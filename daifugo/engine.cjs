'use strict';
/**
 * 大富豪 (Daifugō) — 游戏引擎（纯逻辑，零 I/O）
 *
 * 见 daifugo/SPEC.md 第 1 章。
 * - createGame({players, config, rules, seed}) -> state
 * - apply(state, playerId, action) -> {state, events}   // 不改入参，非法动作 throw 中文 Error
 * - legalMoves(state, playerId) -> [move]               // AI 工具 / 前端提示都吃它
 * - viewFor(state, playerId|null) -> 脱敏视图
 * - comboOf / comboCandidates / beats                   // 牌型判定，前端 <script> 直接复用
 *
 * 所有随机（洗牌/定先手）走 state.rngState 里的确定性 xorshift128，整局可回放。
 *
 * state 里除 SPEC 骨架外多带几样（服务端/前端可忽略）：
 *   pile        —— 本轮已经离开手牌的牌（含场上的 + 都落ち 弃掉的），手牌 + pile 恒为 54
 *   finishCount —— 本轮已出完的人数（定名次用）
 *   lastDaifugo —— 上一轮大富豪（都落ち 判定用）
 *   lastResults / rounds —— 本轮名次 / 历轮名次（计分板抽屉用）
 *   players[].foul —— 本轮犯规（'forbid_finish' | 'miyako_ochi'），结算时踢到最末
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
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣', X: '★' };
const SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3, X: 4 };
const RANK_SYM = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' };
const JOKER_RANK = 16;

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
    if (id !== 'X1' && id !== 'X2') return null;
    return { id, suit: 'X', rank: JOKER_RANK, joker: true };
  }
  if (SUITS.indexOf(suit) < 0) return null;
  const r = Number(id.slice(1));
  if (!Number.isInteger(r) || r < 3 || r > 15) return null;
  return { id, suit, rank: r, joker: false };
}

function cardLabel(id) {
  const c = parseCard(id);
  if (!c) return String(id);
  if (c.joker) return id === 'X1' ? '王①' : '王②';
  return SUIT_SYM[c.suit] + (RANK_SYM[c.rank] || String(c.rank));
}

function cardsLabel(ids) {
  return ids.map(cardLabel).join(' ');
}

/** 牌排序：普通牌按 rank 升序、同 rank 按 ♠♥♦♣，王垫底 */
function cardCmp(a, b) {
  const ca = parseCard(a), cb = parseCard(b);
  if (!ca || !cb) return String(a) < String(b) ? -1 : 1;
  return (ca.rank - cb.rank) || (SUIT_ORDER[ca.suit] - SUIT_ORDER[cb.suit]) || (ca.id < cb.id ? -1 : 1);
}

function sortCards(ids) {
  return ids.slice().sort(cardCmp);
}

/**
 * 单张强度：王恒 16（革命不翻王），普通牌革命时取反（3 最大 2 最小）。
 * 导出给前端排手牌用。
 */
function strengthOf(rank, revolution) {
  if (rank === JOKER_RANK) return JOKER_RANK;
  return revolution ? (18 - rank) : rank;
}

/** 单张牌 id 的当前强度 */
function cardStrength(id, revolution) {
  const c = parseCard(id);
  return c ? strengthOf(c.rank, revolution) : -1;
}

// ---------------------------------------------------------------- 牌型

/**
 * 牌型解析（可能有多种解释：{S5,X1,X2} 既是三条 5、也是同花阶梯）。
 * 返回全部合法解释，'set' 在前 'stair' 在后。
 * opts: { revolution:boolean }  —— 阶梯里王补位有歧义时，取对出牌者最有利（按当前序最强）的那种排法。
 */
