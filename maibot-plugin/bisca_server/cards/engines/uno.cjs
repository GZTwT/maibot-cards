'use strict';
/**
 * Bisca 棋牌室 — UNO 引擎（纯逻辑，零 I/O）
 *
 * 见 docs/design-cards.md §1 引擎契约 + §2 uno 规则拍板。
 * - meta / createGame / apply / legalMoves / viewFor / currentActors / briefing / fmtMove
 *
 * 所有随机（洗牌/定首家/翻开局牌）走 state.rngState 里的确定性 xorshift128，整局可回放。
 *
 * 牌堆约定：
 *   deck    —— 牌库，**末尾是顶张**（pop 摸牌）
 *   discard —— 弃牌堆，**末尾是顶牌**（play 直接 push）
 *   任何时刻 deck + discard + 各家手牌 恒为 108 张
 *
 * state 里除 SPEC 骨架外多带几样：
 *   dir         —— +1 顺时针 / -1 逆时针
 *   activeColor —— 当前生效颜色（万能牌指定后就是指定色）
 *   pending     —— {playerId, card} 摸牌后待决态：只能出这张或 keep
 *   drawStack   —— stack_draw2 开时累计的 +2 张数（当前 current 就是被指着的人）
 *   leader      —— 本局首家（每局轮换）
 *   lastResults / rounds —— 本局/历局计分（计分板抽屉用）
 *
 * 几条自己拍的裁决（SPEC 没写死的）：
 *   1. 开局翻牌视为「庄家」（首家的上家）打出的一手，功能牌照常结算 —— 官方那套
 *      「翻到 Skip 首家跳过 / 翻到 Reverse 反向且首家上家先手 / 翻到 +2 首家摸2跳过」自然成立。
 *      翻出万能牌（W / W+4）塞回牌库重洗重翻。
 *   2. stack_draw2 开时，被 +2 指着的人只能接 +2（任意颜色，官方家规打法）或摸掉累计；
 *      万能+4 不参与叠加，被 +2 指着时也不能拿 W+4 挡。
 *   3. 收尾牌是 +2 / W+4，下家照样摸（官方：这些牌算进他的手牌分）；stack 开时收尾的 +2
 *      没人能再接，累计张数直接砸给下家。
 *   4. +4 不做质疑、不做罚喊 UNO（SPEC §2 明写 v1 简化）。
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

const COLORS = ['R', 'G', 'B', 'Y'];
const COLOR_NAME = { R: '红', G: '绿', B: '蓝', Y: '黄' };
const COLOR_ORDER = { R: 0, G: 1, B: 2, Y: 3 };
const ACTION_NAME = { S: '跳过', R: '反转', D: '+2' };
const VALUE_ORDER = { S: 10, R: 11, D: 12 };

/**
 * 全副 108 张，顺序固定（洗牌走 RNG）。
 * id = 颜色 + 值 + '#' + 第几张：'R5#1'/'R5#2'/'RS#1'(Skip)/'RR#1'(Reverse)/'RD#1'(+2)、
 * 万能 'W#1'~'W#4'、万能+4 'WD#1'~'WD#4'。每张物理牌 id 全局唯一。
 */
const ALL_CARDS = (() => {
  const out = [];
  for (const c of COLORS) {
    out.push(c + '0#1');                                   // 0 每色 1 张
    for (let n = 1; n <= 9; n++) out.push(c + n + '#1', c + n + '#2');
    for (const k of ['S', 'R', 'D']) out.push(c + k + '#1', c + k + '#2');
  }
  for (let i = 1; i <= 4; i++) out.push('W#' + i);
  for (let i = 1; i <= 4; i++) out.push('WD#' + i);
  return out;
})();

const CARD_SET = (() => {
  const m = Object.create(null);
  for (const id of ALL_CARDS) m[id] = true;
  return m;
})();

