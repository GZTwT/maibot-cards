'use strict';
/**
 * Bisca 棋牌室 · 斗地主 (Dou Dizhu) — 游戏引擎（纯逻辑，零 I/O）
 *
 * 见 docs/design-cards.md 第 1 章（引擎统一契约）+ 第 2 章（ddz 规则拍板）。
 * 结构/RNG/中文报错/log 的气质照 daifugo/engine.cjs 抄。
 *
 * 导出八件套：
 *   meta / createGame / apply / legalMoves / viewFor / currentActors / briefing / fmtMove
 *
 * 牌 id 沿用 daifugo 方案：S3..S15 / H.. / D.. / C..，外加 X1(小王) X2(大王)。
 * rank：3..10 照面值，11=J 12=Q 13=K 14=A 15=2，16=小王 17=大王。
 * 强度就是 rank 本身（斗地主不革命，3 最小、2 次大、王最大）。
 *
 * state 里除 SPEC 骨架外多带几样：
 *   bottom / bottomDealt —— 三张底牌 + 是否已并进地主手牌
 *   pile        —— 本局已经打出去的牌
 *   bombs       —— 本局炸弹+王炸的响数（倍数 = 2^bombs）
 *   base        —— 本局底分（= 地主的叫分）
 *   passStreak  —— 连续过牌数（斗地主的「过」是过这一手，不是整墩弃权）
 *   players[].playedCount —— 本局出过几手（春天/反春判定用）
 *
 * 牌张守恒：sum(players[].hand) + pile.length + (bottomDealt ? 0 : 3) === 54
 */

// ---------------------------------------------------------------- RNG

/** 字符串/数字 seed -> uint32 */
function hashSeed(seed) {
  const s = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 由 seed 展开成 xorshift128 的四个 uint32 */
function createRngState(seed) {
  let h = hashSeed(seed === undefined || seed === null ? 'bisca' : seed);
  const out = [];
  for (let i = 0; i < 4; i++) {
    h ^= (h << 13); h >>>= 0;
    h ^= (h >>> 17);
    h ^= (h << 5); h >>>= 0;
    out.push(h >>> 0);
  }
  if (out.every((v) => v === 0)) out[0] = 0x9e3779b9;
  return out;
}

/** 纯函数推进一步：返回 [新的四元组, uint32 随机数] */
function rngNext(rs) {
  let x = rs[0] >>> 0, y = rs[1] >>> 0, z = rs[2] >>> 0, w = rs[3] >>> 0;
  const t = (x ^ (x << 11)) >>> 0;
  x = y; y = z; z = w;
  w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
  return [[x, y, z, w], w];
}

/** 在 state 上就地取一个 [0, n) 的整数（state 必须是已克隆的工作副本） */
function rndInt(s, n) {
  const [next, v] = rngNext(s.rngState);
  s.rngState = next;
  return v % n;
}

/** Fisher-Yates，用 state 的 rng */
function shuffle(s, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rndInt(s, i + 1);
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// ---------------------------------------------------------------- 牌

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3, X: 4 };
const RANK_SYM = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' };
const JOKER_SMALL = 16;
const JOKER_BIG = 17;
/** 顺子/连对/飞机能用到的最大 rank（A=14；2 和王不入顺） */
const MAX_RUN_RANK = 14;

/** 全副 54 张，顺序固定（洗牌走 RNG） */
const ALL_CARDS = (() => {
  const out = [];
  for (const s of SUITS) for (let r = 3; r <= 15; r++) out.push(s + r);
  out.push('X1', 'X2');
  return out;
})();

/** "S3" -> {id,suit,rank,joker}；不合法返回 null */
function parseCard(id) {
  if (typeof id !== 'string' || id.length < 2) return null;
  const suit = id[0];
  if (suit === 'X') {
    if (id === 'X1') return { id, suit: 'X', rank: JOKER_SMALL, joker: true };
    if (id === 'X2') return { id, suit: 'X', rank: JOKER_BIG, joker: true };
    return null;
  }
  if (SUITS.indexOf(suit) < 0) return null;
  const r = Number(id.slice(1));
  if (!Number.isInteger(r) || r < 3 || r > 15) return null;
  return { id, suit, rank: r, joker: false };
}

function cardLabel(id) {
  const c = parseCard(id);
  if (!c) return String(id);
  if (c.joker) return id === 'X1' ? '小王' : '大王';
  return SUIT_SYM[c.suit] + (RANK_SYM[c.rank] || String(c.rank));
}

/** 一串牌的人话，斗地主习惯连着写：♠3♠4♠5 */
function cardsLabel(ids) {
  return ids.map(cardLabel).join('');
}

/** 牌排序：按 rank 升序、同 rank 按 ♠♥♦♣，王垫底 */
function cardCmp(a, b) {
  const ca = parseCard(a), cb = parseCard(b);
  if (!ca || !cb) return String(a) < String(b) ? -1 : 1;
  return (ca.rank - cb.rank) || (SUIT_ORDER[ca.suit] - SUIT_ORDER[cb.suit]) || (ca.id < cb.id ? -1 : 1);
}

function sortCards(ids) {
  return ids.slice().sort(cardCmp);
}

function sortHand(ids) {
  return sortCards(ids);
}

function cardStrength(id) {
  const c = parseCard(id);
  return c ? c.rank : -1;
}

// ---------------------------------------------------------------- 规则

const DEFAULT_RULES = {
  allow_four_two: true        // 四带二：四条可带两单张或两对
};

const RULE_META = [
  { key: 'allow_four_two', label: '四带二', note: '四条可带两单张或两对', def: true }
];

function normRules(rules) {
  const r = rules || DEFAULT_RULES;
  const out = {};
  for (const k of Object.keys(DEFAULT_RULES)) {
    out[k] = (r[k] === undefined) ? DEFAULT_RULES[k] : !!r[k];
  }
  return out;
}

// ---------------------------------------------------------------- 牌型

const TYPE_LABEL = {
  single: '单张',
  pair: '对子',
  triple: '三条',
  triple_one: '三带一',
  triple_pair: '三带对',
  straight: '顺子',
  pair_straight: '连对',
  plane: '飞机',
  plane_one: '飞机带单',
  plane_pair: '飞机带对',
  four_two_single: '四带二',
  four_two_pair: '四带两对',
  bomb: '炸弹',
  rocket: '王炸'
};

/** legalMoves 排序用的类型次序，纯为了输出稳定好看 */
const TYPE_ORDER = [
  'single', 'pair', 'triple', 'triple_one', 'triple_pair',
  'straight', 'pair_straight', 'plane', 'plane_one', 'plane_pair',
  'four_two_single', 'four_two_pair', 'bomb', 'rocket'
];

function comboLabel(combo) {
  if (!combo) return '（空）';
  return TYPE_LABEL[combo.type] || combo.type;
}

function combinations(arr, k) {
  const out = [];
  if (k < 0 || k > arr.length) return out;
  const cur = [];
  (function rec(start) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      cur.push(arr[i]);
      rec(i + 1);
      cur.pop();
    }
  })(0);
  return out;
}

