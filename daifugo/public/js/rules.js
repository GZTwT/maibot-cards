/* 大富豪 —— 引擎桥（出牌合法性「预判」，纯前端体验优化）
 *
 * 页面会去加载 /daifugo/engine.js（全局 window.DaifugoEngine）。
 * **它随时可能不在**（还没部署 / 加载失败 / 接口改了），所以这一层全部防御性调用：
 * 引擎不在或抛错 → ok:false → 房间页不做任何预判，按钮全可点，合法性交给服务端，
 * 服务端 400 会带中文原因，直接 toast。真理永远在服务端那边。
 */
(function (global) {
  'use strict';

  function engine() { return global.DaifugoEngine || null; }

  function usable() {
    var e = engine();
    return !!(e && typeof e.legalMoves === 'function');
  }

  /**
   * 引擎吃的是完整 state，我们手上只有脱敏 view（别人的 hand 没有，只有 handCount）。
   * legalMoves 判「我」能出什么只用得到我自己的手牌 + 场面 + 革命/縛り，
   * 所以给别人补一副空手牌防止引擎读 p.hand.length 炸掉。整段仍然包在 try 里。
   */
  function asState(view) {
    if (!view) return null;
    var st = Object.assign({}, view);
    st.players = (view.players || []).map(function (p) {
      return (p && p.hand) ? p : Object.assign({}, p, { hand: [] });
    });
    return st;
  }

  function key(cards) { return (cards || []).slice().sort().join(','); }

  /**
   * moves(view, playerId) -> {
   *   ok,          引擎给出结果了吗（false = 全面降级，别拿去禁用任何东西）
   *   list:[[id]], 合法出牌（每项是牌 id 数组）
   *   keys:{key:1},
   *   canPass
   * }
   */
  function moves(view, playerId) {
    if (!usable() || !view || !playerId) return { ok: false, list: [], keys: {}, canPass: !!(view && view.field) };
    var raw;
    try { raw = engine().legalMoves(asState(view), playerId); } catch (e) {
      return { ok: false, list: [], keys: {}, canPass: !!(view && view.field) };
    }
    return normalize(raw, view);
  }

  /**
   * 把 legalMoves 的返回（或服务端 state 接口带的 legal 数组）揉成统一结构。
   * 认得下列写法：[{type:'play',cards:[...]}] · [[id,...]] · {moves|plays|list:[...], canPass}
   */
  function normalize(raw, view) {
    var res = { ok: false, list: [], keys: {}, canPass: !!(view && view.field) };
    if (!raw) return res;

    var arr = Array.isArray(raw) ? raw : (raw.moves || raw.plays || raw.list);
    if (!Array.isArray(arr)) return res;

    var sawPass = false;
    if (typeof raw.canPass === 'boolean') { sawPass = true; res.canPass = raw.canPass; }

    arr.forEach(function (m) {
      var cards = null;
      if (Array.isArray(m)) {
        cards = m;
      } else if (typeof m === 'string') {
        if (m === 'pass') { sawPass = true; res.canPass = true; }
        return;
      } else if (m && typeof m === 'object') {
        if (m.type === 'pass' || m.action === 'pass') { sawPass = true; res.canPass = true; return; }
        // 换牌阶段引擎给的是 give_back 组合、轮末给的是 next_round，出牌预判用不上
        if (m.type && m.type !== 'play') return;
        if (Array.isArray(m.cards)) cards = m.cards;
      }
      if (!cards || !cards.length) return;
      res.list.push(cards.slice());
      res.keys[key(cards)] = 1;
    });

    res.ok = true;
    // 引擎没明说能不能过：领出（场上没牌）不能过，跟牌能过——这是标准规则，兜底够用
    if (!sawPass) res.canPass = !!view.field;
    return res;
  }

  /** 当前已选中 sel 的前提下，还有哪些牌可能凑成合法的一手。ok:false 时返回 null = 不做限制 */
  function candidates(res, sel) {
    if (!res || !res.ok) return null;
    var out = {};
    res.list.forEach(function (cards) {
      for (var i = 0; i < sel.length; i++) {
        if (cards.indexOf(sel[i]) === -1) return;     // sel 不是这一手的子集，跳过
      }
      cards.forEach(function (id) { out[id] = 1; });
    });
    return out;
  }

  function isLegal(res, sel) {
    if (!sel || !sel.length) return false;
    if (!res || !res.ok) return true;                 // 降级：一律放行，让服务端说话
    return !!res.keys[key(sel)];
  }

  function canPass(res) {
    if (!res || !res.ok) return true;                 // 降级：按钮可点
    return !!res.canPass;
  }

  var SIZE_NAME = { 1: '单张', 2: '对子', 3: '三条', 4: '四条' };
  var STAIR_TYPE = { stair: 1, stairs: 1, kaidan: 1, seq: 1, sequence: 1, run: 1 };

  /** 牌型的人话名字。引擎在的话直接用它的 comboLabel，口径跟日志一致 */
  function comboName(combo) {
    if (!combo) return '';
    var e = engine();
    if (e && typeof e.comboLabel === 'function') {
      try { return e.comboLabel(combo); } catch (x) { /* 落到本地口径 */ }
    }
    var t = String(combo.type || '').toLowerCase();
    var size = combo.size || 0;
    if (STAIR_TYPE[t]) return size ? (size + ' 连阶梯') : '阶梯';
    return SIZE_NAME[size] || (size ? (size + ' 条') : '');
  }

  function comboOf(cards, opts) {
    var e = engine();
    if (!e || typeof e.comboOf !== 'function') return undefined;   // undefined = 问不到
    try { return e.comboOf((cards || []).slice(), opts || {}) || null; } catch (x) { return null; }
  }

  /** 选了一手但不合法时，给一句人话（尽力而为，问不出细节就说大概） */
  function reason(view, sel) {
    if (!sel || !sel.length) return '先从下面点几张牌';
    var combo = comboOf(sel, { revolution: !!(view && view.revolution) });
    if (combo === null) return '这几张凑不成牌型';
    var f = view && view.field;
    if (f && f.combo) {
      var C = f.combo;
      if (combo && combo.type && C.type && combo.type !== C.type) {
        return '场上是' + (comboName(C) || '别的牌型') + '，得出同一种牌型';
      }
      if (C.size && sel.length !== C.size) {
        return '场上是 ' + C.size + ' 张，你也得出 ' + C.size + ' 张';
      }
      return '压不过场上的牌';
    }
    return '这一手现在出不了';
  }

  global.DfRules = {
    usable: usable,
    moves: moves,
    normalize: normalize,
    candidates: candidates,
    isLegal: isLegal,
    canPass: canPass,
    comboOf: comboOf,
    comboName: comboName,
    reason: reason,
    key: key
  };
})(window);