/**
 * "R5#2" -> {id,color,value,kind,num,points,wild}；不是这副牌里的 id 返回 null。
 * kind: 'num' | 'skip' | 'rev' | 'draw2' | 'wild' | 'wild4'
 */
function parseCard(id) {
  if (typeof id !== 'string' || !CARD_SET[id]) return null;
  const base = id.slice(0, id.indexOf('#'));
  if (base === 'W' || base === 'WD') {
    return {
      id, color: null, value: base, kind: base === 'W' ? 'wild' : 'wild4',
      num: null, points: 50, wild: true
    };
  }
  const color = base[0];
  const v = base.slice(1);
  if (ACTION_NAME[v]) {
    return {
      id, color, value: v, kind: v === 'S' ? 'skip' : v === 'R' ? 'rev' : 'draw2',
      num: null, points: 20, wild: false
    };
  }
  const n = Number(v);
  return { id, color, value: v, kind: 'num', num: n, points: n, wild: false };
}

/** '红5' / '蓝+2' / '绿跳过' / '万能' / '万能+4' */
function cardLabel(id) {
  const c = parseCard(id);
  if (!c) return String(id);
  if (c.kind === 'wild') return '万能';
  if (c.kind === 'wild4') return '万能+4';
  return COLOR_NAME[c.color] + (ACTION_NAME[c.value] || c.value);
}

function cardsLabel(ids) {
  return ids.map(cardLabel).join(' ');
}

/** 手牌排序：R→G→B→Y→万能，同色 0-9 → 跳过 → 反转 → +2 */
function cardCmp(a, b) {
  const ca = parseCard(a), cb = parseCard(b);
  if (!ca || !cb) return String(a) < String(b) ? -1 : 1;
  const oa = ca.wild ? 4 : COLOR_ORDER[ca.color];
  const ob = cb.wild ? 4 : COLOR_ORDER[cb.color];
  if (oa !== ob) return oa - ob;
  const va = ca.wild ? (ca.kind === 'wild' ? 0 : 1) : (VALUE_ORDER[ca.value] !== undefined ? VALUE_ORDER[ca.value] : ca.num);
  const vb = cb.wild ? (cb.kind === 'wild' ? 0 : 1) : (VALUE_ORDER[cb.value] !== undefined ? VALUE_ORDER[cb.value] : cb.num);
  if (va !== vb) return va - vb;
  return a < b ? -1 : 1;
}

function sortCards(ids) {
  return ids.slice().sort(cardCmp);
}

/** 手牌分：数字=面值、跳过/反转/+2=20、万能/万能+4=50 */
function cardPoints(id) {
  const c = parseCard(id);
  return c ? c.points : 0;
}

function handPoints(ids) {
  return ids.reduce((n, id) => n + cardPoints(id), 0);
}

// ---------------------------------------------------------------- 常量/默认

const DEFAULT_RULES = {
  stack_draw2: false          // +2 叠加：被 +2 指到还能再出 +2 转嫁下家
};

const meta = {
  key: 'uno',
  name: 'UNO',
  minPlayers: 2,
  maxPlayers: 4,
  defaultRules: { stack_draw2: false },
  ruleMeta: [
    { key: 'stack_draw2', label: '+2 叠加', note: '被 +2 时可再出 +2 转嫁下家', def: false }
  ]
};

// ---------------------------------------------------------------- 工具

function findPlayer(s, id) {
  return s.players.find((p) => p.id === id) || null;
}

function topCard(s) {
  return s.discard.length ? s.discard[s.discard.length - 1] : null;
}

function dirLabel(dir) {
  return dir > 0 ? '顺时针' : '逆时针';
}

