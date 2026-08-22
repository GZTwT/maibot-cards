/* 大富豪 —— 大厅：建房间（含规则开关折叠面板）+ 房间列表轮询 */
(function (global) {
  'use strict';

  var API = global.DfAPI;
  var UI = global.DfUI;
  var esc = global.DfCards.esc;
  var $ = function (id) { return document.getElementById(id); };

  var rules = API.ruleDefaults(null);     // 先摆 SPEC 默认，大厅接口回来了再覆盖
  var timer = null;

  // ── AI 玩家邀请（建房时勾选，房主入座后服务端自动落座）────────────────────
  // group: 'live' = 外接 agent 座位，等外部程序经 bot API 出牌；'auto' = 服务端自己驱动的 AI。
  var AI_ROSTER = [
    { id: 'external', label: '外接 Agent',  note: '经 bot API 出牌，要外部程序接上', group: 'live' },
    { id: 'opus',     label: 'AI·Opus',    note: '自动出牌 · 随叫随到，脑子最好',    group: 'auto' },
    { id: 'sonnet',   label: 'AI·Sonnet',  note: '自动出牌 · 随叫随到',             group: 'auto' },
    { id: 'haiku',    label: 'AI·Haiku',   note: '自动出牌 · 随叫随到，手最快',      group: 'auto' }
  ];
  var AI_GROUPS = [
    { id: 'live', title: '外接档 · 自己接程序' },
    { id: 'auto', title: '自动档 · 随叫随到' }
  ];
  var aiPicked = {};

  function aiToggleHtml(a) {
    return '<label class="df-toggle' + (aiPicked[a.id] ? ' is-on' : '') + '" data-ai="' + esc(a.id) + '">' +
      '<span class="tx"><span class="k">' + esc(a.label) + '</span>' +
      '<span class="n">' + esc(a.note) + '</span></span>' +
      '<input type="checkbox"' + (aiPicked[a.id] ? ' checked' : '') + '>' +
      '<span class="sw"></span></label>';
  }

  function renderAI() {
    $('lb-ai').innerHTML = AI_GROUPS.map(function (g) {
      var list = AI_ROSTER.filter(function (a) { return a.group === g.id; });
      if (!list.length) return '';
      return '<div class="df-ai-sec"><span class="df-eyebrow">' + esc(g.title) + '</span></div>' +
        list.map(aiToggleHtml).join('');
    }).join('');
    $('lb-ai').querySelectorAll('.df-toggle').forEach(function (el) {
      el.querySelector('input').addEventListener('change', function (e) {
        aiPicked[el.dataset.ai] = e.target.checked;
        el.classList.toggle('is-on', e.target.checked);
        aiSummary();
      });
    });
    aiSummary();
  }

  function aiPickedList() {
    return AI_ROSTER.filter(function (a) { return aiPicked[a.id]; }).map(function (a) { return a.id; });
  }

  function aiSummary() {
    var on = AI_ROSTER.filter(function (a) { return aiPicked[a.id]; }).map(function (a) { return a.label; });
    $('lb-ai-sum').textContent = on.length ? on.join(' · ') + ' 会入座' : '这局只有人类（也可以之后再喊）';
  }

  // ── 规则开关 ──────────────────────────────────────────────────────────────

  function renderRules() {
    $('lb-rules').innerHTML = API.RULE_META.map(function (r) {
      return '<label class="df-toggle' + (rules[r.key] ? ' is-on' : '') + '" data-key="' + r.key + '">' +
        '<span class="tx"><span class="k">' + esc(r.label) + '</span>' +
        '<span class="n">' + esc(r.note) + '</span></span>' +
        '<input type="checkbox"' + (rules[r.key] ? ' checked' : '') + '>' +
        '<span class="sw"></span></label>';
    }).join('');
    $('lb-rules').querySelectorAll('.df-toggle').forEach(function (el) {
      el.querySelector('input').addEventListener('change', function (e) {
        rules[el.dataset.key] = e.target.checked;
        el.classList.toggle('is-on', e.target.checked);
        summary();
      });
    });
    summary();
  }

  function summary() {
    var on = API.RULE_META.filter(function (r) { return rules[r.key]; }).map(function (r) { return r.label; });
    $('lb-rules-sum').textContent = on.length ? on.join(' · ') : '全关（最朴素的打法）';
  }

  // ── 房间列表 ──────────────────────────────────────────────────────────────

  function statusOf(room) {
    var phase = room.phase;
    if (room.finished || phase === 'game_over') return { cls: 'is-done', tx: '已结束' };
    if (room.started || (phase && phase !== 'lobby' && phase !== 'waiting')) return { cls: 'is-live', tx: '进行中' };
    return { cls: 'is-open', tx: '等人中' };
  }

  function roomCard(room) {
    var st = statusOf(room);
    var count = typeof room.playerCount === 'number' ? room.playerCount : (room.players || []).length;
    var max = room.maxPlayers || 4;
    var mine = API.loadSeat(room.code);
    var bits = [
      '<span class="df-tag ' + st.cls + '">' + st.tx + '</span>',
      '<span>' + esc(room.code) + '</span>',
      '<span>' + count + '/' + max + ' 人</span>'
    ];
    if (room.round) bits.push('<span>第 ' + room.round + ' 轮</span>');
    if (room.hasAgents || (room.players || []).some(function (p) { return p && p.isAI; })) {
      bits.push('<span class="bot">' + UI.ICON.robot(12) + 'AI 在座</span>');
    }
    if (mine) bits.push('<span class="df-mine">有你的座位</span>');

    var names = (room.players || []).map(function (p) {
      return '<span class="df-pill">' + esc(p.name || '') + '</span>';
    }).join('');

    return '<a class="cn-card df-room-card" href="room.html?c=' + esc(room.code) + '">' +
      '<div class="main">' +
      '<div class="nm">' + esc(room.name || '未命名房间') + '</div>' +
      '<div class="sub">' + bits.join('') + '</div>' +
      (names ? '<div class="who">' + names + '</div>' : '') +
      '</div>' +
      '<button class="df-room-close" type="button" data-close="' + esc(room.code) + '" aria-label="关闭房间">' + UI.icon('door', 16) + '</button>' +
      '<span class="chev">' + UI.icon('chevron', 18) + '</span></a>';
  }

  // 大厅直接关房(不用进门)。cookie 即自家人权限,座位 token 有就带上(访客场景)。
  function closeFromLobby(code) {
    UI.modal({
      html: '<h2>关闭房间 ' + esc(code) + '？</h2>' +
        '<p class="sub">牌局和聊天记录会一起删掉，里面的人会被请回大厅。</p>' +
        '<div class="df-modal-acts">' +
        '<button class="df-btn" id="lc-no">留着</button>' +
        '<button class="df-btn df-btn--danger" id="lc-yes">关闭</button></div>',
      onMount: function (h) {
        h.el.querySelector('#lc-no').addEventListener('click', function () { h.close(); });
        h.el.querySelector('#lc-yes').addEventListener('click', function () {
          var mine = API.loadSeat(code);
          API.closeRoom(code, mine && mine.playerToken).then(function () {
            h.close();
            UI.toast('房间 ' + code + ' 关掉了');
            loadRooms(true);
          }, function (e) { UI.toast(e.message, true); });
        });
      }
    });
  }

  function loadRooms(quiet) {
    return API.listRooms().then(function (d) {
      var next = API.ruleDefaults(d);
      // 只在用户还没动过开关时跟随服务端默认值（第一次加载）
      if (!loadRooms.seeded) {
        rules = next;
        loadRooms.seeded = true;
        renderRules();
      }
      var list = d.rooms || d.list || [];
      var box = $('lb-rooms');
      if (!list.length) {
        box.innerHTML = '<div class="df-empty">还没有房间，上面开一间吧</div>';
        return;
      }
      var rank = function (r) { return statusOf(r).cls === 'is-open' ? 0 : (statusOf(r).cls === 'is-live' ? 1 : 2); };
      list.sort(function (a, b) { return rank(a) - rank(b); });
      box.innerHTML = list.map(roomCard).join('');
      box.querySelectorAll('.df-room-close').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();       // 按钮长在 <a> 卡片里,不拦会顺便进房
          e.stopPropagation();
          closeFromLobby(el.dataset.close);
        });
      });
    }, function (e) {
      if (!quiet) $('lb-rooms').innerHTML = '<div class="df-empty">' + esc(e.message) + '</div>';
    });
  }

  // ── 建房 ──────────────────────────────────────────────────────────────────

  function create() {
    var btn = $('lb-create');
    var roomName = ($('lb-room').value || '').trim();
    var myName = ($('lb-name').value || '').trim();
    if (!myName) { UI.toast('先起个昵称', true); $('lb-name').focus(); return; }
    btn.disabled = true;
    API.createRoom(roomName || '未命名房间', rules, aiPickedList()).then(function (r) {
      return API.joinRoom(r.code, myName).then(function (seat) {
        API.saveSeat(r.code, Object.assign({ name: myName, isHost: true }, seat));
        API.saveMe({ name: myName });
        location.href = 'room.html?c=' + encodeURIComponent(r.code);
      });
    }).catch(function (e) {
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
    renderRules();
    renderAI();

    $('lb-help').addEventListener('click', function () { UI.rulesHelp(); });
    $('lb-create').addEventListener('click', create);
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
