/* Bisca 大富翁 —— 大厅：建房间 + 房间列表 */
(function (global) {
  'use strict';

  var API = global.MonoAPI;
  var UI = global.MonoUI;
  var esc = global.MonoBoard.esc;
  var $ = function (id) { return document.getElementById(id); };

  var chosen = API.loadMe().color || API.COLORS[0].hex;

  function renderColors() {
    $('lb-colors').innerHTML = API.COLORS.map(function (c) {
      return '<button type="button" class="mono-sw' + (c.hex === chosen ? ' is-on' : '') +
        '" data-hex="' + c.hex + '" title="' + c.name + '" aria-label="' + c.name +
        '" style="background:' + c.hex + '"></button>';
    }).join('');
    $('lb-colors').querySelectorAll('.mono-sw').forEach(function (b) {
      b.addEventListener('click', function () {
        chosen = b.dataset.hex;
        renderColors();
      });
    });
  }

  function tag(room) {
    if (room.finished) return '<span class="mono-tag is-done">已结束</span>';
    if (room.started) return '<span class="mono-tag is-live">进行中</span>';
    return '<span class="mono-tag is-open">等人中</span>';
  }

  function roomCard(room) {
    var dots = (room.players || []).map(function (p) {
      return '<span class="mono-dot" style="background:' + esc(p.color) + '" title="' + esc(p.name) + '"></span>';
    }).join('');
    var seatMine = API.loadSeat(room.code);
    return '<a class="cn-card room-card" href="room.html?c=' + esc(room.code) + '">' +
      '<div class="main">' +
      '<div class="nm">' + esc(room.name || '未命名房间') + '</div>' +
      '<div class="sub">' + tag(room) + '<span>' + esc(room.code) + '</span><span>' +
      room.playerCount + '/4 人</span>' + (seatMine ? '<span>有你的座位</span>' : '') + '</div>' +
      (dots ? '<div class="avatars">' + dots + '</div>' : '') +
      '</div>' +
      '<span class="chev">' + UI.icon('chevron', 18) + '</span></a>';
  }

  function loadRooms() {
    return API.listRooms().then(function (d) {
      var rooms = d.rooms || [];
      var box = $('lb-rooms');
      if (!rooms.length) {
        box.innerHTML = '<div class="lb-empty">还没有房间，上面开一间吧</div>';
        return;
      }
      // 等人中 → 进行中 → 已结束
      var rank = function (r) { return r.finished ? 2 : (r.started ? 1 : 0); };
      rooms.sort(function (a, b) { return rank(a) - rank(b); });
      box.innerHTML = rooms.map(roomCard).join('');
    }, function (e) {
      $('lb-rooms').innerHTML = '<div class="lb-empty">' + esc(e.message) + '</div>';
    });
  }

  function create() {
    var btn = $('lb-create');
    var roomName = ($('lb-room').value || '').trim();
    var myName = ($('lb-name').value || '').trim();
    if (!myName) { UI.toast('先起个昵称', true); $('lb-name').focus(); return; }
    btn.disabled = true;
    API.createRoom(roomName || '未命名房间').then(function (r) {
      return API.joinRoom(r.code, { name: myName, color: chosen }).then(function (seat) {
        API.saveSeat(r.code, seat);
        API.saveMe({ name: seat.name, color: seat.color });
        location.href = 'room.html?c=' + r.code;
      });
    }).catch(function (e) {
      btn.disabled = false;
      UI.toast(e.message, true);
    });
  }

  function boot() {
    $('lb-ic-new').innerHTML = UI.icon('plus', 18);
    $('lb-name').value = API.loadMe().name || '';
    renderColors();
    $('lb-create').addEventListener('click', create);
    $('lb-refresh').addEventListener('click', function () {
      $('lb-rooms').innerHTML = '<div class="lb-empty">加载中…</div>';
      loadRooms();
    });
    loadRooms();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