/** 从 fromId 出发，按当前方向数 steps 个座位 */
function seatAt(s, fromId, steps) {
  const order = s.turnOrder;
  const n = order.length;
  let i = order.indexOf(fromId);
  if (i < 0) i = 0;
  return order[(((i + s.dir * steps) % n) + n) % n];
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
    dir: s.dir,
    players: s.players.map((p) => Object.assign({}, p, { hand: p.hand.slice() })),
    deck: s.deck.slice(),
    discard: s.discard.slice(),
    activeColor: s.activeColor,
    pending: s.pending ? { playerId: s.pending.playerId, card: s.pending.card } : null,
    drawStack: s.drawStack,
    lastResults: s.lastResults ? cloneResults(s.lastResults) : null,
    rounds: s.rounds.map(cloneResults),
    winner: s.winner,
    log: s.log.slice(),
    logSeq: s.logSeq,
    rngState: s.rngState.slice(),
    // 规则表只读，直接共用引用
    rules: s.rules
  };
}

function cloneResults(r) {
  return {
    round: r.round,
    winner: r.winner,
    gain: r.gain,
    players: r.players.map((x) => Object.assign({}, x))
  };
}

/**
 * 日志只留最近 LOG_KEEP 条（logSeq 单调递增，前端按 seq 去重照样对得上）。
 * UNO 一局的步数比大富豪多得多，state 每次 apply 都要整份克隆，日志不封顶会拖成平方级。
 */
const LOG_KEEP = 400;

function logAdd(ctx, type, text) {
  const s = ctx.s;
  s.logSeq += 1;
  const entry = { seq: s.logSeq, t: s.seq, text, type };
  s.log.push(entry);
  if (s.log.length > LOG_KEEP) s.log = s.log.slice(-LOG_KEEP);
  ctx.events.push(entry);
  return entry;
}

// ---------------------------------------------------------------- 牌库 / 发牌

/** 牌库空了就把弃牌堆（留顶牌）洗回来；洗不出来返回 false */
function refillDeck(ctx) {
  const s = ctx.s;
  if (s.deck.length) return true;
  if (s.discard.length <= 1) return false;
  const top = s.discard[s.discard.length - 1];
  const rest = s.discard.slice(0, -1);
  s.discard = [top];
  s.deck = shuffle(s, rest);
  logAdd(ctx, 'reshuffle', `牌库摸空了，把弃牌堆 ${rest.length} 张洗回牌库`);
  return true;
}

/** 摸 n 张（牌库+弃堆都榨干时可能摸不满），返回真正摸到的牌 */
function drawCards(ctx, p, n) {
  const s = ctx.s;
  const got = [];
  for (let i = 0; i < n; i++) {
    if (!s.deck.length && !refillDeck(ctx)) break;
    got.push(s.deck.pop());
  }
  if (got.length) p.hand = sortCards(p.hand.concat(got));
  return got;
}

/**
 * 翻开局牌：万能牌塞回去重翻（SPEC §2）。
 * 翻到的功能牌当作「庄家」（首家上家）打出的一手，effect 里自然把首家 skip/反向/摸2 结算掉。
 */
function flipStarter(ctx) {
  const s = ctx.s;
  const held = [];
  let top = null;
  while (s.deck.length) {
    const id = s.deck.pop();
    if (parseCard(id).wild) { held.push(id); continue; }
    top = id;
    break;
  }
  if (held.length) {
    s.deck = shuffle(s, s.deck.concat(held));
    logAdd(ctx, 'flip', `翻出${held.length > 1 ? ` ${held.length} 张` : ''}万能牌，塞回牌库重翻`);
  }
  if (!top) throw new Error('牌不够翻开局牌了');
  s.discard = [top];
  s.activeColor = parseCard(top).color;
  logAdd(ctx, 'flip', `翻开 ${cardLabel(top)} 作开局牌，当前颜色${COLOR_NAME[s.activeColor]}`);
  const n = s.turnOrder.length;
  const dealer = s.turnOrder[(s.turnOrder.indexOf(s.leader) - 1 + n) % n];
  s.current = s.leader;
  resolveEffect(ctx, dealer, top);
}

