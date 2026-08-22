'use strict';
/**
 * daifugo/engine.cjs 单测（SPEC 第 5 章）
 * 跑：node --test daifugo/test/engine.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert');
const engine = require('../engine.cjs');

const {
  createGame, apply, legalMoves, viewFor,
  comboOf, comboCandidates, comboStrength, beats,
  sortCards, ALL_CARDS, createRngState, rngNext
} = engine;

// ------------------------------------------------------------------ fixtures

const NAMES = { a: 'A', b: 'B', c: 'C', d: 'D' };

/**
 * 造一个手牌摆好的对局：hands = {a:[...], b:[...]}。
 * 没进手牌的牌全塞 pile，保证「手牌 + pile === 54」这条守恒随时可查。
 */
function mk(hands, opts) {
  const o = opts || {};
  const ids = Object.keys(hands);
  const g = createGame({
    players: ids.map((id) => ({ id, name: NAMES[id] || id })),
    seed: o.seed || 'fixture',
    rules: o.rules || {}
  });
  const used = Object.create(null);
  for (const id of ids) {
    const p = g.players.find((x) => x.id === id);
    p.hand = sortCards(hands[id]);
    p.finished = null;
    p.passed = false;
    p.foul = null;
    for (const c of hands[id]) {
      assert.ok(!used[c], `fixture 重复发牌：${c}`);
      used[c] = true;
    }
  }
  g.pile = ALL_CARDS.filter((c) => !used[c]);
  g.phase = 'playing';
  g.round = o.round || 1;
  g.field = null;
  g.lastToPlay = null;
  g.suitLock = null;
  g.finishCount = 0;
  g.revolution = !!o.revolution;
  g.leader = o.leader || ids[0];
  g.current = o.current || g.leader;
  return g;
}

/** 直接摆一手场上的牌（不走 apply，省得铺垫） */
function setField(g, by, cards, as) {
  const combo = comboOf(cards, { revolution: g.revolution, as });
  assert.ok(combo, `setField 牌型不合法：${cards}`);
  g.field = { cards: combo.cards.slice(), by, combo, suits: combo.suits.slice() };
  g.lastToPlay = by;
  return g;
}

function play(g, who, cards, as) {
  const act = { type: 'play', cards };
  if (as) act.as = as;
  return apply(g, who, act).state;
}

function pass(g, who) {
  return apply(g, who, { type: 'pass' }).state;
}

function P(g, id) {
  return g.players.find((p) => p.id === id);
}

function totalCards(g) {
  return g.players.reduce((n, p) => n + p.hand.length, 0) + g.pile.length;
}

function playable(g, who) {
  return legalMoves(g, who).filter((m) => m.type === 'play').map((m) => m.cards.join('+'));
}

// ------------------------------------------------------------------ 牌型判定

test('牌型判定：单/对/三条/四条/阶梯', () => {
  assert.equal(comboOf(['S3']).type, 'set');
  assert.equal(comboOf(['S3']).size, 1);
  assert.equal(comboOf(['S3']).rank, 3);
  assert.equal(comboOf(['S7', 'H7']).size, 2);
  assert.equal(comboOf(['S7', 'H7', 'D7']).size, 3);
  const quad = comboOf(['S7', 'H7', 'D7', 'C7']);
  assert.equal(quad.type, 'set');
  assert.equal(quad.size, 4);

  const st = comboOf(['S4', 'S5', 'S6']);
  assert.equal(st.type, 'stair');
  assert.equal(st.size, 3);
  assert.equal(st.lo, 4);
  assert.equal(st.hi, 6);

  // 2=15 也能进阶梯（A-2 相邻），但不跨回 3
  assert.equal(comboOf(['S13', 'S14', 'S15']).type, 'stair');
  assert.equal(comboOf(['S14', 'S15', 'S3']), null);
});

test('牌型判定：不合法的组合一律 null', () => {
  assert.equal(comboOf([]), null);
  assert.equal(comboOf(['S7', 'H8']), null);            // 不同 rank 不同花色
  assert.equal(comboOf(['S4', 'S6']), null);            // 两张不成阶梯
  assert.equal(comboOf(['S4', 'S5', 'H6']), null);      // 阶梯混花色
  assert.equal(comboOf(['S4', 'S5', 'S7']), null);      // 不连号
  assert.equal(comboOf(['S4', 'S4']), null);            // 重复牌 id
  assert.equal(comboOf(['S2']), null);                  // 没有 rank 2 这张牌
  assert.equal(comboOf(['S16']), null);
  assert.equal(comboOf(['X3']), null);
});

test('牌型判定：一组牌可能有两种解释（同 rank 组优先）', () => {
  const cands = comboCandidates(['S5', 'X1', 'X2']);
  assert.equal(cands.length, 2);
  assert.equal(cands[0].type, 'set');
  assert.equal(cands[1].type, 'stair');
  assert.equal(comboOf(['S5', 'X1', 'X2']).type, 'set');
  assert.equal(comboOf(['S5', 'X1', 'X2'], { as: 'stair' }).type, 'stair');
});

// ------------------------------------------------------------------ 跟牌

test('跟牌：同型同张数、严格更大', () => {
  const g = mk({ a: ['S9', 'S5', 'H5', 'D5'], b: ['H9', 'D8', 'C9', 'H4'] });
  setField(g, 'a', ['S9']);
  g.current = 'b';
  // 单张：H9 平手不行，C9 也不行；D8 更小不行 —— 只剩 pass
  assert.deepEqual(playable(g, 'b'), []);
  assert.ok(legalMoves(g, 'b').some((m) => m.type === 'pass'));
  assert.throws(() => play(g, 'b', ['H9']), /压不过/);
  assert.throws(() => play(g, 'b', ['D8']), /压不过/);

  setField(g, 'a', ['S5', 'H5']);
  g.current = 'b';
  // 张数对不上
  assert.throws(() => play(g, 'b', ['H9']), /同型同张数/);
  const g2 = play(g, 'b', ['H9', 'C9']);
  assert.deepEqual(g2.field.cards, ['H9', 'C9']);

  const g3 = mk({ a: ['S5', 'H5', 'D5', 'S9'], b: ['H9', 'H10', 'H11', 'H4'] });
  setField(g3, 'a', ['S5', 'H5']);
  g3.current = 'b';
  assert.throws(() => play(g3, 'b', ['H9', 'H10', 'H11']), /同型同张数/);
});

