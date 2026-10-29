"use strict";

// 斗地主兜底策略：没有外部 mover / mover 超时 / 返回非法动作时用。
// 只用自己视角能看到的公开信息（手牌、各家剩牌数、场上牌），不偷看别人手牌。
// 目标：农民不压队友、跟牌出最小、领出先走长牌型、留炸弹、残局提速。

function rankOf(id) {
  const s = String(id || "");
  if (s === "X1") return 16;
  if (s === "X2") return 17;
  const n = Number(s.slice(1));
  return Number.isFinite(n) ? n : 0;
}

function isBomb(move) {
  const type = move && (move.as || (move.combo && move.combo.type));
  return type === "bomb" || type === "rocket";
}

function mainRank(move) {
  return (move && move.combo && move.combo.mainRank) || 0;
}

function meOf(view) {
  return (view.players || []).find(function (p) { return p.id === view.you; }) || null;
}

function landlordOf(view) {
  return (view.players || []).find(function (p) { return p.isLandlord; }) || null;
}

function rankCounts(hand) {
  const out = {};
  (hand || []).forEach(function (id) {
    const r = rankOf(id);
    out[r] = (out[r] || 0) + 1;
  });
  return out;
}

function pickBid(view, legal) {
  const me = meOf(view);
  const hand = (me && me.hand) || [];
  const counts = rankCounts(hand);
  let score = 0;
  for (const r of Object.keys(counts)) {
    const n = counts[r];
    const rank = Number(r);
    if (rank === 17) score += 4;
    else if (rank === 16) score += 3;
    else if (rank === 15) score += 2;
    else if (rank === 14) score += 1;
    if (n === 4) score += 6;
  }
  if (counts[16] && counts[17]) score += 5; // 王炸

  let want = 0;
  if (score >= 12) want = 3;
  else if (score >= 8) want = 2;
  else if (score >= 4) want = 1;

  const bids = legal.filter(function (m) { return m && m.type === "bid"; });
  if (!bids.length) return null;
  const exact = bids.find(function (m) { return m.value === want; });
  if (exact) return exact;
  const lower = bids
    .filter(function (m) { return m.value > 0 && m.value <= want; })
    .sort(function (a, b) { return b.value - a.value; })[0];
  return lower || bids.find(function (m) { return m.value === 0; }) || bids[0];
}

function pickMove(view, legal) {
  const me = meOf(view);
  if (!me) return legal[0] || null;
  const hand = me.hand || [];
  const plays = legal.filter(function (m) { return m && m.type === "play"; });
  const pass = legal.find(function (m) { return m && m.type === "pass"; });
  if (!plays.length) return pass || legal[0] || null;

  const field = view.field || null;
  const by = field && (view.players || []).find(function (p) { return p.id === field.by; });
  const teammatePlayed = !!(field && by && !me.isLandlord && !by.isLandlord && by.id !== me.id);

  // 能一把走完就走完，队友的牌也不让。
  const win = plays.find(function (m) { return (m.cards || []).length === hand.length; });
  if (win) return win;

  if (teammatePlayed) {
    // 农民不压农民：队友在场上，除非能直接走完，否则过。
    return pass || plays[0];
  }

  const landlord = landlordOf(view);
  const players = view.players || [];
  // 队友快走完：地主出的这手队友接得住，就别抢，让他走。
  if (!me.isLandlord && field) {
    const mate = players.find(function (p) { return !p.isLandlord && p.id !== me.id; });
    const size = (field.combo && field.combo.size) || 1;
    if (mate && mate.handCount > 0 && mate.handCount <= size) {
      return pass || plays[0];
    }
  }

  const oppCount = me.isLandlord
    ? Math.min.apply(null, (view.players || [])
      .filter(function (p) { return !p.isLandlord; })
      .map(function (p) { return p.handCount || 0; }).concat([99]))
    : (landlord ? (landlord.handCount || 0) : 99);

  const counts = rankCounts(hand);
  const breaksBomb = function (m) {
    if (isBomb(m)) return false;
    return (m.cards || []).some(function (id) { return counts[rankOf(id)] === 4; });
  };
  const nonBomb = plays.filter(function (m) { return !isBomb(m); });
  const candidate = nonBomb.length ? nonBomb : plays;

  if (!field) {
    // 对手只剩一张：先出对子/连牌，别送一张单让他走。
    if (oppCount === 1) {
      const multi = candidate.filter(function (m) { return (m.cards || []).length > 1; });
      if (multi.length) {
        multi.sort(function (a, b) { return mainRank(a) - mainRank(b); });
        return multi[0];
      }
      const singles = candidate.filter(function (m) { return (m.cards || []).length === 1; });
      if (singles.length) {
        singles.sort(function (a, b) { return mainRank(a) - mainRank(b); });
        return singles[singles.length - 1];
      }
    }

    // 领出：多出牌、低主牌优先；不先扔 2/王、不拆炸弹、不领炸弹。
    let best = null;
    let bestScore = -Infinity;
    for (const m of candidate) {
      const r = mainRank(m);
      let score = (m.cards || []).length * 3 - r * 0.35;
      if (r >= 15) score -= 30;
      if (isBomb(m)) score -= 100;
      if (breaksBomb(m)) score -= 25;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best || legal[0] || null;
  }

  // 跟牌：同型里出最小；对手快走完时用最大的同型压住。
  const sorted = candidate.slice().sort(function (a, b) {
    return mainRank(a) - mainRank(b);
  });
  if (!sorted.length) return pass || legal[0] || null;
  if (oppCount <= 2) return sorted[sorted.length - 1];
  const safe = sorted.find(function (m) { return !breaksBomb(m); });
  return safe || sorted[0] || pass || legal[0] || null;
}

function choose(view, legal) {
  if (!view || !Array.isArray(legal) || !legal.length) return null;
  if (view.phase === "bidding") return pickBid(view, legal);
  if (view.phase === "playing") return pickMove(view, legal);
  return legal[0] || null;
}

module.exports = { choose: choose, rankOf: rankOf };