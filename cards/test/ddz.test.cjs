'use strict';
/**
 * cards/engines/ddz.cjs 单测（docs/design-cards.md 第 3 章）
 * 跑：node --test test/ddz.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert');
const engine = require('../engines/ddz.cjs');

const {
  meta, createGame, apply, legalMoves, viewFor, currentActors, briefing, fmtMove,
  comboOf, comboCandidates, beats, enumerateCombos,
  sortCards, cardsLabel, ALL_CARDS
} = engine;

// ------------------------------------------------------------------ fixtures

const NAMES = { a: 'A', b: 'B', c: 'C' };

/**
 * 造一个手牌摆好的对局。hands = {a:[...], b:[...], c:[...]}。
 * 没进手牌的牌全塞 pile，保证「手牌 + pile === 54」这条守恒随时可查
 * （底牌已经算进地主手里，bottomDealt=true）。
 * opts: {landlord, current, leader, base, bombs, rules, played:{a:n,...}, seed}
 */
function mk(hands, opts) {
  const o = opts || {};
  const ids = Object.keys(hands);
  assert.strictEqual(ids.length, 3, 'fixture 必须 3 人');
  const g = createGame({
    players: ids.map((id) => ({ id, name: NAMES[id] || id })),
    seed: o.seed || 'fixture',
    rules: o.rules || {}
  });
  const used = Object.create(null);
  const landlord = o.landlord || ids[0];
  for (const id of ids) {
    const p = g.players.find((x) => x.id === id);
    p.hand = sortCards(hands[id]);
    p.isLandlord = (id === landlord);
    p.playedCount = (o.played && o.played[id]) || 0;
    p.passed = false;
    p.bid = null;
    for (const c of hands[id]) {
      assert.ok(!used[c], `fixture 重复发牌：${c}`);
      used[c] = true;
    }
  }
  g.pile = ALL_CARDS.filter((c) => !used[c]);
  g.bottom = g.pile.slice(0, 3);
  g.bottomDealt = true;
  g.landlord = landlord;
  g.base = o.base || 1;
  g.bombs = o.bombs || 0;
  g.phase = 'playing';
  g.round = o.round || 1;
  g.field = null;
  g.lastToPlay = null;
  g.passStreak = 0;
  g.bids = [];
  g.highBid = null;
  g.leader = o.leader || landlord;
  g.current = o.current || g.leader;
  return g;
}

/** 牌张守恒：手牌 + 已打出去的 + （没发下去的底牌）恒 54，且无重复 */
function assertConservation(g, where) {
  const all = [];
  for (const p of g.players) all.push.apply(all, p.hand);
  all.push.apply(all, g.pile);
  if (!g.bottomDealt) all.push.apply(all, g.bottom);
  assert.strictEqual(all.length, 54, `${where}：牌张总数不是 54（${all.length}）`);
  assert.strictEqual(new Set(all).size, 54, `${where}：出现重复牌`);
}

function play(g, who, cards, as) {
  return apply(g, who, { type: 'play', cards, as }).state;
}

function pass(g, who) {
  return apply(g, who, { type: 'pass' }).state;
}

function typeOf(cards, rules) {
  const c = comboOf(cards, { rules });
  return c ? c.type : null;
}

// ------------------------------------------------------------------ meta

test('meta 按契约写死：ddz / 斗地主 / 恰好 3 人 / 四带二开关', () => {
  assert.strictEqual(meta.key, 'ddz');
  assert.strictEqual(meta.name, '斗地主');
  assert.strictEqual(meta.minPlayers, 3);
  assert.strictEqual(meta.maxPlayers, 3);
  assert.deepStrictEqual(meta.defaultRules, { allow_four_two: true });
  assert.strictEqual(meta.ruleMeta.length, 1);
  assert.strictEqual(meta.ruleMeta[0].key, 'allow_four_two');
  assert.strictEqual(meta.ruleMeta[0].label, '四带二');
  assert.strictEqual(meta.ruleMeta[0].def, true);
});

// ------------------------------------------------------------------ 牌型识别

test('牌型识别：合法牌型表驱动全覆盖', () => {
  const table = [
    // [牌, 期望 type, 期望 mainRank, 期望 len]
    [['S3'], 'single', 3, 1],
    [['X1'], 'single', 16, 1],
    [['X2'], 'single', 17, 1],
    [['S15'], 'single', 15, 1],
    [['S3', 'H3'], 'pair', 3, 1],
    [['S15', 'H15'], 'pair', 15, 1],
    [['S3', 'H3', 'D3'], 'triple', 3, 1],
    [['S3', 'H3', 'D3', 'C4'], 'triple_one', 3, 1],
    [['S3', 'H3', 'D3', 'X2'], 'triple_one', 3, 1],
    [['S3', 'H3', 'D3', 'C4', 'S4'], 'triple_pair', 3, 1],
    [['S3', 'S4', 'S5', 'H6', 'D7'], 'straight', 7, 5],
    [['S10', 'S11', 'S12', 'H13', 'D14'], 'straight', 14, 5],
    [['S3', 'H4', 'D5', 'C6', 'S7', 'H8', 'D9', 'C10', 'S11', 'H12', 'D13', 'C14'], 'straight', 14, 12],
    [['S3', 'H3', 'S4', 'H4', 'S5', 'H5'], 'pair_straight', 5, 3],
    [['S13', 'H13', 'S14', 'H14', 'S12', 'H12'], 'pair_straight', 14, 3],
    [['S3', 'H3', 'D3', 'S4', 'H4', 'D4'], 'plane', 4, 2],
    [['S3', 'H3', 'D3', 'S4', 'H4', 'D4', 'S5', 'H5', 'D5'], 'plane', 5, 3],
    [['S3', 'H3', 'D3', 'S4', 'H4', 'D4', 'C7', 'C8'], 'plane_one', 4, 2],
    [['S3', 'H3', 'D3', 'S4', 'H4', 'D4', 'X1', 'X2'], 'plane_one', 4, 2],
    [['S3', 'H3', 'D3', 'S4', 'H4', 'D4', 'C7', 'S7', 'C8', 'S8'], 'plane_pair', 4, 2],
    [['S3', 'H3', 'D3', 'C3'], 'bomb', 3, 1],
    [['S15', 'H15', 'D15', 'C15'], 'bomb', 15, 1],
    [['X1', 'X2'], 'rocket', 17, 1],
    [['S3', 'H3', 'D3', 'C3', 'S7', 'S8'], 'four_two_single', 3, 1],
    [['S3', 'H3', 'D3', 'C3', 'X1', 'X2'], 'four_two_single', 3, 1],
    [['S3', 'H3', 'D3', 'C3', 'S7', 'H7'], 'four_two_single', 3, 1],
    [['S3', 'H3', 'D3', 'C3', 'S7', 'H7', 'S8', 'H8'], 'four_two_pair', 3, 1]
  ];
  for (const [cards, type, mainRank, len] of table) {
    const c = comboOf(cards);
    assert.ok(c, `${cardsLabel(cards)} 应该是合法牌型（期望 ${type}）`);
    assert.strictEqual(c.type, type, `${cardsLabel(cards)} 认成了 ${c.type}`);
    assert.strictEqual(c.mainRank, mainRank, `${cardsLabel(cards)} 主牌 rank 不对`);
    assert.strictEqual(c.len, len, `${cardsLabel(cards)} len 不对`);
    assert.strictEqual(c.size, cards.length);
  }
});