test('跟牌：阶梯不能跟同 rank 组，反之亦然', () => {
  const g = mk({ a: ['S4', 'S5', 'S6'], b: ['H7', 'D7', 'C7', 'H9', 'H10', 'H11'] });
  setField(g, 'a', ['S4', 'S5', 'S6']);
  g.current = 'b';
  assert.throws(() => play(g, 'b', ['H7', 'D7', 'C7']), /同型同张数/);
  assert.throws(() => play(g, 'b', ['H4', 'H5', 'H6']), /你手里没有/);
  const g2 = play(g, 'b', ['H9', 'H10', 'H11']);
  assert.equal(g2.field.combo.type, 'stair');
  assert.equal(g2.field.combo.hi, 11);
});

test('beats() 供前端预判：空场随便出，同型比强度', () => {
  const st = { revolution: false, rules: engine.DEFAULT_RULES };
  assert.equal(beats(['S3'], null, st), true);
  assert.equal(beats(['S9'], ['S8'], st), true);
  assert.equal(beats(['S8'], ['S9'], st), false);
  assert.equal(beats(['S9'], ['H9'], st), false);         // 平手不算大
  assert.equal(beats(['S9', 'H9'], ['S8'], st), false);   // 张数不同
});

// ------------------------------------------------------------------ 王

test('王：恒 16 最强，做替身按所替 rank 比较', () => {
  assert.equal(comboOf(['X1']).rank, 16);
  assert.equal(comboStrength(comboOf(['X1']), false), 16);
  assert.equal(comboStrength(comboOf(['X1']), true), 16);   // 革命不翻王

  const pair = comboOf(['S5', 'X1']);
  assert.equal(pair.type, 'set');
  assert.equal(pair.rank, 5);                               // 王替身 = 5
  assert.equal(pair.jokers, 1);

  const st = { revolution: false, rules: engine.DEFAULT_RULES };
  assert.equal(beats(['S5', 'X1'], ['S4', 'H4'], st), true);
  assert.equal(beats(['S5', 'X1'], ['S15', 'H15'], st), false);  // 替身只值 5，压不过 2
  assert.equal(beats(['X1', 'X2'], ['S15', 'H15'], st), true);   // 纯王对 = 16
  assert.equal(beats(['X1'], ['S15'], st), true);                // 王单 = 最强单张
});

test('王单只能被另一张王打平（打平不算大）或スペ3', () => {
  const g = mk({ a: ['X1', 'S4'], b: ['S15', 'X2'] });
  setField(g, 'a', ['X1']);
  g.current = 'b';
  assert.throws(() => play(g, 'b', ['S15']), /压不过/);
  assert.throws(() => play(g, 'b', ['X2']), /压不过/);   // 16 vs 16 不是严格大
  assert.deepEqual(playable(g, 'b'), []);
});

// ------------------------------------------------------------------ スペ3

test('スペ3：♠3 反杀单张王，杀完按普通 ♠3 留场', () => {
  const g = mk({ a: ['X1', 'H4'], b: ['S3', 'H7'], c: ['D4', 'D5'] });
  setField(g, 'a', ['X1']);
  g.current = 'b';
  assert.deepEqual(playable(g, 'b'), ['S3']);
  const g2 = play(g, 'b', ['S3']);
  assert.deepEqual(g2.field.cards, ['S3']);
  assert.equal(g2.field.by, 'b');
  assert.equal(g2.current, 'c');
  // 留场的 ♠3 就是普通单张 3，谁都能跟
  assert.ok(playable(g2, 'c').indexOf('D4') >= 0);
});

test('スペ3：只对「单张王」生效，关掉开关就不认', () => {
  // 对子王 不吃 ♠3
  const g = mk({ a: ['X1', 'X2'], b: ['S3', 'H3'] });
  setField(g, 'a', ['X1', 'X2']);
  g.current = 'b';
  assert.throws(() => play(g, 'b', ['S3']), /同型同张数/);
  assert.throws(() => play(g, 'b', ['S3', 'H3']), /压不过/);

  // ♠3 不能压普通单张
  const g2 = mk({ a: ['S15', 'H4'], b: ['S3', 'H7'] });
  setField(g2, 'a', ['S15']);
  g2.current = 'b';
  assert.throws(() => play(g2, 'b', ['S3']), /压不过/);

  // 开关关掉
  const g3 = mk({ a: ['X1', 'H4'], b: ['S3', 'H7'] }, { rules: { spade3: false } });
  setField(g3, 'a', ['X1']);
  g3.current = 'b';
  assert.deepEqual(playable(g3, 'b'), []);
  assert.throws(() => play(g3, 'b', ['S3']), /压不过/);
});

// ------------------------------------------------------------------ 八切

test('八切：含 8 的出牌清场，出牌者继续领出', () => {
  const g = mk({ a: ['S8', 'S9'], b: ['H9', 'H10'], c: ['D9', 'D10'] });
  const g1 = play(g, 'a', ['S8']);
  assert.equal(g1.field, null);
  assert.equal(g1.leader, 'a');
  assert.equal(g1.current, 'a');
  assert.ok(g1.log.some((l) => l.type === 'eight_cut'));
});

test('八切：对子/阶梯里带 8 一样砍，革命中也砍', () => {
  const g = mk({ a: ['S8', 'H8', 'S9'], b: ['D7', 'C7', 'H9'] });
  setField(g, 'b', ['D7', 'C7']);
  g.current = 'a';
  const g1 = play(g, 'a', ['S8', 'H8']);
  assert.equal(g1.field, null);
  assert.equal(g1.current, 'a');

  const g2 = mk({ a: ['S7', 'S8', 'S9', 'H4'], b: ['H7', 'H8', 'H9', 'D4'] });
  const g3 = play(g2, 'a', ['S7', 'S8', 'S9']);
  assert.equal(g3.field, null);
  assert.equal(g3.current, 'a');

  const g4 = mk({ a: ['S8', 'S9'], b: ['H9', 'H10'] }, { revolution: true });
  const g5 = play(g4, 'a', ['S8']);
  assert.equal(g5.field, null);
  assert.equal(g5.leader, 'a');
});