/**
 * 牌型解析：返回这几张牌全部合法的解释（多数情况只有一种，
 * 少数会撞车——比如 12 张连着的三条既是 4 连纯飞机、也可能是 3 连飞机带翅膀）。
 * 顺序即优先级：王炸/炸弹/同 rank 组在前，带翅膀的在后。
 *
 * combo = { type, size, mainRank, len, cards }
 *   mainRank —— 比大小看它（顺子类取最大那张，带牌类取主牌）
 *   len      —— 顺子的长度 / 连对的对数 / 飞机的三条数，其余恒 1
 */
function comboCandidates(cards, rules) {
  const R = normRules(rules);
  if (!Array.isArray(cards) || !cards.length) return [];
  const parsed = [];
  const seen = Object.create(null);
  for (const id of cards) {
    const c = parseCard(id);
    if (!c || seen[id]) return [];
    seen[id] = true;
    parsed.push(c);
  }
  const n = parsed.length;
  const ids = sortCards(parsed.map((c) => c.id));
  const cnt = new Map();
  for (const c of parsed) cnt.set(c.rank, (cnt.get(c.rank) || 0) + 1);
  const out = [];
  const push = (type, mainRank, len) => {
    out.push({ type, size: n, mainRank, len: len || 1, cards: ids });
  };

  // --- 王炸
  if (n === 2 && cnt.get(JOKER_SMALL) === 1 && cnt.get(JOKER_BIG) === 1) {
    push('rocket', JOKER_BIG, 1);
  }

  // --- 同 rank 组：单/对/三条/炸弹（两张王 rank 不同，落不进这里）
  if (cnt.size === 1) {
    const rank = parsed[0].rank;
    if (n === 1) push('single', rank);
    else if (n === 2) push('pair', rank);
    else if (n === 3) push('triple', rank);
    else if (n === 4) push('bomb', rank);
  }

  // --- 三带一 / 三带对
  if (n === 4 || n === 5) {
    for (const [r, c] of cnt) {
      if (c !== 3) continue;
      if (n === 4 && cnt.size === 2) push('triple_one', r);
      if (n === 5 && cnt.size === 2) {
        const other = [...cnt.entries()].find((e) => e[0] !== r);
        if (other && other[1] === 2) push('triple_pair', r);
      }
    }
  }

  // --- 顺子：5 张起，单张连号，2 和王不入顺
  if (n >= 5) {
    const rs = [...cnt.keys()].sort((a, b) => a - b);
    if (rs.length === n && rs[rs.length - 1] <= MAX_RUN_RANK
      && rs[rs.length - 1] - rs[0] === n - 1) {
      push('straight', rs[rs.length - 1], n);
    }
  }

  // --- 连对：3 对起
  if (n >= 6 && n % 2 === 0) {
    const rs = [...cnt.keys()].sort((a, b) => a - b);
    const pairs = n / 2;
    if (rs.length === pairs && rs.every((r) => cnt.get(r) === 2)
      && rs[rs.length - 1] <= MAX_RUN_RANK && rs[rs.length - 1] - rs[0] === pairs - 1) {
      push('pair_straight', rs[rs.length - 1], pairs);
    }
  }

  // --- 飞机：2 组起的连续三条，纯的 / 带同数量单张 / 带同数量对子
  const tri = [...cnt.keys()].filter((r) => cnt.get(r) >= 3 && r <= MAX_RUN_RANK).sort((a, b) => a - b);
  for (let i = 0; i < tri.length; i++) {
    for (let j = i + 1; j < tri.length; j++) {
      if (tri[j] !== tri[j - 1] + 1) break;
      const run = tri.slice(i, j + 1);
      const k = run.length;
      const runSet = new Set(run);
      const rem = [];
      let remTotal = 0;
      for (const [r, c] of cnt) {
        const left = c - (runSet.has(r) ? 3 : 0);
        if (left > 0) { rem.push([r, left]); remTotal += left; }
      }
      const mainRank = run[k - 1];
      if (n === 3 * k && remTotal === 0) {
        push('plane', mainRank, k);
      }
      // 翅膀是 k 张散牌：不能动到三条自己那几个 rank，也不能是某 rank 的三张
      if (n === 4 * k && remTotal === k
        && rem.every(([r, left]) => !runSet.has(r) && left <= 2)) {
        push('plane_one', mainRank, k);
      }
      // 翅膀是 k 个对子：rank 互不相同、都不在三条里
      if (n === 5 * k && remTotal === 2 * k && rem.length === k
        && rem.every(([r, left]) => !runSet.has(r) && left === 2)) {
        push('plane_pair', mainRank, k);
      }
    }
  }

  // --- 四带二（开关）
  if (R.allow_four_two) {
    for (const [r, c] of cnt) {
      if (c !== 4) continue;
      const rest = [...cnt.entries()].filter((e) => e[0] !== r);
      if (n === 6) push('four_two_single', r);
      if (n === 8 && rest.length === 2 && rest.every((e) => e[1] === 2)) push('four_two_pair', r);
    }
  }

  return out;
}

