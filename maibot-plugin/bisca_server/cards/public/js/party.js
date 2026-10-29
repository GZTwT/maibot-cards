/* 群聊牌局入口：手机点一下入座，人满自动开局，其余交给 MaiBot。
 * 链接里的 invite 只访问这一桌；普通大厅/建房接口不因群邀请而对外开放。
 */
(function (global) {
  'use strict';

  var API = global.CdAPI;
  var UI = global.CdUI;
  var esc = UI.esc;
  var $ = function (id) { return document.getElementById(id); };

  var GAME_PAGE = { ddz: 'ddz.html', zjh: 'zjh.html', uno: 'uno.html' };
  var GAME_TEXT = {
    ddz: { name: '斗地主', need: 3, hint: '3 人成局：你、群友和 MaiBot' },
    zjh: { name: '炸金花', need: 2, hint: '2 人就能开局，MaiBot 自动接局' },
    uno: { name: 'UNO', need: 2, hint: '2 人就能开局，MaiBot 自动接局' }
  };
  // 群里开桌时能补位的自动 AI（MaiBot 固定座位不在此列）
  var AI_OPTIONS = [
    { id: 'opus', label: 'AI·Opus' },
    { id: 'sonnet', label: 'AI·Sonnet' },
    { id: 'haiku', label: 'AI·Haiku' }
  ];

  var code = (new URLSearchParams(location.search).get('c') || '').trim().toUpperCase();
  var paramInvite = new URLSearchParams(location.search).get('invite') || '';
  var invite = paramInvite;
  var state = null;
  var seat = null;
  var busy = false;
  var sync = null;
  var toastTimer = null;
  var stopped = false;

  function storedInvite() {
    try {
      if (paramInvite) sessionStorage.setItem('cd-invite', paramInvite);
      return paramInvite || sessionStorage.getItem('cd-invite') || '';
    } catch (e) { return paramInvite; }
  }

  function randomNick() {
    return '牌友' + String(Math.floor(Math.random() * 90) + 10);
  }

  function nick() {
    return ($('p-name').value || '').trim().slice(0, 16);
  }

  function gameOf() {
    return (state && state.game) || 'ddz';
  }

  function gameText() {
    return GAME_TEXT[gameOf()] || GAME_TEXT.ddz;
  }

  function roomHref(c, token) {
    var page = GAME_PAGE[gameOf()] || 'ddz.html';
    var q = '?c=' + encodeURIComponent(c);
    if (token || invite) q += '&invite=' + encodeURIComponent(token || invite);
    return page + q;
  }

  function shareHref() {
    var url = new URL('party.html', location.href);
    url.search = '';
    url.searchParams.set('c', code);
    if (invite) url.searchParams.set('invite', invite);
    return url.href;
  }

  function toast(text, bad) {
    var el = $('p-toast');
    el.textContent = text;
    el.classList.add('is-on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-on'); }, bad ? 3200 : 2400);
  }

  function note(text, kind) {
    var el = $('p-note');
    el.textContent = text || '';
    el.classList.toggle('is-bad', kind === 'bad');
    el.classList.toggle('is-ok', kind === 'ok');
  }

  function waitNote(text, kind) {
    var el = $('p-wait-note');
    el.textContent = text || '';
    el.classList.toggle('is-bad', kind === 'bad');
    el.classList.toggle('is-ok', kind === 'ok');
  }

  function setJoin(text, disabled) {
    $('p-join-text').textContent = text;
    $('p-join').disabled = !!disabled;
  }

  function copyText(text) {
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

  function share() {
    var url = shareHref();
    var text = gameText().name + '牌局 ' + code + '，点开就能一起打';
    if (navigator.share) {
      return navigator.share({ title: gameText().name + '牌局', text: text, url: url })
        .then(function () { toast('已分享'); }, function (e) {
          if (e && e.name === 'AbortError') return;
          return copyText(url).then(function () { toast('链接已复制，粘贴到群里'); });
        });
    }
    return copyText(url).then(function () { toast('链接已复制，粘贴到群里'); }, function () {
      UI.modal({
        html: '<h2>把链接发到群里</h2><p class="sub">长按下面链接选择复制。</p>' +
          '<textarea class="party-share-area" readonly rows="4">' + esc(url) + '</textarea>',
        onMount: function (h) {
          var ta = h.el.querySelector('.party-share-area');
          ta.focus(); ta.select();
        }
      });
    });
  }

  function playerTag(p) {
    var initial = String(p.name || '?').slice(0, 1);
    var isBot = !!(p.isAI || p.agentId);
    return '<span class="party-person' + (isBot ? ' bot' : '') + '" title="' + esc(p.name || '') + '">' +
      '<i>' + (isBot ? UI.ICON.robot(12) : esc(initial)) + '</i>' +
      esc(p.name || '牌友') + '</span>';
  }

  function firstHuman() {
    var seats = (state && state.seats) || [];
    return seats.find(function (s) { return !s.isAI; }) || null;
  }

  function canFill() {
    var first = firstHuman();
    return !!(seat && state && state.party && !state.started && !state.closed &&
      first && first.playerId === seat.playerId);
  }

  // 第一个真人：开局前加/移除自动 AI 补位，补满自动开局。
  var fillKey = '';
  function renderFill(force) {
    var box = $('p-fill');
    if (!box) return;
    var key = canFill()
      ? ((state.seats || []).map(function (s) {
        return s.playerId + ':' + (s.agentId || '');
      }).join(',') + '|' + (state.started ? 1 : 0) + '|' + (state.maxPlayers || 4))
      : '';
    // 轮询每 3 秒来一帧；内容没变就别重建按钮，免得点一半被换掉。
    if (!force && key === fillKey) { box.hidden = !key; return; }
    fillKey = key;
    if (!key) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    var seats = state.seats || [];
    var taken = {};
    var bots = seats.filter(function (s) {
      return s.isAI && s.agentId && s.agentId !== 'maibot';
    });
    bots.forEach(function (s) { taken[s.agentId] = true; });
    var full = seats.length >= (state.maxPlayers || 4);
    var html = '<div class="party-fill-head">AI 补位 <span>只有第一个入座的人能操作</span></div>' +
      '<div class="party-fill-row">';
    bots.forEach(function (s) {
      html += '<button class="party-fill-btn is-on" type="button" data-ai="' + esc(s.agentId) +
        '" data-act="remove">− ' + esc(s.name || s.agentId) + '</button>';
    });
    if (!full) {
      AI_OPTIONS.forEach(function (a) {
        if (taken[a.id]) return;
        html += '<button class="party-fill-btn" type="button" data-ai="' + a.id +
          '" data-act="add">+ ' + esc(a.label) + '</button>';
      });
    }
    html += '</div><p class="party-note">' +
      (full ? '已经补满，正在开局' : '补满会自动开局；不想跟 AI 打可以移掉') + '</p>';
    box.innerHTML = html;
  }

  function fillTap(e) {
    var btn = e.target && e.target.closest ? e.target.closest('button[data-ai]') : null;
    if (!btn || busy || !seat) return;
    busy = true;
    btn.disabled = true;
    var act = btn.getAttribute('data-act');
    API.partyAi(code, seat.playerToken, btn.getAttribute('data-ai'), act).then(function (r) {
      busy = false;
      if (act === 'add' && r && r.started) { location.href = roomHref(code); return; }
      return refresh();
    }, function (err) {
      busy = false;
      fillKey = '';
      toast(err.message || '补位失败，再试一次', true);
      render();
    });
  }

  function renderMembers() {
    var box = $('p-people');
    var seats = (state && state.seats) || [];
    var max = (state && state.maxPlayers) || 4;
    var out = seats.map(playerTag);
    for (var i = seats.length; i < Math.min(max, 4); i++) {
      out.push('<span class="party-person empty">空位</span>');
    }
    box.innerHTML = out.join('');
  }

  function validateSeat(s) {
    if (!s || !s.playerToken) return Promise.reject(new Error('没有座位凭证'));
    // 用旧 token 复座；不能走 inviteJoin，否则刷新一次就多占一个座位，
    // 人满会在真人没到齐时提前开局，多出来的空座位还会把叫分卡死。
    return API.rejoin(code, s.playerToken).then(function (r) {
      seat = Object.assign({}, s, r, { name: r.name || s.name });
      API.saveSeat(code, seat);
      API.saveMe({ name: seat.name });
      if (!($('p-name').value || '').trim()) $('p-name').value = seat.name || '';
      return seat;
    }, function () {
      API.clearSeat(code);
      seat = null;
      throw new Error('座位已失效');
    });
  }

  function restoreSeat() {
    var saved = API.loadSeat(code);
    if (!saved) return Promise.resolve();
    return validateSeat(saved).catch(function () { /* 让人重新入座 */ });
  }

  function join() {
    if (busy) return;
    if (!state) { toast('还没读到牌桌信息', true); return; }
    if (state.closed) { toast('这桌已经散了', true); return; }
    if (state.started) {
      location.href = roomHref(code);
      return;
    }
    var name = nick();
    if (!name) { note('先填写你的昵称', 'bad'); $('p-name').focus(); return; }
    busy = true;
    setJoin('正在入座…', true);
    note('');
    var p = invite ? API.inviteJoin(code, name, invite) : API.joinRoom(code, name);
    p.then(function (r) {
      seat = {
        playerId: r.playerId, playerToken: r.playerToken,
        name: r.name || name
      };
      API.saveSeat(code, seat);
      API.saveMe({ name: seat.name });
      busy = false;
      if (r.started) { location.href = roomHref(code); return; }
      return refresh();
    }).catch(function (e) {
      busy = false;
      setJoin('一键入座', false);
      note(e.message || '入座失败，再试一次', 'bad');
      toast(e.message || '入座失败', true);
    });
  }

  function leave() {
    if (!seat) return;
    if (!global.confirm('退出这桌？')) return;
    API.leaveRoom(code, seat.playerToken).then(function (r) {
      API.clearSeat(code);
      seat = null;
      stopped = true;
      stopSync();
      $('p-seat').hidden = true;
      $('p-wait').hidden = false;
      $('p-start').hidden = true;
      $('p-leave').hidden = true;
      $('p-wait-title').textContent = r && r.takeover ? '已离开，AI 接管' : '已退出这桌';
      $('p-wait-sub').textContent = r && r.roomClosed ? '桌上没人了，这桌已散' : '要再打就让群友重新发个开桌指令';
      waitNote('');
    }, function (e) {
      toast(e.message || '退出失败，再试一次', true);
    });
  }

  function render() {
    if (!state) return;
    var g = gameText();
    $('p-game').textContent = state.gameName || g.name;
    $('p-code').textContent = '房号 ' + code;
    $('p-title').textContent = state.name || (g.name + '牌局');

    var count = (state.seats || []).length;
    var min = state.minPlayers || g.need;
    var max = state.maxPlayers || 4;
    // 群聊桌的 UNO / 炸金花要满员才开；3 人（含 MaiBot）只开斗地主。
    var needFull = !state.started && state.party && state.game !== 'ddz';
    var need = needFull ? max : min;
    if (state.closed) {
      $('p-sub').textContent = '这桌已经散了';
    } else if (state.started) {
      $('p-sub').textContent = '牌局进行中 · ' + count + ' 人在桌上';
    } else {
      $('p-sub').textContent = count + '/' + max + ' 人在桌上 · ' +
        (count >= need ? '可以开局了' : (needFull ? ('要 ' + max + ' 人才能开 ' + g.name) : g.hint));
    }
    renderMembers();
    renderFill();

    if (state.closed) {
      $('p-seat').hidden = true;
      $('p-wait').hidden = false;
      $('p-wait-title').textContent = '房间已结束';
      $('p-wait-sub').textContent = '让群友重新发个开桌指令吧';
      $('p-start').hidden = true;
      $('p-leave').hidden = true;
      waitNote('');
      return;
    }

    if (seat) {
      $('p-seat').hidden = true;
      $('p-wait').hidden = false;
      $('p-leave').hidden = false;
      $('p-wait-title').textContent = state.started ? '牌局进行中' : ('你已入座，' + (seat.name || '牌友'));
      $('p-wait-sub').textContent = state.started ? '点下面按钮进入牌桌' :
        (count >= need ? '人齐了，正在自动开局…' : ('还差 ' + (need - count) + ' 人，人满自动开局'));

      if (state.started) {
        $('p-start').hidden = false;
        $('p-start').textContent = '进入牌桌';
        $('p-start').onclick = function () { location.href = roomHref(code); };
        $('p-start').disabled = false;
        waitNote('');
      } else {
        $('p-start').hidden = true;
        waitNote(needFull
          ? ('群聊桌「' + (state.gameName || '') + '」要 ' + max + ' 人才开；3 人请开斗地主')
          : 'MaiBot 已在座，人满自动开局');
      }
      return;
    }

    $('p-seat').hidden = false;
    $('p-wait').hidden = true;
    if (state.started) {
      $('p-seat').hidden = true;
      $('p-wait').hidden = false;
      $('p-wait-title').textContent = '牌局已经开始';
      $('p-wait-sub').textContent = '桌子没满，点下面进场观战';
      $('p-start').hidden = false;
      $('p-start').textContent = '进入观战';
      $('p-start').onclick = function () { location.href = roomHref(code); };
      $('p-start').disabled = false;
      waitNote('');
      return;
    }
    setJoin('一键入座', false);
    if (count >= max) {
      setJoin('这桌已满', true);
      note('桌子满了，可以看牌或等下一局', 'bad');
    } else {
      note('不用注册，填个昵称就能入座');
    }
  }

  function refresh() {
    if (stopped) return Promise.resolve();
    return (seat ? API.getState(code, seat.playerToken) : API.partyState(code, invite)).then(function (s) {
      state = s;
      render();
      if (s.closed || s.started) stopSync();
    }, function (e) {
      if (e.status === 404) {
        state = { closed: true, seats: [], game: gameOf(), name: '房间不存在' };
        $('p-title').textContent = '这张桌子不在了';
        $('p-sub').textContent = '群聊链接可能已过期，重新发一条开桌指令吧';
        $('p-seat').hidden = true;
        $('p-wait').hidden = true;
        stopSync();
        return;
      }
      if (e.status === 403) {
        state = { closed: true, seats: [], game: gameOf(), name: '邀请已失效' };
        $('p-title').textContent = '邀请链接已失效';
        $('p-sub').textContent = '让群友在群里重新发一次开桌指令';
        $('p-seat').hidden = true;
        $('p-wait').hidden = true;
        stopSync();
        return;
      }
      if (!state) {
        $('p-title').textContent = '暂时连不上牌桌';
        $('p-sub').textContent = e.message || '检查网络后点分享旁的按钮重试';
        note('下拉刷新页面再试一次', 'bad');
      }
    });
  }

  function stopSync() {
    if (sync) { sync.close(); sync = null; }
  }

  function startSync() {
    stopSync();
    if (stopped || document.hidden) return;
    sync = API.openSync(code, seat && seat.playerToken, function (p) {
      state = p;
      render();
      if (p.closed || p.started) stopSync();
    }, function () { /* SSE 自带 3s 轮询兜底 */ });
  }

  function boot() {
    $('p-link-ic').innerHTML = UI.ICON.plane(18);
    $('p-link-chev').innerHTML = UI.icon('chevron', 16);
    $('p-share').innerHTML = UI.ICON.plane(19);

    if (!code) {
      $('p-title').textContent = '缺房间号';
      $('p-sub').textContent = '这个链接不完整，请让群友重新发一次';
      $('p-seat').hidden = true;
      return;
    }
    invite = storedInvite();
    $('p-name').value = API.loadMe().name || randomNick();

    $('p-share').addEventListener('click', share);
    $('p-copy').addEventListener('click', share);
    $('p-join').addEventListener('click', join);
    $('p-fill').addEventListener('click', fillTap);
    $('p-leave').addEventListener('click', leave);
    $('p-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') join();
    });

    restoreSeat().then(refresh).then(startSync);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopSync();
      else refresh().then(startSync);
    });
    global.addEventListener('beforeunload', function () { stopped = true; stopSync(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
