"use strict";

// 炸金花策略：给所有座位（MaiBot、补充 AI、玩家退出托管）共用的保守决策层。
// - 手牌强度按引擎 evalHand 的 cat/key 算，不再只看中文牌型。
// - 带底池赔率、位置、对手松紧（room.stats）。
// - 保守：中/强牌才比牌；弱牌只在小注、人少、后位低频诈唬。

const zjh = require("./zjh.cjs");

function meOf(view) {
  return (view.players || []).find(function (p) { return p.id === view.you; }) || null;
}

function handInfo(view) {
  const me = meOf(view);
  if (!me || !Array.isArray(me.cards) || me.cards.length !== 3) return null;
  try {
    const ev = zjh.evalHand(me.cards);
    return {
      cat: ev.cat,
      top: ev.top,
      key: ev.key.slice(),
      label: zjh.handLabel(ev, view.rules),
    };
  } catch (e) {
    return null;
  }
}

function tierOf(hand) {
  if (!hand) return "blind";
  const cat = hand.cat;
  const pair = cat === 2 ? hand.key[0] : 0;
  if (cat >= 5) return "premium";
  if (cat === 4 || (cat === 3 && hand.top >= 10) || (cat === 2 && pair >= 12)) return "strong";
  if (cat === 3 || cat === 2 || (cat === 1 && hand.top >= 13)) return "medium";
  return "weak";
}

function statsOf(stats, id) {
  const s = (stats || {})[id] || {};
  const acts = Number(s.acts) || 0;
  return {
    foldRate: acts ? (Number(s.fold) || 0) / acts : null,
    raiseRate: acts ? (Number(s.raise) || 0) / acts : null,
    acts: acts,
  };
}

function contextOf(view, stats) {
  const me = meOf(view);
  const players = view.players || [];
  const alive = players.filter(function (p) { return !p.folded && !p.out; });
  const call = Number(view.callCost) || 0;
  const pot = Number(view.pot) || 0;
  const order = view.turnOrder || [];
  const idx = me ? order.indexOf(me.id) : -1;
  const opponents = alive
    .filter(function (p) { return !me || p.id !== me.id; })
    .map(function (p) {
      const st = statsOf(stats, p.id);
      return {
        id: p.id, name: p.name, chips: Number(p.chips) || 0,
        looked: !!p.looked, foldRate: st.foldRate, raiseRate: st.raiseRate,
      };
    });
  return {
    me: me,
    alive: alive,
    chips: me ? Number(me.chips) || 0 : 0,
    pot: pot,
    callCost: call,
    baseBet: Math.max(1, Number(view.rules && view.rules.base_bet) || 10),
    odds: pot + call > 0 ? call / (pot + call) : 1,
    position: order.length && idx >= 0 ? idx / order.length : 0.5,
    opponents: opponents,
    tier: tierOf(handInfo(view)),
  };
}

function byType(legal, type) {
  return (legal || []).filter(function (m) { return m && m.type === type; });
}

function raisesOf(legal) {
  return byType(legal, "bet").filter(function (m) {
    return m.kind === "raise" || m.kind === "raise_allin";
  });
}

function callsOf(legal) {
  return byType(legal, "bet").filter(function (m) {
    return m.kind === "call" || m.kind === "allin";
  });
}

function pickRaise(legal, big) {
  const list = raisesOf(legal).slice().sort(function (a, b) {
    return (a.stake || a.amount || 0) - (b.stake || b.amount || 0);
  });
  if (!list.length) return null;
  const normal = list.filter(function (m) { return m.kind === "raise"; });
  const pool = normal.length ? normal : list;
  return big ? pool[pool.length - 1] : pool[0];
}

function pickCompare(view, legal, ctx, cap) {
  const costCap = ctx.chips * cap;
  const list = byType(legal, "compare").filter(function (m) {
    return (Number(m.cost) || 0) <= costCap;
  });
  if (!list.length) return null;
  const byId = {};
  (view.players || []).forEach(function (p) { byId[p.id] = p; });
  list.sort(function (a, b) {
    const pa = byId[a.target] || {};
    const pb = byId[b.target] || {};
    // 优先没看牌的（范围随机）、筹码少的
    if (!!pa.looked !== !!pb.looked) return pa.looked ? 1 : -1;
    return (Number(pa.chips) || 0) - (Number(pb.chips) || 0);
  });
  return list[0];
}

