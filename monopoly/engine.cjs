'use strict';
/**
 * Bisca 大富翁 — 游戏引擎（纯逻辑，零 I/O）
 *
 * 见 docs/design-monopoly.md 第 2 章。
 * - createGame({players, board, cards, config, seed}) -> state
 * - apply(state, playerId, action) -> {state, events}   // 不改入参，非法动作 throw 中文 Error
 * - 所有随机（掷骰/洗牌/抽卡）走 state.rngState 里的确定性 xorshift128
 *
 * state 里除 SPEC 骨架外多带三样（服务端/前端可忽略）：
 *   board / cards / config —— apply 只收 state，规则表必须随 state 走
 *   extraRoll  —— 本回合掷出双数、结束回合后同一人再掷
 *   debtQueue  —— 同一时刻出现第二笔付不起的欠款时排队（pendingDebt 是队首）
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

// ---------------------------------------------------------------- 常量/默认

const DEFAULT_CONFIG = {
  startCash: 15000,
  salary: 2000,
  bail: 500,
  luxury_tax: 1000,
  maxHouses: 5,          // 第 5 栋 = 旅馆
  jailMaxTurns: 3,       // 蹲满 3 回合强制交保
  railRents: [250, 500, 1000, 2000],
  utilMultipliers: [40, 100],
  jailCell: null         // 不填自动找 type==='jail' 的格
};

const DECK_LABEL = { chance: '机会', community: '命运' };

// ---------------------------------------------------------------- 工具

function normalizeBoard(board) {
  const cells = Array.isArray(board) ? board : (board && Array.isArray(board.cells) ? board.cells : null);
  if (!cells || !cells.length) throw new Error('棋盘数据不合法：至少要有一格');
  return cells.map((c, i) => Object.assign({ idx: i, type: 'parking', name: '空地' }, c));
}

function normalizeCards(cards) {
  const src = cards || {};
  const pick = (k) => (Array.isArray(src[k]) ? src[k] : []);
  return { chance: pick('chance'), community: pick('community') };
}

function findPlayer(s, id) {
  return s.players.find((p) => p.id === id) || null;
}

function cur(s) {
  return findPlayer(s, s.currentPlayer);
}

function cellAt(s, idx) {
  return s.board[idx];
}

function cellName(s, idx) {
  const c = s.board[idx];
  return c ? c.name : `第 ${idx} 格`;
}

function money(n) {
  return `¥${n}`;
}

function activePlayers(s) {
  return s.players.filter((p) => !p.bankrupt);
}

/** 某玩家在某色组里持有的格子索引 */
function groupCells(s, group) {
  const out = [];
  for (let i = 0; i < s.board.length; i++) {
    if (s.board[i].type === 'prop' && s.board[i].group === group) out.push(i);
  }
  return out;
}

function groupFullyOwned(s, group, ownerId) {
  if (!group) return false;
  const idxs = groupCells(s, group);
  if (!idxs.length) return false;
  return idxs.every((i) => s.cells[i] && s.cells[i].owner === ownerId);
}

function countTypeOwned(s, type, ownerId) {
  let n = 0;
  for (let i = 0; i < s.board.length; i++) {
    if (s.board[i].type === type && s.cells[i] && s.cells[i].owner === ownerId) n++;
  }
  return n;
}

function ownedCells(s, ownerId) {
  return Object.keys(s.cells)
    .map(Number)
    .filter((i) => s.cells[i] && s.cells[i].owner === ownerId)
    .sort((a, b) => a - b);
}

function houseCostOf(s, idx) {
  const c = cellAt(s, idx);
  return (c && c.houseCost) || 0;
}

function housesOf(s, idx) {
  return (s.cells[idx] && s.cells[idx].houses) || 0;
}

function jailIndex(s) {
  if (s.config.jailCell !== null && s.config.jailCell !== undefined) return s.config.jailCell;
  const i = s.board.findIndex((c) => c.type === 'jail');
  return i >= 0 ? i : 0;
}

function diceSum(s) {
  return s.dice ? s.dice[0] + s.dice[1] : 0;
}

/**
 * 租金查询（导出给前端/测试用）。idx 无主返回 0。
 */