test('牌型识别：边界——2 和王不入顺、翅膀数量不匹配、杂牌一律非法', () => {
  const bad = [
    [['S11', 'S12', 'S13', 'H14', 'D15'], 'JQKA2 里的 2 不入顺'],
    [['S13', 'H14', 'D15', 'X1', 'X2'], 'KA2 加双王不是顺子'],
    [['S10', 'S11', 'S12', 'S13', 'X1'], '王不能补顺子的位'],
    [['S3', 'S4', 'S5', 'H6'], '顺子不足 5 张'],
    [['S3', 'S4', 'H5', 'D6', 'S8'], '顺子断档'],
    [['S3', 'H3', 'S4', 'H4'], '连对不足 3 对'],
    [['S14', 'H14', 'S15', 'H15', 'S13', 'H13'], '连对不能带 2'],
    [['S3', 'H3', 'S4', 'H4', 'S6', 'H6'], '连对断档'],
    [['S3', 'H3', 'D3', 'S4', 'H4', 'D4', 'C7'], '飞机只带 1 张翅膀'],
    [['S3', 'H3', 'D3', 'S4', 'H4', 'D4', 'C7', 'S7', 'C8'], '飞机翅膀凑不齐两对'],
    [['S3', 'H3', 'D3', 'S4', 'H4', 'D4', 'C4', 'C8'], '飞机翅膀不能是三条自己的第 4 张'],
    [['S14', 'H14', 'D14', 'S15', 'H15', 'D15'], '飞机不能带 2'],
    [['S3', 'H3', 'D3', 'C3', 'S7', 'H7', 'D7', 'C7'], '四带两对不能拿另一个炸弹充数'],
    [['X1', 'X1'], '同一张牌写两遍'],
    [['S3', 'H4'], '两张不同 rank 不是对子'],
    [['X1', 'X2', 'S3'], '双王加一张不是牌型'],
    [['S3', 'H3', 'D4'], '一对加一张单不是牌型'],
    [['S3', 'H3', 'D3', 'C3', 'S7', 'H7', 'S8'], '四带二张数不对'],
    [[], '空牌'],
    [['S16'], '不存在的牌 id'],
    [['X3'], '不存在的王']
  ];
  for (const [cards, why] of bad) {
    assert.strictEqual(comboOf(cards), null, `${JSON.stringify(cards)} 应该非法：${why}`);
  }
});

test('牌型识别：allow_four_two 关掉之后四带二/四带两对都不认', () => {
  const off = { allow_four_two: false };
  assert.strictEqual(typeOf(['S3', 'H3', 'D3', 'C3', 'S7', 'S8'], off), null);
  assert.strictEqual(typeOf(['S3', 'H3', 'D3', 'C3', 'S7', 'H7', 'S8', 'H8'], off), null);
  // 炸弹本身不受开关影响
  assert.strictEqual(typeOf(['S3', 'H3', 'D3', 'C3'], off), 'bomb');
  // 开着的时候照认
  assert.strictEqual(typeOf(['S3', 'H3', 'D3', 'C3', 'S7', 'S8'], { allow_four_two: true }), 'four_two_single');
});

test('牌型识别：一副牌有多种解释时全列出来（4 连三条 = 纯飞机，不硬塞翅膀）', () => {
  const cands = comboCandidates(['S3', 'H3', 'D3', 'S4', 'H4', 'D4', 'S5', 'H5', 'D5', 'S6', 'H6', 'D6']);
  const types = cands.map((c) => c.type);
  assert.ok(types.indexOf('plane') >= 0, '至少要认出 4 连纯飞机');
  assert.strictEqual(cands[0].type, 'plane', '首选解释应该是纯飞机');
  assert.strictEqual(cands[0].len, 4);
});

// ------------------------------------------------------------------ 比大小

