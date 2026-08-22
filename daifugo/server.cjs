#!/usr/bin/env node
"use strict";
// 大富豪 (Daifugō) 独立服务端。默认监听 127.0.0.1:8079，自成一个进程、可自由重启。
// 两处关键设计：
//   1. 分视角广播——每条 SSE 连接记住自己的 playerId，各自调 engine.viewFor 后推自己的视图，
//      绝不把 A 的手牌推给 B（观战 = playerId null）。
//   2. 内部 agent 通道（X-Internal-Key），供外部 bot / agent 程序接入出牌。
// 依赖只有 express，无 ws、无数据库。
// 落盘即真相：rooms/<code>.json 每步 tmp+rename 原子写，进程内存只是缓存。

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const { execFile } = require("child_process");
const { createHmac, timingSafeEqual, randomBytes, randomInt } = require("crypto");

const DEFAULT_PORT = 8079;
const DEFAULT_HOST = "127.0.0.1";
const COOKIE_NAME = "bisca_auth";
const COOKIE_MAX_AGE_MS = 90 * 24 * 3600 * 1000; // 登录态 90 天
const MAX_SEATS = 4;
const MIN_SEATS = 2;
const MAX_ROOM_FILES = 200;
const STALE_ROOM_MS = 7 * 24 * 3600 * 1000;
const SSE_PING_MS = 25000;
// 主题三件套（boot.js / icons.js / base.css）和字体随仓库发布，三个服务共用同一份。
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const FONTS_DIR = path.join(__dirname, "..", "fonts");
const STATIC_MAX_AGE = "1d";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去掉 I L O 0 1
const SEAT_COLORS = ["#ff5c8a", "#5cc8ff", "#ffd45c", "#7dff9e"];
const CHAT_KEEP = 200;     // 房间文件里最多留 200 条闲聊
const CHAT_TAIL = 60;      // 推给前端/视图的最近条数
const CHAT_MAX_LEN = 280;  // 单条上限

// 自动 AI 玩家：agent_id → claude CLI 的 --model 别名。座位轮到就由服务端替它出牌。
const AUTO_MODELS = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku"
};
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude"; // 本机 Claude Code CLI 的可执行名/路径
const AUTO_DELAY_MS = 1200;        // 出牌前顿一下，别快得像机器
const AUTO_CLI_TIMEOUT_MS = 45000; // 单发思考超时
const AUTO_MOVE_CAP = 24;          // prompt 里最多列这么多招
const AUTO_SAY_MAX = 120;          // AI 嘴一句最多落这么多字进聊天
const GAME_NAME = "大富豪（Daifugō）";

// AI 牌友的开场人设，config.json 的 ai_persona 可整句覆写（支持 {seatName} / {gameName} 占位符）
const DEFAULT_AI_PERSONA = "你是牌桌上的 AI 牌友「{seatName}」，正在和朋友们打{gameName}。现在轮到你动。";

// SPEC 第 1 章的规则开关默认值（config.json 缺省时写回这套）
const DEFAULT_RULES = {
  kaidan_revolution: false, // 阶梯革命
  spade3: true,             // スペ3 返し
  shibari: false,           // 縛り
  forbid_finish: true,      // 禁止上がり
  miyako_ochi: false        // 都落ち
};
const RULE_KEYS = Object.keys(DEFAULT_RULES);

// ── 配置读取 ────────────────────────────────────────────────────────────────

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

// 登录密码：设了就启用登录页，没设 = open mode（自托管内网场景，谁进来都是主人）。
// 公网部署请务必设 BISCA_PASSWORD。
const LOGIN_PASSWORD = process.env.BISCA_PASSWORD || "";

// ── 小工具 ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file, value) {
  const tmp = file + "." + process.pid + "." + randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function isValidCode(code) {
  return typeof code === "string" && /^[A-Z0-9]{6}$/.test(code);
}

function randomCode() {
  let out = "";
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return out;
}

function escapeHtml(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// 极简登录页（只有一个密码框，样式内联，不依赖任何外部资源）。
function loginPageHtml(redirect) {
  const back = escapeHtml(redirect || "/daifugo/");
  return "<!DOCTYPE html>\n<html lang=\"zh\"><head><meta charset=\"UTF-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>大富豪 · 登录</title><style>" +
    "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
    "background:#0a0a0f;color:#e8e8f0;font:15px/1.6 system-ui,-apple-system,'Helvetica Neue',sans-serif}" +
    ".box{width:min(92vw,320px);padding:28px 24px;border:1px solid #26263a;border-radius:16px;background:#12121b}" +
    "h1{margin:0 0 4px;font-size:19px}p{margin:0 0 18px;font-size:13px;color:#8a8aa0}" +
    "input{width:100%;padding:11px 13px;border:1px solid #2c2c42;border-radius:10px;background:#0d0d16;" +
    "color:inherit;font-size:15px}input:focus{outline:none;border-color:#6c6cff}" +
    "button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:10px;background:#5b5bef;color:#fff;" +
    "font-size:15px;font-weight:600;cursor:pointer}button:disabled{opacity:.6;cursor:default}" +
    ".err{margin-top:12px;min-height:18px;font-size:13px;color:#ff7a90}" +
    "</style></head><body><form class=\"box\" id=\"f\">" +
    "<h1>大富豪</h1><p>输入房间密码进门</p>" +
    "<input id=\"p\" type=\"password\" autocomplete=\"current-password\" placeholder=\"密码\" autofocus>" +
    "<button type=\"submit\" id=\"b\">进门</button><div class=\"err\" id=\"e\"></div>" +
    "</form><script>\n" +
    "var back=" + JSON.stringify(redirect || "/daifugo/") + ";\n" +
    "document.getElementById('f').addEventListener('submit',function(ev){ev.preventDefault();" +
    "var b=document.getElementById('b'),e=document.getElementById('e');b.disabled=true;e.textContent='';" +
    "fetch('/daifugo/api/login',{method:'POST',headers:{'content-type':'application/json'}," +
    "credentials:'same-origin',body:JSON.stringify({password:document.getElementById('p').value})})" +
    ".then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})" +
    ".then(function(x){if(x.ok&&x.j.ok){location.href=back;}else{b.disabled=false;" +
    "e.textContent=(x.j&&x.j.error)||'密码不对';}},function(){b.disabled=false;e.textContent='连不上服务器';});" +
    "});\n</script></body></html>";
}

// 脱敏：座位 token / invite token 绝不出现在 state、视图或 SSE 里。
function stripTokens(value) {
  if (Array.isArray(value)) return value.map(stripTokens);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      if (k === "playerToken" || k === "inviteToken" || k === "token") continue;
      out[k] = stripTokens(value[k]);
    }
    return out;
  }
  return value;
}

function publicSeats(room) {
  return (room.seats || []).map(function (s) {
    return {
      playerId: s.playerId,
      name: s.name,
      color: s.color,
      isHost: !!s.isHost,
      isAI: !!s.isAI,
      agentId: s.agentId || null
    };
  });
}

function roomSummary(room) {
  const st = room.state || null;
  const phase = (st && st.phase) || null;
  const current = (st && st.current) || null;
  const seat = current ? (room.seats || []).find(function (s) { return s.playerId === current; }) : null;
  return {
    code: room.code,
    name: room.name,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt || room.createdAt,
    started: !!room.started,
    finished: phase === "game_over",
    phase: phase,
    round: (st && st.round) || 0,
    current: current,
    currentName: seat ? seat.name : null,
    playerCount: (room.seats || []).length,
    players: publicSeats(room),
    agentSeats: room.agentSeats || {},
    rules: room.rules || {},
    seq: st && typeof st.seq === "number" ? st.seq : 0
  };
}

// ── 自动 AI 玩家：prompt 排版 + CLI 单发 mover ──────────────────────────────

