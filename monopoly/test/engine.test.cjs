'use strict';
/**
 * monopoly/engine.cjs 单测（见 docs/design-monopoly.md 第 6 章）
 * 跑：node --test monopoly/test/engine.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const engine = require('../engine.cjs');

const DEFAULT_BOARD = require(path.join(__dirname, '../defaults/board.json'));
const DEFAULT_CARDS = require(path.join(__dirname, '../defaults/cards.json'));

// ------------------------------------------------------------------ fixtures

/**
 * 14 格小棋盘，专门用来精准测规则：
 * 0 起点 / 1,2 g1(便宜) / 3 铁路 / 4 机会 / 5 监狱 / 6 公用 / 7 g2(贵) /
 * 8 税 100 / 9 g2 / 10 进监狱 / 11 命运 / 12 铁路 / 13 奢侈税
 */
function fixtureBoard() {
  const g1 = { type: 'prop', group: 'g1', price: 100, rents: [10, 50, 150, 450, 600, 750], houseCost: 50 };
  const g2 = { type: 'prop', group: 'g2', price: 200, rents: [20, 100, 300, 900, 1250, 1500], houseCost: 100 };
  return [
    { idx: 0, type: 'go', name: '起点' },
    Object.assign({ idx: 1, name: '甲街' }, g1),
    Object.assign({ idx: 2, name: '乙街' }, g1),
    { idx: 3, type: 'rail', name: '一号站', price: 200, rents: [250, 500, 1000, 2000] },
    { idx: 4, type: 'chance', name: '机会' },
    { idx: 5, type: 'jail', name: '监狱' },
    { idx: 6, type: 'util', name: '电厂', price: 150, multipliers: [40, 100] },
    Object.assign({ idx: 7, name: '丙路' }, g2),
    { idx: 8, type: 'tax', name: '所得税', amount: 100 },
    Object.assign({ idx: 9, name: '丁路' }, g2),
    { idx: 10, type: 'goto_jail', name: '进监狱' },
    { idx: 11, type: 'community', name: '命运' },
    { idx: 12, type: 'rail', name: '二号站', price: 200, rents: [250, 500, 1000, 2000] },
    { idx: 13, type: 'luxury_tax', name: '奢侈税', amount: 100, flavor: ['整活甲', '整活乙'] }
  ];
}

/** 全是空地的安静棋盘（0 起点 / 5 监狱），测掷骰流程用，落地不会有任何结算 */
function quietBoard(n) {
  const cells = [];
  for (let i = 0; i < (n || 14); i++) {
    if (i === 0) cells.push({ idx: 0, type: 'go', name: '起点' });
    else if (i === 5) cells.push({ idx: 5, type: 'jail', name: '监狱' });
    else cells.push({ idx: i, type: 'parking', name: `空地${i}` });
  }
  return cells;
}

const FIXTURE_CARDS = { chance: [], community: [] };

function newGame(opts) {
  const o = opts || {};
  return engine.createGame({
    players: o.players || [{ id: 'a', name: '甲', color: '#f00' }, { id: 'b', name: '乙', color: '#0f0' }],
    board: o.board || fixtureBoard(),
    cards: o.cards || FIXTURE_CARDS,
    // 小盘的奢侈税格 amount 是 100，config 跟着调小，方便对账
    config: Object.assign({ startCash: 10000, luxury_tax: 100 }, o.config || {}),
    seed: o.seed || 'test-seed'
  });
}

/** 复制一份 state 并按需改写（测试里直接摆盘用） */
function tweak(state, fn) {
  const s = engine.cloneState(state);
  fn(s);
  return s;
}

function P(s, id) {
  return s.players.find((p) => p.id === id);
}

/** 暴力找一个 rngState，让接下来两次掷骰正好是 d1/d2 */
const RIG_CACHE = new Map();
function rigDice(state, d1, d2) {
  const key = `${d1}-${d2}`;
  let rs = RIG_CACHE.get(key);
  if (!rs) {
    for (let i = 1; i < 200000 && !rs; i++) {
      const cand = engine.createRngState(`rig-${key}-${i}`);
      const [s1, v1] = engine.rngNext(cand);
      const [, v2] = engine.rngNext(s1);
      if (v1 % 6 === d1 - 1 && v2 % 6 === d2 - 1) rs = cand;
    }
    assert.ok(rs, `找不到掷出 ${d1}/${d2} 的种子`);
    RIG_CACHE.set(key, rs);
  }
  return tweak(state, (s) => { s.rngState = rs.slice(); });
}

function rollWith(state, playerId, d1, d2) {
  const rigged = rigDice(state, d1, d2);
  const out = engine.apply(rigged, playerId, { type: 'roll' });
  assert.deepStrictEqual(out.state.dice, [d1, d2], '骰子没按预期定死');
  return out;
}

function logText(s) {
  return s.log.map((e) => e.text).join('\n');
}

// ------------------------------------------------------------------ 基础

test('createGame：初始状态与不可变性', () => {
  const s = newGame();
  assert.strictEqual(s.phase, 'awaiting_roll');
  assert.strictEqual(s.currentPlayer, 'a');
  assert.strictEqual(s.players.length, 2);
  assert.strictEqual(P(s, 'a').cash, 10000);
  assert.strictEqual(P(s, 'a').pos, 0);
  assert.strictEqual(s.winner, null);
  assert.deepStrictEqual(s.cells, {});
  assert.ok(s.log.length >= 1);

  const before = JSON.stringify(s);
  const out = rollWith(s, 'a', 1, 2);
  assert.strictEqual(JSON.stringify(s), before, 'apply 不能改入参 state');
  assert.ok(out.state !== s);
  assert.ok(out.events.length > 0);
  assert.strictEqual(out.state.seq, s.seq + 1);
});

test('createGame：人数与重复 id 校验', () => {
  assert.throws(() => engine.createGame({ players: [{ id: 'a' }], board: fixtureBoard(), cards: FIXTURE_CARDS }), /2~4/);
  assert.throws(() => engine.createGame({
    players: [{ id: 'a' }, { id: 'a' }], board: fixtureBoard(), cards: FIXTURE_CARDS
  }), /重复/);
});