test('比大小矩阵：同型比主牌、异型不能跟、张数不同不能跟', () => {
  const T = true, F = false;
  const rows = [
    [['H4'], ['S3'], T, '大单张压小单张'],
    [['S3'], ['H4'], F, '小单张压不动'],
    [['S3'], ['S3'], F, '一样大不算压'],
    [['S15'], ['H14'], T, '2 比 A 大'],
    [['X1'], ['S15'], T, '小王比 2 大'],
    [['X2'], ['X1'], T, '大王比小王大'],
    [['S4', 'H4'], ['S3', 'H3'], T, '对子比对子'],
    [['S4', 'H4'], ['S3'], F, '对子跟不了单张'],
    [['S4', 'H4', 'D4'], ['S3', 'H3', 'D3'], T, '三条比三条'],
    [['S4', 'H4', 'D4', 'C7'], ['S3', 'H3', 'D3', 'C8'], T, '三带一只比三条不比翅膀'],
    [['S3', 'H3', 'D3', 'C8'], ['S4', 'H4', 'D4', 'C7'], F, '三条小就是压不过'],
    [['S4', 'H5', 'D6', 'C7', 'S8'], ['S3', 'H4', 'D5', 'C6', 'S7'], T, '顺子比最大那张'],
    [['S4', 'H5', 'D6', 'C7', 'S8', 'H9'], ['S3', 'H4', 'D5', 'C6', 'S7'], F, '顺子长度不同不能跟'],
    [['S4', 'H4', 'S5', 'H5', 'S6', 'H6'], ['S3', 'H3', 'S4', 'H4', 'S5', 'H5'], T, '连对比最大那对'],
    [['S4', 'H4', 'D4', 'S5', 'H5', 'D5'], ['S3', 'H3', 'D3', 'S4', 'H4', 'D4'], T, '飞机比最大那组'],
    [['S3', 'H3', 'D3', 'C3'], ['H14'], T, '炸弹压单张'],
    [['S3', 'H3', 'D3', 'C3'], ['S4', 'H5', 'D6', 'C7', 'S8'], T, '炸弹压顺子'],
    [['S4', 'H4', 'D4', 'C4'], ['S3', 'H3', 'D3', 'C3'], T, '大炸弹压小炸弹'],
    [['S3', 'H3', 'D3', 'C3'], ['S4', 'H4', 'D4', 'C4'], F, '小炸弹压不动大炸弹'],
    [['S15'], ['S3', 'H3', 'D3', 'C3'], F, '普通牌压不动炸弹'],
    [['X1', 'X2'], ['S15', 'H15', 'D15', 'C15'], T, '王炸压炸弹'],
    [['X1', 'X2'], ['S3'], T, '王炸压单张'],
    [['S15', 'H15', 'D15', 'C15'], ['X1', 'X2'], F, '炸弹压不动王炸'],
    [['S3', 'H3', 'D3', 'C3', 'S7', 'S8'], ['S3'], F, '四带二不是炸弹，压不了单张'],
    [['S4', 'H4', 'D4', 'C4', 'S7', 'S8'], ['S3', 'H3', 'D3', 'C3', 'H7', 'H8'], T, '四带二比四条那个 rank']
  ];
  for (const [a, b, want, why] of rows) {
    assert.strictEqual(beats(a, b), want, `${cardsLabel(a)} vs ${cardsLabel(b)}：${why}`);
  }
  assert.strictEqual(beats(['S3'], null), true, '空场随便出');
  assert.strictEqual(beats(['S3', 'H4'], null), false, '空场也得是合法牌型');
});

// ------------------------------------------------------------------ 叫分流程

test('叫分：叫 3 分直接定地主，底牌并进手牌', () => {
  let g = createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], seed: 'bid-3' });
  assert.strictEqual(g.phase, 'bidding');
  assert.deepStrictEqual(currentActors(g), [g.current]);
  assertConservation(g, '发牌后');
  const first = g.current;
  assert.strictEqual(viewFor(g, first).bottomCards, null, '定地主前底牌谁也看不到');

  g = apply(g, first, { type: 'bid', value: 3 }).state;
  assert.strictEqual(g.phase, 'playing');
  assert.strictEqual(g.landlord, first);
  assert.strictEqual(g.base, 3);
  assert.strictEqual(g.players.find((p) => p.id === first).hand.length, 20);
  assert.strictEqual(g.current, first, '地主先出');
  assertConservation(g, '定地主后');
  const v = viewFor(g, 'b');
  assert.strictEqual(v.bottomCards.length, 3, '定地主后底牌全员可见');
  assert.strictEqual(v.landlord, first);
});

test('叫分：最高者得，叫分必须一次比一次高', () => {
  let g = createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], seed: 'bid-high' });
  const p1 = g.current;
  g = apply(g, p1, { type: 'bid', value: 1 }).state;
  const p2 = g.current;
  assert.notStrictEqual(p2, p1);
  assert.throws(() => apply(g, p2, { type: 'bid', value: 1 }), /要叫就得更高/);
  assert.throws(() => apply(g, p1, { type: 'bid', value: 2 }), /还没轮到你叫分/);
  assert.throws(() => apply(g, p2, { type: 'bid', value: 5 }), /叫分只能是/);

  // legalMoves 只给得出手的分数
  assert.deepStrictEqual(legalMoves(g, p2).map((m) => m.value), [0, 2, 3]);
  assert.deepStrictEqual(legalMoves(g, p1), [], '不轮到他就是空数组');

  g = apply(g, p2, { type: 'bid', value: 2 }).state;
  const p3 = g.current;
  g = apply(g, p3, { type: 'bid', value: 0 }).state;
  assert.strictEqual(g.phase, 'playing');
  assert.strictEqual(g.landlord, p2, '2 分最高，p2 当地主');
  assert.strictEqual(g.base, 2);
});