function startRound(ctx) {
  const s = ctx.s;
  s.dir = 1;
  s.pending = null;
  s.drawStack = 0;
  s.lastResults = null;
  s.discard = [];
  for (const p of s.players) p.hand = [];
  s.deck = shuffle(s, ALL_CARDS);
  const order = s.turnOrder;
  const n = order.length;
  let start = order.indexOf(s.leader);
  if (start < 0) start = 0;
  for (let k = 0; k < 7; k++) {
    for (let i = 0; i < n; i++) findPlayer(s, order[(start + i) % n]).hand.push(s.deck.pop());
  }
  for (const p of s.players) p.hand = sortCards(p.hand);
  s.phase = 'playing';
  logAdd(ctx, 'deal', `第 ${s.round} 局发牌：每人 7 张，${findPlayer(s, s.leader).name} 是首家`);
  flipStarter(ctx);
  logAdd(ctx, 'turn', `轮到 ${findPlayer(s, s.current).name}`);
}

// ---------------------------------------------------------------- 出牌合法性

/** 出这张牌不合法时返回中文原因，合法返回 null */
function playError(s, p, cardId) {
  const c = parseCard(cardId);
  if (!c) return `不认识这张牌：${cardId}`;
  if (p.hand.indexOf(cardId) < 0) return `你手里没有 ${cardLabel(cardId)}`;
  if (s.pending && s.pending.playerId === p.id && s.pending.card !== cardId) {
    return `你刚摸了一张，这一手只能出 ${cardLabel(s.pending.card)} 或者过`;
  }
  if (s.drawStack > 0) {
    // 叠加战里只认 +2（任意颜色），万能+4 挡不住
    return c.kind === 'draw2' ? null
      : `被 +2 指着，只能再出一张 +2 转嫁下家，或者摸 ${s.drawStack} 张`;
  }
  if (c.kind === 'wild') return null;
  if (c.kind === 'wild4') {
    const hasColor = p.hand.some((id) => {
      const x = parseCard(id);
      return x && !x.wild && x.color === s.activeColor;
    });
    return hasColor ? `手里还有${COLOR_NAME[s.activeColor]}牌，不能出万能+4` : null;
  }
  if (c.color === s.activeColor) return null;
  const top = parseCard(topCard(s));
  if (top && !top.wild && top.value === c.value) return null;
  return `${cardLabel(cardId)} 既不是${COLOR_NAME[s.activeColor]}色，也接不上 ${cardLabel(topCard(s))}`;
}

function canPlay(s, p, cardId) {
  return playError(s, p, cardId) === null;
}

// ---------------------------------------------------------------- 回合推进

/**
 * 结算一张打出去的牌（含开局翻牌），负责摸牌惩罚 + 把 s.current 推到下一个该动的人。
 * actorId 是「打出这张牌的人」（开局翻牌时是虚拟庄家）。
 */
function resolveEffect(ctx, actorId, cardId) {
  const s = ctx.s;
  const c = parseCard(cardId);
  const n = s.turnOrder.length;

  if (c.kind === 'rev') {
    s.dir = -s.dir;
    // 2 人局 Reverse = Skip：转一圈回到自己
    s.current = seatAt(s, actorId, n === 2 ? 2 : 1);
    logAdd(ctx, 'reverse', n === 2
      ? `2 人局的反转当跳过用，${findPlayer(s, s.current).name} 接着走`
      : `方向反转，改${dirLabel(s.dir)}`);
    return;
  }

  if (c.kind === 'skip') {
    const victim = findPlayer(s, seatAt(s, actorId, 1));
    s.current = seatAt(s, actorId, 2);
    logAdd(ctx, 'skip', `${victim.name} 被跳过`);
    return;
  }

  if (c.kind === 'draw2') {
    if (s.rules.stack_draw2) {
      s.drawStack += 2;
      s.current = seatAt(s, actorId, 1);
      logAdd(ctx, 'draw2', `+2 累到 ${s.drawStack} 张，${findPlayer(s, s.current).name} 接一张 +2 或者摸掉`);
      return;
    }
    const victim = findPlayer(s, seatAt(s, actorId, 1));
    const got = drawCards(ctx, victim, 2);
    s.current = seatAt(s, actorId, 2);
    logAdd(ctx, 'draw2', `${victim.name} 摸 ${got.length} 张并跳过`);
    return;
  }

  if (c.kind === 'wild4') {
    const victim = findPlayer(s, seatAt(s, actorId, 1));
    const got = drawCards(ctx, victim, 4);
    s.current = seatAt(s, actorId, 2);
    logAdd(ctx, 'wild4', `${victim.name} 摸 ${got.length} 张并跳过`);
    return;
  }

  s.current = seatAt(s, actorId, 1);
}