test('非法动作：轮次/阶段/未知动作都 throw 中文', () => {
  const s = newGame();
  assert.throws(() => engine.apply(s, 'b', { type: 'roll' }), /还没轮到你/);
  assert.throws(() => engine.apply(s, 'a', { type: 'end_turn' }), /还不能结束回合/);
  assert.throws(() => engine.apply(s, 'a', { type: 'buy' }), /没有可买的地/);
  assert.throws(() => engine.apply(s, 'a', { type: 'nonsense' }), /未知动作/);
  assert.throws(() => engine.apply(s, 'zzz', { type: 'roll' }), /查无此人/);

  const afterRoll = rollWith(s, 'a', 1, 2).state;   // 落 3 号铁路 -> awaiting_buy
  assert.strictEqual(afterRoll.phase, 'awaiting_buy');
  assert.throws(() => engine.apply(afterRoll, 'a', { type: 'roll' }), /不是掷骰子的时候/);
});

// ------------------------------------------------------------------ 工资

test('过路起点发工资，落在起点也发（且只发一次）', () => {
  const base = newGame({ config: { salary: 2000 } });
  // 甲在 11 号，掷 3+2=5 -> 绕过起点到 2 号
  const s1 = tweak(base, (s) => { P(s, 'a').pos = 11; });
  const r1 = rollWith(s1, 'a', 3, 2).state;
  assert.strictEqual(P(r1, 'a').pos, 2);
  assert.strictEqual(P(r1, 'a').cash, 12000);
  assert.match(logText(r1), /路过起点/);

  // 正好踩回起点：11 + 3 = 14 % 14 = 0
  const s2 = tweak(base, (s) => { P(s, 'a').pos = 11; });
  const r2 = rollWith(s2, 'a', 1, 2).state;
  assert.strictEqual(P(r2, 'a').pos, 0);
  assert.strictEqual(P(r2, 'a').cash, 12000);

  // 没绕圈不发钱
  const r3 = rollWith(base, 'a', 1, 2).state;
  assert.strictEqual(P(r3, 'a').cash, 10000);
});

// ------------------------------------------------------------------ 买地 / 租金

test('买地与放弃购买', () => {
  const s0 = rollWith(newGame(), 'a', 1, 2).state;   // 落 3 号铁路（200）
  const bought = engine.apply(s0, 'a', { type: 'buy' }).state;
  assert.deepStrictEqual(bought.cells[3], { owner: 'a', houses: 0 });
  assert.strictEqual(P(bought, 'a').cash, 9800);
  assert.strictEqual(bought.phase, 'awaiting_end');
  assert.throws(() => engine.apply(bought, 'a', { type: 'buy' }), /没有可买的地/);

  const declined = engine.apply(s0, 'a', { type: 'decline' }).state;
  assert.strictEqual(declined.cells[3], undefined);
  assert.strictEqual(declined.phase, 'awaiting_end');

  const poor = tweak(s0, (s) => { P(s, 'a').cash = 10; });
  assert.throws(() => engine.apply(poor, 'a', { type: 'buy' }), /现金不足/);
  assert.deepStrictEqual(engine.legalActions(poor, 'a'), ['decline']);
});

test('地产租金各档：裸地 / 全组×2 / 1-4 栋 / 旅馆', () => {
  const base = newGame();
  const only1 = tweak(base, (s) => { s.cells[1] = { owner: 'b', houses: 0 }; });
  assert.strictEqual(engine.rentFor(only1, 1), 10, '裸地 = base');

  const full = tweak(only1, (s) => { s.cells[2] = { owner: 'b', houses: 0 }; });
  assert.strictEqual(engine.rentFor(full, 1), 20, '集齐同色组未盖房 ×2');

  const rents = [10, 50, 150, 450, 600, 750];
  for (let h = 1; h <= 5; h++) {
    const withH = tweak(full, (s) => { s.cells[1].houses = h; });
    assert.strictEqual(engine.rentFor(withH, 1), rents[h], `${h} 栋房租金`);
  }
  // 只有一格盖房、组仍是全组：另一格仍算 ×2
  const mixed = tweak(full, (s) => { s.cells[1].houses = 3; });
  assert.strictEqual(engine.rentFor(mixed, 2), 20);
});

test('踩到别人地产真的付租金给房东', () => {
  const base = tweak(newGame(), (s) => {
    s.cells[1] = { owner: 'b', houses: 0 };
    s.cells[2] = { owner: 'b', houses: 3 };
  });
  const out = rollWith(base, 'a', 1, 1).state;   // 0 -> 2 号，乙的 3 栋房 = 450
  assert.strictEqual(P(out, 'a').cash, 10000 - 450);
  assert.strictEqual(P(out, 'b').cash, 10000 + 450);
  assert.match(logText(out), /付租金/);
  // 自己的地不用付
  const own = tweak(base, (s) => { s.cells[2].owner = 'a'; });
  const out2 = rollWith(own, 'a', 1, 1).state;
  assert.strictEqual(P(out2, 'a').cash, 10000);
  assert.strictEqual(out2.phase, 'awaiting_end');
});