function rentFor(state, idx) {
  const s = state;
  const own = s.cells[idx];
  const cell = cellAt(s, idx);
  if (!own || !cell) return 0;
  if (cell.type === 'prop') {
    const rents = cell.rents || [];
    const h = own.houses || 0;
    if (h > 0) return rents[Math.min(h, rents.length - 1)] || 0;
    const base = rents[0] || 0;
    return groupFullyOwned(s, cell.group, own.owner) ? base * 2 : base;
  }
  if (cell.type === 'rail') {
    const table = (Array.isArray(cell.rents) && cell.rents.length >= 4) ? cell.rents : s.config.railRents;
    const n = countTypeOwned(s, 'rail', own.owner);
    if (n <= 0) return 0;
    return table[Math.min(n, table.length) - 1] || 0;
  }
  if (cell.type === 'util') {
    const mults = (Array.isArray(cell.multipliers) && cell.multipliers.length >= 2)
      ? cell.multipliers : s.config.utilMultipliers;
    const n = countTypeOwned(s, 'util', own.owner);
    if (n <= 0) return 0;
    const m = mults[Math.min(n, mults.length) - 1] || 0;
    return diceSum(s) * m;
  }
  return 0;
}

// ---------------------------------------------------------------- state 拷贝 / 日志

function cloneState(s) {
  const cells = {};
  for (const k of Object.keys(s.cells)) cells[k] = Object.assign({}, s.cells[k]);
  return {
    seq: s.seq,
    createdAt: s.createdAt,
    phase: s.phase,
    currentPlayer: s.currentPlayer,
    dice: s.dice ? s.dice.slice() : null,
    doublesCount: s.doublesCount,
    extraRoll: s.extraRoll,
    players: s.players.map((p) => Object.assign({}, p, { jailCards: p.jailCards.map((c) => Object.assign({}, c)) })),
    cells,
    decks: {
      chance: { draw: s.decks.chance.draw.slice(), discard: s.decks.chance.discard.slice() },
      community: { draw: s.decks.community.draw.slice(), discard: s.decks.community.discard.slice() }
    },
    pendingCard: s.pendingCard ? { deck: s.pendingCard.deck, card: s.pendingCard.card } : null,
    pendingDebt: s.pendingDebt ? Object.assign({}, s.pendingDebt) : null,
    debtQueue: s.debtQueue.map((d) => Object.assign({}, d)),
    log: s.log.slice(),
    winner: s.winner,
    rngState: s.rngState.slice(),
    // 规则表只读，直接共用引用
    board: s.board,
    cards: s.cards,
    config: s.config
  };
}

function logAdd(ctx, type, text) {
  const entry = { seq: ctx.s.log.length + 1, t: ctx.s.seq, text, type };
  ctx.s.log.push(entry);
  ctx.events.push(entry);
  return entry;
}

// ---------------------------------------------------------------- 钱

/** 卖房自救的候选：只能从组内房子最多的格子上拆（保持均衡） */
function sellableCells(s, p) {
  return ownedCells(s, p.id).filter((i) => {
    if (housesOf(s, i) <= 0) return false;
    const cell = cellAt(s, i);
    const peers = groupCells(s, cell.group);
    const max = peers.reduce((m, j) => Math.max(m, housesOf(s, j)), 0);
    return housesOf(s, i) >= max;
  });
}

/** 现金不够时自动半价卖房（先卖贵的） */
function autoSellHouses(ctx, p, need) {
  const s = ctx.s;
  while (p.cash < need) {
    const cands = sellableCells(s, p);
    if (!cands.length) break;
    cands.sort((a, b) =>
      (houseCostOf(s, b) - houseCostOf(s, a)) ||
      (housesOf(s, b) - housesOf(s, a)) ||
      (a - b));
    const idx = cands[0];
    const refund = Math.floor(houseCostOf(s, idx) / 2);
    s.cells[idx].houses -= 1;
    p.cash += refund;
    logAdd(ctx, 'sell_house', `${p.name} 被迫变卖 ${cellName(s, idx)} 的房子，回收 ${money(refund)}`);
  }
}

/**
 * 付钱。to 为 null 表示付给银行。
 * 现金不足 -> 自动卖房 -> 还不够就挂欠条（pendingDebt / debtQueue），返回 false。
 */