/**
 * 牌型判定：返回首选解释，不合法返回 null。
 * opts: { rules, as:'straight'|... } —— as 指定要哪种解释
 */
function comboOf(cards, opts) {
  const o = opts || {};
  const list = comboCandidates(cards, o.rules !== undefined ? o.rules : o);
  if (!list.length) return null;
  if (o.as) return list.find((c) => c.type === o.as) || null;
  return list[0];
}

function toCombo(x, rules) {
  if (!x) return null;
  if (Array.isArray(x)) return comboOf(x, { rules });
  return x;
}

/**
 * a 能不能压 b。a/b 可以是 comboOf 的结果，也可以直接是牌 id 数组。
 * b 为空 = 空场，随便出。王炸压一切，炸弹压一切非炸弹，其余同型同张数比主牌。
 */
function beats(a, b, rules) {
  const ca = toCombo(a, rules);
  if (!ca) return false;
  const cb = toCombo(b, rules);
  if (!cb) return true;
  if (ca.type === 'rocket') return true;
  if (cb.type === 'rocket') return false;
  if (ca.type === 'bomb' && cb.type !== 'bomb') return true;
  if (cb.type === 'bomb' && ca.type !== 'bomb') return false;
  if (ca.type !== cb.type || ca.size !== cb.size) return false;
  return ca.mainRank > cb.mainRank;
}

// ---------------------------------------------------------------- 枚举

/**
 * 枚举手牌能打出的牌型。
 * filter = null 领出（全类型全枚举）；
 * filter = {type,size,mainRank} 跟牌（同型同张数且更大 + 一切炸弹/王炸）。
 *
 * 防爆炸的两条取舍（apply 照样收更花的选法，只是不主动列出来）：
 *   1. 同一个 rank 的不同花色不重复枚举，一律取花色靠前的那几张当代表；
 *   2. 飞机的翅膀按「每个 rank 出一张代表牌」组合，不枚举「拆一对当两张单」的翅膀。
 * 顺子/连对/飞机的主体走滑窗，最长手牌 20 张时总量在几百条量级。
 */