test('八切：出完最后一张 8 时清场，领出权顺延给下一个没出完的人', () => {
  const g = mk({ a: ['S8'], b: ['H9', 'H10'], c: ['D9', 'D10'] });
  const g1 = play(g, 'a', ['S8']);
  assert.equal(P(g1, 'a').finished, 1);
  assert.equal(g1.field, null);
  assert.equal(g1.leader, 'b');
});

// ------------------------------------------------------------------ 革命

test('革命：四条触发，强弱反转，王不受影响', () => {
  const g = mk({
    a: ['S5', 'H5', 'D5', 'C5', 'S3'],
    b: ['S4', 'H4', 'D4', 'C4', 'S15']
  });
  const g1 = play(g, 'a', ['S5', 'H5', 'D5', 'C5']);
  assert.equal(g1.revolution, true);
  assert.ok(g1.log.some((l) => l.type === 'revolution'));
  // 革命序里 4 比 5 大
  assert.equal(comboStrength(comboOf(['S4', 'H4', 'D4', 'C4']), true), 14);
  assert.equal(comboStrength(g1.field.combo, true), 13);
  assert.deepEqual(playable(g1, 'b'), ['S4+H4+D4+C4']);
  // 革命返し
  const g2 = play(g1, 'b', ['S4', 'H4', 'D4', 'C4']);
  assert.equal(g2.revolution, false);
});

test('革命：反转后 3 最大 2 最小，王照样通吃', () => {
  const g = mk({ a: ['S9', 'H4'], b: ['S5', 'S10', 'S3', 'X1'] }, { revolution: true });
  setField(g, 'a', ['S9']);
  g.current = 'b';
  const opts = playable(g, 'b');
  assert.ok(opts.indexOf('S5') >= 0);      // 5 在革命序里比 9 强
  assert.ok(opts.indexOf('S3') >= 0);      // 3 最强
  assert.ok(opts.indexOf('X1') >= 0);      // 王恒 16
  assert.ok(opts.indexOf('S10') < 0);      // 10 更弱
  assert.throws(() => play(g, 'b', ['S10']), /压不过/);

  // 革命序里王仍压 ♠3
  const g2 = mk({ a: ['S3', 'H4'], b: ['X1', 'H7'] }, { revolution: true });
  setField(g2, 'a', ['S3']);
  g2.current = 'b';
  assert.ok(playable(g2, 'b').indexOf('X1') >= 0);
});

test('革命：轮结束重置', () => {
  const g = mk({ a: ['S5', 'H5', 'D5', 'C5'], b: ['S4'], c: ['H4'] });
  const g1 = play(g, 'a', ['S5', 'H5', 'D5', 'C5']);
  assert.equal(g1.revolution, true);
  assert.equal(P(g1, 'a').finished, 1);
  // a 出完，剩 b/c 两人 —— 还没封轮
  assert.equal(g1.phase, 'playing');
  let g2 = g1;
  while (g2.phase === 'playing') {
    g2 = apply(g2, g2.current, legalMoves(g2, g2.current)[0]).state;
  }
  assert.equal(g2.phase, 'round_over');
  assert.equal(g2.revolution, false);
});

test('革命：阶梯革命默认关，打开才认', () => {
  const hands = { a: ['S4', 'S5', 'S6', 'S7', 'S8', 'H13'], b: ['H4', 'H5', 'H6', 'H7', 'H8'] };
  const off = play(mk(hands), 'a', ['S4', 'S5', 'S6', 'S7', 'S8']);
  assert.equal(off.revolution, false);
  const on = play(mk(hands, { rules: { kaidan_revolution: true } }), 'a', ['S4', 'S5', 'S6', 'S7', 'S8']);
  assert.equal(on.revolution, true);
});

// ------------------------------------------------------------------ 阶梯

test('阶梯：王补位，比双方最强一张', () => {
  const withJoker = comboOf(['S4', 'S6', 'X1']);
  assert.equal(withJoker.type, 'stair');
  assert.equal(withJoker.lo, 4);
  assert.equal(withJoker.hi, 6);
  assert.equal(comboStrength(withJoker, false), 6);

  // 王补在哪端有歧义时取对出牌者最有利的排法
  assert.equal(comboOf(['S4', 'S5', 'X1'], { revolution: false }).hi, 6);
  assert.equal(comboOf(['S4', 'S5', 'X1'], { revolution: true }).lo, 3);

  const st = { revolution: false, rules: engine.DEFAULT_RULES };
  assert.equal(beats(['H5', 'H6', 'H7'], ['S4', 'S5', 'S6'], st), true);
  assert.equal(beats(['H4', 'H5', 'H6'], ['S4', 'S5', 'S6'], st), false);
  // 长度必须一致
  assert.equal(beats(['H4', 'H5', 'H6', 'H7'], ['S4', 'S5', 'S6'], st), false);
});

test('阶梯：带王的阶梯真能压场', () => {
  const g = mk({ a: ['S4', 'S5', 'S6', 'D3'], b: ['H9', 'H11', 'X1', 'C3'] });
  const g1 = play(g, 'a', ['S4', 'S5', 'S6']);
  assert.equal(g1.field.combo.type, 'stair');
  // H9 H11 + 王 = ♥9-10-J，最强 J > 6
  const g2 = play(g1, 'b', ['H9', 'H11', 'X1']);
  assert.equal(g2.field.combo.type, 'stair');
  assert.equal(g2.field.combo.lo, 9);
  assert.equal(g2.field.combo.hi, 11);
  assert.equal(g2.field.combo.jokers, 1);
});

// ------------------------------------------------------------------ pass / 清场 / 领出权