test('铁路 4 档租金 / 公用事业按骰点倍数', () => {
  const base = newGame();
  const r1 = tweak(base, (s) => { s.cells[3] = { owner: 'b', houses: 0 }; });
  assert.strictEqual(engine.rentFor(r1, 3), 250);
  const r2 = tweak(r1, (s) => { s.cells[12] = { owner: 'b', houses: 0 }; });
  assert.strictEqual(engine.rentFor(r2, 3), 500);

  // 4 档表在更大的盘上验证（默认盘 4 个火车站）
  const big = engine.createGame({
    players: [{ id: 'a' }, { id: 'b' }], board: DEFAULT_BOARD, cards: DEFAULT_CARDS, seed: 'rail'
  });
  const rails = [5, 15, 25, 35];
  const expect = [250, 500, 1000, 2000];
  let acc = big;
  rails.forEach((idx, i) => {
    acc = tweak(acc, (s) => { s.cells[idx] = { owner: 'b', houses: 0 }; });
    assert.strictEqual(engine.rentFor(acc, rails[0]), expect[i], `${i + 1} 条铁路`);
  });

  // 公用：1 家 = 骰点 ×40，2 家 = ×100
  const u1 = tweak(base, (s) => { s.cells[6] = { owner: 'b', houses: 0 }; s.dice = [3, 4]; });
  assert.strictEqual(engine.rentFor(u1, 6), 7 * 40);
  const u2 = engine.createGame({
    players: [{ id: 'a' }, { id: 'b' }], board: DEFAULT_BOARD, cards: DEFAULT_CARDS, seed: 'util'
  });
  const u2b = tweak(u2, (s) => {
    s.cells[12] = { owner: 'b', houses: 0 };
    s.cells[28] = { owner: 'b', houses: 0 };
    s.dice = [5, 5];
  });
  assert.strictEqual(engine.rentFor(u2b, 12), 10 * 100);

  // 端到端：踩公用真的按骰点收钱
  const land = tweak(base, (s) => { s.cells[6] = { owner: 'b', houses: 0 }; P(s, 'a').pos = 2; });
  const out = rollWith(land, 'a', 2, 2).state;   // 2 -> 6，骰点 4
  assert.strictEqual(P(out, 'a').cash, 10000 - 4 * 40);
  assert.strictEqual(P(out, 'b').cash, 10000 + 4 * 40);
});

// ------------------------------------------------------------------ 税 / 奢侈税

test('普通税格扣钱给银行', () => {
  const s = tweak(newGame(), (s2) => { P(s2, 'a').pos = 6; });
  const out = rollWith(s, 'a', 1, 1).state;   // 6 -> 8 所得税 100
  assert.strictEqual(P(out, 'a').cash, 9900);
  assert.match(logText(out), /所得税/);
});

test('奢侈税：扣 config.luxury_tax 并随机抽一条 flavor', () => {
  const base = newGame({ config: { luxury_tax: 300 } });
  const s = tweak(base, (s2) => { P(s2, 'a').pos = 11; });
  const out = rollWith(s, 'a', 1, 1).state;   // 11 -> 13 奢侈税
  assert.strictEqual(P(out, 'a').pos, 13);
  assert.strictEqual(P(out, 'a').cash, 10000 - 300, '优先用 config.luxury_tax 而不是格子 amount');
  const line = logText(out);
  assert.match(line, /奢侈税/);
  assert.ok(/整活甲|整活乙/.test(line), 'flavor 文案没进日志');

  // 默认盘那格也得有 flavor
  const mt = DEFAULT_BOARD.cells.find((c) => c.type === 'luxury_tax');
  assert.ok(mt && Array.isArray(mt.flavor) && mt.flavor.length >= 4);
});

// ------------------------------------------------------------------ 监狱

test('监狱出路一：掷出双数出狱并按点数移动', () => {
  const s = tweak(newGame({ board: quietBoard() }), (st) => {
    const p = P(st, 'a'); p.inJail = true; p.pos = 5; p.jailTurns = 1;
  });
  const out = rollWith(s, 'a', 3, 3).state;
  assert.strictEqual(P(out, 'a').inJail, false);
  assert.strictEqual(P(out, 'a').jailTurns, 0);
  assert.strictEqual(P(out, 'a').pos, 11);
  assert.match(logText(out), /出狱/);
  // 出狱这次不送额外掷骰
  const ended = engine.apply(out, 'a', { type: 'end_turn' }).state;
  assert.strictEqual(ended.currentPlayer, 'b');
});

test('监狱出路二：交保释金', () => {
  const s = tweak(newGame({ board: quietBoard() }), (st) => {
    const p = P(st, 'a'); p.inJail = true; p.pos = 5;
  });
  assert.ok(engine.legalActions(s, 'a').includes('pay_bail'));
  const paid = engine.apply(s, 'a', { type: 'pay_bail' }).state;
  assert.strictEqual(P(paid, 'a').inJail, false);
  assert.strictEqual(P(paid, 'a').cash, 10000 - 500);
  assert.strictEqual(paid.phase, 'awaiting_roll');
  const moved = rollWith(paid, 'a', 1, 2).state;
  assert.strictEqual(P(moved, 'a').pos, 8);

  const broke = tweak(s, (st) => { P(st, 'a').cash = 10; });
  assert.throws(() => engine.apply(broke, 'a', { type: 'pay_bail' }), /交不起保释金/);
  const free = tweak(s, (st) => { P(st, 'a').inJail = false; });
  assert.throws(() => engine.apply(free, 'a', { type: 'pay_bail' }), /不在监狱/);
});

test('监狱出路三：出狱卡（用掉后回弃牌堆）', () => {
  const s = tweak(newGame({ board: quietBoard() }), (st) => {
    const p = P(st, 'a');
    p.inJail = true; p.pos = 5; p.getOutFree = 1; p.jailCards = [{ deck: 'chance', id: 'c07' }];
  });
  assert.ok(engine.legalActions(s, 'a').includes('use_jail_card'));
  const out = engine.apply(s, 'a', { type: 'use_jail_card' }).state;
  assert.strictEqual(P(out, 'a').inJail, false);
  assert.strictEqual(P(out, 'a').getOutFree, 0);
  assert.deepStrictEqual(P(out, 'a').jailCards, []);
  assert.deepStrictEqual(out.decks.chance.discard, ['c07']);
  assert.strictEqual(out.phase, 'awaiting_roll');

  const none = tweak(s, (st) => { P(st, 'a').getOutFree = 0; P(st, 'a').jailCards = []; });
  assert.throws(() => engine.apply(none, 'a', { type: 'use_jail_card' }), /没有出狱卡/);
});

