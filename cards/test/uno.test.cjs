'use strict';
/**
 * cards/engines/uno.cjs 单测（docs/design-cards.md §1 引擎契约 + §2 uno 规则 + 随机压测）
 * 跑：node --test test/uno.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert');
const engine = require('../engines/uno.cjs');

const {
  meta, createGame, apply, legalMoves, viewFor, currentActors, briefing, fmtMove,
  parseCard, cardLabel, cardPoints, handPoints, sortCards,
  ALL_CARDS, createRngState, rngNext
} = engine;

// ------------------------------------------------------------------ fixtures

const NAMES = { a: 'A', b: 'B', c: 'C', d: 'D' };

function P(g, id) {
  return g.players.find((p) => p.id === id);
}

/** 牌张守恒：牌库 + 弃堆 + 所有手牌 === 108 */
function totalCards(g) {
  return g.deck.length + g.discard.length + g.players.reduce((n, p) => n + p.hand.length, 0);
}

/**
 * 造一个摆好的局面：
 *   hands     —— {a:[...], b:[...]}（顺序即座位顺序）
 *   top       —— 弃堆顶牌
 *   color     —— 当前生效颜色（默认取顶牌颜色；顶牌是万能牌时必填）
 *   current   —— 该谁动（默认第一个）
 *   dir       —— 方向（默认 1）
 *   drawStack —— 被 +2 指着的累计张数
 *   nextDraws —— 强制接下来摸到的牌（按摸的先后写）
 *   rules     —— 规则开关
 * 没进手牌/顶牌/nextDraws 的牌全塞牌库，守恒随时可查。
 */
function mk(spec) {
  const ids = Object.keys(spec.hands);
  const g = createGame({
    players: ids.map((id) => ({ id, name: NAMES[id] || id })),
    seed: spec.seed || 'fixture',
    rules: spec.rules || {}
  });
  const used = Object.create(null);
  const claim = (id) => {
    assert.ok(ALL_CARDS.indexOf(id) >= 0, `fixture 用了不存在的牌：${id}`);
    assert.ok(!used[id], `fixture 重复用牌：${id}`);
    used[id] = true;
  };
  for (const id of ids) {
    for (const c of spec.hands[id]) claim(c);
    P(g, id).hand = sortCards(spec.hands[id]);
  }
  claim(spec.top);
  const draws = (spec.nextDraws || []).slice();
  for (const c of draws) claim(c);

  g.discard = [spec.top];
  g.activeColor = spec.color || parseCard(spec.top).color;
  assert.ok(g.activeColor, 'fixture 顶牌是万能牌，必须显式给 color');
  // 牌库末尾是顶张：nextDraws 倒着贴到末尾，第一张最先被摸到
  g.deck = ALL_CARDS.filter((c) => !used[c]).concat(draws.slice().reverse());
  g.dir = spec.dir || 1;
  g.current = spec.current || ids[0];
  g.leader = spec.leader || g.current;
  g.pending = null;
  g.drawStack = spec.drawStack || 0;
  g.phase = 'playing';
  g.round = 1;
  g.log = [];
  g.rounds = [];
  g.lastResults = null;
  assert.equal(totalCards(g), 108, 'fixture 自己就不守恒');
  return g;
}

function play(g, who, card, color) {
  const act = { type: 'play', card };
  if (color) act.color = color;
  return apply(g, who, act).state;
}

function draw(g, who) {
  return apply(g, who, { type: 'draw' }).state;
}

function keep(g, who) {
  return apply(g, who, { type: 'keep' }).state;
}

function moveKeys(g, who) {
  return legalMoves(g, who).map((m) => m.type + (m.card ? ':' + m.card : '') + (m.color ? ':' + m.color : ''));
}

// ------------------------------------------------------------------ meta / 牌组

test('meta：契约字段一字不差', () => {
  assert.equal(meta.key, 'uno');
  assert.equal(meta.name, 'UNO');
  assert.equal(meta.minPlayers, 2);
  assert.equal(meta.maxPlayers, 4);
  assert.deepEqual(meta.defaultRules, { stack_draw2: false });
  assert.deepEqual(meta.ruleMeta, [
    { key: 'stack_draw2', label: '+2 叠加', note: '被 +2 时可再出 +2 转嫁下家', def: false }
  ]);
});

test('牌组：108 张，id 全局唯一，组成合规', () => {
  assert.equal(ALL_CARDS.length, 108);
  assert.equal(new Set(ALL_CARDS).size, 108, 'id 撞车了');
  const count = (pred) => ALL_CARDS.filter((id) => pred(parseCard(id))).length;
  for (const col of ['R', 'G', 'B', 'Y']) {
    assert.equal(count((c) => c.color === col), 25, `${col} 色应该 25 张`);
    assert.equal(count((c) => c.color === col && c.num === 0), 1, `${col}0 只有 1 张`);
    for (let n = 1; n <= 9; n++) {
      assert.equal(count((c) => c.color === col && c.num === n), 2, `${col}${n} 该 2 张`);
    }
    for (const k of ['skip', 'rev', 'draw2']) {
      assert.equal(count((c) => c.color === col && c.kind === k), 2, `${col} ${k} 该 2 张`);
    }
  }
  assert.equal(count((c) => c.kind === 'wild'), 4);
  assert.equal(count((c) => c.kind === 'wild4'), 4);
  // id 命名约定
  for (const id of ['R5#1', 'R5#2', 'RS#1', 'RR#1', 'RD#1', 'W#1', 'WD#1', 'R0#1']) {
    assert.ok(ALL_CARDS.indexOf(id) >= 0, `缺 id ${id}`);
  }
  assert.equal(ALL_CARDS.indexOf('R0#2'), -1, '0 不该有第二张');
  assert.equal(parseCard('R5#3'), null, '不存在的 id 该返回 null');
  assert.equal(parseCard('Z1#1'), null);
  assert.equal(parseCard('R5'), null);
});