function payTo(ctx, from, to, amount) {
  const s = ctx.s;
  if (!(amount > 0)) return true;
  if (from.cash < amount) autoSellHouses(ctx, from, amount);
  if (from.cash >= amount) {
    from.cash -= amount;
    if (to) to.cash += amount;
    return true;
  }
  const debt = { playerId: from.id, amount, creditor: to ? to.id : null };
  if (!s.pendingDebt) s.pendingDebt = debt;
  else s.debtQueue.push(debt);
  logAdd(ctx, 'debt', `${from.name} 掏不出 ${money(amount)}，只剩宣布破产一条路`);
  return false;
}

function gain(ctx, p, amount, text) {
  p.cash += amount;
  if (text) logAdd(ctx, 'money', text);
}

// ---------------------------------------------------------------- 移动 / 落地结算

function sendToJail(ctx, p) {
  const s = ctx.s;
  p.pos = jailIndex(s);
  p.inJail = true;
  p.jailTurns = 0;
  s.doublesCount = 0;
  s.extraRoll = false;
  logAdd(ctx, 'jail', `${p.name} 被送进监狱`);
}

function movePlayer(ctx, p, n, opts) {
  const s = ctx.s;
  const size = s.board.length;
  const collectGo = !opts || opts.collectGo !== false;
  const from = p.pos;
  let np = (from + n) % size;
  if (np < 0) np += size;
  p.pos = np;
  const passedGo = n > 0 && (from + n) >= size;
  logAdd(ctx, 'move', `${p.name} 走到 ${cellName(s, np)}`);
  if (passedGo && collectGo) {
    gain(ctx, p, s.config.salary, `${p.name} 路过起点，领工资 ${money(s.config.salary)}`);
  }
  resolveLanding(ctx, p);
}

function moveTo(ctx, p, target, collectGo) {
  const s = ctx.s;
  const size = s.board.length;
  let n = (target - p.pos) % size;
  if (n < 0) n += size;
  if (n === 0) {
    // 原地：直接重新结算该格
    logAdd(ctx, 'move', `${p.name} 停在 ${cellName(s, p.pos)}`);
    if (collectGo && s.board[p.pos].type === 'go') {
      gain(ctx, p, s.config.salary, `${p.name} 回到起点，领工资 ${money(s.config.salary)}`);
    }
    resolveLanding(ctx, p);
    return;
  }
  movePlayer(ctx, p, n, { collectGo: collectGo !== false });
}

function drawCard(ctx, deckName) {
  const s = ctx.s;
  const deck = s.decks[deckName];
  if (!deck.draw.length) {
    deck.draw = shuffle(s, deck.discard);
    deck.discard = [];
  }
  if (!deck.draw.length) {
    logAdd(ctx, 'card', `${DECK_LABEL[deckName] || deckName}牌堆空了，什么也没发生`);
    return;
  }
  const id = deck.draw.shift();
  const card = (s.cards[deckName] || []).find((c) => c.id === id);
  if (!card) {
    logAdd(ctx, 'card', `${DECK_LABEL[deckName] || deckName}牌 ${id} 找不到牌面，跳过`);
    return;
  }
  s.pendingCard = { deck: deckName, card };
  logAdd(ctx, 'card', `抽到${DECK_LABEL[deckName] || deckName}：${card.text}`);
}

function chargeRent(ctx, p, idx) {
  const s = ctx.s;
  const own = s.cells[idx];
  if (!own || own.owner === p.id) return;
  const owner = findPlayer(s, own.owner);
  if (!owner || owner.bankrupt) return;
  const amount = rentFor(s, idx);
  if (!(amount > 0)) return;
  logAdd(ctx, 'rent', `${p.name} 踩中 ${owner.name} 的 ${cellName(s, idx)}，付租金 ${money(amount)}`);
  payTo(ctx, p, owner, amount);
}

