"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { choose, adjust, contextOf, handInfo } = require("../engines/zjh-strategy.cjs");

function legal() {
  return [
    { type: "look" },
    { type: "bet", kind: "call", amount: 20, stake: 20 },
    { type: "bet", kind: "raise", amount: 60, stake: 80 },
    { type: "fold" },
    { type: "compare", target: "p2", targetName: "H1", cost: 20 },
  ];
}

function view(cards, opts) {
  const o = opts || {};
  return {
    you: "p1",
    pot: o.pot == null ? 80 : o.pot,
    callCost: o.callCost == null ? 20 : o.callCost,
    currentBet: o.callCost == null ? 20 : o.callCost,
    turnOrder: ["p1", "p2"],
    rules: {},
    players: [
      {
        id: "p1", name: "MaiBot", chips: o.chips == null ? 1000 : o.chips,
        looked: !!cards, cards: cards || null, folded: false, out: false,
      },
      {
        id: "p2", name: "H1", chips: o.oppChips == null ? 900 : o.oppChips,
        looked: !!o.oppLooked, cards: null, folded: false, out: false,
      },
    ],
  };
}

function stubRandom(value, fn) {
  const old = Math.random;
  Math.random = () => value;
  try { return fn(); } finally { Math.random = old; }
}

test("zjh 策略: 结构化牌力能区分豹子/对子/散牌", function () {
  const premium = handInfo(view(["S3", "H3", "D3"]));
  const strong = handInfo(view(["S13", "H13", "D3"]));
  const weak = handInfo(view(["S3", "H5", "D9"]));
  assert.strictEqual(premium.cat, 6);
  assert.strictEqual(strong.cat, 2);
  assert.strictEqual(weak.cat, 1);
  assert.match(premium.label, /豹子/);
});

test("zjh 策略: 强牌加注或比牌，不会弃", function () {
  const picked = stubRandom(0.99, () => choose(view(["S3", "H3", "D3"]), legal(), {}));
  assert.ok(picked.type === "compare" || picked.kind === "raise");
});

test("zjh 策略: 中牌小注可以跟，注大就弃", function () {
  const small = choose(view(["S10", "H11", "D12"], { callCost: 20 }), legal(), {});
  assert.ok(small.type === "compare" || small.kind === "call" || small.kind === "raise");
  const big = stubRandom(0.99, () => choose(
    view(["S3", "H5", "D9"], { callCost: 50, chips: 100 }), legal(), {}
  ));
  assert.strictEqual(big.type, "fold");
});

test("zjh 策略: 闷牌先看，不一直闷跟", function () {
  const picked = stubRandom(0.1, () => choose(view(null), legal(), {}));
  assert.strictEqual(picked.type, "look");
});

test("zjh 策略: 赔率和档位可读", function () {
  const ctx = contextOf(view(["S3", "H4", "D5"], { pot: 80, callCost: 20 }), {});
  assert.ok(ctx.odds > 0 && ctx.odds < 1);
  assert.strictEqual(ctx.tier, "medium");
});

test("zjh 策略: 校正模型动作——强牌弃牌改成加注/比牌", function () {
  const picked = stubRandom(0.1, () => adjust(
    view(["S3", "H3", "D3"]), legal(), { type: "fold" }, {}
  ));
  assert.ok(picked.type === "compare" || picked.kind === "raise");
});

test("zjh 策略: 校正模型动作——弱牌高注跟注改成弃牌", function () {
  const picked = adjust(
    view(["S3", "H5", "D9"], { callCost: 50, chips: 100, pot: 80 }),
    legal(), { type: "bet", kind: "call", amount: 50 }, {}
  );
  assert.strictEqual(picked.type, "fold");
});

test("zjh 策略: 中牌面对一次加注不会看完就弃", function () {
  const picked = adjust(
    view(["S14", "H9", "D5"], { callCost: 50, chips: 900, pot: 70 }),
    legal(), { type: "fold" }, {}
  );
  assert.strictEqual(picked.type, "bet");
  assert.strictEqual(picked.kind, "call");
});

test("zjh 策略: 弱牌面对便宜跟注不弃", function () {
  const picked = adjust(
    view(["S3", "H5", "D9"], { callCost: 20, chips: 1000, pot: 80 }),
    legal(), { type: "bet", kind: "call", amount: 20 }, {}
  );
  assert.strictEqual(picked.type, "bet");
  assert.strictEqual(picked.kind, "call");
  const rescued = adjust(
    view(["S3", "H5", "D9"], { callCost: 20, chips: 1000, pot: 80 }),
    legal(), { type: "fold" }, {}
  );
  assert.strictEqual(rescued.type, "bet");
});