// ---------------------------------------------------------------- 结算

function finalizeRound(ctx, winner) {
  const s = ctx.s;
  let total = 0;
  const rows = s.players.map((q) => {
    const pts = handPoints(q.hand);
    if (q.id !== winner.id) total += pts;
    return { playerId: q.id, name: q.name, handCount: q.hand.length, handPoints: pts, gain: 0, score: 0 };
  });
  winner.score += total;
  for (const r of rows) {
    r.gain = r.playerId === winner.id ? total : 0;
    r.score = findPlayer(s, r.playerId).score;
  }
  const res = { round: s.round, winner: winner.id, gain: total, players: rows };
  s.lastResults = res;
  s.rounds.push(cloneResults(res));
  s.phase = 'round_over';
  s.current = null;
  s.pending = null;
  s.drawStack = 0;
  const rest = rows.filter((r) => r.playerId !== winner.id)
    .map((r) => `${r.name} ${r.handPoints} 分`).join('，');
  logAdd(ctx, 'round_over', `第 ${s.round} 局结束：${winner.name} 出完，收 ${total} 分（${rest}）`);
}

// ---------------------------------------------------------------- 动作

function actPlay(ctx, p, action) {
  const s = ctx.s;
  if (s.phase !== 'playing') throw new Error('现在不是出牌的时候');
  if (s.current !== p.id) throw new Error('还没轮到你出牌');
  const card = action.card;
  if (typeof card !== 'string' || !card) throw new Error('要出哪张牌？');
  const err = playError(s, p, card);
  if (err) throw new Error(err);

  const c = parseCard(card);
  let color = null;
  if (c.wild) {
    color = action.color;
    if (COLORS.indexOf(color) < 0) throw new Error('出万能牌必须指定颜色（R/G/B/Y）');
  }

  // ---- 落定
  s.pending = null;
  p.hand = p.hand.filter((id) => id !== card);
  s.discard.push(card);
  s.activeColor = c.wild ? color : c.color;
  logAdd(ctx, 'play', c.wild
    ? `${p.name} 出 ${cardLabel(card)}，指定颜色${COLOR_NAME[color]}`
    : `${p.name} 出 ${cardLabel(card)}`);
  if (p.hand.length === 1) logAdd(ctx, 'uno', `UNO！${p.name} 只剩一张牌`);

  resolveEffect(ctx, p.id, card);

  if (!p.hand.length) {
    // 收尾的 +2 在叠加战里没人能再接，累计张数直接砸给下家
    if (s.drawStack > 0) {
      const victim = findPlayer(s, s.current);
      const got = drawCards(ctx, victim, s.drawStack);
      logAdd(ctx, 'draw2', `${victim.name} 吃下收尾的 +2，摸 ${got.length} 张`);
      s.drawStack = 0;
    }
    finalizeRound(ctx, p);
    return;
  }
  logAdd(ctx, 'turn', `轮到 ${findPlayer(s, s.current).name}`);
}