function resolveLanding(ctx, p) {
  const s = ctx.s;
  const idx = p.pos;
  const cell = cellAt(s, idx);
  if (!cell) return;
  switch (cell.type) {
    case 'prop':
    case 'rail':
    case 'util': {
      const own = s.cells[idx];
      if (!own) {
        s.phase = 'awaiting_buy';
      } else if (own.owner !== p.id) {
        chargeRent(ctx, p, idx);
      }
      break;
    }
    case 'tax': {
      const amount = cell.amount || 0;
      if (amount > 0) {
        logAdd(ctx, 'tax', `${p.name} 缴纳${cell.name} ${money(amount)}`);
        payTo(ctx, p, null, amount);
      }
      break;
    }
    case 'luxury_tax': {
      const amount = (s.config.luxury_tax !== undefined && s.config.luxury_tax !== null)
        ? s.config.luxury_tax : (cell.amount || 0);
      const flavors = Array.isArray(cell.flavor) && cell.flavor.length ? cell.flavor : null;
      const line = flavors ? flavors[rndInt(s, flavors.length)] : `${cell.name}到了，交钱`;
      logAdd(ctx, 'luxury_tax', `${p.name} 踩到${cell.name}：${line}（${money(amount)}）`);
      payTo(ctx, p, null, amount);
      break;
    }
    case 'chance':
      drawCard(ctx, 'chance');
      break;
    case 'community':
      drawCard(ctx, 'community');
      break;
    case 'goto_jail':
      sendToJail(ctx, p);
      break;
    case 'go':
    case 'jail':
    case 'parking':
    default:
      break;
  }
}

// ---------------------------------------------------------------- 卡牌 effect

function applyCardEffect(ctx, p, deckName, card) {
  const s = ctx.s;
  const eff = card.effect || {};
  switch (eff.type) {
    case 'money': {
      const amount = eff.amount || 0;
      if (amount >= 0) gain(ctx, p, amount, `${p.name} 进账 ${money(amount)}`);
      else {
        logAdd(ctx, 'money', `${p.name} 支出 ${money(-amount)}`);
        payTo(ctx, p, null, -amount);
      }
      break;
    }
    case 'move_to':
      moveTo(ctx, p, eff.cell, eff.collectGo !== false);
      break;
    case 'move_rel':
      if (eff.n) movePlayer(ctx, p, eff.n, { collectGo: eff.n > 0 });
      break;
    case 'goto_jail':
      sendToJail(ctx, p);
      break;
    case 'get_out_free':
      p.getOutFree += 1;
      p.jailCards.push({ deck: deckName, id: card.id });
      logAdd(ctx, 'card', `${p.name} 收好一张出狱卡`);
      break;
    case 'per_player': {
      const amount = eff.amount || 0;
      const others = activePlayers(s).filter((o) => o.id !== p.id);
      if (amount > 0) {
        for (const o of others) {
          logAdd(ctx, 'money', `${o.name} 付给 ${p.name} ${money(amount)}`);
          payTo(ctx, o, p, amount);
        }
      } else if (amount < 0) {
        for (const o of others) {
          logAdd(ctx, 'money', `${p.name} 付给 ${o.name} ${money(-amount)}`);
          // 付不出第一笔就已经破产了，剩下的不再往下追（否则会给同一人挂多张欠条）
          if (!payTo(ctx, p, o, -amount)) break;
        }
      }
      break;
    }
    case 'repairs': {
      const perHouse = eff.perHouse || 0;
      const perHotel = eff.perHotel || 0;
      let houses = 0, hotels = 0;
      for (const i of ownedCells(s, p.id)) {
        const h = housesOf(s, i);
        if (h >= s.config.maxHouses) hotels += 1;
        else houses += h;
      }
      const total = houses * perHouse + hotels * perHotel;
      logAdd(ctx, 'repairs', `${p.name} 修缮 ${houses} 栋房 / ${hotels} 座旅馆，共 ${money(total)}`);
      if (total > 0) payTo(ctx, p, null, total);
      break;
    }
    default:
      logAdd(ctx, 'card', '这张牌上什么也没写');
      break;
  }
}

// ---------------------------------------------------------------- 回合 / 破产

function settlePhase(ctx) {
  const s = ctx.s;
  if (s.phase === 'game_over') return;
  if (s.phase !== 'awaiting_buy') s.phase = 'awaiting_end';
}

function checkGameOver(ctx) {
  const s = ctx.s;
  const alive = activePlayers(s);
  if (alive.length <= 1) {
    s.winner = alive.length ? alive[0].id : null;
    s.phase = 'game_over';
    s.pendingCard = null;
    logAdd(ctx, 'game_over', alive.length ? `${alive[0].name} 赢下整局！` : '所有人都破产了，无人获胜');
    return true;
  }
  return false;
}