test('pass：过了锁到本墩清场，全过则最后出牌者领出', () => {
  let g = mk({ a: ['S9', 'S4'], b: ['H10', 'H3'], c: ['D10', 'D3'], d: ['C10', 'C3'] });
  g = play(g, 'a', ['S9']);
  assert.equal(g.current, 'b');
  g = pass(g, 'b');
  assert.equal(P(g, 'b').passed, true);
  assert.equal(g.current, 'c');
  // b 已经锁了，轮不到他，硬出报错
  assert.throws(() => play(g, 'b', ['H10']), /还没轮到你/);
  assert.deepEqual(legalMoves(g, 'b'), []);
  g = pass(g, 'c');
  assert.equal(g.current, 'd');
  g = pass(g, 'd');
  // 其余全过 → 清场，lastToPlay 领出
  assert.equal(g.field, null);
  assert.equal(g.leader, 'a');
  assert.equal(g.current, 'a');
  assert.equal(P(g, 'b').passed, false);
});

test('pass：领出者不能过', () => {
  const g = mk({ a: ['S9'], b: ['H10'] });
  assert.throws(() => pass(g, 'a'), /必须出牌/);
  assert.ok(!legalMoves(g, 'a').some((m) => m.type === 'pass'));
});

test('领出权继承：lastToPlay 已出完就顺位下一个未完者领出', () => {
  let g = mk({ a: ['S9'], b: ['H3', 'H4'], c: ['D3', 'D4'] });
  g = play(g, 'a', ['S9']);
  assert.equal(P(g, 'a').finished, 1);
  assert.equal(g.current, 'b');
  g = pass(g, 'b');
  g = pass(g, 'c');
  assert.equal(g.field, null);
  assert.equal(g.lastToPlay, 'a');
  assert.equal(g.leader, 'b');       // a 出完了，顺延给 b
  assert.equal(g.current, 'b');
});

test('清场后 pass 状态与 縛り 锁一起复位', () => {
  let g = mk({ a: ['S9', 'S5'], b: ['H9', 'H3'] }, { rules: { shibari: true } });
  g = play(g, 'a', ['S5']);
  g = pass(g, 'b');
  assert.equal(g.field, null);
  assert.equal(g.suitLock, null);
  assert.equal(P(g, 'b').passed, false);
});

// ------------------------------------------------------------------ 縛り

test('縛り：连续两手花色组一致 → 本墩锁花色', () => {
  let g = mk({ a: ['S5', 'S9', 'H9'], b: ['S7', 'H8'] }, { rules: { shibari: true } });
  g = play(g, 'a', ['S5']);
  assert.equal(g.suitLock, null);
  g = play(g, 'b', ['S7']);
  assert.deepEqual(g.suitLock, ['S']);
  assert.equal(g.current, 'a');
  // 锁 ♠ 之后 ♥9 不能出，♠9 可以
  assert.deepEqual(playable(g, 'a'), ['S9']);
  assert.throws(() => play(g, 'a', ['H9']), /縛り/);
  const g2 = play(g, 'a', ['S9']);
  assert.deepEqual(g2.field.cards, ['S9']);
});

test('縛り：默认关的时候花色随便出', () => {
  let g = mk({ a: ['S5', 'H9', 'S13'], b: ['S7', 'H10'] });
  g = play(g, 'a', ['S5']);
  g = play(g, 'b', ['S7']);
  assert.equal(g.suitLock, null);
  const g2 = play(g, 'a', ['H9']);
  assert.deepEqual(g2.field.cards, ['H9']);
});

// ------------------------------------------------------------------ 禁止上がり

test('禁止上がり：拿 2 收尾判垫底', () => {
  let g = mk({ a: ['S15'], b: ['H4', 'H5'], c: ['D4', 'D5'] });
  g = play(g, 'a', ['S15']);
  assert.equal(P(g, 'a').foul, 'forbid_finish');
  // 打完整轮看名次：a 虽然第一个出完，还是垫底
  g = pass(g, 'b'); g = pass(g, 'c');
  g = play(g, g.current, [P(g, g.current).hand[0]]);
  while (g.phase === 'playing') {
    const mv = legalMoves(g, g.current);
    g = apply(g, g.current, mv[0]).state;
  }
  assert.equal(g.phase, 'round_over');
  assert.equal(P(g, 'a').rank, 'daihinmin');
  assert.equal(P(g, 'a').score, 0);
});

test('禁止上がり：王/8/スペ3 收尾同样犯规，革命中改判 3', () => {
  // 王
  let g = play(mk({ a: ['X1'], b: ['H4', 'H5'] }), 'a', ['X1']);
  assert.equal(P(g, 'a').foul, 'forbid_finish');
  assert.equal(P(g, 'a').rank, 'daihinmin');

  // 8
  g = play(mk({ a: ['S8'], b: ['H4', 'H5'] }), 'a', ['S8']);
  assert.equal(P(g, 'a').foul, 'forbid_finish');

  // 革命中 2 不再是禁牌，3 才是
  const rev = mk({ a: ['S15'], b: ['H4', 'H5'] }, { revolution: true });
  g = play(rev, 'a', ['S15']);
  assert.equal(P(g, 'a').foul, null);
  assert.equal(P(g, 'a').rank, 'daifugo');
  const rev3 = mk({ a: ['S3'], b: ['H4', 'H5'] }, { revolution: true });
  g = play(rev3, 'a', ['S3']);
  assert.equal(P(g, 'a').foul, 'forbid_finish');

  // スペ3 反杀收尾
  let g2 = mk({ a: ['X1', 'H6'], b: ['S3'] });
  setField(g2, 'a', ['X1']);
  g2.current = 'b';
  g2 = play(g2, 'b', ['S3']);
  assert.equal(P(g2, 'b').foul, 'forbid_finish');
  assert.equal(P(g2, 'b').rank, 'daihinmin');
});

test('禁止上がり：非最后一手带 2 不犯规；开关关掉则谁都不犯规', () => {
  let g = mk({ a: ['S15', 'S4'], b: ['H4', 'H5'] });
  g = play(g, 'a', ['S15']);
  assert.equal(P(g, 'a').foul, null);
  assert.equal(P(g, 'a').finished, null);

  const off = play(mk({ a: ['S15'], b: ['H4', 'H5'] }, { rules: { forbid_finish: false } }), 'a', ['S15']);
  assert.equal(P(off, 'a').foul, null);
  assert.equal(P(off, 'a').rank, 'daifugo');
});

// ------------------------------------------------------------------ 名次表 / 计分

