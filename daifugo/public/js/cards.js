/* 大富豪 —— 牌面（纯 CSS 牌，无图片资源）
 * 牌 id 约定见 SPEC §1：'S3'..'S15'（H/D/C 同理，11=J 12=Q 13=K 14=A 15=2）、王 'X1' 'X2'。
 * 渲染时才把 15 翻成 "2"、14 翻成 "A"——id 不动，回传服务端的永远是原 id。
 * 颜色不写死：红花色吃 --danger，黑花色吃 --text-strong，王吃 --accent（见 daifugo.css 顶部别名）。
 */
(function (global) {
  'use strict';

  var SUITS = {
    S: { sym: '♠', tone: 'black', name: '黑桃' },
    H: { sym: '♥', tone: 'red', name: '红桃' },
    D: { sym: '♦', tone: 'red', name: '方块' },
    C: { sym: '♣', tone: 'black', name: '梅花' }
  };

  var RANK_TEXT = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 'S15' -> {id,suit:'S',rank:15,joker:false}；'X1' -> {id,joker:true,rank:16} */
  function parse(id) {
    var s = String(id || '');
    if (s.charAt(0) === 'X') return { id: s, joker: true, suit: null, rank: 16 };
    var suit = s.charAt(0);
    var rank = parseInt(s.slice(1), 10);
    if (!SUITS[suit] || !(rank >= 3 && rank <= 15)) return null;
    return { id: s, joker: false, suit: suit, rank: rank };
  }

  function rankText(rank) { return RANK_TEXT[rank] || String(rank); }

  /** 纯文字标签，日志/toast 里用：'♠2' / '★' */
  function label(id) {
    var c = parse(id);
    if (!c) return String(id || '');
    if (c.joker) return c.id === 'X1' ? '★大王' : '★小王';
    return SUITS[c.suit].sym + rankText(c.rank);
  }

  function labels(ids) {
    return (ids || []).map(label).join(' ');
  }

  /** 当前序下的强度：王恒 16，普通牌革命时取反（3 最大） */
  function strength(id, revolution) {
    var c = parse(id);
    if (!c) return 0;
    if (c.joker) return 16;
    return revolution ? (18 - c.rank) : c.rank;
  }

  /** 手牌排序：弱 → 强（革命时自动倒过来），同强度按花色稳定排 */
  function sortHand(ids, revolution) {
    var order = { S: 0, H: 1, D: 2, C: 3 };
    return (ids || []).slice().sort(function (a, b) {
      var d = strength(a, revolution) - strength(b, revolution);
      if (d) return d;
      var ca = parse(a), cb = parse(b);
      if (!ca || !cb) return 0;
      return (order[ca.suit] || 9) - (order[cb.suit] || 9);
    });
  }

  /**
   * 一张牌的 HTML。opts: {tag:'button'|'div', selected, dead, size:'sm'|'md', idx, extra}
   * idx 进 --i，给逐张入场动画排队用。
   */
  function cardHtml(id, opts) {
    var o = opts || {};
    var c = parse(id);
    var tag = o.tag || 'div';
    var cls = ['df-card'];
    if (o.size) cls.push('df-card--' + o.size);
    if (o.selected) cls.push('is-on');
    if (o.dead) cls.push('is-dead');
    if (o.extra) cls.push(o.extra);

    var body;
    if (!c) {
      cls.push('is-tone-black');
      body = '<span class="r">?</span><span class="s">?</span>';
    } else if (c.joker) {
      // X1=大王(红) X2=小王(主题色)——强度一样,纯认脸用
      cls.push('is-tone-joker');
      if (c.id === 'X1') cls.push('is-joker-big');
      body = '<span class="r">★</span><span class="s">' + (c.id === 'X1' ? '大王' : '小王') + '</span>';
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
    for (var i = 0; i < show; i++) out += '<i class="df-back" style="--i:' + i + '"></i>';
    return out;
  }

  /** 这手牌里有没有 8（判八切清场用；牌型/张数不限） */
  function hasEight(ids) {
    return (ids || []).some(function (id) {
      var c = parse(id);
      return !!c && !c.joker && c.rank === 8;
    });
  }

  global.DfCards = {
    SUITS: SUITS,
    esc: esc,
    parse: parse,
    rankText: rankText,
    label: label,
    labels: labels,
    strength: strength,
    sortHand: sortHand,
    cardHtml: cardHtml,
    backsHtml: backsHtml,
    hasEight: hasEight
  };
})(window);