// 牌面排版（和 tools/daifugo.cjs 一套写法，纯给 prompt 看）
const SUIT_CN = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RANK_CN = { 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2" };
const COMBO_CN = {
  single: "单张", pair: "对子", double: "对子", triple: "三条", three: "三条",
  quad: "四条", four: "四条", set: "同数", kaidan: "阶梯", stair: "阶梯",
  stairs: "阶梯", sequence: "阶梯", straight: "阶梯"
};

function fmtCard(id) {
  const s = String(id || "");
  if (s[0] === "X") return "★JOKER";
  const suit = SUIT_CN[s[0]];
  const n = parseInt(s.slice(1), 10);
  if (!suit || !n) return s;
  return suit + (RANK_CN[n] || String(n));
}

function fmtCards(cards) {
  return (cards || []).map(fmtCard).join(" ");
}

// 强度：王恒最强；革命时普通牌取反。只用来给手牌排序。
function cardStrength(id, revolution) {
  const s = String(id || "");
  if (s[0] === "X") return 100;
  const n = parseInt(s.slice(1), 10) || 0;
  return revolution ? 18 - n : n;
}

function moveLine(m, i) {
  const label = "  p" + (i + 1) + " ";
  if (!m) return label + "?";
  if (m.type === "pass") return label + "过（pass）";
  if (m.type === "next_round") return label + "开下一轮";
  const head = m.type === "give_back" ? "回赠 " : (m.label ? m.label + " " : "");
  return label + head + fmtCards(m.cards);
}

// 给 AI 牌友看的牌桌简报。要点：手牌按强度排好、场面是谁的什么牌、合法招编号、最近闲聊。
function buildAutoPrompt(job) {
  const view = job.view || {};
  const me = (view.players || []).find(function (p) { return p.id === view.you; }) || {};
  const hand = (me.hand || []).slice().sort(function (a, b) {
    return cardStrength(b, view.revolution) - cardStrength(a, view.revolution);
  });
  const legal = job.legal || [];
  const lines = [];

  lines.push(String(job.persona || DEFAULT_AI_PERSONA)
    .split("{seatName}").join(job.seatName)
    .split("{gameName}").join(GAME_NAME));
  lines.push("");
  lines.push("你的手牌（" + hand.length + " 张，强 → 弱）：" + (hand.length ? fmtCards(hand) : "（空了）"));
  if (view.revolution) lines.push("⚡革命中：强度反转，3 最大、2 最小，王仍最强。");
  if (view.suitLock && view.suitLock.length) {
    lines.push("縛り中：本墩锁花色 " + view.suitLock.map(function (s) { return SUIT_CN[s] || s; }).join(""));
  }

  if (job.phase === "exchange") {
    const item = ((view.exchange && view.exchange.pending) || []).find(function (x) {
      return x && x.from === view.you && x.given === null;
    });
    const to = item ? ((view.players || []).find(function (p) { return p.id === item.to; }) || {}) : null;
    lines.push("换牌阶段：你是富方，要回赠 " + (item ? item.count : "几") + " 张给 " +
      ((to && to.name) || "对家") + "（一般给最弱的，留强牌给自己）。");
  } else if (!view.field) {
    lines.push("场上空着——你领出，出什么都行。");
  } else {
    const by = (view.players || []).find(function (p) { return p.id === view.field.by; });
    const kind = view.field.combo && view.field.combo.type
      ? (COMBO_CN[view.field.combo.type] || view.field.combo.type) : "";
    lines.push("场上：" + fmtCards(view.field.cards) + (kind ? "（" + kind + "）" : "") +
      " —— " + ((by && by.name) || "?") + " 出的。你要压过它，或者过。");
  }

  const others = (view.players || []).filter(function (p) { return p.id !== view.you; }).map(function (p) {
    const n = typeof p.handCount === "number" ? p.handCount : (p.hand || []).length;
    return p.name + " " + n + " 张" + (p.finished ? "（已出完）" : p.passed ? "（本墩已过）" : "");
  }).join(" / ");
  if (others) lines.push("其他人：" + others);

  lines.push("");
  lines.push("能出的招（只能从这里挑）：");
  legal.slice(0, AUTO_MOVE_CAP).forEach(function (m, i) { lines.push(moveLine(m, i)); });
  if (legal.length > AUTO_MOVE_CAP) {
    lines.push("  （还有 " + (legal.length - AUTO_MOVE_CAP) + " 招没列出来，只从 p1~p" + AUTO_MOVE_CAP + " 里选）");
  }

  const chat = job.chatTail || [];
  if (chat.length) {
    lines.push("");
    lines.push("最近的牌桌闲聊：");
    chat.forEach(function (c) { lines.push("  " + (c && c.name) + "：" + (c && c.text)); });
  }

  lines.push("");
  lines.push("打牌思路：大牌和王留到后手，能用小牌压就别甩大的；谁快出完了就该压死他；压不动就 pass 别硬送。");
  lines.push("只回一个 JSON 对象，前后不要任何别的字，形如 {\"move\":\"p2\",\"say\":\"可选的一句话\"}" +
    "（p2 换成你真正要出的那一招的编号）。");
  lines.push("move 只能是上面列出的编号（p1、p2……）或 \"pass\"（列表里有过这一招才能用）。");
  lines.push("say 是一句短嘴炮：可以毒舌调侃但别伤人，不超过 40 字。大多数轮次别说话（大概三轮开一次口就够）——" +
    "出大牌、八切、革命、被人压死这种时候才值得嘴一句；不想说就整个省掉 say 字段。");
  return lines.join("\n");
}

// 宽容解析：模型爱在 JSON 外面裹一层废话，取第一个 { 到最后一个 }。
function extractJsonObject(text) {
  const s = String(text || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try {
    const o = JSON.parse(s.slice(a, b + 1));
    return o && typeof o === "object" ? o : null;
  } catch (e) {
    return null;
  }
}

// 默认 mover：调本机已登录的 Claude Code CLI（env CLAUDE_BIN 可换可执行名）单发一次——
// 不续会话、不喂 system prompt、不给任何工具，就是个便宜的出牌脑子。
// 机器上没装 CLI（或调用失败）时这里返回 {error}，调用方会兜底出第一招，牌局不会卡住。
function cliMover(job) {
  return new Promise(function (resolve) {
    const args = [
      "-p", buildAutoPrompt(job),
      "--output-format", "json",
      "--model", job.modelKey,
      "--max-turns", "1",
      "--allowed-tools", ""
    ];
    const child = execFile(CLAUDE_BIN, args, {
      timeout: AUTO_CLI_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024
      // 环境直接继承 process.env：CLI 用的是当前用户自己的登录态
    }, function (err, stdout, stderr) {
      // CLI 的 stdin-3s 警告是噪音；err.message 带整条命令行（含完整 prompt），绝不外泄。
      const errText = String(stderr || "")
        .replace(/Warning: no stdin data received[^\n]*\n?/g, "").trim();
      if (err) {
        const reason = err.killed
          ? "AI 思考超时（>" + Math.round(AUTO_CLI_TIMEOUT_MS / 1000) + "s）"
          : ("claude 退出 " + (err.code != null ? "码 " + err.code : "信号 " + err.signal) +
             (errText ? " — " + errText.slice(-200) : ""));
        return resolve({ move: null, error: reason });
      }
      let result = "";
      try {
        const j = JSON.parse(stdout || "");
        result = j && typeof j.result === "string" ? j.result : String(stdout || "");
      } catch (e) {
        result = String(stdout || "");
      }
      const obj = extractJsonObject(result);
      if (!obj) return resolve({ move: null, error: "AI 没回出 JSON" });
      resolve({ move: obj.move, say: typeof obj.say === "string" ? obj.say : "" });
    });
    // execFile 默认 pipe stdin 且不关，claude 会等 3s 并打警告 —— 直接关掉
    try { child.stdin.end(); } catch (e) { /* 没 stdin 就算了 */ }
  });
}

// ── 叫外接 agent 座位（通用 webhook）────────────────────────────────────────
// agentId === "external" 的座位不由服务端驱动：轮到它时等外部程序走 X-Internal-Key 通道出牌。
// 配了 WAKE_WEBHOOK_URL（env 或 config.json 的 wake_webhook_url）就 POST 一个 JSON 通知，
// 用户自己把它桥接到任何通知 / agent 系统；没配就不叫，纯等 API。
const WAKE_TIMEOUT_MS = 30000;

// 外接 agent 座位的 agent_id：这个座位属于"人肉/外部程序"，服务端只负责叫、不替它出牌。
const EXTERNAL_AGENT_ID = "external";

// 牌桌简报（跟着 webhook 一起送出去，收到通知的 agent 不用再拉一次 view 就能出牌）
function buildTurnBriefing(job) {
  const view = job.view || {};
  const legal = job.legal || [];
  const me = (view.players || []).find(function (p) { return p.id === view.you; }) || {};
  const hand = (me.hand || []).slice().sort(function (a, b) {
    return cardStrength(b, view.revolution) - cardStrength(a, view.revolution);
  });
  const lines = [];
  lines.push("手牌(" + hand.length + "张,强→弱): " + (hand.length ? fmtCards(hand) : "(空)"));
  if (view.revolution) lines.push("⚡革命中:强弱反转,3最大2最小,王不变。");
  const f = view.field;
  if (f) {
    const by = (view.players || []).find(function (p) { return p.id === f.by; });
    lines.push("场上: " + fmtCards(f.cards) + " —— " + (by ? by.name : "?") + " 出的,要压过或 pass");
  } else {
    lines.push(job.phase === "exchange" ? "换牌阶段:你是富方,挑牌回赠" : "场上空着,你领出");
  }
  lines.push("其他人: " + (view.players || []).filter(function (p) { return p.id !== view.you; })
    .map(function (p) {
      return p.name + " " + (p.handCount != null ? p.handCount : "?") + "张" + (p.passed ? "(已过)" : "");
    }).join(" / "));
  const cap = 15;
  legal.slice(0, cap).forEach(function (m, i) { lines.push(moveLine(m, i)); });
  if (legal.length > cap) lines.push("(还有 " + (legal.length - cap) + " 招没列,完整列表走 agent view 接口)");
  const chats = (job.chatTail || []).map(function (c) { return "  " + c.name + "：" + c.text; });
  if (chats.length) lines.push("最近闲聊:\n" + chats.join("\n"));
  return lines.join("\n");
}

// webhook 的 body：谁、哪间房、什么局面、能出什么招。字段稳定，随便你怎么桥接。
function wakePayload(job) {
  const legal = job.legal || [];
  const payload = {
    kind: job.kind,                       // "turn" | "chat"
    code: job.code,
    roomName: job.roomName,
    game: "daifugo",
    gameName: GAME_NAME,
    phase: job.phase || null,
    seatName: job.seatName || null,
    agentId: EXTERNAL_AGENT_ID
  };
  if (job.kind === "chat") {
    payload.chatLines = job.chatLines || [];
  } else {
    payload.briefing = buildTurnBriefing(job);
    payload.moveLines = legal.slice(0, 15).map(moveLine);
    payload.chatLines = (job.chatTail || []).map(function (c) { return c.name + "：" + c.text; });
  }
  return payload;
}

// 默认 waker：配了 webhook 就 POST 过去，没配就什么都不做（外部程序自己轮询 agent 接口）。
function makeWebhookWaker(getUrl) {
  return async function (job) {
    const url = getUrl();
    if (!url) return;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, WAKE_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(wakePayload(job)),
        signal: controller.signal
      });
      if (!res.ok) throw new Error("webhook HTTP " + res.status);
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── 服务工厂 ────────────────────────────────────────────────────────────────

function createServer(options) {
  const opts = options || {};
  const dataDir = opts.dataDir || process.env.BISCA_DATA_DIR || path.join(__dirname, "data");
  const roomsDir = path.join(dataDir, "rooms");
  const configFile = path.join(dataDir, "config.json");
  const publicDir = opts.publicDir || path.join(__dirname, "public");
  // 引擎默认吃同目录 engine.cjs；测试注入 stub，也可用 DAIFUGO_ENGINE 换一套规则实现。
  const enginePath = opts.enginePath || process.env.DAIFUGO_ENGINE || path.join(__dirname, "engine.cjs");
  const engine = opts.engine || require(enginePath);

  ensureDir(roomsDir);

  // config.json 先落地（cookie secret / internal key 首启即生成），后面全靠它。
  const config = ensureConfig();
  const cookieSecret = opts.cookieSecret || config.cookie_secret;
  // 登录密码：默认取 env BISCA_PASSWORD，opts.password 供测试/嵌入时覆盖。空串 = open mode。
  const loginPassword = typeof opts.password === "string" ? opts.password : LOGIN_PASSWORD;

  const rooms = new Map(); // code -> room（内存缓存，盘上是真相）
  const sseClients = new Map(); // code -> Set<{res, playerId}>
  const allSse = new Set();

  // ── 认证 ──
  // 设了 BISCA_PASSWORD = 走登录页签发 bisca_auth cookie；没设 = open mode，人人 owner。

  function signCookie(value) {
    return value + "." + createHmac("sha256", cookieSecret).update(value).digest("base64url");
  }

  function verifyCookie(signed) {
    if (!signed || !signed.includes(".")) return null;
    const dot = signed.lastIndexOf(".");
    const value = signed.substring(0, dot);
    const expected = signCookie(value);
    const a = Buffer.from(expected);
    const b = Buffer.from(signed);
    if (a.length !== b.length) return null;
    return timingSafeEqual(a, b) ? value : null;
  }

  function parseCookies(req) {
    const cookies = {};
    const header = req.headers.cookie || "";
    header.split(";").forEach(function (c) {
      const parts = c.trim().split("=");
      if (parts.length >= 2) cookies[parts[0]] = parts.slice(1).join("=");
    });
    return cookies;
  }

  function checkCookie(req) {
    const val = verifyCookie(parseCookies(req)[COOKIE_NAME]);
    if (!val) return false;
    if (val === "authenticated") return true;
    const i = val.indexOf(".");
    if (i === -1 || val.substring(0, i) !== "authenticated") return false;
    const issuedAt = parseInt(val.substring(i + 1), 10);
    if (!issuedAt || Date.now() - issuedAt > COOKIE_MAX_AGE_MS) return false;
    return true;
  }

  // ── config.json（热读，缺省自动初始化）──

  function loadConfig() {
    const cfg = readJsonSafe(configFile, null);
    if (!cfg || typeof cfg !== "object") return {};
    return cfg;
  }

  // 首次启动没有 config.json（或缺字段）就生成写回：
  // cookie_secret = 本机登录 cookie 的签名密钥；internal_key = bot 通道钥匙。两个都别外传。
  function ensureConfig() {
    const cfg = readJsonSafe(configFile, null);
    const next = cfg && typeof cfg === "object" ? cfg : {};
    let dirty = false;
    if (typeof next.allow_guests !== "boolean") { next.allow_guests = false; dirty = true; }
    if (typeof next.cookie_secret !== "string" || next.cookie_secret.length < 32) {
      next.cookie_secret = randomBytes(32).toString("hex");
      dirty = true;
    }
    if (typeof next.internal_key !== "string" || next.internal_key.length < 16) {
      next.internal_key = randomBytes(24).toString("hex");
      dirty = true;
    }
    if (!next.defaults || typeof next.defaults !== "object") { next.defaults = {}; dirty = true; }
    for (const k of RULE_KEYS) {
      if (typeof next.defaults[k] !== "boolean") { next.defaults[k] = DEFAULT_RULES[k]; dirty = true; }
    }
    if (dirty) {
      try {
        writeJsonAtomic(configFile, next);
      } catch (e) {
        console.warn("[daifugo] config.json 写入失败：" + (e && e.message));
      }
    }
    return next;
  }

  function guestsAllowed() {
    return loadConfig().allow_guests === true;
  }

  function internalKey() {
    const k = loadConfig().internal_key;
    return typeof k === "string" && k.length >= 16 ? k : null;
  }

  // 轮到外接 agent 座位时通知谁（env 优先，其次 config.json）。没配就不叫。
  function wakeWebhookUrl() {
    const u = process.env.WAKE_WEBHOOK_URL || loadConfig().wake_webhook_url;
    return typeof u === "string" && /^https?:\/\//i.test(u) ? u : null;
  }

  function checkInternalKey(req) {
    const given = req.headers["x-internal-key"];
    const want = internalKey();
    if (!want || typeof given !== "string" || !given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(want);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // rules：只认已知开关，其余丢掉；config.defaults 打底。
  function resolveRules(input) {
    const defaults = loadConfig().defaults || {};
    const out = {};
    for (const k of RULE_KEYS) {
      out[k] = typeof defaults[k] === "boolean" ? defaults[k] : DEFAULT_RULES[k];
      if (input && typeof input[k] === "boolean") out[k] = input[k];
    }
    return out;
  }

  // ── 房间存取 ──

  function roomPath(code) {
    return path.join(roomsDir, code + ".json");
  }

  function loadRoom(code) {
    if (!isValidCode(code)) return null;
    if (rooms.has(code)) return rooms.get(code);
    const room = readJsonSafe(roomPath(code), null);
    if (!room || room.code !== code) return null;
    rooms.set(code, room);
    scheduleAuto(room); // 懒加载：这房第一次被摸到时也看一眼欠不欠 AI 出牌
    return room;
  }

  function saveRoom(room) {
    room.updatedAt = Date.now();
    writeJsonAtomic(roomPath(room.code), room);
    rooms.set(room.code, room);
  }

  function listRoomCodes() {
    let files = [];
    try {
      files = fs.readdirSync(roomsDir);
    } catch (e) {
      return [];
    }
    return files.filter(function (f) {
      return f.endsWith(".json") && isValidCode(f.slice(0, -5));
    }).map(function (f) {
      return f.slice(0, -5);
    });
  }

  function listRooms(limit) {
    return listRoomCodes()
      .map(function (c) { return loadRoom(c); })
      .filter(Boolean)
      .sort(function (a, b) { return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0); })
      .slice(0, limit || 20);
  }

  function findRoomByInvite(token) {
    if (!token || typeof token !== "string") return null;
    for (const code of listRoomCodes()) {
      const room = loadRoom(code);
      if (room && room.inviteToken && room.inviteToken === token) return room;
    }
    return null;
  }

  // 启动清理：rooms/ 超 200 个文件时删最旧的"已结束"房间
  //（phase=game_over，或未 started 且超 7 天）。
  function cleanupRooms() {
    const codes = listRoomCodes();
    if (codes.length <= MAX_ROOM_FILES) return 0;
    const now = Date.now();
    const entries = [];
    for (const code of codes) {
      const file = roomPath(code);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch (e) {
        continue;
      }
      const room = readJsonSafe(file, null);
      if (!room) continue;
      const finished = !!(room.state && room.state.phase === "game_over");
      const stale = !room.started && now - (room.createdAt || mtime) > STALE_ROOM_MS;
      if (finished || stale) entries.push({ code, file, mtime });
    }
    entries.sort(function (a, b) { return a.mtime - b.mtime; });
    let remaining = codes.length;
    let removed = 0;
    for (const e of entries) {
      if (remaining <= MAX_ROOM_FILES) break;
      try {
        fs.unlinkSync(e.file);
        rooms.delete(e.code);
        remaining--;
        removed++;
      } catch (err) { /* 删不掉就算了 */ }
    }
    if (removed) console.log("[daifugo] cleanup removed " + removed + " finished room file(s)");
    return removed;
  }

  // ── 分视角视图 ──

  // 引擎没导出 viewFor 时的保底脱敏（并行开发期的安全网）：只留自己的手牌。
  function fallbackView(state, playerId) {
    const view = JSON.parse(JSON.stringify(state));
    if (Array.isArray(view.players)) {
      view.players = view.players.map(function (p) {
        if (p && p.id === playerId) return p;
        const copy = Object.assign({}, p);
        copy.handCount = Array.isArray(p && p.hand) ? p.hand.length : (p && p.handCount) || 0;
        delete copy.hand;
        return copy;
      });
    }
    if (view.exchange && Array.isArray(view.exchange.pending)) {
      view.exchange = Object.assign({}, view.exchange, {
        pending: view.exchange.pending.map(function (x) {
          if (x && (x.from === playerId || x.to === playerId)) return x;
          const copy = Object.assign({}, x);
          copy.given = null;
          return copy;
        })
      });
    }
    return view;
  }

  function viewOf(room, playerId) {
    if (!room.state) return null;
    let view;
    if (engine && typeof engine.viewFor === "function") {
      view = engine.viewFor(room.state, playerId || null);
    } else {
      view = fallbackView(room.state, playerId || null);
    }
    return stripTokens(view);
  }

  function legalOf(room, playerId) {
    if (!room.state || !playerId) return [];
    if (!engine || typeof engine.legalMoves !== "function") return [];
    try {
      const moves = engine.legalMoves(room.state, playerId);
      return Array.isArray(moves) ? stripTokens(moves) : [];
    } catch (e) {
      return [];
    }
  }

  function seatByToken(room, token) {
    if (!token || typeof token !== "string") return null;
    return (room.seats || []).find(function (s) { return s.playerToken === token; }) || null;
  }

  function seatByAgent(room, agentId) {
    const pid = (room.agentSeats || {})[agentId];
    if (!pid) return null;
    return (room.seats || []).find(function (s) { return s.playerId === pid; }) || null;
  }

  function isYourTurn(room, playerId) {
    const st = room.state;
    if (!st || !playerId) return false;
    if (st.phase === "exchange") {
      // pending: {from: 富方(欠回赠), to: 贫方, done, taken, given} —— 欠动作的是 from
      const pending = (st.exchange && st.exchange.pending) || [];
      return pending.some(function (x) { return x && x.from === playerId && !x.done; });
    }
    return st.current === playerId;
  }

  // ── 牌桌聊天 ──

  // 聊天不涉及手牌，所有视角看同一份，只留最近 200 条。
  function pushChat(room, by, name, text) {
    if (!Array.isArray(room.chat)) room.chat = [];
    room.chat.push({ ts: Date.now(), by: by || null, name: name, text: text });
    if (room.chat.length > CHAT_KEEP) room.chat = room.chat.slice(-CHAT_KEEP);
    return room.chat[room.chat.length - 1];
  }

  function chatTail(room) {
    return (room.chat || []).slice(-CHAT_TAIL);
  }

  // 文本校验（两条通道共用）：空 / 超长都是 400
  function normChatText(raw) {
    const text = String(raw === undefined || raw === null ? "" : raw).trim();
    if (!text) return { error: "说点什么吧，空消息发不出去" };
    if (text.length > CHAT_MAX_LEN) return { error: "一条最多 " + CHAT_MAX_LEN + " 个字，太长了" };
    return { text: text };
  }

  // ── SSE 广播（分视角）──

  function statePayload(room, playerId) {
    return {
      code: room.code,
      name: room.name,
      started: !!room.started,
      closed: !!room.closed,
      rules: room.rules || {},
      seats: publicSeats(room),
      you: playerId || null,
      yourTurn: isYourTurn(room, playerId),
      seq: room.state && typeof room.state.seq === "number" ? room.state.seq : 0,
      chat: chatTail(room),
      state: viewOf(room, playerId || null)
    };
  }

  // 每条连接按自己的 playerId 单独算视图（同视角的连接共用一次序列化）。
  function broadcast(room) {
    // 统一的"变更后"钩子：任何一步落地都顺手看一眼是不是轮到自动 AI / 外接 agent 了。
    scheduleAuto(room);
    scheduleExternalWake(room);
    const set = sseClients.get(room.code);
    if (!set || !set.size) return;
    const cache = new Map();
    for (const client of set) {
      const pid = client.playerId || null;
      const key = pid || "";
      if (!cache.has(key)) {
        cache.set(key, "event: state\ndata: " + JSON.stringify(statePayload(room, pid)) + "\n\n");
      }
      try {
        client.res.write(cache.get(key));
      } catch (e) { /* 断开的客户端由 close 事件清理 */ }
    }
  }

  // ── 自动 AI 玩家驱动器 ──
  // 座位是 AI 且 agent_id 在 AUTO_MODELS 里 = 服务端自己起 claude CLI 替它出牌。
  // 触发点只有一个：broadcast（任何状态变动都会走）+ 懒加载房间的首次落缓存 + 启动扫描。

  const aiMover = typeof opts.aiMover === "function" ? opts.aiMover : cliMover;
  const autoBusy = new Set();   // 每房一把锁，防并发重入
  const autoTimers = new Set(); // stop() 时清掉还没触发的定时器

  // ── 轮到外接 agent 座位：按需 webhook 通知一声 ─────────────────────────────
  // 每个"回合身份"（房号:seq:phase）只叫一次，聊天/重连引起的 broadcast 不会重复轰炸。
  // config.json 里 wake_external_on_turn:false 可整体关掉。
  const externalWaker = typeof opts.externalWaker === "function"
    ? opts.externalWaker
    : makeWebhookWaker(wakeWebhookUrl);
  const externalWokenKeys = new Set();
  const EXTERNAL_WAKE_DELAY_MS = typeof opts.externalWakeDelayMs === "number" ? opts.externalWakeDelayMs : 3000;

  function scheduleExternalWake(room) {
    if (!room || !room.state || room.closed) return;
    const cfg = readJsonSafe(configFile, null) || {};
    if (cfg.wake_external_on_turn === false) return;
    const seat = pendingExternalSeat(room);
    if (!seat) return;
    const key = room.code + ":" + room.state.seq + ":" + room.state.phase;
    if (externalWokenKeys.has(key)) return;
    externalWokenKeys.add(key);
    if (externalWokenKeys.size > 500) { externalWokenKeys.clear(); externalWokenKeys.add(key); }
    const code = room.code;
    const roomName = room.name || code;
    const phase = room.state.phase;
    const t = setTimeout(function () {
      autoTimers.delete(t);
      // 通知前最后确认一次：这 3 秒里可能有人替它动了 / 局面翻页了
      const fresh = loadRoom(code);
      const still = fresh && pendingExternalSeat(fresh);
      if (!still || still.playerId !== seat.playerId ||
          !fresh.state || (fresh.code + ":" + fresh.state.seq + ":" + fresh.state.phase) !== key) return;
      Promise.resolve(externalWaker({
        kind: "turn", code: code, roomName: roomName, phase: phase, seatName: seat.name,
        // 简报直接带进通知：收到的 agent 不用再拉一次 view 就能出牌
        view: viewOf(fresh, seat.playerId),
        legal: legalOf(fresh, seat.playerId),
        chatTail: (fresh.chat || []).slice(-3)
      }))
        .catch(function (e) {
          console.warn("[daifugo] " + code + " 叫外接 agent 出牌失败：" + (e && e.message));
        });
    }, EXTERNAL_WAKE_DELAY_MS);
    if (typeof t.unref === "function") t.unref();
    autoTimers.add(t);
  }

  // ── 牌桌聊天有新话，外接 agent 不在回合上也捎个信（防轰炸：去抖 + 冷却）────
  // 每次唤醒对外部 agent 都是一整个回合的开销，不能一句一叫。
  // 去抖:最后一条人话后等 10s 再叫(连发的话攒一起);冷却:每房两次聊天唤醒至少隔 120s。
  const CHAT_WAKE_DEBOUNCE_MS = typeof opts.chatWakeDebounceMs === "number" ? opts.chatWakeDebounceMs : 10000;
  const CHAT_WAKE_COOLDOWN_MS = typeof opts.chatWakeCooldownMs === "number" ? opts.chatWakeCooldownMs : 120000;
  const chatWakeState = new Map(); // code → {timer, lastAt}

  function scheduleExternalChatWake(room) {
    if (!room || room.closed) return;
    const cfg = readJsonSafe(configFile, null) || {};
    if (cfg.wake_external_on_turn === false) return;
    const extSeat = (room.seats || []).find(function (s) { return s.agentId === EXTERNAL_AGENT_ID; });
    if (!extSeat) return;
    if (pendingExternalSeat(room)) return; // 轮到它,turn wake 会带上聊天,不重复叫
    const code = room.code;
    const st = chatWakeState.get(code) || {};
    if (st.timer) return; // 已在去抖窗口里,后续消息自然攒进去
    const wait = Math.max(CHAT_WAKE_DEBOUNCE_MS, (st.lastAt || 0) + CHAT_WAKE_COOLDOWN_MS - Date.now());
    const t = setTimeout(function () {
      autoTimers.delete(t);
      const s2 = chatWakeState.get(code) || {};
      s2.timer = null;
      s2.lastAt = Date.now();
      chatWakeState.set(code, s2);
      const fresh = loadRoom(code);
      if (!fresh || fresh.closed) return;
      const seat = (fresh.seats || []).find(function (s) { return s.agentId === EXTERNAL_AGENT_ID; });
      if (!seat) return;
      if (pendingExternalSeat(fresh)) return; // 这会儿轮到它了,让 turn wake 管
      const lines = (fresh.chat || []).slice(-5)
        .filter(function (c) { return c.by !== seat.playerId; })
        .map(function (c) { return "  " + c.name + "：" + c.text; });
      if (!lines.length) return;
      Promise.resolve(externalWaker({
        kind: "chat", code: code, roomName: fresh.name || code,
        phase: fresh.state && fresh.state.phase, seatName: seat.name, chatLines: lines
      })).catch(function (e) {
        console.warn("[daifugo] " + code + " 聊天捎信给外接 agent 失败：" + (e && e.message));
      });
    }, wait);
    if (typeof t.unref === "function") t.unref();
    autoTimers.add(t);
    st.timer = t;
    chatWakeState.set(code, st);
  }

  // 现在欠动作的 playerId 列表（playing=当前出牌者；exchange=欠回赠的富方，可能多个）
  function pendingOwedIds(room) {
    const st = room && room.state;
    if (!room || !room.started || !st) return [];
    if (st.phase === "playing") return st.current ? [st.current] : [];
    if (st.phase === "exchange") {
      return ((st.exchange && st.exchange.pending) || [])
        .filter(function (it) { return it && it.given === null; })
        .map(function (it) { return it.from; });
    }
    return []; // round_over / game_over：下一轮由人点，机器不抢
  }

  function pendingSeatWhere(room, match) {
    for (const pid of pendingOwedIds(room)) {
      const seat = (room.seats || []).find(function (s) { return s.playerId === pid; });
      if (seat && seat.isAI && match(seat)) return seat;
    }
    return null;
  }

  // 欠动作的人里，有没有需要自动驱动（CLI AI）的座位？没有返回 null。
  function pendingAutoSeat(room) {
    return pendingSeatWhere(room, function (s) { return !!AUTO_MODELS[s.agentId]; });
  }

  // 欠动作的是不是外接 agent 座位？轮到它就按需 webhook 通知一声。
  function pendingExternalSeat(room) {
    return pendingSeatWhere(room, function (s) { return s.agentId === EXTERNAL_AGENT_ID; });
  }

  function scheduleAuto(room) {
    if (!room || room.closed || autoBusy.has(room.code)) return;
    const seat = pendingAutoSeat(room);
    if (!seat) return;
    const code = room.code;
    autoBusy.add(code);
    const timer = setTimeout(function () {
      autoTimers.delete(timer);
      runAutoTurn(code, seat.playerId).catch(function (e) {
        console.error("[daifugo] " + code + " 自动出牌异常：" + (e && e.message));
        return false;
      }).then(function (acted) {
        autoBusy.delete(code);
        if (!acted) return; // 这一手没落地就别再排，绝不能空转烧 CLI
        const fresh = loadRoom(code);
        if (fresh) scheduleAuto(fresh); // 下一个欠动作的可能还是自动座位
      });
    }, AUTO_DELAY_MS);
    if (typeof timer.unref === "function") timer.unref();
    autoTimers.add(timer);
  }

  // 'pN' → 第 N 招（1 起）；'pass' → 过。对不上返回 null，交给兜底。
  function resolveAutoMove(move, legal) {
    if (typeof move !== "string") return null;
    const s = move.trim().toLowerCase();
    if (s === "pass") {
      return legal.find(function (m) { return m && m.type === "pass"; }) || null;
    }
    const m = s.match(/^p(\d+)$/);
    if (!m) return null;
    const idx = parseInt(m[1], 10) - 1;
    return idx >= 0 && idx < legal.length ? legal[idx] : null;
  }

  // 真正走一手：问 AI → 落动作 → 顺带把嘴炮发进牌桌聊天。返回是否真出了牌。
  async function runAutoTurn(code, playerId) {
    const room = loadRoom(code);
    if (!room) return false;
    const seat = (room.seats || []).find(function (s) { return s.playerId === playerId; });
    if (!seat) return false;
    // 等这 1.2 秒的功夫局面可能已经被人推着走了，重新确认还欠他动作
    const still = pendingAutoSeat(room);
    if (!still || still.playerId !== playerId) return false;

    const legal = legalOf(room, playerId);
    if (!legal.length) {
      console.warn("[daifugo] " + code + " " + seat.name + " 没有合法招，自动出牌跳过");
      return false;
    }

    let picked = null;
    let say = "";
    let why = "";
    try {
      const out = await aiMover({
        seatName: seat.name,
        modelKey: AUTO_MODELS[seat.agentId],
        persona: typeof loadConfig().ai_persona === "string" ? loadConfig().ai_persona : null,
        view: viewOf(room, playerId),
        legal: legal,
        chatTail: (room.chat || []).slice(-6),
        phase: room.state.phase
      });
      picked = resolveAutoMove(out && out.move, legal);
      if (picked && out && typeof out.say === "string") say = out.say.trim();
      if (!picked) why = (out && out.error) || ("看不懂的回答：" + JSON.stringify(out && out.move));
    } catch (e) {
      why = (e && e.message) || "mover 抛错";
    }
    if (!picked) {
      // 非法 / 解析失败 / CLI 挂了 —— 兜底出第一招，闭嘴照打
      console.warn("[daifugo] " + code + " " + seat.name + " 自动出牌兜底（" + why + "）");
      picked = legal[0];
      say = "";
    }

    let out = applyCore(room, seat, picked);
    if (out.error && picked !== legal[0]) {
      // 引擎说非法（局面对不上了）→ 再兜底一次
      console.warn("[daifugo] " + code + " " + seat.name + " 这招被引擎拒了（" + out.error + "），改出第一招");
      out = applyCore(room, seat, legal[0]);
      say = "";
    }
    if (out.error) {
      console.error("[daifugo] " + code + " " + seat.name + " 自动出牌失败，放弃这一手：" + out.error);
      return false;
    }
    if (say) pushChat(room, seat.playerId, seat.name, say.slice(0, AUTO_SAY_MAX));
    saveRoom(room);
    broadcast(room);
    return true;
  }

  // 启动扫描：重启前正轮到自动 AI 的局，接着走完。
  function resumeAuto() {
    for (const code of listRoomCodes()) {
      let room = null;
      try {
        room = loadRoom(code);
      } catch (e) { /* 坏文件跳过 */ }
      if (room && room.started && room.state) {
        scheduleAuto(room);
        scheduleExternalWake(room);
      }
    }
  }

  // ── express ──

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));

  // 主题 + 字体：本地静态，挂在认证门之前（登录页自己也要用）。
  // 两套挂载点：裸路径给直连，/daifugo 前缀给按路径分流的反代。
  const themeStatic = express.static(ASSETS_DIR, { maxAge: STATIC_MAX_AGE });
  const fontStatic = express.static(FONTS_DIR, { maxAge: STATIC_MAX_AGE });
  ["", "/daifugo"].forEach(function (prefix) {
    app.use(prefix + "/assets-theme", themeStatic);
    app.use(prefix + "/fonts", fontStatic);
  });

  // 认证门：cookie = owner 级；X-Internal-Key = agent 级（视同 owner）；
  // allow_guests 开启时合法 invite = 该房间的 guest。
  // 没设 BISCA_PASSWORD = open mode：不查 cookie，直接 owner。
  function deny(res, req) {
    // 浏览器直接打开页面（cookie 过期/未登录）→ 跳本服务自己的登录页；
    // API/fetch 请求照旧 JSON 403。
    if (req && req.method === "GET" && String(req.headers.accept || "").includes("text/html")) {
      return res.redirect("/daifugo/login?r=" + encodeURIComponent(req.originalUrl || "/daifugo/"));
    }
    return res.status(403).json({ error: "未授权：需要登录，或有效的房间邀请链接" });
  }

  // 登录页 / 登录接口挂在 authGate 之前注册，所以天然不受门禁管。

  // 反代后面（cloudflared / nginx）判 HTTPS，决定 cookie 要不要 Secure
  function isSecureReq(req) {
    if (req.secure) return true;
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    return proto.toLowerCase() === "https";
  }

  app.get("/daifugo/login", function (req, res) {
    if (!loginPassword) return res.redirect("/daifugo/"); // open mode 没有登录这回事
    // 回跳地址只收本站绝对路径（"//evil.com" 是协议相对 URL，得挡掉）
    const raw = typeof req.query.r === "string" ? req.query.r : "";
    const r = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/daifugo/";
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.send(loginPageHtml(r));
  });

  app.post("/daifugo/api/login", function (req, res) {
    if (!loginPassword) return res.json({ ok: true, open: true });
    const given = String((req.body && req.body.password) || "");
    const a = Buffer.from(given);
    const b = Buffer.from(loginPassword);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(403).json({ error: "密码不对" });
    }
    const value = "authenticated." + Date.now();
    res.set("Set-Cookie", COOKIE_NAME + "=" + signCookie(value) +
      "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.floor(COOKIE_MAX_AGE_MS / 1000) +
      (isSecureReq(req) ? "; Secure" : ""));
    res.json({ ok: true });
  });

  // 静态子资源（js/css/图/字体/engine.js）没有任何秘密，直接放行——
  // 不然访客拿邀请链接能打开页面，script/css 子请求不带 invite 全 403（monopoly 老坑）。
  // .html 页面故意不豁免：页面请求本身会带 ?invite= 或 cookie，没凭证就该去登录页。
  const PUBLIC_ASSET_RE = /\.(js|css|map|png|jpg|jpeg|svg|webp|ico|woff2?)$/i;

  app.use(function authGate(req, res, next) {
    if (req.method === "GET" && PUBLIC_ASSET_RE.test(req.path || "")) {
      req.authLevel = "asset";
      return next();
    }
    if (checkInternalKey(req)) {
      req.authLevel = "agent";
      return next();
    }
    if (!loginPassword || checkCookie(req)) {
      req.authLevel = "owner";
      return next();
    }
    if (guestsAllowed()) {
      const token = req.query.invite || req.headers["x-invite-token"];
      const room = findRoomByInvite(typeof token === "string" ? token : null);
      if (room) {
        req.authLevel = "guest";
        req.inviteRoom = room.code;
        return next();
      }
    }
    return deny(res, req);
  });

  // guest 只能摸自己 invite 对应的那个房间
  function scopeGuard(req, res, next) {
    if (req.authLevel === "guest" && req.inviteRoom !== req.params.code) return deny(res);
    next();
  }

  // agent 通道只认 X-Internal-Key（key 错/没带 = 403，不给 cookie 兜底）
  function agentGuard(req, res, next) {
    if (req.authLevel !== "agent") {
      return res.status(403).json({ error: "内部通道需要正确的 X-Internal-Key" });
    }
    next();
  }

  function requireRoom(req, res) {
    const room = loadRoom(req.params.code);
    if (!room) {
      res.status(404).json({ error: "房间不存在" });
      return null;
    }
    return room;
  }

  // 建座位（人类和 agent 共用）
  function addSeat(room, name, extra) {
    const seat = Object.assign({
      playerId: "p" + (room.seats.length + 1),
      playerToken: randomBytes(16).toString("hex"),
      name: name,
      color: SEAT_COLORS[room.seats.length % SEAT_COLORS.length],
      isHost: room.seats.length === 0,
      isAI: false
    }, extra || {});
    room.seats.push(seat);
    return seat;
  }

  // 动作核心（不认识 res，自动 AI 也用它）：只推引擎和 room.state，
  // 失败返回 {error}，落盘/广播交给调用方。
  function applyCore(room, seat, action) {
    if (!room.started || !room.state) return { error: "牌局还没开始" };
    if (!action || !action.type) return { error: "缺少动作类型" };
    let out;
    try {
      out = engine.apply(room.state, seat.playerId, action);
    } catch (e) {
      return { error: e && e.message ? e.message : "非法动作" };
    }
    const nextState = out && out.state ? out.state : out;
    room.state = nextState;
    return { state: nextState, events: (out && out.events) || [] };
  }

  // HTTP 版：出牌/过/回赠等动作的共同落地——apply → 落盘 → 分视角广播
  function applyAction(room, seat, action, res) {
    const out = applyCore(room, seat, action);
    if (out.error) {
      res.status(400).json({ error: out.error });
      return null;
    }
    saveRoom(room);
    broadcast(room);
    return out;
  }

  const api = express.Router();

  // 可邀请的 AI 玩家名录（agent_id → 桌面显示名）。
  // external = 外接 agent 座位（服务端不替它出牌，等外部程序走 X-Internal-Key 通道动手）；
  // 其余三个在 AUTO_MODELS 里，服务端起 claude CLI 替它们出牌。
  const AI_ROSTER = {
    external: "外接 Agent",
    opus: "AI·Opus",
    sonnet: "AI·Sonnet",
    haiku: "AI·Haiku"
  };

  // 建房时勾选的 AI，等房主（第一个人类）入座后自动落座——
  // 不能在建房时就坐，否则 seats[0] 的 isHost 会落在 AI 头上。
  function seatPendingInvites(room) {
    if (!Array.isArray(room.aiInvites) || !room.aiInvites.length) return false;
    let changed = false;
    for (const agentId of room.aiInvites) {
      if (!AI_ROSTER[agentId]) continue;
      if (!room.agentSeats) room.agentSeats = {};
      if (seatByAgent(room, agentId)) continue;             // 幂等：已在座
      if ((room.seats || []).length >= MAX_SEATS) break;
      const seat = addSeat(room, AI_ROSTER[agentId], { isAI: true, agentId: agentId });
      room.agentSeats[agentId] = seat.playerId;
      changed = true;
    }
    room.aiInvites = [];
    return changed;
  }

  // POST /daifugo/api/rooms {name, rules?, ai_players?} → {code, inviteToken}
  api.post("/rooms", function (req, res) {
    if (req.authLevel === "guest") return deny(res);
    const body = req.body || {};
    const name = String(body.name || "").trim().slice(0, 24) || "未命名房间";
    const aiInvites = Array.isArray(body.ai_players)
      ? body.ai_players.filter(function (id, i, arr) { return AI_ROSTER[id] && arr.indexOf(id) === i; })
      : [];
    let code = null;
    for (let i = 0; i < 30; i++) {
      const c = randomCode();
      if (!fs.existsSync(roomPath(c))) { code = c; break; }
    }
    if (!code) return res.status(500).json({ error: "房间号生成失败，请重试" });
    const room = {
      code: code,
      name: name,
      createdAt: Date.now(),
      inviteToken: randomBytes(16).toString("hex"),
      rules: resolveRules(body.rules),
      seats: [],
      agentSeats: {},
      aiInvites: aiInvites,
      started: false,
      state: null
    };
    saveRoom(room);
    res.json({ ok: true, code: room.code, name: room.name, rules: room.rules, inviteToken: room.inviteToken });
  });

  // GET /daifugo/api/rooms → 大厅列表（近 20 个）+ 服务端规则默认值（前端建房面板照它摆开关）
  api.get("/rooms", function (req, res) {
    if (req.authLevel === "guest") return deny(res);
    res.json({ ok: true, rooms: listRooms(20).map(roomSummary), defaults: resolveRules(null) });
  });

  // POST /daifugo/api/rooms/:code/join {name, playerToken?} → {playerId, playerToken}
  api.post("/rooms/:code/join", scopeGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const body = req.body || {};

    // 带旧 token 回来 = 复座（刷新/断线重进）
    if (body.playerToken) {
      const seat = seatByToken(room, body.playerToken);
      if (seat) {
        return res.json({
          ok: true, code: room.code, playerId: seat.playerId, playerToken: seat.playerToken,
          name: seat.name, color: seat.color, isHost: !!seat.isHost, rejoined: true
        });
      }
    }

    if (room.started) return res.status(400).json({ error: "牌局已开始，无法入座" });
    if ((room.seats || []).length >= MAX_SEATS) return res.status(400).json({ error: "房间已满（最多 4 人）" });

    const name = String(body.name || "").trim().slice(0, 16) || ("玩家" + (room.seats.length + 1));
    const seat = addSeat(room, name, null);
    seatPendingInvites(room);
    saveRoom(room);
    broadcast(room);
    res.json({
      ok: true, code: room.code, playerId: seat.playerId, playerToken: seat.playerToken,
      name: seat.name, color: seat.color, isHost: seat.isHost, rejoined: false
    });
  });

  // POST /daifugo/api/rooms/:code/start {playerToken} — 仅房主，≥2 人
  api.post("/rooms/:code/start", scopeGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const token = (req.body && req.body.playerToken) || "";
    const host = (room.seats || [])[0];
    if (!host || token !== host.playerToken) return res.status(403).json({ error: "只有房主可以开局" });
    if (room.started) return res.status(400).json({ error: "牌局已经开始了" });
    if (room.seats.length < MIN_SEATS) return res.status(400).json({ error: "至少要 2 个人才能开局" });

    const rules = resolveRules(room.rules);
    let state;
    try {
      state = engine.createGame({
        players: room.seats.map(function (s) {
          return { id: s.playerId, name: s.name, isAI: !!s.isAI };
        }),
        // 引擎读的是 config.defaults / rules 两个位置，平着塞 config 会被无视，
        // 两处都给才保证房间规则开关真的生效（别只传 config）
        config: rules,
        rules: rules,
        seed: randomInt(1, 2147483647)
      });
    } catch (e) {
      return res.status(400).json({ error: e && e.message ? e.message : "开局失败" });
    }
    room.started = true;
    room.startedAt = Date.now();
    room.rules = rules;
    room.state = state;
    saveRoom(room);
    broadcast(room);
    res.json({ ok: true, code: room.code, seq: state && state.seq });
  });

  // GET /daifugo/api/rooms/:code/state?token= → viewFor 脱敏视图（无 token=观战）
  api.get("/rooms/:code/state", scopeGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const seat = seatByToken(room, typeof req.query.token === "string" ? req.query.token : null);
    const payload = statePayload(room, seat ? seat.playerId : null);
    payload.ok = true;
    payload.legal = seat ? legalOf(room, seat.playerId) : [];
    if (req.authLevel === "owner") payload.inviteToken = room.inviteToken;
    res.json(payload);
  });

  // GET /daifugo/api/rooms/:code/events?token= → SSE（连上先推自己的视图，25s :ping）
  api.get("/rooms/:code/events", scopeGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const seat = seatByToken(room, typeof req.query.token === "string" ? req.query.token : null);
    const playerId = seat ? seat.playerId : null;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write("retry: 3000\n\n");
    res.write("event: state\ndata: " + JSON.stringify(statePayload(room, playerId)) + "\n\n");

    const client = { res: res, playerId: playerId };
    if (!sseClients.has(room.code)) sseClients.set(room.code, new Set());
    sseClients.get(room.code).add(client);
    allSse.add(res);

    const ping = setInterval(function () {
      try { res.write(":ping\n\n"); } catch (e) { /* 下一轮 close 会清理 */ }
    }, SSE_PING_MS);
    if (typeof ping.unref === "function") ping.unref();

    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearInterval(ping);
      const set = sseClients.get(room.code);
      if (set) {
        set.delete(client);
        if (!set.size) sseClients.delete(room.code);
      }
      allSse.delete(res);
    }
    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  // POST /daifugo/api/rooms/:code/action {playerToken, type, ...}
  api.post("/rooms/:code/action", scopeGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const body = req.body || {};
    const seat = seatByToken(room, body.playerToken);
    if (!seat) return res.status(403).json({ error: "你没有座位（观战中）" });

    const action = {};
    for (const k of Object.keys(body)) {
      if (k !== "playerToken") action[k] = body[k];
    }
    const out = applyAction(room, seat, action, res);
    if (!out) return;
    res.json({
      ok: true,
      seq: out.state && typeof out.state.seq === "number" ? out.state.seq : 0,
      events: out.events,
      view: viewOf(room, seat.playerId),
      legal: legalOf(room, seat.playerId),
      yourTurn: isYourTurn(room, seat.playerId)
    });
  });

  // POST /daifugo/api/rooms/:code/chat {playerToken?, name?, text} — 牌桌闲聊
  // 有座位 token = 用座位身份说话；没有 = 观战路人（by 为 null）。
  api.post("/rooms/:code/chat", scopeGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const body = req.body || {};
    const t = normChatText(body.text);
    if (t.error) return res.status(400).json({ error: t.error });
    const seat = seatByToken(room, body.playerToken);
    const name = seat ? seat.name : (String(body.name || "").trim().slice(0, 16) || "观战");
    pushChat(room, seat ? seat.playerId : null, name, t.text);
    saveRoom(room);
    broadcast(room);
    scheduleExternalChatWake(room); // 人话才捎信;agent 通道自己的发言不叫(免自言自语)
    res.json({ ok: true });
  });

  // POST /daifugo/api/rooms/:code/close {playerToken?} — 关房:踢线+删档。
  // owner cookie / agent 通道 = 自家人,免座位凭据直接关(换设备丢 localStorage 也能清理);
  // 访客必须持房主座位 token(实际上访客当不了房主,等于关不了)。
  api.post("/rooms/:code/close", scopeGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const privileged = req.authLevel === "owner" || req.authLevel === "agent";
    const token = (req.body && req.body.playerToken) || "";
    const host = (room.seats || [])[0];
    if (!privileged && (!host || token !== host.playerToken)) {
      return res.status(403).json({ error: "只有房主可以关闭房间" });
    }
    room.closed = true;
    broadcast(room); // 各视角推 closed:true,前端据此退回大厅
    const code = room.code;
    setTimeout(function () { // 给 SSE 一点冲刷时间再拆台
      const set = sseClients.get(code);
      if (set) for (const c of set) { try { c.res.end(); } catch (e) { /* 已断 */ } }
      sseClients.delete(code);
      rooms.delete(code);
      try { fs.rmSync(roomPath(code), { force: true }); } catch (e) { /* 没了拉倒 */ }
    }, 300);
    res.json({ ok: true });
  });

  // ── 内部 agent 通道（X-Internal-Key，供外部 bot / agent 程序接入出牌）──

  // GET /daifugo/api/agent/rooms → 大厅列表（含哪些房有 agent 座位）
  api.get("/agent/rooms", agentGuard, function (req, res) {
    res.json({ ok: true, rooms: listRooms(20).map(roomSummary) });
  });

  // POST /daifugo/api/agent/:code/join {agent_id, name} → 入座（幂等）
  api.post("/agent/:code/join", agentGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const body = req.body || {};
    const agentId = String(body.agent_id || "").trim().slice(0, 32);
    if (!agentId) return res.status(400).json({ error: "缺少 agent_id" });
    if (!room.agentSeats) room.agentSeats = {};

    // 幂等：同 agent_id 再 join = 返回已有座位（断续会话免丢座）
    const existing = seatByAgent(room, agentId);
    if (existing) {
      return res.json({
        ok: true, code: room.code, playerId: existing.playerId, name: existing.name,
        isHost: !!existing.isHost, rejoined: true
      });
    }

    if (room.started) return res.status(400).json({ error: "牌局已开始，无法入座" });
    if ((room.seats || []).length >= MAX_SEATS) return res.status(400).json({ error: "房间已满（最多 4 人）" });

    const name = String(body.name || "").trim().slice(0, 16) || agentId;
    const seat = addSeat(room, name, { isAI: true, agentId: agentId });
    room.agentSeats[agentId] = seat.playerId;
    saveRoom(room);
    broadcast(room);
    res.json({
      ok: true, code: room.code, playerId: seat.playerId, name: seat.name,
      isHost: seat.isHost, rejoined: false
    });
  });

  // GET /daifugo/api/agent/:code/view?agent_id= → {view, legal, yourTurn}
  api.get("/agent/:code/view", agentGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const agentId = typeof req.query.agent_id === "string" ? req.query.agent_id : "";
    const seat = seatByAgent(room, agentId);
    if (!seat) return res.status(404).json({ error: "这个 agent 还没在这房间入座" });
    const st = room.state;
    const current = st && st.current
      ? (room.seats.find(function (s) { return s.playerId === st.current; }) || null)
      : null;
    res.json({
      ok: true,
      code: room.code,
      name: room.name,
      started: !!room.started,
      rules: room.rules || {},
      seats: publicSeats(room),
      you: seat.playerId,
      yourName: seat.name,
      seq: st && typeof st.seq === "number" ? st.seq : 0,
      currentName: current ? current.name : null,
      yourTurn: isYourTurn(room, seat.playerId),
      chat: chatTail(room),
      view: viewOf(room, seat.playerId),
      legal: legalOf(room, seat.playerId)
    });
  });

  // POST /daifugo/api/agent/:code/act {agent_id, type, cards?}
  api.post("/agent/:code/act", agentGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const body = req.body || {};
    const agentId = String(body.agent_id || "").trim();
    const seat = seatByAgent(room, agentId);
    if (!seat) return res.status(404).json({ error: "这个 agent 还没在这房间入座" });

    const action = {};
    for (const k of Object.keys(body)) {
      if (k !== "agent_id") action[k] = body[k];
    }
    const out = applyAction(room, seat, action, res);
    if (!out) return;
    const st = room.state;
    const current = st && st.current
      ? (room.seats.find(function (s) { return s.playerId === st.current; }) || null)
      : null;
    res.json({
      ok: true,
      seq: st && typeof st.seq === "number" ? st.seq : 0,
      events: out.events,
      currentName: current ? current.name : null,
      yourTurn: isYourTurn(room, seat.playerId),
      view: viewOf(room, seat.playerId),
      legal: legalOf(room, seat.playerId)
    });
  });

  // POST /daifugo/api/agent/:code/chat {agent_id, text} — agent 在牌桌上说话
  api.post("/agent/:code/chat", agentGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const body = req.body || {};
    const agentId = String(body.agent_id || "").trim();
    const seat = seatByAgent(room, agentId);
    if (!seat) return res.status(400).json({ error: "这个 agent 还没在这房间入座，先 join 才能说话" });
    const t = normChatText(body.text);
    if (t.error) return res.status(400).json({ error: t.error });
    pushChat(room, seat.playerId, seat.name, t.text);
    saveRoom(room);
    broadcast(room);
    res.json({ ok: true });
  });

  app.use("/daifugo/api", api);

  // GET /daifugo/engine.js → 原样送 engine.cjs（前端复用判定逻辑）
  app.get("/daifugo/engine.js", function (req, res) {
    fs.readFile(enginePath, "utf8", function (err, src) {
      if (err) return res.status(404).json({ error: "engine.cjs 还没就位" });
      res.set("Content-Type", "application/javascript; charset=utf-8");
      res.set("Cache-Control", "no-cache");
      res.send(src);
    });
  });

  // 静态托管 public/
  app.use("/daifugo", express.static(publicDir, { extensions: ["html"], index: "index.html" }));
  app.get("/", function (req, res) { res.redirect("/daifugo/"); });

  app.use(function (req, res) { res.status(404).json({ error: "路径不存在" }); });

  // eslint-disable-next-line no-unused-vars
  app.use(function (err, req, res, next) {
    console.error("[daifugo] error", err && err.stack ? err.stack : err);
    if (res.headersSent) return res.end();
    res.status(500).json({ error: (err && err.message) || "服务器内部错误" });
  });

  const server = http.createServer(app);

  // 重启前正轮到自动 AI 的局，起来就接着走
  try {
    resumeAuto();
  } catch (e) {
    console.warn("[daifugo] 启动扫描自动座位失败：" + (e && e.message));
  }

  return {
    app: app,
    server: server,
    dataDir: dataDir,
    roomsDir: roomsDir,
    configFile: configFile,
    engine: engine,
    enginePath: enginePath,
    internalKey: function () { return internalKey(); },
    cleanupRooms: cleanupRooms,
    signCookie: signCookie,
    config: config,
    get port() {
      const a = server.address();
      return a && typeof a === "object" ? a.port : null;
    },
    start: function (port, host) {
      return new Promise(function (resolve, reject) {
        server.once("error", reject);
        server.listen(
          port === undefined || port === null ? DEFAULT_PORT : port,
          host || DEFAULT_HOST,
          function () {
            server.removeListener("error", reject);
            resolve(server.address().port);
          }
        );
      });
    },
    stop: function () {
      return new Promise(function (resolve) {
        for (const t of autoTimers) clearTimeout(t);
        autoTimers.clear();
        autoBusy.clear();
        for (const res of allSse) {
          try { res.end(); } catch (e) { /* ignore */ }
        }
        allSse.clear();
        sseClients.clear();
        server.close(function () { resolve(); });
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      });
    }
  };
}

module.exports = { createServer: createServer };

if (require.main === module) {
  const inst = createServer({});
  inst.cleanupRooms();
  const port = parseInt(process.env.PORT, 10) || DEFAULT_PORT;
  inst.start(port, process.env.HOST || DEFAULT_HOST).then(function (p) {
    console.log("[daifugo] listening on " + (process.env.HOST || DEFAULT_HOST) + ":" + p +
      " (data: " + inst.dataDir + ", host: " + os.hostname() + ", auth: " +
      (LOGIN_PASSWORD ? "password" : "open") + ")");
    if (!LOGIN_PASSWORD) {
      console.log("[daifugo] open mode：没设 BISCA_PASSWORD，任何能连上的人都是主人。公网部署请设密码。");
    }
  }).catch(function (e) {
    console.error("[daifugo] failed to listen:", e && e.message);
    process.exit(1);
  });
}