test('蹲满 3 回合强制交保释金后照常走', () => {
  const board = quietBoard();
  let s = tweak(newGame({ board }), (st) => {
    const p = P(st, 'a'); p.inJail = true; p.pos = 5;
  });
  // 第 1 次没掷出双数：继续蹲
  s = rollWith(s, 'a', 1, 2).state;
  assert.strictEqual(P(s, 'a').inJail, true);
  assert.strictEqual(P(s, 'a').jailTurns, 1);
  assert.strictEqual(P(s, 'a').pos, 5);
  assert.strictEqual(P(s, 'a').cash, 10000);
  s = engine.apply(s, 'a', { type: 'end_turn' }).state;
  s = rollWith(s, 'b', 1, 2).state;
  s = engine.apply(s, 'b', { type: 'end_turn' }).state;
  // 第 2 次
  s = rollWith(s, 'a', 2, 3).state;
  assert.strictEqual(P(s, 'a').jailTurns, 2);
  assert.strictEqual(P(s, 'a').inJail, true);
  s = engine.apply(s, 'a', { type: 'end_turn' }).state;
  s = rollWith(s, 'b', 1, 2).state;
  s = engine.apply(s, 'b', { type: 'end_turn' }).state;
  // 第 3 次：强制交保 + 移动
  s = rollWith(s, 'a', 1, 4).state;
  assert.strictEqual(P(s, 'a').inJail, false);
  assert.strictEqual(P(s, 'a').jailTurns, 0);
  assert.strictEqual(P(s, 'a').cash, 10000 - 500);
  assert.strictEqual(P(s, 'a').pos, 10);
  assert.match(logText(s), /强制缴纳保释金/);
});

test('踩到「进监狱」格直接坐牢', () => {
  const s = tweak(newGame(), (st) => { P(st, 'a').pos = 8; });
  const out = rollWith(s, 'a', 1, 1).state;   // 8 -> 10 进监狱
  const p = P(out, 'a');
  assert.strictEqual(p.inJail, true);
  assert.strictEqual(p.pos, 5);
  assert.strictEqual(out.phase, 'awaiting_end');
});

// ------------------------------------------------------------------ 双数

test('掷出双数可以再掷一次', () => {
  const board = quietBoard();
  let s = newGame({ board });
  s = rollWith(s, 'a', 2, 2).state;
  assert.strictEqual(s.doublesCount, 1);
  assert.strictEqual(s.extraRoll, true);
  s = engine.apply(s, 'a', { type: 'end_turn' }).state;
  assert.strictEqual(s.currentPlayer, 'a', '双数后还是自己');
  assert.strictEqual(s.phase, 'awaiting_roll');
  // 非双数就交棒
  s = rollWith(s, 'a', 1, 2).state;
  assert.strictEqual(s.doublesCount, 0);
  s = engine.apply(s, 'a', { type: 'end_turn' }).state;
  assert.strictEqual(s.currentPlayer, 'b');
});

test('三连双直接进监狱（第三次不再移动）', () => {
  const board = quietBoard();
  let s = newGame({ board });
  s = rollWith(s, 'a', 1, 1).state;
  assert.strictEqual(P(s, 'a').pos, 2);
  s = engine.apply(s, 'a', { type: 'end_turn' }).state;
  s = rollWith(s, 'a', 2, 2).state;
  assert.strictEqual(s.doublesCount, 2);
  assert.strictEqual(P(s, 'a').pos, 6);
  s = engine.apply(s, 'a', { type: 'end_turn' }).state;
  s = rollWith(s, 'a', 3, 3).state;
  assert.strictEqual(P(s, 'a').inJail, true);
  assert.strictEqual(P(s, 'a').pos, 5, '第三次双数不移动，直接进监狱');
  assert.strictEqual(s.doublesCount, 0);
  assert.strictEqual(s.extraRoll, false);
  assert.match(logText(s), /连掷三次双数/);
  s = engine.apply(s, 'a', { type: 'end_turn' }).state;
  assert.strictEqual(s.currentPlayer, 'b');
});

// ------------------------------------------------------------------ 建房

test('均衡建房 + 非法盖房全家桶', () => {
  const base = tweak(newGame(), (s) => {
    s.cells[1] = { owner: 'a', houses: 0 };
    s.cells[7] = { owner: 'a', houses: 0 };   // g2 只买了一半
    s.phase = 'awaiting_end';
  });
  // 没集齐同色组
  assert.throws(() => engine.apply(base, 'a', { type: 'build', cellIdx: 1 }), /集齐同色/);
  assert.throws(() => engine.apply(base, 'a', { type: 'build', cellIdx: 7 }), /集齐同色/);
  // 不是自己的地 / 不是地产格
  const other = tweak(base, (s) => { s.cells[2] = { owner: 'b', houses: 0 }; });
  assert.throws(() => engine.apply(other, 'a', { type: 'build', cellIdx: 2 }), /不是你的/);
  assert.throws(() => engine.apply(base, 'a', { type: 'build', cellIdx: 3 }), /不能盖房/);
  assert.throws(() => engine.apply(base, 'a', { type: 'build', cellIdx: 0 }), /不能盖房/);

  let s = tweak(base, (st) => { st.cells[2] = { owner: 'a', houses: 0 }; });
  // 第一栋 OK
  s = engine.apply(s, 'a', { type: 'build', cellIdx: 1 }).state;
  assert.strictEqual(s.cells[1].houses, 1);
  assert.strictEqual(P(s, 'a').cash, 10000 - 50);
  // 同一格再盖会破坏均衡
  assert.throws(() => engine.apply(s, 'a', { type: 'build', cellIdx: 1 }), /均衡建房/);
  s = engine.apply(s, 'a', { type: 'build', cellIdx: 2 }).state;
  assert.strictEqual(s.cells[2].houses, 1);
  // 一路盖到旅馆
  for (let h = 2; h <= 5; h++) {
    s = engine.apply(s, 'a', { type: 'build', cellIdx: 1 }).state;
    s = engine.apply(s, 'a', { type: 'build', cellIdx: 2 }).state;
    assert.strictEqual(s.cells[1].houses, h);
  }
  assert.strictEqual(P(s, 'a').cash, 10000 - 50 * 10);
  assert.throws(() => engine.apply(s, 'a', { type: 'build', cellIdx: 1 }), /旅馆/);
  assert.match(logText(s), /盖起旅馆/);

  // 坐牢时不能盖房
  const jailed = tweak(base, (st) => { st.cells[2] = { owner: 'a', houses: 0 }; P(st, 'a').inJail = true; });
  assert.throws(() => engine.apply(jailed, 'a', { type: 'build', cellIdx: 1 }), /监狱/);
  // 钱不够
  const poor = tweak(base, (st) => { st.cells[2] = { owner: 'a', houses: 0 }; P(st, 'a').cash = 10; });
  assert.throws(() => engine.apply(poor, 'a', { type: 'build', cellIdx: 1 }), /现金不足/);
  // 轮不到你
  assert.throws(() => engine.apply(base, 'b', { type: 'build', cellIdx: 1 }), /还没轮到你/);
});