test('牌面：解析 / 人话 / 分值', () => {
  const rows = [
    ['R5#2', { color: 'R', kind: 'num', num: 5, points: 5 }, '红5'],
    ['G0#1', { color: 'G', kind: 'num', num: 0, points: 0 }, '绿0'],
    ['BS#1', { color: 'B', kind: 'skip', points: 20 }, '蓝跳过'],
    ['YR#2', { color: 'Y', kind: 'rev', points: 20 }, '黄反转'],
    ['BD#1', { color: 'B', kind: 'draw2', points: 20 }, '蓝+2'],
    ['W#3', { color: null, kind: 'wild', points: 50 }, '万能'],
    ['WD#2', { color: null, kind: 'wild4', points: 50 }, '万能+4']
  ];
  for (const [id, want, label] of rows) {
    const c = parseCard(id);
    for (const k of Object.keys(want)) assert.equal(c[k], want[k], `${id}.${k}`);
    assert.equal(cardLabel(id), label);
    assert.equal(cardPoints(id), want.points);
  }
  assert.equal(handPoints(['R5#1', 'BS#1', 'W#1', 'G0#1']), 5 + 20 + 50 + 0);
  assert.equal(handPoints([]), 0);
  // 全副牌总分：数字 360 + 功能 480 + 万能 400
  assert.equal(handPoints(ALL_CARDS), 1240);
});

test('排序：红绿蓝黄 → 万能，同色 数字 → 跳过 → 反转 → +2', () => {
  const got = sortCards(['W#1', 'RD#1', 'YS#1', 'R0#1', 'WD#1', 'B3#1', 'RS#1', 'R9#2', 'RR#1', 'G1#1']);
  assert.deepEqual(got, ['R0#1', 'R9#2', 'RS#1', 'RR#1', 'RD#1', 'G1#1', 'B3#1', 'YS#1', 'W#1', 'WD#1']);
});

// ------------------------------------------------------------------ createGame

test('createGame：人数闸 / 每人 7 张 / 开局牌不是万能 / 守恒 108', () => {
  assert.throws(() => createGame({ players: [{ id: 'a' }] }), /2~4 人/);
  assert.throws(() => createGame({ players: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })) }), /2~4 人/);
  assert.throws(() => createGame({ players: [{ id: 'a' }, { id: 'a' }] }), /id 重复/);

  for (let n = 2; n <= 4; n++) {
    for (let k = 0; k < 40; k++) {
      const ids = ['a', 'b', 'c', 'd'].slice(0, n);
      const g = createGame({ players: ids.map((id) => ({ id, name: NAMES[id] })), seed: `cg-${n}-${k}` });
      assert.equal(g.phase, 'playing');
      assert.equal(g.round, 1);
      assert.equal(g.players.length, n);
      assert.equal(g.discard.length, 1, '弃堆只有开局那张');
      assert.ok(!parseCard(g.discard[0]).wild, '开局牌不能是万能牌');
      // 每人 7 张；开局翻出 +2 时首家还得多摸 2 张
      const bonus = parseCard(g.discard[0]).kind === 'draw2' ? 2 : 0;
      for (const p of g.players) {
        assert.equal(p.hand.length, p.id === g.leader ? 7 + bonus : 7, '每人 7 张');
      }
      assert.equal(g.deck.length, 108 - 7 * n - 1 - bonus);
      assert.equal(totalCards(g), 108);
      assert.equal(g.activeColor, parseCard(g.discard[0]).color);
      assert.ok(g.turnOrder.indexOf(g.current) >= 0);
      assert.equal(currentActors(g).length, 1);
      assert.equal(typeof g.rngState[0], 'number');
      assert.equal(g.rules.stack_draw2, false, '开关默认关');
    }
  }
  // 脏开关不进 state
  const g2 = createGame({ players: [{ id: 'a' }, { id: 'b' }], rules: { stack_draw2: true, 乱来: 1 } });
  assert.deepEqual(Object.keys(g2.rules), ['stack_draw2']);
  assert.equal(g2.rules.stack_draw2, true);
});

test('createGame：规则开关四种塞法都认（server.cjs 是平着塞 config 的）', () => {
  const ps = [{ id: 'a' }, { id: 'b' }];
  const shapes = [
    { config: { stack_draw2: true } },
    { config: { defaults: { stack_draw2: true } } },
    { config: { rules: { stack_draw2: true } } },
    { rules: { stack_draw2: true } }
  ];
  for (const extra of shapes) {
    const g = createGame(Object.assign({ players: ps, seed: 'rules' }, extra));
    assert.equal(g.rules.stack_draw2, true, `这种塞法没读到：${JSON.stringify(extra)}`);
  }
  assert.equal(createGame({ players: ps, seed: 'rules' }).rules.stack_draw2, false);
});

test('createGame：同 seed 完全可复现，不同 seed 不一样', () => {
  const mkg = (seed) => createGame({
    players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], seed
  });
  const g1 = mkg('same'), g2 = mkg('same'), g3 = mkg('other');
  assert.deepEqual(g1.players.map((p) => p.hand), g2.players.map((p) => p.hand));
  assert.deepEqual(g1.deck, g2.deck);
  assert.equal(g1.discard[0], g2.discard[0]);
  assert.notDeepEqual(g1.players.map((p) => p.hand), g3.players.map((p) => p.hand));
});

