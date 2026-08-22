/* Bisca 大富翁 —— 浮层件：toast / 通用弹层 / 入座卡 / 格子详情 / 卡牌 / 胜利屏 / 选格抽屉 */
(function (global) {
  'use strict';

  var esc = global.MonoBoard.esc;
  var R = global.MonoRules;

  function icon(name, size) {
    return (global.BiscaIcons && global.BiscaIcons.svg(name, size)) || '';
  }

  // ── toast ──────────────────────────────────────────────────────────────────

  function toastLayer() {
    var el = document.getElementById('mono-toasts');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mono-toasts';
      el.className = 'mono-toasts';
      document.body.appendChild(el);
    }
    return el;
  }

  function toast(text, bad) {
    var el = document.createElement('div');
    el.className = 'mono-toast' + (bad ? ' is-bad' : '');
    el.textContent = String(text || '');
    toastLayer().appendChild(el);
    setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () { el.remove(); }, 220);
    }, bad ? 3200 : 2200);
  }

  // ── 通用弹层 ───────────────────────────────────────────────────────────────

  function modal(opts) {
    var o = opts || {};
    var scrim = document.createElement('div');
    scrim.className = 'mono-scrim';
    var box = document.createElement('div');
    box.className = 'mono-modal ' + (o.className || '');
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

  // ── 入座卡 ─────────────────────────────────────────────────────────────────

  function joinDialog(opts) {
    var o = opts || {};
    var taken = (o.taken || []).map(function (c) { return String(c).toLowerCase(); });
    var colors = global.MonoAPI.COLORS;
    var chosen = null;
    for (var i = 0; i < colors.length; i++) {
      if (taken.indexOf(colors[i].hex.toLowerCase()) === -1) {
        if (!chosen || (o.preferColor && colors[i].hex.toLowerCase() === String(o.preferColor).toLowerCase())) {
          chosen = colors[i].hex;
        }
      }
    }
    var sw = colors.map(function (c) {
      var isTaken = taken.indexOf(c.hex.toLowerCase()) !== -1;
      return '<button type="button" class="mono-sw' + (isTaken ? ' is-taken' : '') +
        (c.hex === chosen ? ' is-on' : '') + '" data-hex="' + c.hex + '" title="' + c.name +
        '" aria-label="' + c.name + '" style="background:' + c.hex + '"></button>';
    }).join('');

    return modal({
      dismissable: false,
      html: '<h2>坐下来一起玩</h2>' +
        '<div class="sub">' + esc(o.subtitle || '选个名字和棋子颜色，坐进这局。') + '</div>' +
        '<div class="mono-field" style="margin-top:16px"><span class="k">昵称</span>' +
        '<input id="jd-name" maxlength="16" placeholder="怎么称呼你" value="' + esc(o.name || '') + '"></div>' +
        '<div class="mono-field" style="margin-top:14px"><span class="k">棋子颜色</span>' +
        '<div class="mono-swatches">' + sw + '</div></div>' +
        '<div style="display:flex;gap:8px;margin-top:18px">' +
        '<button class="mono-btn mono-btn--ghost" id="jd-watch">只看看</button>' +
        '<button class="mono-btn mono-btn--primary" id="jd-ok" style="flex:1">入座</button></div>',
      onMount: function (h) {
        var box = h.el;
        box.querySelectorAll('.mono-sw').forEach(function (b) {
          b.addEventListener('click', function () {
            box.querySelectorAll('.mono-sw').forEach(function (x) { x.classList.remove('is-on'); });
            b.classList.add('is-on');
            chosen = b.dataset.hex;
          });
        });
        box.querySelector('#jd-watch').addEventListener('click', function () {
          h.close();
          if (o.onWatch) o.onWatch();
        });
        box.querySelector('#jd-ok').addEventListener('click', function () {
          var nm = (box.querySelector('#jd-name').value || '').trim();
          if (!nm) { toast('先起个名字吧', true); return; }
          if (!chosen) { toast('挑个颜色', true); return; }
          h.close();
          o.onSubmit({ name: nm, color: chosen });
        });
      }
    });
  }

  // ── 格子详情 popover ───────────────────────────────────────────────────────

  var RENT_LABEL = ['裸地', '1 栋房', '2 栋房', '3 栋房', '4 栋房', '旅馆'];

  function cellDetail(state, idx, opts) {
    var o = opts || {};
    var cell = R.cellAt(state, idx) || {};
    var own = R.ownerOf(state, idx);
    var owner = own ? R.findPlayer(state, own.owner) : null;
    var houses = own ? (own.houses || 0) : 0;
    var maxHouses = (state.config && state.config.maxHouses) || 5;

    var rows = '';
    if (cell.price) rows += row('地价', '¥' + cell.price);
    if (cell.amount && !cell.price) rows += row('金额', '¥' + cell.amount);
    rows += row('归属', owner ? owner.name : (cell.price ? '还没人买' : '—'));
    if (cell.type === 'prop') {
      rows += row('房产', houses >= maxHouses ? '旅馆' : (houses ? houses + ' 栋房' : '空地'));
      if (cell.houseCost) rows += row('每栋造价', '¥' + cell.houseCost);
    }
    if (cell.type === 'prop' && cell.rents) {
      cell.rents.forEach(function (v, i) {
        var on = owner && ((houses === 0 && i === 0) || (houses > 0 && Math.min(houses, cell.rents.length - 1) === i));
        rows += '<div class="prow' + (on ? ' is-on' : '') + '"><span class="k">' +
          (RENT_LABEL[i] || ('第 ' + i + ' 档')) + '租金</span><span class="v">¥' + v + '</span></div>';
      });
      if (owner && houses === 0 && R.groupFullyOwned(state, cell.group, owner.id)) {
        rows += row('集齐同色组', '裸地租金 ×2');
      }
    } else if (cell.type === 'rail' && cell.rents) {
      cell.rents.forEach(function (v, i) {
        rows += row('拥 ' + (i + 1) + ' 站', '¥' + v);
      });
    } else if (cell.type === 'util') {
      var m = cell.multipliers || (state.config && state.config.utilMultipliers) || [40, 100];
      rows += row('拥 1 家', '骰点 ×' + m[0]);
      rows += row('拥 2 家', '骰点 ×' + m[1]);
    }
    if (owner) rows += row('当前租金', '¥' + R.rentFor(state, idx));

    var acts = '';
    if (o.canBuild) acts += '<button class="mono-btn mono-btn--primary mono-btn--sm" id="cd-build">盖房 ¥' + (cell.houseCost || 0) + '</button>';
    if (o.canSell) acts += '<button class="mono-btn mono-btn--sm" id="cd-sell">卖房 +¥' + Math.floor((cell.houseCost || 0) / 2) + '</button>';

    var grp = cell.group ? ' data-group="' + cell.group + '"' : '';
    return modal({
      className: 'mono-pop',
      html: '<div class="ptop"><i class="pbar"' + grp + ' data-type="' + esc(cell.type || '') + '"></i>' +
        '<div><div class="pnm">' + esc(cell.name || ('第 ' + idx + ' 格')) + '</div>' +
        '<div class="ptype">' + esc(global.MonoBoard.TYPE_LABEL[cell.type] || '格子') + ' · 第 ' + idx + ' 格</div></div></div>' +
        '<div style="margin-top:12px">' + rows + '</div>' +
        (acts ? '<div class="pacts">' + acts + '</div>' : ''),
      onMount: function (h) {
        var b = h.el.querySelector('#cd-build');
        if (b) b.addEventListener('click', function () { h.close(); o.onBuild(idx); });
        var s = h.el.querySelector('#cd-sell');
        if (s) s.addEventListener('click', function () { h.close(); o.onSell(idx); });
      }
    });

    function row(k, v) {
      return '<div class="prow"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>';
    }
  }

  // ── 卡牌 ───────────────────────────────────────────────────────────────────

  var cardHandle = null;
  var cardKey = null;

  function showCard(deck, card, opts) {
    var o = opts || {};
    var key = deck + '|' + (card.id || card.text);
    if (cardHandle && cardKey === key) return;
    hideCard();
    cardKey = key;
    var label = deck === 'chance' ? '机会' : '命运';
    cardHandle = modal({
      dismissable: false,
      className: 'mono-card-wrap',
      html: '<div class="mono-card">' +
        '<div class="deck">' + (deck === 'chance' ? global.MonoBoard.ICON.chance : global.MonoBoard.ICON.community) + '</div>' +
        '<div class="dname">' + label + '</div>' +
        '<div class="txt">' + esc(card.text || '') + '</div>' +
        (o.canAck
          ? '<button class="mono-btn mono-btn--primary" id="mc-ok" style="width:100%">知道了</button>'
          : '<div class="who">等 ' + esc(o.who || '对方') + ' 确认…</div>') +
        '</div>',
      onMount: function (h) {
        var b = h.el.querySelector('#mc-ok');
        if (b) b.addEventListener('click', function () { o.onAck(); });
      },
      onClose: function () { cardHandle = null; cardKey = null; }
    });
  }

  function hideCard() {
    if (cardHandle) cardHandle.close();
    cardHandle = null;
    cardKey = null;
  }

  // ── 胜利屏 ─────────────────────────────────────────────────────────────────

  var winEl = null;

  function showWin(name, colors) {
    if (winEl) return;
    winEl = document.createElement('div');
    winEl.className = 'mono-win';
    var bits = '';
    var palette = (colors && colors.length) ? colors : ['#ff5c8a', '#5cc8ff', '#ffd45c', '#7dff9e'];
    for (var i = 0; i < 70; i++) {
      var c = palette[i % palette.length];
      bits += '<i style="left:' + (Math.random() * 100).toFixed(2) + '%;background:' + c +
        ';animation-duration:' + (2.4 + Math.random() * 2.6).toFixed(2) + 's;animation-delay:' +
        (Math.random() * 2.2).toFixed(2) + 's;transform:rotate(' + ((Math.random() * 90) | 0) + 'deg)"></i>';
    }
    winEl.innerHTML = '<div class="mono-confetti">' + bits + '</div>' +
      '<div class="crown">' + global.MonoBoard.ICON.crown.replace('width="9" height="9"', 'width="52" height="52"') + '</div>' +
      '<div class="big">' + esc(name) + ' 获胜</div>' +
      '<div class="sub">这局到此为止，服不服？</div>' +
      '<a class="mono-btn mono-btn--primary" href="/monopoly/">回大厅</a>';
    document.body.appendChild(winEl);
  }

  function hideWin() {
    if (winEl) { winEl.remove(); winEl = null; }
  }

  // ── 选格抽屉（盖房用）──────────────────────────────────────────────────────

  function pick(opts) {
    var o = opts || {};
    var rows = (o.rows || []).map(function (r) {
      return '<div class="row" data-idx="' + r.idx + '"><span class="nm">' + esc(r.name) + '</span>' +
        '<span class="cost">' + esc(r.note || '') + '</span>' +
        '<button class="mono-btn mono-btn--primary mono-btn--sm" data-go="' + r.idx + '">' + esc(o.verb || '选它') + '</button></div>';
    }).join('');
    return modal({
      html: '<h2>' + esc(o.title || '挑一个') + '</h2>' +
        '<div class="mono-pick" style="margin-top:14px">' + rows + '</div>',
      onMount: function (h) {
        h.el.querySelectorAll('[data-go]').forEach(function (b) {
          b.addEventListener('click', function () {
            h.close();
            o.onPick(Number(b.dataset.go));
          });
        });
      }
    });
  }

  global.MonoUI = {
    icon: icon,
    toast: toast,
    modal: modal,
    joinDialog: joinDialog,
    cellDetail: cellDetail,
    showCard: showCard,
    hideCard: hideCard,
    showWin: showWin,
    hideWin: hideWin,
    pick: pick
  };
})(window);
