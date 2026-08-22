"use strict";
// 极简 engine stub —— 只为 server.test.cjs 注入用，不是真引擎。
// 接口对齐 SPEC 第 2 章：createGame({players, board, cards, config, seed}) → state
//                        apply(state, playerId, action) → {state, events}（非法 throw 中文 Error）

function createGame(input) {
  const o = input || {};
  const players = o.players || [];
  if (players.length < 2) throw new Error("至少要 2 个人才能开局");
  return {
    seq: 0,
    createdAt: Date.now(),
    phase: "awaiting_roll",
    currentPlayer: players[0].id,
    dice: null,
    doublesCount: 0,
    players: players.map(function (p) {
      return { id: p.id, name: p.name, color: p.color, cash: 15000, pos: 0, bankrupt: false };
    }),
    cells: {},
    decks: { chance: { draw: [], discard: [] }, community: { draw: [], discard: [] } },
    pendingCard: null,
    pendingDebt: null,
    log: [],
    winner: null,
    rngState: [o.seed || 1, 2, 3, 4],
    seed: o.seed || null
  };
}

function apply(state, playerId, action) {
  if (!action || !action.type) throw new Error("缺少动作类型");
  if (state.winner) throw new Error("牌局已经结束了");
  if (state.currentPlayer !== playerId) throw new Error("还没轮到你行动");
  if (action.type !== "roll" && action.type !== "end_turn") {
    throw new Error("非法动作：" + action.type);
  }
  const seq = state.seq + 1;
  const next = Object.assign({}, state, {
    seq: seq,
    dice: action.type === "roll" ? [3, 4] : state.dice,
    phase: action.type === "roll" ? "awaiting_end" : "awaiting_roll",
    log: state.log.concat([{ seq: seq, t: Date.now(), text: playerId + " " + action.type, type: action.type }])
  });
  if (action.type === "end_turn") {
    const ids = state.players.map(function (p) { return p.id; });
    next.currentPlayer = ids[(ids.indexOf(playerId) + 1) % ids.length];
  }
  return { state: next, events: [{ type: action.type, playerId: playerId }] };
}

module.exports = { createGame: createGame, apply: apply };