test('卖房半价回收，且必须均衡拆', () => {
  let s = tweak(newGame(), (st) => {
    st.cells[1] = { owner: 'a', houses: 2 };
    st.cells[2] = { owner: 'a', houses: 1 };
    st.phase = 'awaiting_end';
    P(st, 'a').cash = 0;
  });
  // 组内房子少的那格不能先拆
  assert.throws(() => engine.apply(s, 'a', { type: 'sell_house', cellIdx: 2 }), /均衡拆房/);
  s = engine.apply(s, 'a', { type: 'sell_house', cellIdx: 1 }).state;
  assert.strictEqual(s.cells[1].houses, 1);
  assert.strictEqual(P(s, 'a').cash, 25, '半价回收');
  s = engine.apply(s, 'a', { type: 'sell_house', cellIdx: 2 }).state;
  assert.strictEqual(P(s, 'a').cash, 50);
  s = engine.apply(s, 'a', { type: 'sell_house', cellIdx: 1 }).state;
  assert.strictEqual(s.cells[1].houses, 0);
  assert.throws(() => engine.apply(s, 'a', { type: 'sell_house', cellIdx: 1 }), /没有房子/);
});

// ------------------------------------------------------------------ 卡牌

function withCard(state, effect, deck) {
  return tweak(state, (s) => {
    s.phase = 'awaiting_end';
    s.pendingCard = { deck: deck || 'chance', card: { id: 'x1', text: '测试牌', effect } };
  });
}

test('抽到卡后必须先 card_ack 才能干别的', () => {
  const cards = {
    chance: [{ id: 'c1', text: '进账 500', effect: { type: 'money', amount: 500 } }],
    community: []
  };
  const base = newGame({ cards });
  const s = tweak(base, (st) => { P(st, 'a').pos = 2; });
  const drawn = rollWith(s, 'a', 1, 1).state;   // 2 -> 4 机会
  assert.ok(drawn.pendingCard);
  assert.strictEqual(drawn.pendingCard.card.id, 'c1');
  assert.deepStrictEqual(engine.legalActions(drawn, 'a'), ['card_ack']);
  assert.throws(() => engine.apply(drawn, 'a', { type: 'end_turn' }), /先确认抽到的卡牌/);
  const acked = engine.apply(drawn, 'a', { type: 'card_ack' }).state;
  assert.strictEqual(acked.pendingCard, null);
  assert.strictEqual(P(acked, 'a').cash, 10500);
  assert.deepStrictEqual(acked.decks.chance.discard, ['c1']);
  assert.throws(() => engine.apply(acked, 'a', { type: 'card_ack' }), /没有待确认的卡牌/);
});

test('牌堆抽空后自动把弃牌洗回来', () => {
  const cards = {
    chance: [
      { id: 'c1', text: 'A', effect: { type: 'money', amount: 100 } },
      { id: 'c2', text: 'B', effect: { type: 'money', amount: 200 } }
    ],
    community: []
  };
  let s = tweak(newGame({ cards }), (st) => {
    st.decks.chance.draw = [];
    st.decks.chance.discard = ['c1', 'c2'];
    P(st, 'a').pos = 2;
  });
  s = rollWith(s, 'a', 1, 1).state;
  assert.ok(s.pendingCard, '弃牌堆应被洗回抽牌堆');
  assert.strictEqual(s.decks.chance.draw.length, 1);
});

test('effect: money 收/付', () => {
  const base = newGame();
  const plus = engine.apply(withCard(base, { type: 'money', amount: 1500 }), 'a', { type: 'card_ack' }).state;
  assert.strictEqual(P(plus, 'a').cash, 11500);
  const minus = engine.apply(withCard(base, { type: 'money', amount: -1200 }), 'a', { type: 'card_ack' }).state;
  assert.strictEqual(P(minus, 'a').cash, 8800);
});

test('effect: move_to（含过起点发不发工资）与落地继续结算', () => {
  const base = tweak(newGame(), (s) => { P(s, 'a').pos = 11; });
  const go = engine.apply(withCard(base, { type: 'move_to', cell: 0, collectGo: true }), 'a', { type: 'card_ack' }).state;
  assert.strictEqual(P(go, 'a').pos, 0);
  assert.strictEqual(P(go, 'a').cash, 12000);

  const noPay = engine.apply(withCard(base, { type: 'move_to', cell: 5, collectGo: false }), 'a', { type: 'card_ack' }).state;
  assert.strictEqual(P(noPay, 'a').pos, 5);
  assert.strictEqual(P(noPay, 'a').cash, 10000, '探监不发工资');
  assert.strictEqual(P(noPay, 'a').inJail, false, 'move_to 监狱只是探监');

  // 走到无主地会进入 awaiting_buy
  const buyable = engine.apply(withCard(base, { type: 'move_to', cell: 7, collectGo: true }), 'a', { type: 'card_ack' }).state;
  assert.strictEqual(buyable.phase, 'awaiting_buy');
  assert.strictEqual(P(buyable, 'a').pos, 7);
  // 走到别人的地照付租金
  const rented = tweak(base, (s) => { s.cells[7] = { owner: 'b', houses: 0 }; });
  const paid = engine.apply(withCard(rented, { type: 'move_to', cell: 7, collectGo: true }), 'a', { type: 'card_ack' }).state;
  assert.strictEqual(P(paid, 'a').cash, 12000 - 20);
});