function enumerateCombos(hand, rules, filter) {
  const R = normRules(rules);
  const out = [];
  if (filter && filter.type === 'rocket') return out;   // 王炸无解

  const byRank = new Map();
  for (const id of sortCards(hand)) {
    const c = parseCard(id);
    if (!c) continue;
    if (!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank).push(c.id);
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const cnt = (r) => (byRank.get(r) || []).length;
  const canon = (r, k) => byRank.get(r).slice(0, k);
  const has = (r) => byRank.has(r);

  const need = (type, size) => !filter || (filter.type === type && filter.size === size);
  const seen = new Set();
  const push = (type, cards, mainRank, len) => {
    if (filter && filter.type === type && filter.size === cards.length
      && !(mainRank > filter.mainRank)) return;
    const sorted = sortCards(cards);
    const key = type + '|' + sorted.join(',');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type, cards: sorted, mainRank, len: len || 1, size: sorted.length });
  };

  // --- 单/对/三条/炸弹/王炸
  for (const r of ranks) {
    if (need('single', 1)) push('single', canon(r, 1), r);
    if (cnt(r) >= 2 && need('pair', 2)) push('pair', canon(r, 2), r);
    if (cnt(r) >= 3 && need('triple', 3)) push('triple', canon(r, 3), r);
    if (cnt(r) >= 4) push('bomb', canon(r, 4), r);          // 炸弹永远可出
  }
  if (has(JOKER_SMALL) && has(JOKER_BIG)) push('rocket', ['X1', 'X2'], JOKER_BIG);

  // --- 三带一 / 三带对
  for (const t of ranks) {
    if (cnt(t) < 3) continue;
    for (const r of ranks) {
      if (r === t) continue;
      if (need('triple_one', 4)) push('triple_one', canon(t, 3).concat(canon(r, 1)), t);
      if (cnt(r) >= 2 && need('triple_pair', 5)) push('triple_pair', canon(t, 3).concat(canon(r, 2)), t);
    }
  }

  // --- 顺子（滑窗）
  for (let len = 5; len <= 12; len++) {
    if (!need('straight', len)) continue;
    for (let lo = 3; lo + len - 1 <= MAX_RUN_RANK; lo++) {
      const cards = [];
      let ok = true;
      for (let r = lo; r < lo + len; r++) {
        if (!has(r)) { ok = false; break; }
        cards.push(canon(r, 1)[0]);
      }
      if (ok) push('straight', cards, lo + len - 1, len);
    }
  }

  // --- 连对（滑窗）
  for (let len = 3; len <= 10; len++) {
    if (!need('pair_straight', len * 2)) continue;
    for (let lo = 3; lo + len - 1 <= MAX_RUN_RANK; lo++) {
      let cards = [];
      let ok = true;
      for (let r = lo; r < lo + len; r++) {
        if (cnt(r) < 2) { ok = false; break; }
        cards = cards.concat(canon(r, 2));
      }
      if (ok) push('pair_straight', cards, lo + len - 1, len);
    }
  }

  // --- 飞机（滑窗 + 翅膀组合）
  for (let k = 2; k <= 6; k++) {
    for (let lo = 3; lo + k - 1 <= MAX_RUN_RANK; lo++) {
      let body = [];
      let ok = true;
      const runSet = new Set();
      for (let r = lo; r < lo + k; r++) {
        if (cnt(r) < 3) { ok = false; break; }
        runSet.add(r);
        body = body.concat(canon(r, 3));
      }
      if (!ok) continue;
      const mainRank = lo + k - 1;
      if (need('plane', 3 * k)) push('plane', body, mainRank, k);
      if (need('plane_one', 4 * k)) {
        const pool = ranks.filter((r) => !runSet.has(r));
        for (const wing of combinations(pool, k)) {
          push('plane_one', body.concat(wing.map((r) => canon(r, 1)[0])), mainRank, k);
        }
      }
      if (need('plane_pair', 5 * k)) {
        const pool = ranks.filter((r) => !runSet.has(r) && cnt(r) >= 2);
        for (const wing of combinations(pool, k)) {
          let cards = body.slice();
          for (const r of wing) cards = cards.concat(canon(r, 2));
          push('plane_pair', cards, mainRank, k);
        }
      }
    }
  }

  // --- 四带二
  if (R.allow_four_two) {
    for (const q of ranks) {
      if (cnt(q) < 4) continue;
      const body = canon(q, 4);
      if (need('four_two_single', 6)) {
        const pool = ranks.filter((r) => r !== q);
        for (const wing of combinations(pool, 2)) {
          push('four_two_single', body.concat(wing.map((r) => canon(r, 1)[0])), q);
        }
        for (const r of pool) {                      // 带走一个对子也算两张单
          if (cnt(r) >= 2) push('four_two_single', body.concat(canon(r, 2)), q);
        }
      }
      if (need('four_two_pair', 8)) {
        const pool = ranks.filter((r) => r !== q && cnt(r) >= 2);
        for (const wing of combinations(pool, 2)) {
          let cards = body.slice();
          for (const r of wing) cards = cards.concat(canon(r, 2));
          push('four_two_pair', cards, q);
        }
      }
    }
  }

  out.sort((a, b) =>
    (TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type))
    || (a.size - b.size)
    || (a.mainRank - b.mainRank)
    || (a.cards.join() < b.cards.join() ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------- 工具

function findPlayer(s, id) {
  return s.players.find((p) => p.id === id) || null;
}

/** turnOrder 上 fromId 的下家 */
function nextSeat(s, fromId) {
  const order = s.turnOrder;
  let i = order.indexOf(fromId);
  if (i < 0) i = 0;
  return order[(i + 1) % order.length];
}

function cloneCombo(c) {
  return c ? Object.assign({}, c, { cards: c.cards.slice() }) : null;
}

function cloneState(s) {
  return {
    seq: s.seq,
    createdAt: s.createdAt,
    phase: s.phase,
    round: s.round,
    turnOrder: s.turnOrder.slice(),
    current: s.current,
    leader: s.leader,
    players: s.players.map((p) => Object.assign({}, p, { hand: p.hand.slice() })),
    field: s.field ? {
      cards: s.field.cards.slice(),
      by: s.field.by,
      combo: cloneCombo(s.field.combo)
    } : null,
    lastToPlay: s.lastToPlay,
    passStreak: s.passStreak,
    bottom: s.bottom.slice(),
    bottomDealt: s.bottomDealt,
    landlord: s.landlord,
    bidStarter: s.bidStarter,
    bids: s.bids.map((b) => Object.assign({}, b)),
    highBid: s.highBid ? Object.assign({}, s.highBid) : null,
    base: s.base,
    bombs: s.bombs,
    spring: s.spring,
    antiSpring: s.antiSpring,
    pile: s.pile.slice(),
    roundWinner: s.roundWinner,
    lastResults: s.lastResults ? s.lastResults.map((r) => Object.assign({}, r)) : null,
    rounds: s.rounds.map((r) => Object.assign({}, r, {
      results: r.results.map((x) => Object.assign({}, x))
    })),
    winner: s.winner,
    log: s.log.slice(),
    rngState: s.rngState.slice(),
    // 规则表只读，直接共用引用
    rules: s.rules
  };
}

function logAdd(ctx, type, text) {
  const entry = { seq: ctx.s.log.length + 1, t: ctx.s.seq, text, type };
  ctx.s.log.push(entry);
  ctx.events.push(entry);
  return entry;
}

/** 当前倍数（不含结算时才知道的春天） */
function currentMultiplier(s) {
  return Math.pow(2, s.bombs);
}

// ---------------------------------------------------------------- 发牌 / 开局 / 结算

function dealRound(ctx) {
  const s = ctx.s;
  const deck = shuffle(s, ALL_CARDS);
  for (const p of s.players) p.hand = [];
  const order = s.turnOrder;
  let start = order.indexOf(s.bidStarter);
  if (start < 0) start = 0;
  for (let i = 0; i < 51; i++) {
    findPlayer(s, order[(start + i) % order.length]).hand.push(deck[i]);
  }
  for (const p of s.players) p.hand = sortHand(p.hand);
  s.bottom = sortCards(deck.slice(51));
  s.bottomDealt = false;
}

/** 摆好一局的初始状态：发牌 + 进叫分阶段 */
function startRound(ctx) {
  const s = ctx.s;
  s.phase = 'bidding';
  s.field = null;
  s.lastToPlay = null;
  s.leader = null;
  s.passStreak = 0;
  s.pile = [];
  s.bombs = 0;
  s.base = null;
  s.landlord = null;
  s.spring = false;
  s.antiSpring = false;
  s.roundWinner = null;
  s.lastResults = null;
  for (const p of s.players) {
    p.hand = [];
    p.bid = null;
    p.isLandlord = false;
    p.playedCount = 0;
    p.passed = false;
  }
  if (!s.bidStarter) s.bidStarter = s.turnOrder[rndInt(s, s.turnOrder.length)];
  s.bids = [];
  s.highBid = null;
  s.current = s.bidStarter;
  dealRound(ctx);
  logAdd(ctx, 'deal', `第 ${s.round} 局发牌完毕，每人 17 张 + 3 张底牌`);
  logAdd(ctx, 'bid', `${findPlayer(s, s.current).name} 先叫分`);
}

/** 全都不叫：同一局内重开，round 不变，先叫的位置往下家挪一格 */
function redeal(ctx) {
  const s = ctx.s;
  logAdd(ctx, 'redeal', '全都不叫，重新发牌');
  s.bidStarter = nextSeat(s, s.bidStarter);
  s.bids = [];
  s.highBid = null;
  for (const p of s.players) p.bid = null;
  s.current = s.bidStarter;
  dealRound(ctx);
  logAdd(ctx, 'bid', `${findPlayer(s, s.current).name} 先叫分`);
}

function setLandlord(ctx, p) {
  const s = ctx.s;
  s.landlord = p.id;
  p.isLandlord = true;
  s.base = s.highBid ? s.highBid.value : (p.bid || 1);
  p.hand = sortHand(p.hand.concat(s.bottom));
  s.bottomDealt = true;
  s.phase = 'playing';
  s.leader = p.id;
  s.current = p.id;
  s.field = null;
  s.lastToPlay = null;
  s.passStreak = 0;
  logAdd(ctx, 'landlord', `${p.name} 以 ${s.base} 分当地主，底牌 ${cardsLabel(s.bottom)}`);
  logAdd(ctx, 'turn', `${p.name} 先出`);
}

function finalizeRound(ctx, winner) {
  const s = ctx.s;
  const ll = findPlayer(s, s.landlord);
  const landlordWon = winner.id === s.landlord;
  const farmers = s.players.filter((p) => !p.isLandlord);
  s.spring = landlordWon && farmers.every((f) => f.playedCount === 0);
  s.antiSpring = !landlordWon && ll.playedCount === 1;
  const mult = Math.pow(2, s.bombs) * ((s.spring || s.antiSpring) ? 2 : 1);
  const base = s.base || 1;
  const results = [];
  for (const p of s.players) {
    const unit = p.isLandlord ? 2 : 1;
    const delta = (landlordWon === p.isLandlord ? 1 : -1) * unit * base * mult;
    p.score += delta;
    results.push({
      playerId: p.id, name: p.name, isLandlord: p.isLandlord,
      delta, score: p.score
    });
  }
  s.roundWinner = landlordWon ? 'landlord' : 'farmer';
  s.lastResults = results;
  s.rounds.push({
    round: s.round,
    landlord: s.landlord,
    base,
    bombs: s.bombs,
    multiplier: mult,
    spring: s.spring,
    antiSpring: s.antiSpring,
    winner: s.roundWinner,
    results: results.map((r) => Object.assign({}, r))
  });
  s.phase = 'round_over';
  s.current = null;
  // field 留着不清，前端好把最后那一手亮在桌上
  const extra = s.spring ? '春天！' : (s.antiSpring ? '反春！' : '');
  logAdd(ctx, 'round_over',
    `${extra}第 ${s.round} 局结束：${landlordWon ? '地主' : '农民'}胜，`
    + `底分 ${base} × 倍数 ${mult}（炸弹 ${s.bombs} 响）；`
    + results.map((r) => `${r.name} ${r.delta >= 0 ? '+' : ''}${r.delta}`).join('，'));
}

/** 清场：场上归零，ownerId 重新领出 */
function clearTrick(ctx, ownerId) {
  const s = ctx.s;
  s.field = null;
  s.passStreak = 0;
  for (const p of s.players) p.passed = false;
  const owner = findPlayer(s, ownerId);
  if (!owner) { s.leader = null; s.current = null; return; }
  s.leader = owner.id;
  s.current = owner.id;
  logAdd(ctx, 'clear', `两家都过，${owner.name} 重新领出`);
}

// ---------------------------------------------------------------- 出牌合法性

/** 跟牌不合法时返回中文原因，合法返回 null（field 为空不该调这个） */
function followError(s, combo) {
  const f = s.field.combo;
  if (combo.type === 'rocket') return null;
  if (f.type === 'rocket') return '王炸谁也压不住';
  if (combo.type === 'bomb' && f.type !== 'bomb') return null;
  if (f.type === 'bomb' && combo.type !== 'bomb') return `场上是炸弹，只能用更大的炸弹或王炸压`;
  if (combo.type !== f.type || combo.size !== f.size) {
    return `场上是${comboLabel(f)}（${f.size} 张），跟牌要同型同张数`;
  }
  if (combo.mainRank <= f.mainRank) return `压不过场上的 ${cardsLabel(f.cards)}`;
  return null;
}

// ---------------------------------------------------------------- 动作

function actBid(ctx, p, action) {
  const s = ctx.s;
  if (s.phase !== 'bidding') throw new Error('现在不是叫分阶段');
  if (s.current !== p.id) throw new Error('还没轮到你叫分');
  const value = Number(action.value);
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    throw new Error('叫分只能是 0（不叫）/1/2/3');
  }
  if (value > 0 && s.highBid && value <= s.highBid.value) {
    throw new Error(`已经有人叫 ${s.highBid.value} 分了，要叫就得更高`);
  }
  p.bid = value;
  s.bids.push({ playerId: p.id, value });
  logAdd(ctx, 'bid', value === 0 ? `${p.name} 不叫` : `${p.name} 叫 ${value} 分`);
  if (value > 0 && (!s.highBid || value > s.highBid.value)) {
    s.highBid = { playerId: p.id, value };
  }
  if (value === 3) { setLandlord(ctx, p); return; }
  if (s.bids.length >= s.players.length) {
    if (!s.highBid) { redeal(ctx); return; }
    setLandlord(ctx, findPlayer(s, s.highBid.playerId));
    return;
  }
  s.current = nextSeat(s, p.id);
}

