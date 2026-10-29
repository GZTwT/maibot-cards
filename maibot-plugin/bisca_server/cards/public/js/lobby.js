/* Bisca 棋牌室 —— 大厅：选游戏 + 建房间（规则开关随 game 切换）+ 房间列表轮询
 * 规则开关表不在这儿写死：CdAPI.gameMeta(game) 去把引擎源码当模块加载，读它的 meta.ruleMeta。
 */
(function (global) {
  'use strict';

  var API = global.CdAPI;
  var UI = global.CdUI;
  var esc = UI.esc;
  var $ = function (id) { return document.getElementById(id); };

  var GAMES = ['ddz', 'zjh', 'uno'];
  var game = 'ddz';                 // 当前选中的游戏
  var metas = {};                   // game -> meta（引擎给的）
  var rulesByGame = {};             // game -> 规则值（切回来还在）
  var filter = 'all';               // 房间列表过滤
  var timer = null;

  function meta() { return metas[game] || null; }
  function rules() {
    if (!rulesByGame[game]) rulesByGame[game] = {};
    return rulesByGame[game];
  }

  // ── AI 玩家邀请（建房时勾选，房主入座后服务端自动落座）────────────────────
  // group: 'live' = 外接 agent，要外部程序经 bot API 替它出牌；
  //        'auto' = 服务端起 Claude Code CLI 自动出牌，轮到就自己动。
  var AI_ROSTER = [
    { id: 'external', label: '外接 Agent', note: '经 bot API 出牌，要外部程序在线', group: 'live' },
    { id: 'opus',     label: 'AI·Opus',   note: '自动出牌 · 随叫随到，脑子最好',    group: 'auto' },
    { id: 'sonnet',   label: 'AI·Sonnet', note: '自动出牌 · 随叫随到',             group: 'auto' },
    { id: 'haiku',    label: 'AI·Haiku',  note: '自动出牌 · 随叫随到，手最快',      group: 'auto' }
  ];
  var AI_GROUPS = [
    { id: 'live', title: '外接档 · 要外部程序在线' },
    { id: 'auto', title: '自动档 · 随叫随到' }
  ];
  var aiPicked = {};

  function aiCap() {
    var m = meta();
    return Math.max(0, ((m && m.maxPlayers) || 4) - 1);   // 留一个座位给你自己
  }

  function aiPickedList() {
    return AI_ROSTER.filter(function (a) { return aiPicked[a.id]; }).map(function (a) { return a.id; });
  }

  function aiToggleHtml(a) {
    return '<label class="cd-toggle' + (aiPicked[a.id] ? ' is-on' : '') + '" data-ai="' + esc(a.id) + '">' +
      '<span class="tx"><span class="k">' + esc(a.label) + '</span>' +
      '<span class="n">' + esc(a.note) + '</span></span>' +
      '<input type="checkbox"' + (aiPicked[a.id] ? ' checked' : '') + '>' +
      '<span class="sw"></span></label>';
  }

  function renderAI() {
    $('lb-ai').innerHTML = AI_GROUPS.map(function (g) {
      var list = AI_ROSTER.filter(function (a) { return a.group === g.id; });
      if (!list.length) return '';
      return '<div class="cd-ai-sec"><span class="cd-eyebrow">' + esc(g.title) + '</span></div>' +
        list.map(aiToggleHtml).join('');
    }).join('');
    $('lb-ai').querySelectorAll('.cd-toggle').forEach(function (el) {
      el.querySelector('input').addEventListener('change', function (e) {
        aiPicked[el.dataset.ai] = e.target.checked;
        el.classList.toggle('is-on', e.target.checked);
        aiSummary();
      });
    });
    aiSummary();
  }

  function aiSummary() {
    var on = AI_ROSTER.filter(function (a) { return aiPicked[a.id]; });
    var cap = aiCap();
    var el = $('lb-ai-sum');
    var m = meta();
    if (on.length > cap) {
      el.textContent = (m ? m.name : '这个游戏') + '最多 ' + ((m && m.maxPlayers) || 4) +
        ' 人，算上你只能再请 ' + cap + ' 位——先取消几个';
      el.classList.add('is-bad');
    } else {
      el.textContent = on.length
        ? on.map(function (a) { return a.label; }).join(' · ') + ' 会入座'
        : '这局只有人类（也可以之后再喊）';
      el.classList.remove('is-bad');
    }
  }

  // ── 游戏选择 ──────────────────────────────────────────────────────────────

  function gameLabel(g) {
    return (metas[g] && metas[g].name) || API.gameName(g);
  }

  function gameSeatsText(g) {
    var m = metas[g];
    if (!m) return '';
    return m.minPlayers === m.maxPlayers ? ('恰好 ' + m.minPlayers + ' 人')
      : (m.minPlayers + '~' + m.maxPlayers + ' 人');
  }

  function renderGames() {
    $('lb-games').innerHTML = GAMES.map(function (g) {
      var cat = (API.games() || []).filter(function (c) { return c.key === g; })[0];
      var down = cat && cat.ready === false;
      return '<button type="button" class="cd-gamepick' + (g === game ? ' is-on' : '') +
        (down ? ' is-down' : '') + '" data-game="' + g + '"' + (down ? ' disabled' : '') + '>' +
        '<span class="k">' + esc(gameLabel(g)) + '</span>' +
        '<span class="n">' + esc(down ? '引擎没就绪' : gameSeatsText(g)) + '</span></button>';
    }).join('');
    $('lb-games').querySelectorAll('.cd-gamepick').forEach(function (el) {
      el.addEventListener('click', function () { pickGame(el.dataset.game); });
    });
  }

  function pickGame(g) {
    if (!g || g === game) return;
    game = g;
    try { localStorage.setItem('cards_last_game', g); } catch (e) { /* 隐私模式写不了就算了 */ }
    renderGames();
    renderRules();
    aiSummary();
    ensureMeta(g).then(function () {
      if (game !== g) return;       // 加载期间用户又换了一个，别覆盖
      renderGames();
      renderRules();
      aiSummary();
    });
  }

  /** 拿引擎 meta（gameMeta 永不 reject，最差是「没有开关」） */
  function ensureMeta(g) {
    return API.gameMeta(g).then(function (m) {
      metas[g] = m;
      if (!rulesByGame[g]) rulesByGame[g] = API.ruleDefaults(m);
      else {
        var def = API.ruleDefaults(m);       // 引擎后到：补上没见过的开关，别丢用户改过的
        Object.keys(def).forEach(function (k) {
          if (rulesByGame[g][k] === undefined) rulesByGame[g][k] = def[k];
        });
      }
      return m;
    });
  }

  // ── 规则开关（布尔画开关，数字画输入框）──────────────────────────────────

  function ruleRowHtml(r, val) {
    if (typeof r.def === 'number') {
      return '<label class="cd-numrow" data-key="' + esc(r.key) + '">' +
        '<span class="tx"><span class="k">' + esc(r.label) + '</span>' +
        '<span class="n">' + esc(r.note || '') + '</span></span>' +
        '<input type="number" inputmode="numeric" min="1" step="1" value="' +
        esc(typeof val === 'number' ? val : r.def) + '"></label>';
    }
    return '<label class="cd-toggle' + (val ? ' is-on' : '') + '" data-key="' + esc(r.key) + '">' +
      '<span class="tx"><span class="k">' + esc(r.label) + '</span>' +
      '<span class="n">' + esc(r.note || '') + '</span></span>' +
      '<input type="checkbox"' + (val ? ' checked' : '') + '>' +
      '<span class="sw"></span></label>';
  }

  function renderRules() {
    var box = $('lb-rules');
    var m = meta();
    var list = (m && m.ruleMeta) || [];
    if (!list.length) {
      box.innerHTML = '<div class="cd-empty">' + (m ? '这个游戏没有可选开关，按标准规则打' : '开关加载中…') + '</div>';
      ruleSummary();
      return;
    }
    var vals = rules();
    box.innerHTML = list.map(function (r) { return ruleRowHtml(r, vals[r.key]); }).join('');

    box.querySelectorAll('.cd-toggle').forEach(function (el) {
      el.querySelector('input').addEventListener('change', function (e) {
        rules()[el.dataset.key] = e.target.checked;
        el.classList.toggle('is-on', e.target.checked);
        ruleSummary();
      });
    });
    box.querySelectorAll('.cd-numrow input').forEach(function (input) {
      input.addEventListener('change', function () {
        var key = input.parentNode.dataset.key;
        var n = parseInt(input.value, 10);
        if (!isFinite(n) || n < 1) n = 1;
        if (n > 1000000) n = 1000000;
        input.value = String(n);
        rules()[key] = n;
        ruleSummary();
      });
    });
    ruleSummary();
  }

  function ruleSummary() {
    var m = meta();
    var list = (m && m.ruleMeta) || [];
    if (!list.length) { $('lb-rules-sum').textContent = m ? '按标准规则打' : '加载中…'; return; }
    var vals = rules();
    var on = [];
    list.forEach(function (r) {
      if (typeof r.def === 'number') on.push(r.label + ' ' + (vals[r.key] == null ? r.def : vals[r.key]));
      else if (vals[r.key]) on.push(r.label);
    });
    $('lb-rules-sum').textContent = on.length ? on.join(' · ') : '全关（最朴素的打法）';
  }

  // ── 房间列表 ──────────────────────────────────────────────────────────────

  function statusOf(room) {
    var phase = room.phase;
    if (room.finished || phase === 'game_over') return { cls: 'is-done', tx: '已结束' };
    if (room.started || (phase && phase !== 'lobby' && phase !== 'waiting')) return { cls: 'is-live', tx: '进行中' };
    return { cls: 'is-open', tx: '等人中' };
  }

  /** 房间链接统一指 room.html（它查完 game 再跳对应牌桌页），invite 原样带过去 */
  function roomHref(code) {
    var inv = API.invite();
    return 'room.html?c=' + encodeURIComponent(code) + (inv ? '&invite=' + encodeURIComponent(inv) : '');
  }

  function roomCard(room) {
    var st = statusOf(room);
    var count = typeof room.playerCount === 'number' ? room.playerCount : (room.players || []).length;
    var max = room.maxPlayers || 4;
    var mine = API.loadSeat(room.code);
    var bits = [
      '<span class="cd-tag cd-tag--game">' + esc(room.gameName || API.gameName(room.game)) + '</span>',
      '<span class="cd-tag ' + st.cls + '">' + st.tx + '</span>',
      '<span>' + esc(room.code) + '</span>',
      '<span>' + count + '/' + max + ' 人</span>'
    ];
    if (room.round) bits.push('<span>第 ' + room.round + ' 轮</span>');
    if (room.hasAgents || (room.players || []).some(function (p) { return p && p.isAI; })) {
      bits.push('<span class="bot">' + UI.ICON.robot(12) + 'AI 在座</span>');
    }
    if (mine) bits.push('<span class="cd-mine">有你的座位</span>');

    var names = (room.players || []).map(function (p) {
      return '<span class="cd-pill">' + esc(p.name || '') + '</span>';
    }).join('');

    return '<a class="cn-card cd-room-card" href="' + esc(roomHref(room.code)) + '">' +
      '<div class="main">' +
      '<div class="nm">' + esc(room.name || '未命名房间') + '</div>' +
      '<div class="sub">' + bits.join('') + '</div>' +
      (names ? '<div class="who">' + names + '</div>' : '') +
      '</div>' +
      '<button class="cd-room-close" type="button" data-close="' + esc(room.code) + '" aria-label="关闭房间">' + UI.icon('door', 16) + '</button>' +
      '<span class="chev">' + UI.icon('chevron', 18) + '</span></a>';
  }

  // 大厅直接关房(不用进门)。cookie 即自家人权限,座位 token 有就带上(访客场景)。
  function closeFromLobby(code) {
    UI.modal({
      html: '<h2>关闭房间 ' + esc(code) + '？</h2>' +
        '<p class="sub">牌局和聊天记录会一起删掉，里面的人会被请回大厅。</p>' +
        '<div class="cd-modal-acts">' +
        '<button class="cd-btn" id="lc-no">留着</button>' +
        '<button class="cd-btn cd-btn--danger" id="lc-yes">关闭</button></div>',
      onMount: function (h) {
        h.el.querySelector('#lc-no').addEventListener('click', function () { h.close(); });
        h.el.querySelector('#lc-yes').addEventListener('click', function () {
          var mine = API.loadSeat(code);
          API.closeRoom(code, mine && mine.playerToken).then(function () {
            h.close();
            UI.toast('房间 ' + code + ' 关掉了');
            loadRooms(true);
            // 服务端先回 ok 再延迟 300ms 才删档，马上刷会把这张卡又拉回来——补一枪
            setTimeout(function () { loadRooms(true); }, 700);
          }, function (e) { UI.toast(e.message, true); });
        });
      }
    });
  }

  function renderFilter() {
    var tabs = [{ k: 'all', t: '全部' }].concat(GAMES.map(function (g) {
      return { k: g, t: gameLabel(g) };
    }));
    $('lb-filter').innerHTML = tabs.map(function (t) {
      return '<button type="button" class="cd-chip' + (filter === t.k ? ' is-on' : '') +
        '" data-filter="' + t.k + '">' + esc(t.t) + '</button>';
    }).join('');
    $('lb-filter').querySelectorAll('.cd-chip').forEach(function (el) {
      el.addEventListener('click', function () {
        filter = el.dataset.filter;
        renderFilter();
        renderRooms();
      });
    });
  }

  var lastRooms = [];

  function renderRooms() {
    var box = $('lb-rooms');
    var list = lastRooms.filter(function (r) { return filter === 'all' || r.game === filter; });
    if (!list.length) {
      box.innerHTML = '<div class="cd-empty">' +
        (filter === 'all' ? '还没有房间，上面开一间吧' : ('还没有' + gameLabel(filter) + '的房间')) + '</div>';
      return;
    }
    var rank = function (r) { var c = statusOf(r).cls; return c === 'is-open' ? 0 : (c === 'is-live' ? 1 : 2); };
    list.sort(function (a, b) { return rank(a) - rank(b); });
    box.innerHTML = list.map(roomCard).join('');
    box.querySelectorAll('.cd-room-close').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();       // 按钮长在 <a> 卡片里,不拦会顺便进房
        e.stopPropagation();
        closeFromLobby(el.dataset.close);
      });
    });
  }

  function loadRooms(quiet) {
    return API.listRooms().then(function (d) {
      lastRooms = d.rooms || d.list || [];
      if (!loadRooms.seeded) {         // 服务端目录到了：游戏按钮上的人数/就绪状态跟着更新
        loadRooms.seeded = true;
        renderGames();
        renderFilter();
      }
      renderRooms();
    }, function (e) {
      if (!quiet) $('lb-rooms').innerHTML = '<div class="cd-empty">' + esc(e.message) + '</div>';
    });
  }

  // ── 建房 ──────────────────────────────────────────────────────────────────

  function create() {
    var btn = $('lb-create');
    var roomName = ($('lb-room').value || '').trim();
    var myName = ($('lb-name').value || '').trim();
    if (!myName) { UI.toast('先起个昵称', true); $('lb-name').focus(); return; }
    var picks = aiPickedList();
    if (picks.length > aiCap()) {
      UI.toast('人太多了：' + gameLabel(game) + '最多 ' + ((meta() && meta().maxPlayers) || 4) +
        ' 人，算上你只能再请 ' + aiCap() + ' 位', true);
      return;
    }
    btn.disabled = true;
    API.createRoom(game, roomName || '未命名房间', rules(), picks).then(function (r) {
      return API.joinRoom(r.code, myName).then(function (seat) {
        API.saveSeat(r.code, Object.assign({ name: myName, isHost: true }, seat));
        API.saveMe({ name: myName });
        location.href = roomHref(r.code);
      });
    }).catch(function (e) {
      btn.disabled = false;
      UI.toast(e.message, true);
    });
  }

  // 群聊开桌：服务端固定放一只 MaiBot，这里只负责生成可转发的入桌链接。
  function copyLink(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok ? Promise.resolve() : Promise.reject(new Error('复制失败'));
  }

  function partyShare(r) {
    var text = (r.gameName || gameLabel(r.game)) + '牌局 ' + r.code + '，点开就能一起打';
    if (navigator.share) {
      return navigator.share({ title: r.name, text: text, url: r.inviteUrl }).then(function () {
        UI.toast('已分享');
      }, function (e) {
        if (e && e.name === 'AbortError') return;
        return copyLink(r.inviteUrl).then(function () { UI.toast('链接已复制'); });
      });
    }
    return copyLink(r.inviteUrl).then(function () { UI.toast('链接已复制'); });
  }

  function party() {
    var btn = $('lb-party');
    var myName = ($('lb-name').value || '').trim();
    if (!myName) { UI.toast('先起个昵称', true); $('lb-name').focus(); return; }
    btn.disabled = true;
    API.createParty(game, ($('lb-room').value || '').trim() || (myName + '的牌局'), myName, rules()).then(function (r) {
      btn.disabled = false;
      API.saveSeat(r.code, Object.assign({ name: r.host.name, isHost: true }, r.host));
      API.saveMe({ name: r.host.name });
      var open = 'party.html?c=' + encodeURIComponent(r.code) +
        '&invite=' + encodeURIComponent(r.inviteUrl.split('invite=')[1] || '');
      UI.modal({
        html: '<h2>群聊牌桌已开好</h2>' +
          '<p class="sub">' + esc(r.name) + ' · ' + esc(r.gameName) + '<br>' +
          'MaiBot 已经入座。把链接发到群里，群友点开就能入座。</p>' +
          '<textarea class="party-share-area" readonly rows="3">' + esc(r.inviteUrl) + '</textarea>' +
          '<div class="cd-modal-acts">' +
          '<button class="cd-btn" id="lp-share">分享</button>' +
          '<button class="cd-btn cd-btn--primary" id="lp-open">进入牌桌</button></div>',
        onMount: function (h) {
          var ta = h.el.querySelector('.party-share-area');
          ta.addEventListener('focus', function () { ta.select(); });
          h.el.querySelector('#lp-share').addEventListener('click', function () {
            partyShare(r).catch(function (e) { UI.toast(e.message, true); });
          });
          h.el.querySelector('#lp-open').addEventListener('click', function () {
            location.href = open;
          });
          copyLink(r.inviteUrl).catch(function () {});
        }
      });
    }, function (e) {
      btn.disabled = false;
      UI.toast(e.message, true);
    });
  }

  // ── 启动 ──────────────────────────────────────────────────────────────────

  function boot() {
    $('lb-ic-new').innerHTML = UI.icon('plus', 18);
    $('lb-ic-rule').innerHTML = UI.icon('ruler', 16);
    $('lb-ic-ai').innerHTML = UI.ICON.robot(16);
    $('lb-name').value = API.loadMe().name || '';

    try {
      var last = localStorage.getItem('cards_last_game');
      if (last && GAMES.indexOf(last) !== -1) game = last;
    } catch (e) { /* 读不到就默认斗地主 */ }

    renderGames();
    renderFilter();
    renderRules();
    renderAI();

    // 三个引擎的 meta 都先拉一遍：按钮上的人数、切换时的开关表都靠它
    GAMES.forEach(function (g) {
      ensureMeta(g).then(function () {
        renderGames();
        renderFilter();
        if (g === game) { renderRules(); aiSummary(); }
      });
    });

    $('lb-help').addEventListener('click', function () { UI.rulesHelp(game); });
    $('lb-create').addEventListener('click', create);
    $('lb-ic-party').innerHTML = UI.ICON.robot(18);
    $('lb-party-chev').innerHTML = UI.icon('chevron', 16);
    $('lb-party').addEventListener('click', party);
    $('lb-refresh').addEventListener('click', function () { loadRooms(); });

    loadRooms();
    timer = setInterval(function () {
      if (!document.hidden) loadRooms(true);
    }, 5000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) loadRooms(true);
    });
    window.addEventListener('beforeunload', function () { if (timer) clearInterval(timer); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
