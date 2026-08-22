/* Bisca 大富翁 —— 规则查询（浏览器端只读版）
 * 照抄 engine.cjs 的 legalActions / buildableCells / sellableCells / rentFor 分支，
 * 只用来决定「画哪几个按钮」。真正的合法性以后端为准（400 会带中文原因，直接 toast）。
 */
(function (global) {
  'use strict';

  function findPlayer(s, id) {
    if (!s || !s.players) return null;
    for (var i = 0; i < s.players.length; i++) if (s.players[i].id === id) return s.players[i];
    return null;
  }

  function cellAt(s, i) { return (s.board && s.board[i]) || null; }

  function ownerOf(s, i) {
    var o = s.cells && (s.cells[i] || s.cells[String(i)]);
    return o || null;
  }

  function housesOf(s, i) {
    var o = ownerOf(s, i);
    return (o && o.houses) || 0;
  }

  function houseCostOf(s, i) {
    var c = cellAt(s, i);
    return (c && c.houseCost) || 0;
  }

  function groupCells(s, group) {
    var out = [];
    if (!group || !s.board) return out;
    for (var i = 0; i < s.board.length; i++) {
      if (s.board[i].type === 'prop' && s.board[i].group === group) out.push(i);
    }
    return out;
  }

  function groupFullyOwned(s, group, ownerId) {
    var idxs = groupCells(s, group);
    if (!idxs.length) return false;
    return idxs.every(function (i) {
      var o = ownerOf(s, i);
      return o && o.owner === ownerId;
    });
  }

  function countTypeOwned(s, type, ownerId) {
    var n = 0;
    for (var i = 0; i < s.board.length; i++) {
      var o = ownerOf(s, i);
      if (s.board[i].type === type && o && o.owner === ownerId) n++;
    }
    return n;
  }

  function ownedCells(s, ownerId) {
    var out = [];
    if (!s.cells) return out;
    Object.keys(s.cells).forEach(function (k) {
      var o = s.cells[k];
      if (o && o.owner === ownerId) out.push(Number(k));
    });
    return out.sort(function (a, b) { return a - b; });
  }

  function diceSum(s) { return s.dice ? s.dice[0] + s.dice[1] : 0; }

  /** 当前租金（无主返回 0）。公用事业按当前骰点算，跟引擎一致。 */
  function rentFor(s, idx) {
    var own = ownerOf(s, idx);
    var cell = cellAt(s, idx);
    if (!own || !cell) return 0;
    if (cell.type === 'prop') {
      var rents = cell.rents || [];
      var h = own.houses || 0;
      if (h > 0) return rents[Math.min(h, rents.length - 1)] || 0;
      var base = rents[0] || 0;
      return groupFullyOwned(s, cell.group, own.owner) ? base * 2 : base;
    }
    if (cell.type === 'rail') {
      var table = (cell.rents && cell.rents.length >= 4) ? cell.rents : (s.config.railRents || []);
      var n = countTypeOwned(s, 'rail', own.owner);
      if (n <= 0) return 0;
      return table[Math.min(n, table.length) - 1] || 0;
    }
    if (cell.type === 'util') {
      var mults = (cell.multipliers && cell.multipliers.length >= 2) ? cell.multipliers : (s.config.utilMultipliers || []);
      var m = countTypeOwned(s, 'util', own.owner);
      if (m <= 0) return 0;
      return diceSum(s) * (mults[Math.min(m, mults.length) - 1] || 0);
    }
    return 0;
  }

  /** 该玩家此刻可盖房的格子 */
  function buildableCells(s, playerId) {
    var p = findPlayer(s, playerId);
    if (!p || p.inJail) return [];
    var maxHouses = (s.config && s.config.maxHouses) || 5;
    return ownedCells(s, playerId).filter(function (i) {
      var cell = cellAt(s, i);
      if (!cell || cell.type !== 'prop') return false;
      if (!groupFullyOwned(s, cell.group, playerId)) return false;
      var h = housesOf(s, i);
      if (h >= maxHouses) return false;
      var min = groupCells(s, cell.group).reduce(function (m, j) { return Math.min(m, housesOf(s, j)); }, Infinity);
      if (h + 1 - min > 1) return false;
      return p.cash >= houseCostOf(s, i);
    });
  }

  /** 该玩家此刻可拆房的格子（组内房子最多的那些） */
  function sellableCells(s, playerId) {
    return ownedCells(s, playerId).filter(function (i) {
      if (housesOf(s, i) <= 0) return false;
      var cell = cellAt(s, i);
      var max = groupCells(s, cell.group).reduce(function (m, j) { return Math.max(m, housesOf(s, j)); }, 0);
      return housesOf(s, i) >= max;
    });
  }

  /** engine.legalActions 的浏览器版 */
  function legalActions(s, playerId) {
    var out = [];
    if (!s || s.phase === 'game_over') return out;
    var p = findPlayer(s, playerId);
    if (!p || p.bankrupt) return out;
    if (s.pendingDebt) {
      if (s.pendingDebt.playerId === playerId) out.push('declare_bankrupt');
      return out;
    }
    if (s.currentPlayer !== playerId) return out;
    if (s.pendingCard) return ['card_ack'];
    if (s.phase === 'awaiting_buy') {
      var price = (cellAt(s, p.pos) || {}).price || 0;
      if (p.cash >= price) out.push('buy');
      out.push('decline');
      return out;
    }
    if (s.phase === 'awaiting_roll') {
      out.push('roll');
      if (p.inJail) {
        if (p.cash >= (s.config.bail || 0)) out.push('pay_bail');
        if (p.getOutFree > 0) out.push('use_jail_card');
      }
    }
    if (s.phase === 'awaiting_end') out.push('end_turn');
    if ((s.phase === 'awaiting_roll' || s.phase === 'awaiting_end') && !p.inJail) {
      if (buildableCells(s, playerId).length) out.push('build');
      if (sellableCells(s, playerId).length) out.push('sell_house');
    }
    return out;
  }

  global.MonoRules = {
    findPlayer: findPlayer,
    cellAt: cellAt,
    ownerOf: ownerOf,
    housesOf: housesOf,
    houseCostOf: houseCostOf,
    ownedCells: ownedCells,
    groupFullyOwned: groupFullyOwned,
    rentFor: rentFor,
    buildableCells: buildableCells,
    sellableCells: sellableCells,
    legalActions: legalActions
  };
})(window);