test('开局翻牌：功能牌对首家生效（Skip 跳首家 / Reverse 反向 / +2 首家摸2跳过）', () => {
  const seen = Object.create(null);
  for (let n = 2; n <= 4; n++) {
    const ids = ['a', 'b', 'c', 'd'].slice(0, n);
    for (let k = 0; k < 400; k++) {
      const g = createGame({ players: ids.map((id) => ({ id, name: NAMES[id] })), seed: `flip-${n}-${k}` });
      const c = parseCard(g.discard[0]);
      const order = g.turnOrder;
      const L = order.indexOf(g.leader);
      const at = (off) => order[((L + off) % n + n) % n];
      seen[n + ':' + c.kind] = (seen[n + ':' + c.kind] || 0) + 1;
      if (c.kind === 'num') {
        assert.equal(g.current, g.leader, '数字开局牌：首家直接开打');
        assert.equal(g.dir, 1);
        assert.equal(P(g, g.leader).hand.length, 7);
      } else if (c.kind === 'skip') {
        assert.equal(g.current, at(1), 'Skip 开局：首家被跳过');
        assert.equal(g.dir, 1);
        assert.equal(P(g, g.leader).hand.length, 7);
      } else if (c.kind === 'rev') {
        assert.equal(g.dir, -1, 'Reverse 开局：方向反转');
        // 视为庄家（首家上家）打出：2 人局当 Skip（庄家自己接着走），多人局从庄家往新方向数一个
        assert.equal(g.current, n === 2 ? at(-1) : at(-2));
      } else if (c.kind === 'draw2') {
        assert.equal(P(g, g.leader).hand.length, 9, '+2 开局：首家摸 2 张');
        assert.equal(g.current, at(1), '+2 开局：首家被跳过');
      } else {
        assert.fail('开局牌不该是 ' + c.kind);
      }
      assert.equal(totalCards(g), 108);
    }
  }
  for (const n of [2, 3, 4]) {
    for (const k of ['num', 'skip', 'rev', 'draw2']) {
      assert.ok(seen[n + ':' + k] > 0, `${n} 人局没扫到开局翻出 ${k} 的样本`);
    }
  }
});

// ------------------------------------------------------------------ 出牌合法性

test('出牌合法性：表驱动（同色 / 同值 / 万能 / W+4 限制）', () => {
  const rows = [
    // [说明, 顶牌, 当前色, 手牌, 要出的牌, 合法?]
    ['同色数字', 'R3#1', 'R', ['R7#1'], 'R7#1', true],
    ['同值不同色', 'R3#1', 'R', ['G3#1'], 'G3#1', true],
    ['同色功能牌', 'R3#1', 'R', ['RS#1'], 'RS#1', true],
    ['跳过配跳过', 'RS#1', 'R', ['GS#1'], 'GS#1', true],
    ['反转配反转', 'RR#1', 'R', ['BR#1'], 'BR#1', true],
    ['+2 配 +2（不同色）', 'RD#1', 'R', ['BD#1'], 'BD#1', true],
    ['万能牌随便出', 'R3#1', 'R', ['W#1', 'R5#1'], 'W#1', true],
    ['颜色不对值也不对', 'R3#1', 'R', ['G7#1'], 'G7#1', false],
    ['数字对不上功能牌', 'RS#1', 'R', ['G3#1'], 'G3#1', false],
    ['功能牌种类不同', 'RS#1', 'R', ['GR#1'], 'GR#1', false],
    ['顶牌是万能：跟指定色', 'W#1', 'G', ['G5#1'], 'G5#1', true],
    ['顶牌是万能：别的色不行', 'W#1', 'G', ['B5#1'], 'B5#1', false],
    ['W+4：手上没当前色 → 能出', 'R3#1', 'R', ['WD#1', 'G5#1'], 'WD#1', true],
    ['W+4：手上还有当前色 → 不能出', 'R3#1', 'R', ['WD#1', 'R9#1'], 'WD#1', false],
    ['W+4：手上有别色和万能不影响', 'R3#1', 'R', ['WD#1', 'W#1', 'B2#1'], 'WD#1', true],
    ['W+4：当前色由万能指定后照样算', 'W#2', 'B', ['WD#1', 'B2#1'], 'WD#1', false]
  ];
  for (const [why, top, color, hand, card, ok] of rows) {
    const g = mk({ hands: { a: hand, b: ['Y8#1', 'Y8#2'] }, top, color });
    const err = engine.playError(g, P(g, 'a'), card);
    if (ok) {
      assert.equal(err, null, `${why}：本该能出，却说「${err}」`);
      assert.ok(moveKeys(g, 'a').some((k) => k.indexOf('play:' + card) === 0), `${why}：legalMoves 里没列出来`);
      assert.doesNotThrow(() => play(g, 'a', card, 'G'));
    } else {
      assert.ok(err && typeof err === 'string', `${why}：本该被拦，却放行了`);
      assert.ok(!moveKeys(g, 'a').some((k) => k.indexOf('play:' + card) === 0), `${why}：legalMoves 不该列它`);
      assert.throws(() => play(g, 'a', card, 'G'), /./, why);
    }
  }
});

test('出牌：手里没有的牌 / 不认识的 id / 万能牌不给颜色 都 throw 中文', () => {
  const g = mk({ hands: { a: ['R5#1', 'W#1'], b: ['Y8#1'] }, top: 'R3#1' });
  assert.throws(() => play(g, 'a', 'R9#2'), /你手里没有/);
  assert.throws(() => play(g, 'a', 'R5#9'), /不认识这张牌/);
  assert.throws(() => play(g, 'a', 'W#1'), /必须指定颜色/);
  assert.throws(() => play(g, 'a', 'W#1', 'X'), /必须指定颜色/);
  assert.throws(() => play(g, 'b', 'Y8#1'), /还没轮到你/);
  assert.throws(() => apply(g, 'a', { type: 'play' }), /要出哪张牌/);
  assert.throws(() => apply(g, 'zz', { type: 'draw' }), /查无此人/);
  assert.throws(() => apply(g, 'a', { type: '乱来' }), /未知动作/);
});