function actPlay(ctx, p, action) {
  const s = ctx.s;
  if (s.phase === 'bidding') throw new Error('还在叫分，先把地主定下来');
  if (s.phase !== 'playing') throw new Error('现在不是出牌的时候');
  if (s.current !== p.id) throw new Error('还没轮到你出牌');

  const cards = Array.isArray(action.cards) ? action.cards.slice() : [];
  if (!cards.length) throw new Error('至少要出一张牌');
  const dup = Object.create(null);
  for (const id of cards) {
    if (dup[id]) throw new Error(`同一张牌不能出两次：${cardLabel(id)}`);
    dup[id] = true;
    if (p.hand.indexOf(id) < 0) throw new Error(`你手里没有 ${cardLabel(id)}`);
  }

  const cands = comboCandidates(cards, s.rules);
  if (!cands.length) throw new Error('这不是合法的斗地主牌型');
  let list = cands;
  if (action.as) {
    list = cands.filter((c) => c.type === action.as);
    if (!list.length) throw new Error(`这几张牌凑不成${TYPE_LABEL[action.as] || action.as}`);
  }

  let combo = null;
  if (!s.field) {
    combo = list[0];
  } else {
    let firstErr = null;
    for (const c of list) {
      const err = followError(s, c);
      if (!err) { combo = c; break; }
      if (!firstErr) firstErr = err;
    }
    if (!combo) throw new Error(firstErr || '这手牌压不住场上的牌');
  }

  // ---- 落定
  p.hand = p.hand.filter((id) => cards.indexOf(id) < 0);
  p.playedCount += 1;
  p.passed = false;
  s.pile = s.pile.concat(combo.cards);
  s.field = { cards: combo.cards.slice(), by: p.id, combo: cloneCombo(combo) };
  s.lastToPlay = p.id;
  s.passStreak = 0;
  logAdd(ctx, 'play', `${p.name} 出 ${cardsLabel(combo.cards)}（${comboLabel(combo)}）`);

  if (combo.type === 'bomb' || combo.type === 'rocket') {
    s.bombs += 1;
    logAdd(ctx, 'bomb',
      `${combo.type === 'rocket' ? '王炸' : '炸弹'}！倍数翻到 ${currentMultiplier(s)} 倍`);
  }

  if (!p.hand.length) {
    logAdd(ctx, 'finish', `${p.name} 牌出完了`);
    finalizeRound(ctx, p);
    return;
  }

  s.current = nextSeat(s, p.id);
}

