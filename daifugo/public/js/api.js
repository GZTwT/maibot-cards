/* 大富豪 —— 后端封装
 * ① REST（错误一律抛成带中文 message 的 Error，调用方直接 toast）
 * ② openSync：SSE 主链路 + 断线 3s 重连 + 连续 3 次失败退化成 3s 轮询；seq 只前进不回退
 * ③ 座位 token 的 localStorage 存取（按房间码分键）
 * 注意：大富豪的推送是「按你视角脱敏后的 view」，不是全量 state——
 *      同一个房间，两条连接收到的东西不一样，所以 token 必须进 SSE / state 的 query。
 */
(function (global) {
  'use strict';

  var BASE = '/daifugo/api';

  function url(p) { return BASE + p; }

  // 访客邀请：链接上的 ?invite= 记下来，之后所有 API/SSE 都带着走
  // （EventSource 不能加 header，所以 query 也要带；刷新丢参靠 sessionStorage 续命）
  var INVITE = (function () {
    try {
      var q = new URLSearchParams(location.search).get('invite');
      if (q) { sessionStorage.setItem('df-invite', q); return q; }
      return sessionStorage.getItem('df-invite') || '';
    } catch (e) { return ''; }
  })();

  function qs(token) {
    var parts = [];
    if (token) parts.push('token=' + encodeURIComponent(token));
    if (INVITE) parts.push('invite=' + encodeURIComponent(INVITE));
    return parts.length ? ('?' + parts.join('&')) : '';
  }

  function req(p, opts) {
    var o = Object.assign({ credentials: 'same-origin' }, opts || {});
    o.headers = Object.assign({ 'content-type': 'application/json' }, o.headers || {});
    if (INVITE) o.headers['x-invite-token'] = INVITE;
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

  // ── 规则开关（默认值见设计文档；服务端 config.defaults 下发时以它为准）──────────

  var RULE_META = [
    { key: 'spade3', label: 'スペ3 反杀', note: '单张王被黑桃3 打掉', def: true },
    { key: 'shibari', label: '縛り（锁花色）', note: '同花色连出两手 → 本墩锁花色', def: false },
    { key: 'kaidan_revolution', label: '阶梯革命', note: '5 张以上阶梯也翻天', def: false },
    { key: 'forbid_finish', label: '禁止上がり', note: '最后一手 2/王/8 收尾 = 判垫底', def: true },
    { key: 'miyako_ochi', label: '都落ち', note: '上轮大富豪没先出完 → 直接降大贫民', def: false }
  ];

  function ruleDefaults(payload) {
    var out = {};
    RULE_META.forEach(function (r) { out[r.key] = r.def; });
    // 大厅接口可能顺带下发服务端默认值，字段名不确定，能认几个是几个
    var src = payload && (payload.defaults || payload.ruleDefaults || payload.rules);
    if (src && typeof src === 'object') {
      RULE_META.forEach(function (r) {
        if (typeof src[r.key] === 'boolean') out[r.key] = src[r.key];
      });
    }
    return out;
  }

  // ── REST ──────────────────────────────────────────────────────────────────

  function listRooms() { return req('/rooms'); }

  function createRoom(name, rules, aiPlayers) {
    var body = { name: name };
    if (rules) body.rules = rules;
    if (aiPlayers && aiPlayers.length) body.ai_players = aiPlayers;
    return post('/rooms', body);
  }

  function joinRoom(code, name) { return post('/rooms/' + code + '/join', { name: name }); }

  /** 带旧 token 回来 = 复座（服务端认了就把座位原样还回来，含 isHost） */
  function rejoin(code, playerToken) { return post('/rooms/' + code + '/join', { playerToken: playerToken }); }

  function startRoom(code, playerToken) { return post('/rooms/' + code + '/start', { playerToken: playerToken }); }

  function closeRoom(code, playerToken) { return post('/rooms/' + code + '/close', { playerToken: playerToken }); }

  function getState(code, token) { return req('/rooms/' + code + '/state' + qs(token)); }

  function action(code, playerToken, type, extra) {
    var body = Object.assign({}, extra || {}, { playerToken: playerToken, type: type });
    return post('/rooms/' + code + '/action', body);
  }

  /**
   * 牌桌聊天：sendChat(code, {playerToken, name, text})
   * 有座位带 playerToken（服务端按座位认人）；观战没座位，报个 name 就能说话。
   */
  function sendChat(code, opts) {
    var o = opts || {};
    var body = { text: o.text };
    if (o.playerToken) body.playerToken = o.playerToken;
    if (o.name) body.name = o.name;
    return post('/rooms/' + code + '/chat', body);
  }

  // ── 同步 ──────────────────────────────────────────────────────────────────

  /**
   * openSync(code, token, onPayload, onStatus) -> {close()}
   * onStatus 收 'live' | 'retry' | 'polling'
   */
  function openSync(code, token, onPayload, onStatus) {
    var es = null, fails = 0, poll = null, retry = null, closed = false, lastSeq = -1;

    function status(s) { if (onStatus) { try { onStatus(s); } catch (e) { /* 状态回调炸了不影响同步 */ } } }

    function deliver(payload) {
      if (!payload || closed) return;
      var seq = payload.seq;
      if (typeof seq !== 'number' && payload.state) seq = payload.state.seq;
      if (typeof seq !== 'number') seq = lastSeq + 1;
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
        getState(code, token).then(deliver, function () { /* 轮询失败继续下一轮 */ });
      };
      tick();
      poll = setInterval(tick, 3000);
    }

    function onEvent(ev) {
      fails = 0;
      stopPoll();
      status('live');
      var payload = null;
      try { payload = JSON.parse(ev.data); } catch (e) { return; }
      deliver(payload);
    }

    function connect() {
      if (closed) return;
      try {
        es = new EventSource(url('/rooms/' + code + '/events') + qs(token));
      } catch (e) {
        startPoll();
        return;
      }
      // 服务端事件名照 monopoly 叫 'state'；万一是默认消息也接得住
      es.addEventListener('state', onEvent);
      es.addEventListener('view', onEvent);
      es.onmessage = onEvent;
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

  // ── 座位 token（按房间码存，断线复座靠它）──────────────────────────────────

  function seatKey(code) { return 'daifugo_seat_' + code; }

  function loadSeat(code) {
    try { return JSON.parse(localStorage.getItem(seatKey(code)) || 'null'); } catch (e) { return null; }
  }
  function saveSeat(code, seat) {
    try { localStorage.setItem(seatKey(code), JSON.stringify(seat)); } catch (e) { /* 隐私模式写不了就算了 */ }
  }
  function clearSeat(code) {
    try { localStorage.removeItem(seatKey(code)); } catch (e) { /* ignore */ }
  }

  /** 上一次用过的昵称，方便下次直接带出来 */
  function loadMe() {
    try { return JSON.parse(localStorage.getItem('daifugo_me') || 'null') || {}; } catch (e) { return {}; }
  }
  function saveMe(me) {
    try { localStorage.setItem('daifugo_me', JSON.stringify(me)); } catch (e) { /* ignore */ }
  }

  global.DfAPI = {
    RULE_META: RULE_META,
    ruleDefaults: ruleDefaults,
    listRooms: listRooms,
    createRoom: createRoom,
    joinRoom: joinRoom,
    rejoin: rejoin,
    startRoom: startRoom,
    closeRoom: closeRoom,
    getState: getState,
    action: action,
    sendChat: sendChat,
    openSync: openSync,
    loadSeat: loadSeat,
    saveSeat: saveSeat,
    clearSeat: clearSeat,
    loadMe: loadMe,
    saveMe: saveMe
  };
})(window);