function canBluff(ctx) {
  if (ctx.tier !== "weak") return false;
  if (ctx.alive.length > 2) return false;
  if (ctx.position < 0.5) return false;
  if (ctx.callCost > Math.max(10, ctx.chips * 0.06)) return false;
  const opp = ctx.opponents[0];
  if (opp && opp.foldRate != null && opp.foldRate < 0.2) return false;
  return Math.random() < 0.25;
}

function choose(view, legal, stats) {
  if (!view || !Array.isArray(legal) || !legal.length) return null;
  const ctx = contextOf(view, stats);
  const hand = handInfo(view);
  if (!ctx.me) return legal[0] || null;
  const look = byType(legal, "look")[0] || null;
  const call = callsOf(legal)[0] || null;
  const fold = byType(legal, "fold")[0] || null;

  if (!hand) {
    // 闷牌：小注可以闷跟两手，否则先看牌。
    if (look && (ctx.callCost > ctx.chips * 0.03 || Math.random() < 0.55)) return look;
    return call || look || legal[0] || null;
  }

  if (ctx.tier === "premium" || ctx.tier === "strong") {
    const cmp = pickCompare(view, legal, ctx, ctx.tier === "premium" ? 0.45 : 0.4);
    if (cmp && Math.random() < (ctx.tier === "premium" ? 0.55 : 0.35)) return cmp;
    return pickRaise(legal, true) || call || legal[0] || null;
  }

  if (ctx.tier === "medium") {
    const cmp = pickCompare(view, legal, ctx, 0.25);
    if (cmp && ctx.odds < 0.3 && Math.random() < 0.35) return cmp;
    if (ctx.odds > 0.55 && fold) return fold;
    return call || pickRaise(legal, false) || legal[0] || null;
  }

  if (canBluff(ctx)) return pickRaise(legal, false) || call || legal[0] || null;
  return fold || call || legal[0] || null;
}

function adjust(view, legal, picked, stats) {
  if (!view || !Array.isArray(legal) || !picked || !picked.type) return picked || null;
  const ctx = contextOf(view, stats);
  const hand = handInfo(view);
  if (!ctx.me || !hand) return picked;

  const fold = byType(legal, "fold")[0] || null;
  const call = callsOf(legal)[0] || null;
  const cmp = pickCompare(view, legal, ctx, ctx.tier === "medium" ? 0.25 : 0.45);

  if (picked.type === "compare") {
    if (ctx.tier === "weak" || (picked.cost || 0) > ctx.chips * 0.45) {
      return fold || call || picked;
    }
    return picked;
  }

  if (ctx.tier === "premium" || ctx.tier === "strong") {
    if (picked.type === "fold") return cmp || pickRaise(legal, true) || picked;
    if (picked.type === "bet" && picked.kind === "call") {
      if (cmp && Math.random() < 0.5) return cmp;
      return pickRaise(legal, true) || picked;
    }
    if (picked.type === "bet" && (picked.kind === "raise" || picked.kind === "raise_allin")) {
      if (cmp && ctx.pot >= (cmp.cost || 0) * 2 && Math.random() < 0.3) return cmp;
      return picked;
    }
    return picked;
  }

  if (ctx.tier === "medium") {
    if (picked.type === "fold") {
      // 中牌面对一次正常加注也该跟：别看完牌就白弃。
      const cheap = Math.max(20, ctx.chips * 0.08);
      return call && (ctx.callCost <= cheap || ctx.odds <= 0.45) ? call : picked;
    }
    if (picked.type === "bet" && picked.kind === "call" && cmp && Math.random() < 0.3) {
      return cmp;
    }
    if (picked.type === "bet" && picked.kind === "raise" && ctx.odds > 0.35) {
      return call || fold || picked;
    }
    return picked;
  }

  // 弱牌：便宜注别弃；多人/高赔率不跟；单挑后位小注可以诈唬
  const cheap = Math.max(ctx.baseBet * 2, ctx.chips * 0.02);
  if (picked.type === "fold" && call && ctx.callCost <= cheap) return call;
  if (picked.type === "bet" && picked.kind === "call" && ctx.callCost <= cheap) return picked;
  if (picked.type === "bet" && (ctx.alive.length > 2 || ctx.odds > 0.45 ||
      ctx.callCost > ctx.chips * 0.1)) {
    return fold || picked;
  }
  if (picked.type === "fold" && canBluff(ctx)) {
    return pickRaise(legal, false) || picked;
  }
  if (picked.type === "bet" && picked.kind === "raise" && !canBluff(ctx)) {
    return fold || picked;
  }
  return picked;
}

module.exports = {
  choose: choose,
  adjust: adjust,
  handInfo: handInfo,
  tierOf: tierOf,
  contextOf: contextOf,
};