function actDraw(ctx, p) {
  const s = ctx.s;
  if (s.phase !== 'playing') throw new Error('现在不是摸牌的时候');
  if (s.current !== p.id) throw new Error('还没轮到你');
  if (s.pending) throw new Error('你刚摸了一张，出掉它或者过');

  if (s.drawStack > 0) {
    const n = s.drawStack;
    const got = drawCards(ctx, p, n);
    s.drawStack = 0;
    s.current = seatAt(s, p.id, 1);
    logAdd(ctx, 'draw', `${p.name} 接不住，摸 ${got.length} 张并跳过`);
    logAdd(ctx, 'turn', `轮到 ${findPlayer(s, s.current).name}`);
    return;
  }

  const got = drawCards(ctx, p, 1);
  if (!got.length) {
    s.current = seatAt(s, p.id, 1);
    logAdd(ctx, 'draw', `${p.name} 想摸牌，可牌库和弃牌堆都空了，只能过`);
    logAdd(ctx, 'turn', `轮到 ${findPlayer(s, s.current).name}`);
    return;
  }
  const card = got[0];
  logAdd(ctx, 'draw', `${p.name} 摸了一张`);
  if (canPlay(s, p, card)) {
    s.pending = { playerId: p.id, card };
    logAdd(ctx, 'pending', `${p.name} 摸到的牌能出，出还是留着`);
    return;
  }
  s.current = seatAt(s, p.id, 1);
  logAdd(ctx, 'turn', `${p.name} 摸到的牌出不了，轮到 ${findPlayer(s, s.current).name}`);
}

function actKeep(ctx, p) {
  const s = ctx.s;
  if (s.phase !== 'playing') throw new Error('现在不是出牌的时候');
  if (!s.pending || s.pending.playerId !== p.id) throw new Error('你现在没有刚摸的牌要处理');
  s.pending = null;
  s.current = seatAt(s, p.id, 1);
  logAdd(ctx, 'keep', `${p.name} 摸到的牌留着不出`);
  logAdd(ctx, 'turn', `轮到 ${findPlayer(s, s.current).name}`);
}

function actNextRound(ctx) {
  const s = ctx.s;
  if (s.phase !== 'round_over') throw new Error('这一局还没打完');
  const n = s.turnOrder.length;
  s.leader = s.turnOrder[(s.turnOrder.indexOf(s.leader) + 1) % n];   // 首家轮换
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
  s.pending = null;
  logAdd(ctx, 'game_over', `整场结束：${board.map((p) => `${p.name} ${p.score} 分`).join('，')}`);
}

// ---------------------------------------------------------------- 对外 API

function createGame(opts) {
  const o = opts || {};
  const players = o.players;
  if (!Array.isArray(players) || players.length < meta.minPlayers || players.length > meta.maxPlayers) {
    throw new Error(`玩家人数必须是 ${meta.minPlayers}~${meta.maxPlayers} 人`);
  }
  // 规则开关三种塞法都认：config 平着塞 / config.defaults / config.rules / 顶层 rules
  // （cards/server.cjs 走的是平着塞 config 那条路，daifugo 当年就是这里漏读，规则开关白设了）
  const cfg = o.config || {};
  const rules = Object.assign({}, DEFAULT_RULES, cfg, cfg.defaults || {}, cfg.rules || {}, o.rules || {});
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
    dir: 1,
    players: ps,
    deck: [],
    discard: [],
    activeColor: null,
    pending: null,
    drawStack: 0,
    lastResults: null,
    rounds: [],
    winner: null,
    rules: clean,
    log: [],
    logSeq: 0,
    rngState: createRngState(o.seed)
  };

  const ctx = { s, events: [] };
  logAdd(ctx, 'start', `开局：${ps.map((p) => p.name).join('、')}（${ps.length} 人）`);
  s.leader = s.turnOrder[rndInt(s, s.turnOrder.length)];
  startRound(ctx);
  return s;
}