function actPass(ctx, p) {
  const s = ctx.s;
  if (s.phase === 'bidding') throw new Error('还在叫分，先把地主定下来');
  if (s.phase !== 'playing') throw new Error('现在不是出牌的时候');
  if (s.current !== p.id) throw new Error('还没轮到你');
  if (!s.field) throw new Error('你是这一墩的领出者，必须出牌');
  p.passed = true;
  s.passStreak += 1;
  logAdd(ctx, 'pass', `${p.name} 过`);
  if (s.passStreak >= s.players.length - 1) {
    clearTrick(ctx, s.lastToPlay);
    return;
  }
  s.current = nextSeat(s, p.id);
}

function actNextRound(ctx) {
  const s = ctx.s;
  if (s.phase !== 'round_over') throw new Error('这一局还没打完');
  // 地主赢了继续先叫，输了让下家先叫
  s.bidStarter = (s.roundWinner === 'landlord') ? s.landlord : nextSeat(s, s.landlord);
  s.round += 1;
  startRound(ctx);
}

function actEndMatch(ctx) {
  const s = ctx.s;
  const board = s.players.slice().sort((a, b) => (b.score - a.score)
    || (s.turnOrder.indexOf(a.id) - s.turnOrder.indexOf(b.id)));
  s.winner = board.length ? board[0].id : null;
  s.phase = 'game_over';
  s.current = null;
  logAdd(ctx, 'game_over', `收盘：${board.map((p) => `${p.name} ${p.score} 分`).join('，')}`);
}

// ---------------------------------------------------------------- 对外 API