function advanceTurn(ctx) {
  const s = ctx.s;
  s.doublesCount = 0;
  s.extraRoll = false;
  const n = s.players.length;
  let i = s.players.findIndex((p) => p.id === s.currentPlayer);
  if (i < 0) i = 0;
  for (let k = 1; k <= n; k++) {
    const cand = s.players[(i + k) % n];
    if (!cand.bankrupt) {
      s.currentPlayer = cand.id;
      break;
    }
  }
  s.phase = 'awaiting_roll';
  s.dice = null;
  logAdd(ctx, 'turn', `轮到 ${findPlayer(s, s.currentPlayer).name} 行动`);
}

function liquidate(ctx, p, creditorId) {
  const s = ctx.s;
  let creditor = creditorId ? findPlayer(s, creditorId) : null;
  if (creditor && creditor.bankrupt) creditor = null;   // 债主也出局了就归公
  // 房子一律半价退给银行，钱先进破产者口袋
  for (const i of ownedCells(s, p.id)) {
    const h = housesOf(s, i);
    if (h > 0) {
      const refund = Math.floor(houseCostOf(s, i) / 2) * h;
      s.cells[i].houses = 0;
      p.cash += refund;
      logAdd(ctx, 'sell_house', `清算：${cellName(s, i)} 的 ${h} 栋房子折现 ${money(refund)}`);
    }
  }
  const props = ownedCells(s, p.id);
  for (const i of props) {
    if (creditor) s.cells[i].owner = creditor.id;
    else delete s.cells[i];
  }
  if (props.length) {
    logAdd(ctx, 'bankrupt', creditor
      ? `${p.name} 的 ${props.length} 处地产转给 ${creditor.name}`
      : `${p.name} 的 ${props.length} 处地产收归银行`);
  }
  if (creditor && p.cash > 0) {
    creditor.cash += p.cash;
    logAdd(ctx, 'bankrupt', `${p.name} 的现金 ${money(p.cash)} 归 ${creditor.name}`);
  }
  // 出狱卡还回牌堆
  for (const jc of p.jailCards) {
    if (s.decks[jc.deck]) s.decks[jc.deck].discard.push(jc.id);
  }
  p.jailCards = [];
  p.getOutFree = 0;
  p.cash = 0;
  p.inJail = false;
  p.jailTurns = 0;
  p.bankrupt = true;
  logAdd(ctx, 'bankrupt', `${p.name} 宣布破产，退出牌局`);
}

// ---------------------------------------------------------------- 动作

function actRoll(ctx, p) {
  const s = ctx.s;
  if (s.phase !== 'awaiting_roll') throw new Error('现在不是掷骰子的时候');
  const d1 = 1 + rndInt(s, 6);
  const d2 = 1 + rndInt(s, 6);
  s.dice = [d1, d2];
  const sum = d1 + d2;
  const isDouble = d1 === d2;
  logAdd(ctx, 'roll', `${p.name} 掷出 ${d1} + ${d2} = ${sum}${isDouble ? '（双数）' : ''}`);

  if (p.inJail) {
    s.extraRoll = false;
    if (isDouble) {
      p.inJail = false;
      p.jailTurns = 0;
      logAdd(ctx, 'jail', `${p.name} 掷出双数，出狱！`);
      movePlayer(ctx, p, sum, { collectGo: true });
    } else {
      p.jailTurns += 1;
      if (p.jailTurns >= s.config.jailMaxTurns) {
        logAdd(ctx, 'jail', `${p.name} 蹲满 ${s.config.jailMaxTurns} 回合，强制缴纳保释金 ${money(s.config.bail)}`);
        const ok = payTo(ctx, p, null, s.config.bail);
        p.inJail = false;
        p.jailTurns = 0;
        if (ok) movePlayer(ctx, p, sum, { collectGo: true });
      } else {
        logAdd(ctx, 'jail', `${p.name} 没掷出双数，继续蹲（第 ${p.jailTurns} 回合）`);
      }
    }
    settlePhase(ctx);
    return;
  }

  if (isDouble) {
    s.doublesCount += 1;
    if (s.doublesCount >= 3) {
      logAdd(ctx, 'jail', `${p.name} 连掷三次双数，直接进监狱`);
      sendToJail(ctx, p);
      settlePhase(ctx);
      return;
    }
    s.extraRoll = true;
  } else {
    s.doublesCount = 0;
    s.extraRoll = false;
  }
  movePlayer(ctx, p, sum, { collectGo: true });
  settlePhase(ctx);
}