test('名次表：4 人 大富豪/富豪/贫民/大贫民，分 3/2/1/0', () => {
  let g = mk({ a: ['S4'], b: ['S5'], c: ['S6'], d: ['S7'] });
  g = play(g, 'a', ['S4']);
  g = play(g, 'b', ['S5']);
  g = play(g, 'c', ['S6']);
  assert.equal(g.phase, 'round_over');       // 倒数第二人出完即封轮
  assert.equal(P(g, 'd').hand.length, 1);
  assert.deepEqual(g.players.map((p) => p.rank), ['daifugo', 'fugo', 'hinmin', 'daihinmin']);
  assert.deepEqual(g.players.map((p) => p.score), [3, 2, 1, 0]);
  assert.deepEqual(g.lastResults.map((r) => r.playerId), ['a', 'b', 'c', 'd']);
});

test('名次表：3 人 大富豪/平民/大贫民 分 2/1/0；2 人 大富豪/大贫民 分 1/0', () => {
  let g3 = mk({ a: ['S4'], b: ['S5'], c: ['S6'] });
  g3 = play(g3, 'a', ['S4']);
  g3 = play(g3, 'b', ['S5']);
  assert.equal(g3.phase, 'round_over');
  assert.deepEqual(g3.players.map((p) => p.rank), ['daifugo', 'heimin', 'daihinmin']);
  assert.deepEqual(g3.players.map((p) => p.score), [2, 1, 0]);

  let g2 = mk({ a: ['S4'], b: ['S5'] });
  g2 = play(g2, 'a', ['S4']);
  assert.equal(g2.phase, 'round_over');
  assert.deepEqual(g2.players.map((p) => p.rank), ['daifugo', 'daihinmin']);
  assert.deepEqual(g2.players.map((p) => p.score), [1, 0]);
});

test('计分累计：多轮相加，end_match 出总榜', () => {
  let g = mk({ a: ['S4'], b: ['S5'], c: ['S6'], d: ['S7'] });
  g = play(g, 'a', ['S4']);
  g = play(g, 'b', ['S5']);
  g = play(g, 'c', ['S6']);
  const after1 = g.players.map((p) => p.score);
  assert.deepEqual(after1, [3, 2, 1, 0]);

  // 开下一轮 → 换牌 → 再打一轮迷你局
  g = apply(g, 'a', { type: 'next_round' }).state;
  assert.equal(g.round, 2);
  assert.equal(g.phase, 'exchange');
  while (g.phase === 'exchange') {
    const item = g.exchange.pending.find((it) => it.given === null);
    g = apply(g, item.from, legalMoves(g, item.from)[0]).state;
  }
  // 重新摆牌打第二轮（保持 pile 守恒）
  const hands = { d: ['S4'], a: ['S5'], b: ['S6'], c: ['S7'] };
  const used = Object.create(null);
  for (const id of Object.keys(hands)) {
    P(g, id).hand = sortCards(hands[id]);
    hands[id].forEach((c) => { used[c] = true; });
  }
  g.pile = ALL_CARDS.filter((c) => !used[c]);
  g.leader = 'd'; g.current = 'd'; g.field = null; g.lastToPlay = null;
  assert.equal(totalCards(g), 54);
  g = play(g, 'd', ['S4']);
  g = play(g, 'a', ['S5']);
  g = play(g, 'b', ['S6']);
  assert.equal(g.phase, 'round_over');
  assert.deepEqual(g.players.map((p) => p.score), [3 + 2, 2 + 1, 1 + 0, 0 + 3]);
  assert.equal(g.rounds.length, 2);

  const done = apply(g, 'a', { type: 'end_match' }).state;
  assert.equal(done.phase, 'game_over');
  assert.equal(done.winner, 'a');           // a 5 分
  assert.throws(() => apply(done, 'a', { type: 'next_round' }), /整场已经结束/);
});

// ------------------------------------------------------------------ 换牌

test('换牌：第 2 轮起贫方自动上缴最强牌，富方回赠前不能开打', () => {
  let g = mk({ a: ['S4'], b: ['S5'], c: ['S6'], d: ['S7'] });
  g = play(g, 'a', ['S4']);
  g = play(g, 'b', ['S5']);
  g = play(g, 'c', ['S6']);
  g = apply(g, 'a', { type: 'next_round' }).state;

  assert.equal(g.phase, 'exchange');
  assert.equal(g.exchange.pending.length, 2);
  const big = g.exchange.pending.find((it) => it.count === 2);
  const small = g.exchange.pending.find((it) => it.count === 1);
  assert.equal(big.from, 'a');    // 大富豪
  assert.equal(big.to, 'd');      // 大贫民
  assert.equal(small.from, 'b');  // 富豪
  assert.equal(small.to, 'c');    // 贫民

  // 上缴的确实是按普通序最强的 N 张
  for (const it of g.exchange.pending) {
    const poor = P(g, it.to);
    const all = poor.hand.concat(it.taken);
    const top = all.slice().sort((x, y) => engine.cardStrength(y, false) - engine.cardStrength(x, false))
      .slice(0, it.count).map((c) => engine.cardStrength(c, false)).sort();
    const got = it.taken.map((c) => engine.cardStrength(c, false)).sort();
    assert.deepEqual(got, top);
    assert.ok(it.taken.every((c) => P(g, it.from).hand.indexOf(c) >= 0));
  }
  assert.equal(totalCards(g), 54);

  // 换牌没完不能出牌
  assert.throws(() => play(g, 'd', [P(g, 'd').hand[0]]), /换牌/);
  assert.throws(() => apply(g, 'd', { type: 'pass' }), /换牌/);
  // 贫方没有回赠义务
  assert.deepEqual(legalMoves(g, 'd'), []);
  assert.throws(() => apply(g, 'd', { type: 'give_back', cards: [P(g, 'd').hand[0]] }), /没有要回赠的牌/);
  // 张数不对
  assert.throws(() => apply(g, 'a', { type: 'give_back', cards: [P(g, 'a').hand[0]] }), /要回赠 2 张/);

  const giveA = P(g, 'a').hand.slice(0, 2);
  g = apply(g, 'a', { type: 'give_back', cards: giveA }).state;
  assert.equal(g.phase, 'exchange');                        // b 还欠着
  assert.ok(giveA.every((c) => P(g, 'd').hand.indexOf(c) >= 0));
  assert.ok(giveA.every((c) => P(g, 'a').hand.indexOf(c) < 0));
  assert.throws(() => apply(g, 'a', { type: 'give_back', cards: [P(g, 'a').hand[0]] }), /没有要回赠的牌/);

  const giveB = P(g, 'b').hand.slice(0, 1);
  g = apply(g, 'b', { type: 'give_back', cards: giveB }).state;
  assert.equal(g.phase, 'playing');
  assert.equal(g.leader, 'd');       // 以后各轮大贫民先出
  assert.equal(g.current, 'd');
  assert.equal(totalCards(g), 54);
  assert.deepEqual(g.players.map((p) => p.hand.length).sort(), [13, 13, 14, 14]);
});

