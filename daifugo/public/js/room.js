/* 大富豪 —— 牌桌主控
 * 负责：入座/复座/观战、SSE 同步（按我的视角推的脱敏 view）、对手条、场面、手牌扇面、
 *      出牌/过/换牌回赠、计分板、名次揭晓、革命特效、八切散场。
 * 合法性预判走 DfRules（引擎不在就整体降级，按钮全放开，错了让服务端说话）。
 */
(function (global) {
  'use strict';

  var API = global.DfAPI;
  var UI = global.DfUI;
  var Cards = global.DfCards;
  var Rules = global.DfRules;
  var esc = Cards.esc;

  var $ = function (id) { return document.getElementById(id); };
  var code = (new URLSearchParams(location.search).get('c') || '').toUpperCase();

  var seat = null;          // {playerId, playerToken, name, isHost?}
  var view = null;          // 最近一次「我视角」的 view
  var meta = {};            // 房间壳信息（名字/房主/未开局的座位表）
  var sync = null;
  var sel = [];             // 选中的牌 id
  var legal = { ok: false, list: [], keys: {}, canPass: true };
  var busy = false;
  var handKey = '';
  var fieldKey = '';
  var lastRevo = null;
  var revealedRound = -1;
  var lastTurnMine = false;
  var joinAsked = false;
  var feedSeen = {};        // 流水/聊天条目的去重集合（key -> 1），只进不出
  var feedPrimed = false;   // 第一帧只补历史，不弹气泡
  var bubbles = {};         // playerId -> {text, until}：座位卡上的聊天气泡
  var chatBusy = false;

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
    if (view && view.hand) return view.hand;      // 服务端也可能把我的手牌单独挂在 view.hand
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
    var h = meta.hostId || (view && (view.hostId || view.host));
    if (h) return h === seat.playerId;
    var first = players()[0] || (meta.seats || [])[0];
    return !!(first && (first.id || first.playerId) === seat.playerId);   // 兜底：首位入座者
  }

  /** 纸飞机（发送键）——ui.js 的 ICON 里没有，按同规格手写，stroke 1.7 */
  function planeIcon(size) {
    var s = size || 18;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21.2 3.3 2.9 10.1a.62.62 0 0 0 .04 1.17l7.06 2.2 2.2 7.06a.62.62 0 0 0 1.17.04z"/>' +
      '<path d="M21.2 3.3 10 14.5"/></svg>';
  }

  function clip(text, n) {
    var s = String(text == null ? '' : text);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function seatsForWait() {
    var ps = players();
    if (ps.length) return ps;
    return (meta.seats || []).map(function (s) {
      return { id: s.id || s.playerId, name: s.name, isAI: s.isAI };
    });
  }

  // ── 换牌阶段：谁欠谁 ──────────────────────────────────────────────────────
  // exchange.pending 项 = {from,to,count,done,taken,given}：
  // from = 富方（要挑牌回赠的那个，engine.legalMoves 也是按 from 找 give_back），
  // to = 贫方（已经被自动上缴了 taken 那几张），done/given 非空 = 这一对换完了。
  // taken/given 只对当事双方可见，别人看到的是 null。

  function richSideOf(e) { return e.from; }

  function pending() {
    var ex = view && view.exchange;
    var list = (ex && (ex.pending || ex.list)) || [];
    return list.filter(function (e) { return e && !e.done && !e.given; });
  }

  /** 我要回赠：{entry, count, to} */
  function myGiveBack() {
    if (!seat) return null;
    var hit = null;
    pending().forEach(function (e) {
      if (hit) return;
      if (richSideOf(e) === seat.playerId) {
        var other = (e.from === seat.playerId) ? e.to : e.from;
        hit = { entry: e, count: e.count || 1, to: other, taken: e.taken || null };
      }
    });
    return hit;
  }

  /** 我被上缴了牌、正等对面回：{entry, from, cards} */
  function myWaiting() {
    if (!seat) return null;
    var hit = null;
    pending().forEach(function (e) {
      if (hit) return;
      var rich = richSideOf(e);
      if (rich !== seat.playerId && (e.from === seat.playerId || e.to === seat.playerId)) {
        hit = { entry: e, from: rich, cards: e.taken || null };
      }
    });
    return hit;
  }

  // ── 动作 ──────────────────────────────────────────────────────────────────

  function send(type, extra) {
    if (busy || !seat) return Promise.resolve();
    busy = true;
    renderActions();
    return API.action(code, seat.playerToken, type, extra).then(function () {
      busy = false;
      sel = [];
      render();
    }, function (err) {
      busy = false;
      UI.toast(err.message, true);     // 服务端的中文报错直接显示
      render();
    });
  }

  var foulConfirm = '';   // 犯规收尾防呆：上次警告过的选牌指纹，同一手再点一次才放行

  // 禁止上がり会踩雷的牌：8/王恒犯规；2 犯规（革命中换成 3）。只做提醒，判罚仍在引擎。
  function foulFinishRanks(cards) {
    var bad = [];
    var revo = !!(view && view.revolution);
    cards.forEach(function (id) {
      var s = String(id);
      if (s[0] === 'X') { bad.push('王'); return; }
      var n = parseInt(s.slice(1), 10);
      if (n === 8) bad.push('8');
      else if (!revo && n === 15) bad.push('2');
      else if (revo && n === 3) bad.push('3');
    });
    return bad;
  }

  function playSelected() {
    if (!sel.length) { UI.toast('先点几张牌', true); return; }
    if (!Rules.isLegal(legal, sel)) { UI.toast(Rules.reason(view, sel), true); return; }
    // 防呆：这一手会把手牌出光、且含禁止收尾牌 → 拦一下，同一手再点一次才真出
    var rules = (view && view.rules) || {};
    if (rules.forbid_finish !== false && sel.length === myHand().length) {
      var bad = foulFinishRanks(sel);
      if (bad.length) {
        var key = sel.slice().sort().join(',');
        if (foulConfirm !== key) {
          foulConfirm = key;
          UI.toast('⚠️ 用 ' + bad.join('/') + ' 收尾会犯规垫底（禁止上がり）！想清楚了再点一次', true);
          return;
        }
      }
    }
    foulConfirm = '';
    send('play', { cards: sel.slice() });
  }

  function copyInvite() {
    var link = location.origin + '/daifugo/room.html?c=' + encodeURIComponent(code) +
      '&invite=' + encodeURIComponent(meta.inviteToken);
    var fallback = function () { window.prompt('复制这个链接发给朋友：', link); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(function () {
        UI.toast('邀请链接已复制，发给朋友就能进来打');
      }, fallback);
    } else fallback();
  }

  function giveBack(count) {
    if (sel.length !== count) { UI.toast('要挑 ' + count + ' 张', true); return; }
    send('give_back', { cards: sel.slice() });
  }

  // ── 头部 / 对手条 ─────────────────────────────────────────────────────────

  function renderHeader() {
    $('r-name').textContent = meta.name || '房间';
    $('r-code').textContent = code + (view && view.round ? ' · 第 ' + view.round + ' 轮' : '');
    $('r-close').hidden = !isHost();
  }

  function seatCard(p) {
    var cls = ['df-seat'];
    if (view && view.current === p.id && view.phase === 'playing') cls.push('is-turn');
    if (p.finished != null || (p.handCount === 0 && p.hand == null)) cls.push('is-done');
    if (p.passed) cls.push('is-passed');
    if (seat && seat.playerId === p.id) cls.push('is-me');

    var idAttr = ' data-id="' + esc(p.id) + '"';

    // 还没开局：只报个名，别显示「0 张」这种没意义的数字
    if (!started()) {
      return '<div class="' + cls.join(' ') + '"' + idAttr + '><div class="top">' +
        (p.isAI ? '<i class="bot" title="AI 座位">' + UI.ICON.robot(13) + '</i>' : '') +
        '<span class="nm">' + esc(p.name || '') + '</span></div>' +
        '<div class="tail"><span class="tx">已入座</span></div></div>';
    }

    var count = typeof p.handCount === 'number' ? p.handCount : (p.hand ? p.hand.length : 0);
    var tail = [];
    if (p.finished != null) tail.push('第 ' + (p.finished + 1) + ' 个出完');
    else if (p.passed) tail.push('已过');
    else if (view && view.current === p.id && view.phase === 'playing') tail.push(p.isAI ? '思考中' : '出牌中');

    return '<div class="' + cls.join(' ') + '"' + idAttr + '>' +
      '<div class="top">' +
      (p.isAI ? '<i class="bot" title="AI 座位">' + UI.ICON.robot(13) + '</i>' : '') +
      '<span class="nm">' + esc(p.name || '') + '</span>' +
      '</div>' +
      '<div class="cnt"><span class="backs">' + Cards.backsHtml(count, 5) + '</span>' +
      '<b>' + count + '</b><span class="u">张</span></div>' +
      '<div class="tail">' + (UI.rankBadge(p.rank) || '') +
      (tail.length ? '<span class="tx">' + esc(tail.join(' · ')) + '</span>' : '') + '</div>' +
      '</div>';
  }

  function renderSeats() {
    var ps = players();
    if (!ps.length) ps = seatsForWait();
    var others = seat ? ps.filter(function (p) { return p.id !== seat.playerId; }) : ps;
    $('r-seats').innerHTML = others.map(seatCard).join('') ||
      '<div class="df-seat is-empty">还没别人</div>';
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
    Array.prototype.forEach.call(host.querySelectorAll('.df-bubble'), function (el) { el.remove(); });
    Object.keys(bubbles).forEach(function (pid) {
      var b = bubbles[pid];
      if (!b || b.until <= now) { delete bubbles[pid]; return; }
      var card = null;
      Array.prototype.forEach.call(host.children, function (el) {
        if (!card && el.dataset && el.dataset.id === pid) card = el;
      });
      if (!card) return;
      var el = document.createElement('div');
      el.className = 'df-bubble';
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

  function renderField() {
    var turn = $('r-turn'), badges = $('r-badges'), pile = $('r-pile'), by = $('r-by');

    if (!started()) {
      turn.innerHTML = '等开局';
      badges.innerHTML = '';
      pile.innerHTML = '';
      by.textContent = '';
      fieldKey = '';
      return;
    }

    if (view.phase === 'playing') {
      var cur = nameOf(view.current);
      turn.innerHTML = '轮到 <b>' + esc(cur) + '</b>' + (isMyTurn() ? '（你）' : '');
    } else if (view.phase === 'exchange') {
      turn.innerHTML = '换牌回合';
    } else if (view.phase === 'round_over') {
      turn.innerHTML = '本轮结束';
    } else if (view.phase === 'game_over') {
      turn.innerHTML = '整场结束';
    }

    var bs = '';
    if (view.revolution) {
      bs += '<span class="df-badge is-revo">' + UI.ICON.revo(13) + '革命中</span>';
    }
    if (view.suitLock && view.suitLock.length) {
      var syms = view.suitLock.map(function (s) {
        return (Cards.SUITS[s] && Cards.SUITS[s].sym) || esc(s);
      }).join('');
      bs += '<span class="df-badge is-lock">' + UI.ICON.lock(13) + '縛り ' + syms + '</span>';
    }
    badges.innerHTML = bs;

    var f = view.field;
    var key = f ? ((f.cards || []).join(',') + '|' + f.by) : 'none';
    if (key !== fieldKey) {
      fieldKey = key;
      pile.innerHTML = f
        ? (f.cards || []).map(function (id, i) { return Cards.cardHtml(id, { idx: i, extra: 'is-fly' }); }).join('')
        : '<div class="df-pile-empty">场上空着</div>';
    }
    by.innerHTML = f
      ? esc(nameOf(f.by)) + ' 出的' + (f.combo && Rules.comboName(f.combo) ? ' · ' + Rules.comboName(f.combo) : '')
      : (view.phase === 'playing' ? '谁领出都行' : '');
  }

  // ── 流水 + 聊天（同一条流）────────────────────────────────────────────────
  // 每帧服务端都给全量（log 是整场累积、chat 是最近 60 条），这里只 append 没见过的，
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
    if (!seat || !view) return false;
    if (view.phase === 'exchange') return !!myGiveBack();
    return isMyTurn();
  }

  function renderHand() {
    var box = $('r-handzone');
    if (!seat || !started()) { box.hidden = true; return; }   // 观战 / 还没发牌
    box.hidden = false;

    var hand = Cards.sortHand(myHand(), !!(view && view.revolution));
    var key = hand.join(',') + '|' + (view && view.revolution ? 'r' : 'n');
    if (key !== handKey) {
      handKey = key;
      sel = sel.filter(function (id) { return hand.indexOf(id) !== -1; });
      $('r-fan').innerHTML = hand.map(function (id, i) {
        return Cards.cardHtml(id, { tag: 'button', idx: i });
      }).join('');
    }

    var mine = me();
    $('r-mine').innerHTML = '你的手牌 <b>' + hand.length + '</b> 张' +
      (mine && mine.rank ? ' ' + UI.rankBadge(mine.rank) : '');
    syncHand();
  }

  /** 选中态 / 置灰态，不重建 DOM */
  function syncHand() {
    var alive = null;
    if (canSelect() && view.phase === 'playing') alive = Rules.candidates(legal, sel);

    Array.prototype.forEach.call($('r-fan').children, function (el) {
      var id = el.dataset.id;
      el.classList.toggle('is-on', sel.indexOf(id) !== -1);
      el.classList.toggle('is-dead', !!(alive && !alive[id]));
      el.disabled = !canSelect();
    });

    var hint = $('r-hint');
    if (!canSelect()) {
      hint.textContent = '';
    } else if (view.phase === 'exchange') {
      var gb = myGiveBack();
      hint.textContent = '挑 ' + gb.count + ' 张回赠（已选 ' + sel.length + '）';
    } else if (!sel.length) {
      hint.textContent = '点牌选中，可多选';
    } else if (!Rules.isLegal(legal, sel)) {
      hint.textContent = Rules.reason(view, sel);
      hint.classList.add('is-bad');
      return;
    } else {
      hint.textContent = '选了 ' + sel.length + ' 张：' + Cards.labels(sel);
    }
    hint.classList.remove('is-bad');
  }

  function onFanTap(e) {
    var el = e.target && e.target.closest ? e.target.closest('.df-card') : null;
    if (!el || !canSelect()) return;
    var id = el.dataset.id;
    var i = sel.indexOf(id);
    if (i !== -1) {
      sel.splice(i, 1);
    } else {
      var gb = view.phase === 'exchange' ? myGiveBack() : null;
      if (gb && sel.length >= gb.count) sel.shift();     // 回赠张数满了，挤掉最早选的
      sel.push(id);
    }
    syncHand();
    renderActions();
  }

  // ── 通知条（换牌说明）─────────────────────────────────────────────────────

  function renderNotice() {
    var el = $('r-notice');
    if (!view || view.phase !== 'exchange' || !seat) { el.hidden = true; return; }
    var gb = myGiveBack();
    var wt = myWaiting();
    if (gb) {
      el.hidden = false;
      el.innerHTML = '你是<b>' + esc(UI.rankLabel((me() || {}).rank) || '富方') + '</b>，该回牌了：' +
        (gb.taken && gb.taken.length ? '收了 ' + esc(Cards.labels(gb.taken)) + '，' : '') +
        '从手里挑 ' + gb.count + ' 张送给 ' + esc(nameOf(gb.to)) + '（挑什么都行，包括垃圾牌）';
    } else if (wt) {
      el.hidden = false;
      el.innerHTML = wt.cards && wt.cards.length
        ? '已自动上缴 <b>' + esc(Cards.labels(wt.cards)) + '</b>，等 ' + esc(nameOf(wt.from)) + ' 回牌'
        : '已自动上缴最强的 ' + ((wt.entry && wt.entry.count) || 1) + ' 张，等 ' + esc(nameOf(wt.from)) + ' 回牌';
    } else {
      el.hidden = false;
      el.innerHTML = '换牌进行中，等富方回牌…';
    }
  }

  // ── 操作区 ────────────────────────────────────────────────────────────────

  function btn(label, cls, fn, disabled) {
    var b = document.createElement('button');
    b.className = 'df-btn ' + (cls || '');
    b.innerHTML = label;
    b.disabled = !!disabled || busy;
    b.addEventListener('click', fn);
    return b;
  }

  function hint(html) {
    var d = document.createElement('div');
    d.className = 'df-actbar-hint';
    d.innerHTML = html;
    return d;
  }

  function renderActions() {
    var bar = $('r-acts');
    bar.innerHTML = '';

    if (!seat) {
      var w = document.createElement('span');
      w.className = 'df-watch';
      w.innerHTML = UI.ICON.cards(15) + '观战中';
      bar.appendChild(w);
      return;
    }

    if (!started()) {
      var n = seatsForWait().length;
      if (isHost()) {
        bar.appendChild(btn('开局（' + n + ' 人）', 'df-btn--primary df-btn--wide', function () {
          API.startRoom(code, seat.playerToken).catch(function (e) { UI.toast(e.message, true); });
        }, n < 2));
        if (n < 2) bar.appendChild(hint('至少 2 个人才能开'));
      } else {
        bar.appendChild(hint('等房主开局…'));
      }
      if (meta.inviteToken) bar.appendChild(btn('邀请朋友', 'df-btn--ghost', copyInvite));
      return;
    }

    if (view.phase === 'game_over') {
      bar.appendChild(hint('整场结束了'));
      return;
    }

    if (view.phase === 'round_over') {
      bar.appendChild(btn('看名次', '', function () { openReveal(); }));
      bar.appendChild(btn('开下一轮', 'df-btn--primary', function () { send('next_round'); }));
      if (isHost()) bar.appendChild(btn('结束整场', 'df-btn--danger', function () { send('end_match'); }));
      return;
    }

    if (view.phase === 'exchange') {
      var gb = myGiveBack();
      if (gb) {
        bar.appendChild(btn('回赠 ' + gb.count + ' 张', 'df-btn--primary df-btn--wide', function () {
          giveBack(gb.count);
        }, sel.length !== gb.count));
      } else {
        bar.appendChild(hint('等富方回牌…'));
      }
      return;
    }

    var mine = me();
    if (mine && mine.finished != null) {
      bar.appendChild(hint('你已经出完了，等这轮打完'));
      return;
    }

    if (!isMyTurn()) {
      var cur = findPlayer(view.current);
      bar.appendChild(hint('等 ' + (cur && cur.isAI ? UI.ICON.robot(14) : '') +
        '<b>' + esc(cur ? cur.name : '对面') + '</b> 出牌…'));
      return;
    }

    bar.appendChild(btn('出牌', 'df-btn--primary df-btn--wide', playSelected,
      !sel.length || !Rules.isLegal(legal, sel)));
    bar.appendChild(btn('过', 'df-btn--wide', function () { send('pass'); }, !Rules.canPass(legal)));
  }

  // ── 未开局面板 ────────────────────────────────────────────────────────────

  function renderWait() {
    var el = $('r-wait');
    var stage = $('r-stage');
    // 说明卡是 inset:0 的覆盖层，等人阶段得让出底下那条聊天（CSS 给它抬 bottom）
    if (stage) stage.classList.toggle('is-waiting', !started());
    if (started()) { el.hidden = true; return; }
    el.hidden = false;
    var ss = seatsForWait();
    el.innerHTML = '<div class="box cn-card">' +
      '<div><div class="df-eyebrow">房间号</div>' +
      '<h2>' + esc(code) + '</h2></div>' +
      '<div class="sub">把房间号发给对面，他们在大厅点进来就能坐下。2~4 人，凑够 2 个房主就能开局。</div>' +
      '<div class="df-seatlist">' + (ss.length ? ss.map(function (s) {
        return '<div class="df-seatrow">' +
          (s.isAI ? '<i class="bot">' + UI.ICON.robot(14) + '</i>' : '') +
          '<span class="nm">' + esc(s.name || '') + '</span>' +
          '<span class="role">' + (seat && seat.playerId === s.id ? '你' : '玩家') + '</span></div>';
      }).join('') : '<div class="df-empty">还没人坐下</div>') + '</div>' +
      (view && view.rules ? '<div class="df-rulechips">' + rulesChips(view.rules) + '</div>' : '') +
      '</div>';
  }

  function rulesChips(rules) {
    return API.RULE_META.map(function (r) {
      return '<span class="df-chip' + (rules[r.key] ? ' is-on' : '') + '">' + esc(r.label) + '</span>';
    }).join('');
  }

  // ── 覆盖层：名次揭晓 / 总榜 ───────────────────────────────────────────────

  function openReveal() {
    UI.rankReveal(view, {
      meId: seat && seat.playerId,
      canNext: !!seat,
      canEnd: isHost(),
      onNext: function () { send('next_round'); },
      onEnd: function () { send('end_match'); }
    });
  }

  function renderOverlays() {
    if (!view) return;
    if (view.phase === 'round_over') {
      if (revealedRound !== view.round) {
        revealedRound = view.round;
        openReveal();
      }
    } else {
      if (view.phase !== 'game_over') UI.hideReveal();
      revealedRound = -1;
    }

    if (view.phase === 'game_over') {
      UI.hideReveal();
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

    legal = (seat && view && view.phase === 'playing' && isMyTurn())
      ? Rules.moves(view, seat.playerId)
      : { ok: false, list: [], keys: {}, canPass: false };

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

  // ── 动效：革命 / 清场散开 ─────────────────────────────────────────────────

  function scatter(oldField) {
    var host = $('r-field');
    if (!host || !oldField) return;
    var ghost = document.createElement('div');
    ghost.className = 'df-ghost';
    ghost.innerHTML = (oldField.cards || []).map(function (id, i) {
      return Cards.cardHtml(id, { idx: i });
    }).join('');
    host.appendChild(ghost);
    Array.prototype.forEach.call(ghost.children, function (el) {
      el.style.setProperty('--dx', ((Math.random() * 2 - 1) * 120).toFixed(0) + 'px');
      el.style.setProperty('--dy', (-30 - Math.random() * 90).toFixed(0) + 'px');
      el.style.setProperty('--rot', ((Math.random() * 2 - 1) * 70).toFixed(0) + 'deg');
    });
    // 下一帧再加类，保证动画从初始态起跑
    requestAnimationFrame(function () { ghost.classList.add('is-scatter'); });
    if (Cards.hasEight(oldField.cards)) UI.banner(host, '八切り', 'hachi');
    setTimeout(function () { ghost.remove(); }, 1000);
  }

  function animateDiff(prev) {
    if (!view || !prev) { lastRevo = view ? !!view.revolution : null; return; }
    if (lastRevo !== null && !!view.revolution !== lastRevo) UI.revolution(!!view.revolution);
    lastRevo = !!view.revolution;
    if (prev.field && !view.field) scatter(prev.field);
  }

  // ── 同步 ──────────────────────────────────────────────────────────────────

  function ingest(payload) {
    if (!payload || typeof payload !== 'object') return;
    // 兼容两种包法：直接推我视角的 view / 包一层 {name,seats,started,state}
    var v = (payload.state && typeof payload.state === 'object') ? payload.state : payload;
    if (payload.name) meta.name = payload.name;
    if (payload.hostId) meta.hostId = payload.hostId;
    if (payload.seats) meta.seats = payload.seats;
    if (v && v.hostId) meta.hostId = v.hostId;
    if (v && v.roomName) meta.name = v.roomName;
    // 聊天挂在外层（statePayload.chat），不在脱敏后的 view 里
    if (Array.isArray(payload.chat)) meta.chat = payload.chat;
    else if (v && Array.isArray(v.chat)) meta.chat = v.chat;
    // 邀请 token 只有 owner 视角拿得到（服务端把关），有就记下用于「邀请朋友」
    if (payload.inviteToken) meta.inviteToken = payload.inviteToken;
    view = v || null;
  }

  var roomClosed = false;

  function onPayload(p) {
    if (p && p.closed && !roomClosed) {
      roomClosed = true;
      if (sync) sync.close();
      UI.toast('房间被房主关闭了，回大厅～');
      setTimeout(function () { location.href = '/daifugo/'; }, 1400);
      return;
    }
    var prev = view;
    ingest(p);
    render();
    animateDiff(prev);
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
        '<div class="sub">「' + esc(meta.name || code) + '」还没开局，报个名字就能上桌。</div>' +
        '<div class="df-field-row"><span class="k">昵称</span>' +
        '<input id="jd-name" maxlength="16" placeholder="怎么称呼你" value="' + esc(last.name || '') + '"></div>' +
        '<div class="df-modal-acts">' +
        '<button class="df-btn" id="jd-watch">只看看</button>' +
        '<button class="df-btn df-btn--primary" id="jd-ok">入座</button></div>',
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
      document.body.innerHTML = '<div class="df-empty" style="padding-top:80px">没给房间号，回大厅重来吧</div>';
      return;
    }
    $('r-code').textContent = code;
    $('r-back').innerHTML = UI.icon('back', 22);
    $('r-score').innerHTML = UI.icon('coins', 20);

    $('r-help').innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.6 2.9c-.8.5-1.2 1-1.2 1.9"/><circle cx="12" cy="16.8" r="0.5"/></svg>';
    $('r-help').addEventListener('click', function () { UI.rulesHelp(); });

    $('r-close').innerHTML = UI.icon('door', 20);
    $('r-close').addEventListener('click', function () {
      if (!isHost()) return;
      UI.modal({
        html: '<h2>关闭这个房间？</h2>' +
          '<p class="sub">牌局和聊天记录会一起删掉，大家都会被请回大厅。</p>' +
          '<div class="df-modal-acts">' +
          '<button class="df-btn" id="cl-no">再打打</button>' +
          '<button class="df-btn df-btn--danger" id="cl-yes">关闭房间</button></div>',
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
      if (!view || !players().length) { UI.toast('还没开局，没分可算'); return; }
      UI.scoreboard(view, {
        meId: seat && seat.playerId,
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
      // 输入法组词中的回车是「选词」不是「发送」，不拦会把半截句子发出去
      if (e.isComposing || e.keyCode === 229) return;
      sendChat();
    });
    $('r-chatin').addEventListener('focus', function () {
      // iOS 键盘弹起后把输入条顶回可视区（输入条是普通文档流元素，不是 fixed）
      setTimeout(function () {
        try { $('r-chatdock').scrollIntoView({ block: 'end', behavior: 'smooth' }); } catch (err) { /* 老 WebKit 不认 options */ }
      }, 260);
    });

    seat = API.loadSeat(code);
    var pre = (seat && seat.playerToken)
      ? API.getState(code, seat.playerToken).then(function (v) {
        // token 还认不认？认的话我应该出现在玩家表里（没开局的房间可能还没有 players）
        var ps = (v && v.players) || (v && v.state && v.state.players) || [];
        if (ps.length && !ps.some(function (p) { return p.id === seat.playerId; })) {
          API.clearSeat(code);
          seat = null;
        }
      }, function () {
        API.clearSeat(code);            // token 失效（房间被清了/重建了）
        seat = null;
      })
      : Promise.resolve();

    pre.then(function () {
      sync = API.openSync(code, seat && seat.playerToken, onPayload, onStatus);
    });

    window.addEventListener('beforeunload', function () { if (sync) sync.close(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