const HANDLERS = {
  play: (ctx, p, a) => actPlay(ctx, p, a),
  draw: (ctx, p) => actDraw(ctx, p),
  keep: (ctx, p) => actKeep(ctx, p),
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

/** 一张能出的牌 -> move（万能牌按 4 色展开成 4 条） */
function pushPlayMoves(out, cardId) {
  const c = parseCard(cardId);
  if (c.wild) {
    for (const col of COLORS) {
      const mv = { type: 'play', card: cardId, color: col };
      mv.label = fmtMove(mv);
      out.push(mv);
    }
    return;
  }
  const mv = { type: 'play', card: cardId };
  mv.label = fmtMove(mv);
  out.push(mv);
}

/**
 * 该玩家此刻的合法动作。
 * playing：能出的牌（万能展开 4 色）+ {type:'draw'}；pending 摸牌态只有刚摸那张 + {type:'keep'}
 * round_over：[{type:'next_round'}]（end_match 是房主特权，服务端把关，不进这张表）
 */
function legalMoves(state, playerId) {
  const s = state;
  const out = [];
  if (!s || s.phase === 'game_over') return out;
  const p = findPlayer(s, playerId);
  if (!p) return out;
  if (s.phase === 'round_over') return [{ type: 'next_round', label: fmtMove({ type: 'next_round' }) }];
  if (s.phase !== 'playing' || s.current !== p.id) return out;

  if (s.pending && s.pending.playerId === p.id) {
    if (canPlay(s, p, s.pending.card)) pushPlayMoves(out, s.pending.card);
    const keep = { type: 'keep' };
    keep.label = fmtMove(keep);
    out.push(keep);
    return out;
  }

  for (const id of sortCards(p.hand)) if (canPlay(s, p, id)) pushPlayMoves(out, id);
  const draw = { type: 'draw' };
  if (s.drawStack > 0) draw.count = s.drawStack;
  draw.label = fmtMove(draw);
  out.push(draw);
  return out;
}

/**
 * 脱敏视图。playerId=null / 不认识的 id = 观战：谁的手牌都看不到。
 * 牌库内容、别人手牌、别人刚摸的那张、rngState 都不外泄。
 */
function viewFor(state, playerId) {
  const s = state;
  const me = playerId ? findPlayer(s, playerId) : null;
  const meId = me ? me.id : null;
  const top = topCard(s);
  return {
    seq: s.seq,
    createdAt: s.createdAt,
    phase: s.phase,
    round: s.round,
    turnOrder: s.turnOrder.slice(),
    current: s.current,
    leader: s.leader,
    dir: s.dir,
    dirLabel: dirLabel(s.dir),
    you: meId,
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      isAI: p.isAI,
      score: p.score,
      handCount: p.hand.length,
      uno: p.hand.length === 1,
      hand: (meId && p.id === meId) ? p.hand.slice() : null
    })),
    top,
    topLabel: top ? cardLabel(top) : null,
    activeColor: s.activeColor,
    activeColorName: s.activeColor ? COLOR_NAME[s.activeColor] : null,
    deckCount: s.deck.length,
    discardCount: s.discard.length,
    drawStack: s.drawStack,
    pending: s.pending ? {
      playerId: s.pending.playerId,
      mine: meId === s.pending.playerId,
      card: meId === s.pending.playerId ? s.pending.card : null
    } : null,
    lastResults: s.lastResults ? cloneResults(s.lastResults) : null,
    rounds: s.rounds.map(cloneResults),
    winner: s.winner,
    rules: Object.assign({}, s.rules),
    log: s.log.slice()
  };
}

/**
 * 现在欠动作的人。playing 就是 current（pending 摸牌态的人也是 current 本人）。
 * round_over 返回 []：开下一局是房主/真人的决定，不让自动 AI自己续摊（照 daifugo 的做法）。
 */
function currentActors(state) {
  const s = state;
  if (!s || s.phase !== 'playing' || !s.current) return [];
  return [s.current];
}

/** 手牌按颜色分组排一行：'红3 红跳过 | 蓝+2 | 万能' */
function handLine(hand) {
  if (!hand.length) return '（空）';
  const groups = [];
  let cur = null, curKey = null;
  for (const id of sortCards(hand)) {
    const c = parseCard(id);
    const key = c.wild ? 'W' : c.color;
    if (key !== curKey) { cur = []; curKey = key; groups.push(cur); }
    cur.push(cardLabel(id));
  }
  return groups.map((g) => g.join(' ')).join(' | ');
}