test('换牌：贫方手里有王也要交出去', () => {
  // 换一批 seed 直到大贫民的牌里有王为止
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    let g = mk({ a: ['S4'], b: ['S5'], c: ['S6'], d: ['S7'] }, { seed: 'jk' + i });
    g = play(g, 'a', ['S4']);
    g = play(g, 'b', ['S5']);
    g = play(g, 'c', ['S6']);
    g = apply(g, 'a', { type: 'next_round' }).state;
    const it = g.exchange.pending.find((x) => x.count === 2);
    const union = P(g, it.to).hand.concat(it.taken);
    const jokers = union.filter((x) => x[0] === 'X');
    if (!jokers.length) continue;
    found = true;
    for (const j of jokers.slice(0, it.count)) assert.ok(it.taken.indexOf(j) >= 0, `王 ${j} 没被上缴`);
  }
  assert.ok(found, '40 个 seed 都没摸到王，改 seed');
});

test('换牌：3 人 / 2 人只有 2 张那一对', () => {
  for (const ids of [['a', 'b', 'c'], ['a', 'b']]) {
    const hands = {};
    ids.forEach((id, i) => { hands[id] = ['S' + (4 + i)]; });
    let g = mk(hands);
    for (let i = 0; i < ids.length - 1; i++) g = play(g, ids[i], hands[ids[i]]);
    assert.equal(g.phase, 'round_over');
    g = apply(g, ids[0], { type: 'next_round' }).state;
    assert.equal(g.phase, 'exchange');
    assert.equal(g.exchange.pending.length, 1);
    assert.equal(g.exchange.pending[0].count, 2);
    assert.equal(g.exchange.pending[0].from, 'a');
    assert.equal(g.exchange.pending[0].to, ids[ids.length - 1]);
  }
});

test('第 1 轮没有换牌', () => {
  const g = createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 'x' });
  assert.equal(g.phase, 'playing');
  assert.equal(g.exchange, null);
  assert.equal(g.round, 1);
});

// ------------------------------------------------------------------ 都落ち

test('都落ち：上轮大富豪没第一个出完，当场跌成大贫民', () => {
  const rules = { miyako_ochi: true };
  let g = mk({ a: ['S4'], b: ['S5'], c: ['S6'], d: ['S7'] }, { rules });
  g = play(g, 'a', ['S4']);
  g = play(g, 'b', ['S5']);
  g = play(g, 'c', ['S6']);
  assert.equal(P(g, 'a').rank, 'daifugo');

  g = apply(g, 'a', { type: 'next_round' }).state;
  while (g.phase === 'exchange') {
    const it = g.exchange.pending.find((x) => x.given === null);
    g = apply(g, it.from, legalMoves(g, it.from)[0]).state;
  }
  // 第二轮重新摆牌：让 d 先出完，a（上轮大富豪）还剩牌
  const hands = { d: ['S4'], a: ['S9', 'S10'], b: ['H9', 'H10'], c: ['D9', 'D10'] };
  const used = Object.create(null);
  for (const id of Object.keys(hands)) {
    P(g, id).hand = sortCards(hands[id]);
    hands[id].forEach((x) => { used[x] = true; });
  }
  g.pile = ALL_CARDS.filter((x) => !used[x]);
  g.leader = 'd'; g.current = 'd'; g.field = null; g.lastToPlay = null;

  g = play(g, 'd', ['S4']);
  assert.equal(P(g, 'd').finished, 1);
  assert.equal(P(g, 'a').foul, 'miyako_ochi');
  assert.equal(P(g, 'a').hand.length, 0);        // 手牌被没收
  assert.equal(totalCards(g), 54);               // 没收的牌进 pile，54 张守恒
  assert.ok(g.log.some((l) => l.type === 'miyako_ochi'));

  while (g.phase === 'playing') {
    const mv = legalMoves(g, g.current);
    g = apply(g, g.current, mv[0]).state;
  }
  assert.equal(P(g, 'a').rank, 'daihinmin');
  assert.equal(P(g, 'd').rank, 'daifugo');
});

test('都落ち：上轮大富豪自己第一个出完就没事；开关默认关', () => {
  const rules = { miyako_ochi: true };
  let g = mk({ a: ['S4'], b: ['S5'], c: ['S6'], d: ['S7'] }, { rules });
  g = play(g, 'a', ['S4']); g = play(g, 'b', ['S5']); g = play(g, 'c', ['S6']);
  g = apply(g, 'a', { type: 'next_round' }).state;
  while (g.phase === 'exchange') {
    const it = g.exchange.pending.find((x) => x.given === null);
    g = apply(g, it.from, legalMoves(g, it.from)[0]).state;
  }
  const hands = { d: ['S4', 'S5'], a: ['S9'], b: ['H9', 'H10'], c: ['D9', 'D10'] };
  const used = Object.create(null);
  for (const id of Object.keys(hands)) {
    P(g, id).hand = sortCards(hands[id]);
    hands[id].forEach((x) => { used[x] = true; });
  }
  g.pile = ALL_CARDS.filter((x) => !used[x]);
  g.leader = 'a'; g.current = 'a'; g.field = null; g.lastToPlay = null;
  g = play(g, 'a', ['S9']);
  assert.equal(P(g, 'a').finished, 1);
  assert.equal(P(g, 'a').foul, null);
  assert.ok(g.players.every((p) => p.foul !== 'miyako_ochi'));

  assert.equal(engine.DEFAULT_RULES.miyako_ochi, false);
});

