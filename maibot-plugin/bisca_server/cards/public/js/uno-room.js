/* Bisca 棋牌室 —— UNO 牌桌主控
 * 骨架照抄 daifugo/public/js/room.js（入座/复座/观战、SSE 分视角同步、座位条 + 气泡、
 * 流水聊天混排、邀请朋友、关房、说明抽屉、IME 回车守卫全套），换成共享 cd-* 外壳。
 * UNO 自己的部分：彩色牌面、顶牌 + 当前生效颜色 + 方向、手牌按色分组、点牌即出、
 * 万能牌选色弹层、摸牌 pending 两选一、UNO! 徽标、本局结算卡。
 * 合法性预判走 window.UnoEngine（引擎源码 /cards/engine/uno.js）；**引擎缺席就整体降级**：
 * 手牌全亮、不预判，错了让服务端的中文报错说话。
 */
(function (global) {
  'use strict';

  var API = global.CdAPI;
  var UI = global.CdUI;
  var esc = UI.esc;

  /** 引擎每次用之前重新取一次：<script> 是异步 onerror 降级，可能比这支脚本晚就位 */
  function eng() { return global.UnoEngine || null; }

  var $ = function (id) { return document.getElementById(id); };
  var code = (new URLSearchParams(location.search).get('c') || '').toUpperCase();

  var seat = null;          // {playerId, playerToken, name, isHost?}
  var view = null;          // 最近一次「我视角」的 view（未开局时是外层壳）
  var meta = {};            // 房间壳信息（名字/房主/座位表/规则/邀请码）
  var gmeta = null;         // 引擎 meta（人数下限 + 规则开关表），CdAPI.gameMeta('uno') 拿
  var sync = null;
  var busy = false;
  var legalList = [];       // 服务端给的合法招（只有 REST /state 和 action 回包带）
  var legalSeq = -1;        // 上面那份是哪个 seq 的——对不上就不敢用
  var handKey = '';
  var topKey = '';
  var ringKey = '';
  var dirKey = '';
  var lastDir = null;
  var shownRound = -1;
  var resultBox = null;
  var lastTurnMine = false;
  var joinAsked = false;
  var roomClosed = false;
  var feedSeen = {};        // 流水/聊天条目去重（key -> 1），只进不出
  var feedPrimed = false;   // 第一帧只补历史，不弹气泡也不飘横幅
  var bubbles = {};         // playerId -> {text, until}
  var chatBusy = false;

  var COLOR_CN = { R: '红', G: '绿', B: '蓝', Y: '黄' };
  var COLORS = ['R', 'G', 'B', 'Y'];

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

  function myHand() {
    var m = me();
    if (m && m.hand) return m.hand;
    if (view && view.hand) return view.hand;
    return [];
  }

  function started() {
    var p = view && view.phase;
    return !!(p && p !== 'lobby' && p !== 'waiting' && players().length);
  }

  function isMyTurn() {
    return !!(seat && view && view.phase === 'playing' && view.current === seat.playerId);
  }

  function isHost() {
    if (!seat) return false;
    if (seat.isHost != null) return !!seat.isHost;
    var h = meta.hostId;
    if (h) return h === seat.playerId;
    var first = (meta.seats || [])[0] || players()[0];
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

  // ── 牌 ────────────────────────────────────────────────────────────────────
  // 引擎在就用引擎的 parseCard/cardLabel/sortCards/canPlay，不在就用这儿的土办法顶上。
  // id 形如 'R5#1' / 'RS#1'(Skip) / 'RR#1'(Reverse) / 'RD#1'(+2) / 'W#1' / 'WD#1'(+4)

  var KIND_OF = { S: 'skip', R: 'rev', D: 'draw2' };
  var KIND_CN = { skip: '跳过', rev: '反转', draw2: '+2' };

  /** 永远返回一个对象（引擎认不出的怪 id 也给个壳，别让渲染整片炸掉） */
  function info(id) {
    var E = eng();
    if (E && E.parseCard) {
      var c = E.parseCard(id);
      if (c) return c;
    }
    var base = String(id == null ? '' : id).split('#')[0];
    if (base === 'W') return { id: id, color: null, value: 'W', kind: 'wild', num: null, wild: true };
    if (base === 'WD') return { id: id, color: null, value: 'WD', kind: 'wild4', num: null, wild: true };
    var color = base.charAt(0);
    var v = base.slice(1);
    var kind = KIND_OF[v] || 'num';
    return { id: id, color: color, value: v, kind: kind, num: kind === 'num' ? Number(v) : null, wild: false };
  }

  function labelOf(id) {
    var E = eng();
    if (E && E.cardLabel) return E.cardLabel(id);
    var c = info(id);
    if (c.kind === 'wild') return '万能';
    if (c.kind === 'wild4') return '万能+4';
    return (COLOR_CN[c.color] || '') + (KIND_CN[c.kind] || c.value);
  }

  function svg(size, sw, inner) {
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" ' +
      'stroke="currentColor" stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + inner + '</svg>';
  }

  /** ⊘ 跳过 */
  function svgSkip(s) { return svg(s, 2.4, '<circle cx="12" cy="12" r="8.2"/><path d="M6.2 6.2 17.8 17.8"/>'); }
  /** ⇄ 反转 */
  function svgRev(s) {
    return svg(s, 2.1, '<path d="M3.6 9h13.2"/><path d="M13.4 5.4 17.2 9l-3.8 3.6"/>' +
      '<path d="M20.4 15H7.2"/><path d="M10.6 11.4 6.8 15l3.8 3.6"/>');
  }
  /** ⟳ 方向（顺时针；逆时针靠 CSS scaleX(-1) 镜像） */
  function svgDir(s) { return svg(s, 1.9, '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20.6 4.4V10h-5.6"/>'); }
  /** 纸飞机（发送键） */
  function planeIcon(s) {
    return svg(s, 1.7, '<path d="M21.2 3.3 2.9 10.1a.62.62 0 0 0 .04 1.17l7.06 2.2 2.2 7.06a.62.62 0 0 0 1.17.04z"/>' +
      '<path d="M21.2 3.3 10 14.5"/>');
  }
  /** 四色田字（万能牌的角标 / 牌心） */
  function quad(cls) { return '<span class="uno-quad' + (cls || '') + '"><i></i><i></i><i></i><i></i></span>'; }

  function glyphHtml(c, big) {
    if (c.kind === 'skip') return '<span class="glyph">' + svgSkip(big ? 44 : 25) + '</span>';
    if (c.kind === 'rev') return '<span class="glyph">' + svgRev(big ? 44 : 25) + '</span>';
    if (c.kind === 'draw2') return '<span class="glyph is-sm">+2</span>';
    if (c.kind === 'wild') return '<span class="glyph">' + quad(' uno-quad--mid') + '</span>';
    if (c.kind === 'wild4') return '<span class="glyph">' + quad(' uno-quad--mid') + '<b>+4</b></span>';
    return '<span class="glyph">' + esc(c.value) + '</span>';
  }

  /**
   * 一张牌的 HTML。色盲友好双编码：色块 + 左上角 R/G/B/Y 字母；
   * 功能牌的符号全是 SVG/文字（⊘ / ⇄ / +2 / 田字 / +4），一个 emoji 都没有。
   * opts: {tag:'button', big:true, cls:'is-grp', disabled:true}
   */
  function cardHtml(id, opts) {
    var o = opts || {};
    var c = info(id);
    var cls = ['uno-card', c.wild ? 'is-wild' : ('is-' + String(c.color || '').toLowerCase())];
    if (o.big) cls.push('is-big');
    if (o.cls) cls.push(o.cls);
    var tag = o.tag || 'div';
    var head = c.wild
      ? '<span class="corner">' + quad('') + '</span>'
      : '<span class="ltr">' + esc(c.color) + '</span>';
    return '<' + tag + ' class="' + cls.join(' ') + '" data-id="' + esc(id) + '"' +
      (tag === 'button' ? ' type="button"' + (o.disabled ? ' disabled' : '') : '') +
      ' aria-label="' + esc(labelOf(id)) + '">' + head + glyphHtml(c, !!o.big) + '</' + tag + '>';
  }

  /** 手牌排序：引擎的 sortCards 优先（R→G→B→Y→万能，同色 0-9 → 跳过 → 反转 → +2） */
  var COLOR_ORDER = { R: 0, G: 1, B: 2, Y: 3 };
  var VALUE_ORDER = { S: 10, R: 11, D: 12 };

  function sortHand(hand) {
    var E = eng();
    if (E && E.sortCards) {
      try { return E.sortCards(hand); } catch (e) { /* 引擎版本对不上就自己排 */ }
    }
    return hand.slice().sort(function (a, b) {
      var ca = info(a), cb = info(b);
      var oa = ca.wild ? 4 : COLOR_ORDER[ca.color];
      var ob = cb.wild ? 4 : COLOR_ORDER[cb.color];
      if (oa !== ob) return oa - ob;
      var va = ca.wild ? (ca.kind === 'wild' ? 0 : 1) : (VALUE_ORDER[ca.value] !== undefined ? VALUE_ORDER[ca.value] : ca.num);
      var vb = cb.wild ? (cb.kind === 'wild' ? 0 : 1) : (VALUE_ORDER[cb.value] !== undefined ? VALUE_ORDER[cb.value] : cb.num);
      if (va !== vb) return va - vb;
      return a < b ? -1 : 1;
    });
  }

  /**
   * 拿 view 拼一份「够 playError 用」的假 state：
   * 引擎的 canPlay 只读 pending / drawStack / activeColor / discard 末张，脱敏 view 全给了。
   */
  function shimState() {
    var p = view && view.pending;
    return {
      pending: (p && p.playerId) ? { playerId: p.playerId, card: p.card } : null,
      drawStack: (view && view.drawStack) || 0,
      activeColor: view && view.activeColor,
      discard: (view && view.top) ? [view.top] : []
    };
  }

  /** 现在能出的牌 {id:1}；不轮到我返回 null（= 不做置灰，没信息就别乱画） */
  function playableSet() {
    if (!seat || !view || !isMyTurn()) return null;
    var hand = myHand();
    var out = {};
    var E = eng();
    if (E && E.canPlay) {
      try {
        var s = shimState(), p = { id: seat.playerId, hand: hand.slice() };
        hand.forEach(function (id) { if (E.canPlay(s, p, id)) out[id] = 1; });
        return out;
      } catch (e) { out = {}; /* 掉到下面两条兜底 */ }
    }
    // 服务端给过合法招、而且就是这一帧的（SSE 不带 legal，所以多半用不上）
    if (legalSeq === (view.seq || 0) && legalList.length) {
      legalList.forEach(function (m) { if (m && m.type === 'play' && m.card) out[m.card] = 1; });
      return out;
    }
    hand.forEach(function (id) { out[id] = 1; });   // 引擎缺席：全亮，错了服务端说
    return out;
  }

  // ── 动作 ──────────────────────────────────────────────────────────────────

  function send(type, extra) {
    if (busy || !seat) return Promise.resolve();
    busy = true;
    renderActions();
    return API.action(code, seat.playerToken, type, extra).then(function (r) {
      busy = false;
      if (r && Array.isArray(r.legal) && r.view && typeof r.view.seq === 'number') {
        legalList = r.legal;
        legalSeq = r.view.seq;
      }
      render();
    }, function (err) {
      busy = false;
      UI.toast(err.message, true);     // 服务端的中文报错直接显示
      render();
    });
  }

  /** 万能牌先弹选色，选完才带 color 发 play */
  function askColor(id) {
    var btns = COLORS.map(function (k) {
      return '<button class="uno-pickbtn is-' + k.toLowerCase() + '" type="button" data-c="' + k + '">' +
        '<span class="sw"></span><b>' + COLOR_CN[k] + '</b><i>' + k + '</i></button>';
    }).join('');
    UI.modal({
      html: '<h2>指定一个颜色</h2>' +
        '<div class="sub">出 <b>' + esc(labelOf(id)) + '</b>，下一家得跟着这个颜色走。</div>' +
        '<div class="uno-pick">' + btns + '</div>' +
        '<div class="cd-modal-acts"><button class="cd-btn" id="pk-no" type="button">先不出</button></div>',
      onMount: function (h) {
        Array.prototype.forEach.call(h.el.querySelectorAll('.uno-pickbtn'), function (b) {
          b.addEventListener('click', function () {
            h.close();
            send('play', { card: id, color: b.dataset.c });
          });
        });
        h.el.querySelector('#pk-no').addEventListener('click', function () { h.close(); });
      }
    });
  }

  function playCard(id) {
    if (!isMyTurn()) { UI.toast('还没轮到你', true); return; }
    if (info(id).wild) askColor(id);
    else send('play', { card: id });
  }

  function copyInvite() {
    // 指跳转页 room.html：它查完这间房是什么游戏再 replace 到对应牌桌，换游戏也不会失效
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
    $('r-name').textContent = meta.name || 'UNO 房间';
    $('r-code').textContent = code + (started() && view.round ? ' · 第 ' + view.round + ' 局' : '');
    $('r-close').hidden = !isHost();
  }

  function seatCard(p) {
    var cls = ['cd-seat'];
    if (view && view.current === p.id && view.phase === 'playing') cls.push('is-turn');
    if (seat && seat.playerId === p.id) cls.push('is-me');
    var idAttr = ' data-id="' + esc(p.id) + '"';
    var bot = p.isAI ? '<i class="bot" title="AI 座位">' + UI.ICON.robot(13) + '</i>' : '';

    // 还没开局：只报个名，别显示「0 张」这种没意义的数字
    if (!started()) {
      return '<div class="' + cls.join(' ') + '"' + idAttr + '><div class="top">' + bot +
        '<span class="nm">' + esc(p.name || '') + '</span></div>' +
        '<div class="tail"><span class="tx">已入座</span></div></div>';
    }

    var count = typeof p.handCount === 'number' ? p.handCount : (p.hand ? p.hand.length : 0);
    var uno = !!(p.uno || count === 1);
    if (uno) cls.push('has-uno');

    var tail = [];
    if (view.phase === 'playing' && view.current === p.id) {
      tail.push(view.pending && view.pending.playerId === p.id ? '摸了一张' : (p.isAI ? '思考中' : '出牌中'));
    }

    return '<div class="' + cls.join(' ') + '"' + idAttr + '>' +
      '<div class="top">' + bot + '<span class="nm">' + esc(p.name || '') + '</span></div>' +
      '<div class="cnt"><b>' + count + '</b><span class="u">张</span>' +
      '<span class="u">· ' + (p.score || 0) + ' 分</span></div>' +
      '<div class="tail">' + (tail.length ? '<span class="tx">' + esc(tail.join(' · ')) + '</span>' : '') + '</div>' +
      (uno ? '<span class="uno-tag">UNO!</span>' : '') +
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

  // ── 场面 ──────────────────────────────────────────────────────────────────

  function dirHtml(label) {
    return '<span class="ic">' + svgDir(20) + '</span><span class="tx">' + esc(label) + '</span>';
  }

  function renderField() {
    var turn = $('r-turn'), badges = $('r-badges'), top = $('r-top');
    var ring = $('r-color'), dir = $('r-dir'), deck = $('r-deck');

    if (!started()) {
      turn.innerHTML = '等开局';
      badges.innerHTML = '';
      top.innerHTML = '<div class="empty">还没发牌</div>';
      ring.dataset.color = '';
      ring.innerHTML = '<span class="sw"></span><span class="lt">—</span><span class="nm">等开局</span>';
      dir.dataset.dir = '1';
      dir.innerHTML = dirHtml('顺时针');
      deck.innerHTML = '<b>—</b><span>张牌库</span>';
      topKey = ''; ringKey = ''; dirKey = '';
      return;
    }

    if (view.phase === 'playing') {
      turn.innerHTML = '轮到 <b>' + esc(nameOf(view.current)) + '</b>' + (isMyTurn() ? '（你）' : '');
    } else if (view.phase === 'round_over') {
      turn.innerHTML = '第 ' + (view.round || 1) + ' 局结束';
    } else if (view.phase === 'game_over') {
      turn.innerHTML = '整场结束';
    } else {
      turn.innerHTML = '';
    }

    var bs = '';
    if (view.drawStack > 0) bs += '<span class="cd-badge is-warn">+2 累计 ' + view.drawStack + ' 张</span>';
    if (view.rules && view.rules.stack_draw2) bs += '<span class="cd-badge">+2 叠加</span>';
    badges.innerHTML = bs;

    // 顶牌：同一张就不重画，免得掉牌动画每帧重播（discardCount 变了才是真出了新牌）
    var tk = String(view.top || '') + '|' + (view.discardCount || 0);
    if (tk !== topKey) {
      topKey = tk;
      top.innerHTML = view.top ? cardHtml(view.top, { big: true }) : '<div class="empty">空</div>';
    }

    // 当前生效颜色：万能牌指定颜色后和顶牌可能不同色，**以这里为准**
    var col = view.activeColor || '';
    if (col !== ringKey) {
      ringKey = col;
      ring.dataset.color = col;
      ring.innerHTML = '<span class="sw"></span><span class="lt">' + esc(col || '—') + '</span>' +
        '<span class="nm">' + esc(view.activeColorName || COLOR_CN[col] || '未定') + '</span>';
    }

    var d = (view.dir < 0) ? '-1' : '1';
    var dl = view.dirLabel || (view.dir < 0 ? '逆时针' : '顺时针');
    if (d + dl !== dirKey) {
      dirKey = d + dl;
      dir.dataset.dir = d;
      dir.innerHTML = dirHtml(dl);
    }

    deck.innerHTML = '<b>' + (typeof view.deckCount === 'number' ? view.deckCount : '—') + '</b><span>张牌库</span>';
  }

  // ── 流水 + 聊天（同一条流）────────────────────────────────────────────────
  // 每帧服务端都给全量（log 是最近 400 条、chat 是最近 60 条），这里只 append 没见过的，
  // 绝不整区重画——重画会闪，还会把滚动位置弹回去。

  var FEED_MAX = 90;         // DOM 里最多留这么多条，超了从头上砍

  // 从流水里挑该飘横幅的事件（type 来自引擎 logAdd）
  var BANNER = { skip: ['跳过', 'alt'], reverse: ['反转', ''] };

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
      fresh.push({
        html: '<div class="row" data-key="' + esc(key) + '">' + esc(text) + '</div>',
        banner: (feedPrimed && r && BANNER[r.type]) ? BANNER[r.type] : null
      });
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
        if (it.banner) UI.banner($('r-field'), it.banner[0], it.banner[1]);
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

  // ── 手牌 ──────────────────────────────────────────────────────────────────

  function renderHand() {
    var box = $('r-handzone');
    if (!seat || !started()) { box.hidden = true; return; }   // 观战 / 还没发牌
    box.hidden = false;

    var hand = sortHand(myHand());
    var key = hand.join(',');
    if (key !== handKey) {
      handKey = key;
      var prevGrp = null;
      $('r-fan').innerHTML = hand.length ? hand.map(function (id) {
        var c = info(id);
        var g = c.wild ? 'W' : c.color;
        var cls = (prevGrp !== null && g !== prevGrp) ? 'is-grp' : '';   // 换一色留道缝
        prevGrp = g;
        return cardHtml(id, { tag: 'button', cls: cls });
      }).join('') : '<div class="empty">手里空了</div>';
    }

    $('r-mine').innerHTML = '你的手牌 <b>' + hand.length + '</b> 张';
    syncHand();
  }

  /** 亮/灰/可点，不重建 DOM */
  function syncHand() {
    var alive = playableSet();
    var canTap = !!(seat && isMyTurn() && !busy);
    Array.prototype.forEach.call($('r-fan').children, function (el) {
      if (!el.dataset || !el.dataset.id) return;
      var ok = !alive || !!alive[el.dataset.id];
      el.classList.toggle('is-dead', !!alive && !ok);
      el.classList.toggle('is-hot', !!alive && ok);
      el.disabled = !canTap || (!!alive && !ok);
    });

    var hint = $('r-hint');
    hint.classList.remove('is-bad');
    if (!started()) { hint.textContent = ''; return; }
    if (view.phase === 'round_over') { hint.textContent = '本局结束了'; return; }
    if (view.phase === 'game_over') { hint.textContent = ''; return; }
    if (!isMyTurn()) { hint.textContent = '等别人出牌'; return; }
    if (view.pending && view.pending.mine) { hint.textContent = '刚摸的那张：出掉，或者留着'; return; }
    if (view.drawStack > 0) {
      hint.textContent = '被 +2 指着：接一张 +2，或者摸 ' + view.drawStack + ' 张';
      hint.classList.add('is-bad');
      return;
    }
    if (!alive) { hint.textContent = '点一张牌就是出'; return; }
    var n = Object.keys(alive).length;
    hint.textContent = n ? ('点一张出（能出 ' + n + ' 张）') : '没有能出的牌，摸一张吧';
  }

  function onFanTap(e) {
    var el = e.target && e.target.closest ? e.target.closest('.uno-card') : null;
    if (!el || el.disabled || !el.dataset.id) return;
    playCard(el.dataset.id);
  }

  // ── 通知条（摸牌 pending / +2 叠加）────────────────────────────────────────

  function renderNotice() {
    var el = $('r-notice');
    if (!seat || !started() || view.phase !== 'playing') { el.hidden = true; return; }

    if (view.pending && view.pending.mine && view.pending.card) {
      var id = view.pending.card;
      el.hidden = false;
      el.innerHTML = '摸到了 <b>' + esc(labelOf(id)) + '</b> —— 出它，还是留着？' +
        '<div class="uno-notice-acts">' +
        '<button class="cd-btn cd-btn--sm cd-btn--primary" id="r-pd-play" type="button">出它</button>' +
        '<button class="cd-btn cd-btn--sm" id="r-pd-keep" type="button">留着</button></div>';
      $('r-pd-play').addEventListener('click', function () { playCard(id); });
      $('r-pd-keep').addEventListener('click', function () { send('keep'); });
      return;
    }

    if (isMyTurn() && view.drawStack > 0) {
      el.hidden = false;
      el.innerHTML = '上家把 <b>+2</b> 甩过来了，已经累到 <b>' + view.drawStack +
        ' 张</b>：接一张 +2 转嫁下家，或者自己摸掉。';
      return;
    }

    el.hidden = true;
  }

  // ── 操作区 ────────────────────────────────────────────────────────────────

  function btn(label, cls, fn, disabled) {
    var b = document.createElement('button');
    b.className = 'cd-btn ' + (cls || '');
    b.type = 'button';
    b.innerHTML = label;
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
      var minp = (gmeta && gmeta.minPlayers) || 2;
      if (isHost()) {
        bar.appendChild(btn('开局（' + n + ' 人）', 'cd-btn--primary cd-btn--wide', function () {
          API.startRoom(code, seat.playerToken).catch(function (e) { UI.toast(e.message, true); });
        }, n < minp));
        if (n < minp) bar.appendChild(hint('至少 ' + minp + ' 个人才能开'));
      } else {
        bar.appendChild(hint('等房主开局…'));
      }
      if (meta.inviteToken) bar.appendChild(btn('邀请朋友', 'cd-btn--ghost', copyInvite));
      return;
    }

    if (view.phase === 'game_over') {
      bar.appendChild(hint('整场结束了'));
      return;
    }

    if (view.phase === 'round_over') {
      bar.appendChild(btn('看结算', '', function () { openResult(true); }));
      bar.appendChild(btn('再来一局', 'cd-btn--primary', function () { send('next_round'); }));
      if (isHost()) bar.appendChild(btn('结束整场', 'cd-btn--danger', function () { send('end_match'); }));
      return;
    }

    if (!isMyTurn()) {
      var cur = findPlayer(view.current);
      bar.appendChild(hint('等 ' + (cur && cur.isAI ? UI.ICON.robot(14) : '') +
        '<b>' + esc(cur ? cur.name : '对面') + '</b> 出牌…'));
      return;
    }

    if (view.pending && view.pending.mine) {
      var pid = view.pending.card;
      bar.appendChild(btn('出掉刚摸的', 'cd-btn--primary cd-btn--wide', function () { playCard(pid); }, !pid));
      bar.appendChild(btn('留着，过', 'cd-btn--wide', function () { send('keep'); }));
      return;
    }

    bar.appendChild(btn(view.drawStack > 0 ? ('摸 ' + view.drawStack + ' 张') : '摸一张',
      'cd-btn--primary cd-btn--wide', function () { send('draw'); }));
    bar.appendChild(hint('点上面的牌就是出牌'));
  }

  // ── 未开局面板 ────────────────────────────────────────────────────────────

  function rulesChips() {
    var rm = (gmeta && gmeta.ruleMeta) || [];
    var rules = (view && view.rules) || meta.rules || {};
    return rm.map(function (r) {
      return '<span class="cd-chip' + (rules[r.key] ? ' is-on' : '') + '">' + esc(r.label) + '</span>';
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
    var minp = (gmeta && gmeta.minPlayers) || 2;
    var maxp = (gmeta && gmeta.maxPlayers) || 4;
    var chips = rulesChips();
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
      (chips ? '<div class="cd-rulechips">' + chips + '</div>' : '') +
      '</div>';
  }

  // ── 覆盖层：本局结算 / 整场总榜 ───────────────────────────────────────────

  /** openResult(force)：round_over 自动弹一次，「看结算」按钮可以再叫出来 */
  function openResult(force) {
    if (!view || !view.lastResults) {
      if (force) UI.toast('这一局还没算完');
      return;
    }
    if (resultBox) {
      if (!force) return;
      resultBox.close();
    }
    var r = view.lastResults;
    var meId = seat && seat.playerId;
    var win = null;
    r.players.forEach(function (x) { if (x.playerId === r.winner) win = x; });

    var rows = r.players.map(function (x) {
      var isW = x.playerId === r.winner;
      return '<div class="rw' + (x.playerId === meId ? ' is-me' : '') + '">' +
        '<span class="nm">' + esc(x.name || '') + '</span>' +
        '<span class="lost">' + (isW ? '出完了' : ('剩 ' + x.handCount + ' 张 · 送出 ' + x.handPoints + ' 分')) + '</span>' +
        '<span class="tot">' + (x.score || 0) + '</span></div>';
    }).join('');

    var acts = '';
    if (seat) acts += '<button class="cd-btn cd-btn--primary" id="rs-next" type="button">再来一局</button>';
    if (seat && isHost()) acts += '<button class="cd-btn cd-btn--danger" id="rs-end" type="button">结束整场</button>';

    resultBox = UI.modal({
      sheet: true,
      className: 'uno-result',
      html: '<div class="cd-sheet-grip"></div>' +
        '<h2>第 ' + (r.round || view.round || 1) + ' 局结束</h2>' +
        '<div class="sub">出完的人把别人手上的牌全折成分数收走，累计到整场结束。</div>' +
        '<div class="win"><span class="ic">' + UI.ICON.crown(20) + '</span>' +
        '<span class="nm">' + esc(win ? (win.name || '') : nameOf(r.winner)) + ' 出完</span>' +
        '<span class="gn">+' + (r.gain || 0) + '</span></div>' +
        '<div class="rows">' + rows + '</div>' +
        (acts ? '<div class="cd-sheet-acts">' + acts + '</div>' : ''),
      onClose: function () { resultBox = null; },
      onMount: function (h) {
        var n = h.el.querySelector('#rs-next');
        if (n) n.addEventListener('click', function () { h.close(); send('next_round'); });
        var e = h.el.querySelector('#rs-end');
        if (e) e.addEventListener('click', function () { h.close(); send('end_match'); });
      }
    });
  }

  function renderOverlays() {
    if (!view) return;

    if (view.phase === 'round_over') {
      if (shownRound !== view.round) {
        shownRound = view.round;
        openResult(false);
      }
    } else {
      shownRound = -1;
      if (resultBox) resultBox.close();
    }

    if (view.phase === 'game_over') {
      if (resultBox) resultBox.close();
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

    // 轮到我了震一下（没有 vibrate 就静默跳过）
    var mineTurn = isMyTurn();
    if (mineTurn && !lastTurnMine && navigator.vibrate) {
      try { navigator.vibrate(30); } catch (e) { /* ignore */ }
    }
    lastTurnMine = mineTurn;
  }

  /** 方向一变就把箭头转半秒（reverse 的视觉回执，比读流水快） */
  function animateDiff() {
    if (!view || !started()) { lastDir = null; return; }
    var d = (typeof view.dir === 'number') ? view.dir : 1;
    if (lastDir !== null && d !== lastDir) {
      var el = $('r-dir');
      if (el) {
        el.classList.remove('is-flip');
        void el.offsetWidth;                 // 强制回流，动画才会从头跑
        el.classList.add('is-flip');
        setTimeout(function () { el.classList.remove('is-flip'); }, 560);
      }
    }
    lastDir = d;
  }

  // ── 同步 ──────────────────────────────────────────────────────────────────

  function ingest(payload) {
    if (!payload || typeof payload !== 'object') return;
    // 未开局时 payload.state 是 null，view 退化成外层壳（有 seats/rules，没有 phase）
    var v = (payload.state && typeof payload.state === 'object') ? payload.state : payload;
    if (payload.name) meta.name = payload.name;
    if (payload.seats) {
      meta.seats = payload.seats;
      var host = payload.seats[0];
      if (host) meta.hostId = host.playerId || host.id;
      // 座位表里带 isHost，顺手校准一次（换设备/复座时 localStorage 里的可能是旧的）
      if (seat) {
        payload.seats.forEach(function (s) {
          if ((s.playerId || s.id) === seat.playerId && s.isHost != null) seat.isHost = !!s.isHost;
        });
      }
    }
    if (payload.rules) meta.rules = payload.rules;
    if (Array.isArray(payload.chat)) meta.chat = payload.chat;
    else if (v && Array.isArray(v.chat)) meta.chat = v.chat;
    // 邀请 token 只有 owner 视角拿得到（服务端把关），有就记下用于「邀请朋友」
    if (payload.inviteToken) meta.inviteToken = payload.inviteToken;
    if (Array.isArray(payload.legal)) {
      legalList = payload.legal;
      legalSeq = (payload.state && typeof payload.state.seq === 'number') ? payload.state.seq : (payload.seq || 0);
    }
    view = v || null;
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
    animateDiff();
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
        '<div class="sub">「' + esc(meta.name || code) + '」还没开局，报个名字就能上桌打 UNO。</div>' +
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
    if (seat || joinAsked || !view) return;
    if (started()) return;              // 已开局又没座位 = 观战
    joinAsked = true;
    askJoin();
  }

  /** 入座后要带着 token 重开一条 SSE，才收得到自己的手牌 */
  function reopen() {
    if (sync) sync.close();
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

    $('r-help').innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.6 2.9c-.8.5-1.2 1-1.2 1.9"/><circle cx="12" cy="16.8" r="0.5"/></svg>';
    $('r-help').addEventListener('click', function () { UI.rulesHelp('uno'); });

    $('r-close').innerHTML = UI.icon('door', 20);
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

    $('r-score').addEventListener('click', function () {
      if (!started()) { UI.toast('还没开局，没分可算'); return; }
      UI.scoreboard(view, {
        meId: seat && seat.playerId,
        unit: '分',
        noteOf: function (p) {
          var n = typeof p.handCount === 'number' ? p.handCount : 0;
          return '剩 ' + n + ' 张';
        },
        canNext: !!seat && view.phase === 'round_over',
        canEnd: isHost() && view.phase !== 'game_over',
        onNext: function () { send('next_round'); },
        onEnd: function () { send('end_match'); }
      });
    });

    $('r-fan').addEventListener('click', onFanTap);

    // 聊天输入条
    $('r-chatsend').innerHTML = planeIcon(18);
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

    // 引擎 meta：人数下限 + 规则开关表（拿不到也不影响玩，永不 reject）
    API.gameMeta('uno').then(function (m) {
      gmeta = m;
      if (view) render();
    });

    seat = API.loadSeat(code);
    // 开局前先拉一份 REST 快照：① 验座位 token 还认不认 ② 只有这条路带 inviteToken（邀请朋友）
    // 和 legal，SSE 的分视角推送里都没有
    var pre = API.getState(code, seat && seat.playerToken).then(function (v) {
      if (seat) {
        // token 还认不认？认的话我应该在座位表里（房间被清了/重建了就清掉本地座位）
        var ss = (v && v.seats) || [];
        var mine = null;
        ss.forEach(function (s) { if ((s.playerId || s.id) === seat.playerId) mine = s; });
        if (ss.length && !mine) {
          API.clearSeat(code);
          seat = null;
        } else if (mine && mine.isHost != null) {
          seat.isHost = !!mine.isHost;
          API.saveSeat(code, seat);
        }
      }
      onPayload(v);                     // 顺手把第一帧画出来，别对着空壳等 SSE
    }, function () {
      if (seat) {
        API.clearSeat(code);            // token 失效（房间被清了/重建了）
        seat = null;
      }
    });

    pre.then(function () {
      sync = API.openSync(code, seat && seat.playerToken, onPayload, onStatus);
    });

    window.addEventListener('beforeunload', function () { if (sync) sync.close(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