test('叫分：全都不叫 → 同一局内重新洗发，round 不变', () => {
  let g = createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], seed: 'bid-zero' });
  const before = g.players.map((p) => p.hand.join(','));
  const starter = g.current;
  for (let i = 0; i < 3; i++) g = apply(g, g.current, { type: 'bid', value: 0 }).state;
  assert.strictEqual(g.phase, 'bidding', '重发之后还在叫分');
  assert.strictEqual(g.round, 1, 'round 不变');
  assert.strictEqual(g.landlord, null);
  assert.deepStrictEqual(g.bids, [], '叫分记录清空');
  assert.strictEqual(g.highBid, null);
  assert.notStrictEqual(g.current, starter, '先叫的位置往下家挪一格');
  assert.ok(g.log.some((l) => l.text === '全都不叫，重新发牌'), 'log 里要有重发那一条');
  const after = g.players.map((p) => p.hand.join(','));
  assert.notDeepStrictEqual(after, before, '牌得是重新洗过的');
  assert.strictEqual(g.bottomDealt, false);
  assertConservation(g, '重发后');
  for (const p of g.players) assert.strictEqual(p.hand.length, 17);
});

test('叫分：叫分阶段不能出牌，出牌阶段不能叫分', () => {
  let g = createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], seed: 'bid-phase' });
  const who = g.current;
  const one = g.players.find((p) => p.id === who).hand[0];
  assert.throws(() => apply(g, who, { type: 'play', cards: [one] }), /先把地主定下来/);
  assert.throws(() => apply(g, who, { type: 'pass' }), /先把地主定下来/);
  g = apply(g, who, { type: 'bid', value: 3 }).state;
  assert.throws(() => apply(g, who, { type: 'bid', value: 1 }), /现在不是叫分阶段/);
});

// ------------------------------------------------------------------ 出牌 / pass

test('出牌：跟牌必须同型同长且更大，牌不在手里要报错', () => {
  let g = mk({ a: ['S5', 'H5', 'S9'], b: ['S6', 'H6', 'S10'], c: ['S7', 'H7', 'S11'] });
  g = play(g, 'a', ['S5', 'H5']);
  assert.strictEqual(g.field.combo.type, 'pair');
  assert.throws(() => play(g, 'b', ['S6']), /跟牌要同型同张数/);
  assert.throws(() => play(g, 'b', ['S10']), /跟牌要同型同张数/);
  assert.throws(() => play(g, 'b', ['H10']), /你手里没有/);
  assert.throws(() => play(g, 'c', ['S7', 'H7']), /还没轮到你出牌/);
  g = play(g, 'b', ['S6', 'H6']);
  assert.strictEqual(g.current, 'c');
  assert.throws(() => play(g, 'c', ['S11']), /跟牌要同型同张数/);
});

test('出牌：领出者不能过，压不过的牌要给中文原因', () => {
  let g = mk({ a: ['S5', 'S9'], b: ['S4', 'S10'], c: ['S7', 'S11'] });
  assert.throws(() => pass(g, 'a'), /必须出牌/);
  g = play(g, 'a', ['S5']);
  assert.throws(() => play(g, 'b', ['S4']), /压不过场上的/);
});

test('pass 规则：其余两家都过 → 清场，领出权归最后出牌的人', () => {
  let g = mk({ a: ['S5', 'S9'], b: ['S6', 'S10'], c: ['S7', 'S11'] });
  g = play(g, 'a', ['S5']);
  g = play(g, 'b', ['S6']);
  assert.strictEqual(g.lastToPlay, 'b');
  g = pass(g, 'c');
  assert.strictEqual(g.field !== null, true, '只过了一家，场还没清');
  assert.strictEqual(g.current, 'a');
  g = pass(g, 'a');
  assert.strictEqual(g.field, null, '两家都过就清场');
  assert.strictEqual(g.leader, 'b');
  assert.strictEqual(g.current, 'b', '领出权归最后出牌的 B');
  assert.strictEqual(g.passStreak, 0);
  assert.ok(g.players.every((p) => !p.passed), '清场后 passed 标记全清');
});

test('pass 规则：过了一手，等有新牌上桌还能再出（不是整墩弃权）', () => {
  let g = mk({ a: ['S5', 'S9', 'H9'], b: ['S6', 'S10', 'H10'], c: ['S7', 'S15', 'H15'] });
  g = play(g, 'a', ['S5']);
  g = pass(g, 'b');
  g = play(g, 'c', ['S7']);
  assert.strictEqual(g.current, 'a');
  g = pass(g, 'a');
  assert.strictEqual(g.current, 'b', '轮回到过过一次的 B，他还能出');
  assert.strictEqual(g.field.by, 'c');
  const moves = legalMoves(g, 'b');
  assert.ok(moves.some((m) => m.type === 'play' && m.cards.join() === 'S10'), 'B 手里的 ♠10 压得住 ♠7');
});

test('王炸压炸弹，王炸上桌谁也压不住', () => {
  let g = mk({
    a: ['S3', 'H3', 'D3', 'C3', 'S9'],
    b: ['S4', 'H4', 'D4', 'C4', 'S10'],
    c: ['X1', 'X2', 'S11']
  });
  g = play(g, 'a', ['S3', 'H3', 'D3', 'C3']);
  assert.strictEqual(g.bombs, 1);
  assert.strictEqual(viewFor(g, 'a').multiplier, 2);
  g = play(g, 'b', ['S4', 'H4', 'D4', 'C4']);
  assert.strictEqual(g.bombs, 2);
  g = play(g, 'c', ['X1', 'X2']);
  assert.strictEqual(g.field.combo.type, 'rocket');
  assert.strictEqual(g.bombs, 3);
  assert.strictEqual(viewFor(g, 'c').multiplier, 8);
  // 王炸上桌之后只剩「过」
  const moves = legalMoves(g, 'a');
  assert.deepStrictEqual(moves.map((m) => m.type), ['pass'], '王炸面前只能过');
  assert.throws(() => play(g, 'a', ['S9']), /王炸谁也压不住/);
});

// ------------------------------------------------------------------ 计分

