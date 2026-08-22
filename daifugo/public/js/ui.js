/* 大富豪 —— 浮层件：图标 / toast / 弹层 / 计分板抽屉 / 名次揭晓 / 总榜 / 革命特效
 * 图标全是线框 SVG（主题图标库或同规格手写 24×24 stroke 1.8），零 emoji 当图标。
 */
(function (global) {
  'use strict';

  var esc = global.DfCards.esc;

  function icon(name, size) {
    return (global.BiscaIcons && global.BiscaIcons.svg(name, size)) || '';
  }

  // ── 库里没有的图标，按同一规格手写 ────────────────────────────────────────

  function wrap(size, inner) {
    var s = size || 18;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      inner + '</svg>';
  }

  var ICON = {
    /** AI 座位的机器人徽标 */
    robot: function (s) {
      return wrap(s, '<rect x="4" y="8.5" width="16" height="11" rx="3"/>' +
        '<path d="M12 4.5v4"/><circle cx="12" cy="3.2" r="1.2"/>' +
        '<path d="M9.3 13v1.4"/><path d="M14.7 13v1.4"/><path d="M9.5 17h5"/>' +
        '<path d="M2.5 12.8v2.4"/><path d="M21.5 12.8v2.4"/>');
    },
    /** 革命 ⟲ */
    revo: function (s) {
      return wrap(s, '<path d="M4.6 12a7.4 7.4 0 0 1 12.8-5.1"/><path d="M17.7 3.3v3.7H14"/>' +
        '<path d="M19.4 12a7.4 7.4 0 0 1-12.8 5.1"/><path d="M6.3 20.7V17H10"/>');
    },
    /** 縛り（锁花色） */
    lock: function (s) {
      return wrap(s, '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2.6"/>' +
        '<path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9"/><path d="M12 14.4v2.2"/>');
    },
    /** 大富豪皇冠 */
    crown: function (s) {
      return wrap(s, '<path d="M4 19h16"/><path d="M4.2 19 3 7.4l4.9 3.6L12 4.4l4.1 6.6L21 7.4 19.8 19"/>');
    },
    /** 手牌 */
    cards: function (s) {
      return wrap(s, '<rect x="9" y="5" width="10.5" height="14.5" rx="2.4"/>' +
        '<path d="M6.6 7.4 4.8 8a2 2 0 0 0-1.3 2.5l2.6 8.2"/>');
    }
  };

  // ── 名次 ──────────────────────────────────────────────────────────────────

  var RANK_META = {
    daifugo: { label: '大富豪', tier: 1 },
    fugo: { label: '富豪', tier: 2 },
    heimin: { label: '平民', tier: 3 },
    hinmin: { label: '贫民', tier: 4 },
    daihinmin: { label: '大贫民', tier: 5 }
  };

  function rankLabel(rank) {
    var m = RANK_META[rank];
    return m ? m.label : '';
  }

  function rankBadge(rank, opts) {
    var m = RANK_META[rank];
    if (!m) return '';
    var o = opts || {};
    return '<span class="df-rank" data-tier="' + m.tier + '">' +
      (m.tier === 1 ? '<i class="ic">' + ICON.crown(o.iconSize || 12) + '</i>' : '') +
      m.label + '</span>';
  }

  /** 名次从好到坏排序用 */
  function rankTier(rank) {
    var m = RANK_META[rank];
    return m ? m.tier : 9;
  }

  // ── toast ─────────────────────────────────────────────────────────────────

  function toastLayer() {
    var el = document.getElementById('df-toasts');
    if (!el) {
      el = document.createElement('div');
      el.id = 'df-toasts';
      el.className = 'df-toasts';
      document.body.appendChild(el);
    }
    return el;
  }

  function toast(text, bad) {
    var el = document.createElement('div');
    el.className = 'df-toast' + (bad ? ' is-bad' : '');
    el.textContent = String(text || '');
    toastLayer().appendChild(el);
    setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () { el.remove(); }, 220);
    }, bad ? 3200 : 2000);
  }

  // ── 通用弹层 / 底部抽屉 ────────────────────────────────────────────────────

  function modal(opts) {
    var o = opts || {};
    var scrim = document.createElement('div');
    scrim.className = 'df-scrim' + (o.sheet ? ' is-sheet' : '');
    var box = document.createElement('div');
    box.className = (o.sheet ? 'df-sheet ' : 'df-modal ') + (o.className || '');
    box.innerHTML = o.html || '';
    scrim.appendChild(box);
    document.body.appendChild(scrim);

    var handle = {
      el: box,
      scrim: scrim,
      close: function () {
        if (scrim.parentNode) scrim.remove();
        if (o.onClose) o.onClose();
      }
    };
    if (o.dismissable !== false) {
      scrim.addEventListener('click', function (e) { if (e.target === scrim) handle.close(); });
    }
    if (o.onMount) o.onMount(handle);
    return handle;
  }

  // ── 计分板抽屉 ────────────────────────────────────────────────────────────

  /**
   * scoreboard(view, opts)
   * opts: {meId, canNext, canEnd, onNext, onEnd}
   */
  function scoreboard(view, opts) {
    var o = opts || {};
    var players = (view.players || []).slice().sort(function (a, b) {
      return (b.score || 0) - (a.score || 0) || rankTier(a.rank) - rankTier(b.rank);
    });
    var rows = players.map(function (p) {
      return '<div class="df-score-row' + (p.id === o.meId ? ' is-me' : '') + '">' +
        '<span class="nm">' + esc(p.name || '') + (p.isAI ? '<i class="bot">' + ICON.robot(13) + '</i>' : '') + '</span>' +
        '<span class="rk">' + (rankBadge(p.rank) || '<span class="df-dim">—</span>') + '</span>' +
        '<span class="sc">' + (p.score || 0) + '</span>' +
        '</div>';
    }).join('');

    var acts = '';
    if (o.canNext) acts += '<button class="df-btn df-btn--primary" id="sb-next">开下一轮</button>';
    if (o.canEnd) acts += '<button class="df-btn df-btn--danger" id="sb-end">结束整场</button>';

    return modal({
      sheet: true,
      html: '<div class="df-sheet-grip"></div>' +
        '<h2>计分板</h2>' +
        '<div class="sub">第 ' + (view.round || 1) + ' 轮 · 每轮按名次记分，累计到整场结束</div>' +
        '<div class="df-score-head"><span class="nm">玩家</span><span class="rk">本轮</span><span class="sc">累计</span></div>' +
        '<div class="df-score">' + rows + '</div>' +
        (acts ? '<div class="df-sheet-acts">' + acts + '</div>' : ''),
      onMount: function (h) {
        var n = h.el.querySelector('#sb-next');
        if (n) n.addEventListener('click', function () { h.close(); o.onNext(); });
        var e = h.el.querySelector('#sb-end');
        if (e) e.addEventListener('click', function () { h.close(); o.onEnd(); });
      }
    });
  }

  // ── 轮结束：名次揭晓卡 ────────────────────────────────────────────────────

  var revealHandle = null;

  /**
   * rankReveal(view, opts) —— 大富豪 → 大贫民 逐条揭晓
   * opts: {meId, canNext, canEnd, onNext, onEnd, onClose}
   */
  function rankReveal(view, opts) {
    var o = opts || {};
    if (revealHandle) return revealHandle;
    var players = (view.players || []).slice().sort(function (a, b) {
      return rankTier(a.rank) - rankTier(b.rank) ||
        ((a.finished == null ? 99 : a.finished) - (b.finished == null ? 99 : b.finished));
    });
    var rows = players.map(function (p, i) {
      return '<div class="df-reveal-row' + (p.id === o.meId ? ' is-me' : '') + '" style="--i:' + i + '">' +
        '<span class="pos">' + (i + 1) + '</span>' +
        '<span class="nm">' + esc(p.name || '') + (p.isAI ? '<i class="bot">' + ICON.robot(13) + '</i>' : '') + '</span>' +
        (rankBadge(p.rank, { iconSize: 13 }) || '') +
        '<span class="sc">' + (p.score || 0) + ' 分</span>' +
        '</div>';
    }).join('');

    var acts = '<button class="df-btn" id="rv-close">看牌桌</button>';
    if (o.canNext) acts += '<button class="df-btn df-btn--primary" id="rv-next">开下一轮</button>';
    if (o.canEnd) acts += '<button class="df-btn df-btn--danger" id="rv-end">结束整场</button>';

    revealHandle = modal({
      className: 'df-reveal',
      dismissable: false,
      html: '<div class="df-eyebrow">第 ' + (view.round || 1) + ' 轮结束</div>' +
        '<h2>名次揭晓</h2>' +
        '<div class="df-reveal-list">' + rows + '</div>' +
        '<div class="df-reveal-acts">' + acts + '</div>',
      onMount: function (h) {
        h.el.querySelector('#rv-close').addEventListener('click', function () { h.close(); });
        var n = h.el.querySelector('#rv-next');
        if (n) n.addEventListener('click', function () { h.close(); o.onNext(); });
        var e = h.el.querySelector('#rv-end');
        if (e) e.addEventListener('click', function () { h.close(); o.onEnd(); });
      },
      onClose: function () {
        revealHandle = null;
        if (o.onClose) o.onClose();
      }
    });
    return revealHandle;
  }

  function hideReveal() {
    if (revealHandle) revealHandle.close();
    revealHandle = null;
  }

  // ── 整场结束：总榜 + 撒花 ─────────────────────────────────────────────────

  var overEl = null;

  function gameOver(view, opts) {
    if (overEl) return;
    var o = opts || {};
    var players = (view.players || []).slice().sort(function (a, b) {
      return (b.score || 0) - (a.score || 0);
    });
    var rows = players.map(function (p, i) {
      return '<div class="row' + (p.id === o.meId ? ' is-me' : '') + '" style="--i:' + i + '">' +
        '<span class="pos">' + (i + 1) + '</span>' +
        '<span class="nm">' + esc(p.name || '') + (p.isAI ? '<i class="bot">' + ICON.robot(13) + '</i>' : '') + '</span>' +
        '<span class="sc">' + (p.score || 0) + '</span></div>';
    }).join('');

    var bits = '';
    for (var i = 0; i < 60; i++) {
      // 颜色不写死：CSS 用 nth-child 轮换 accent / ink / shared
      bits += '<i style="left:' + (Math.random() * 100).toFixed(2) + '%;animation-duration:' +
        (2.4 + Math.random() * 2.6).toFixed(2) + 's;animation-delay:' + (Math.random() * 2.2).toFixed(2) + 's"></i>';
    }

    overEl = document.createElement('div');
    overEl.className = 'df-over';
    overEl.innerHTML = '<div class="df-confetti">' + bits + '</div>' +
      '<div class="crown">' + ICON.crown(52) + '</div>' +
      '<div class="big">' + esc(players.length ? (players[0].name || '') : '没人') + ' 是最后的大富豪</div>' +
      '<div class="sub">打了 ' + (view.round || 1) + ' 轮，总分说了算</div>' +
      '<div class="df-over-list">' + rows + '</div>' +
      '<a class="df-btn df-btn--primary" href="/daifugo/">回大厅</a>';
    document.body.appendChild(overEl);
  }

  function hideGameOver() {
    if (overEl) { overEl.remove(); overEl = null; }
  }

  // ── 革命特效（全场 180° 翻 + 变色，P5 的排面）────────────────────────────

  function revolution(on) {
    var el = document.createElement('div');
    el.className = 'df-revo' + (on ? '' : ' is-off');
    el.innerHTML = '<div class="ring">' + ICON.revo(96) + '</div>' +
      '<div class="word">' + (on ? '革命' : '革命終了') + '</div>' +
      '<div class="tip">' + (on ? '强弱全部反过来了' : '牌力恢复原样') + '</div>';
    document.body.appendChild(el);
    document.body.classList.add('is-revolting');
    setTimeout(function () {
      document.body.classList.remove('is-revolting');
      el.classList.add('is-out');
      setTimeout(function () { el.remove(); }, 400);
    }, 1500);
  }

  // ── 八切清场横幅 ──────────────────────────────────────────────────────────

  function banner(host, text, kind) {
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'df-banner' + (kind ? ' is-' + kind : '');
    el.textContent = text;
    host.appendChild(el);
    setTimeout(function () { el.remove(); }, 1300);
  }

  // ── 玩法说明（大厅和牌桌共用；访客朋友第一次玩全靠它）─────────────────────

  function rulesHelp() {
    var S = function (t, body) {
      return '<section class="df-help-sec"><h3>' + t + '</h3>' + body + '</section>';
    };
    var P = function (t) { return '<p>' + t + '</p>'; };
    modal({
      sheet: true,
      className: 'df-help',
      html: '<div class="df-sheet-grip"></div><h2>大富豪怎么玩</h2>' +
        S('目标', P('最先把手牌出完的人当<b>大富豪</b>，最后剩牌的当<b>大贫民</b>。牌力从小到大：3 → K → A → <b>2</b>，王最大。花色不分大小。')) +
        S('出牌', P('轮到你领出时随便出：<b>单张 / 对子 / 三条 / 四条 / 同花色 3 张以上的连号（阶梯）</b>。') +
          P('跟牌必须<b>同类型、同张数、且更大</b>。出不起或不想出就「过」——但过了这一墩就锁了，清场前不能再进。') +
          P('其他人全过 → 清场，最后出牌的人重新领出。王可以当任何牌的替身。')) +
        S('八切', P('出的牌里带 <b>8</b> → 场面立刻清空，你接着领出。抢主动权的神器。')) +
        S('革命', P('<b>四张同点数</b>一起甩出来 → 天下大乱：强弱整个翻转，3 最大、2 最小（王不受影响）。再来一次革命或本轮打完才恢复。')) +
        S('スペ3 反杀', P('有人单出王牌称霸时，<b>黑桃 3</b> 可以直接反杀它——全场最小的牌斩全场最大的牌。（可选规则，默认开）')) +
        S('禁止上がり ⚠️', P('最后一手用 <b>8、王、2</b>（革命中是 3）收尾 = 犯规出完，<b>直接判垫底</b>。大杀器别留到最后一张！（可选规则，默认开；界面会在你要踩雷时拦一下）')) +
        S('縛り · 锁花色', P('同一墩里，连着两手的<b>花色完全一样</b>（比如都出的红桃）→ 这一墩被「锁」住，之后只能出这个花色。牌少的人容易被锁死。（可选规则，默认关）')) +
        S('都落ち', P('上一轮的大富豪这轮没能第一个出完 → 当场跌落成大贫民，从天堂直坠地狱。（可选规则，默认关）')) +
        S('换牌', P('第二轮开始，开打前先劫富济贫反着来：<b>大贫民把最强的 2 张上缴</b>给大富豪，大富豪挑 2 张不要的还回去（富豪↔贫民是 1 张）。所以卫冕比翻身容易——这就是这个游戏的残酷之处。')) +
        S('计分', P('每轮按名次拿分累计，想打几轮打几轮，房主随时可以「结束整场」看总榜。'))
    });
  }

  global.DfUI = {
    rulesHelp: rulesHelp,
    icon: icon,
    ICON: ICON,
    RANK_META: RANK_META,
    rankLabel: rankLabel,
    rankBadge: rankBadge,
    rankTier: rankTier,
    toast: toast,
    modal: modal,
    scoreboard: scoreboard,
    rankReveal: rankReveal,
    hideReveal: hideReveal,
    gameOver: gameOver,
    hideGameOver: hideGameOver,
    revolution: revolution,
    banner: banner
  };
})(window);