test('出万能牌：指定色成为当前生效颜色', () => {
  let g = mk({ hands: { a: ['W#1', 'R5#1'], b: ['Y8#1'] }, top: 'R3#1' });
  g = play(g, 'a', 'W#1', 'B');
  assert.equal(g.activeColor, 'B');
  assert.equal(g.discard[g.discard.length - 1], 'W#1');
  // 万能牌指定蓝之后，黄8 接不上（万能牌不参与同值匹配）
  assert.ok(engine.playError(g, P(g, 'b'), 'Y8#1'));
  assert.deepEqual(moveKeys(g, 'b'), ['draw']);
});

// ------------------------------------------------------------------ 回合推进矩阵

test('回合推进矩阵：2/3/4 人 × 正反方向 × 数字/Skip/Reverse/+2/W+4', () => {
  const FILL = { b: 'Y1#1', c: 'Y2#1', d: 'Y3#1' };
  const cases = [
    { kind: '数字', card: 'R7#1', step: 1, drawn: 0 },
    { kind: 'Skip', card: 'RS#1', step: 2, drawn: 0 },
    { kind: 'Reverse', card: 'RR#1', step: 1, flip: true, drawn: 0 },
    { kind: '+2', card: 'RD#1', step: 2, drawn: 2 },
    { kind: 'W+4', card: 'WD#1', step: 2, drawn: 4 }
  ];
  for (let n = 2; n <= 4; n++) {
    const ids = ['a', 'b', 'c', 'd'].slice(0, n);
    for (const dir of [1, -1]) {
      for (const cs of cases) {
        const hands = { a: [cs.card, 'G0#1'] };
        for (const id of ids.slice(1)) hands[id] = [FILL[id]];
        const g0 = mk({ hands, top: 'R3#1', color: 'R', dir, current: 'a' });
        const g = play(g0, 'a', cs.card, 'G');
        const why = `${n} 人 dir=${dir} ${cs.kind}`;

        // 期望座位（独立算一遍，不复用引擎的 seatAt）
        const nd = cs.flip ? -dir : dir;
        let want;
        if (cs.flip) want = ids[(((n === 2 ? 2 * nd : nd) % n) + n) % n];
        else want = ids[(((cs.step * dir) % n) + n) % n];
        assert.equal(g.current, want, `${why}：轮到谁算错了`);
        assert.equal(g.dir, cs.flip ? -dir : dir, `${why}：方向算错了`);

        // 受害者摸牌
        const victim = ids[(((dir % n) + n) % n)];
        for (const id of ids.slice(1)) {
          const base = 1;
          const want2 = (id === victim ? base + cs.drawn : base);
          assert.equal(P(g, id).hand.length, want2, `${why}：${id} 手牌张数不对`);
        }
        assert.equal(P(g, 'a').hand.length, 1, `${why}：出牌人手牌没减`);
        assert.equal(totalCards(g), 108, `${why}：牌不守恒`);
        assert.equal(g.phase, 'playing');
        assert.deepEqual(currentActors(g), [want]);
      }
    }
  }
});

test('2 人局：Reverse 等于 Skip（自己接着出），Skip 也是自己接着出', () => {
  let g = mk({ hands: { a: ['RR#1', 'RR#2', 'RS#1', 'R5#1'], b: ['Y8#1'] }, top: 'R3#1' });
  g = play(g, 'a', 'RR#1');
  assert.equal(g.current, 'a', '2 人局反转 = 跳过，还是我出');
  assert.equal(g.dir, -1);
  g = play(g, 'a', 'RR#2');
  assert.equal(g.current, 'a', '再反一次还是我');
  assert.equal(g.dir, 1);
  g = play(g, 'a', 'RS#1');
  assert.equal(g.current, 'a', '2 人局 Skip 也是我接着出');
  assert.equal(P(g, 'b').hand.length, 1, 'b 一张都没摸');
});

test('4 人局：Reverse 后连着走，方向真的反了', () => {
  let g = mk({
    hands: { a: ['RR#1', 'G0#1'], b: ['R1#1', 'G1#1'], c: ['R2#1', 'G2#1'], d: ['R4#1', 'G4#1'] },
    top: 'R3#1'
  });
  g = play(g, 'a', 'RR#1');
  assert.equal(g.current, 'd');
  g = play(g, 'd', 'R4#1');
  assert.equal(g.current, 'c');
  g = play(g, 'c', 'R2#1');
  assert.equal(g.current, 'b');
  g = play(g, 'b', 'R1#1');
  assert.equal(g.current, 'a');
});

// ------------------------------------------------------------------ 摸牌 pending 流

test('摸牌 pending：摸到能出的牌 → 只能出这张或 keep', () => {
  let g = mk({ hands: { a: ['G7#1'], b: ['Y8#1'], c: ['Y9#1'] }, top: 'R3#1', nextDraws: ['R8#1'] });
  assert.deepEqual(moveKeys(g, 'a'), ['draw'], '手上出不了，只能摸');
  g = draw(g, 'a');
  assert.ok(g.pending, '该进 pending 态');
  assert.equal(g.pending.playerId, 'a');
  assert.equal(g.pending.card, 'R8#1');
  assert.equal(g.current, 'a', 'pending 时回合还在自己手上');
  assert.deepEqual(currentActors(g), ['a']);
  assert.deepEqual(moveKeys(g, 'a'), ['play:R8#1', 'keep']);
  assert.throws(() => draw(g, 'a'), /刚摸了一张/, '不能连摸两张');
  assert.throws(() => play(g, 'a', 'G7#1'), /只能出/, 'pending 里不能出别的牌');
  assert.throws(() => keep(g, 'b'), /没有刚摸的牌/);

  const g2 = play(g, 'a', 'R8#1');
  assert.equal(g2.pending, null);
  assert.equal(g2.current, 'b');
  assert.equal(P(g2, 'a').hand.length, 1);
  assert.equal(g2.discard[g2.discard.length - 1], 'R8#1');
  assert.equal(totalCards(g2), 108);
});