function comboCandidates(cards, opts) {
  const rev = !!(opts && opts.revolution);
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
  const suits = parsed.map((c) => c.suit).sort();
  const jokers = parsed.filter((c) => c.joker);
  const normals = parsed.filter((c) => !c.joker);
  const out = [];

  // --- 同 rank 组（单/对/三条/四条+），王当替身
  let setRank = null;
  if (!normals.length) setRank = JOKER_RANK;                       // 纯王
  else if (normals.every((c) => c.rank === normals[0].rank)) setRank = normals[0].rank;
  if (setRank !== null) {
    out.push({
      type: 'set', size: n, rank: setRank, lo: null, hi: null, suit: null,
      jokers: jokers.length, cards: ids, suits,
      strength: strengthOf(setRank, rev)
    });
  }

  // --- 阶梯：同花色 3+ 连号，王补位
  if (n >= 3 && normals.length) {
    const suit = normals[0].suit;
    const ranks = normals.map((c) => c.rank);
    const uniq = new Set(ranks);
    if (normals.every((c) => c.suit === suit) && uniq.size === ranks.length) {
      const min = Math.min.apply(null, ranks);
      const max = Math.max.apply(null, ranks);
      if (max - min + 1 <= n) {
        let best = null;
        for (let lo = 3; lo + n - 1 <= 15; lo++) {
          const hi = lo + n - 1;
          if (lo > min || hi < max) continue;
          const st = Math.max(strengthOf(lo, rev), strengthOf(hi, rev));
          if (!best || st > best.strength) best = { lo, hi, strength: st };
        }
        if (best) {
          out.push({
            type: 'stair', size: n, rank: null, lo: best.lo, hi: best.hi, suit,
            jokers: jokers.length, cards: ids, suits,
            strength: best.strength
          });
        }
      }
    }
  }
  return out;
}

/**
 * 牌型判定：返回首选解释（同 rank 组优先），不合法返回 null。
 * opts: { revolution:boolean, as:'set'|'stair' }
 */
function comboOf(cards, opts) {
  const list = comboCandidates(cards, opts);
  if (!list.length) return null;
  const as = opts && opts.as;
  if (as) return list.find((c) => c.type === as) || null;
  return list[0];
}

/** 组合在给定序下的比较强度（阶梯比最强一张） */
function comboStrength(combo, revolution) {
  if (!combo) return -1;
  if (combo.type === 'stair') {
    return Math.max(strengthOf(combo.lo, revolution), strengthOf(combo.hi, revolution));
  }
  return strengthOf(combo.rank, revolution);
}

function comboLabel(combo) {
  if (!combo) return '（空）';
  if (combo.type === 'stair') return `${combo.size} 连阶梯`;
  const names = { 1: '单张', 2: '对子', 3: '三条', 4: '四条' };
  return names[combo.size] || `${combo.size} 条`;
}

function isJokerSingle(combo) {
  return !!combo && combo.type === 'set' && combo.size === 1 && combo.rank === JOKER_RANK;
}

function isSpadeThreeSingle(combo) {
  return !!combo && combo.type === 'set' && combo.size === 1 && combo.cards.length === 1 && combo.cards[0] === 'S3';
}

function toCombo(x, rev) {
  if (!x) return null;
  if (Array.isArray(x)) return comboOf(x, { revolution: rev });
  return x;
}

/**
 * a 能不能压 b（不含縛り，那是场面状态不是牌型关系）。
 * a/b 可以是 comboOf 的结果，也可以直接是牌 id 数组。b 为空 = 空场，随便出。
 * state 只读 revolution / rules.spade3，可传 null。
 */
function beats(a, b, state) {
  const rev = !!(state && state.revolution);
  const rules = (state && state.rules) || DEFAULT_RULES;
  const ca = toCombo(a, rev);
  if (!ca) return false;
  const cb = toCombo(b, rev);
  if (!cb) return true;
  // スペ3：黑桃3 反杀单张王
  if (rules.spade3 && isSpadeThreeSingle(ca) && isJokerSingle(cb)) return true;
  if (ca.type !== cb.type || ca.size !== cb.size) return false;
  return comboStrength(ca, rev) > comboStrength(cb, rev);
}