function actBuy(ctx, p) {
  const s = ctx.s;
  if (s.phase !== 'awaiting_buy') throw new Error('现在没有可买的地');
  const idx = p.pos;
  const cell = cellAt(s, idx);
  if (s.cells[idx]) throw new Error('这块地已经有主了');
  const price = cell.price || 0;
  if (p.cash < price) throw new Error(`现金不足，买不起${cell.name}（需要 ${money(price)}）`);
  p.cash -= price;
  s.cells[idx] = { owner: p.id, houses: 0 };
  logAdd(ctx, 'buy', `${p.name} 买下 ${cell.name}，花费 ${money(price)}`);
  s.phase = 'awaiting_end';
}

function actDecline(ctx, p) {
  const s = ctx.s;
  if (s.phase !== 'awaiting_buy') throw new Error('现在没有要不要买的问题');
  logAdd(ctx, 'decline', `${p.name} 放弃购买 ${cellName(s, p.pos)}`);
  s.phase = 'awaiting_end';
}

function actBuild(ctx, p, action) {
  const s = ctx.s;
  if (s.phase !== 'awaiting_roll' && s.phase !== 'awaiting_end') throw new Error('现在不能盖房');
  const idx = Number(action.cellIdx);
  const cell = cellAt(s, idx);
  if (!cell || cell.type !== 'prop') throw new Error('这一格不能盖房');
  const own = s.cells[idx];
  if (!own || own.owner !== p.id) throw new Error('这块地不是你的');
  if (p.inJail) throw new Error('在监狱里没法盖房');
  if (!groupFullyOwned(s, cell.group, p.id)) throw new Error('必须集齐同色地才能盖房');
  if (own.houses >= s.config.maxHouses) throw new Error('这里已经是旅馆了，盖不动了');
  const peers = groupCells(s, cell.group);
  const min = peers.reduce((m, j) => Math.min(m, housesOf(s, j)), Infinity);
  if (own.houses + 1 - min > 1) throw new Error('必须均衡建房：同组各地房屋数相差不能超过 1');
  const cost = houseCostOf(s, idx);
  if (p.cash < cost) throw new Error(`现金不足，盖不起房（需要 ${money(cost)}）`);
  p.cash -= cost;
  own.houses += 1;
  const isHotel = own.houses >= s.config.maxHouses;
  logAdd(ctx, 'build', `${p.name} 在 ${cell.name} ${isHotel ? '盖起旅馆' : `盖了第 ${own.houses} 栋房`}，花费 ${money(cost)}`);
}

function actSellHouse(ctx, p, action) {
  const s = ctx.s;
  if (s.phase !== 'awaiting_roll' && s.phase !== 'awaiting_end') throw new Error('现在不能卖房');
  const idx = Number(action.cellIdx);
  const cell = cellAt(s, idx);
  if (!cell || cell.type !== 'prop') throw new Error('这一格没有房子');
  const own = s.cells[idx];
  if (!own || own.owner !== p.id) throw new Error('这块地不是你的');
  if (own.houses <= 0) throw new Error('这块地上没有房子');
  const peers = groupCells(s, cell.group);
  const max = peers.reduce((m, j) => Math.max(m, housesOf(s, j)), 0);
  if (own.houses - 1 < max - 1) throw new Error('必须均衡拆房：同组各地房屋数相差不能超过 1');
  const refund = Math.floor(houseCostOf(s, idx) / 2);
  own.houses -= 1;
  p.cash += refund;
  logAdd(ctx, 'sell_house', `${p.name} 卖掉 ${cell.name} 的一栋房，回收 ${money(refund)}`);
}

function actEndTurn(ctx, p) {
  const s = ctx.s;
  if (s.phase !== 'awaiting_end') throw new Error('现在还不能结束回合');
  if (s.extraRoll) {
    s.extraRoll = false;
    s.phase = 'awaiting_roll';
    logAdd(ctx, 'turn', `${p.name} 掷出双数，再来一次`);
    return;
  }
  advanceTurn(ctx);
}

