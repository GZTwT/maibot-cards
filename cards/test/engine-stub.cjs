"use strict";
// 多游戏 engine stub —— 只为 server.test.cjs 注入用，不是真引擎
// （真引擎在 cards/engines/{ddz,zjh,uno}.cjs 并行开发中）。
// createStub(meta) 出一个符合 SPEC 第 1 章完整契约的假引擎，测试可以捏出
// 「三人局的 ddz」「两人局的 zjh」这种不同 meta 的游戏，验证底盘真的按房间取引擎。
//
// 八个导出：
//   meta / createGame / apply / legalMoves / viewFor / currentActors / briefing / fmtMove
//
// 玩法：每家发同花色 4 张（p1=♠ p2=♥ p3=♦ p4=♣），轮流出一张或过；
// 每家还带一个 secret 私密字段（"SEC-<花色>"），viewFor 只给本人看——
// 服务端的分视角脱敏靠它断言"A 的流里没有 B 的任何私密字段"。

const SUITS = ["S", "H", "D", "C"];

const DEFAULT_META = {
  key: "stub",
  name: "测试牌",
  minPlayers: 2,
  maxPlayers: 4,
  defaultRules: { fast_mode: true, bonus: 3 },
  ruleMeta: [
    { key: "fast_mode", label: "快速模式", note: "stub 用", def: true },
    { key: "bonus", label: "奖励分", note: "stub 用", def: 3 }
  ]
};

function createStub(input) {
  const meta = Object.assign({}, DEFAULT_META, input || {});

  function createGame(o) {
    const opt = o || {};
    const players = opt.players || [];
    if (players.length < meta.minPlayers) throw new Error("至少要 " + meta.minPlayers + " 个人才能开局");
    if (players.length > meta.maxPlayers) throw new Error("最多 " + meta.maxPlayers + " 个人");
    const ids = players.map(function (p) { return p.id; });
    return {
      seq: 0,
      game: meta.key,
      createdAt: Date.now(),
      phase: "playing",
      round: 1,
      turnOrder: ids,
      current: ids[0],
      players: players.map(function (p, i) {
        const suit = SUITS[i % SUITS.length];
        return {
          id: p.id,
          name: p.name,
          isAI: !!p.isAI,
          hand: [suit + "3", suit + "4", suit + "5", suit + "6"],
          secret: "SEC-" + suit,
          passed: false,
          finished: null,
          score: 0
        };
      }),
      field: null,
      rules: opt.config || {},
      log: [],
      rngState: [opt.seed || 1, 2, 3, 4],
      seed: opt.seed || null
    };
  }

  function findPlayer(state, playerId) {
    return ((state && state.players) || []).find(function (p) { return p.id === playerId; }) || null;
  }

  function apply(state, playerId, action) {
    if (!action || !action.type) throw new Error("缺少动作类型");
    if (state.phase === "game_over") throw new Error("这一场已经结束了");
    if (state.phase === "round_over") {
      if (action.type !== "next_round") throw new Error("这一轮打完了，只能开下一轮");
    } else if (state.current !== playerId) {
      throw new Error("还没轮到你出牌");
    }
    const me = findPlayer(state, playerId);
    if (!me) throw new Error("你不在这局里");
    if (["play", "pass", "next_round", "end_match"].indexOf(action.type) === -1) {
      throw new Error("非法动作：" + action.type);
    }

    const seq = state.seq + 1;
    const next = JSON.parse(JSON.stringify(state));
    next.seq = seq;
    const nextMe = findPlayer(next, playerId);

    if (action.type === "end_match") {
      next.phase = "game_over";
    } else if (action.type === "next_round") {
      next.phase = "playing";
      next.round = (next.round || 1) + 1;
      next.field = null;
      next.players.forEach(function (p, i) {
        const suit = SUITS[i % SUITS.length];
        p.hand = [suit + "3", suit + "4", suit + "5", suit + "6"];
        p.passed = false;
        p.finished = null;
      });
      next.current = next.turnOrder[0];
    } else if (action.type === "play") {
      const cards = Array.isArray(action.cards) ? action.cards : [];
      if (!cards.length) throw new Error("没选牌");
      for (const c of cards) {
        if (nextMe.hand.indexOf(c) === -1) throw new Error("你手里没有这张牌：" + c);
      }
      nextMe.hand = nextMe.hand.filter(function (c) { return cards.indexOf(c) === -1; });
      next.field = { cards: cards.slice(), by: playerId };
      if (!nextMe.hand.length) {
        nextMe.finished = 1;
        nextMe.score = (nextMe.score || 0) + 1;
        next.phase = "round_over";
      }
    } else {
      if (!next.field) throw new Error("场上没牌，不能过");
      nextMe.passed = true;
    }

    if (next.phase === "playing") {
      const ids = next.turnOrder;
      next.current = ids[(ids.indexOf(playerId) + 1) % ids.length];
    }
    next.log = (next.log || []).concat([{ seq: seq, t: Date.now(), text: playerId + " " + action.type }]);
    return { state: next, events: [{ type: action.type, playerId: playerId, cards: action.cards || null }] };
  }

  function legalMoves(state, playerId) {
    if (!state) return [];
    if (state.phase === "round_over") return [{ type: "next_round" }];
    if (state.phase === "game_over") return [];
    if (state.current !== playerId) return [];
    const me = findPlayer(state, playerId);
    if (!me) return [];
    const moves = (me.hand || []).map(function (c) {
      return { type: "play", cards: [c] };
    });
    if (state.field) moves.push({ type: "pass" });
    return moves;
  }

  function currentActors(state) {
    if (!state || state.phase === "game_over" || state.phase === "round_over") return [];
    return state.current ? [state.current] : [];
  }

  function viewFor(state, playerId) {
    const view = JSON.parse(JSON.stringify(state));
    view.you = playerId || null;
    view.players = view.players.map(function (p) {
      const copy = Object.assign({}, p);
      copy.handCount = (p.hand || []).length;
      if (p.id !== playerId) {
        delete copy.hand;
        delete copy.secret; // 私密字段：别人一律看不到
      }
      return copy;
    });
    return view;
  }

  function briefing(state, playerId) {
    const me = findPlayer(state, playerId) || {};
    const lines = [];
    lines.push("【" + meta.name + "】第 " + (state.round || 1) + " 轮 · " + state.phase);
    lines.push("你的手牌(" + (me.hand || []).length + " 张)：" + ((me.hand || []).join(" ") || "(空)"));
    if (state.field) {
      const by = findPlayer(state, state.field.by);
      lines.push("场上：" + (state.field.cards || []).join(" ") + " —— " + ((by && by.name) || "?") + " 出的");
    } else {
      lines.push("场上空着，你领出。");
    }
    lines.push("其他人：" + (state.players || []).filter(function (p) { return p.id !== playerId; })
      .map(function (p) { return p.name + " " + (p.hand || []).length + " 张"; }).join(" / "));
    return lines.join("\n");
  }

  function fmtMove(move) {
    if (!move) return "?";
    if (move.type === "pass") return "过（pass）";
    if (move.type === "next_round") return "开下一轮";
    if (move.type === "end_match") return "结束整场";
    return "出 " + (move.cards || []).join(" ");
  }

  return {
    meta: meta,
    createGame: createGame,
    apply: apply,
    legalMoves: legalMoves,
    viewFor: viewFor,
    currentActors: currentActors,
    briefing: briefing,
    fmtMove: fmtMove
  };
}

module.exports = { createStub: createStub };