const meta = {
  key: 'ddz',
  name: '斗地主',
  minPlayers: 3,
  maxPlayers: 3,
  defaultRules: Object.assign({}, DEFAULT_RULES),
  ruleMeta: RULE_META.map((r) => Object.assign({}, r))
};

function createGame(opts) {
  const o = opts || {};
  const players = o.players;
  if (!Array.isArray(players) || players.length !== 3) {
    throw new Error('斗地主必须恰好 3 人');
  }
  const cfg = o.config || {};
  const rules = normRules(Object.assign({}, DEFAULT_RULES, cfg.defaults || {}, cfg.rules || {}, o.rules || {}));

  const ids = Object.create(null);
  const ps = players.map((p, i) => {
    const id = p.id || `p${i + 1}`;
    if (ids[id]) throw new Error(`玩家 id 重复：${id}`);
    ids[id] = true;
    return {
      id,
      name: p.name || `玩家${i + 1}`,
      isAI: !!p.isAI,
      hand: [],
      bid: null,
      isLandlord: false,
      playedCount: 0,
      passed: false,
      score: 0
    };
  });

  const s = {
    seq: 0,
    createdAt: Date.now(),
    phase: 'bidding',
    round: 1,
    turnOrder: ps.map((p) => p.id),
    current: null,
    leader: null,
    players: ps,
    field: null,
    lastToPlay: null,
    passStreak: 0,
    bottom: [],
    bottomDealt: false,
    landlord: null,
    bidStarter: null,
    bids: [],
    highBid: null,
    base: null,
    bombs: 0,
    spring: false,
    antiSpring: false,
    pile: [],
    roundWinner: null,
    lastResults: null,
    rounds: [],
    winner: null,
    rules,
    log: [],
    rngState: createRngState(o.seed)
  };

  const ctx = { s, events: [] };
  logAdd(ctx, 'start', `开局：${ps.map((p) => p.name).join('、')}（斗地主 3 人）`);
  startRound(ctx);
  return s;
}

const HANDLERS = {
  bid: (ctx, p, a) => actBid(ctx, p, a),
  play: (ctx, p, a) => actPlay(ctx, p, a),
  pass: (ctx, p) => actPass(ctx, p),
  next_round: (ctx) => actNextRound(ctx),
  end_match: (ctx) => actEndMatch(ctx)
};

function apply(state, playerId, action) {
  if (!state) throw new Error('缺少牌局状态');
  const act = (typeof action === 'string') ? { type: action } : (action || {});
  const type = act.type;
  if (!type || !HANDLERS[type]) throw new Error(`未知动作：${type || '(空)'}`);
  if (state.phase === 'game_over') throw new Error('整场已经结束了');
  if (!findPlayer(state, playerId)) throw new Error('查无此人');

  const s = cloneState(state);
  s.seq += 1;
  const ctx = { s, events: [] };
  HANDLERS[type](ctx, findPlayer(s, playerId), act);
  return { state: s, events: ctx.events };
}

/**
 * 该玩家此刻的合法动作。
 * bidding：{type:'bid',value} 列表（0 恒在，1~3 得比现价高）
 * playing：全部能出的牌（{type:'play',cards,as,combo,label}）+ 场上有牌时的 {type:'pass'}
 * round_over：[{type:'next_round'}]（end_match 是房主特权，服务端把关，不进这张表）
 */
function legalMoves(state, playerId) {
  const s = state;
  const out = [];
  if (!s || s.phase === 'game_over') return out;
  const p = findPlayer(s, playerId);
  if (!p) return out;

  if (s.phase === 'round_over') return [{ type: 'next_round' }];

  if (s.phase === 'bidding') {
    if (s.current !== p.id) return out;
    out.push({ type: 'bid', value: 0 });
    const floor = s.highBid ? s.highBid.value : 0;
    for (let v = floor + 1; v <= 3; v++) out.push({ type: 'bid', value: v });
    return out;
  }

  if (s.current !== p.id) return out;
  const filter = s.field
    ? { type: s.field.combo.type, size: s.field.combo.size, mainRank: s.field.combo.mainRank }
    : null;
  for (const c of enumerateCombos(p.hand, s.rules, filter)) {
    out.push({
      type: 'play', cards: c.cards.slice(), as: c.type,
      combo: Object.assign({}, c, { cards: c.cards.slice() }),
      label: TYPE_LABEL[c.type] || c.type
    });
  }
  if (s.field) out.push({ type: 'pass' });
  return out;
}

/**
 * 脱敏视图。playerId=null / 不认识的 id = 观战：谁的手牌都看不到。
 * 底牌在定地主之前谁也看不见，定完对所有人公开。rngState 不外泄。
 */
function viewFor(state, playerId) {
  const s = state;
  const me = playerId ? findPlayer(s, playerId) : null;
  const meId = me ? me.id : null;
  return {
    seq: s.seq,
    createdAt: s.createdAt,
    phase: s.phase,
    round: s.round,
    turnOrder: s.turnOrder.slice(),
    current: s.current,
    leader: s.leader,
    you: meId,
    landlord: s.landlord,
    base: s.base,
    bombs: s.bombs,
    multiplier: currentMultiplier(s),
    spring: s.spring,
    antiSpring: s.antiSpring,
    bids: s.bids.map((b) => Object.assign({}, b)),
    highBid: s.highBid ? Object.assign({}, s.highBid) : null,
    bottomCards: s.bottomDealt ? s.bottom.slice() : null,
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      isAI: p.isAI,
      isLandlord: p.isLandlord,
      bid: p.bid,
      passed: p.passed,
      playedCount: p.playedCount,
      score: p.score,
      handCount: p.hand.length,
      hand: (meId && p.id === meId) ? p.hand.slice() : null
    })),
    field: s.field ? {
      cards: s.field.cards.slice(),
      by: s.field.by,
      combo: cloneCombo(s.field.combo)
    } : null,
    lastToPlay: s.lastToPlay,
    pile: s.pile.slice(),
    roundWinner: s.roundWinner,
    lastResults: s.lastResults ? s.lastResults.map((r) => Object.assign({}, r)) : null,
    rounds: s.rounds.map((r) => Object.assign({}, r, {
      results: r.results.map((x) => Object.assign({}, x))
    })),
    winner: s.winner,
    rules: Object.assign({}, s.rules),
    log: s.log.slice()
  };
}