test('effect: move_rel 前进/后退（后退不发工资）', () => {
  const base = tweak(newGame(), (s) => { P(s, 'a').pos = 2; });
  const back = engine.apply(withCard(base, { type: 'move_rel', n: -3 }), 'a', { type: 'card_ack' }).state;
  assert.strictEqual(P(back, 'a').pos, 13);
  assert.strictEqual(P(back, 'a').cash, 10000 - 100, '退到奢侈税格，交税但不发工资');

  const fwd = engine.apply(withCard(base, { type: 'move_rel', n: 3 }), 'a', { type: 'card_ack' }).state;
  assert.strictEqual(P(fwd, 'a').pos, 5);
  assert.strictEqual(P(fwd, 'a').cash, 10000);
});

test('effect: goto_jail', () => {
  const s = engine.apply(withCard(newGame(), { type: 'goto_jail' }), 'a', { type: 'card_ack' }).state;
  assert.strictEqual(P(s, 'a').inJail, true);
  assert.strictEqual(P(s, 'a').pos, 5);
});

test('effect: get_out_free 持有期间不进弃牌堆', () => {
  const s = engine.apply(withCard(newGame(), { type: 'get_out_free' }, 'community'), 'a', { type: 'card_ack' }).state;
  assert.strictEqual(P(s, 'a').getOutFree, 1);
  assert.deepStrictEqual(P(s, 'a').jailCards, [{ deck: 'community', id: 'x1' }]);
  assert.deepStrictEqual(s.decks.community.discard, [], '出狱卡在手上时不回弃牌堆');
});

test('effect: per_player 收钱/付钱', () => {
  const three = newGame({
    players: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }, { id: 'c', name: '丙' }]
  });
  const collect = engine.apply(withCard(three, { type: 'per_player', amount: 500 }), 'a', { type: 'card_ack' }).state;
  assert.strictEqual(P(collect, 'a').cash, 11000);
  assert.strictEqual(P(collect, 'b').cash, 9500);
  assert.strictEqual(P(collect, 'c').cash, 9500);

  const payAll = engine.apply(withCard(three, { type: 'per_player', amount: -300 }), 'a', { type: 'card_ack' }).state;
  assert.strictEqual(P(payAll, 'a').cash, 9400);
  assert.strictEqual(P(payAll, 'b').cash, 10300);
});

test('effect: repairs 按房/旅馆收钱', () => {
  const base = tweak(newGame(), (s) => {
    s.cells[1] = { owner: 'a', houses: 3 };
    s.cells[2] = { owner: 'a', houses: 5 };   // 旅馆
    s.cells[7] = { owner: 'b', houses: 4 };   // 别人的不算
  });
  const s = engine.apply(withCard(base, { type: 'repairs', perHouse: 100, perHotel: 500 }), 'a', { type: 'card_ack' }).state;
  assert.strictEqual(P(s, 'a').cash, 10000 - (3 * 100 + 500));
  assert.strictEqual(P(s, 'b').cash, 10000);
});

// ------------------------------------------------------------------ 欠债 / 破产

test('现金不足自动半价卖房抵债，先卖贵的', () => {
  const base = tweak(newGame(), (s) => {
    s.cells[1] = { owner: 'a', houses: 1 };   // houseCost 50
    s.cells[2] = { owner: 'a', houses: 1 };
    s.cells[7] = { owner: 'a', houses: 1 };   // houseCost 100 -> 先卖这组
    s.cells[9] = { owner: 'a', houses: 1 };
    P(s, 'a').cash = 0;
    P(s, 'a').pos = 6;
  });
  const out = rollWith(base, 'a', 1, 1).state;   // 6 -> 8 所得税 100
  assert.strictEqual(out.pendingDebt, null, '卖房够还就不该欠债');
  assert.strictEqual(P(out, 'a').cash, 0, '卖 2 栋贵房 = 100，正好交税');
  assert.strictEqual(out.cells[7].houses, 0);
  assert.strictEqual(out.cells[9].houses, 0);
  assert.strictEqual(out.cells[1].houses, 1, '便宜的房子不该被动');
  assert.strictEqual(out.cells[2].houses, 1);
  assert.match(logText(out), /被迫变卖/);
});

test('自动卖房时保持组内均衡（只从房子最多的格拆）', () => {
  const base = tweak(newGame(), (s) => {
    s.cells[1] = { owner: 'a', houses: 3 };
    s.cells[2] = { owner: 'a', houses: 3 };
    P(s, 'a').cash = 0;
    P(s, 'a').pos = 6;
  });
  const out = rollWith(base, 'a', 1, 1).state;   // 交税 100 -> 需要卖 4 栋
  assert.strictEqual(P(out, 'a').cash, 0);
  const h = [out.cells[1].houses, out.cells[2].houses].sort();
  assert.deepStrictEqual(h, [1, 1]);
});