test('摸牌 pending：keep 结束回合', () => {
  let g = mk({ hands: { a: ['G7#1'], b: ['Y8#1'], c: ['Y9#1'] }, top: 'R3#1', nextDraws: ['R8#1'] });
  g = draw(g, 'a');
  g = keep(g, 'a');
  assert.equal(g.pending, null);
  assert.equal(g.current, 'b');
  assert.equal(P(g, 'a').hand.length, 2, '摸到的牌留手里');
  assert.ok(P(g, 'a').hand.indexOf('R8#1') >= 0);
  assert.equal(totalCards(g), 108);
});

test('摸牌：摸到出不了的牌，回合自动结束（不用 keep）', () => {
  let g = mk({ hands: { a: ['G7#1'], b: ['Y8#1'], c: ['Y9#1'] }, top: 'R3#1', nextDraws: ['B8#1'] });
  g = draw(g, 'a');
  assert.equal(g.pending, null, '出不了就别摆 pending');
  assert.equal(g.current, 'b', '直接过给下家');
  assert.equal(P(g, 'a').hand.length, 2);
  assert.throws(() => keep(g, 'a'), /没有刚摸的牌/);
  assert.deepEqual(moveKeys(g, 'a'), [], '不轮到他就没招');
});

test('摸牌 pending：摸到万能牌按 4 色展开', () => {
  let g = mk({ hands: { a: ['G7#1'], b: ['Y8#1'] }, top: 'R3#1', nextDraws: ['W#1'] });
  g = draw(g, 'a');
  assert.deepEqual(moveKeys(g, 'a'), ['play:W#1:R', 'play:W#1:G', 'play:W#1:B', 'play:W#1:Y', 'keep']);
  const g2 = play(g, 'a', 'W#1', 'Y');
  assert.equal(g2.activeColor, 'Y');
});

test('摸牌：牌库+弃堆榨干时摸不到，直接过（不死锁）', () => {
  const g = mk({ hands: { a: ['G7#1'], b: ['Y8#1'] }, top: 'R3#1' });
  // 把牌库塞进弃堆下层再抽干：只留顶牌
  const rest = g.deck.slice();
  g.deck = [];
  g.discard = ['R3#1'];
  P(g, 'a').hand = P(g, 'a').hand.concat(rest.slice(0, rest.length));
  assert.equal(totalCards(g), 108);
  assert.deepEqual(moveKeys(g, 'a').slice(-1), ['draw'], '摸不到也得留着 draw 这条路');
  const g2 = draw(g, 'a');
  assert.equal(g2.current, 'b');
  assert.equal(totalCards(g2), 108);
});

// ------------------------------------------------------------------ 弃堆重洗

test('弃堆重洗：留顶牌，其余洗回牌库，108 张守恒', () => {
  const g = mk({ hands: { a: ['R5#1'], b: ['G5#1'] }, top: 'B1#1', rules: { stack_draw2: true } });
  const rest = g.deck.slice();
  g.deck = rest.slice(0, 1);                       // 牌库只剩 1 张
  g.discard = rest.slice(1).concat(['B1#1']);      // 其余全在弃堆，B1#1 是顶牌
  g.drawStack = 6;                                 // a 手上没 +2，只能摸 6 张
  assert.equal(totalCards(g), 108);
  assert.deepEqual(moveKeys(g, 'a'), ['draw']);
  assert.equal(fmtMove(legalMoves(g, 'a')[0]), '摸 6 张');

  const g2 = draw(g, 'a');
  assert.equal(P(g2, 'a').hand.length, 7, '摸满 6 张');
  assert.equal(g2.discard.length, 1, '弃堆洗完只剩顶牌');
  assert.equal(g2.discard[0], 'B1#1', '顶牌必须留着');
  assert.equal(g2.deck.length, 108 - 7 - 1 - 1);
  assert.equal(totalCards(g2), 108);
  assert.ok(g2.log.some((l) => l.type === 'reshuffle'), '该有洗牌日志');
  assert.equal(g2.drawStack, 0);
  assert.equal(g2.current, 'b', '摸完累计牌要跳过');
});

// ------------------------------------------------------------------ stack_draw2

test('stack_draw2 关：+2 下家直接摸 2 并跳过', () => {
  let g = mk({
    hands: { a: ['RD#1', 'G0#1'], b: ['BD#1', 'Y8#1'], c: ['Y9#1'] },
    top: 'R3#1', rules: { stack_draw2: false }
  });
  g = play(g, 'a', 'RD#1');
  assert.equal(g.drawStack, 0, '不叠加就别攒');
  assert.equal(P(g, 'b').hand.length, 4, 'b 摸 2 张');
  assert.equal(g.current, 'c', 'b 被跳过');
  assert.equal(totalCards(g), 108);
});

test('stack_draw2 开：能接 +2 转嫁，接不住就摸累计', () => {
  let g = mk({
    hands: { a: ['RD#1', 'G0#1'], b: ['BD#1', 'Y8#1'], c: ['Y9#1', 'G1#1'] },
    top: 'R3#1', rules: { stack_draw2: true }
  });
  g = play(g, 'a', 'RD#1');
  assert.equal(g.drawStack, 2);
  assert.equal(g.current, 'b', '被指着的人还得动一手');
  assert.equal(P(g, 'b').hand.length, 2, '还没摸牌');
  // 被 +2 指着时只能接 +2（任意颜色）或摸
  assert.deepEqual(moveKeys(g, 'b'), ['play:BD#1', 'draw']);
  assert.ok(engine.playError(g, P(g, 'b'), 'Y8#1').indexOf('+2') >= 0);

  g = play(g, 'b', 'BD#1');
  assert.equal(g.drawStack, 4, '累加到 4');
  assert.equal(g.current, 'c');
  assert.deepEqual(moveKeys(g, 'c'), ['draw']);
  assert.equal(fmtMove(legalMoves(g, 'c')[0]), '摸 4 张');

  g = draw(g, 'c');
  assert.equal(P(g, 'c').hand.length, 6, 'c 摸 4 张');
  assert.equal(g.drawStack, 0);
  assert.equal(g.current, 'a', 'c 摸完被跳过');
  assert.equal(totalCards(g), 108);
});

