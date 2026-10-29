/* Bisca 棋牌室 · 炸金花 —— 牌桌主控
 * 壳子（座位条 / 聊天混排 / 入座弹窗 / 邀请 / 关房 / 计分板 / 断线复座）照搬 daifugo room.js 范式，
 * 类名换成共享的 cd-* 骨架，炸金花专属件（筹码池 / 暗牌翻面 / 下注动作条 / 摊牌结算卡）另起 zj-*。
 *
 * 铁律：**动作条上的每一个按钮都来自 payload.legal**，前端一个规则都不自己算。
 *      SSE 推的 statePayload 不带 legal（只有 GET /state 和 POST /action 带），
 *      所以每当局面指纹（seq|phase|current）变了就顺手拉一次 state 把 legal 补上，见 refreshLegal。
 * 观战永远看不到任何人的牌：viewFor 已经脱敏（cards 为 null），UI 不做任何"补全"。
 */
(function (global) {
  'use strict';

  var API = global.CdAPI;
  var UI = global.CdUI;
  var esc = UI.esc;

  var $ = function (id) { return document.getElementById(id); };
  var code = (new URLSearchParams(location.search).get('c') || '').toUpperCase();

  var seat = null;          // {playerId, playerToken, name, isHost?}
  var view = null;          // 最近一次「我视角」的 view（= payload.state）
  var meta = {};            // 房间壳信息（名字/座位表/规则/邀请 token/聊天）
  var gmeta = null;         // 引擎 meta（规则条目，等人面板的规则 chip 用）
  var legal = [];           // 服务端下发的合法动作
  var legalKey = '';        // legal 对应的局面指纹
  var legalBusy = false;
  var sync = null;
  var busy = false;
  var joinAsked = false;
  var chatBusy = false;
  var lastTurnMine = false;
  var roomClosed = false;

  var feedSeen = {};        // 流水/聊天条目去重集合（key -> 1），只进不出
  var feedPrimed = false;   // 第一帧只补历史，不弹气泡
  var bubbles = {};         // playerId -> {text, until}

  var handSig = { round: -1, cards: '', n: -1 };   // 手牌区指纹（翻面动画靠它判「刚看牌」）
  var shownRound = -1;      // 已经弹过结算卡的局号
  var showHandle = null;    // 结算卡句柄
  var brokeRound = -1;      // 已经报过轮空横幅的局号

  // ── 取数小工具 ────────────────────────────────────────────────────────────

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

  function started() { return !!(meta.started && view && players().length); }

  function isMyTurn() {
    return !!(seat && view && view.phase === 'betting' && view.current === seat.playerId);
  }

  function isHost() {
    if (!seat) return false;
    if (seat.isHost != null) return !!seat.isHost;
    var ss = meta.seats || [];
    for (var i = 0; i < ss.length; i++) {
      if ((ss[i].playerId || ss[i].id) === seat.playerId) return !!ss[i].isHost;
    }
    var first = ss[0];
    return !!(first && (first.playerId || first.id) === seat.playerId);   // 兜底：首位入座者
  }

  function seatsForWait() {
    var ps = players();
    if (ps.length) return ps;
    return (meta.seats || []).map(function (s) {
      return { id: s.playerId || s.id, name: s.name, isAI: s.isAI };
    });
  }

  function clip(text, n) {
    var s = String(text == null ? '' : text);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function num(v) { return typeof v === 'number' ? v : 0; }

  // ── 牌面（纯 CSS，无图片；牌 id 沿用 S3..S15，14=A 15=2）───────────────────
  // ⚠️ 炸金花 A 最大、2 最小，但**牌面照常渲染**（"2" 就写 2），强度差异写在玩法说明里。

  var SUITS = {
    S: { sym: '♠', tone: 'black' },
    H: { sym: '♥', tone: 'red' },
    D: { sym: '♦', tone: 'red' },
    C: { sym: '♣', tone: 'black' }
  };
  var RANK_TEXT = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' };

  function parseCard(id) {
    var s = String(id || '');
    var suit = s.charAt(0);
    var rank = parseInt(s.slice(1), 10);
    if (!SUITS[suit] || !(rank >= 3 && rank <= 15)) return null;
    return { id: s, suit: suit, rank: rank };
  }

  function rankText(rank) { return RANK_TEXT[rank] || String(rank); }

  function cardLabel(id) {
    var c = parseCard(id);
    return c ? (SUITS[c.suit].sym + rankText(c.rank)) : String(id || '');
  }

  function cardsLabel(ids) { return (ids || []).map(cardLabel).join(' '); }

  /** 牌面正面。opts: {size:'sm', extra} */
  function cardFace(id, opts) {
    var o = opts || {};
    var c = parseCard(id);
    var cls = ['zj-card'];
    if (o.size) cls.push('zj-card--' + o.size);
    if (o.extra) cls.push(o.extra);
    if (!c) {
      cls.push('is-tone-black');
      return '<div class="' + cls.join(' ') + '"><span class="r">?</span><span class="s">?</span></div>';
    }
    cls.push('is-tone-' + SUITS[c.suit].tone);
    return '<div class="' + cls.join(' ') + '" data-id="' + esc(id) + '">' +
      '<span class="r">' + rankText(c.rank) + '</span>' +
      '<span class="s">' + SUITS[c.suit].sym + '</span>' +
      '<span class="c">' + SUITS[c.suit].sym + '</span></div>';
  }

  /** 牌背纹样：磨砂底 + 线框菱格（跟图标同规格的手写 SVG，零图片） */
  function cardBack() {
    return '<div class="zj-card zj-card--back">' +
      '<svg viewBox="0 0 44 62" width="100%" height="100%" fill="none" stroke="currentColor" ' +
      'stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="5" y="5" width="34" height="52" rx="7"/>' +
      '<path d="M22 13 32 31 22 49 12 31z"/>' +
      '<path d="M22 21 27 31 22 41 17 31z"/>' +
      '<circle cx="22" cy="31" r="2.4"/>' +
      '<path d="M9 31h3"/><path d="M32 31h3"/>' +
      '</svg></div>';
  }

  /** 一张「可翻面」的牌：背面在前，正面预转 180°；容器加 .is-open 就翻过来 */
  function cardSlot(id, i, open) {
    return '<div class="zj-slot' + (open ? ' is-open' : '') + '" style="--i:' + i + '"' +
      (id ? ' data-id="' + esc(id) + '"' : '') + '>' +
      '<div class="zj-flip">' +
      '<div class="zj-face zj-face--back">' + cardBack() + '</div>' +
      '<div class="zj-face zj-face--front">' + (id ? cardFace(id) : cardFace(null)) + '</div>' +
      '</div></div>';
  }

  // ── 图标（库里没有的按 BiscaIcons 规格手写，stroke 1.8）────────────────────

  function wrap(size, inner, w) {
    var s = size || 18;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" ' +
      'stroke="currentColor" stroke-width="' + (w || 1.8) + '" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }

  /** 闷着（没看牌）：闭眼 */
  function eyeShut(s) {
    return wrap(s, '<path d="M3 11.5c2.6 3.4 5.6 5.1 9 5.1s6.4-1.7 9-5.1"/>' +
      '<path d="M4.6 14.4 3 17"/><path d="M9 16.3 8.3 19"/><path d="M15 16.3 15.7 19"/>' +
      '<path d="M19.4 14.4 21 17"/>', 1.6);
  }

  /** 已看牌：睁眼 */
  function eyeOpen(s) {
    return wrap(s, '<path d="M2.6 12S6.4 6 12 6s9.4 6 9.4 6-3.8 6-9.4 6-9.4-6-9.4-6z"/>' +
      '<circle cx="12" cy="12" r="2.6"/>', 1.6);
  }

  /** 问号（玩法说明按钮） */
  function helpIcon(s) {
    return wrap(s, '<circle cx="12" cy="12" r="9"/>' +
      '<path d="M9.6 9.2a2.5 2.5 0 1 1 3.6 2.9c-.8.5-1.2 1-1.2 1.9"/>' +
      '<circle cx="12" cy="16.8" r="0.5"/>', 1.7);
  }

  // ── 引擎（防御性复用：只用来补一句牌型人话，拿不到就不显示）───────────────

  function handLabelOf(cards, given) {
    if (given) return given;
    var E = global.ZjhEngine;
    if (!E || typeof E.evalHand !== 'function' || typeof E.handLabel !== 'function') return '';
    if (!cards || cards.length !== 3) return '';
    try { return E.handLabel(E.evalHand(cards), (view && view.rules) || {}) || ''; } catch (e) { return ''; }
  }

  // ── 合法动作取数 ──────────────────────────────────────────────────────────

  function movesOf(type) {
    return legal.filter(function (m) { return m && m.type === type; });
  }

  function lookMove() { return movesOf('look')[0] || null; }

  /** 跟注 / 跟不起的全押（引擎保证最多一条） */
  function callMove() {
    return legal.filter(function (m) {
      return m && m.type === 'bet' && (m.kind === 'call' || m.kind === 'allin');
    })[0] || null;
  }

  function raiseMoves() {
    return legal.filter(function (m) {
      return m && m.type === 'bet' && (m.kind === 'raise' || m.kind === 'raise_allin');
    });
  }

  function compareMoves() { return movesOf('compare'); }

  // ── 动作 ──────────────────────────────────────────────────────────────────

  function send(type, extra) {
    if (busy || !seat) return Promise.resolve();
    busy = true;
    renderActions();
    return API.action(code, seat.playerToken, type, extra).then(function (r) {
      busy = false;
      // 回执里就带着新的 legal，先用上，等 SSE 那帧到了再对账
      if (r && Array.isArray(r.legal)) legal = r.legal;
      render();
    }, function (err) {
      busy = false;
      UI.toast(err.message, true);     // 服务端的中文报错直接显示
      render();
    });
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
    // 只放房号 + 局数：375px 上再加个游戏名会把这行挤成两行，把整个头部顶高
    $('r-code').textContent = code + (view && view.round ? ' · 第 ' + view.round + ' 局' : '');
    $('r-close').hidden = !isHost();
  }

  /** 座位卡上的状态徽标：轮空 / 弃牌 / 全押 / 已看 / 闷 */
  function stateTag(p) {
    if (p.out) return '<span class="zj-stag">轮空</span>';
    if (p.folded) return '<span class="zj-stag">弃牌</span>';
    if (p.allin) return '<span class="zj-stag is-hot">全押</span>';
    if (p.looked) return '<span class="zj-stag is-open">' + eyeOpen(12) + '已看</span>';
    return '<span class="zj-stag is-blind">' + eyeShut(12) + '闷</span>';
  }

  function seatCard(p) {
    var cls = ['cd-seat'];
    if (view && view.current === p.id && view.phase === 'betting') cls.push('is-turn');
    if (p.folded || p.out) cls.push('is-done');          // 弃牌 / 轮空一律置灰
    var idAttr = ' data-id="' + esc(p.id) + '"';

    // 还没开局：只报个名，别显示「0 筹码」这种没意义的数字
    if (!started()) {
      return '<div class="' + cls.join(' ') + '"' + idAttr + '><div class="top">' +
        (p.isAI ? '<i class="bot" title="AI 座位">' + UI.ICON.robot(13) + '</i>' : '') +
        '<span class="nm">' + esc(p.name || '') + '</span></div>' +
        '<div class="tail"><span class="tx">已入座</span></div></div>';
    }

    var isDealer = view && view.dealer === p.id;
    return '<div class="' + cls.join(' ') + '"' + idAttr + '>' +
      '<div class="top">' +
      (p.isAI ? '<i class="bot" title="AI 座位">' + UI.ICON.robot(13) + '</i>' : '') +
      '<span class="nm">' + esc(p.name || '') + '</span>' +
      (isDealer ? '<span class="zj-dealer" title="庄家">庄</span>' : '') +
      '</div>' +
      '<div class="cnt"><i class="zj-cic">' + UI.ICON.chips(13) + '</i>' +
      '<b>' + num(p.chips) + '</b><span class="u">筹码</span></div>' +
      '<div class="tail">' + stateTag(p) +
      '<span class="tx">投 ' + num(p.bet) + '</span></div>' +
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

  // ── 场面：筹码池 ──────────────────────────────────────────────────────────

  function renderField() {
    var turn = $('r-turn'), badges = $('r-badges');

    if (!started()) {
      turn.innerHTML = '等开局';
      $('r-pot').textContent = '0';
      $('r-bet').textContent = '—';
      $('r-ante').textContent = (meta.rules && meta.rules.base_bet) || '—';
      $('r-call').textContent = '—';
      badges.innerHTML = '';
      return;
    }

    if (view.phase === 'betting') {
      var cur = nameOf(view.current);
      turn.innerHTML = '轮到 <b>' + esc(cur) + '</b>' + (isMyTurn() ? '（你）' : '') + ' 说话';
    } else if (view.phase === 'round_over') {
      turn.innerHTML = '第 <b>' + num(view.round) + '</b> 局结束';
    } else if (view.phase === 'game_over') {
      turn.innerHTML = '整场结束';
    } else {
      turn.innerHTML = '';
    }

    $('r-pot').textContent = String(num(view.pot));
    $('r-bet').textContent = String(num(view.currentBet));
    $('r-ante').textContent = String((view.rules && view.rules.base_bet) || 0);

    var m = me();
    var callable = !!(m && view.phase === 'betting' && !m.folded && !m.allin &&
      typeof view.callCost === 'number');
    $('r-callcell').hidden = !callable;
    $('r-call').textContent = callable ? String(view.callCost) : '—';

    var bs = '';
    if (m && !m.folded && !m.out && view.phase === 'betting' && !m.looked) {
      bs += '<span class="cd-badge is-hot">' + eyeShut(13) + '你闷着 · 跟注半价</span>';
    }
    if (view.rules && view.rules.special_235) {
      bs += '<span class="cd-badge">235 克豹子</span>';
    }
    badges.innerHTML = bs;
  }

  // ── 流水 + 聊天（同一条流）────────────────────────────────────────────────
  // 每帧服务端都给全量（log 是整场累积、chat 是最近若干条），这里只 append 没见过的，
  // 绝不整区重画——重画会闪，还会把滚动位置弹回去。

  var FEED_MAX = 90;         // DOM 里最多留这么多条，超了从头上砍

  function logText(r) { return typeof r === 'string' ? r : ((r && r.text) || ''); }

  function chatRows() {
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

  // ── 我的三张牌（没看牌 = 牌背，看牌后翻面）────────────────────────────────

  function renderHand() {
    var box = $('r-handzone');
    if (!seat || !started()) {
      box.hidden = true;
      handSig = { round: -1, cards: '', n: -1 };
      return;
    }
    box.hidden = false;

    var m = me() || {};
    var cards = Array.isArray(m.cards) ? m.cards : null;    // 没看牌时服务端给 null
    var n = typeof m.handCount === 'number' ? m.handCount : (cards ? cards.length : 0);
    var round = num(view.round);
    var sig = cards ? cards.join(',') : '';

    if (sig !== handSig.cards || round !== handSig.round || n !== handSig.n) {
      // 同一局里从「没牌面」变成「有牌面」= 刚看牌，走翻面动画；其余情况直接落定态
      var flip = !!sig && !handSig.cards && handSig.round === round;
      var host = $('r-hand');
      if (!n) {
        host.innerHTML = '<div class="zj-hand-empty">' +
          (m.out ? '本局轮空，没给你发牌' : '还没发牌') + '</div>';
      } else if (cards) {
        host.innerHTML = cards.map(function (id, i) { return cardSlot(id, i, !flip); }).join('');
        if (flip) {
          var slots = host.querySelectorAll('.zj-slot');
          requestAnimationFrame(function () {
            Array.prototype.forEach.call(slots, function (el) { el.classList.add('is-open'); });
          });
        }
      } else {
        var backs = '';
        for (var i = 0; i < n; i++) backs += cardSlot(null, i, false);
        host.innerHTML = backs;
      }
      handSig = { round: round, cards: sig, n: n };
    }

    var label = handLabelOf(cards, m.hand);
    $('r-mine').innerHTML = '<i class="zj-cic">' + UI.ICON.chips(14) + '</i>' +
      '<b>' + num(m.chips) + '</b> 筹码 · 本局已投 <b>' + num(m.bet) + '</b>';
    var hint = $('r-hint');
    if (m.out) hint.textContent = '这局轮空';
    else if (cards) hint.textContent = label ? ('你的牌：' + label) : cardsLabel(cards);
    else hint.textContent = '三张暗牌，还闷着';
    hint.classList.toggle('is-bad', !!m.folded && !m.out);
  }

  // ── 通知条 ────────────────────────────────────────────────────────────────

  function renderNotice() {
    var el = $('r-notice');
    if (!seat || !started() || !view) { el.hidden = true; return; }
    var m = me();
    if (!m) { el.hidden = true; return; }

    if (view.phase === 'betting' && m.allin) {
      el.hidden = false;
      el.innerHTML = '你已经<b>全押</b>（投了 ' + num(m.bet) + '），接下来只能等摊牌。';
      return;
    }
    if (view.phase === 'betting' && m.folded) {
      el.hidden = false;
      el.innerHTML = '你这局<b>弃牌</b>了，投出去的 ' + num(m.bet) + ' 不退，等这局打完。';
      return;
    }
    // 别人轮空不占整条通知：座位卡 + “X 人轮空”徽标已经说清楚了，
    // 460px 矮屏上再塞一行会把聊天区和手牌顶重叠。
    el.hidden = true;
  }

  // ── 操作区 ────────────────────────────────────────────────────────────────

  function btn(label, cls, fn, disabled, act) {
    var b = document.createElement('button');
    b.className = 'cd-btn ' + (cls || '');
    b.type = 'button';
    b.innerHTML = label;
    if (act) b.dataset.act = act;
    b.disabled = !!disabled || busy;
    b.addEventListener('click', fn);
    return b;
  }

  function hintEl(html) {
    var d = document.createElement('div');
    d.className = 'cd-actbar-hint';
    d.innerHTML = html;
    return d;
  }

  /** 加注面板：legal 给的档位 + 自定义数字（clamp 在档位区间里） */
  function openRaise() {
    var ms = raiseMoves();
    if (!ms.length) { UI.toast('这一手加不了注', true); return; }
    var amounts = ms.map(function (m) { return m.amount; });
    var lo = Math.min.apply(null, amounts);
    var hi = Math.max.apply(null, amounts);
    var blind = !!ms[0].blind;

    var tiers = ms.map(function (m) {
      return '<button class="cd-btn zj-tier" type="button" data-act="raise-tier" ' +
        'data-amount="' + m.amount + '">' +
        '<b>抬到 ' + m.stake + '</b><i>掏 ' + m.amount +
        (m.kind === 'raise_allin' ? ' · 全押' : '') + '</i></button>';
    }).join('');

    UI.modal({
      sheet: true,
      className: 'zj-raise',
      html: '<div class="cd-sheet-grip"></div><h2>加注</h2>' +
        '<div class="sub">当前注 <b>' + num(view.currentBet) + '</b>，抬得越高后面的人跟得越贵。' +
        (blind ? '你还闷着，<b>掏一半的钱抬双倍的注</b>。' : '') + '</div>' +
        '<div class="zj-tiers">' + tiers + '</div>' +
        '<div class="cd-field-row"><span class="k">自己填（掏出去的筹码，' + lo + '~' + hi + '）</span>' +
        '<input id="rz-num" type="number" inputmode="numeric" min="' + lo + '" max="' + hi +
        '" value="' + lo + '"></div>' +
        '<div class="cd-sheet-acts">' +
        '<button class="cd-btn" type="button" id="rz-no">再想想</button>' +
        '<button class="cd-btn cd-btn--primary" type="button" id="rz-go" data-act="raise-go">加这么多</button>' +
        '</div>',
      onMount: function (h) {
        Array.prototype.forEach.call(h.el.querySelectorAll('[data-act="raise-tier"]'), function (b) {
          b.addEventListener('click', function () {
            h.close();
            send('bet', { amount: parseInt(b.dataset.amount, 10) });
          });
        });
        h.el.querySelector('#rz-no').addEventListener('click', function () { h.close(); });
        h.el.querySelector('#rz-go').addEventListener('click', function () {
          var v = parseInt(h.el.querySelector('#rz-num').value, 10);
          if (!v || v < 0) { UI.toast('填个数字吧', true); return; }
          v = Math.max(lo, Math.min(hi, v));      // clamp：越界直接按边界走，别让服务端 400
          h.close();
          send('bet', { amount: v });
        });
      }
    });
  }

  /** 比牌面板：legal 里的 compare target 列成对手按钮 */
  function openCompare() {
    var ms = compareMoves();
    if (!ms.length) { UI.toast('现在还不能比牌', true); return; }
    var rows = ms.map(function (m) {
      return '<button class="cd-btn zj-target" type="button" data-act="compare-pick" ' +
        'data-target="' + esc(m.target) + '">' +
        '<b>' + esc(m.targetName || nameOf(m.target)) + '</b>' +
        '<i>付 ' + num(m.cost) + ' 比一把</i></button>';
    }).join('');

    UI.modal({
      sheet: true,
      className: 'zj-cmp',
      html: '<div class="cd-sheet-grip"></div><h2>跟谁比牌</h2>' +
        '<div class="sub">付一份当前注比一把，<b>输的那个当场弃牌滚蛋</b>；平手算你输。' +
        '结果只有你俩知道。</div>' +
        '<div class="zj-targets">' + rows + '</div>',
      onMount: function (h) {
        Array.prototype.forEach.call(h.el.querySelectorAll('[data-act="compare-pick"]'), function (b) {
          b.addEventListener('click', function () {
            h.close();
            send('compare', { target: b.dataset.target });
          });
        });
      }
    });
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
      var need = meta.minPlayers || 2;
      if (isHost()) {
        bar.appendChild(btn('开局（' + n + ' 人）', 'cd-btn--primary cd-btn--wide', function () {
          API.startRoom(code, seat.playerToken).catch(function (e) { UI.toast(e.message, true); });
        }, n < need, 'start'));
        if (n < need) bar.appendChild(hintEl('至少 ' + need + ' 个人才能开'));
      } else {
        bar.appendChild(hintEl('等房主开局…'));
      }
      if (meta.inviteToken) bar.appendChild(btn('邀请朋友', 'cd-btn--ghost', copyInvite, false, 'invite'));
      return;
    }

    if (view.phase === 'game_over') {
      bar.appendChild(hintEl('整场结束了'));
      return;
    }

    if (view.phase === 'round_over') {
      bar.appendChild(btn('看结算', '', function () { openShowdown(true); }, false, 'showdown'));
      bar.appendChild(btn('开下一局', 'cd-btn--primary cd-btn--wide', function () {
        send('next_round');
      }, false, 'next'));
      if (isHost()) {
        bar.appendChild(btn('结束整场', 'cd-btn--danger', function () { send('end_match'); }, false, 'end'));
      }
      return;
    }

    var m = me() || {};
    if (m.out) { bar.appendChild(hintEl('这局你轮空，等下一局')); return; }
    if (m.allin) { bar.appendChild(hintEl('<b>已全押</b>，等摊牌')); return; }
    if (m.folded) { bar.appendChild(hintEl('你已经弃牌了，等这局打完')); return; }

    if (!isMyTurn()) {
      var cur = findPlayer(view.current);
      bar.appendChild(hintEl('等 ' + (cur && cur.isAI ? UI.ICON.robot(14) : '') +
        '<b>' + esc(cur ? cur.name : '对面') + '</b> 说话…'));
      return;
    }

    var box = document.createElement('div');
    box.className = 'zj-acts';
    bar.appendChild(box);

    if (!legal.length) {
      // 局面刚变、legal 还在路上（SSE 那帧不带）——按钮宁可空一瞬，也不摆过期的价码
      box.appendChild(hintEl('正在取这一手能做什么…'));
      refreshLegal();
      return;
    }

    var lk = lookMove();
    if (lk) {
      box.appendChild(btn(eyeOpen(16) + '看牌', 'zj-full', function () { send('look'); }, false, 'look'));
    }

    var cm = callMove();
    if (cm) {
      var label = (cm.kind === 'allin')
        ? ('全押 ' + cm.amount)
        : ('跟注 ' + cm.amount + (cm.blind ? '<i class="zj-half">闷·半价</i>' : ''));
      box.appendChild(btn(label, 'cd-btn--primary zj-full', function () {
        send('bet', { amount: cm.amount });
      }, false, 'call'));
    }

    var rms = raiseMoves();
    box.appendChild(btn('加注', '', openRaise, !rms.length, 'raise'));

    var cms = compareMoves();
    box.appendChild(btn('比牌', '', openCompare, !cms.length, 'compare'));

    if (movesOf('fold').length) {
      box.appendChild(btn('弃牌', 'cd-btn--danger', function () { send('fold'); }, false, 'fold'));
    }
  }

  // ── 未开局面板 ────────────────────────────────────────────────────────────

  function ruleChips() {
    var rules = (view && view.rules) || meta.rules || {};
    var items = (gmeta && gmeta.ruleMeta) || [];
    if (!items.length) return '';
    return items.map(function (r) {
      var v = rules[r.key];
      if (typeof r.def === 'boolean') {
        return '<span class="cd-chip' + (v ? ' is-on' : '') + '">' + esc(r.label) + '</span>';
      }
      return '<span class="cd-chip is-on">' + esc(r.label) + ' ' +
        esc(String(v == null ? r.def : v)) + '</span>';
    }).join('');
  }

  function renderWait() {
    var el = $('r-wait');
    var stage = $('r-stage');
    // 说明卡是 inset:0 的覆盖层，等人阶段得让出底下那条聊天（CSS 给它抬 bottom）
    if (stage) stage.classList.toggle('is-waiting', !started());
    if (started()) { el.hidden = true; return; }
    el.hidden = false;
    var ss = seatsForWait();
    var maxp = meta.maxPlayers || 4;
    var minp = meta.minPlayers || 2;
    el.innerHTML = '<div class="box cn-card">' +
      '<div><div class="cd-eyebrow">房间号</div><h2>' + esc(code) + '</h2></div>' +
      '<div class="sub">把房间号发给对面，他们在大厅点进来就能坐下。' +
      minp + '~' + maxp + ' 人，凑够 ' + minp + ' 个房主就能开局。</div>' +
      '<div class="cd-seatlist">' + (ss.length ? ss.map(function (s) {
        return '<div class="cd-seatrow">' +
          (s.isAI ? '<i class="bot">' + UI.ICON.robot(14) + '</i>' : '') +
          '<span class="nm">' + esc(s.name || '') + '</span>' +
          '<span class="role">' + (seat && seat.playerId === s.id ? '你' : '玩家') + '</span></div>';
      }).join('') : '<div class="cd-empty">还没人坐下</div>') + '</div>' +
      '<div class="cd-rulechips">' + ruleChips() + '</div>' +
      '</div>';
  }

  // ── 摊牌结算卡 ────────────────────────────────────────────────────────────

  var REASON = {
    showdown: '摊牌！',
    last_standing: '其他人全弃了'
  };

  function openShowdown(manual) {
    if (!view || view.phase !== 'round_over') return;
    var res = view.lastResults || {};
    var reveal = (view.showdown && view.showdown.reveal) ||
      (Array.isArray(res.reveal) ? res.reveal : []);
    var gains = {};
    (res.winners || []).forEach(function (w) { gains[w.playerId] = w; });

    var rows = reveal.map(function (r, i) {
      var w = gains[r.playerId];
      var label = handLabelOf(r.cards, r.label);
      return '<div class="zj-show-row' + (seat && r.playerId === seat.playerId ? ' is-me' : '') +
        (w ? ' is-win' : '') + '" style="--i:' + i + '">' +
        '<div class="hd"><span class="nm">' + esc(r.name || nameOf(r.playerId)) + '</span>' +
        (w ? '<span class="gain">+' + num(w.gain) + '</span>' : '<span class="gain is-none">—</span>') +
        '</div>' +
        '<div class="cards">' + (r.cards || []).map(function (id) {
          return cardFace(id, { size: 'sm' });
        }).join('') + '</div>' +
        '<div class="lbl">' + esc(label || '') + '</div>' +
        '</div>';
    }).join('');

    var quit = players().filter(function (p) {
      return p.folded && !p.out && !gains[p.id] && reveal.every(function (r) { return r.playerId !== p.id; });
    });
    var outs = players().filter(function (p) { return p.out; });

    var acts = '<button class="cd-btn cd-btn--primary" type="button" id="sd-next" data-act="next">开下一局</button>';
    if (isHost()) {
      acts = '<button class="cd-btn cd-btn--danger" type="button" id="sd-end" data-act="end">结束整场</button>' + acts;
    }

    if (showHandle) { showHandle.close(); showHandle = null; }
    showHandle = UI.modal({
      className: 'zj-show',
      onClose: function () { showHandle = null; },
      html: '<div class="cd-eyebrow">第 ' + num(res.round || view.round) + ' 局 · 池底 ' +
        num(res.pot != null ? res.pot : 0) + '</div>' +
        '<h2>' + esc(REASON[res.reason] || '本局结束') + '</h2>' +
        '<div class="zj-show-list">' + (rows || '<div class="cd-empty">没人摊牌</div>') + '</div>' +
        (quit.length ? '<div class="zj-show-foot">弃牌：' +
          quit.map(function (p) { return esc(p.name || ''); }).join('、') + '</div>' : '') +
        (outs.length ? '<div class="zj-show-foot">轮空：' +
          outs.map(function (p) { return esc(p.name || ''); }).join('、') + '</div>' : '') +
        (seat ? '<div class="cd-modal-acts">' + acts + '</div>' : ''),
      onMount: function (h) {
        var n = h.el.querySelector('#sd-next');
        if (n) n.addEventListener('click', function () { h.close(); send('next_round'); });
        var e = h.el.querySelector('#sd-end');
        if (e) e.addEventListener('click', function () { h.close(); send('end_match'); });
      }
    });
    if (manual) shownRound = num(view.round);
  }

  function renderOverlays() {
    if (!view) return;

    if (view.phase === 'round_over') {
      if (shownRound !== num(view.round)) {
        shownRound = num(view.round);
        openShowdown(false);
      }
    } else {
      if (showHandle) { showHandle.close(); showHandle = null; }
      if (view.phase !== 'game_over') shownRound = -1;
    }

    if (view.phase === 'game_over') {
      UI.gameOver(view, { meId: seat && seat.playerId });
    } else {
      UI.hideGameOver();
    }
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

    // 新的一局里有人轮空：横幅报一次（log 里也有一条，横幅只是别让人错过）
    if (view && view.phase === 'betting' && num(view.round) !== brokeRound &&
      players().some(function (p) { return p.out; })) {
      brokeRound = num(view.round);
      UI.banner($('r-field'), '有人轮空', 'alt');
    }

    // 轮到我了震一下（没有 vibrate 就静默跳过）
    var mineTurn = isMyTurn();
    if (mineTurn && !lastTurnMine && navigator.vibrate) {
      try { navigator.vibrate(30); } catch (e) { /* ignore */ }
    }
    lastTurnMine = mineTurn;
  }

  // ── 同步 ──────────────────────────────────────────────────────────────────

  function legalStamp() {
    if (!seat || !view) return '';
    return num(view.seq) + '|' + view.phase + '|' + (view.current || '') + '|' + seat.playerId;
  }

  /**
   * SSE 那帧不带 legal（只有 GET /state / POST /action 带），局面一变就补一次。
   * 拉回来的 payload 直接喂回 onPayload，指纹没变就不会再拉——不会打转。
   */
  function refreshLegal() {
    if (!seat || !view || legalBusy) return;
    var stamp = legalStamp();
    if (!stamp || stamp === legalKey) return;
    legalBusy = true;
    legalKey = stamp;
    API.getState(code, seat.playerToken).then(function (p) {
      legalBusy = false;
      onPayload(p);
    }, function () {
      legalBusy = false;
      legalKey = '';        // 拉失败：下一帧再试
    });
  }

  function ingest(p) {
    if (!p || typeof p !== 'object') return;
    if (p.name) meta.name = p.name;
    if (p.seats) meta.seats = p.seats;
    if (p.rules) meta.rules = p.rules;
    if (typeof p.started === 'boolean') meta.started = p.started;
    if (typeof p.minPlayers === 'number') meta.minPlayers = p.minPlayers;
    if (typeof p.maxPlayers === 'number') meta.maxPlayers = p.maxPlayers;
    // 聊天挂在外层（statePayload.chat），不在脱敏后的 view 里
    if (Array.isArray(p.chat)) meta.chat = p.chat;
    // 邀请 token 只有 owner 视角的 GET /state 拿得到，有就记下用于「邀请朋友」
    if (p.inviteToken) meta.inviteToken = p.inviteToken;

    var v = (p.state && typeof p.state === 'object') ? p.state : null;
    if (v) view = v;
    else if (!p.started) view = null;      // 还没开局：没有 state 很正常

    // legal 只有部分接口带；带了就连指纹一起记下，没带就把过期的那份先丢掉
    // （拿旧价码画按钮 = 点下去必吃服务端 400，不如空一瞬等 refreshLegal 补上）
    if (Array.isArray(p.legal)) {
      legal = p.legal;
      legalKey = legalStamp();
    } else if (legalStamp() !== legalKey) {
      legal = [];
    }
    if (!seat) { legal = []; legalKey = ''; }
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
    maybeAskSeat();
    refreshLegal();
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
      html: '<h2>坐下来打一局炸金花</h2>' +
        '<div class="sub">「' + esc(meta.name || code) + '」还没开局，报个名字就能上桌。</div>' +
        '<div class="cd-field-row"><span class="k">昵称</span>' +
        '<input id="jd-name" maxlength="16" placeholder="怎么称呼你" value="' + esc(last.name || '') + '"></div>' +
        '<div class="cd-modal-acts">' +
        '<button class="cd-btn" type="button" id="jd-watch">只看看</button>' +
        '<button class="cd-btn cd-btn--primary" type="button" id="jd-ok">入座</button></div>',
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
    if (meta.started) return;            // 已开局又没座位 = 观战
    if (!meta.seats && !view) return;    // 还没收到第一帧
    joinAsked = true;
    askJoin();
  }

  /** 入座后要带着 token 重开一条 SSE，才收得到自己的牌 */
  function reopen() {
    if (sync) sync.close();
    legalKey = '';
    sync = API.openSync(code, seat && seat.playerToken, onPayload, onStatus);
    // 顺手拉一份：新连接的第一帧偶尔要等，别让刚入座的人对着旧画面发呆
    API.getState(code, seat && seat.playerToken).then(onPayload, function () { /* 等 SSE 就行 */ });
  }

  // ── 启动 ──────────────────────────────────────────────────────────────────

  function boot() {
    if (!code) {
      document.body.innerHTML = '<div class="cd-empty" style="padding-top:80px">没给房间号，回大厅重来吧</div>';
      return;
    }
    $('r-code').textContent = code;
    $('r-back').innerHTML = UI.icon('back', 22);
    $('r-score').innerHTML = UI.icon('coins', 20);
    $('r-poticon').innerHTML = UI.ICON.chips(22);

    $('r-help').innerHTML = helpIcon(20);
    $('r-help').addEventListener('click', function () { UI.rulesHelp('zjh'); });

    $('r-close').innerHTML = UI.icon('door', 20);
    $('r-close').addEventListener('click', function () {
      if (!isHost()) return;
      UI.modal({
        html: '<h2>关闭这个房间？</h2>' +
          '<p class="sub">牌局、筹码和聊天记录会一起删掉，大家都会被请回大厅。</p>' +
          '<div class="cd-modal-acts">' +
          '<button class="cd-btn" type="button" id="cl-no">再打打</button>' +
          '<button class="cd-btn cd-btn--danger" type="button" id="cl-yes">关闭房间</button></div>',
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

    $('r-score').addEventListener('click', function () {
      if (!view || !players().length) { UI.toast('还没开局，没筹码可算'); return; }
      UI.scoreboard(view, {
        meId: seat && seat.playerId,
        unit: '筹码',
        noteOf: function (p) {
          var st = p.out ? '轮空' : (p.folded ? '已弃' : (p.allin ? '全押' : ''));
          return num(p.chips) + (st ? ' · ' + st : '');
        },
        canNext: !!seat && view.phase === 'round_over',
        canEnd: isHost() && view.phase !== 'game_over',
        onNext: function () { send('next_round'); },
        onEnd: function () { send('end_match'); }
      });
    });

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

    // 规则 chip 的中文标签来自引擎 meta（拿不到就不画 chip，不影响玩）
    API.gameMeta('zjh').then(function (m) {
      gmeta = m;
      if (!started()) renderWait();
    }, function () { /* 无所谓 */ });

    seat = API.loadSeat(code);
    // 复座校验走 GET /state 而不是 rejoin：token 过期时 join 会**新开一个座位**
    // （服务端认不出 token 就走正常入座那条路），白白多出一个"玩家3"。
    var pre = (seat && seat.playerToken)
      ? API.getState(code, seat.playerToken).then(function (v) {
        var ss = (v && v.seats) || [];
        var mine = ss.some(function (s) { return (s.playerId || s.id) === seat.playerId; });
        if (ss.length && !mine) {        // 座位表里没我 = 这张 token 过期了
          API.clearSeat(code);
          seat = null;
        }
      }, function () {
        API.clearSeat(code);            // 房间被清了/重建了
        seat = null;
      })
      : Promise.resolve();

    pre.then(function () {
      sync = API.openSync(code, seat && seat.playerToken, onPayload, onStatus);
      API.getState(code, seat && seat.playerToken).then(onPayload, function () { /* 等 SSE 就行 */ });
    });

    window.addEventListener('beforeunload', function () { if (sync) sync.close(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