test('还不上钱 -> pendingDebt -> 只能宣布破产 -> 地产归债主 -> 剩一人判胜', () => {
  const base = tweak(newGame(), (s) => {
    s.cells[1] = { owner: 'a', houses: 0 };
    s.cells[2] = { owner: 'a', houses: 0 };
    s.cells[7] = { owner: 'b', houses: 5 };   // 旅馆租金 1500
    s.cells[9] = { owner: 'b', houses: 0 };
    P(s, 'a').cash = 100;
    P(s, 'a').pos = 5;
  });
  const debt = rollWith(base, 'a', 1, 1).state;   // 5 -> 7
  assert.ok(debt.pendingDebt, '应该欠下租金');
  assert.strictEqual(debt.pendingDebt.playerId, 'a');
  assert.strictEqual(debt.pendingDebt.creditor, 'b');
  assert.strictEqual(debt.pendingDebt.amount, 1500);
  assert.deepStrictEqual(engine.legalActions(debt, 'a'), ['declare_bankrupt']);
  assert.throws(() => engine.apply(debt, 'a', { type: 'end_turn' }), /只能宣布破产/);
  assert.throws(() => engine.apply(debt, 'b', { type: 'declare_bankrupt' }), /等欠债的人/);

  const over = engine.apply(debt, 'a', { type: 'declare_bankrupt' }).state;
  assert.strictEqual(P(over, 'a').bankrupt, true);
  assert.strictEqual(P(over, 'a').cash, 0);
  assert.strictEqual(over.cells[1].owner, 'b', '地产归债主');
  assert.strictEqual(over.cells[2].owner, 'b');
  assert.strictEqual(P(over, 'b').cash, 10000 + 100, '残余现金也归债主');
  assert.strictEqual(over.phase, 'game_over');
  assert.strictEqual(over.winner, 'b');
  assert.strictEqual(over.pendingDebt, null);
  assert.match(logText(over), /赢下整局/);
  assert.throws(() => engine.apply(over, 'b', { type: 'roll' }), /已经结束/);
});

test('欠银行破产：地产收归银行，牌局在三人局里继续', () => {
  const base = tweak(newGame({
    players: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }, { id: 'c', name: '丙' }],
    config: { startCash: 10000, luxury_tax: 50000 }
  }), (s) => {
    s.cells[1] = { owner: 'a', houses: 2 };
    s.cells[2] = { owner: 'a', houses: 2 };
    P(s, 'a').cash = 0;
    P(s, 'a').pos = 11;
  });
  const debt = rollWith(base, 'a', 1, 1).state;   // 11 -> 13 奢侈税 50000
  assert.ok(debt.pendingDebt);
  assert.strictEqual(debt.pendingDebt.creditor, null);
  assert.deepStrictEqual([debt.cells[1].houses, debt.cells[2].houses], [0, 0], '先把房全卖了自救');

  const after = engine.apply(debt, 'a', { type: 'declare_bankrupt' }).state;
  assert.strictEqual(P(after, 'a').bankrupt, true);
  assert.strictEqual(after.cells[1], undefined, '地产收归银行');
  assert.strictEqual(after.cells[2], undefined);
  assert.strictEqual(after.winner, null);
  assert.strictEqual(after.phase, 'awaiting_roll');
  assert.strictEqual(after.currentPlayer, 'b', '破产者出局后轮到下一位');
  assert.throws(() => engine.apply(after, 'a', { type: 'roll' }), /破产出局/);
});

test('破产清算：手上的房子折现后一并交给债主', () => {
  const base = tweak(newGame(), (s) => {
    s.cells[1] = { owner: 'a', houses: 2 };   // 2 * 25 = 50
    s.cells[2] = { owner: 'a', houses: 2 };
    s.cells[7] = { owner: 'b', houses: 5 };
    s.cells[9] = { owner: 'b', houses: 0 };
    P(s, 'a').cash = 0;
    P(s, 'a').pos = 5;
  });
  const debt = rollWith(base, 'a', 1, 1).state;   // 欠 1500，卖光房也不够
  assert.ok(debt.pendingDebt);
  const cashAfterSelling = P(debt, 'a').cash;
  assert.strictEqual(cashAfterSelling, 100, '4 栋房各回收 25');
  const over = engine.apply(debt, 'a', { type: 'declare_bankrupt' }).state;
  assert.strictEqual(P(over, 'b').cash, 10000 + 100);
  assert.strictEqual(over.cells[1].houses, 0);
  assert.strictEqual(over.cells[1].owner, 'b');
  assert.strictEqual(over.winner, 'b');
});

test('per_player 付不起：只挂一张欠条，破产后牌局继续', () => {
  const three = tweak(newGame({
    players: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }, { id: 'c', name: '丙' }]
  }), (s) => {
    s.cells[1] = { owner: 'a', houses: 0 };
    P(s, 'a').cash = 100;
  });
  const debt = engine.apply(withCard(three, { type: 'per_player', amount: -5000 }), 'a', { type: 'card_ack' }).state;
  assert.ok(debt.pendingDebt);
  assert.strictEqual(debt.pendingDebt.playerId, 'a');
  assert.strictEqual(debt.pendingDebt.creditor, 'b');
  assert.deepStrictEqual(debt.debtQueue, [], '同一个人不该被挂两张欠条');

  const after = engine.apply(debt, 'a', { type: 'declare_bankrupt' }).state;
  assert.strictEqual(P(after, 'a').bankrupt, true);
  assert.strictEqual(after.cells[1].owner, 'b');
  assert.strictEqual(after.pendingDebt, null);
  assert.strictEqual(after.phase, 'awaiting_roll');
  assert.strictEqual(after.currentPlayer, 'b');
  assert.strictEqual(after.winner, null);
});

test('per_player 收钱时两人都付不起：欠条排队逐个清算', () => {
  const three = tweak(newGame({
    players: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }, { id: 'c', name: '丙' }]
  }), (s) => {
    P(s, 'b').cash = 10;
    P(s, 'c').cash = 10;
  });
  const debt = engine.apply(withCard(three, { type: 'per_player', amount: 5000 }), 'a', { type: 'card_ack' }).state;
  assert.strictEqual(debt.pendingDebt.playerId, 'b');
  assert.strictEqual(debt.debtQueue.length, 1);
  assert.strictEqual(debt.debtQueue[0].playerId, 'c');
  assert.deepStrictEqual(engine.legalActions(debt, 'c'), [], '排队中的人还轮不到');

  const step1 = engine.apply(debt, 'b', { type: 'declare_bankrupt' }).state;
  assert.strictEqual(step1.pendingDebt.playerId, 'c');
  assert.strictEqual(step1.winner, null);
  const step2 = engine.apply(step1, 'c', { type: 'declare_bankrupt' }).state;
  assert.strictEqual(step2.phase, 'game_over');
  assert.strictEqual(step2.winner, 'a');
  assert.strictEqual(step2.pendingDebt, null);
});

