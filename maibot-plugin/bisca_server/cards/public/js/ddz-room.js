/* Bisca 棋牌室 · 斗地主 —— 牌桌主控
 * 负责：入座/复座/观战、SSE 同步（按我的视角推的脱敏 view）、座位条、叫分、地主与底牌、
 *      场面、手牌扇面、出牌/过、炸弹动效、名次卡、计分板、总榜。
 * 通用件全走共享壳：CdAPI（后端）/ CdUI（浮层）/ cards.css 的 cd-* 骨架；
 * 这一份只写斗地主自己的东西（牌面 HTML、叫分件、地主件、底牌区）。
 * 合法性预判走 window.DdzEngine（引擎源码 /cards/engine/ddz.js 原样挂 window）——
 * 全部防御性调用，引擎没加载就整体降级：不预判、按钮全放开，错了让服务端的中文 400 说话。
 */
(function (global) {
  'use strict';

  var API = global.CdAPI;
  var UI = global.CdUI;
  var esc = UI.esc;

  var $ = function (id) { return document.getElementById(id); };
  var code = (new URLSearchParams(location.search).get('c') || '').toUpperCase();

  // ── 牌面（纯 CSS 牌，思路照搬 daifugo cards.js）────────────────────────────
  // id 约定跟引擎一致：'S3'..'S15'（H/D/C 同理，11=J 12=Q 13=K 14=A 15=2），
  // 王是 'X1'=小王、'X2'=大王（**和大富豪的 X1/X2 正好相反，以引擎为准**）。
  // 渲染时才把 15 翻成 "2"，回传服务端的永远是原 id。

  var SUITS = {
    S: { sym: '♠', tone: 'black', name: '黑桃' },
    H: { sym: '♥', tone: 'red', name: '红桃' },
    D: { sym: '♦', tone: 'red', name: '方块' },
    C: { sym: '♣', tone: 'black', name: '梅花' }
  };
  var RANK_TEXT = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' };
  var JOKER_SMALL = 16;
  var JOKER_BIG = 17;

  /** 'S15' -> {id,suit:'S',rank:15,joker:false}；'X2' -> {id,joker:true,rank:17} */
  function parseCard(id) {
    var s = String(id || '');
    if (s.charAt(0) === 'X') {
      if (s === 'X1') return { id: s, joker: true, suit: null, rank: JOKER_SMALL };
      if (s === 'X2') return { id: s, joker: true, suit: null, rank: JOKER_BIG };
      return null;
    }
    var suit = s.charAt(0);
    var rank = parseInt(s.slice(1), 10);
    if (!SUITS[suit] || !(rank >= 3 && rank <= 15)) return null;
    return { id: s, joker: false, suit: suit, rank: rank };
  }

  function rankText(rank) { return RANK_TEXT[rank] || String(rank); }

  /** 纯文字标签，提示/流水里用：'♠2' / '大王' */
  function cardLabel(id) {
    var c = parseCard(id);
    if (!c) return String(id || '');
    if (c.joker) return c.rank === JOKER_BIG ? '大王' : '小王';
    return SUITS[c.suit].sym + rankText(c.rank);
  }

  /** 斗地主习惯连着写：♠3♠4♠5 */
  function cardLabels(ids) { return (ids || []).map(cardLabel).join(''); }

  /** 手牌排序：小 → 大（引擎在就用引擎那份，口径完全一致） */
  function sortHand(ids) {
    var list = (ids || []).slice();
    var e = engine();
    if (e && e.sortCards) {
      try { return e.sortCards(list); } catch (err) { /* 引擎抽风就走下面的本地排序 */ }
    }
    var order = { S: 0, H: 1, D: 2, C: 3 };
    return list.sort(function (a, b) {
      var ca = parseCard(a), cb = parseCard(b);
      if (!ca || !cb) return String(a) < String(b) ? -1 : 1;
      return (ca.rank - cb.rank) || ((order[ca.suit] || 9) - (order[cb.suit] || 9));
    });
  }

  /**
   * 一张牌的 HTML。opts: {tag:'button'|'div', size:'sm', idx, extra}
   * idx 进 --i，给逐张入场动画排队 + 叠牌时定层级用。
   */
  function cardHtml(id, opts) {
    var o = opts || {};
    var c = parseCard(id);
    var tag = o.tag || 'div';
    var cls = ['ddz-card'];
    if (o.size) cls.push('ddz-card--' + o.size);
    if (o.extra) cls.push(o.extra);

    var body;
    if (!c) {
      cls.push('is-tone-black');
      body = '<span class="r">?</span><span class="s">?</span>';
    } else if (c.joker) {
      // X2=大王(红) X1=小王(主题色)——强度不同，认脸也不同
      cls.push('is-tone-joker');
      if (c.rank === JOKER_BIG) cls.push('is-joker-big');
      body = '<span class="r">★</span><span class="s">' + (c.rank === JOKER_BIG ? '大王' : '小王') + '</span>';
    } else {
      cls.push('is-tone-' + SUITS[c.suit].tone);
      body = '<span class="r">' + rankText(c.rank) + '</span>' +
        '<span class="s">' + SUITS[c.suit].sym + '</span>' +
        '<span class="c">' + SUITS[c.suit].sym + '</span>';
    }

    return '<' + tag + ' class="' + cls.join(' ') + '" data-id="' + esc(id) + '"' +
      (tag === 'button' ? ' type="button"' : '') +
      ' style="--i:' + (o.idx || 0) + '">' + body + '</' + tag + '>';
  }

  /** 一堆牌背（对手剩余张数用）：最多画 max 张，多的只报数字 */
  function backsHtml(count, max) {
    var n = Math.max(0, count || 0);
    var show = Math.min(n, max || 5);
    var out = '';
    for (var i = 0; i < show; i++) out += '<i class="ddz-back" style="--i:' + i + '"></i>';
    return out;
  }

  // ── 会话状态 ──────────────────────────────────────────────────────────────

  var seat = null;          // {playerId, playerToken, name, isHost?}
  var view = null;          // 最近一次「我视角」的 view（= payload.state）
  var meta = {};            // 房间壳信息（名字/房主/未开局的座位表/邀请 token/规则）
  var gmeta = null;         // 引擎 meta（规则 chips 的标签表）
  var sync = null;
  var sel = [];             // 选中的牌 id
  var busy = false;
  var chatBusy = false;
  var handKey = '';
  var fieldKey = '';
  var bottomKey = '';
  var joinAsked = false;
  var roomClosed = false;
  var lastTurnMine = false;
  var revealedRound = -1;
  var revealHandle = null;
  var lastLogSeq = 0;       // 已经看过的流水条 seq（炸弹/重发这种动效靠它触发）
  var logPrimed = false;    // 第一帧只补历史，不放动效
  var feedSeen = {};        // 流水/聊天条目的去重集合（key -> 1），只进不出
  var feedPrimed = false;   // 第一帧只补历史，不弹气泡
  var bubbles = {};         // playerId -> {text, until}：座位卡上的聊天气泡
  var lastLegal = null;     // 服务端给过的合法招（只有 state/action 接口带，SSE 不带）
  var lastLegalSeq = -1;

  // ── 取数小工具 ────────────────────────────────────────────────────────────

  function engine() { return global.DdzEngine || null; }

  function players() { return (view && view.players) || []; }

  function findPlayer(id) {
    var ps = players();
    for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
    return null;
  }

  function nameOf(id) {
    var p = findPlayer(id);
    return p ? (p.name || '') : '对面';
  }

  function me() { return seat ? findPlayer(seat.playerId) : null; }

  function myHand() {
    var m = me();
    if (m && m.hand) return m.hand;
    if (view && view.hand) return view.hand;      // 服务端也可能把我的手牌单独挂在 view.hand
    return [];
  }

  function started() {
    var p = view && view.phase;
    return !!(p && p !== 'lobby' && p !== 'waiting' && players().length);
  }

  function phase() { return (view && view.phase) || ''; }

  function isMyTurn() {
    return !!(seat && view && view.phase === 'playing' && view.current === seat.playerId);
  }

  function isMyBid() {
    return !!(seat && view && view.phase === 'bidding' && view.current === seat.playerId);
  }

  function isHost() {
    if (!seat) return false;
    if (seat.isHost != null) return !!seat.isHost;
    var h = meta.hostId || (view && (view.hostId || view.host));
    if (h) return h === seat.playerId;
    var first = players()[0] || (meta.seats || [])[0];
    return !!(first && (first.id || first.playerId) === seat.playerId);   // 兜底：首位入座者
  }

  function rules() { return (view && view.rules) || meta.rules || {}; }

  /** 本局倍数：view.multiplier = 2^bombs（春天那一下要结算才知道，不在这儿） */
  function multiplier() {
    if (view && typeof view.multiplier === 'number') return view.multiplier;
    var b = (view && view.bombs) || 0;
    return Math.pow(2, b);
  }

  function clip(text, n) {
    var s = String(text == null ? '' : text);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function seatsForWait() {
    var ps = players();
    if (ps.length) return ps;
    return (meta.seats || []).map(function (s) {
      return { id: s.playerId || s.id, name: s.name, isAI: s.isAI, isHost: s.isHost };
    });
  }

  /** 叫分的人话：null=还没轮到 / 0=不叫 / n=n 分 */
  function bidText(v) {
    if (v === null || v === undefined) return '';
    return Number(v) === 0 ? '不叫' : (v + ' 分');
  }

  function roleOf(p) {
    if (!p || !view || !view.landlord) return '';
    return p.isLandlord ? '地主' : '农民';
  }

  // ── 引擎预判（全部防御性；引擎不在就返回「不知道」）────────────────────────

  /** 选中这几张是什么牌型；引擎不在返回 null（调用方按「不知道」处理） */
  function comboOf(cards) {
    var e = engine();
    if (!e || !e.comboOf) return null;
    try { return e.comboOf(cards.slice(), { rules: rules() }); } catch (err) { return null; }
  }

  function comboName(combo) {
    var e = engine();
    if (combo && e && e.comboLabel) {
      try { return e.comboLabel(combo); } catch (err) { /* 掉到下面 */ }
    }
    return combo && combo.type ? combo.type : '';
  }

  /** 这手能不能压住场上；引擎不在一律放行（真不行服务端会拦） */
  function canBeatField(combo) {
    var e = engine();
    if (!e || !e.beats) return true;
    if (!view || !view.field) return true;
    try { return !!e.beats(combo, view.field.combo, rules()); } catch (err) { return true; }
  }

  /** 选中的牌现在能不能出 */
  function playOk() {
    if (!sel.length) return false;
    var e = engine();
    if (!e || !e.comboOf) return true;          // 降级：全放开
    var c = comboOf(sel);
    if (!c) return false;
    return canBeatField(c);
  }

  /** 选牌提示（出不了时说人话） */
  function playHint() {
    if (!sel.length) return '点牌选中，可多选';
    var e = engine();
    if (!e || !e.comboOf) return '选了 ' + sel.length + ' 张：' + cardLabels(sortHand(sel));
    var c = comboOf(sel);
    if (!c) return '这不是合法的斗地主牌型';
    if (!canBeatField(c)) {
      var f = view && view.field;
      return '压不过场上的 ' + cardLabels((f && f.cards) || []);
    }
    return comboName(c) + ' · ' + cardLabels(sortHand(sel));
  }

  /**
   * 我此刻的合法招。引擎在就本地算（view 的字段够 legalMoves 用：phase/current/highBid/
   * field.combo/rules + 我自己的 hand）；引擎不在就退到服务端给过的那份；都没有返回 null =
   * 「不知道」，按钮一律放开。
   */
  var legalCache = { key: '', list: null };

  function legalList() {
    if (!seat || !view) return null;
    var key = view.seq + '|' + phase() + '|' + (view.current || '') + '|' + myHand().length;
    if (legalCache.key === key) return legalCache.list;
    var out = null;
    var e = engine();
    if (e && e.legalMoves) {
      try {
        var moves = e.legalMoves(view, seat.playerId);
        if (Array.isArray(moves)) out = moves;
      } catch (err) { out = null; }
    }
    if (!out && Array.isArray(lastLegal) && lastLegalSeq === view.seq) out = lastLegal;
    legalCache = { key: key, list: out };
    return out;
  }

  /** 叫分按钮亮哪几个；不知道就全亮（0~3），错了让服务端说 */
  function bidValues() {
    var list = legalList();
    if (!list) return [0, 1, 2, 3];
    var out = [];
    list.forEach(function (m) {
      if (m && m.type === 'bid') {
        var v = Number(m.value);
        if (out.indexOf(v) === -1) out.push(v);
      }
    });
    return out.sort(function (a, b) { return a - b; });
  }

  function canPass() {
    var list = legalList();
    if (!list) return !!(view && view.field);      // 不知道：场上有牌就允许点
    return list.some(function (m) { return m && m.type === 'pass'; });
  }

  /**
   * 当前选牌还有救的牌集合（照 daifugo 的置灰思路）：
   * 从合法招里挑「包含当前全部选牌」的那些，把它们用到的牌并起来。
   * 一个都不剩就返回 null——满屏灰反而不知道怎么退。
   */
  function candidateMap() {
    if (!isMyTurn()) return null;
    var list = legalList();
    if (!list) return null;
    var out = Object.create(null);
    var hit = 0;
    list.forEach(function (m) {
      if (!m || m.type !== 'play' || !Array.isArray(m.cards)) return;
      for (var i = 0; i < sel.length; i++) {
        if (m.cards.indexOf(sel[i]) === -1) return;
      }
      hit += 1;
      m.cards.forEach(function (id) { out[id] = 1; });
    });
    return hit ? out : null;
  }

  // ── 动作 ──────────────────────────────────────────────────────────────────

  function send(type, extra) {
    if (busy || !seat) return Promise.resolve();
    busy = true;
    renderActions();
    return API.action(code, seat.playerToken, type, extra).then(function (r) {
      busy = false;
      sel = [];
      if (r && Array.isArray(r.legal)) { lastLegal = r.legal; lastLegalSeq = r.seq; }
      render();
    }, function (err) {
      busy = false;
      UI.toast(err.message, true);     // 服务端的中文报错直接显示
      render();
    });
  }

  function playSelected() {
    if (!sel.length) { UI.toast('先点几张牌', true); return; }
    if (!playOk()) { UI.toast(playHint(), true); return; }
    send('play', { cards: sel.slice() });
  }

  function copyInvite() {
    var link = location.origin + '/cards/room.html?c=' + encodeURIComponent(code) +
      '&invite=' + encodeURIComponent(meta.inviteToken);
    var fallback = function () { window.prompt('复制这个链接发给朋友：', link); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(function () {
        UI.toast('邀请链接已复制，发给朋友就能进来打');
      }, fallback);
    } else fallback();
  }

  // ── 头部 / 座位条 ─────────────────────────────────────────────────────────

  function renderHeader() {
    $('r-name').textContent = meta.name || '房间';
    $('r-code').textContent = code + (view && view.round ? ' · 第 ' + view.round + ' 局' : '');
    $('r-close').hidden = !isHost();
  }

  function roleTagHtml(p, size) {
    var role = roleOf(p);
    if (!role) return '';
    return '<span class="ddz-role' + (p.isLandlord ? ' is-landlord' : ' is-farmer') + '">' +
      (p.isLandlord ? '<i class="ddz-crown">' + UI.ICON.crown(size || 12) + '</i>' : '') +
      role + '</span>';
  }

  function seatCard(p) {
    var cls = ['cd-seat'];
    if (view && view.current === p.id && (view.phase === 'playing' || view.phase === 'bidding')) cls.push('is-turn');
    if (p.handCount === 0 && started() && view.phase !== 'bidding') cls.push('is-done');
    if (p.passed && view && view.phase === 'playing') cls.push('is-passed');
    if (p.isLandlord) cls.push('is-landlord');

    var idAttr = ' data-id="' + esc(p.id) + '"' +
      (roleOf(p) ? ' data-role="' + (p.isLandlord ? 'landlord' : 'farmer') + '"' : '');

    // 还没开局：只报个名，别显示「0 张」这种没意义的数字
    if (!started()) {
      return '<div class="' + cls.join(' ') + '"' + idAttr + '><div class="top">' +
        (p.isAI ? '<i class="bot" title="AI 座位">' + UI.ICON.robot(13) + '</i>' : '') +
        '<span class="nm">' + esc(p.name || '') + '</span></div>' +
        '<div class="tail"><span class="tx">已入座</span></div></div>';
    }

    var count = typeof p.handCount === 'number' ? p.handCount : (p.hand ? p.hand.length : 0);
    var tail = [];
    if (view.phase === 'bidding') {
      if (p.bid !== null && p.bid !== undefined) tail.push(bidText(p.bid));
      else if (view.current === p.id) tail.push(p.isAI ? '思考中' : '叫分中');
    } else if (view.phase === 'playing') {
      if (view.current === p.id) tail.push(p.isAI ? '思考中' : '出牌中');
      else if (p.passed) tail.push('过');
    } else if (count === 0) {
      tail.push('出完了');
    }

    return '<div class="' + cls.join(' ') + '"' + idAttr + '>' +
      '<div class="top">' +
      (p.isAI ? '<i class="bot" title="AI 座位">' + UI.ICON.robot(13) + '</i>' : '') +
      '<span class="nm">' + esc(p.name || '') + '</span>' +
      '</div>' +
      '<div class="cnt"><span class="backs">' + backsHtml(count, 5) + '</span>' +
      '<b>' + count + '</b><span class="u">张</span></div>' +
      '<div class="tail">' + roleTagHtml(p) +
      (tail.length ? '<span class="tx">' + esc(tail.join(' · ')) + '</span>' : '') + '</div>' +
      '</div>';
  }

  function renderSeats() {
    var ps = players();
    if (!ps.length) ps = seatsForWait();
    var others = seat ? ps.filter(function (p) { return p.id !== seat.playerId; }) : ps;
    $('r-seats').innerHTML = others.map(seatCard).join('') ||
      '<div class="cd-seat is-empty">还没别人</div>';
    paintBubbles();     // 座位条是整块重画的，气泡得跟着补回去
  }

  // ── 座位气泡（别人说话时在他卡上飘一下）──────────────────────────────────

  function showBubble(pid, text) {
    if (!pid) return;
    // 同时只飘一个：座位卡窄，两个气泡会互相压住（谁最新算谁的，流水区一条都不少）
    bubbles = {};
    bubbles[pid] = { text: clip(text, 40), until: Date.now() + 3500 };
    paintBubbles();
    setTimeout(function () {
      var b = bubbles[pid];
      if (b && b.until <= Date.now() + 40) { delete bubbles[pid]; paintBubbles(); }
    }, 3600);
  }

  function paintBubbles() {
    var host = $('r-seats');
    if (!host) return;
    var now = Date.now();
    var live = 0;
    Array.prototype.forEach.call(host.querySelectorAll('.cd-bubble'), function (el) { el.remove(); });
    Object.keys(bubbles).forEach(function (pid) {
      var b = bubbles[pid];
      if (!b || b.until <= now) { delete bubbles[pid]; return; }
      var card = null;
      Array.prototype.forEach.call(host.children, function (el) {
        if (!card && el.dataset && el.dataset.id === pid) card = el;
      });
      if (!card) return;
      var el = document.createElement('div');
      el.className = 'cd-bubble';
      var tx = document.createElement('span');
      tx.className = 'tx';                      // 省略号在内层，气泡本体要 overflow:visible 才留得住尖角
      tx.textContent = b.text;
      el.appendChild(tx);
      // 座位条重画后气泡是新元素，把动画倒推回已经飘过的那段，别从头再来一遍
      el.style.animationDelay = '-' + Math.max(0, 3500 - (b.until - now)) + 'ms';
      card.appendChild(el);
      live += 1;
    });
    host.classList.toggle('has-bubble', live > 0);
  }

  // ── 场面（轮次 / 徽标 / 底牌 / 叫分 / 出的牌）──────────────────────────────

  function renderTurn() {
    var el = $('r-turn');
    if (!started()) { el.innerHTML = '等开局'; return; }
    if (view.phase === 'bidding') {
      el.innerHTML = '叫分中 · 轮到 <b>' + esc(nameOf(view.current)) + '</b>' + (isMyBid() ? '（你）' : '');
    } else if (view.phase === 'playing') {
      el.innerHTML = '轮到 <b>' + esc(nameOf(view.current)) + '</b>' + (isMyTurn() ? '（你）' : '');
    } else if (view.phase === 'round_over') {
      el.innerHTML = '第 ' + (view.round || 1) + ' 局结束';
    } else if (view.phase === 'game_over') {
      el.innerHTML = '整场结束';
    } else {
      el.innerHTML = '';
    }
  }

  function renderBadges() {
    var el = $('r-badges');
    if (!started()) { el.innerHTML = ''; return; }
    var bs = '';
    if (view.landlord) {
      bs += '<span class="cd-badge is-hot ddz-badge--landlord">' +
        '<i class="ddz-crown">' + UI.ICON.crown(13) + '</i>地主 ' + esc(nameOf(view.landlord)) + '</span>';
    } else if (view.highBid) {
      bs += '<span class="cd-badge ddz-badge--highbid">最高 ' + esc(nameOf(view.highBid.playerId)) +
        ' ' + view.highBid.value + ' 分</span>';
    }
    if (view.base) bs += '<span class="cd-badge ddz-badge--base">底分 ' + view.base + '</span>';
    var m = multiplier();
    var bombs = view.bombs || 0;
    bs += '<span class="cd-badge ddz-badge--mult' + (bombs ? ' is-warn' : '') + '">倍数 ×' + m +
      (bombs ? '（炸 ' + bombs + ' 响）' : '') + '</span>';
    el.innerHTML = bs;
  }

  /** 底牌三张：定完地主对全员明示（观战也看得见） */
  function renderBottom() {
    var box = $('r-bottom');
    var list = (view && view.bottomCards) || null;
    if (!list || !list.length) { box.hidden = true; bottomKey = ''; return; }
    box.hidden = false;
    var key = list.join(',');
    if (key === bottomKey) return;
    bottomKey = key;
    $('r-bottom-cards').innerHTML = list.map(function (id, i) {
      return cardHtml(id, { size: 'sm', idx: i, extra: 'is-flip' });
    }).join('');
  }

  /** 叫分阶段：各家喊了什么 */
  function renderBids() {
    var box = $('r-bids');
    if (!started() || view.phase !== 'bidding') { box.hidden = true; return; }
    box.hidden = false;
    var order = (view.turnOrder && view.turnOrder.length) ? view.turnOrder : players().map(function (p) { return p.id; });
    box.innerHTML = order.map(function (id) {
      var p = findPlayer(id);
      if (!p) return '';
      var said = (p.bid === null || p.bid === undefined);
      var isNow = view.current === id;
      return '<span class="ddz-bid' + (said ? ' is-waiting' : '') + (isNow ? ' is-now' : '') +
        (p.bid ? ' is-called' : '') + '" data-id="' + esc(id) + '">' +
        '<b>' + esc(p.name || '') + '</b>' +
        '<i>' + esc(said ? (isNow ? '思考中…' : '还没轮到') : bidText(p.bid)) + '</i></span>';
    }).join('');
  }

  function renderPile() {
    var pile = $('r-pile'), by = $('r-by');
    if (!started()) { pile.innerHTML = ''; by.textContent = ''; fieldKey = ''; return; }

    var f = view.field;
    var key = f ? ((f.cards || []).join(',') + '|' + f.by) : ('none|' + view.phase);
    if (key !== fieldKey) {
      fieldKey = key;
      // 一手 8 张以上（四带二/飞机带翅膀）整体缩一号，别把场面撑破
      pile.classList.toggle('is-many', !!(f && (f.cards || []).length > 8));
      if (f) {
        pile.innerHTML = (f.cards || []).map(function (id, i) {
          return cardHtml(id, { idx: i, extra: 'is-fly' });
        }).join('');
      } else if (view.phase === 'bidding') {
        pile.innerHTML = '<div class="ddz-pile-empty">叫分定地主，最高分拿底牌</div>';
      } else {
        pile.innerHTML = '<div class="ddz-pile-empty">场上空着，' +
          esc(view.leader ? nameOf(view.leader) : '地主') + ' 领出</div>';
      }
    }

    by.innerHTML = f
      ? esc(nameOf(f.by)) + ' 出的' + (f.combo ? ' · ' + esc(comboName(f.combo)) : '')
      : '';
  }

  function renderField() {
    renderTurn();
    renderBadges();
    renderBottom();
    renderBids();
    renderPile();
  }

  // ── 流水 + 聊天（同一条流）────────────────────────────────────────────────
  // 每帧服务端都给全量（log 是整场累积、chat 是最近若干条），这里只 append 没见过的，
  // 绝不整区重画——重画会闪，还会把滚动位置弹回去。

  var FEED_MAX = 90;         // DOM 里最多留这么多条，超了从头上砍

  function logText(r) { return typeof r === 'string' ? r : ((r && r.text) || ''); }

  function chatRows() {
    // chat 挂在外层 statePayload；万一服务端塞进 state 里也接得住
    if (view && Array.isArray(view.chat)) return view.chat;
    return meta.chat || [];
  }

  function chatRowHtml(m, key, isMe, p) {
    return '<div class="row is-chat' + (isMe ? ' is-me' : '') + '" data-key="' + esc(key) + '">' +
      (p && p.isAI ? '<i class="bot">' + UI.ICON.robot(12) + '</i>' : '') +
      '<span class="who">' + esc(m.name || (p && p.name) || '路人') + '</span>' +
      '<span class="tx">' + esc(m.text) + '</span></div>';
  }

  function renderLog() {
    var box = $('r-log');
    if (!box) return;
    // 贴底跟随；用户自己上翻了就别抢他的滚动位置
    var stick = (box.scrollHeight - box.scrollTop - box.clientHeight) < 24;
    var fresh = [];

    ((view && view.log) || []).forEach(function (r, i) {
      var text = logText(r);
      if (!text) return;
      var key = 'L' + ((r && typeof r.seq === 'number') ? r.seq : i) + '|' + text;
      if (feedSeen[key]) return;
      feedSeen[key] = 1;
      fresh.push({ html: '<div class="row" data-key="' + esc(key) + '">' + esc(text) + '</div>' });
    });

    var meId = seat && seat.playerId;
    chatRows().slice().sort(function (a, b) {
      return ((a && a.ts) || 0) - ((b && b.ts) || 0);
    }).forEach(function (m) {
      if (!m || !m.text) return;
      var key = 'C' + (m.ts || 0) + '|' + (m.name || '') + '|' + m.text;
      if (feedSeen[key]) return;
      feedSeen[key] = 1;
      var p = m.by ? findPlayer(m.by) : null;
      var isMe = !!(meId && m.by === meId);
      fresh.push({
        html: chatRowHtml(m, key, isMe, p),
        // 自己的话不弹气泡；补历史（首帧）和陈年旧话也不弹
        bubble: (!isMe && m.by && feedPrimed && (!m.ts || Date.now() - m.ts < 20000))
          ? { by: m.by, text: m.text } : null
      });
    });

    if (fresh.length) {
      fresh.forEach(function (it) {
        box.insertAdjacentHTML('beforeend', it.html);
        if (it.bubble) showBubble(it.bubble.by, it.bubble.text);
      });
      while (box.children.length > FEED_MAX) box.removeChild(box.firstChild);
      if (stick) box.scrollTop = box.scrollHeight;
    }
    feedPrimed = true;
  }

  // ── 发言 ──────────────────────────────────────────────────────────────────

  function chatName() {
    if (seat && seat.name) return seat.name;
    return (API.loadMe().name || '观战');
  }

  function sendChat() {
    var el = $('r-chatin');
    var btn = $('r-chatsend');
    if (!el || chatBusy) return;
    var text = (el.value || '').trim();
    if (!text) return;
    if (text.length > 280) text = text.slice(0, 280);

    chatBusy = true;
    btn.disabled = true;
    var body = { text: text };
    if (seat && seat.playerToken) body.playerToken = seat.playerToken;
    else body.name = chatName();

    API.sendChat(code, body).then(function () {
      chatBusy = false;
      btn.disabled = false;
      el.value = '';
      // 不 blur：键盘收起来再弹一次，手机上唠嗑体验很差
    }, function (e) {
      chatBusy = false;
      btn.disabled = false;
      UI.toast(e.message, true);
    });
  }

  // ── 手牌扇面 ──────────────────────────────────────────────────────────────

  function canSelect() {
    return isMyTurn();
  }

  function renderHand() {
    var box = $('r-handzone');
    // 观战没手牌可看；没开局 / 手上一张不剩（出完了）也把整块收起来
    if (!seat || !started()) { box.hidden = true; return; }
    var hand = sortHand(myHand());
    if (!hand.length) { box.hidden = true; return; }
    box.hidden = false;

    var key = hand.join(',');
    if (key !== handKey) {
      handKey = key;
      sel = sel.filter(function (id) { return hand.indexOf(id) !== -1; });
      $('r-fan').innerHTML = hand.map(function (id, i) {
        return cardHtml(id, { tag: 'button', idx: i });
      }).join('');
    }
    // 手牌多（地主 20 张）就叠紧一点，345px 也得摊得开
    $('r-fan').classList.toggle('is-dense', hand.length > 14);

    var mine = me();
    $('r-mine').innerHTML = '你的手牌 <b>' + hand.length + '</b> 张' +
      (mine ? roleTagHtml(mine, 12) : '');
    syncHand();
  }

  /** 选中态 / 置灰态，不重建 DOM */
  function syncHand() {
    var alive = canSelect() ? candidateMap() : null;

    Array.prototype.forEach.call($('r-fan').children, function (el) {
      var id = el.dataset.id;
      el.classList.toggle('is-on', sel.indexOf(id) !== -1);
      el.classList.toggle('is-dead', !!(alive && !alive[id]));
      el.disabled = !canSelect();
    });

    var hint = $('r-hint');
    if (!canSelect()) {
      hint.textContent = '';
      hint.classList.remove('is-bad');
      return;
    }
    hint.textContent = playHint();
    hint.classList.toggle('is-bad', !!sel.length && !playOk());
  }

  function onFanTap(e) {
    var el = e.target && e.target.closest ? e.target.closest('.ddz-card') : null;
    if (!el || !canSelect()) return;
    var id = el.dataset.id;
    var i = sel.indexOf(id);
    if (i !== -1) sel.splice(i, 1);
    else sel.push(id);
    syncHand();
    renderActions();
  }

  // ── 通知条（我的角色 / 叫分说明）───────────────────────────────────────────

  function renderNotice() {
    var el = $('r-notice');
    if (!seat || !started()) { el.hidden = true; return; }

    if (view.phase === 'bidding') {
      el.hidden = false;
      el.innerHTML = isMyBid()
        ? '轮到你叫分：叫得最高的当<b>地主</b>，底牌归你，叫的分就是这局<b>底分</b>。'
        : '等 <b>' + esc(nameOf(view.current)) + '</b> 叫分…（三家都不叫就重新发牌）';
      return;
    }

    // 角色提醒只在本局开打前后露一会儿：自己出过一手就撤掉，把高度还给牌桌
    // （身份长期挂在手牌区的 tag 和场面上的地主徽标上，不会丢）
    var mine = me();
    if (view.phase === 'playing' && mine && view.landlord && !mine.playedCount) {
      var mates = players().filter(function (p) {
        return !p.isLandlord && p.id !== mine.id;
      }).map(function (p) { return p.name; });
      el.hidden = false;
      el.innerHTML = mine.isLandlord
        ? '你是<b>地主</b>，一打二：底牌 ' + esc(cardLabels((view.bottomCards || []))) + ' 已并进你的手牌。'
        : '你是<b>农民</b>，队友是 <b>' + esc(mates.join('、') || '另一位') + '</b>，一起压地主。';
      return;
    }

    el.hidden = true;
  }

  // ── 操作区 ────────────────────────────────────────────────────────────────

  function btn(label, cls, fn, disabled, id) {
    var b = document.createElement('button');
    b.className = 'cd-btn ' + (cls || '');
    b.type = 'button';
    b.innerHTML = label;
    if (id) b.id = id;
    b.disabled = !!disabled || busy;
    b.addEventListener('click', fn);
    return b;
  }

  function hint(html) {
    var d = document.createElement('div');
    d.className = 'cd-actbar-hint';
    d.innerHTML = html;
    return d;
  }

  function renderActions() {
    var bar = $('r-acts');
    bar.innerHTML = '';

    if (!seat) {
      var w = document.createElement('span');
      w.className = 'cd-watch';
      w.innerHTML = UI.ICON.cards(15) + '观战中';
      bar.appendChild(w);
      return;
    }

    if (!started()) {
      var n = seatsForWait().length;
      var need = (meta.minPlayers || 3);
      if (isHost()) {
        bar.appendChild(btn('开局（' + n + '/' + need + ' 人）', 'cd-btn--primary cd-btn--wide', function () {
          API.startRoom(code, seat.playerToken).catch(function (e) { UI.toast(e.message, true); });
        }, n !== need, 'r-start'));
        if (n !== need) bar.appendChild(hint('斗地主<b>恰好 ' + need + ' 人</b>才能开'));
      } else {
        bar.appendChild(hint('等房主开局…'));
      }
      if (meta.inviteToken) bar.appendChild(btn('邀请朋友', 'cd-btn--ghost', copyInvite, false, 'r-invite'));
      return;
    }

    if (view.phase === 'game_over') {
      bar.appendChild(hint('整场结束了'));
      return;
    }

    if (view.phase === 'round_over') {
      bar.appendChild(btn('看结果', '', function () { openReveal(true); }, false, 'r-result'));
      bar.appendChild(btn('开下一局', 'cd-btn--primary', function () { send('next_round'); }, false, 'r-next'));
      if (isHost()) bar.appendChild(btn('结束整场', 'cd-btn--danger', function () { send('end_match'); }, false, 'r-end'));
      return;
    }

    if (view.phase === 'bidding') {
      if (!isMyBid()) {
        var bp = findPlayer(view.current);
        bar.appendChild(hint('等 ' + (bp && bp.isAI ? UI.ICON.robot(14) : '') +
          '<b>' + esc(bp ? bp.name : '对面') + '</b> 叫分…'));
        return;
      }
      var allow = bidValues();
      [0, 1, 2, 3].forEach(function (v) {
        var on = allow.indexOf(v) !== -1;
        var b = btn(v === 0 ? '不叫' : (v + ' 分'),
          'ddz-bidbtn' + (v === 3 ? ' cd-btn--primary' : ''),
          function () { send('bid', { value: v }); }, !on, 'r-bid-' + v);
        b.dataset.bid = String(v);
        bar.appendChild(b);
      });
      return;
    }

    var mine = me();
    if (mine && mine.handCount === 0) {
      bar.appendChild(hint('你出完了，等这局结算'));
      return;
    }

    if (!isMyTurn()) {
      var cur = findPlayer(view.current);
      bar.appendChild(hint('等 ' + (cur && cur.isAI ? UI.ICON.robot(14) : '') +
        '<b>' + esc(cur ? cur.name : '对面') + '</b> 出牌…'));
      return;
    }

    bar.appendChild(btn('出牌', 'cd-btn--primary cd-btn--wide', playSelected, !playOk(), 'r-play'));
    bar.appendChild(btn('过', 'cd-btn--wide', function () { send('pass'); }, !canPass(), 'r-pass'));
  }

  // ── 未开局面板 ────────────────────────────────────────────────────────────

  function ruleChips() {
    var vals = rules();
    var list = (gmeta && gmeta.ruleMeta) || [];
    if (!list.length) return '';
    return '<div class="cd-rulechips">' + list.map(function (r) {
      return '<span class="cd-chip' + (vals[r.key] ? ' is-on' : '') + '">' + esc(r.label) + '</span>';
    }).join('') + '</div>';
  }

  function renderWait() {
    var el = $('r-wait');
    var stage = $('r-stage');
    // 说明卡是 inset:0 的覆盖层，等人阶段得让出底下那条聊天（CSS 给它抬 bottom）
    if (stage) stage.classList.toggle('is-waiting', !started());
    if (started()) { el.hidden = true; return; }
    el.hidden = false;
    var ss = seatsForWait();
    var need = meta.minPlayers || 3;
    el.innerHTML = '<div class="box cn-card">' +
      '<div><div class="cd-eyebrow">房间号</div>' +
      '<h2>' + esc(code) + '</h2></div>' +
      '<div class="sub">把房间号发给朋友，他们在大厅点进来就能坐下。斗地主<b>恰好 ' + need +
      ' 人</b>，坐满房主就能开局。</div>' +
      '<div class="cd-seatlist">' + (ss.length ? ss.map(function (s) {
        var isMe = seat && seat.playerId === (s.id || s.playerId);
        return '<div class="cd-seatrow">' +
          (s.isAI ? '<i class="bot">' + UI.ICON.robot(14) + '</i>' : '') +
          '<span class="nm">' + esc(s.name || '') + '</span>' +
          '<span class="role">' + (isMe ? '你' : (s.isHost ? '房主' : '玩家')) + '</span></div>';
      }).join('') : '<div class="cd-empty">还没人坐下</div>') + '</div>' +
      ruleChips() +
      '</div>';
  }

  // ── 覆盖层：本局名次卡 / 总榜 ─────────────────────────────────────────────

  /** 本局的实际倍数（含春天那一下）：优先读 rounds 里落定的那条 */
  function roundRecord() {
    var rs = (view && view.rounds) || [];
    for (var i = rs.length - 1; i >= 0; i--) {
      if (rs[i] && rs[i].round === view.round) return rs[i];
    }
    return rs.length ? rs[rs.length - 1] : null;
  }

  function openReveal(force) {
    if (revealHandle) { if (!force) return revealHandle; revealHandle.close(); }
    var rec = roundRecord() || {};
    var results = (view.lastResults || []).slice().sort(function (a, b) {
      return (b.delta || 0) - (a.delta || 0);
    });
    var llWon = view.roundWinner === 'landlord';
    var mult = rec.multiplier || multiplier();
    var base = rec.base || view.base || 1;
    var extra = (view.spring || rec.spring) ? '春天' : ((view.antiSpring || rec.antiSpring) ? '反春' : '');

    var rows = results.map(function (r, i) {
      var p = findPlayer(r.playerId);
      return '<div class="ddz-reveal-row' + (seat && r.playerId === seat.playerId ? ' is-me' : '') +
        '" style="--i:' + i + '">' +
        '<span class="nm">' + esc(r.name || '') +
        (p && p.isAI ? '<i class="bot">' + UI.ICON.robot(13) + '</i>' : '') + '</span>' +
        '<span class="rl' + (r.isLandlord ? ' is-landlord' : '') + '">' +
        (r.isLandlord ? '地主' : '农民') + '</span>' +
        '<span class="dl' + ((r.delta || 0) >= 0 ? ' is-up' : ' is-down') + '">' +
        ((r.delta || 0) >= 0 ? '+' : '') + (r.delta || 0) + '</span>' +
        '<span class="sc">共 ' + (r.score || 0) + '</span></div>';
    }).join('');

    var acts = '<button class="cd-btn" id="rv-close" type="button">看牌桌</button>' +
      '<button class="cd-btn cd-btn--primary" id="rv-next" type="button">开下一局</button>';
    if (isHost()) acts += '<button class="cd-btn cd-btn--danger" id="rv-end" type="button">结束整场</button>';

    revealHandle = UI.modal({
      className: 'ddz-reveal',
      dismissable: false,
      html: '<div class="cd-eyebrow">第 ' + (view.round || 1) + ' 局结束</div>' +
        '<h2>' + (llWon ? '地主赢了' : '农民赢了') + '</h2>' +
        (extra ? '<div class="ddz-reveal-extra">' + extra + '！倍数再翻一倍</div>' : '') +
        '<div class="sub">底分 ' + base + ' × 倍数 ' + mult +
        '（炸弹 ' + (rec.bombs != null ? rec.bombs : (view.bombs || 0)) + ' 响' +
        (extra ? ' + ' + extra : '') + '）</div>' +
        '<div class="ddz-reveal-list">' + rows + '</div>' +
        '<div class="cd-modal-acts ddz-reveal-acts">' + acts + '</div>',
      onMount: function (h) {
        h.el.querySelector('#rv-close').addEventListener('click', function () { h.close(); });
        h.el.querySelector('#rv-next').addEventListener('click', function () { h.close(); send('next_round'); });
        var e = h.el.querySelector('#rv-end');
        if (e) e.addEventListener('click', function () { h.close(); send('end_match'); });
      },
      onClose: function () { revealHandle = null; }
    });
    return revealHandle;
  }

  function hideReveal() {
    if (revealHandle) revealHandle.close();
    revealHandle = null;
  }

  function renderOverlays() {
    if (!view) return;
    if (view.phase === 'round_over') {
      if (revealedRound !== view.round) {
        revealedRound = view.round;
        openReveal();
      }
    } else {
      if (view.phase !== 'game_over') hideReveal();
      revealedRound = -1;
    }

    if (view.phase === 'game_over') {
      hideReveal();
      UI.gameOver(view, { meId: seat && seat.playerId });
    } else {
      UI.hideGameOver();
    }
  }

  // ── 动效：炸弹震一下 / 重发 / 春天（都由流水条驱动）────────────────────────

  function shake() {
    var b = document.body;
    b.classList.remove('is-boom');
    // 强制回流，连炸两次也能重新起跑
    void b.offsetWidth;
    b.classList.add('is-boom');
    setTimeout(function () { b.classList.remove('is-boom'); }, 560);
  }

  /** 新进来的流水条：炸弹震、重发弹横幅、春天喊一嗓子 */
  function watchLog() {
    var list = (view && view.log) || [];
    var maxSeq = lastLogSeq;
    var fresh = [];
    list.forEach(function (r, i) {
      var s = (r && typeof r.seq === 'number') ? r.seq : (i + 1);
      if (s > lastLogSeq) fresh.push(r);
      if (s > maxSeq) maxSeq = s;
    });
    lastLogSeq = maxSeq;
    if (!logPrimed) { logPrimed = true; return; }   // 首帧只是补历史，不放动效

    var host = $('r-field');
    fresh.forEach(function (r) {
      var type = r && r.type;
      var text = logText(r);
      if (type === 'bomb') {
        shake();
        UI.banner(host, text.indexOf('王炸') === 0 ? '王炸' : '炸弹', 'bad');
      } else if (type === 'redeal') {
        UI.banner(host, '重新发牌', 'alt');
        UI.toast('三家都不叫，重新洗牌发过');
      } else if (type === 'landlord') {
        // 这里**不弹横幅**：横幅正好压在刚翻出来的底牌上，
        // 定地主已经有底牌翻牌动画 + 场面徽标交代了
        UI.toast(text);
      } else if (type === 'round_over') {
        if (text.indexOf('春天') === 0) UI.banner(host, '春天', 'alt');
        else if (text.indexOf('反春') === 0) UI.banner(host, '反春', 'alt');
      }
    });
  }

  // ── 主渲染 ────────────────────────────────────────────────────────────────

  function render() {
    renderHeader();
    renderSeats();
    renderWait();
    renderField();
    renderLog();
    renderNotice();
    renderHand();
    renderActions();
    renderOverlays();

    // 轮到我了震一下（没有 vibrate 就静默跳过）
    var mineTurn = isMyTurn() || isMyBid();
    if (mineTurn && !lastTurnMine && navigator.vibrate) {
      try { navigator.vibrate(30); } catch (e) { /* ignore */ }
    }
    lastTurnMine = mineTurn;
  }

  // ── 同步 ──────────────────────────────────────────────────────────────────

  function ingest(payload) {
    if (!payload || typeof payload !== 'object') return;
    // 兼容两种包法：直接推我视角的 view / 外面包一层 {name,seats,started,state}
    var v = (payload.state && typeof payload.state === 'object') ? payload.state : payload;
    if (payload.name) meta.name = payload.name;
    if (payload.hostId) meta.hostId = payload.hostId;
    if (payload.seats) meta.seats = payload.seats;
    if (payload.rules) meta.rules = payload.rules;
    if (typeof payload.minPlayers === 'number') meta.minPlayers = payload.minPlayers;
    if (typeof payload.maxPlayers === 'number') meta.maxPlayers = payload.maxPlayers;
    if (v && v.hostId) meta.hostId = v.hostId;
    if (v && v.roomName) meta.name = v.roomName;
    // 聊天挂在外层（statePayload.chat），不在脱敏后的 view 里
    if (Array.isArray(payload.chat)) meta.chat = payload.chat;
    else if (v && Array.isArray(v.chat)) meta.chat = v.chat;
    // 邀请 token 只有 owner 视角拿得到（服务端把关），有就记下用于「邀请朋友」
    if (payload.inviteToken) meta.inviteToken = payload.inviteToken;
    // 合法招只有 state / action 两个接口带（SSE 不带），带了就存一份当引擎的后备
    if (Array.isArray(payload.legal)) {
      lastLegal = payload.legal;
      lastLegalSeq = (typeof payload.seq === 'number') ? payload.seq : (v && v.seq);
    }
    view = (v && v.phase) ? v : (v && v.players ? v : null);
  }

  function onPayload(p) {
    if (p && p.closed && !roomClosed) {
      roomClosed = true;
      if (sync) sync.close();
      UI.toast('房间被房主关闭了，回大厅～');
      setTimeout(function () { location.href = '/cards/'; }, 1400);
      return;
    }
    ingest(p);
    render();
    watchLog();
    maybeAskSeat();
  }

  function onStatus(s) {
    var el = $('r-conn');
    el.dataset.conn = s;
    el.querySelector('.tx').textContent = s === 'live' ? '已连接' : (s === 'polling' ? '轮询中' : '重连中');
  }

  // ── 入座 / 复座 ───────────────────────────────────────────────────────────

  function askJoin() {
    var last = API.loadMe();
    UI.modal({
      dismissable: false,
      html: '<h2>坐下来打一局</h2>' +
        '<div class="sub">「' + esc(meta.name || code) + '」还没开局，报个名字就能上桌（斗地主恰好 3 人）。</div>' +
        '<div class="cd-field-row"><span class="k">昵称</span>' +
        '<input id="jd-name" maxlength="16" placeholder="怎么称呼你" value="' + esc(last.name || '') + '"></div>' +
        '<div class="cd-modal-acts">' +
        '<button class="cd-btn" id="jd-watch" type="button">只看看</button>' +
        '<button class="cd-btn cd-btn--primary" id="jd-ok" type="button">入座</button></div>',
      onMount: function (h) {
        h.el.querySelector('#jd-watch').addEventListener('click', function () {
          h.close();
          UI.toast('观战模式，随便看');
        });
        h.el.querySelector('#jd-ok').addEventListener('click', function () {
          var nm = (h.el.querySelector('#jd-name').value || '').trim();
          if (!nm) { UI.toast('先起个名字吧', true); return; }
          API.joinRoom(code, nm).then(function (r) {
            h.close();
            seat = Object.assign({ name: nm }, r);
            API.saveSeat(code, seat);
            API.saveMe({ name: nm });
            UI.toast('坐好了，' + nm);
            reopen();
            render();
          }, function (e) {
            UI.toast(e.message, true);
            joinAsked = false;
          });
        });
      }
    });
  }

  function maybeAskSeat() {
    if (seat || joinAsked) return;
    if (!view && !meta.seats) return;   // 一帧都还没收到，别急着弹入座框
    if (started()) return;              // 已开局又没座位 = 观战
    joinAsked = true;
    askJoin();
  }

  /** 入座后要带着 token 重开一条 SSE，才收得到自己的手牌 */
  function reopen() {
    if (sync) sync.close();
    sync = API.openSync(code, seat && seat.playerToken, onPayload, onStatus);
    // 顺手拉一份：新连接的第一帧偶尔要等，别让刚入座的人对着旧画面发呆
    // （这一份还顺带把 legal / inviteToken 带回来，SSE 那条不给）
    API.getState(code, seat && seat.playerToken).then(onPayload, function () { /* 等 SSE 就行 */ });
  }

  // ── 启动 ──────────────────────────────────────────────────────────────────

  function bindClose() {
    $('r-close').addEventListener('click', function () {
      if (!isHost()) return;
      UI.modal({
        html: '<h2>关闭这个房间？</h2>' +
          '<p class="sub">牌局和聊天记录会一起删掉，大家都会被请回大厅。</p>' +
          '<div class="cd-modal-acts">' +
          '<button class="cd-btn" id="cl-no" type="button">再打打</button>' +
          '<button class="cd-btn cd-btn--danger" id="cl-yes" type="button">关闭房间</button></div>',
        onMount: function (h) {
          h.el.querySelector('#cl-no').addEventListener('click', function () { h.close(); });
          h.el.querySelector('#cl-yes').addEventListener('click', function () {
            API.closeRoom(code, seat && seat.playerToken).then(function () {
              h.close(); // 收尾交给 SSE 的 closed 信号统一退场
            }, function (e) { UI.toast(e.message, true); });
          });
        }
      });
    });
  }

  function boot() {
    if (!code) {
      document.body.innerHTML = '<div class="cd-empty" style="padding-top:80px">没给房间号，回大厅重来吧</div>';
      return;
    }
    $('r-code').textContent = code;
    $('r-back').innerHTML = UI.icon('back', 22);
    $('r-score').innerHTML = UI.icon('coins', 20);

    $('r-help').innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.6 2.9c-.8.5-1.2 1-1.2 1.9"/><circle cx="12" cy="16.8" r="0.5"/></svg>';
    $('r-help').addEventListener('click', function () { UI.rulesHelp('ddz'); });

    $('r-close').innerHTML = UI.icon('door', 20);
    bindClose();

    $('r-score').addEventListener('click', function () {
      if (!view || !players().length) { UI.toast('还没开局，没分可算'); return; }
      var m = multiplier();
      UI.scoreboard(view, {
        meId: seat && seat.playerId,
        unit: '总分',
        noteOf: function (p) {
          var role = roleOf(p);
          if (!role) return '';
          return role + (m > 1 ? ' ×' + m : '');
        },
        canNext: !!seat && view.phase === 'round_over',
        canEnd: isHost() && view.phase !== 'game_over',
        onNext: function () { send('next_round'); },
        onEnd: function () { send('end_match'); }
      });
    });

    $('r-fan').addEventListener('click', onFanTap);

    // 聊天输入条
    $('r-chatsend').innerHTML = UI.ICON.plane(18);
    $('r-chatbar').addEventListener('submit', function (e) {
      e.preventDefault();
      sendChat();
    });
    $('r-chatin').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      e.preventDefault();
      // 输入法组词中的回车是「选词」不是「发送」（不然中文输入法打字打一半就被发出去）
      if (e.isComposing || e.keyCode === 229) return;
      sendChat();
    });
    $('r-chatin').addEventListener('focus', function () {
      // iOS 键盘弹起后把输入条顶回可视区（输入条是普通文档流元素，不是 fixed）
      setTimeout(function () {
        try { $('r-chatdock').scrollIntoView({ block: 'end', behavior: 'smooth' }); } catch (err) { /* 老 WebKit 不认 options */ }
      }, 260);
    });

    // 规则 chips 的标签表（引擎 meta；拿不到就不画 chips，不影响玩）
    API.gameMeta('ddz').then(function (m) {
      gmeta = m;
      if (!started()) renderWait();
    }, function () { /* 永不 reject，这儿只是兜个底 */ });

    seat = API.loadSeat(code);
    var pre = (seat && seat.playerToken)
      ? API.getState(code, seat.playerToken).then(function (v) {
        // token 还认不认？认的话我应该出现在玩家表里（没开局的房间可能还没有 players）
        var ps = (v && v.players) || (v && v.state && v.state.players) || [];
        if (ps.length && !ps.some(function (p) { return p.id === seat.playerId; })) {
          API.clearSeat(code);
          seat = null;
          return;
        }
        onPayload(v);          // 顺手吃下这一帧：inviteToken / legal 只有这条路给
      }, function () {
        API.clearSeat(code);            // token 失效（房间被清了/重建了）
        seat = null;
      })
      : Promise.resolve();

    pre.then(function () {
      sync = API.openSync(code, seat && seat.playerToken, onPayload, onStatus);
      if (!seat) {
        // 没座位的：也拉一份，好让「还没开局 → 问要不要入座」这条路立刻走起来
        API.getState(code, null).then(onPayload, function () { /* 等 SSE */ });
      }
    });

    window.addEventListener('beforeunload', function () { if (sync) sync.close(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
