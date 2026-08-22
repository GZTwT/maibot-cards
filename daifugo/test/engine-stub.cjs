"use strict";
// 极简 engine stub —— 只为 server.test.cjs 注入用，不是真引擎（真引擎在 daifugo/engine.cjs 并行开发中）。
// 接口对齐 SPEC 第 1 章：
//   createGame({players, config, seed}) → state
//   apply(state, playerId, action) → {state, events}（非法 throw 中文 Error）
//   legalMoves(state, playerId) → [{type:'play',cards:[...]}|{type:'pass'}]
//   viewFor(state, playerId|null) → 脱敏视图（自己手牌全量，他人只有 handCount）
// 发牌是写死的：每家一个花色，方便断言"A 的流里不出现 B 的牌"。

const SUITS = ["S", "H", "D", "C"]; // p1=黑桃 p2=红桃 p3=方块 p4=梅花

function createGame(input) {
  const o = input || {};
  const players = o.players || [];
  if (players.length < 2) throw new Error("至少要 2 个人才能开局");
  if (players.length > 4) throw new Error("最多 4 个人");
  const ids = players.map(function (p) { return p.id; });
  return {
    seq: 0,
    createdAt: Date.now(),
    phase: "playing",
    round: 1,
    turnOrder: ids,
    current: ids[0],
    leader: ids[0],
    players: players.map(function (p, i) {
      const suit = SUITS[i];
      return {
        id: p.id,
        name: p.name,
        isAI: !!p.isAI,
        hand: [suit + "3", suit + "4", suit + "5", suit + "6"],
        rank: null,
        finished: null,
        passed: false,
        score: 0
      };
    }),
    field: null,
    lastToPlay: null,
    revolution: false,
    suitLock: null,
    exchange: null,
    rules: o.config || {},
    log: [],
    rngState: [o.seed || 1, 2, 3, 4],
    seed: o.seed || null
  };
}

function findPlayer(state, playerId) {
  return (state.players || []).find(function (p) { return p.id === playerId; }) || null;
}

function rankOf(card) {
  return parseInt(String(card).slice(1), 10) || 0;
}

function apply(state, playerId, action) {
  if (!action || !action.type) throw new Error("缺少动作类型");
  if (state.phase === "game_over") throw new Error("这一场已经结束了");
  if (state.current !== playerId) throw new Error("还没轮到你出牌");
  const me = findPlayer(state, playerId);
  if (!me) throw new Error("你不在这局里");
  if (action.type !== "play" && action.type !== "pass") {
    throw new Error("非法动作：" + action.type);
  }

  const seq = state.seq + 1;
  const next = JSON.parse(JSON.stringify(state));
  next.seq = seq;
  const nextMe = findPlayer(next, playerId);

  if (action.type === "play") {
    const cards = Array.isArray(action.cards) ? action.cards : [];
    if (!cards.length) throw new Error("没选牌");
    for (const c of cards) {
      if (nextMe.hand.indexOf(c) === -1) throw new Error("你手里没有这张牌：" + c);
    }
    nextMe.hand = nextMe.hand.filter(function (c) { return cards.indexOf(c) === -1; });
    next.field = {
      cards: cards.slice(),
      by: playerId,
      combo: { type: cards.length === 1 ? "single" : "set", size: cards.length, strength: rankOf(cards[0]) }
    };
    next.lastToPlay = playerId;
  } else {
    if (!next.field) throw new Error("场上没牌，不能过");
    nextMe.passed = true;
  }

  const ids = next.turnOrder;
  next.current = ids[(ids.indexOf(playerId) + 1) % ids.length];
  next.log = (next.log || []).concat([{ seq: seq, t: Date.now(), text: playerId + " " + action.type }]);
  return { state: next, events: [{ type: action.type, playerId: playerId, cards: action.cards || null }] };
}

function legalMoves(state, playerId) {
  if (!state || state.current !== playerId) return [];
  const me = findPlayer(state, playerId);
  if (!me) return [];
  const moves = me.hand.map(function (c) {
    return { type: "play", cards: [c], combo: { type: "single", size: 1, strength: rankOf(c) }, label: "单张 " + c };
  });
  if (state.field) moves.push({ type: "pass", label: "过" });
  return moves;
}

function viewFor(state, playerId) {
  const view = JSON.parse(JSON.stringify(state));
  view.you = playerId || null;
  view.players = view.players.map(function (p) {
    const copy = Object.assign({}, p);
    copy.handCount = (p.hand || []).length;
    if (p.id !== playerId) delete copy.hand;
    return copy;
  });
  return view;
}

module.exports = {
  createGame: createGame,
  apply: apply,
  legalMoves: legalMoves,
  viewFor: viewFor
};