// ------------------------------------------------------------------ 整局回放

/** 用 legalActions 驱动一整局（贪心：能买就买、能盖就盖） */
function playFullGame(seed) {
  let s = engine.createGame({
    players: [{ id: 'a', name: '甲', color: '#a' }, { id: 'b', name: '乙', color: '#b' }],
    board: DEFAULT_BOARD,
    cards: DEFAULT_CARDS,
    config: { startCash: 5000 },
    seed
  });
  let steps = 0;
  while (s.phase !== 'game_over') {
    if (++steps > 50000) throw new Error('整局没能在 50000 步内分出胜负');
    const actor = s.pendingDebt ? s.pendingDebt.playerId : s.currentPlayer;
    const acts = engine.legalActions(s, actor);
    let action = null;
    if (acts.includes('declare_bankrupt')) action = { type: 'declare_bankrupt' };
    else if (acts.includes('card_ack')) action = { type: 'card_ack' };
    else if (acts.includes('buy')) action = { type: 'buy' };
    else if (acts.includes('build')) action = { type: 'build', cellIdx: engine.buildableCells(s, actor)[0] };
    else if (acts.includes('decline')) action = { type: 'decline' };
    else if (acts.includes('roll')) action = { type: 'roll' };
    else if (acts.includes('end_turn')) action = { type: 'end_turn' };
    assert.ok(action, `没有可执行的动作：phase=${s.phase} acts=${acts.join(',')}`);
    s = engine.apply(s, actor, action).state;
  }
  return { state: s, steps };
}

test('固定 seed 两人整局：能分出胜负，且两次回放完全一致', () => {
  const r1 = playFullGame('bisca-2026');
  assert.strictEqual(r1.state.phase, 'game_over');
  assert.ok(r1.state.winner, '必须有赢家');
  const loser = r1.state.players.find((p) => p.id !== r1.state.winner);
  assert.strictEqual(loser.bankrupt, true);
  assert.ok(r1.state.log.length > 30); // 整局该留下一串像样的流水（这颗 seed 实际 45 条）
  assert.match(logText(r1.state), /赢下整局/);

  const r2 = playFullGame('bisca-2026');
  assert.strictEqual(r2.steps, r1.steps, '步数必须一致');
  assert.strictEqual(r2.state.seq, r1.state.seq, 'seq 必须一致');
  assert.strictEqual(r2.state.winner, r1.state.winner);
  const strip = (st) => JSON.stringify(Object.assign({}, st, { createdAt: 0, board: null, cards: null, config: null }));
  assert.strictEqual(strip(r2.state), strip(r1.state), '整局状态必须逐字节一致');

  // 换个 seed 应该走出不一样的局
  const r3 = playFullGame('another-seed');
  assert.strictEqual(r3.state.phase, 'game_over');
  assert.notStrictEqual(r3.state.seq, r1.state.seq);
});

// ------------------------------------------------------------------ 默认数据文件

test('默认棋盘/牌堆文件结构合法', () => {
  const cells = DEFAULT_BOARD.cells;
  assert.ok(typeof DEFAULT_BOARD._readme === 'string' && DEFAULT_BOARD._readme.length > 50);
  assert.strictEqual(cells.length, 40, '必须正好 40 格');
  cells.forEach((c, i) => assert.strictEqual(c.idx, i, `idx 必须连续，第 ${i} 格不对`));

  const byType = {};
  for (const c of cells) byType[c.type] = (byType[c.type] || 0) + 1;
  assert.strictEqual(byType.prop, 22);
  assert.strictEqual(byType.rail, 4);
  assert.strictEqual(byType.util, 2);
  assert.strictEqual(byType.chance, 3);
  assert.strictEqual(byType.community, 3);
  assert.strictEqual(byType.tax, 1);
  assert.strictEqual(byType.luxury_tax, 1);
  assert.strictEqual(byType.go, 1);
  assert.strictEqual(byType.jail, 1);
  assert.strictEqual(byType.goto_jail, 1);
  assert.strictEqual(byType.parking, 1);

  const groups = {};
  for (const c of cells) {
    if (c.type !== 'prop') continue;
    assert.ok(/^g[1-8]$/.test(c.group), `${c.name} 的组名不对`);
    assert.ok(c.price >= 600 && c.price <= 4000, `${c.name} 地价越界`);
    assert.strictEqual(c.rents.length, 6, `${c.name} 租金表应有 6 档`);
    assert.ok(c.houseCost > 0);
    groups[c.group] = (groups[c.group] || 0) + 1;
  }
  assert.strictEqual(Object.keys(groups).length, 8);
  for (const g of Object.keys(groups)) assert.ok(groups[g] >= 2 && groups[g] <= 3, `${g} 组格数不对`);

  const types = new Set();
  const ids = new Set();
  for (const deck of ['chance', 'community']) {
    const list = DEFAULT_CARDS[deck];
    assert.ok(list.length >= 10, `${deck} 至少 10 张`);
    let jailCards = 0;
    for (const c of list) {
      assert.ok(c.id && c.text && c.effect && c.effect.type, `${deck} 牌面不全`);
      assert.ok(!ids.has(c.id), `卡牌 id 重复：${c.id}`);
      ids.add(c.id);
      types.add(c.effect.type);
      if (c.effect.type === 'get_out_free') jailCards++;
      if (c.effect.type === 'move_to') {
        assert.ok(c.effect.cell >= 0 && c.effect.cell < 40, `${c.id} 的目标格越界`);
      }
    }
    assert.ok(jailCards >= 1, `${deck} 至少要有一张出狱卡`);
  }
  assert.deepStrictEqual(
    [...types].sort(),
    ['get_out_free', 'goto_jail', 'money', 'move_rel', 'move_to', 'per_player', 'repairs'],
    '七种 effect 必须全覆盖'
  );
});