function sameSuitSet(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function suitSetLabel(suits) {
  return suits.map((x) => SUIT_SYM[x] || x).join('');
}

// ---------------------------------------------------------------- 常量/默认

const DEFAULT_RULES = {
  spade3: true,               // スペ3：黑桃3 反杀单张王
  shibari: false,             // 縛り：连续两手花色组相同 → 本墩锁花色
  kaidan_revolution: false,   // 5 连以上阶梯也触发革命
  forbid_finish: true,        // 禁止上がり：最后一手含 2(革命中 3)/王/8 或 スペ3 收尾 → 判垫底
  miyako_ochi: false          // 都落ち：上轮大富豪没第一个出完，当场跌成大贫民
};

const RANK_NAMES = {
  2: ['daifugo', 'daihinmin'],
  3: ['daifugo', 'heimin', 'daihinmin'],
  4: ['daifugo', 'fugo', 'hinmin', 'daihinmin']
};

const RANK_LABEL = {
  daifugo: '大富豪', fugo: '富豪', heimin: '平民', hinmin: '贫民', daihinmin: '大贫民'
};

// ---------------------------------------------------------------- 工具

function findPlayer(s, id) {
  return s.players.find((p) => p.id === id) || null;
}

function unfinishedPlayers(s) {
  return s.players.filter((p) => p.finished === null);
}

/** turnOrder 上 fromId 之后第一个满足 pred 的人（不含 fromId 自己） */
function nextMatching(s, fromId, pred) {
  const order = s.turnOrder;
  let i = order.indexOf(fromId);
  if (i < 0) i = 0;
  for (let k = 1; k <= order.length; k++) {
    const p = findPlayer(s, order[(i + k) % order.length]);
    if (p && p.id !== fromId && pred(p)) return p;
  }
  return null;
}

/** fromId 之后第一个还没出完的人（fromId 自己不算） */
function nextUnfinished(s, fromId) {
  return nextMatching(s, fromId, (p) => p.finished === null);
}

/** fromId 之后第一个还能在本墩行动的人 */
function nextActive(s, fromId) {
  return nextMatching(s, fromId, (p) => p.finished === null && !p.passed);
}

function sortHand(ids) {
  return sortCards(ids);
}

/** 按当前序取最强的 n 张（换牌自动上缴用；SPEC 指明按普通序） */
function strongestCards(hand, n, revolution) {
  return hand.slice()
    .sort((a, b) => (cardStrength(b, revolution) - cardStrength(a, revolution))
      || (SUIT_ORDER[parseCard(b).suit] - SUIT_ORDER[parseCard(a).suit]))
    .slice(0, n);
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

// ---------------------------------------------------------------- state 拷贝 / 日志

function cloneCombo(c) {
  return c ? Object.assign({}, c, { cards: c.cards.slice(), suits: c.suits.slice() }) : null;
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
      combo: cloneCombo(s.field.combo),
      suits: s.field.suits.slice()
    } : null,
    lastToPlay: s.lastToPlay,
    revolution: s.revolution,
    suitLock: s.suitLock ? s.suitLock.slice() : null,
    exchange: s.exchange ? {
      pending: s.exchange.pending.map((it) => ({
        from: it.from, to: it.to, count: it.count,
        taken: it.taken.slice(),
        given: it.given ? it.given.slice() : null
      }))
    } : null,
    pile: s.pile.slice(),
    finishCount: s.finishCount,
    lastDaifugo: s.lastDaifugo,
    lastResults: s.lastResults ? s.lastResults.map((r) => Object.assign({}, r)) : null,
    rounds: s.rounds.map((r) => ({ round: r.round, results: r.results.map((x) => Object.assign({}, x)) })),
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

// ---------------------------------------------------------------- 发牌 / 开轮 / 结算

function dealRound(ctx) {
  const s = ctx.s;
  const deck = shuffle(s, ALL_CARDS);
  for (const p of s.players) p.hand = [];
  const order = s.turnOrder;
  let start = order.indexOf(s.leader);
  if (start < 0) start = 0;
  for (let i = 0; i < deck.length; i++) {
    findPlayer(s, order[(start + i) % order.length]).hand.push(deck[i]);
  }
  for (const p of s.players) p.hand = sortHand(p.hand);
  logAdd(ctx, 'deal', `第 ${s.round} 轮发牌完毕：${s.players.map((p) => `${p.name} ${p.hand.length} 张`).join('，')}`);
}

/** 第 2 轮起的换牌：贫方自动上缴最强牌，富方欠着一手回赠 */
function setupExchange(ctx) {
  const s = ctx.s;
  const byRank = (r) => s.players.find((p) => p.rank === r) || null;
  const pairs = [];
  const df = byRank('daifugo'), dh = byRank('daihinmin');
  if (df && dh) pairs.push({ rich: df, poor: dh, count: 2 });
  if (s.players.length === 4) {
    const fg = byRank('fugo'), hm = byRank('hinmin');
    if (fg && hm) pairs.push({ rich: fg, poor: hm, count: 1 });
  }
  if (!pairs.length) { s.exchange = null; return; }

  const pending = [];
  for (const pr of pairs) {
    // SPEC：贫方按当前普通序（非革命序）自动上缴最强牌，含王
    const taken = sortCards(strongestCards(pr.poor.hand, pr.count, false));
    pr.poor.hand = sortHand(pr.poor.hand.filter((id) => taken.indexOf(id) < 0));
    pr.rich.hand = sortHand(pr.rich.hand.concat(taken));
    pending.push({ from: pr.rich.id, to: pr.poor.id, count: pr.count, taken, given: null });
    logAdd(ctx, 'exchange', `${pr.poor.name}（${RANK_LABEL[pr.poor.rank]}）向 ${pr.rich.name}（${RANK_LABEL[pr.rich.rank]}）上缴 ${pr.count} 张最强牌`);
  }
  s.exchange = { pending };
  s.phase = 'exchange';
  logAdd(ctx, 'exchange', '等富方回赠牌，回齐才开打');
}

function startRound(ctx) {
  const s = ctx.s;
  s.revolution = false;
  s.field = null;
  s.lastToPlay = null;
  s.suitLock = null;
  s.pile = [];
  s.finishCount = 0;
  s.exchange = null;
  s.lastResults = null;
  for (const p of s.players) {
    p.hand = [];
    p.finished = null;
    p.passed = false;
    p.foul = null;
  }
  if (s.round === 1) {
    s.leader = s.turnOrder[rndInt(s, s.turnOrder.length)];
    s.lastDaifugo = null;
  } else {
    const dh = s.players.find((p) => p.rank === 'daihinmin');
    s.leader = dh ? dh.id : s.turnOrder[rndInt(s, s.turnOrder.length)];
    s.lastDaifugo = (s.players.find((p) => p.rank === 'daifugo') || {}).id || null;
  }
  s.current = s.leader;
  s.phase = 'playing';
  dealRound(ctx);
  logAdd(ctx, 'turn', `${findPlayer(s, s.leader).name} 先出`);
  if (s.round > 1) setupExchange(ctx);
}

function finalizeRound(ctx) {
  const s = ctx.s;
  for (const p of s.players) {
    if (p.finished === null) {
      s.finishCount += 1;
      p.finished = s.finishCount;
    }
  }
  // 犯规（禁止上がり / 都落ち）的人一律踢到最末，其余按出完先后
  const order = s.players.slice().sort((a, b) =>
    ((a.foul ? 1 : 0) - (b.foul ? 1 : 0)) || (a.finished - b.finished));
  const names = RANK_NAMES[s.players.length];
  const results = [];
  order.forEach((p, i) => {
    const gain = s.players.length - 1 - i;
    p.rank = names[i];
    p.score += gain;
    results.push({ playerId: p.id, name: p.name, place: i + 1, rank: names[i], gain, score: p.score, foul: p.foul || null });
  });
  s.lastResults = results;
  s.rounds.push({ round: s.round, results: results.map((r) => Object.assign({}, r)) });
  s.phase = 'round_over';
  s.revolution = false;
  s.field = null;
  s.suitLock = null;
  s.current = null;
  logAdd(ctx, 'round_over', `第 ${s.round} 轮结束：${results.map((r) => `${r.name} ${RANK_LABEL[r.rank]}`).join('，')}`);
}

function checkRoundOver(ctx) {
  const s = ctx.s;
  if (s.phase !== 'playing') return false;
  if (unfinishedPlayers(s).length <= 1) {
    finalizeRound(ctx);
    return true;
  }
  return false;
}

/** 清场：field 归零、pass 解锁，ownerId 领出（已出完就顺位下一个未完者） */
function clearTrick(ctx, ownerId) {
  const s = ctx.s;
  s.field = null;
  s.suitLock = null;
  for (const p of s.players) p.passed = false;
  const owner = findPlayer(s, ownerId);
  const lead = (owner && owner.finished === null) ? owner : nextUnfinished(s, ownerId);
  if (!lead) { s.leader = null; s.current = null; return; }
  s.leader = lead.id;
  s.current = lead.id;
  logAdd(ctx, 'clear', `清场，${lead.name} 重新领出`);
}

/** 某人出完（或被都落ち踢出） */
function finishPlayer(ctx, p, foul) {
  const s = ctx.s;
  s.finishCount += 1;
  p.finished = s.finishCount;
  p.passed = false;
  p.foul = foul || null;
  if (foul === 'forbid_finish') {
    logAdd(ctx, 'finish', `${p.name} 用禁止牌收尾，犯规上がり —— 本轮直接垫底`);
  } else {
    logAdd(ctx, 'finish', `${p.name} 第 ${s.finishCount} 个出完`);
  }
  // 都落ち：第一个出完的不是上轮大富豪 → 上轮大富豪当场跌成大贫民
  if (s.finishCount === 1 && s.rules.miyako_ochi && s.lastDaifugo && p.id !== s.lastDaifugo) {
    const d = findPlayer(s, s.lastDaifugo);
    if (d && d.finished === null) {
      s.pile = s.pile.concat(d.hand);
      d.hand = [];
      s.finishCount += 1;
      d.finished = s.finishCount;
      d.passed = false;
      d.foul = 'miyako_ochi';
      logAdd(ctx, 'miyako_ochi', `都落ち！${d.name} 没能第一个出完，当场跌成大贫民`);
    }
  }
}

// ---------------------------------------------------------------- 出牌合法性

function isSpade3Kill(s, cards) {
  return !!(s.rules.spade3 && s.field && cards.length === 1 && cards[0] === 'S3'
    && isJokerSingle(s.field.combo));
}

/** 跟牌不合法时返回中文原因，合法返回 null（field 为空不该调这个） */
function followError(s, combo, spade3Kill) {
  if (s.suitLock && !sameSuitSet(combo.suits, s.suitLock)) {
    return `縛り生效，本墩只能出 ${suitSetLabel(s.suitLock)} 这组花色`;
  }
  if (spade3Kill) return null;
  const f = s.field.combo;
  if (combo.type !== f.type || combo.size !== f.size) {
    return `场上是${comboLabel(f)}，必须出同型同张数`;
  }
  if (comboStrength(combo, s.revolution) <= comboStrength(f, s.revolution)) {
    return `压不过场上的 ${cardsLabel(f.cards)}`;
  }
  return null;
}

/** 最后一手是不是禁止上がり（revBefore = 出这手时的序） */
function forbiddenFinishReason(s, cards, revBefore, spade3Kill) {
  if (!s.rules.forbid_finish) return null;
  const parsed = cards.map(parseCard);
  if (parsed.some((c) => c.joker)) return '王';
  if (parsed.some((c) => c.rank === 8)) return '8';
  const banned = revBefore ? 3 : 15;
  if (parsed.some((c) => !c.joker && c.rank === banned)) return revBefore ? '3' : '2';
  if (spade3Kill) return 'スペ3 反杀';
  return null;
}

/**
 * 枚举手牌能凑出的全部牌型（filter={type,size} 时只枚举同型同张数，跟牌时快得多）。
 * 返回 [{cards, as}]，同一组牌的不同解释算两条。
 */
function enumerateCombos(hand, filter) {
  const parsed = hand.map(parseCard).filter(Boolean);
  const jokers = parsed.filter((c) => c.joker).map((c) => c.id);
  const byRank = new Map();
  const bySuit = new Map();
  for (const c of parsed) {
    if (c.joker) continue;
    if (!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank).push(c.id);
    if (!bySuit.has(c.suit)) bySuit.set(c.suit, new Map());
    bySuit.get(c.suit).set(c.rank, c.id);
  }
  const out = [];
  const seen = Object.create(null);
  const push = (cards, as) => {
    const sorted = sortCards(cards);
    const key = as + '|' + sorted.join(',');
    if (seen[key]) return;
    seen[key] = true;
    out.push({ cards: sorted, as });
  };

  if (!filter || filter.type === 'set') {
    for (const [, ids] of byRank) {
      for (let a = 1; a <= ids.length; a++) {
        for (let b = 0; b <= jokers.length; b++) {
          const size = a + b;
          if (filter && size !== filter.size) continue;
          for (const ca of combinations(ids, a)) {
            for (const cb of combinations(jokers, b)) push(ca.concat(cb), 'set');
          }
        }
      }
    }
    for (let b = 1; b <= jokers.length; b++) {           // 纯王组
      if (filter && b !== filter.size) continue;
      for (const cb of combinations(jokers, b)) push(cb, 'set');
    }
  }

  if (!filter || filter.type === 'stair') {
    for (const [, have] of bySuit) {
      const maxLen = Math.min(13, have.size + jokers.length);
      const lens = filter ? [filter.size] : [];
      if (!filter) for (let L = 3; L <= maxLen; L++) lens.push(L);
      for (const L of lens) {
        if (L < 3 || L > maxLen) continue;
        for (let lo = 3; lo + L - 1 <= 15; lo++) {
          const present = [];
          for (let r = lo; r < lo + L; r++) if (have.has(r)) present.push(have.get(r));
          if (!present.length) continue;
          const missing = L - present.length;
          if (missing > jokers.length) continue;
          if (missing === 0) { push(present, 'stair'); continue; }
          for (const cb of combinations(jokers, missing)) push(present.concat(cb), 'stair');
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 动作

function actPlay(ctx, p, action) {
  const s = ctx.s;
  if (s.phase === 'exchange') throw new Error('换牌还没完，先等富方回赠');
  if (s.phase !== 'playing') throw new Error('现在不是出牌的时候');
  if (p.finished !== null) throw new Error('你已经出完了，歇着吧');
  if (s.current !== p.id) throw new Error('还没轮到你出牌');

  const cards = Array.isArray(action.cards) ? action.cards.slice() : [];
  if (!cards.length) throw new Error('至少要出一张牌');
  const dup = Object.create(null);
  for (const id of cards) {
    if (dup[id]) throw new Error(`同一张牌不能出两次：${cardLabel(id)}`);
    dup[id] = true;
    if (p.hand.indexOf(id) < 0) throw new Error(`你手里没有 ${cardLabel(id)}`);
  }

  const revBefore = s.revolution;
  const cands = comboCandidates(cards, { revolution: revBefore });
  if (!cands.length) throw new Error('这不是合法的牌型（同 rank 组或同花色 3 连以上阶梯）');
  let list = cands;
  if (action.as) {
    list = cands.filter((c) => c.type === action.as);
    if (!list.length) throw new Error(`这几张牌凑不成${action.as === 'stair' ? '阶梯' : '同 rank 组'}`);
  }

  const spade3Kill = isSpade3Kill(s, cards);
  let combo = null;
  if (!s.field) {
    combo = list[0];
  } else {
    let firstErr = null;
    for (const c of list) {
      const err = followError(s, c, spade3Kill);
      if (!err) { combo = c; break; }
      if (!firstErr) firstErr = err;
    }
    if (!combo) throw new Error(firstErr || '这手牌压不住场上的牌');
  }

  // ---- 落定
  const prevField = s.field;
  p.hand = p.hand.filter((id) => cards.indexOf(id) < 0);
  s.pile = s.pile.concat(combo.cards);
  s.field = { cards: combo.cards.slice(), by: p.id, combo: cloneCombo(combo), suits: combo.suits.slice() };
  s.lastToPlay = p.id;
  logAdd(ctx, 'play', `${p.name} 出 ${cardsLabel(combo.cards)}（${comboLabel(combo)}）`);
  if (spade3Kill) logAdd(ctx, 'spade3', `スペ3！${p.name} 用 ♠3 反杀了单张王`);

  // ---- 縛り：连续两手花色组完全一致
  if (s.rules.shibari && prevField && !s.suitLock && sameSuitSet(combo.suits, prevField.suits)) {
    s.suitLock = combo.suits.slice();
    logAdd(ctx, 'shibari', `縛り！本墩锁死 ${suitSetLabel(s.suitLock)} 这组花色`);
  }

  // ---- 革命 / 革命返し
  const isRevo = (combo.type === 'set' && combo.size >= 4)
    || (s.rules.kaidan_revolution && combo.type === 'stair' && combo.size >= 5);
  if (isRevo) {
    s.revolution = !s.revolution;
    s.field.combo.strength = comboStrength(s.field.combo, s.revolution);
    logAdd(ctx, 'revolution', s.revolution
      ? `革命！${p.name} 掀桌，强弱全反转（王不受影响）`
      : `革命返し！${p.name} 把桌子翻回来了`);
  }

  // ---- 出完 & 禁止上がり
  let justFinished = false;
  if (!p.hand.length) {
    const reason = forbiddenFinishReason(s, combo.cards, revBefore, spade3Kill);
    if (reason) logAdd(ctx, 'forbid_finish', `${p.name} 最后一手带了 ${reason}`);
    finishPlayer(ctx, p, reason ? 'forbid_finish' : null);
    justFinished = true;
  }

  // ---- 八切：任何含 8 的出牌都清场，出牌者继续领出（革命中同样生效）
  const eightCut = combo.cards.some((id) => {
    const c = parseCard(id);
    return c && !c.joker && c.rank === 8;
  });
  if (eightCut) {
    logAdd(ctx, 'eight_cut', `八切！${p.name} 用 8 把场面砍了`);
  }

  if (checkRoundOver(ctx)) return;

  if (eightCut) {
    clearTrick(ctx, p.id);
    return;
  }
  const nxt = nextActive(s, p.id);
  if (!nxt) {
    clearTrick(ctx, s.lastToPlay);
    return;
  }
  s.current = nxt.id;
  if (justFinished) logAdd(ctx, 'turn', `轮到 ${nxt.name}`);
}

function actPass(ctx, p) {
  const s = ctx.s;
  if (s.phase === 'exchange') throw new Error('换牌还没完，先等富方回赠');
  if (s.phase !== 'playing') throw new Error('现在不是出牌的时候');
  if (p.finished !== null) throw new Error('你已经出完了，歇着吧');
  if (s.current !== p.id) throw new Error('还没轮到你');
  if (!s.field) throw new Error('你是这一墩的领出者，必须出牌');
  p.passed = true;
  logAdd(ctx, 'pass', `${p.name} 过`);
  // 最后出牌的那位不算「还能行动」——其余在场未出完者全过了就清场
  const nxt = nextMatching(s, p.id, (q) => q.finished === null && !q.passed && q.id !== s.lastToPlay);
  if (!nxt) {
    clearTrick(ctx, s.lastToPlay);
    return;
  }
  s.current = nxt.id;
}

function actGiveBack(ctx, p, action) {
  const s = ctx.s;
  if (s.phase !== 'exchange' || !s.exchange) throw new Error('现在不是换牌阶段');
  const item = s.exchange.pending.find((it) => it.from === p.id && it.given === null);
  if (!item) throw new Error('你没有要回赠的牌');
  const cards = Array.isArray(action.cards) ? action.cards.slice() : [];
  if (cards.length !== item.count) throw new Error(`要回赠 ${item.count} 张牌，你给了 ${cards.length} 张`);
  const dup = Object.create(null);
  for (const id of cards) {
    if (dup[id]) throw new Error(`同一张牌不能给两次：${cardLabel(id)}`);
    dup[id] = true;
    if (p.hand.indexOf(id) < 0) throw new Error(`你手里没有 ${cardLabel(id)}`);
  }
  const to = findPlayer(s, item.to);
  p.hand = sortHand(p.hand.filter((id) => cards.indexOf(id) < 0));
  to.hand = sortHand(to.hand.concat(cards));
  item.given = sortCards(cards);
  logAdd(ctx, 'exchange', `${p.name} 回赠 ${item.count} 张牌给 ${to.name}`);
  if (s.exchange.pending.every((it) => it.given !== null)) {
    s.phase = 'playing';
    logAdd(ctx, 'turn', `换牌完成，${findPlayer(s, s.leader).name} 先出`);
  }
}

function actNextRound(ctx) {
  const s = ctx.s;
  if (s.phase !== 'round_over') throw new Error('这一轮还没打完');
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
  logAdd(ctx, 'game_over', `整场结束：${board.map((p) => `${p.name} ${p.score} 分`).join('，')}`);
}

// ---------------------------------------------------------------- 对外 API

function createGame(opts) {
  const o = opts || {};
  const players = o.players;
  if (!Array.isArray(players) || players.length < 2 || players.length > 4) {
    throw new Error('玩家人数必须是 2~4 人');
  }
  const cfg = o.config || {};
  const rules = Object.assign({}, DEFAULT_RULES, cfg.defaults || {}, o.rules || {});
  // 只留认识的开关，别让脏字段混进 state.rules
  const clean = {};
  for (const k of Object.keys(DEFAULT_RULES)) clean[k] = !!rules[k];

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
      rank: null,
      finished: null,
      passed: false,
      foul: null,
      score: 0
    };
  });

  const s = {
    seq: 0,
    createdAt: Date.now(),
    phase: 'playing',
    round: 1,
    turnOrder: ps.map((p) => p.id),
    current: null,
    leader: null,
    players: ps,
    field: null,
    lastToPlay: null,
    revolution: false,
    suitLock: null,
    exchange: null,
    pile: [],
    finishCount: 0,
    lastDaifugo: null,
    lastResults: null,
    rounds: [],
    winner: null,
    rules: clean,
    log: [],
    rngState: createRngState(o.seed)
  };

  const ctx = { s, events: [] };
  logAdd(ctx, 'start', `开局：${ps.map((p) => p.name).join('、')}（${ps.length} 人）`);
  startRound(ctx);
  return s;
}

const HANDLERS = {
  play: (ctx, p, a) => actPlay(ctx, p, a),
  pass: (ctx, p) => actPass(ctx, p),
  give_back: (ctx, p, a) => actGiveBack(ctx, p, a),
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
 * playing：全部能出的牌（{type:'play',cards,as,combo,label}）+ 场上有牌时的 {type:'pass'}
 * exchange：富方的全部 {type:'give_back',cards}
 * round_over：[{type:'next_round'}]（end_match 是房主特权，服务端把关，不进这张表）
 */
function legalMoves(state, playerId) {
  const s = state;
  const out = [];
  if (!s || s.phase === 'game_over') return out;
  const p = findPlayer(s, playerId);
  if (!p) return out;

  if (s.phase === 'round_over') return [{ type: 'next_round' }];

  if (s.phase === 'exchange') {
    const item = s.exchange && s.exchange.pending.find((it) => it.from === p.id && it.given === null);
    if (!item) return out;
    for (const cs of combinations(sortHand(p.hand), item.count)) {
      out.push({ type: 'give_back', cards: cs.slice() });
    }
    return out;
  }

  if (p.finished !== null || s.current !== p.id) return out;
  const filter = s.field ? { type: s.field.combo.type, size: s.field.combo.size } : null;
  for (const cand of enumerateCombos(p.hand, filter)) {
    const combo = comboOf(cand.cards, { revolution: s.revolution, as: cand.as });
    if (!combo) continue;
    if (s.field && followError(s, combo, isSpade3Kill(s, cand.cards))) continue;
    out.push({ type: 'play', cards: cand.cards, as: cand.as, combo, label: comboLabel(combo) });
  }
  out.sort((a, b) =>
    (a.combo.type < b.combo.type ? -1 : a.combo.type > b.combo.type ? 1 : 0)
    || (a.combo.size - b.combo.size)
    || (comboStrength(a.combo, s.revolution) - comboStrength(b.combo, s.revolution))
    || (a.cards.join() < b.cards.join() ? -1 : 1));
  if (s.field) out.push({ type: 'pass' });
  return out;
}

/**
 * 脱敏视图。playerId=null / 不认识的 id = 观战：谁的手牌都看不到。
 * 换牌阶段给/收的牌只对当事双方可见。rngState 不外泄。
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
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      isAI: p.isAI,
      rank: p.rank,
      finished: p.finished,
      passed: p.passed,
      foul: p.foul,
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
    revolution: s.revolution,
    suitLock: s.suitLock ? s.suitLock.slice() : null,
    exchange: s.exchange ? {
      pending: s.exchange.pending.map((it) => {
        const mine = meId === it.from || meId === it.to;
        return {
          from: it.from,
          to: it.to,
          count: it.count,
          done: it.given !== null,
          taken: mine ? it.taken.slice() : null,
          given: mine && it.given ? it.given.slice() : null
        };
      })
    } : null,
    pile: s.pile.slice(),
    lastResults: s.lastResults ? s.lastResults.map((r) => Object.assign({}, r)) : null,
    rounds: s.rounds.map((r) => ({ round: r.round, results: r.results.map((x) => Object.assign({}, x)) })),
    winner: s.winner,
    rules: Object.assign({}, s.rules),
    log: s.log.slice()
  };
}

// ---------------------------------------------------------------- 双环境导出

const API = {
  // 主接口
  createGame,
  apply,
  legalMoves,
  viewFor,
  // 牌型判定（前端预判复用）
  comboOf,
  comboCandidates,
  comboStrength,
  comboLabel,
  beats,
  enumerateCombos,
  parseCard,
  cardLabel,
  cardsLabel,
  cardStrength,
  strengthOf,
  sortCards,
  // 杂项（服务端/测试用）
  createRngState,
  rngNext,
  shuffle,
  cloneState,
  ALL_CARDS,
  DEFAULT_RULES,
  RANK_NAMES,
  RANK_LABEL
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.DaifugoEngine = API;