/** 中文局面简报（不含合法招列表） */
function briefing(state, playerId) {
  const s = state;
  const me = playerId ? findPlayer(s, playerId) : null;
  const lines = [];

  if (s.phase === 'game_over') {
    const board = s.players.slice().sort((a, b) => b.score - a.score);
    lines.push(`整场结束：${board.map((p) => `${p.name} ${p.score} 分`).join('，')}`);
    if (s.winner) lines.push(`冠军：${findPlayer(s, s.winner).name}`);
    return lines.join('\n');
  }

  if (s.phase === 'round_over') {
    const r = s.lastResults;
    lines.push(`第 ${s.round} 局结束。`);
    if (r) {
      lines.push(`${findPlayer(s, r.winner).name} 出完，收 ${r.gain} 分。`);
      lines.push(r.players.map((x) => `${x.name} ${x.score} 分`).join('，'));
    }
    lines.push('等开下一局。');
    return lines.join('\n');
  }

  lines.push(`第 ${s.round} 局 · ${dirLabel(s.dir)} · 牌库剩 ${s.deck.length} 张`);
  lines.push(`顶牌 ${cardLabel(topCard(s))}，当前颜色${COLOR_NAME[s.activeColor]}`);
  if (me) lines.push(`你的手牌（${me.hand.length} 张）：${handLine(me.hand)}`);
  lines.push(`各家：${s.players.map((p) => `${p.name} ${p.hand.length} 张`).join('，')}`);

  const unos = s.players.filter((p) => p.hand.length === 1);
  if (unos.length) lines.push(`UNO 警报：${unos.map((p) => p.name).join('、')} 只剩 1 张！`);
  if (s.drawStack > 0) lines.push(`+2 已累到 ${s.drawStack} 张，${findPlayer(s, s.current).name} 要么接 +2 要么摸掉。`);

  const cur = s.current ? findPlayer(s, s.current) : null;
  if (!cur) return lines.join('\n');
  const mine = me && cur.id === me.id;
  if (s.pending && s.pending.playerId === cur.id) {
    lines.push(mine
      ? `你刚摸到 ${cardLabel(s.pending.card)}，可以出掉它，也可以留着过。`
      : `${cur.name} 刚摸了一张，正在想出不出。`);
  } else {
    lines.push(mine ? '轮到你了。' : `轮到 ${cur.name}。`);
  }
  return lines.join('\n');
}

/** 一招的人话：'红5' / '蓝+2' / '万能变绿' / '摸一张' */
function fmtMove(move) {
  const m = (typeof move === 'string') ? { type: move } : (move || {});
  switch (m.type) {
    case 'play': {
      const c = parseCard(m.card);
      if (c && c.wild && m.color) return cardLabel(m.card) + '变' + (COLOR_NAME[m.color] || m.color);
      return cardLabel(m.card);
    }
    case 'draw':
      return m.count > 1 ? `摸 ${m.count} 张` : '摸一张';
    case 'keep':
      return '不出，过';
    case 'next_round':
      return '开下一局';
    case 'end_match':
      return '结束整场';
    default:
      return String(m.type || '(空)');
  }
}

// ---------------------------------------------------------------- 双环境导出

const API = {
  // SPEC §1 八件套
  meta,
  createGame,
  apply,
  legalMoves,
  viewFor,
  currentActors,
  briefing,
  fmtMove,
  // 牌面工具（前端复用）
  parseCard,
  cardLabel,
  cardsLabel,
  cardPoints,
  handPoints,
  sortCards,
  canPlay,
  playError,
  // 杂项（服务端/测试用）
  createRngState,
  rngNext,
  shuffle,
  cloneState,
  ALL_CARDS,
  COLORS,
  COLOR_NAME,
  DEFAULT_RULES
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.UnoEngine = API;