test('stack_draw2 开：万能+4 挡不住 +2，被指着时也不能出别的', () => {
  const g = mk({
    hands: { a: ['R5#1'], b: ['WD#1', 'W#1', 'G3#1'] },
    top: 'R3#1', drawStack: 2, current: 'b', rules: { stack_draw2: true }
  });
  assert.ok(engine.playError(g, P(g, 'b'), 'WD#1').indexOf('+2') >= 0);
  assert.ok(engine.playError(g, P(g, 'b'), 'W#1'));
  assert.deepEqual(moveKeys(g, 'b'), ['draw']);
  assert.throws(() => play(g, 'b', 'WD#1', 'G'), /\+2/);
});

// ------------------------------------------------------------------ 结算 / 计分

test('计分：赢家收其余玩家手牌分（数字面值 / 功能 20 / 万能 50）', () => {
  let g = mk({
    hands: { a: ['R5#1'], b: ['G9#1', 'GS#1', 'W#1'], c: ['Y0#1'] },
    top: 'R3#1'
  });
  g = play(g, 'a', 'R5#1');
  assert.equal(g.phase, 'round_over');
  assert.equal(g.current, null);
  assert.deepEqual(currentActors(g), [], 'round_over 不欠动作');
  assert.equal(P(g, 'a').score, 9 + 20 + 50 + 0);
  assert.equal(P(g, 'b').score, 0);
  assert.equal(P(g, 'c').score, 0);
  assert.equal(g.lastResults.winner, 'a');
  assert.equal(g.lastResults.gain, 79);
  assert.equal(g.rounds.length, 1);
  const rowB = g.lastResults.players.find((x) => x.playerId === 'b');
  assert.equal(rowB.handPoints, 79);
  assert.equal(rowB.handCount, 3);
  assert.equal(totalCards(g), 108);
  assert.deepEqual(legalMoves(g, 'b'), [{ type: 'next_round', label: '开下一局' }]);
});

test('收尾是 +2 / W+4：下家照样摸，那几张算进他的手牌分', () => {
  // 收尾 +2：b 摸到 黄0 + 黄1 = 1 分，加原有 绿9 = 10 分
  let g = mk({
    hands: { a: ['RD#1'], b: ['G9#1'] },
    top: 'R3#1', nextDraws: ['Y0#1', 'Y1#1']
  });
  g = play(g, 'a', 'RD#1');
  assert.equal(g.phase, 'round_over');
  assert.equal(P(g, 'b').hand.length, 3);
  assert.equal(P(g, 'a').score, 9 + 0 + 1);
  assert.equal(totalCards(g), 108);

  // 收尾 W+4
  let h = mk({
    hands: { a: ['WD#1'], b: ['G9#1'] },
    top: 'R3#1', nextDraws: ['Y0#1', 'Y1#1', 'Y2#1', 'Y3#1']
  });
  h = play(h, 'a', 'WD#1', 'B');
  assert.equal(h.phase, 'round_over');
  assert.equal(P(h, 'b').hand.length, 5);
  assert.equal(P(h, 'a').score, 9 + 0 + 1 + 2 + 3);
  assert.equal(totalCards(h), 108);
});

test('stack 开：收尾的 +2 把累计张数全砸给下家', () => {
  let g = mk({
    hands: { a: ['RD#1'], b: ['G9#1'] },
    top: 'R3#1', drawStack: 2, current: 'a',
    nextDraws: ['Y0#1', 'Y1#1', 'Y2#1', 'Y3#1'],
    rules: { stack_draw2: true }
  });
  g = play(g, 'a', 'RD#1');
  assert.equal(g.phase, 'round_over');
  assert.equal(g.drawStack, 0);
  assert.equal(P(g, 'b').hand.length, 5, '2+2 全摸掉');
  assert.equal(P(g, 'a').score, 9 + 0 + 1 + 2 + 3);
  assert.equal(totalCards(g), 108);
});

test('next_round：重发 + 首家轮换 + 分数累计；end_match 收摊', () => {
  let g = mk({ hands: { a: ['R5#1'], b: ['G9#1'], c: ['Y0#1'] }, top: 'R3#1', leader: 'a' });
  g = play(g, 'a', 'R5#1');
  const score1 = P(g, 'a').score;
  assert.equal(score1, 9);

  assert.throws(() => play(g, 'b', 'G9#1'), /不是出牌的时候/);
  g = apply(g, 'a', { type: 'next_round' }).state;
  assert.equal(g.phase, 'playing');
  assert.equal(g.round, 2);
  assert.equal(g.leader, 'b', '首家轮换到下一位');
  assert.equal(g.dir, 1, '方向复位');
  assert.equal(g.drawStack, 0);
  assert.equal(g.pending, null);
  for (const p of g.players) assert.equal(p.hand.length, 7);
  assert.equal(P(g, 'a').score, score1, '分数带着走');
  assert.equal(totalCards(g), 108);
  assert.throws(() => apply(g, 'a', { type: 'next_round' }), /还没打完/);

  const h = apply(g, 'a', { type: 'end_match' }).state;
  assert.equal(h.phase, 'game_over');
  assert.equal(h.winner, 'a');
  assert.equal(h.current, null);
  assert.deepEqual(currentActors(h), []);
  assert.deepEqual(legalMoves(h, 'a'), []);
  assert.throws(() => apply(h, 'a', { type: 'draw' }), /整场已经结束/);
});

// ------------------------------------------------------------------ 契约面