// ------------------------------------------------------------------ rules 合并 / viewFor

test('rules：config.defaults 与传入 rules 合并进 state.rules', () => {
  const g = createGame({
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    config: { defaults: { shibari: true, miyako_ochi: true } },
    rules: { miyako_ochi: false },
    seed: 'r'
  });
  assert.deepEqual(g.rules, {
    spade3: true, shibari: true, kaidan_revolution: false, forbid_finish: true, miyako_ochi: false
  });
  const bare = createGame({ players: [{ id: 'a' }, { id: 'b' }], seed: 'r' });
  assert.deepEqual(bare.rules, engine.DEFAULT_RULES);
  assert.notEqual(bare.rules, engine.DEFAULT_RULES);   // 副本，别被改坏
});

test('viewFor：只看得到自己的手牌，观战谁的都看不到', () => {
  const g = mk({ a: ['S4', 'S5'], b: ['H4', 'H5'], c: ['D4', 'D5'] });
  const va = viewFor(g, 'a');
  assert.deepEqual(va.players.find((p) => p.id === 'a').hand, ['S4', 'S5']);
  assert.equal(va.players.find((p) => p.id === 'b').hand, null);
  assert.equal(va.players.find((p) => p.id === 'b').handCount, 2);
  assert.equal(va.you, 'a');
  assert.equal(va.rngState, undefined);
  assert.equal(JSON.stringify(va).indexOf('H4'), -1);

  const obs = viewFor(g, null);
  assert.ok(obs.players.every((p) => p.hand === null));
  assert.ok(obs.players.every((p) => p.handCount === 2));
  assert.equal(obs.you, null);
  assert.equal(viewFor(g, '查无此人').you, null);
});

test('viewFor：换牌的给/收只对当事双方可见', () => {
  let g = mk({ a: ['S4'], b: ['S5'], c: ['S6'], d: ['S7'] });
  g = play(g, 'a', ['S4']); g = play(g, 'b', ['S5']); g = play(g, 'c', ['S6']);
  g = apply(g, 'a', { type: 'next_round' }).state;
  const big = g.exchange.pending.find((it) => it.count === 2);

  const va = viewFor(g, 'a').exchange.pending.find((it) => it.count === 2);
  const vd = viewFor(g, 'd').exchange.pending.find((it) => it.count === 2);
  const vc = viewFor(g, 'c').exchange.pending.find((it) => it.count === 2);
  assert.deepEqual(va.taken, big.taken);
  assert.deepEqual(vd.taken, big.taken);
  assert.equal(vc.taken, null);                     // 局外人看不到
  assert.equal(vc.count, 2);                        // 但知道有这么回事
  const dump = JSON.stringify(viewFor(g, 'c'));
  for (const card of big.taken) assert.equal(dump.indexOf('"' + card + '"'), -1);
});

// ------------------------------------------------------------------ 动作守卫

test('动作守卫：未知动作/查无此人/不是你的回合', () => {
  const g = mk({ a: ['S4', 'S5'], b: ['H4', 'H5'] });
  assert.throws(() => apply(g, 'a', { type: 'fly' }), /未知动作/);
  assert.throws(() => apply(g, 'zzz', { type: 'pass' }), /查无此人/);
  assert.throws(() => play(g, 'b', ['H4']), /还没轮到你/);
  assert.throws(() => play(g, 'a', ['H4']), /你手里没有/);
  assert.throws(() => play(g, 'a', []), /至少要出一张牌/);
  assert.throws(() => play(g, 'a', ['S4', 'S4']), /不能出两次/);
  assert.throws(() => play(g, 'a', ['S4', 'S5']), /不是合法的牌型/);
  assert.throws(() => apply(g, 'a', { type: 'next_round' }), /还没打完/);
  assert.throws(() => apply(null, 'a', { type: 'pass' }), /缺少牌局状态/);
});

test('apply 不改入参 state', () => {
  const g = mk({ a: ['S4', 'S5'], b: ['H4', 'H5'] });
  const snapshot = JSON.stringify(g);
  const r = apply(g, 'a', { type: 'play', cards: ['S4'] });
  assert.equal(JSON.stringify(g), snapshot);
  assert.equal(r.state.seq, g.seq + 1);
  assert.ok(r.events.length > 0);
});

test('createGame 人数守卫', () => {
  assert.throws(() => createGame({ players: [{ id: 'a' }] }), /2~4/);
  assert.throws(() => createGame({ players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }] }), /2~4/);
  assert.throws(() => createGame({ players: [{ id: 'a' }, { id: 'a' }] }), /id 重复/);
});

test('发牌：54 张发完，4 人 13/13/14/14', () => {
  const g = createGame({
    players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], seed: 'deal'
  });
  assert.deepEqual(g.players.map((p) => p.hand.length).sort(), [13, 13, 14, 14]);
  const all = g.players.reduce((acc, p) => acc.concat(p.hand), []);
  assert.equal(new Set(all).size, 54);
  assert.equal(totalCards(g), 54);
  const g3 = createGame({ players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], seed: 'deal' });
  assert.deepEqual(g3.players.map((p) => p.hand.length), [18, 18, 18]);
  const g2 = createGame({ players: [{ id: 'a' }, { id: 'b' }], seed: 'deal' });
  assert.deepEqual(g2.players.map((p) => p.hand.length), [27, 27]);
});

// ------------------------------------------------------------------ 确定性回放

/** 用固定 seed 的 bot 打完一整轮，返回每步动作与最终 state */
function replay(seed) {
  let g = createGame({
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }],
    seed
  });
  let rs = createRngState('bot-' + seed);
  const rnd = (n) => { const [next, v] = rngNext(rs); rs = next; return v % n; };
  const trace = [];
  while (g.phase === 'playing' || g.phase === 'exchange') {
    const actor = g.phase === 'exchange'
      ? g.exchange.pending.find((it) => it.given === null).from
      : g.current;
    const mv = legalMoves(g, actor);
    const pick = mv[rnd(mv.length)];
    trace.push(actor + ':' + pick.type + ':' + (pick.cards || []).join('+'));
    g = apply(g, actor, pick).state;
  }
  return { g, trace };
}