test('计分：地主先出完 = 地主胜，收两家；农民出完 = 农民胜', () => {
  let g = mk({ a: ['S9'], b: ['S10'], c: ['S11'] }, { base: 2, played: { a: 3, b: 3, c: 3 } });
  g = play(g, 'a', ['S9']);
  assert.strictEqual(g.phase, 'round_over');
  assert.strictEqual(g.roundWinner, 'landlord');
  assert.strictEqual(g.spring, false);
  const by = {};
  for (const r of g.lastResults) by[r.playerId] = r.delta;
  assert.deepStrictEqual(by, { a: 4, b: -2, c: -2 }, '底分 2 × 倍数 1：地主 ±2 倍，农民 ±1 倍');
  assert.strictEqual(by.a + by.b + by.c, 0, '零和');
  assert.deepStrictEqual(legalMoves(g, 'b'), [{ type: 'next_round' }]);
  assert.deepStrictEqual(currentActors(g), []); // round_over 不列人,下一局由人点
});

test('计分：农民任一家出完就算农民胜', () => {
  let g = mk({ a: ['S9', 'S3'], b: ['S10'], c: ['S11'] }, { base: 1, played: { a: 3, b: 3, c: 3 } });
  g = play(g, 'a', ['S9']);
  g = play(g, 'b', ['S10']);
  assert.strictEqual(g.phase, 'round_over');
  assert.strictEqual(g.roundWinner, 'farmer');
  const by = {};
  for (const r of g.lastResults) by[r.playerId] = r.delta;
  assert.deepStrictEqual(by, { a: -2, b: 1, c: 1 });
});

test('计分：春天 —— 地主赢且两农民一张没出，倍数 ×2', () => {
  let g = mk({ a: ['X2', 'S5'], b: ['S6'], c: ['S7'] }, { base: 1 });
  g = play(g, 'a', ['X2']);
  g = pass(g, 'b');
  g = pass(g, 'c');
  assert.strictEqual(g.current, 'a', '清场后地主继续领出');
  g = play(g, 'a', ['S5']);
  assert.strictEqual(g.phase, 'round_over');
  assert.strictEqual(g.spring, true);
  assert.strictEqual(g.antiSpring, false);
  assert.strictEqual(g.rounds[0].multiplier, 2);
  const by = {};
  for (const r of g.lastResults) by[r.playerId] = r.delta;
  assert.deepStrictEqual(by, { a: 4, b: -2, c: -2 });
  assert.ok(g.log.some((l) => l.text.indexOf('春天！') === 0));
});

test('计分：反春 —— 农民赢且地主只出过第一手，倍数 ×2', () => {
  let g = mk({ a: ['S3', 'H4'], b: ['X2'], c: ['S7'] }, { base: 2 });
  g = play(g, 'a', ['S3']);
  g = play(g, 'b', ['X2']);
  assert.strictEqual(g.phase, 'round_over');
  assert.strictEqual(g.antiSpring, true);
  assert.strictEqual(g.spring, false);
  assert.strictEqual(g.rounds[0].multiplier, 2);
  const by = {};
  for (const r of g.lastResults) by[r.playerId] = r.delta;
  assert.deepStrictEqual(by, { a: -8, b: 4, c: 4 }, '底分 2 × 反春 2');
});

test('计分：农民赢但地主出过不止第一手 → 不算反春', () => {
  let g = mk({ a: ['S3', 'S15', 'S4', 'H4'], b: ['S5', 'S6', 'H9'], c: ['S7', 'S8'] }, { base: 1 });
  g = play(g, 'a', ['S3']);              // 地主第一手
  g = play(g, 'b', ['S5']);
  g = play(g, 'c', ['S7']);
  g = play(g, 'a', ['S15']);             // 地主第二手（2 压单张）
  g = pass(g, 'b');
  g = pass(g, 'c');
  assert.strictEqual(g.current, 'a');
  g = play(g, 'a', ['S4']);              // 地主第三手
  g = play(g, 'b', ['S6']);
  g = play(g, 'c', ['S8']);              // C 出完，农民胜
  assert.strictEqual(g.phase, 'round_over');
  assert.strictEqual(g.roundWinner, 'farmer');
  assert.strictEqual(g.players.find((p) => p.id === 'a').playedCount, 3);
  assert.strictEqual(g.antiSpring, false, '地主出过三手，反春不成立');
  assert.strictEqual(g.spring, false);
  assert.strictEqual(g.rounds[0].multiplier, 1);
});

test('计分：炸弹响数决定倍数（2^n），春天再 ×2', () => {
  // 一响炸弹，无春天
  let g = mk({ a: ['S3', 'H3', 'D3', 'C3', 'S5'], b: ['S6'], c: ['S7'] },
    { base: 2, played: { b: 1, c: 1 } });
  g = play(g, 'a', ['S3', 'H3', 'D3', 'C3']);
  g = pass(g, 'b');
  g = pass(g, 'c');
  g = play(g, 'a', ['S5']);
  assert.strictEqual(g.rounds[0].bombs, 1);
  assert.strictEqual(g.rounds[0].multiplier, 2);
  assert.strictEqual(g.rounds[0].spring, false);
  assert.strictEqual(g.lastResults.find((r) => r.playerId === 'a').delta, 2 * 2 * 2);

  // 两响 + 春天 = 2^2 × 2 = 8
  let h = mk({ a: ['S3', 'H3', 'D3', 'C3', 'X1', 'X2'], b: ['S6'], c: ['S7'] }, { base: 1 });
  h = play(h, 'a', ['S3', 'H3', 'D3', 'C3']);
  h = pass(h, 'b');
  h = pass(h, 'c');
  h = play(h, 'a', ['X1', 'X2']);
  assert.strictEqual(h.bombs, 2);
  assert.strictEqual(h.spring, true);
  assert.strictEqual(h.rounds[0].multiplier, 8);
  assert.strictEqual(h.lastResults.find((r) => r.playerId === 'a').delta, 1 * 8 * 2);
  assert.strictEqual(h.lastResults.find((r) => r.playerId === 'b').delta, -8);
});

