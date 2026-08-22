/* Bisca 棋牌室 —— 共享浮层件：转义 / 图标 / toast / 弹层 / 计分板 / 总榜 / 横幅 / 玩法说明
 * 大厅和三张牌桌页（ddz.html / zjh.html / uno.html）共用这一份，游戏专属的件各自写在各自的 js 里。
 * 图标全是线框 SVG（BiscaIcons 或同规格手写 24×24 stroke 1.8），零 emoji 当图标。
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function icon(name, size) {
    return (global.BiscaIcons && global.BiscaIcons.svg(name, size)) || '';
  }

  // ── 库里没有的图标，按 BiscaIcons 规格手写 ────────────────────────────────

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
    /** 赢家皇冠 */
    crown: function (s) {
      return wrap(s, '<path d="M4 19h16"/><path d="M4.2 19 3 7.4l4.9 3.6L12 4.4l4.1 6.6L21 7.4 19.8 19"/>');
    },
    /** 手牌 */
    cards: function (s) {
      return wrap(s, '<rect x="9" y="5" width="10.5" height="14.5" rx="2.4"/>' +
        '<path d="M6.6 7.4 4.8 8a2 2 0 0 0-1.3 2.5l2.6 8.2"/>');
    },
    /** 筹码（炸金花下注用） */
    chips: function (s) {
      return wrap(s, '<circle cx="12" cy="12" r="7.6"/><circle cx="12" cy="12" r="3.2"/>' +
        '<path d="M12 4.4v2.4"/><path d="M12 17.2v2.4"/><path d="M4.4 12h2.4"/><path d="M17.2 12h2.4"/>');
    },
    /** 纸飞机（聊天发送） */
    plane: function (s) {
      return wrap(s, '<path d="M21 3 10.5 13.5"/><path d="M21 3l-6.6 18-3.9-7.5L3 9.6z"/>');
    }
  };

  // ── toast ─────────────────────────────────────────────────────────────────

  function toastLayer() {
    var el = document.getElementById('cd-toasts');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cd-toasts';
      el.className = 'cd-toasts';
      document.body.appendChild(el);
    }
    return el;
  }

  function toast(text, bad) {
    var el = document.createElement('div');
    el.className = 'cd-toast' + (bad ? ' is-bad' : '');
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
    scrim.className = 'cd-scrim' + (o.sheet ? ' is-sheet' : '');
    var box = document.createElement('div');
    box.className = (o.sheet ? 'cd-sheet ' : 'cd-modal ') + (o.className || '');
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

  // ── 计分板抽屉（三个游戏共用：名字 + 一句本轮备注 + 累计分）────────────────

  /**
   * scoreboard(view, opts)
   * opts: {meId, unit, noteOf(p)->string, canNext, canEnd, onNext, onEnd}
   * noteOf 由各牌桌页自己给（斗地主填「地主/农民」，炸金花填筹码，UNO 填剩几张）。
   */
  function scoreboard(view, opts) {
    var o = opts || {};
    var v = view || {};
    var players = (v.players || []).slice().sort(function (a, b) {
      return (b.score || 0) - (a.score || 0);
    });
    var rows = players.map(function (p) {
      var note = o.noteOf ? (o.noteOf(p) || '') : '';
      return '<div class="cd-score-row' + (p.id === o.meId ? ' is-me' : '') + '">' +
        '<span class="nm">' + esc(p.name || '') + (p.isAI ? '<i class="bot">' + ICON.robot(13) + '</i>' : '') + '</span>' +
        '<span class="rk">' + (note ? esc(note) : '<span class="cd-dim">—</span>') + '</span>' +
        '<span class="sc">' + (p.score || 0) + '</span>' +
        '</div>';
    }).join('');

    var acts = '';
    if (o.canNext) acts += '<button class="cd-btn cd-btn--primary" id="sb-next">开下一轮</button>';
    if (o.canEnd) acts += '<button class="cd-btn cd-btn--danger" id="sb-end">结束整场</button>';

    return modal({
      sheet: true,
      html: '<div class="cd-sheet-grip"></div>' +
        '<h2>计分板</h2>' +
        '<div class="sub">第 ' + (v.round || 1) + ' 轮 · 每轮的分累计到整场结束</div>' +
        '<div class="cd-score-head"><span class="nm">玩家</span><span class="rk">本轮</span>' +
        '<span class="sc">' + esc(o.unit || '累计') + '</span></div>' +
        '<div class="cd-score">' + rows + '</div>' +
        (acts ? '<div class="cd-sheet-acts">' + acts + '</div>' : ''),
      onMount: function (h) {
        var n = h.el.querySelector('#sb-next');
        if (n) n.addEventListener('click', function () { h.close(); o.onNext(); });
        var e = h.el.querySelector('#sb-end');
        if (e) e.addEventListener('click', function () { h.close(); o.onEnd(); });
      }
    });
  }

  // ── 整场结束：总榜 + 撒花 ─────────────────────────────────────────────────

  var overEl = null;

  /** gameOver(view, {meId, title}) —— title 不给就是「X 是最后的赢家」 */
  function gameOver(view, opts) {
    if (overEl) return;
    var o = opts || {};
    var v = view || {};
    var players = (v.players || []).slice().sort(function (a, b) {
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
    overEl.className = 'cd-over';
    overEl.innerHTML = '<div class="cd-confetti">' + bits + '</div>' +
      '<div class="crown">' + ICON.crown(52) + '</div>' +
      '<div class="big">' + esc(o.title || ((players.length ? (players[0].name || '') : '没人') + ' 是最后的赢家')) + '</div>' +
      '<div class="sub">打了 ' + (v.round || 1) + ' 轮，总分说了算</div>' +
      '<div class="cd-over-list">' + rows + '</div>' +
      '<a class="cd-btn cd-btn--primary" href="/cards/">回大厅</a>';
    document.body.appendChild(overEl);
  }

  function hideGameOver() {
    if (overEl) { overEl.remove(); overEl = null; }
  }

  // ── 场面横幅（清场 / 炸弹 / 反转 之类的一闪而过）──────────────────────────

  function banner(host, text, kind) {
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'cd-banner' + (kind ? ' is-' + kind : '');
    el.textContent = text;
    host.appendChild(el);
    setTimeout(function () { el.remove(); }, 1300);
  }

  // ── 玩法说明（大厅和牌桌共用；访客朋友第一次玩全靠它）─────────────────────

  var GAME_NAME = { ddz: '斗地主', zjh: '炸金花', uno: 'UNO' };

  function S(t, body) {
    return '<section class="cd-help-sec"><h3>' + t + '</h3>' + body + '</section>';
  }
  function P(t) { return '<p>' + t + '</p>'; }

  var HELP = {
    ddz: {
      title: '斗地主怎么玩',
      body:
        S('目标', P('恰好 <b>3 个人</b>。一副 54 张牌，每人 17 张，剩 3 张当<b>底牌</b>。' +
          '一个人当<b>地主</b>拿走底牌单挑，另外两个是<b>农民</b>，天然一伙——' +
          '谁先把手里的牌出完，谁那边就赢。')) +
        S('叫分', P('发完牌轮流叫分：<b>1 分 / 2 分 / 3 分</b>，也可以<b>不叫</b>。' +
          '出价最高的人当地主，底牌当场亮给所有人看，叫的分就是这局的<b>底分</b>。' +
          '叫到 3 分直接封顶开打；<b>三个人都不叫 → 重新洗牌发过</b>。')) +
        S('牌力', P('单张从小到大：<b>3 4 5 6 7 8 9 10 J Q K A 2</b>，再上面是<b>小王</b>和<b>大王</b>。花色不分大小。')) +
        S('牌型', P('<b>单张 / 对子 / 三条 / 三带一 / 三带一对</b>；' +
          '<b>顺子</b>（5 张以上连号，比如 5-6-7-8-9）、<b>连对</b>（3 对以上连号）、' +
          '<b>飞机</b>（连着的三条，可以每个各带一张或各带一对）。') +
          P('<b>2 和王不进顺子</b>，A 只能当顶（…J Q K A 就到头了）。') +
          P('<b>炸弹</b>＝四张同点数，<b>王炸</b>＝双王。炸弹压一切普通牌型，王炸压一切炸弹。')) +
        S('出牌', P('地主先出，逆时针轮转。跟牌必须是<b>同牌型、同张数、且更大</b>；' +
          '出不起或不想出就「<b>不要</b>」。两家都不要 → 上一个出牌的人重新领出，什么牌型随他。') +
          P('农民是一伙的：队友快出完了就帮着压，别自己人打自己人。')) +
        S('计分', P('本局分数＝<b>底分 × 倍数</b>。每炸一次（炸弹或王炸）<b>倍数翻一倍</b>；' +
          '地主一张牌没出就被打光（<b>春天</b>）或农民一张没出就输光（<b>反春</b>）再翻一倍。') +
          P('地主赢：从<b>两个农民各收一份</b>；地主输：<b>赔给两个农民各一份</b>。累计到整场结束。')) +
        S('四带二 ⚙️', P('可选规则（默认<b>开</b>）：四张同点数可以带两张单牌、或带两个对子当普通牌型出。' +
          '关掉的话四张同点数就只能当炸弹用。')) +
        S('人数提醒', P('斗地主<b>恰好 3 人</b>才能开局。建房时算上你自己一共只能有 3 个座位，' +
          'AI 最多请 2 位——勾多了服务端也塞不进来。'))
    },
    zjh: {
      title: '炸金花怎么玩',
      body:
        S('目标', P('<b>2~4 人</b>，52 张牌（没有王），每人发 <b>3 张</b>。' +
          '靠下注把别人吓走，或者最后<b>比牌</b>比赢——池子里的筹码归你。')) +
        S('筹码和底注', P('每人入局带一份<b>初始筹码</b>（默认 1000），每局开始各交一份<b>底注</b>（默认 10）进池子，' +
          '底注也是这一轮的「当前注」。筹码不够底注的人这局轮空。')) +
        S('闷牌', P('开局你的三张牌是<b>扣着的</b>——不看就下注叫「<b>闷</b>」，闷着跟注<b>只要一半钱</b>，' +
          '这是炸金花最上头的地方：省钱，还唬人。') +
          P('随时可以<b>看牌</b>翻开自己那三张；看完就是明牌，之后下注按全价。（可选规则，默认开；关掉的话开局所有人直接明牌。）')) +
        S('轮到你能做什么', P('<b>跟注</b>：把当前注补进池子，继续。<br>' +
          '<b>加注</b>：加大当前注，后面的人要跟就得掏更多。<br>' +
          '<b>弃牌</b>：不玩了，之前扔的钱不退。<br>' +
          '<b>比牌</b>：付一份当前注，点名和某个人当场对牌，<b>输的那个当场出局</b>（比牌只有你俩知道结果）。')) +
        S('牌力', P('从大到小：<b>豹子</b>（三张同点，如 AAA）＞<b>顺金</b>（同花色的三连，如 ♠5♠6♠7）＞' +
          '<b>金花</b>（三张同花色）＞<b>顺子</b>（三连不同花）＞<b>对子</b>＞<b>散牌</b>（单张比大小）。') +
          P('A 最大，2 最小；但 <b>A-2-3 算最小的顺子</b>，压不过 Q-K-A。' +
            '同类型先比最大的那张，再比第二张，一路比下去。')) +
        S('这局怎么结束', P('别人全弃牌只剩你一个，或者比牌比到只剩一个人没出局 —— 剩下的那位<b>把池子全端走</b>。' +
          '筹码累计带到下一局，想打几局打几局，房主随时能「结束整场」。')) +
        S('235 克豹子 ⚙️', P('可选规则（默认<b>关</b>）：花色互不相同的 <b>2、3、5</b> 能吃掉豹子（最大的牌被最烂的牌反杀），' +
          '但遇到别的牌型时它就是最小的散牌。')) +
        S('底注 / 初始筹码 ⚙️', P('这两项建房时可以直接改数字：底注越大，节奏越凶；' +
          '初始筹码决定大家能扛几轮。每个房间的筹码<b>各算各的</b>，不跨房、更不是真钱。'))
    },
    uno: {
      title: 'UNO 怎么玩',
      body:
        S('目标', P('<b>2~4 人</b>，每人先摸 <b>7 张</b>，翻一张当起始弃牌堆。' +
          '轮流往弃牌堆上盖牌，<b>谁先把手牌出完谁赢这一局</b>，剩牌的人按手上的牌给赢家送分。')) +
        S('怎么算能出', P('你出的牌要和牌堆顶那张<b>颜色相同</b>、或者<b>数字/图案相同</b>，' +
          '万能牌（黑色）任何时候都能出。') +
          P('出万能牌时你要<b>指定一个颜色</b>，下一个人就得跟这个颜色。')) +
        S('功能牌', P('<b>跳过（Skip）</b>：下一个人这轮没了，直接轮过去。<br>' +
          '<b>反转（Reverse）</b>：出牌方向掉头（两个人时相当于再来一次跳过）。<br>' +
          '<b>+2</b>：下家摸两张并且不能出牌。<br>' +
          '<b>万能（Wild）</b>：随便指定颜色。<br>' +
          '<b>万能 +4（Wild Draw Four）</b>：指定颜色，下家摸四张还不能出。')) +
        S('出不起怎么办', P('手上没有能出的牌就<b>摸一张</b>。摸到的那张<b>如果能出，可以立刻打出去</b>；' +
          '不想出就留着，这轮结束轮到下一位。')) +
        S('计分', P('有人出完，这一局结束，其他人手上的牌折算成分数给赢家：' +
          '<b>数字牌算面值</b>（0~9），<b>跳过 / 反转 / +2 各 20 分</b>，' +
          '<b>万能 和 万能+4 各 50 分</b>。分数累计，房主随时可以「结束整场」看总榜。')) +
        S('+2 叠加 ⚙️', P('可选规则（默认<b>关</b>）：被 +2 指到时，如果你手上也有 +2，可以接着出，' +
          '把罚摸的张数<b>累加转嫁给下家</b>（+2、+4 张、+6 张…直到有人接不住全摸下来）。' +
          '关掉就是官方基础规则：被 +2 指到只能乖乖摸两张。')) +
        S('v1 的两点简化', P('<b>不做质疑</b>：别人出万能 +4 时不能质疑他手上有没有同色牌。<br>' +
          '<b>UNO 自动喊</b>：剩最后一张时系统自动提示，不会因为忘喊被罚牌。'))
    }
  };

  /** rulesHelp(game) —— game 传 'ddz'|'zjh'|'uno'；不认识的一律给个提示，别静默 */
  function rulesHelp(game) {
    var h = HELP[game];
    if (!h) {
      return modal({
        sheet: true, className: 'cd-help',
        html: '<div class="cd-sheet-grip"></div><h2>玩法说明</h2>' +
          '<div class="sub">先在上面选一个游戏，这里就会写它的规则。</div>'
      });
    }
    return modal({
      sheet: true,
      className: 'cd-help',
      html: '<div class="cd-sheet-grip"></div><h2>' + esc(h.title) + '</h2>' + h.body
    });
  }

  global.CdUI = {
    esc: esc,
    icon: icon,
    ICON: ICON,
    GAME_NAME: GAME_NAME,
    toast: toast,
    modal: modal,
    scoreboard: scoreboard,
    gameOver: gameOver,
    hideGameOver: hideGameOver,
    banner: banner,
    rulesHelp: rulesHelp
  };
})(window);
