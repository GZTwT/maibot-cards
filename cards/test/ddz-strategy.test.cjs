"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { choose } = require("../engines/ddz-strategy.cjs");

function play(type, mainRank, cards) {
  return {
    type: "play", as: type, cards: cards,
    combo: { type: type, mainRank: mainRank, size: cards.length, cards: cards },
  };
}

function view(opts) {
  return {
    phase: "playing",
    you: "p2",
    landlord: "p1",
    players: [
      { id: "p1", isLandlord: true, handCount: opts.landlordCount == null ? 10 : opts.landlordCount },
      { id: "p2", isLandlord: false, handCount: opts.myCards.length, hand: opts.myCards },
      { id: "p3", isLandlord: false, handCount: opts.teammateCount == null ? 5 : opts.teammateCount },
    ],
    field: opts.field || null,
  };
}

test("ddz 策略: 农民不压队友，除非能一把走完", function () {
  const v = view({
    myCards: ["S3", "H4", "D5", "C6"],
    field: { by: "p3", cards: ["S9"], combo: { type: "single", mainRank: 9 } },
  });
  const legal = [
    play("single", 10, ["H10"]),
    play("single", 13, ["HK"]),
    { type: "pass" },
  ];
  assert.strictEqual(choose(v, legal).type, "pass");

  const v2 = view({
    myCards: ["HK"],
    field: { by: "p3", cards: ["S9"], combo: { type: "single", mainRank: 9 } },
  });
  const win = play("single", 13, ["HK"]);
  assert.strictEqual(choose(v2, [win, { type: "pass" }]), win);
});

test("ddz 策略: 压地主出最小的同型，残局改出最大的", function () {
  const field = { by: "p1", cards: ["S9"], combo: { type: "single", mainRank: 9 } };
  const small = play("single", 10, ["D10"]);
  const big = play("single", 13, ["HK"]);
  const legal = [small, big, { type: "pass" }];

  assert.strictEqual(choose(view({ myCards: ["D10", "HK"], field: field }), legal), small);
  assert.strictEqual(choose(view({
    myCards: ["D10", "HK"], field: field, landlordCount: 1,
  }), legal), big);
});

test("ddz 策略: 队友只剩一手时让队友接，不抢地主", function () {
  const field = { by: "p1", cards: ["S9"], combo: { type: "single", mainRank: 9 } };
  const beat = play("single", 10, ["D10"]);
  const legal = [beat, { type: "pass" }];
  assert.strictEqual(choose(view({
    myCards: ["D10", "HK"], field: field, teammateCount: 1,
  }), legal).type, "pass");
});

test("ddz 策略: 领出优先长牌型/低牌，不先扔炸弹", function () {
  const myCards = ["S3", "H4", "D5", "C6", "S7", "S8", "H8"];
  const straight = play("straight", 7, ["S3", "H4", "D5", "C6", "S7"]);
  const pair = play("pair", 8, ["S8", "H8"]);
  const single = play("single", 3, ["S3"]);
  const bomb = play("bomb", 8, ["S8", "H8", "D8", "C8"]);
  const picked = choose(view({ myCards: myCards }), [single, pair, straight, bomb]);
  assert.strictEqual(picked, straight);
});

test("ddz 策略: 对手只剩一张时领对子，不送单张", function () {
  const myCards = ["S3", "S8", "H8"];
  const single = play("single", 3, ["S3"]);
  const pair = play("pair", 8, ["S8", "H8"]);
  const picked = choose(view({ myCards: myCards, landlordCount: 1 }), [single, pair]);
  assert.strictEqual(picked, pair);
});

test("ddz 策略: 叫分按手牌强度，不总是 0", function () {
  const bids = [0, 1, 2, 3].map(function (value) { return { type: "bid", value: value }; });
  const strong = {
    phase: "bidding", you: "p2",
    players: [{ id: "p2", hand: ["X1", "X2", "S3", "H3", "D3", "C3", "S4", "H4", "D4", "C4"] }],
  };
  assert.strictEqual(choose(strong, bids).value, 3);

  const weak = {
    phase: "bidding", you: "p2",
    players: [{ id: "p2", hand: ["S3", "H4", "D5", "C6", "S7"] }],
  };
  assert.strictEqual(choose(weak, bids).value, 0);
});