test('计分：分数累计进 players[].score', () => {
  let g = mk({ a: ['S9'], b: ['S10'], c: ['S11'] }, { base: 1, played: { a: 1, b: 1, c: 1 } });
  g.players.find((p) => p.id === 'a').score = 5;
  g = play(g, 'a', ['S9']);
  assert.strictEqual(g.players.find((p) => p.id === 'a').score, 7);
  assert.strictEqual(g.lastResults.find((r) => r.playerId === 'a').score, 7);
});

// ------------------------------------------------------------------ 局间 / 收盘

test('next_round：重新发牌重新叫分，round + 1，比分留着', () => {
  let g = mk({ a: ['S9'], b: ['S10'], c: ['S11'] }, { base: 1, played: { a: 1, b: 1, c: 1 } });
  g = play(g, 'a', ['S9']);
  assert.strictEqual(g.phase, 'round_over');
  const scores = g.players.map((p) => p.score);
  g = apply(g, 'a', { type: 'next_round' }).state;
  assert.strictEqual(g.phase, 'bidding');
  assert.strictEqual(g.round, 2);
  assert.strictEqual(g.landlord, null);
  assert.strictEqual(g.base, null);
  assert.strictEqual(g.bombs, 0);
  assert.strictEqual(g.bottomDealt, false);
  assert.deepStrictEqual(g.players.map((p) => p.score), scores, '比分是累计的');
  for (const p of g.players) assert.strictEqual(p.hand.length, 17);
  assertConservation(g, '第二局发牌后');
  assert.throws(() => apply(g, 'a', { type: 'next_round' }), /这一局还没打完/);
});

test('end_match：房主收盘，phase → game_over，之后什么都不能做', () => {
  let g = mk({ a: ['S9'], b: ['S10'], c: ['S11'] }, { base: 1 });
  g.players.find((p) => p.id === 'b').score = 9;
  g = apply(g, 'a', { type: 'end_match' }).state;
  assert.strictEqual(g.phase, 'game_over');
  assert.strictEqual(g.winner, 'b');
  assert.deepStrictEqual(currentActors(g), []);
  assert.deepStrictEqual(legalMoves(g, 'a'), []);
  assert.throws(() => apply(g, 'a', { type: 'pass' }), /整场已经结束了/);
});

test('createGame：人数不对就 throw，id 重复也 throw', () => {
  assert.throws(() => createGame({ players: [{ id: 'a' }, { id: 'b' }] }), /恰好 3 人/);
  assert.throws(() => createGame({ players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }), /恰好 3 人/);
  assert.throws(() => createGame({ players: [{ id: 'a' }, { id: 'a' }, { id: 'c' }] }), /id 重复/);
  assert.throws(() => apply(mk({ a: ['S9'], b: ['S10'], c: ['S11'] }), 'zzz', { type: 'pass' }), /查无此人/);
  assert.throws(() => apply(mk({ a: ['S9'], b: ['S10'], c: ['S11'] }), 'a', { type: '飞' }), /未知动作/);
});

test('createGame：同一个 seed 发出同一副牌（可回放）', () => {
  const ps = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  const g1 = createGame({ players: ps, seed: 'same' });
  const g2 = createGame({ players: ps, seed: 'same' });
  assert.deepStrictEqual(g1.players.map((p) => p.hand), g2.players.map((p) => p.hand));
  assert.deepStrictEqual(g1.bottom, g2.bottom);
  const g3 = createGame({ players: ps, seed: 'other' });
  assert.notDeepStrictEqual(g1.players.map((p) => p.hand), g3.players.map((p) => p.hand));
});

test('apply 不改入参（state 是不可变的）', () => {
  const g = mk({ a: ['S5', 'S9'], b: ['S6'], c: ['S7'] });
  const snapshot = JSON.stringify(g);
  apply(g, 'a', { type: 'play', cards: ['S5'] });
  assert.strictEqual(JSON.stringify(g), snapshot);
});

// ------------------------------------------------------------------ legalMoves

test('legalMoves：跟牌只列压得住的同型同长 + 所有炸弹王炸 + 过', () => {
  let g = mk({
    a: ['S5', 'H5', 'S3'],
    b: ['S4', 'H4', 'S6', 'H6', 'S8', 'H8', 'D8', 'C8', 'X1', 'X2'],
    c: ['S9']
  });
  g = play(g, 'a', ['S5', 'H5']);
  const moves = legalMoves(g, 'b');
  const plays = moves.filter((m) => m.type === 'play');
  const kinds = new Set(plays.map((m) => m.combo.type));
  assert.deepStrictEqual([...kinds].sort(), ['bomb', 'pair', 'rocket'], '同型的对子 + 炸弹 + 王炸，别的一概不列');
  const pairs = plays.filter((m) => m.combo.type === 'pair').map((m) => m.cards.join());
  assert.deepStrictEqual(pairs, ['S6,H6', 'S8,H8'], '♠4♥4 太小不列，♠6♥6 和拆炸弹的 ♠8♥8 都能压');
  assert.deepStrictEqual(plays.filter((m) => m.combo.type === 'bomb').map((m) => m.cards.join()),
    ['S8,H8,D8,C8'], '炸弹不管场上是什么都列出来');
  assert.ok(moves.some((m) => m.type === 'pass'), '跟牌一定能过');
  assert.strictEqual(legalMoves(g, 'c').length, 0, '不轮到他就是空数组');
});

