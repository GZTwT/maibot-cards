/* Bisca 棋牌室 —— 后端封装（范式照抄 daifugo/public/js/api.js，BASE 换成 /cards/api）
 * ① REST（错误一律抛成带中文 message 的 Error，调用方直接 toast）
 * ② openSync：SSE 主链路 + 3s 轮询常开（隧道会缓冲 SSE）+ 断线重连；seq 只前进不回退
 * ③ 座位 token 的 localStorage 存取（按房间码分键）
 * ④ gameMeta(game)：规则开关表**不在前端硬编码**，从 GET /cards/engine/<game>.js
 *    把引擎源码当模块加载，读它挂的 window 全局（DdzEngine / ZjhEngine / UnoEngine）拿 meta。
 * 注意：推送是「按你视角脱敏后的 view」，不是全量 state——
 *      同一个房间，两条连接收到的东西不一样，所以 token 必须进 SSE / state 的 query。
 */
(function (global) {
  'use strict';

  var BASE = '/cards/api';
  var VER = '20260819cards';

  function url(p) { return BASE + p; }

  // 访客邀请：链接上的 ?invite= 记下来，之后所有 API/SSE 都带着走
  // （EventSource 不能加 header，所以 query 也要带；刷新丢参靠 sessionStorage 续命）
  function readInvite() {
    try {
      var q = new URLSearchParams(location.search).get('invite');
      if (q) { sessionStorage.setItem('cd-invite', q); return q; }
      return sessionStorage.getItem('cd-invite') || '';
    } catch (e) { return ''; }
  }
  var INVITE = readInvite();

  // A group link opened in a new tab may be read by party.js before this module loads.
  function syncInvite() {
    if (!INVITE) INVITE = readInvite();
    return INVITE;
  }

  function qs(token) {
    var parts = [];
    if (token) parts.push('token=' + encodeURIComponent(token));
    if (INVITE) parts.push('invite=' + encodeURIComponent(INVITE));
    return parts.length ? ('?' + parts.join('&')) : '';
  }

  function req(p, opts) {
    var o = Object.assign({ credentials: 'same-origin' }, opts || {});
    o.headers = Object.assign({ 'content-type': 'application/json' }, o.headers || {});
    syncInvite();
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

  // ── 游戏目录 / 引擎 meta ───────────────────────────────────────────────────

  // 引擎源码里的 window 全局名（engines/*.cjs 末尾 `window.XxxEngine = API`）
  var ENGINE_GLOBAL = { ddz: 'DdzEngine', zjh: 'ZjhEngine', uno: 'UnoEngine' };

  // 引擎一个都没就绪时的最后兜底：只有名字和人数，开关一律空（不硬编码规则表）
  var GAME_FALLBACK = {
    ddz: { name: '斗地主', minPlayers: 3, maxPlayers: 3 },
    zjh: { name: '炸金花', minPlayers: 2, maxPlayers: 4 },
    uno: { name: 'UNO', minPlayers: 2, maxPlayers: 4 }
  };
  var GAME_KEYS = ['ddz', 'zjh', 'uno'];

  var catalog = {};       // game -> 服务端 /rooms 顺带下发的 games 条目（引擎缺席时的次选）
  var metaCache = {};     // game -> 归一化后的 meta（只缓存拿到真货的）
  var metaPending = {};   // game -> Promise

  function absorbCatalog(payload) {
    var list = payload && payload.games;
    if (!Array.isArray(list)) return;
    list.forEach(function (g) { if (g && g.key) catalog[g.key] = g; });
  }

  function normMeta(src, game) {
    var m = src || {};
    var fb = GAME_FALLBACK[game] || {};
    return {
      key: game,
      name: m.name || fb.name || game,
      ready: m.ready !== false,
      minPlayers: typeof m.minPlayers === 'number' ? m.minPlayers : (fb.minPlayers || 2),
      maxPlayers: typeof m.maxPlayers === 'number' ? m.maxPlayers : (fb.maxPlayers || 4),
      defaultRules: (m.defaultRules && typeof m.defaultRules === 'object') ? m.defaultRules : {},
      ruleMeta: Array.isArray(m.ruleMeta) ? m.ruleMeta : []
    };
  }

  // 动态 import：三个引擎文件顶层都有同名 const（meta / DEFAULT_RULES / findPlayer…），
  // 用 <script> 挂会在同一个全局词法环境里撞名，第二个直接 SyntaxError；
  // ES 模块各带作用域，撞不着，而且模块里 window 还在，照样挂 window.XxxEngine。
  // import() 写在 new Function 里：老浏览器解析不动这句语法时只炸这一行，不连累整个 api.js。
  var dynImport = null;
  function importModule(src) {
    if (dynImport === null) {
      try { dynImport = new Function('u', 'return import(u);'); } catch (e) { dynImport = false; }
    }
    if (!dynImport) return Promise.reject(new Error('这个浏览器加载不了引擎'));
    try { return dynImport(src); } catch (e) { return Promise.reject(e); }
  }

  function loadEngine(game) {
    var name = ENGINE_GLOBAL[game];
    if (!name) return Promise.reject(new Error('不认识的游戏「' + game + '」'));
    if (global[name] && global[name].meta) return Promise.resolve(global[name]);
    return importModule('/cards/engine/' + game + '.js?v=' + VER).then(function (mod) {
      var api = global[name] || (mod && (mod.default || mod));
      if (!api || !api.meta) throw new Error('引擎没给 meta');
      return api;
    });
  }

  /**
   * gameMeta(game) -> Promise<{key,name,minPlayers,maxPlayers,defaultRules,ruleMeta}>
   * 优先引擎本尊；引擎没就绪就退到服务端 /rooms 下发的目录；再不行退化成「无开关」。
   * 永不 reject——大厅拿不到开关也得能建房。
   */
  function gameMeta(game) {
    if (metaCache[game]) return Promise.resolve(metaCache[game]);
    if (metaPending[game]) return metaPending[game];
    var p = loadEngine(game).then(function (api) {
      var m = normMeta(api.meta, game);
      metaCache[game] = m;
      delete metaPending[game];
      return m;
    }, function () {
      delete metaPending[game];
      // 失败不写缓存：等目录到了再问一次，说不定就有开关了
      return normMeta(catalog[game], game);
    });
    metaPending[game] = p;
    return p;
  }

  /** meta 里的默认规则值（defaultRules 优先，缺的用 ruleMeta[].def 补） */
  function ruleDefaults(meta) {
    var out = {};
    var m = meta || {};
    (m.ruleMeta || []).forEach(function (r) { if (r && r.key) out[r.key] = r.def; });
    Object.keys(m.defaultRules || {}).forEach(function (k) { out[k] = m.defaultRules[k]; });
    return out;
  }

  /** 服务端目录（listRooms 回来后才有；没有就 null） */
  function games() {
    var out = GAME_KEYS.map(function (k) { return catalog[k] || null; }).filter(Boolean);
    return out.length ? out : null;
  }

  function gameName(game) {
    if (metaCache[game]) return metaCache[game].name;
    if (catalog[game] && catalog[game].name) return catalog[game].name;
    return (GAME_FALLBACK[game] && GAME_FALLBACK[game].name) || game || '';
  }

  // ── REST ──────────────────────────────────────────────────────────────────

  /** listRooms() 全部；listRooms('ddz') 只要那一个游戏的 */
  function listRooms(game) {
    return req('/rooms' + (game ? ('?game=' + encodeURIComponent(game)) : '')).then(function (d) {
      absorbCatalog(d);
      return d;
    });
  }

  function createRoom(game, name, rules, aiPlayers) {
    var body = { game: game, name: name };
    if (rules) body.rules = rules;
    if (aiPlayers && aiPlayers.length) body.ai_players = aiPlayers;
    return post('/rooms', body);
  }

  /** 群聊开桌：服务端固定加 MaiBot 座位，返回 partyUrl / inviteUrl。 */
  function createParty(game, name, hostName, rules) {
    var body = { game: game, name: name, host_name: hostName };
    if (rules) body.rules = rules;
    return post('/party', body);
  }

  /** 群聊邀请入座：临时头优先于 sessionStorage 里的旧邀请。 */
  function inviteJoin(code, name, invite) {
    return req('/rooms/' + code + '/join', {
      method: 'POST', body: JSON.stringify({ name: name }),
      headers: { 'x-invite-token': invite }
    });
  }

  function joinRoom(code, name) { return post('/rooms/' + code + '/join', { name: name }); }

  /** 带旧 token 回来 = 复座（服务端认了就把座位原样还回来，含 isHost） */
  function rejoin(code, playerToken) { return post('/rooms/' + code + '/join', { playerToken: playerToken }); }

  function guestHeaders(invite) {
    return invite ? { 'x-invite-token': invite } : {};
  }

  /** Group-link lobby reads are invite-scoped; they never reveal hands or legal moves. */
  function partyState(code, invite) {
    if (invite) INVITE = invite;
    return req('/rooms/' + code + '/state?invite=' + encodeURIComponent(invite),
      { headers: guestHeaders(invite) });
  }

  function partyStart(code, playerToken, invite) {
    if (invite) INVITE = invite;
    return req('/rooms/' + code + '/start', {
      method: 'POST', body: JSON.stringify({ playerToken: playerToken }),
      headers: guestHeaders(invite)
    });
  }


  function startRoom(code, playerToken) { return post('/rooms/' + code + '/start', { playerToken: playerToken }); }

  function partyAi(code, playerToken, agentId, action) {
    return post('/rooms/' + code + '/ai', { playerToken: playerToken, agentId: agentId, action: action });
  }

  function closeRoom(code, playerToken) { return post('/rooms/' + code + '/close', { playerToken: playerToken }); }

  function leaveRoom(code, playerToken) { return post('/rooms/' + code + '/leave', { playerToken: playerToken }); }

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
   * 轮询常开：cloudflared 会把 SSE 响应整段缓冲，隧道下推送要等关页面才到。
   * SSE 先到的帧照收，seq 只进不退，重复帧渲染结果一样。
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
      // 服务端事件名叫 'state'；万一是默认消息也接得住
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
    // SSE 能连上（200）但被代理缓冲时不会报错，光等 error 不会退到轮询，所以直接开。
    startPoll();

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

  function seatKey(code) { return 'cards_seat_' + code; }

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
    try { return JSON.parse(localStorage.getItem('cards_me') || 'null') || {}; } catch (e) { return {}; }
  }
  function saveMe(me) {
    try { localStorage.setItem('cards_me', JSON.stringify(me)); } catch (e) { /* ignore */ }
  }

  global.CdAPI = {
    VER: VER,
    GAME_KEYS: GAME_KEYS,
    ENGINE_GLOBAL: ENGINE_GLOBAL,
    invite: function () { return INVITE; },
    gameMeta: gameMeta,
    gameName: gameName,
    games: games,
    ruleDefaults: ruleDefaults,
    listRooms: listRooms,
    createRoom: createRoom,
    createParty: createParty,
    inviteJoin: inviteJoin,
    partyState: partyState,
    partyStart: partyStart,
    partyAi: partyAi,
    joinRoom: joinRoom,
    rejoin: rejoin,
    startRoom: startRoom,
    closeRoom: closeRoom,
    leaveRoom: leaveRoom,
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