/**
 * 现在欠动作的人。
 * bidding/playing 就是 current 一个人；round_over/game_over 返回 []
 * （下一局由人点——列人的话自动 AI会烧 CLI 抢 next_round,大富豪同口径）。
 */
function currentActors(state) {
  const s = state;
  if (!s || s.phase === 'game_over' || s.phase === 'round_over') return [];
  return s.current ? [s.current] : [];
}

/** 中文局面简报（不含合法招列表） */
function briefing(state, playerId) {
  const s = state;
  const me = playerId ? findPlayer(s, playerId) : null;
  const lines = [];
  const ll = s.landlord ? findPlayer(s, s.landlord) : null;

  const head = [`第 ${s.round} 局`];
  if (ll) head.push(`地主 ${ll.name}`);
  if (s.base) head.push(`底分 ${s.base}`);
  head.push(`倍数 ${currentMultiplier(s)}（炸弹 ${s.bombs} 响）`);
  lines.push(head.join(' · '));

  if (me) {
    lines.push(`你的手牌（${me.hand.length} 张）：${cardsLabel(sortHand(me.hand)) || '（空）'}`);
    if (ll) {
      lines.push(me.isLandlord
        ? `你是地主，一打二。`
        : `你是农民，队友是 ${s.players.filter((p) => !p.isLandlord && p.id !== me.id).map((p) => p.name).join('、')}。`);
    }
  }

  if (s.phase === 'bidding') {
    const said = s.bids.length
      ? s.bids.map((b) => `${findPlayer(s, b.playerId).name} ${b.value === 0 ? '不叫' : b.value + ' 分'}`).join('，')
      : '还没人叫';
    lines.push(`叫分中：${said}。当前最高 ${s.highBid ? s.highBid.value + ' 分（' + findPlayer(s, s.highBid.playerId).name + '）' : '无'}。`);
    lines.push(`轮到 ${findPlayer(s, s.current).name} 叫分。`);
    return lines.join('\n');
  }

  if (s.bottomDealt) lines.push(`底牌：${cardsLabel(s.bottom)}`);

  if (s.phase === 'playing') {
    if (s.field) {
      const by = findPlayer(s, s.field.by);
      lines.push(`场上：${by.name} 出的 ${cardsLabel(s.field.cards)}（${comboLabel(s.field.combo)}），你要压得过它或者过。`);
    } else {
      lines.push(`场上空着，${findPlayer(s, s.leader).name} 领出。`);
    }
  }

  lines.push('剩牌：' + s.players.map((p) =>
    `${me && p.id === me.id ? '你' : p.name}${p.isLandlord ? '(地主)' : ''} ${p.hand.length} 张`).join('，'));

  if (s.phase === 'playing') {
    lines.push(s.current === (me && me.id) ? '现在轮到你。' : `现在轮到 ${findPlayer(s, s.current).name}。`);
  } else if (s.phase === 'round_over') {
    const r = s.lastResults || [];
    lines.push(`本局${s.roundWinner === 'landlord' ? '地主胜' : '农民胜'}`
      + (s.spring ? '（春天）' : s.antiSpring ? '（反春）' : '')
      + '：' + r.map((x) => `${x.name} ${x.delta >= 0 ? '+' : ''}${x.delta}（共 ${x.score}）`).join('，'));
    lines.push('等人喊「下一局」。');
  } else if (s.phase === 'game_over') {
    lines.push('整场已经收盘了。');
  }
  return lines.join('\n');
}

/** 一招的人话 */
function fmtMove(move) {
  const m = (typeof move === 'string') ? { type: move } : (move || {});
  switch (m.type) {
    case 'bid':
      return Number(m.value) === 0 ? '不叫' : `叫 ${m.value} 分`;
    case 'pass':
      return '过';
    case 'play': {
      const cards = Array.isArray(m.cards) ? m.cards : [];
      const combo = m.combo || comboOf(cards, { as: m.as });
      const label = combo ? comboLabel(combo) : '牌';
      return `${cardsLabel(sortCards(cards))}（${label}）`;
    }
    case 'next_round':
      return '下一局';
    case 'end_match':
      return '收盘';
    default:
      return m.type ? String(m.type) : '（空）';
  }
}

// ---------------------------------------------------------------- 双环境导出

const API = {
  // 契约八件套
  meta,
  createGame,
  apply,
  legalMoves,
  viewFor,
  currentActors,
  briefing,
  fmtMove,
  // 牌型判定（前端预判复用）
  comboOf,
  comboCandidates,
  comboLabel,
  beats,
  enumerateCombos,
  parseCard,
  cardLabel,
  cardsLabel,
  cardStrength,
  sortCards,
  // 杂项（服务端/测试用）
  createRngState,
  rngNext,
  shuffle,
  cloneState,
  ALL_CARDS,
  DEFAULT_RULES,
  TYPE_LABEL
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.DdzEngine = API;