test('apply：不改入参，seq 自增，events 带日志', () => {
  const g = mk({ hands: { a: ['R5#1', 'G0#1'], b: ['Y8#1'] }, top: 'R3#1' });
  const before = JSON.stringify(g);
  const r = apply(g, 'a', { type: 'play', card: 'R5#1' });
  assert.equal(JSON.stringify(g), before, 'apply 把入参改了');
  assert.equal(r.state.seq, g.seq + 1);
  assert.ok(r.events.length > 0);
  assert.ok(r.events.every((e) => typeof e.text === 'string' && typeof e.type === 'string'));
  assert.ok(r.state.log.length > g.log.length);
});

test('legalMoves：不轮到他返回 []，round_over 返回 next_round，万能展开 4 条', () => {
  const g = mk({ hands: { a: ['W#1', 'R5#1'], b: ['Y8#1'] }, top: 'R3#1' });
  assert.deepEqual(legalMoves(g, 'b'), []);
  assert.deepEqual(legalMoves(g, '查无此人'), []);
  assert.deepEqual(legalMoves(null, 'a'), []);
  assert.deepEqual(moveKeys(g, 'a'),
    ['play:R5#1', 'play:W#1:R', 'play:W#1:G', 'play:W#1:B', 'play:W#1:Y', 'draw']);
  for (const m of legalMoves(g, 'a')) assert.equal(typeof m.label, 'string');
});

test('currentActors：playing 是 current（含 pending 摸牌者），终局是 []', () => {
  let g = mk({ hands: { a: ['G7#1'], b: ['Y8#1'] }, top: 'R3#1', nextDraws: ['R8#1'] });
  assert.deepEqual(currentActors(g), ['a']);
  g = draw(g, 'a');
  assert.deepEqual(currentActors(g), ['a'], 'pending 时还是他欠一手');
  g = keep(g, 'a');
  assert.deepEqual(currentActors(g), ['b']);
});

test('viewFor：自己手牌全量、他人只有张数、牌库和 rng 不外泄', () => {
  let g = mk({ hands: { a: ['G7#1', 'R5#1'], b: ['Y8#1'] }, top: 'R3#1', nextDraws: ['R8#1'] });
  const v = viewFor(g, 'a');
  assert.equal(v.you, 'a');
  assert.deepEqual(v.players.find((p) => p.id === 'a').hand, sortCards(['G7#1', 'R5#1']));
  assert.equal(v.players.find((p) => p.id === 'b').hand, null);
  assert.equal(v.players.find((p) => p.id === 'b').handCount, 1);
  assert.equal(v.players.find((p) => p.id === 'b').uno, true, '剩 1 张要打 UNO 标');
  assert.equal(v.top, 'R3#1');
  assert.equal(v.topLabel, '红3');
  assert.equal(v.activeColor, 'R');
  assert.equal(v.activeColorName, '红');
  assert.equal(v.dir, 1);
  assert.equal(v.dirLabel, '顺时针');
  assert.equal(v.deckCount, g.deck.length);
  assert.equal(v.drawStack, 0);
  assert.equal(v.pending, null);
  assert.equal(v.deck, undefined, '牌库内容不能外泄');
  assert.equal(v.discard, undefined, '弃堆内容不外泄（只给顶牌）');
  assert.equal(v.rngState, undefined, 'rng 不能外泄');
  assert.ok(JSON.stringify(v).indexOf(g.deck[0]) < 0 || g.deck.indexOf('R3#1') >= 0);

  // 观战视角：谁的手牌都看不到
  const w = viewFor(g, null);
  assert.equal(w.you, null);
  assert.ok(w.players.every((p) => p.hand === null));

  // pending 的那张牌只有本人看得见
  g = draw(g, 'a');
  assert.equal(viewFor(g, 'a').pending.card, 'R8#1');
  assert.equal(viewFor(g, 'a').pending.mine, true);
  assert.equal(viewFor(g, 'b').pending.card, null);
  assert.equal(viewFor(g, 'b').pending.playerId, 'a');
  assert.equal(viewFor(g, 'b').pending.mine, false);
});

test('briefing：手牌按颜色排好，顶牌/颜色/方向/各家张数/UNO 警报都在', () => {
  const g = mk({
    hands: { a: ['R5#1', 'RS#1', 'B2#1', 'W#1'], b: ['Y8#1'], c: ['G1#1', 'G2#1'] },
    top: 'R3#1', dir: -1
  });
  const s = briefing(g, 'a');
  assert.ok(s.indexOf('红5 红跳过 | 蓝2 | 万能') >= 0, '手牌没按颜色排：' + s);
  assert.ok(s.indexOf('红3') >= 0, '没写顶牌');
  assert.ok(s.indexOf('当前颜色红') >= 0);
  assert.ok(s.indexOf('逆时针') >= 0);
  assert.ok(s.indexOf('A 4 张') >= 0 && s.indexOf('B 1 张') >= 0 && s.indexOf('C 2 张') >= 0);
  assert.ok(s.indexOf('UNO 警报') >= 0 && s.indexOf('B') >= 0);
  assert.ok(s.indexOf('轮到你') >= 0);
  assert.ok(s.indexOf('合法') < 0, '简报不该带合法招列表');
  // 别人视角看不到自己手牌行
  assert.ok(briefing(g, 'b').indexOf('黄8') >= 0);
  assert.ok(briefing(g, null).indexOf('你的手牌') < 0);
  // +2 累计 / round_over / game_over 三态都能出话
  const st = mk({ hands: { a: ['R5#1'], b: ['Y8#1'] }, top: 'R3#1', drawStack: 4, rules: { stack_draw2: true } });
  assert.ok(briefing(st, 'a').indexOf('累到 4 张') >= 0);
  let over = mk({ hands: { a: ['R5#1'], b: ['Y8#1'] }, top: 'R3#1' });
  over = play(over, 'a', 'R5#1');
  assert.ok(briefing(over, 'b').indexOf('结束') >= 0);
  const done = apply(over, 'a', { type: 'end_match' }).state;
  assert.ok(briefing(done, 'a').indexOf('整场结束') >= 0);
});

