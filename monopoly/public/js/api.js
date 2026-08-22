/* Bisca 大富翁 —— 后端封装
 * ① REST（错误一律抛成带中文 message 的 Error，调用方直接 toast）
 * ② openSync：SSE 主链路 + 断线 3s 重连 + 连续 3 次失败退化成 3s 轮询；seq 只前进不回退
 * ③ 座位 token 的 localStorage 存取（按房间码分键）
 */
(function (global) {
  'use strict';

  var BASE = '/monopoly/api';

  function url(p) { return BASE + p; }

  function req(p, opts) {
    var o = Object.assign({ credentials: 'same-origin' }, opts || {});
    o.headers = Object.assign({ 'content-type': 'application/json' }, o.headers || {});
    return fetch(url(p), o).then(function (r) {
      return r.text().then(function (raw) {
        var body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch (e) { body = {}; }
        if (!r.ok || body.error) {
          var err = new Error(body.error || ('请求失败了（' + r.status + '）'));
          err.status = r.status;
          throw err;
        }
        return body;
      });
    }, function () {
      throw new Error('连不上服务器，等会儿再试试');
    });
  }

  function post(p, body) {
    return req(p, { method: 'POST', body: JSON.stringify(body || {}) });
  }

  // ── REST ──────────────────────────────────────────────────────────────────

  function listRooms() { return req('/rooms'); }

  function createRoom(name) { return post('/rooms', { name: name }); }

  function joinRoom(code, body) { return post('/rooms/' + code + '/join', body); }

  function startRoom(code, playerToken) { return post('/rooms/' + code + '/start', { playerToken: playerToken }); }

  function getState(code) { return req('/rooms/' + code + '/state'); }

  function action(code, playerToken, type, extra) {
    var body = Object.assign({}, extra || {}, { playerToken: playerToken, type: type });
    return post('/rooms/' + code + '/action', body);
  }

  // ── 同步 ──────────────────────────────────────────────────────────────────

  /**
   * openSync(code, onPayload, onStatus) -> {close()}
   * onStatus 收 'live' | 'retry' | 'polling'
   */
  function openSync(code, onPayload, onStatus) {
    var es = null, fails = 0, poll = null, retry = null, closed = false, lastSeq = -1;

    function status(s) { if (onStatus) { try { onStatus(s); } catch (e) { /* 状态回调炸了不影响同步 */ } } }

    function deliver(payload) {
      if (!payload || closed) return;
      var seq = typeof payload.seq === 'number' ? payload.seq : 0;
      if (seq < lastSeq) return;          // 旧 seq 直接丢，不让画面回退
      lastSeq = seq;
      onPayload(payload);
    }

    function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

    function startPoll() {
      if (poll || closed) return;
      status('polling');
      var tick = function () {
        if (closed) return;
        getState(code).then(deliver, function () { /* 轮询失败继续下一轮 */ });
      };
      tick();
      poll = setInterval(tick, 3000);
    }

    function connect() {
      if (closed) return;
      try {
        es = new EventSource(url('/rooms/' + code + '/events'));
      } catch (e) {
        startPoll();
        return;
      }
      es.addEventListener('state', function (ev) {
        fails = 0;
        stopPoll();
        status('live');
        var payload = null;
        try { payload = JSON.parse(ev.data); } catch (e) { return; }
        deliver(payload);
      });
      es.onerror = function () {
        if (closed) return;
        try { es.close(); } catch (e) { /* ignore */ }
        es = null;
        fails += 1;
        if (fails >= 3) { status('polling'); startPoll(); } else { status('retry'); }
        if (retry) clearTimeout(retry);
        retry = setTimeout(connect, fails >= 3 ? 15000 : 3000);
      };
    }

    connect();

    return {
      close: function () {
        closed = true;
        stopPoll();
        if (retry) clearTimeout(retry);
        if (es) { try { es.close(); } catch (e) { /* ignore */ } }
      }
    };
  }

  // ── 座位 token（按房间码存）────────────────────────────────────────────────

  function seatKey(code) { return 'monopoly_seat_' + code; }

  function loadSeat(code) {
    try { return JSON.parse(localStorage.getItem(seatKey(code)) || 'null'); } catch (e) { return null; }
  }
  function saveSeat(code, seat) {
    try { localStorage.setItem(seatKey(code), JSON.stringify(seat)); } catch (e) { /* 隐私模式写不了就算了 */ }
  }
  function clearSeat(code) {
    try { localStorage.removeItem(seatKey(code)); } catch (e) { /* ignore */ }
  }

  /** 上一次用过的昵称/颜色，方便下次直接带出来 */
  function loadMe() {
    try { return JSON.parse(localStorage.getItem('monopoly_me') || 'null') || {}; } catch (e) { return {}; }
  }
  function saveMe(me) {
    try { localStorage.setItem('monopoly_me', JSON.stringify(me)); } catch (e) { /* ignore */ }
  }

  // 8 色棋子板。后端只收 #rrggbb，所以这里必须是 hex（属于数据色，不走 token）。
  var COLORS = [
    { hex: '#ff5c8a', name: '玫红' },
    { hex: '#5cc8ff', name: '湖蓝' },
    { hex: '#ffd45c', name: '姜黄' },
    { hex: '#7dff9e', name: '薄荷' },
    { hex: '#c08bff', name: '藕紫' },
    { hex: '#ff9f5c', name: '橘橙' },
    { hex: '#63e6c3', name: '青瓷' },
    { hex: '#a8b6ff', name: '雾蓝' }
  ];

  global.MonoAPI = {
    COLORS: COLORS,
    listRooms: listRooms,
    createRoom: createRoom,
    joinRoom: joinRoom,
    startRoom: startRoom,
    getState: getState,
    action: action,
    openSync: openSync,
    loadSeat: loadSeat,
    saveSeat: saveSeat,
    clearSeat: clearSeat,
    loadMe: loadMe,
    saveMe: saveMe
  };
})(window);