test('legalMoves：领出把各种牌型都枚举出来，且每一条 apply 都收', () => {
  const hand = ['S3', 'H3', 'D3', 'C3', 'S4', 'H4', 'S5', 'H5', 'S6', 'H6', 'S7', 'X1', 'X2'];
  let g = mk({ a: hand, b: ['S9'], c: ['S10'] });
  const moves = legalMoves(g, 'a');
  const kinds = new Set(moves.map((m) => m.combo.type));
  for (const want of ['single', 'pair', 'triple', 'triple_one', 'triple_pair',
    'straight', 'pair_straight', 'bomb', 'rocket', 'four_two_single', 'four_two_pair']) {
    assert.ok(kinds.has(want), `领出应该枚举得到 ${want}`);
  }
  assert.ok(!moves.some((m) => m.type === 'pass'), '领出不能过');
  for (const m of moves) {
    const r = apply(g, 'a', m);          // 每条合法招都得真的能落地
    assert.strictEqual(r.state.field.combo.type, m.combo.type, fmtMove(m) + ' 落地后牌型对不上');
  }
});

test('legalMoves：飞机/连对走滑窗，20 张手牌也不会枚举爆炸', () => {
  // 地主 20 张：4 组连着的三条 + 一串杂牌，属于枚举压力最大的形状
  const hand = [
    'S3', 'H3', 'D3', 'S4', 'H4', 'D4', 'S5', 'H5', 'D5', 'S6', 'H6', 'D6',
    'S8', 'H9', 'D10', 'C11', 'S12', 'H13', 'D14', 'X2'
  ];
  const t0 = Date.now();
  const moves = enumerateCombos(hand, { allow_four_two: true }, null);
  const ms = Date.now() - t0;
  assert.ok(moves.length > 0);
  assert.ok(moves.length < 4000, `枚举条数失控：${moves.length}`);
  assert.ok(ms < 1000, `枚举太慢：${ms}ms`);
  const kinds = new Set(moves.map((m) => m.type));
  assert.ok(kinds.has('plane'), '要有纯飞机');
  assert.ok(kinds.has('plane_one'), '要有飞机带单');
  assert.ok(kinds.has('pair_straight'), '要有连对');
  assert.ok(kinds.has('straight'), '要有顺子');
  // 每条都得是引擎自己认的合法牌型
  for (const m of moves) {
    const c = comboOf(m.cards, { as: m.type });
    assert.ok(c, `枚举出了非法牌型：${cardsLabel(m.cards)} as ${m.type}`);
    assert.strictEqual(c.mainRank, m.mainRank);
  }
});

test('legalMoves：allow_four_two 关掉之后不再枚举四带二', () => {
  const hand = ['S3', 'H3', 'D3', 'C3', 'S7', 'H7', 'S8', 'H8'];
  const on = enumerateCombos(hand, { allow_four_two: true }, null).map((m) => m.type);
  const off = enumerateCombos(hand, { allow_four_two: false }, null).map((m) => m.type);
  assert.ok(on.indexOf('four_two_single') >= 0 && on.indexOf('four_two_pair') >= 0);
  assert.strictEqual(off.indexOf('four_two_single'), -1);
  assert.strictEqual(off.indexOf('four_two_pair'), -1);
  let g = mk({ a: hand, b: ['S9'], c: ['S10'] }, { rules: { allow_four_two: false } });
  assert.throws(() => play(g, 'a', ['S3', 'H3', 'D3', 'C3', 'S7', 'S8']), /不是合法的斗地主牌型/);
});

// ------------------------------------------------------------------ 视图 / 人话

test('viewFor：自己手牌全量，别人只有张数，观战谁的也看不到', () => {
  const g = mk({ a: ['S5', 'H5'], b: ['S6', 'H6', 'S7'], c: ['S9'] }, { base: 3, bombs: 2 });
  const va = viewFor(g, 'a');
  assert.deepStrictEqual(va.players.find((p) => p.id === 'a').hand, ['S5', 'H5']);
  assert.strictEqual(va.players.find((p) => p.id === 'b').hand, null);
  assert.strictEqual(va.players.find((p) => p.id === 'b').handCount, 3);
  assert.strictEqual(va.you, 'a');
  assert.strictEqual(va.landlord, 'a');
  assert.strictEqual(va.base, 3);
  assert.strictEqual(va.multiplier, 4);
  assert.strictEqual(va.bottomCards.length, 3);
  assert.strictEqual(va.rngState, undefined, 'rngState 不外泄');

  const vo = viewFor(g, null);
  assert.ok(vo.players.every((p) => p.hand === null), '观战看不到任何手牌');
  assert.strictEqual(vo.you, null);
});

test('briefing：中文简报把手牌/身份/底牌/场上/剩牌/倍数都说清楚', () => {
  let g = mk({ a: ['S5', 'H5', 'S9'], b: ['S6', 'H6', 'S10'], c: ['S7', 'H7', 'S11'] },
    { base: 2, bombs: 1 });
  g = play(g, 'a', ['S5', 'H5']);
  const b = briefing(g, 'b');
  assert.match(b, /第 1 局/);
  assert.match(b, /地主 A/);
  assert.match(b, /底分 2/);
  assert.match(b, /倍数 2/);
  assert.match(b, /你的手牌（3 张）/);
  assert.match(b, /你是农民/);
  assert.match(b, /底牌：/);
  assert.match(b, /场上：A 出的 ♠5♥5（对子）/);
  assert.match(b, /剩牌：/);
  assert.match(b, /现在轮到你/);
  assert.ok(b.indexOf('♠6♥6♠10') >= 0, '手牌要排好序写出来');

  const a = briefing(g, 'a');
  assert.match(a, /你是地主/);

  // 叫分阶段的简报
  const fresh = createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], seed: 'brief' });
  const fb = briefing(fresh, fresh.current);
  assert.match(fb, /叫分中/);
  assert.match(fb, /还没人叫/);
  assert.match(fb, /叫分。$/);
});