function actPayBail(ctx, p) {
  const s = ctx.s;
  if (!p.inJail) throw new Error('你又不在监狱里');
  if (s.phase !== 'awaiting_roll') throw new Error('现在不能交保释金');
  const bail = s.config.bail;
  if (p.cash < bail) autoSellHouses(ctx, p, bail);
  if (p.cash < bail) throw new Error(`现金不足，交不起保释金（需要 ${money(bail)}）`);
  p.cash -= bail;
  p.inJail = false;
  p.jailTurns = 0;
  logAdd(ctx, 'jail', `${p.name} 交了 ${money(bail)} 保释金，走出监狱`);
}

function actUseJailCard(ctx, p) {
  const s = ctx.s;
  if (!p.inJail) throw new Error('你又不在监狱里');
  if (s.phase !== 'awaiting_roll') throw new Error('现在不能用出狱卡');
  if (p.getOutFree <= 0) throw new Error('你没有出狱卡');
  p.getOutFree -= 1;
  const jc = p.jailCards.shift();
  if (jc && s.decks[jc.deck]) s.decks[jc.deck].discard.push(jc.id);
  p.inJail = false;
  p.jailTurns = 0;
  logAdd(ctx, 'jail', `${p.name} 亮出出狱卡，大摇大摆走出监狱`);
}

function actCardAck(ctx, p) {
  const s = ctx.s;
  if (!s.pendingCard) throw new Error('现在没有待确认的卡牌');
  const { deck, card } = s.pendingCard;
  s.pendingCard = null;
  applyCardEffect(ctx, p, deck, card);
  if (!card.effect || card.effect.type !== 'get_out_free') {
    s.decks[deck].discard.push(card.id);
  }
  settlePhase(ctx);
}

function actDeclareBankrupt(ctx, p) {
  const s = ctx.s;
  const debt = s.pendingDebt;
  if (!debt || debt.playerId !== p.id) throw new Error('你现在没到宣布破产的地步');
  const wasCurrent = s.currentPlayer === p.id;
  liquidate(ctx, p, debt.creditor);
  // 人都出局了，他名下其余欠条一并作废
  s.debtQueue = s.debtQueue.filter((d) => d.playerId !== p.id);
  s.pendingDebt = s.debtQueue.length ? s.debtQueue.shift() : null;
  if (checkGameOver(ctx)) return;
  if (wasCurrent) {
    s.pendingCard = null;
    advanceTurn(ctx);
  } else {
    settlePhase(ctx);
  }
}

// ---------------------------------------------------------------- 对外 API

function createGame(opts) {
  const o = opts || {};
  const players = o.players;
  if (!Array.isArray(players) || players.length < 2 || players.length > 4) {
    throw new Error('玩家人数必须是 2~4 人');
  }
  const board = normalizeBoard(o.board);
  const cards = normalizeCards(o.cards);
  const config = Object.assign({}, DEFAULT_CONFIG, o.config || {});

  const ids = new Set();
  const ps = players.map((p, i) => {
    const id = p.id || `p${i + 1}`;
    if (ids.has(id)) throw new Error(`玩家 id 重复：${id}`);
    ids.add(id);
    return {
      id,
      name: p.name || `玩家${i + 1}`,
      color: p.color || ['#c084fc', '#67e8f9', '#fca5a5', '#fde68a'][i % 4],
      cash: config.startCash,
      pos: 0,
      inJail: false,
      jailTurns: 0,
      getOutFree: 0,
      jailCards: [],
      bankrupt: false
    };
  });

  const s = {
    seq: 0,
    createdAt: Date.now(),
    phase: 'awaiting_roll',
    currentPlayer: ps[0].id,
    dice: null,
    doublesCount: 0,
    extraRoll: false,
    players: ps,
    cells: {},
    decks: { chance: { draw: [], discard: [] }, community: { draw: [], discard: [] } },
    pendingCard: null,
    pendingDebt: null,
    debtQueue: [],
    log: [],
    winner: null,
    rngState: createRngState(o.seed),
    board,
    cards,
    config
  };
  s.decks.chance.draw = shuffle(s, cards.chance.map((c) => c.id));
  s.decks.community.draw = shuffle(s, cards.community.map((c) => c.id));

  const ctx = { s, events: [] };
  logAdd(ctx, 'start', `牌局开始：${ps.map((p) => p.name).join('、')}，每人 ${money(config.startCash)}`);
  logAdd(ctx, 'turn', `轮到 ${ps[0].name} 行动`);
  return s;
}