test('固定 seed 整轮确定性回放', () => {
  const a = replay('replay-1');
  const b = replay('replay-1');
  assert.deepEqual(a.trace, b.trace);
  const strip = (s) => { const c = JSON.parse(JSON.stringify(s)); delete c.createdAt; return c; };
  assert.deepEqual(strip(a.g), strip(b.g));
  assert.equal(a.g.phase, 'round_over');
  const c = replay('replay-2');
  assert.notDeepEqual(a.trace, c.trace);

  // 同 seed 建局，发的牌也一样
  const mkg = () => createGame({ players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], seed: 'same' });
  assert.deepEqual(mkg().players.map((p) => p.hand), mkg().players.map((p) => p.hand));
});

// ------------------------------------------------------------------ 随机压测

test('压测：随机合法动作打满 200 轮，54 张守恒 + 永不死锁', () => {
  const players = [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' },
    { id: 'c', name: 'C', isAI: true }, { id: 'd', name: 'D', isAI: true }
  ];
  let g = createGame({ players, seed: 'stress', rules: { shibari: true, kaidan_revolution: true, miyako_ochi: true } });
  let rs = createRngState('stress-bot');
  const rnd = (n) => { const [next, v] = rngNext(rs); rs = next; return v % n; };

  let rounds = 0;
  let steps = 0;
  const seenRevolution = { yes: false };
  while (rounds < 200) {
    steps += 1;
    assert.ok(steps < 500000, '步数失控，八成是死循环');

    // 54 张永远都在
    assert.equal(totalCards(g), 54, `第 ${steps} 步牌数不对`);
    const all = g.players.reduce((acc, p) => acc.concat(p.hand), []).concat(g.pile);
    assert.equal(new Set(all).size, 54, `第 ${steps} 步有牌重复/丢失`);

    if (g.revolution) seenRevolution.yes = true;

    if (g.phase === 'round_over') {
      rounds += 1;
      // 名次表每轮都齐整
      assert.equal(g.lastResults.length, players.length);
      assert.deepEqual(g.lastResults.map((r) => r.place), [1, 2, 3, 4]);
      assert.deepEqual(g.players.map((p) => p.rank).slice().sort(),
        ['daifugo', 'daihinmin', 'fugo', 'hinmin']);
      if (rounds >= 200) break;
      g = apply(g, g.turnOrder[rnd(4)], { type: 'next_round' }).state;
      continue;
    }

    let actor;
    if (g.phase === 'exchange') {
      actor = g.exchange.pending.find((it) => it.given === null).from;
    } else {
      assert.equal(g.phase, 'playing');
      actor = g.current;
      assert.ok(actor, 'playing 阶段必须有当前玩家');
      assert.equal(P(g, actor).finished, null, '轮到的人不该是已出完的');
    }

    const mv = legalMoves(g, actor);
    // 永不死锁：任何 playing 状态下当前玩家至少有 pass 或一手能出的牌
    assert.ok(mv.length > 0, `第 ${steps} 步死锁：phase=${g.phase} actor=${actor}`);
    if (g.phase === 'playing') {
      if (g.field) assert.ok(mv.some((m) => m.type === 'pass'), '场上有牌就必须能过');
      else {
        assert.ok(mv.every((m) => m.type === 'play'), '领出者不能过');
        assert.ok(mv.length > 0, '领出者必须有牌可出');
      }
    }
    g = apply(g, actor, mv[rnd(mv.length)]).state;
  }

  assert.equal(rounds, 200);
  assert.equal(g.rounds.length, 200);
  assert.ok(seenRevolution.yes, '200 轮一次革命都没见着，可疑');
  const total = g.players.reduce((n, p) => n + p.score, 0);
  assert.equal(total, 200 * (3 + 2 + 1 + 0));
});

test('压测：2 人 / 3 人局各 60 轮也不炸', () => {
  for (const n of [2, 3]) {
    const ids = ['a', 'b', 'c'].slice(0, n);
    let g = createGame({
      players: ids.map((id) => ({ id, name: NAMES[id] })),
      seed: 'stress-' + n,
      rules: { shibari: true, kaidan_revolution: true, miyako_ochi: true, forbid_finish: true }
    });
    let rs = createRngState('bot-' + n);
    const rnd = (k) => { const [next, v] = rngNext(rs); rs = next; return v % k; };
    let rounds = 0;
    let steps = 0;
    while (rounds < 60) {
      steps += 1;
      assert.ok(steps < 200000, 'n=' + n + ' 步数失控');
      assert.equal(totalCards(g), 54);
      if (g.phase === 'round_over') {
        rounds += 1;
        if (rounds >= 60) break;
        g = apply(g, ids[0], { type: 'next_round' }).state;
        continue;
      }
      const actor = g.phase === 'exchange'
        ? g.exchange.pending.find((it) => it.given === null).from
        : g.current;
      const mv = legalMoves(g, actor);
      assert.ok(mv.length > 0, `n=${n} 第 ${steps} 步死锁 phase=${g.phase}`);
      g = apply(g, actor, mv[rnd(mv.length)]).state;
    }
    assert.equal(rounds, 60);
    assert.equal(g.players.reduce((t, p) => t + p.score, 0), 60 * (n * (n - 1) / 2));
  }
});

// ------------------------------------------------------------------ 双环境导出

test('导出：CommonJS + 浏览器全局都挂得上', () => {
  for (const k of ['createGame', 'apply', 'legalMoves', 'viewFor', 'comboOf', 'beats']) {
    assert.equal(typeof engine[k], 'function', `缺导出 ${k}`);
  }
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../engine.cjs'), 'utf8');
  assert.ok(src.indexOf("typeof window !== 'undefined'") >= 0, '缺浏览器全局导出');
  assert.ok(src.indexOf('window.DaifugoEngine') >= 0, '缺 window.DaifugoEngine');
  // 在无 module/window 的环境里跑一遍，确认不炸
  const vm = require('node:vm');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.equal(typeof sandbox.window.DaifugoEngine.comboOf, 'function');
  assert.equal(sandbox.window.DaifugoEngine.comboOf(['S7', 'H7']).size, 2);
});
