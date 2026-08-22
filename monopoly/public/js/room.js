/* Bisca 大富翁 —— 房间页主控
 * 负责：入座/复座/观战、SSE 同步、玩家栏、棋盘、骰子、日志、操作条、格子详情、卡牌、胜利屏。
 */
(function (global) {
  'use strict';

  var API = global.MonoAPI;
  var UI = global.MonoUI;
  var R = global.MonoRules;
  var BoardView = global.MonoBoard;
  var esc = BoardView.esc;

  var $ = function (id) { return document.getElementById(id); };
  var code = (new URLSearchParams(location.search).get('c') || '').toUpperCase();

  var seat = null;          // {playerId, playerToken, name, color, isHost}
  var payload = null;       // 最近一次 state 广播
  var state = null;
  var boardUI = null;
  var zoom = null;
  var sync = null;
  var busy = false;
  var lastDiceKey = null;
  var lastTurnMine = false;
  var joinAsked = false;

  // ── 小工具 ────────────────────────────────────────────────────────────────

  function me() { return seat && state ? R.findPlayer(state, seat.playerId) : null; }
  function isMyTurn() { return !!(seat && state && state.currentPlayer === seat.playerId); }
  function money(n) { return '¥' + (n || 0); }

  function send(type, extra) {
    if (busy || !seat) return Promise.resolve();
    busy = true;
    renderActions();
    return API.action(code, seat.playerToken, type, extra).then(function () {
      busy = false;
      renderActions();
    }, function (err) {
      busy = false;
      UI.toast(err.message, true);
      renderActions();
    });
  }

  // ── 头部 / 玩家栏 ──────────────────────────────────────────────────────────

  function renderHeader() {
    $('r-name').textContent = (payload && payload.name) || '房间';
    $('r-code').textContent = code;
  }

  function renderPlayers() {
    var box = $('r-players');
    if (!state) {
      var seats = (payload && payload.seats) || [];
      box.innerHTML = seats.map(function (s) {
        return '<div class="pl-card' + (seat && seat.playerId === s.playerId ? ' is-me' : '') + '">' +
          '<div class="top"><span class="mono-dot" style="background:' + esc(s.color) + '"></span>' +
          '<span class="nm">' + esc(s.name) + '</span></div>' +
          '<div class="tail">' + (s.isHost ? '房主' : '玩家') + '</div></div>';
      }).join('');
      return;
    }
    box.innerHTML = state.players.map(function (p) {
      var tail = [];
      if (p.inJail) tail.push('蹲监狱');
      if (p.getOutFree > 0) tail.push('出狱卡 ×' + p.getOutFree);
      var n = R.ownedCells(state, p.id).length;
      if (n) tail.push(n + ' 处地');
      return '<div class="pl-card' +
        (state.currentPlayer === p.id && !state.winner ? ' is-turn' : '') +
        (p.bankrupt ? ' is-out' : '') +
        (seat && seat.playerId === p.id ? ' is-me' : '') + '">' +
        '<div class="top"><span class="mono-dot" style="background:' + esc(p.color) + '"></span>' +
        '<span class="nm">' + esc(p.name) + '</span></div>' +
        '<div class="cash">' + (p.bankrupt ? '已出局' : money(p.cash)) + '</div>' +
        '<div class="tail">' + esc(tail.join(' · ')) + '</div></div>';
    }).join('');
  }

  // ── 中央区：回合 / 骰子 / 日志 ─────────────────────────────────────────────

  var PHASE_HINT = {
    awaiting_roll: '等一手骰子',
    awaiting_buy: '要不要买这块地',
    awaiting_end: '可以收工了',
    game_over: '牌局结束'
  };

  function centerHtml() {
    return '<div class="cc-turn"><span id="cc-who"></span><div class="cc-phase" id="cc-phase"></div></div>' +
      '<div class="cc-dice">' + dieHtml() + dieHtml() + '</div>' +
      '<div class="cc-log" id="cc-log"></div>';
  }

  function dieHtml() {
    var pips = '';
    for (var i = 0; i < 9; i++) pips += '<span class="pip"></span>';
    return '<div class="mono-die" data-v="1">' + pips + '</div>';
  }

  function renderCenter() {
    if (!boardUI) return;
    var c = boardUI.center;
    if (!c.querySelector('#cc-log')) c.innerHTML = centerHtml();

    var cur = R.findPlayer(state, state.currentPlayer);
    $('cc-who').innerHTML = state.winner
      ? '<b>' + esc((R.findPlayer(state, state.winner) || {}).name || '') + '</b> 赢了'
      : ('轮到 <b>' + esc(cur ? cur.name : '') + '</b>' + (isMyTurn() ? '（你）' : ''));
    $('cc-phase').textContent = PHASE_HINT[state.phase] || '';

    renderDice(c);
    renderLog();
  }

  function renderDice(c) {
    var dice = c.querySelectorAll('.mono-die');
    var key = state.dice ? (state.seq + ':' + state.dice.join(',')) : 'none';
    if (key === lastDiceKey) return;
    var animate = lastDiceKey !== null && !!state.dice;   // 首次进房不摇，之后每次新点数都摇
    lastDiceKey = key;
    if (!state.dice) {
      dice[0].dataset.v = '1';
      dice[1].dataset.v = '1';
      return;
    }
    if (!animate) {
      dice[0].dataset.v = String(state.dice[0]);
      dice[1].dataset.v = String(state.dice[1]);
      return;
    }
    // 摇 0.8s，中途乱跳点数，到点定格真实结果
    var spin = setInterval(function () {
      dice[0].dataset.v = String(1 + Math.floor(Math.random() * 6));
      dice[1].dataset.v = String(1 + Math.floor(Math.random() * 6));
    }, 80);
    dice[0].classList.add('is-rolling');
    dice[1].classList.add('is-rolling');
    setTimeout(function () {
      clearInterval(spin);
      dice[0].classList.remove('is-rolling');
      dice[1].classList.remove('is-rolling');
      if (state.dice) {
        dice[0].dataset.v = String(state.dice[0]);
        dice[1].dataset.v = String(state.dice[1]);
      }
    }, 800);
  }

  function renderLog() {
    var box = $('cc-log');
    if (!box) return;
    var rows = (state.log || []).slice(-6);
    box.innerHTML = rows.map(function (r) {
      return '<div class="row">' + esc(r.text) + '</div>';
    }).join('');
  }

  // ── 操作条 ────────────────────────────────────────────────────────────────

  function btn(label, cls, fn) {
    var b = document.createElement('button');
    b.className = 'mono-btn ' + (cls || '');
    b.textContent = label;
    b.disabled = busy;
    b.addEventListener('click', fn);
    return b;
  }

  function renderActions() {
    var bar = $('r-actions');
    bar.innerHTML = '';

    if (!seat) {
      var badge = document.createElement('span');
      badge.className = 'mono-watch';
      badge.innerHTML = UI.icon('play', 15) + '观战中';
      bar.appendChild(badge);
      return;
    }

    if (!state) {
      var seats = (payload && payload.seats) || [];
      if (seat.isHost) {
        bar.appendChild(btn('开局（' + seats.length + ' 人）', 'mono-btn--primary', function () {
          API.startRoom(code, seat.playerToken).catch(function (e) { UI.toast(e.message, true); });
        }));
      } else {
        bar.appendChild(hint('等房主开局…'));
      }
      return;
    }

    if (state.winner) {
      bar.appendChild(hint('牌局结束'));
      return;
    }

    var mine = me();
    if (mine && mine.bankrupt) {
      bar.appendChild(hint('你已经出局了，接着看戏吧'));
      return;
    }

    var acts = R.legalActions(state, seat.playerId);
    if (!acts.length) {
      var cur = R.findPlayer(state, state.currentPlayer);
      bar.appendChild(hint('等 <b>' + esc(cur ? cur.name : '对方') + '</b> 行动…'));
      return;
    }

    if (acts.indexOf('declare_bankrupt') !== -1) {
      bar.appendChild(btn('宣布破产', 'mono-btn--danger', function () { send('declare_bankrupt'); }));
      return;
    }
    if (acts.indexOf('card_ack') !== -1) {
      bar.appendChild(hint('先把卡牌确认了'));
      return;
    }
    if (acts.indexOf('roll') !== -1) {
      bar.appendChild(btn('掷骰子', 'mono-btn--primary', function () { send('roll'); }));
    }
    if (acts.indexOf('buy') !== -1) {
      var cell = R.cellAt(state, mine.pos) || {};
      bar.appendChild(btn('买下 ' + money(cell.price), 'mono-btn--primary', function () { send('buy'); }));
    }
    if (acts.indexOf('decline') !== -1) {
      bar.appendChild(btn('不买', '', function () { send('decline'); }));
    }
    if (acts.indexOf('pay_bail') !== -1) {
      bar.appendChild(btn('交保释金 ' + money(state.config.bail), '', function () { send('pay_bail'); }));
    }
    if (acts.indexOf('use_jail_card') !== -1) {
      bar.appendChild(btn('用出狱卡', '', function () { send('use_jail_card'); }));
    }
    if (acts.indexOf('build') !== -1) {
      bar.appendChild(btn('盖房', '', openBuildPicker));
    }
    if (acts.indexOf('end_turn') !== -1) {
      bar.appendChild(btn('结束回合', 'mono-btn--primary', function () { send('end_turn'); }));
    }

    function hint(html) {
      var d = document.createElement('div');
      d.className = 'mono-hint';
      d.innerHTML = html;
      return d;
    }
  }

  function openBuildPicker() {
    var idxs = R.buildableCells(state, seat.playerId);
    if (!idxs.length) { UI.toast('现在没有能盖房的地', true); return; }
    UI.pick({
      title: '在哪块地盖？',
      verb: '盖',
      rows: idxs.map(function (i) {
        var c = R.cellAt(state, i);
        return {
          idx: i,
          name: c.name,
          note: '已有 ' + R.housesOf(state, i) + ' 栋 · ' + money(c.houseCost)
        };
      }),
      onPick: function (i) { send('build', { cellIdx: i }); }
    });
  }

  // ── 欠款警示 ──────────────────────────────────────────────────────────────

  function renderAlert() {
    var el = $('r-alert');
    var d = state && state.pendingDebt;
    if (!d) { el.hidden = true; return; }
    var who = R.findPlayer(state, d.playerId);
    var cred = d.creditor ? R.findPlayer(state, d.creditor) : null;
    var mineDebt = seat && d.playerId === seat.playerId;
    el.hidden = false;
    el.innerHTML = mineDebt
      ? '你欠 ' + esc(cred ? cred.name : '银行') + ' ' + money(d.amount) + '，房子都卖光也补不上——只能宣布破产了。'
      : esc(who ? who.name : '有人') + ' 还不上 ' + money(d.amount) + '，等他宣布破产。';
  }

  // ── 棋盘 / 舞台 ───────────────────────────────────────────────────────────

  function ensureBoard() {
    if (boardUI) return;
    boardUI = BoardView.build($('r-board'), state.board);
    boardUI.center.innerHTML = centerHtml();
    zoom = BoardView.attachZoom($('r-stage'), $('r-canvas'), onStageTap);
    zoom.reset();
    $('r-zoom').hidden = false;
    window.addEventListener('resize', function () { if (zoom) zoom.reset(); });
  }

  // 缩放层用了 setPointerCapture，pointerup 的 target 会被重定向到视口，
  // 所以点中哪一格必须靠坐标反查。
  function onStageTap(e) {
    if (!state) return;
    var hit = document.elementFromPoint(e.clientX, e.clientY);
    var el = hit && hit.closest ? hit.closest('.mono-cell') : null;
    if (!el) return;
    openCell(Number(el.dataset.idx));
  }

  function openCell(idx) {
    var mine = me();
    var own = R.ownerOf(state, idx);
    var isMine = !!(mine && own && own.owner === mine.id && !state.winner);
    var canTouch = isMine && isMyTurn() && !state.pendingCard && !state.pendingDebt &&
      (state.phase === 'awaiting_roll' || state.phase === 'awaiting_end');
    var cell = R.cellAt(state, idx) || {};
    UI.cellDetail(state, idx, {
      canBuild: canTouch && cell.type === 'prop' && (own.houses || 0) < ((state.config && state.config.maxHouses) || 5),
      canSell: canTouch && (own && own.houses > 0),
      onBuild: function (i) { send('build', { cellIdx: i }); },
      onSell: function (i) { send('sell_house', { cellIdx: i }); }
    });
  }

  function renderWait() {
    var el = $('r-wait');
    if (state) { el.hidden = true; return; }
    el.hidden = false;
    var seats = (payload && payload.seats) || [];
    el.innerHTML = '<div class="box cn-card">' +
      '<div><div class="mono-eyebrow">房间号</div>' +
      '<h2 style="margin-top:6px;letter-spacing:.16em">' + esc(code) + '</h2></div>' +
      '<div class="sub">把房间号发给对面，他们在大厅点进来就能坐下。凑够 2 个人房主就能开局。</div>' +
      '<div class="mono-seatlist">' + (seats.length ? seats.map(function (s) {
        return '<div class="mono-seat"><span class="mono-dot" style="background:' + esc(s.color) + '"></span>' +
          '<span class="nm">' + esc(s.name) + '</span>' +
          '<span class="role">' + (s.isHost ? '房主' : '玩家') + '</span></div>';
      }).join('') : '<div class="lb-empty">还没人坐下</div>') + '</div>' +
      '</div>';
  }

  // ── 主渲染 ────────────────────────────────────────────────────────────────

  function render() {
    renderHeader();
    renderPlayers();
    renderWait();

    if (!state) {
      $('r-board').hidden = true;
      $('r-zoom').hidden = true;
      renderAlert();
      renderActions();
      return;
    }

    $('r-board').hidden = false;
    ensureBoard();
    BoardView.update(boardUI, state, {});
    renderCenter();
    renderAlert();
    renderActions();

    // 卡牌
    if (state.pendingCard) {
      var drawer = R.findPlayer(state, state.currentPlayer);
      UI.showCard(state.pendingCard.deck, state.pendingCard.card, {
        canAck: isMyTurn(),
        who: drawer ? drawer.name : '',
        onAck: function () { send('card_ack'); }
      });
    } else {
      UI.hideCard();
    }

    // 胜利屏
    if (state.winner) {
      var w = R.findPlayer(state, state.winner);
      UI.showWin(w ? w.name : '无人', state.players.map(function (p) { return p.color; }));
    } else {
      UI.hideWin();
    }

    // 轮到我了震一下（iOS PWA 没有 vibrate 就静默跳过）
    var mineTurn = isMyTurn() && !state.winner && !(me() || {}).bankrupt;
    if (mineTurn && !lastTurnMine && navigator.vibrate) {
      try { navigator.vibrate(30); } catch (e) { /* ignore */ }
    }
    lastTurnMine = mineTurn;
  }

  // ── 同步 ──────────────────────────────────────────────────────────────────

  function onPayload(p) {
    payload = p;
    state = p.state || null;
    render();
    maybeAskSeat();
  }

  function onStatus(s) {
    var el = $('r-conn');
    el.dataset.conn = s;
    el.querySelector('.tx').textContent = s === 'live' ? '已连接' : (s === 'polling' ? '轮询中' : '重连中');
  }

  // ── 入座 / 复座 ───────────────────────────────────────────────────────────

  function maybeAskSeat() {
    if (seat || joinAsked || !payload) return;
    if (payload.started) return;                 // 已开局且没座位 = 观战
    joinAsked = true;
    var last = API.loadMe();
    UI.joinDialog({
      taken: (payload.seats || []).map(function (s) { return s.color; }),
      name: last.name || '',
      preferColor: last.color,
      subtitle: '「' + (payload.name || code) + '」还没开局，坐下就能玩。',
      onSubmit: function (v) {
        API.joinRoom(code, { name: v.name, color: v.color }).then(function (r) {
          seat = r;
          API.saveSeat(code, r);
          API.saveMe({ name: r.name, color: r.color });
          UI.toast('坐好了，' + r.name);
          render();
        }, function (e) {
          UI.toast(e.message, true);
          joinAsked = false;
        });
      },
      onWatch: function () { UI.toast('观战模式，随便看'); }
    });
  }

  function boot() {
    if (!code) {
      document.body.innerHTML = '<div class="lb-empty" style="padding-top:80px">没给房间号，回大厅重来吧</div>';
      return;
    }
    $('r-code').textContent = code;

    var saved = API.loadSeat(code);
    var pre = saved && saved.playerToken
      ? API.joinRoom(code, { playerToken: saved.playerToken }).then(function (r) {
        seat = r;
        API.saveSeat(code, r);
      }, function () {
        API.clearSeat(code);          // token 失效（房间被清了/重建了）
      })
      : Promise.resolve();

    pre.then(function () {
      sync = API.openSync(code, onPayload, onStatus);
    });

    $('zoom-in').addEventListener('click', function () { if (zoom) zoom.zoomBy(1.25); });
    $('zoom-out').addEventListener('click', function () { if (zoom) zoom.zoomBy(0.8); });
    $('zoom-fit').addEventListener('click', function () { if (zoom) zoom.reset(); });
    $('r-back').innerHTML = UI.icon('back', 22);

    window.addEventListener('beforeunload', function () { if (sync) sync.close(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
