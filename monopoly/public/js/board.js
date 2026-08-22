/* Bisca 大富翁 —— 棋盘渲染 + 捏合缩放
 * 11×11 grid，周圈 40 格（0=起点在右下角，顺时针 = 视觉上先往左走），四角大格。
 * 棋子单独一层绝对定位，改 left/top 即 CSS 过渡滑动。
 */
(function (global) {
  'use strict';

  var SIZE = 40;
  var SVG_HEAD = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

  /* 库里没有的格子图标，按同规格手写内联 path（24×24 / fill:none / stroke 1.8） */
  var ICON = {
    go: SVG_HEAD + '<path d="M4 12h13"/><path d="M12 7l5 5-5 5"/><path d="M20 5v14"/></svg>',
    rail: SVG_HEAD + '<rect x="6" y="4" width="12" height="12" rx="2.5"/><path d="M6.5 10h11"/>' +
      '<path d="M9 19l-2 2"/><path d="M15 19l2 2"/><path d="M9.5 13h.01"/><path d="M14.5 13h.01"/></svg>',
    util: SVG_HEAD + '<path d="M13 3 5 13.5h5.5L10 21l8-10.5h-5.5L13 3Z"/></svg>',
    tax: SVG_HEAD + '<path d="M12 8.5c3.9 0 7-1.1 7-2.5S15.9 3.5 12 3.5 5 4.6 5 6s3.1 2.5 7 2.5Z"/>' +
      '<path d="M5 6v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/><path d="M5 12v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6"/></svg>',
    chance: SVG_HEAD + '<path d="M12 4l1.3 3.1 3.3.3-2.5 2.2.8 3.2L12 13.4 9.1 15l.8-3.2L7.4 9.6l3.3-.3Z"/>' +
      '<path d="M18 17.5h.01"/><path d="M6 18h.01"/></svg>',
    community: SVG_HEAD + '<path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v10A1.5 1.5 0 0 1 18.5 18h-13A1.5 1.5 0 0 1 4 16.5Z"/>' +
      '<path d="M4.6 6.6 12 12l7.4-5.4"/></svg>',
    jail: SVG_HEAD + '<rect x="4.5" y="4.5" width="15" height="15" rx="2.5"/><path d="M9 4.5v15"/><path d="M12 4.5v15"/><path d="M15 4.5v15"/></svg>',
    goto_jail: SVG_HEAD + '<rect x="9" y="6" width="10.5" height="12" rx="2"/><path d="M13 6v12"/><path d="M16.2 6v12"/>' +
      '<path d="M3 12h5"/><path d="M6 9.5 8.5 12 6 14.5"/></svg>',
    parking: SVG_HEAD + '<path d="M3.5 14.5h17"/><path d="M5 14.5 7 8.2a2 2 0 0 1 1.9-1.4h6.2A2 2 0 0 1 17 8.2l2 6.3"/>' +
      '<path d="M4.5 14.5v3.6h2.8v-1.8"/><path d="M19.5 14.5v3.6h-2.8v-1.8"/><path d="M8 11.4h8"/></svg>',
    crown: '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round" class="crown" aria-hidden="true">' +
      '<path d="M3.5 7.5 7 12l5-7 5 7 3.5-4.5V18h-17Z"/></svg>'
  };

  var TYPE_LABEL = {
    go: '起点', prop: '地产', rail: '车站', util: '公用事业', tax: '税收',
    luxury_tax: '奢侈税', chance: '机会', community: '命运',
    jail: '监狱', goto_jail: '进监狱', parking: '停车场'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** idx -> 11×11 grid 的行列（1-based）。0 在右下角，顺时针一圈。 */
  function cellPos(i) {
    if (i <= 10) return { r: 11, c: 11 - i };              // 底边：右下 → 左下
    if (i <= 20) return { r: 21 - i, c: 1 };               // 左边：左下 → 左上
    if (i <= 30) return { r: 1, c: i - 19 };               // 顶边：左上 → 右上
    return { r: i - 29, c: 11 };                           // 右边：右上 → 右下
  }

  function isCorner(i) { return i === 0 || i === 10 || i === 20 || i === 30; }

  function cellIcon(cell) {
    if (!cell) return '';
    if (cell.type === 'luxury_tax') return ICON.tax;
    return ICON[cell.type] || '';
  }

  function cellInner(cell, i) {
    var name = esc(cell.name || ('第 ' + i + ' 格'));
    var crown = cell.type === 'luxury_tax' ? ICON.crown + ' ' : '';
    var ico = (cell.type === 'prop') ? '' : ('<div class="cico">' + cellIcon(cell) + '</div>');
    var foot = '';
    if (cell.price) foot = '<div class="cprice">¥' + cell.price + '</div>';
    else if (cell.amount) foot = '<div class="cprice">¥' + cell.amount + '</div>';
    return '<i class="cbar"></i>' +
      ico +
      '<div class="cname">' + crown + name + '</div>' +
      foot +
      '<div class="chouses"></div>';
  }

  /** 首次构建 DOM，返回句柄（后续只做 update，不重建，棋子才能滑动） */
  function build(el, board) {
    el.innerHTML = '';
    var cells = [];
    for (var i = 0; i < SIZE; i++) {
      var cell = (board && board[i]) || {};
      var pos = cellPos(i);
      var d = document.createElement('div');
      d.className = 'mono-cell' + (isCorner(i) ? ' is-corner' : '');
      d.dataset.idx = String(i);
      d.dataset.type = cell.type || '';
      if (cell.group) d.dataset.group = cell.group;
      d.style.gridRow = String(pos.r);
      d.style.gridColumn = String(pos.c);
      d.innerHTML = cellInner(cell, i);
      el.appendChild(d);
      cells.push(d);
    }
    var center = document.createElement('div');
    center.className = 'mono-center';
    el.appendChild(center);

    var layer = document.createElement('div');
    layer.className = 'mono-tokens';
    el.appendChild(layer);

    return { root: el, cells: cells, center: center, layer: layer, tokens: {} };
  }

  function houseHtml(n, maxHouses) {
    if (!n) return '';
    if (n >= maxHouses) return '<i class="hotel"></i>';
    var out = '';
    for (var k = 0; k < n; k++) out += '<i></i>';
    return out;
  }

  /** 每次 state 变化调用：刷新归属/房子/高亮/棋子位置 */
  function update(ui, state, opts) {
    var o = opts || {};
    var maxHouses = (state.config && state.config.maxHouses) || 5;
    var byId = {};
    state.players.forEach(function (p) { byId[p.id] = p; });
    var curPlayer = byId[state.currentPlayer];

    for (var i = 0; i < SIZE; i++) {
      var el = ui.cells[i];
      if (!el) continue;
      var own = state.cells[i] || state.cells[String(i)] || null;
      var dot = el.querySelector('.cown');
      if (own && byId[own.owner]) {
        if (!dot) {
          dot = document.createElement('div');
          dot.className = 'cown';
          el.appendChild(dot);
        }
        dot.style.background = byId[own.owner].color;
        dot.style.color = byId[own.owner].color;
      } else if (dot) {
        dot.remove();
      }
      var hs = el.querySelector('.chouses');
      if (hs) hs.innerHTML = houseHtml(own ? (own.houses || 0) : 0, maxHouses);

      el.classList.toggle('is-here', !!curPlayer && curPlayer.pos === i && !state.winner);
      el.classList.toggle('is-pick', !!(o.highlight && o.highlight.indexOf(i) !== -1));
    }

    placeTokens(ui, state);
  }

  function placeTokens(ui, state) {
    var perCell = {};
    state.players.forEach(function (p) {
      var k = p.pos || 0;
      (perCell[k] = perCell[k] || []).push(p);
    });

    var seen = {};
    Object.keys(perCell).forEach(function (k) {
      var group = perCell[k];
      var cell = ui.cells[Number(k)];
      if (!cell) return;
      var cx = cell.offsetLeft + cell.offsetWidth / 2;
      var cy = cell.offsetTop + cell.offsetHeight / 2;
      group.forEach(function (p, n) {
        seen[p.id] = true;
        var t = ui.tokens[p.id];
        if (!t) {
          t = document.createElement('div');
          t.className = 'mono-token';
          t.dataset.pid = p.id;
          ui.layer.appendChild(t);
          ui.tokens[p.id] = t;
        }
        t.style.background = p.color;
        t.style.color = p.color;
        t.title = p.name;
        t.classList.toggle('is-out', !!p.bankrupt);
        t.classList.toggle('is-turn', state.currentPlayer === p.id && !p.bankrupt && !state.winner);
        var dx = (n - (group.length - 1) / 2) * 11;
        t.style.left = (cx + dx - 7.5) + 'px';
        t.style.top = (cy - 7.5 + (group.length > 1 ? 4 : 0)) + 'px';
      });
    });

    Object.keys(ui.tokens).forEach(function (id) {
      if (!seen[id]) { ui.tokens[id].remove(); delete ui.tokens[id]; }
    });
  }

  // ── 缩放 / 拖动 ────────────────────────────────────────────────────────────

  var MAX = 2.5;

  /**
   * attachZoom(viewport, canvas) —— 自写 pointer events：
   * 双指捏合缩放、单指拖动（内容超出视口时）、双击/双触复位、ctrl+滚轮、外部 +/- 按钮。
   */
  function attachZoom(viewport, canvas, onTap) {
    var scale = 1, tx = 0, ty = 0, fit = 1;
    var pts = {};
    var pinch = null;
    var moved = 0;
    var lastTapAt = 0;

    function contentSize() { return canvas.offsetWidth || 1; }

    function apply() {
      canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    }

    function clampPan() {
      var w = viewport.clientWidth, h = viewport.clientHeight;
      var s = contentSize() * scale;
      // 内容比视口小就居中，比视口大就限制在边界内（留 40px 余量，手指好抓）
      if (s <= w) tx = (w - s) / 2; else tx = Math.min(40, Math.max(w - s - 40, tx));
      if (s <= h) ty = (h - s) / 2; else ty = Math.min(40, Math.max(h - s - 40, ty));
    }

    function minScale() { return Math.min(0.6, fit); }

    function setScale(next, ax, ay) {
      var lo = minScale();
      next = Math.max(lo, Math.min(MAX, next));
      var k = next / scale;
      tx = ax - (ax - tx) * k;
      ty = ay - (ay - ty) * k;
      scale = next;
      clampPan();
      apply();
    }

    function reset() {
      var w = viewport.clientWidth, h = viewport.clientHeight, s = contentSize();
      fit = Math.min((w - 16) / s, (h - 16) / s);
      if (!isFinite(fit) || fit <= 0) fit = 1;
      scale = Math.min(fit, MAX);
      tx = (w - s * scale) / 2;
      ty = (h - s * scale) / 2;
      apply();
    }

    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function list() { return Object.keys(pts).map(function (k) { return pts[k]; }); }

    viewport.addEventListener('pointerdown', function (e) {
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      try { viewport.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      var l = list();
      if (l.length === 2) {
        pinch = { d: dist(l[0], l[1]), s: scale };
      } else if (l.length === 1) {
        moved = 0;
      }
    });

    viewport.addEventListener('pointermove', function (e) {
      var p = pts[e.pointerId];
      if (!p) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      var l = list();
      if (l.length >= 2 && pinch) {
        var d = dist(l[0], l[1]);
        if (pinch.d > 0) {
          var r = viewport.getBoundingClientRect();
          var mx = (l[0].x + l[1].x) / 2 - r.left;
          var my = (l[0].y + l[1].y) / 2 - r.top;
          setScale(pinch.s * (d / pinch.d), mx, my);
        }
        moved = 99;
      } else if (l.length === 1) {
        moved += Math.abs(dx) + Math.abs(dy);
        tx += dx; ty += dy;
        clampPan();
        apply();
      }
    });

    function up(e) {
      delete pts[e.pointerId];
      if (list().length < 2) pinch = null;
      if (list().length === 0 && moved < 6) {
        var now = Date.now();
        if (now - lastTapAt < 320) { reset(); lastTapAt = 0; return; }
        lastTapAt = now;
        if (onTap) onTap(e);
      }
    }
    viewport.addEventListener('pointerup', up);
    viewport.addEventListener('pointercancel', function (e) { delete pts[e.pointerId]; pinch = null; });

    viewport.addEventListener('wheel', function (e) {
      if (!e.ctrlKey) return;   // 桌面：ctrl+滚轮 / 触控板捏合
      e.preventDefault();
      var r = viewport.getBoundingClientRect();
      setScale(scale * (e.deltaY < 0 ? 1.12 : 0.89), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    viewport.addEventListener('dblclick', function () { reset(); });

    return {
      reset: reset,
      zoomBy: function (k) {
        setScale(scale * k, viewport.clientWidth / 2, viewport.clientHeight / 2);
      }
    };
  }

  global.MonoBoard = {
    build: build,
    update: update,
    attachZoom: attachZoom,
    cellPos: cellPos,
    isCorner: isCorner,
    TYPE_LABEL: TYPE_LABEL,
    ICON: ICON,
    esc: esc
  };
})(window);