test('fmtMove：一招说人话', () => {
  assert.strictEqual(fmtMove({ type: 'play', cards: ['S3', 'S4', 'H5', 'D6', 'C7'] }), '♠3♠4♥5♦6♣7（顺子）');
  assert.strictEqual(fmtMove({ type: 'play', cards: ['S5', 'H5'] }), '♠5♥5（对子）');
  assert.strictEqual(fmtMove({ type: 'play', cards: ['X1', 'X2'] }), '小王大王（王炸）');
  assert.strictEqual(fmtMove({ type: 'play', cards: ['S3', 'H3', 'D3', 'C3'] }), '♠3♥3♦3♣3（炸弹）');
  assert.strictEqual(fmtMove({ type: 'pass' }), '过');
  assert.strictEqual(fmtMove({ type: 'bid', value: 2 }), '叫 2 分');
  assert.strictEqual(fmtMove({ type: 'bid', value: 0 }), '不叫');
  assert.strictEqual(fmtMove({ type: 'next_round' }), '下一局');
  assert.strictEqual(fmtMove({ type: 'end_match' }), '收盘');
  assert.strictEqual(fmtMove('pass'), '过');
});

test('currentActors：叫分/出牌一个人，局末空（下一局人来点），收盘空', () => {
  const fresh = createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], seed: 'actors' });
  assert.deepStrictEqual(currentActors(fresh), [fresh.current]);
  let g = mk({ a: ['S9'], b: ['S10'], c: ['S11'] }, { current: 'a' });
  assert.deepStrictEqual(currentActors(g), ['a']);
  g = play(g, 'a', ['S9']);
  assert.deepStrictEqual(currentActors(g), []); // round_over 不列人,防自动 AI烧CLI抢next_round
  g = apply(g, 'a', { type: 'end_match' }).state;
  assert.deepStrictEqual(currentActors(g), []);
});

// ------------------------------------------------------------------ 随机压测

/** 测试自己的随机源，跟引擎 RNG 无关 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('随机压测：三个假人随机合法动作打满 50 局，不 throw、不死锁、54 张守恒', () => {
  const rnd = mulberry32(20260819);
  let g = createGame({
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    seed: 'stress'
  });
  let rounds = 0;
  let steps = 0;
  let bombSeen = 0;
  let redeals = 0;
  const typesSeen = new Set();

  while (rounds < 50) {
    steps += 1;
    assert.ok(steps < 200000, '步数爆表，八成是死循环了');
    assertConservation(g, `第 ${rounds + 1} 局第 ${steps} 步`);

    if (g.phase === 'round_over') {
      rounds += 1;
      const res = g.lastResults;
      assert.strictEqual(res.length, 3);
      assert.strictEqual(res.reduce((n, r) => n + r.delta, 0), 0, '每局结算必须零和');
      assert.ok(g.players.some((p) => p.hand.length === 0), '一定有人把牌出完了');
      if (rounds >= 50) break;
      g = apply(g, g.players[0].id, { type: 'next_round' }).state;
      continue;
    }

    const actors = currentActors(g);
    assert.ok(actors.length > 0, `phase=${g.phase} 却没人欠动作`);
    const who = actors[0];
    const moves = legalMoves(g, who);
    assert.ok(moves.length > 0, `phase=${g.phase} 的 ${who} 一条合法招都没有`);
    const mv = moves[Math.floor(rnd() * moves.length)];
    if (mv.type === 'play') {
      typesSeen.add(mv.combo.type);
      if (mv.combo.type === 'bomb' || mv.combo.type === 'rocket') bombSeen += 1;
    }
    const before = g;
    g = apply(g, who, mv).state;
    assert.ok(g.seq > before.seq, 'seq 必须往前走');
    assert.notStrictEqual(g, before, 'apply 必须返回新 state');
    if (g.phase === 'bidding' && before.phase === 'bidding' && g.bids.length === 0 && before.bids.length === 2) {
      redeals += 1;
    }
  }

  assert.strictEqual(rounds, 50);
  assert.strictEqual(g.rounds.length, 50, '50 局的战绩都记下来了');
  assert.strictEqual(g.players.reduce((n, p) => n + p.score, 0), 0, '总分零和');
  assert.ok(bombSeen > 0, '50 局里总该炸过几回');
  assert.ok(typesSeen.size >= 8, `牌型覆盖太少：${[...typesSeen].join(',')}`);
  assert.ok(redeals >= 0);

  // 收盘也得干净
  g = apply(g, 'a', { type: 'end_match' }).state;
  assert.strictEqual(g.phase, 'game_over');
  assert.deepStrictEqual(currentActors(g), []);
});

test('随机压测：换个种子再跑 10 局，viewFor/briefing 全程不炸', () => {
  const rnd = mulberry32(913);
  let g = createGame({
    players: [{ id: 'a', name: '小明' }, { id: 'b', name: '小红' }, { id: 'c', name: '小刚' }],
    seed: 'stress-2',
    rules: { allow_four_two: false }
  });
  let rounds = 0;
  let steps = 0;
  while (rounds < 10) {
    steps += 1;
    assert.ok(steps < 100000, '步数爆表');
    for (const pid of ['a', 'b', 'c', null]) {
      const v = viewFor(g, pid);
      assert.strictEqual(v.players.length, 3);
      assert.ok(typeof briefing(g, pid) === 'string');
    }
    if (g.phase === 'round_over') {
      rounds += 1;
      if (rounds >= 10) break;
      g = apply(g, 'a', { type: 'next_round' }).state;
      continue;
    }
    const who = currentActors(g)[0];
    const moves = legalMoves(g, who);
    assert.ok(moves.every((m) => typeof fmtMove(m) === 'string' && fmtMove(m).length > 0));
    // 四带二关着，任何一条合法招都不该是四带二
    assert.ok(!moves.some((m) => m.type === 'play'
      && (m.combo.type === 'four_two_single' || m.combo.type === 'four_two_pair')));
    g = apply(g, who, moves[Math.floor(rnd() * moves.length)]).state;
  }
  assert.strictEqual(rounds, 10);
});