const HANDLERS = {
  roll: (ctx, p) => actRoll(ctx, p),
  buy: (ctx, p) => actBuy(ctx, p),
  decline: (ctx, p) => actDecline(ctx, p),
  build: (ctx, p, a) => actBuild(ctx, p, a),
  sell_house: (ctx, p, a) => actSellHouse(ctx, p, a),
  end_turn: (ctx, p) => actEndTurn(ctx, p),
  pay_bail: (ctx, p) => actPayBail(ctx, p),
  use_jail_card: (ctx, p) => actUseJailCard(ctx, p),
  card_ack: (ctx, p) => actCardAck(ctx, p),
  declare_bankrupt: (ctx, p) => actDeclareBankrupt(ctx, p)
};

function apply(state, playerId, action) {
  if (!state) throw new Error('缺少牌局状态');
  const act = (typeof action === 'string') ? { type: action } : (action || {});
  const type = act.type;
  if (!type || !HANDLERS[type]) throw new Error(`未知动作：${type || '(空)'}`);
  if (state.phase === 'game_over') throw new Error('牌局已经结束了');

  const src = findPlayer(state, playerId);
  if (!src) throw new Error('查无此人');
  if (src.bankrupt) throw new Error('你已经破产出局了');

  if (state.pendingDebt) {
    if (type !== 'declare_bankrupt') throw new Error('欠款未结清，现在只能宣布破产');
    if (state.pendingDebt.playerId !== playerId) throw new Error('等欠债的人先宣布破产');
  } else if (state.pendingCard) {
    if (type !== 'card_ack') throw new Error('请先确认抽到的卡牌');
    if (state.currentPlayer !== playerId) throw new Error('还没轮到你行动');
  } else if (state.currentPlayer !== playerId) {
    throw new Error('还没轮到你行动');
  }

  const s = cloneState(state);
  s.seq += 1;
  const ctx = { s, events: [] };
  const p = findPlayer(s, playerId);
  HANDLERS[type](ctx, p, act);
  return { state: s, events: ctx.events };
}

/** 当前 playerId 可执行的动作类型（前端画按钮 / 测试驱动用） */
function legalActions(state, playerId) {
  const out = [];
  if (!state || state.phase === 'game_over') return out;
  const p = findPlayer(state, playerId);
  if (!p || p.bankrupt) return out;
  if (state.pendingDebt) {
    if (state.pendingDebt.playerId === playerId) out.push('declare_bankrupt');
    return out;
  }
  if (state.currentPlayer !== playerId) return out;
  if (state.pendingCard) return ['card_ack'];
  if (state.phase === 'awaiting_buy') {
    const price = (cellAt(state, p.pos) || {}).price || 0;
    if (p.cash >= price) out.push('buy');
    out.push('decline');
    return out;
  }
  if (state.phase === 'awaiting_roll') {
    if (p.inJail) {
      out.push('roll');
      if (p.cash >= state.config.bail) out.push('pay_bail');
      if (p.getOutFree > 0) out.push('use_jail_card');
    } else {
      out.push('roll');
    }
  }
  if (state.phase === 'awaiting_end') out.push('end_turn');
  if ((state.phase === 'awaiting_roll' || state.phase === 'awaiting_end') && !p.inJail) {
    if (buildableCells(state, playerId).length) out.push('build');
    if (sellableCells(state, p).length) out.push('sell_house');
  }
  return out;
}

/** 该玩家此刻合法可盖房的格子索引列表 */
function buildableCells(state, playerId) {
  const s = state;
  const p = findPlayer(s, playerId);
  if (!p || p.inJail) return [];
  return ownedCells(s, playerId).filter((i) => {
    const cell = cellAt(s, i);
    if (!cell || cell.type !== 'prop') return false;
    if (!groupFullyOwned(s, cell.group, playerId)) return false;
    const h = housesOf(s, i);
    if (h >= s.config.maxHouses) return false;
    const peers = groupCells(s, cell.group);
    const min = peers.reduce((m, j) => Math.min(m, housesOf(s, j)), Infinity);
    if (h + 1 - min > 1) return false;
    return p.cash >= houseCostOf(s, i);
  });
}

module.exports = {
  createGame,
  apply,
  legalActions,
  buildableCells,
  rentFor,
  // 辅助导出（测试/服务端用）
  createRngState,
  rngNext,
  shuffle,
  cloneState,
  normalizeBoard,
  normalizeCards,
  DEFAULT_CONFIG
};