test('fmtMove：人话表', () => {
  assert.equal(fmtMove({ type: 'play', card: 'R5#1' }), '红5');
  assert.equal(fmtMove({ type: 'play', card: 'BD#2' }), '蓝+2');
  assert.equal(fmtMove({ type: 'play', card: 'GS#1' }), '绿跳过');
  assert.equal(fmtMove({ type: 'play', card: 'YR#1' }), '黄反转');
  assert.equal(fmtMove({ type: 'play', card: 'W#1', color: 'G' }), '万能变绿');
  assert.equal(fmtMove({ type: 'play', card: 'WD#1', color: 'B' }), '万能+4变蓝');
  assert.equal(fmtMove({ type: 'draw' }), '摸一张');
  assert.equal(fmtMove({ type: 'draw', count: 4 }), '摸 4 张');
  assert.equal(fmtMove({ type: 'keep' }), '不出，过');
  assert.equal(fmtMove({ type: 'next_round' }), '开下一局');
  assert.equal(fmtMove({ type: 'end_match' }), '结束整场');
  assert.equal(fmtMove('draw'), '摸一张');
  assert.equal(fmtMove(null), '(空)');
});

// ------------------------------------------------------------------ 压测

function stress(n, rules, rounds, seed) {
  const ids = ['a', 'b', 'c', 'd'].slice(0, n);
  let g = createGame({ players: ids.map((id) => ({ id, name: NAMES[id] })), seed, rules });
  let rs = createRngState('bot-' + seed);
  const rnd = (k) => { const [next, v] = rngNext(rs); rs = next; return v % k; };
  let done = 0;
  let steps = 0;
  const seen = Object.create(null);
  while (done < rounds) {
    steps += 1;
    assert.ok(steps < 400000, `n=${n} 步数失控`);
    assert.equal(totalCards(g), 108, `n=${n} 第 ${steps} 步牌不守恒`);
    if (g.phase === 'round_over') {
      done += 1;
      assert.deepEqual(currentActors(g), []);
      assert.deepEqual(legalMoves(g, ids[0]).map((m) => m.type), ['next_round']);
      if (done >= rounds) break;
      g = apply(g, ids[rnd(n)], { type: 'next_round' }).state;
      continue;
    }
    const actors = currentActors(g);
    assert.equal(actors.length, 1, `n=${n} 第 ${steps} 步 currentActors 不对：${JSON.stringify(actors)}`);
    const mv = legalMoves(g, actors[0]);
    assert.ok(mv.length > 0, `n=${n} 第 ${steps} 步死锁 phase=${g.phase}`);
    for (const m of mv) seen[m.type] = (seen[m.type] || 0) + 1;
    // 视图/简报/人话每 20 步抽查一次（每步都查太贵）
    if (steps % 20 === 0) {
      for (const id of ids) if (id !== actors[0]) assert.deepEqual(legalMoves(g, id), [], `${id} 不该有招`);
      assert.ok(briefing(g, actors[0]).length > 0);
      for (const m of mv) assert.ok(fmtMove(m).length > 0);
      assert.ok(viewFor(g, actors[0]).players.every((p) => (p.id === actors[0]) === (p.hand !== null)));
    }
    g = apply(g, actors[0], mv[rnd(mv.length)]).state;
  }
  assert.equal(done, rounds);
  assert.equal(g.rounds.length, rounds);
  // 每局赢家分 = 那局其余人手牌分和；总分对得上
  const total = g.players.reduce((t, p) => t + p.score, 0);
  const expect = g.rounds.reduce((t, r) => t + r.gain, 0);
  assert.equal(total, expect, '累计分对不上');
  for (const r of g.rounds) {
    const rest = r.players.filter((x) => x.playerId !== r.winner).reduce((t, x) => t + x.handPoints, 0);
    assert.equal(r.gain, rest);
    assert.equal(r.players.find((x) => x.playerId === r.winner).handCount, 0, '赢家该出完');
  }
  return seen;
}

test('压测：2/3/4 人随机合法动作各打满 50 局（默认规则）', () => {
  for (const n of [2, 3, 4]) {
    const seen = stress(n, {}, 50, 'stress-' + n);
    assert.ok(seen.play > 0 && seen.draw > 0, `n=${n} 动作太单调：${JSON.stringify(seen)}`);
    assert.ok(seen.keep > 0, `n=${n} 一次 pending 摸牌都没撞上？`);
  }
});

test('压测：2/3/4 人 stack_draw2 开着各打满 50 局', () => {
  for (const n of [2, 3, 4]) {
    stress(n, { stack_draw2: true }, 50, 'stack-' + n);
  }
});

// ------------------------------------------------------------------ 双环境导出

test('导出：SPEC 八件套齐全 + CommonJS/浏览器全局都挂得上', () => {
  for (const k of ['createGame', 'apply', 'legalMoves', 'viewFor', 'currentActors', 'briefing', 'fmtMove']) {
    assert.equal(typeof engine[k], 'function', `缺导出 ${k}`);
  }
  assert.equal(typeof engine.meta, 'object', '缺导出 meta');

  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../engines/uno.cjs'), 'utf8');
  assert.ok(src.indexOf("typeof window !== 'undefined'") >= 0, '缺浏览器全局导出');
  assert.ok(src.indexOf('window.UnoEngine') >= 0, '缺 window.UnoEngine');
  const vm = require('node:vm');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.equal(sandbox.window.UnoEngine.ALL_CARDS.length, 108);
  assert.equal(sandbox.window.UnoEngine.cardLabel('BD#1'), '蓝+2');
});
