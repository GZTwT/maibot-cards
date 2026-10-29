"use strict";

const test = require("node:test");
const assert = require("node:assert");
const zjh = require("../engines/zjh.cjs");
const strategy = require("../engines/zjh-strategy.cjs");

test("zjh 模拟: 策略跑完整局，动作始终合法", function () {
  for (let seed = 1; seed <= 3; seed++) {
    const players = [
      { id: "p1", name: "MaiBot", isAI: true },
      { id: "p2", name: "H1" },
      { id: "p3", name: "H2" },
      { id: "p4", name: "H3" },
    ];
    let state = zjh.createGame({
      players: players,
      rules: zjh.DEFAULT_RULES,
      seed: seed,
    });
    let guard = 600;
    while (guard-- > 0 && state.phase !== "round_over" && state.phase !== "game_over") {
      const actor = (zjh.currentActors(state) || [])[0];
      if (!actor) break;
      const legal = zjh.legalMoves(state, actor);
      assert.ok(legal.length, "当前行动者必须有合法招");
      const pick = strategy.choose(zjh.viewFor(state, actor), legal, {}) || legal[0];
      assert.ok(legal.indexOf(pick) !== -1, "策略只能返回合法招");
      const out = zjh.apply(state, actor, pick);
      state = out && out.state ? out.state : out;
    }
    assert.ok(
      state.phase === "round_over" || state.phase === "game_over",
      "整局应能结束，phase=" + state.phase
    );
  }
});