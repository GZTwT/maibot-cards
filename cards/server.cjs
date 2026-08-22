#!/usr/bin/env node
"use strict";
// Bisca 棋牌室多游戏底盘。默认监听 127.0.0.1:8081，URL 前缀 /cards。
// 底盘和 daifugo 同构（认证/静态资源豁免/房间原子落盘/SSE 分视角/牌桌聊天/
// 访客邀请/关房/AI 邀请落座/自动 AI 玩家 CLI 驱动/外接 agent 唤醒/重启恢复），
// 唯一的结构差异：**一个服务装三个游戏**——
//   1. 引擎注册表 ENGINES = {ddz, zjh, uno}，safeRequire 包着（缺谁服务照起）。
//   2. 房间带 game 字段，一切 engine.* 调用改成按房间取 ENGINES[room.game]。
//   3. 人数上限/规则默认值/牌桌简报/招式人话全走 engine.meta / engine.briefing / engine.fmtMove。
// 唯一运行时依赖是 express，无 ws、无新依赖。
// 落盘即真相：rooms/<code>.json 每步 tmp+rename 原子写，进程内存只是缓存。

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const { execFile } = require("child_process");
const { createHmac, timingSafeEqual, randomBytes, randomInt } = require("crypto");

const DEFAULT_PORT = 8081;
const DEFAULT_HOST = "127.0.0.1";
const COOKIE_NAME = "bisca_auth";
const LOGIN_PATH = "/cards/login";
const COOKIE_MAX_AGE_MS = 90 * 24 * 3600 * 1000; // 登录有效期 90 天
const MAX_SEATS = 4;  // engine.meta 没给上限时的兜底
const MIN_SEATS = 2;  // 同上
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

// 自动 AI 玩家：agent_id → claude CLI 的 --model 别名（服务端替这些座位出牌）
const AUTO_MODELS = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku"
};
// 外接 agent 座位：服务端不驱动，等外部程序走 X-Internal-Key 通道出牌。
const EXTERNAL_AGENT_ID = "external";
const AUTO_DELAY_MS = 1200;        // 出牌前顿一下，别快得像机器
const AUTO_CLI_TIMEOUT_MS = 45000; // 单发思考超时
const AUTO_MOVE_CAP = 24;          // AI prompt 里最多列这么多招
const WAKE_MOVE_CAP = 15;          // 外接 agent 唤醒简报里最多列这么多招
const AUTO_SAY_MAX = 120;          // AI 嘴一句最多落这么多字进聊天

// ── 引擎注册表 ──────────────────────────────────────────────────────────────
// 三个引擎并行开发中，谁没就位就是 null——服务照起，只在"建这个 game 的房"时 503。

const ENGINE_DIR = process.env.CARDS_ENGINE_DIR || path.join(__dirname, "engines");
const GAME_LIST = ["ddz", "zjh", "uno"];

function safeRequire(file) {
  try {
    return require(file);
  } catch (e) {
    console.warn("[cards] 引擎未就绪 " + file + "：" + (e && e.message));
    return null;
  }
}

function defaultEnginePath(game) {
  return path.join(ENGINE_DIR, game + ".cjs");
}

const ENGINES = {
  ddz: safeRequire(defaultEnginePath("ddz")),
  zjh: safeRequire(defaultEnginePath("zjh")),
  uno: safeRequire(defaultEnginePath("uno"))
};

// 各游戏的一句话策略提示（塞进 AI prompt，炸金花是下注游戏，思路和出牌游戏完全不同）
const STRATEGY_HINT = {
  ddz: "记牌压制配合队友或单干",
  zjh: "牌差就早弃,牌好就加注,闷牌省钱",
  uno: "留万能牌收尾,盯着剩1张的人"
};

// ── 配置读取 ────────────────────────────────────────────────────────────────

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

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

// engine 可能还没就位（并行开发/被删），meta 一律走这个兜底口。
function metaOf(engine, game) {
  const m = (engine && engine.meta) || {};
  return {
    key: m.key || game,
    name: m.name || game,
    minPlayers: typeof m.minPlayers === "number" ? m.minPlayers : MIN_SEATS,
    maxPlayers: typeof m.maxPlayers === "number" ? m.maxPlayers : MAX_SEATS,
    defaultRules: (m.defaultRules && typeof m.defaultRules === "object") ? m.defaultRules : {},
    ruleMeta: Array.isArray(m.ruleMeta) ? m.ruleMeta : []
  };
}

function roomSummary(room, engine) {
  const st = room.state || null;
  const phase = (st && st.phase) || null;
  const current = (st && st.current) || null;
  const seat = current ? (room.seats || []).find(function (s) { return s.playerId === current; }) : null;
  const meta = metaOf(engine, room.game);
  return {
    code: room.code,
    name: room.name,
    game: room.game,
    gameName: meta.name,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt || room.createdAt,
    started: !!room.started,
    finished: phase === "game_over",
    phase: phase,
    round: (st && st.round) || 0,
    current: current,
    currentName: seat ? seat.name : null,
    playerCount: (room.seats || []).length,
    maxPlayers: meta.maxPlayers,
    players: publicSeats(room),
    agentSeats: room.agentSeats || {},
    rules: room.rules || {},
    seq: st && typeof st.seq === "number" ? st.seq : 0
  };
}

// ── 引擎契约的安全外壳（引擎抛错 / 没导出都不许掀翻服务）────────────────────

function safeBriefing(engine, state, playerId) {
  if (!engine || typeof engine.briefing !== "function") return "（这个引擎没给简报）";
  try {
    const s = engine.briefing(state, playerId);
    return typeof s === "string" && s ? s : "（这个引擎没给简报）";
  } catch (e) {
    return "（简报生成失败：" + (e && e.message) + "）";
  }
}

function safeFmtMove(engine, move) {
  if (engine && typeof engine.fmtMove === "function") {
    try {
      const s = engine.fmtMove(move);
      if (typeof s === "string" && s) return s;
    } catch (e) { /* 落到下面的兜底排版 */ }
  }
  if (!move) return "?";
  if (move.type === "pass") return "过（pass）";
  const cards = Array.isArray(move.cards) ? " " + move.cards.join(" ") : "";
  return String(move.type || "?") + cards;
}

// 招式列表排版：编号 p1..pN，超过 cap 就截断并说明（口径照 daifugo）。
function numberedMoves(moveLines, cap) {
  const out = [];
  (moveLines || []).slice(0, cap).forEach(function (s, i) {
    out.push("  p" + (i + 1) + " " + s);
  });
  return out;
}

// ── 自动 AI 玩家：prompt 排版 + CLI 单发 mover ──────────────────────────────

// 开场人设句：config.json 的 ai_persona 可整句覆写，{seatName}/{gameName} 会被替换。
const DEFAULT_AI_PERSONA =
  "你是牌桌上的 AI 牌友「{seatName}」，正在和朋友们打{gameName}。现在轮到你动。";

function renderPersona(tpl, job) {
  return String(typeof tpl === "string" && tpl.trim() ? tpl : DEFAULT_AI_PERSONA)
    .replace(/\{seatName\}/g, job.seatName || "AI")
    .replace(/\{gameName\}/g, job.gameName || "牌");
}

// 给 AI 看的牌桌简报。局面部分由引擎自己写（briefing），这里只管排版+合法招编号+闲聊+思路。
function buildAutoPrompt(job) {
  const moveLines = job.moveLines || [];
  const lines = [];

  lines.push(renderPersona(job.persona, job));
  lines.push("");
  lines.push(job.briefing || "");

  lines.push("");
  lines.push("能出的招（只能从这里挑）：");
  numberedMoves(moveLines, AUTO_MOVE_CAP).forEach(function (l) { lines.push(l); });
  if (moveLines.length > AUTO_MOVE_CAP) {
    lines.push("  （还有 " + (moveLines.length - AUTO_MOVE_CAP) + " 招没列出来，只从 p1~p" + AUTO_MOVE_CAP + " 里选）");
  }

  const chat = job.chatTail || [];
  if (chat.length) {
    lines.push("");
    lines.push("最近的牌桌闲聊：");
    chat.forEach(function (c) { lines.push("  " + (c && c.name) + "：" + (c && c.text)); });
  }

  lines.push("");
  lines.push("打牌思路：" + (STRATEGY_HINT[job.game] || "别送,该稳的时候稳,该压的时候压") + "。");
  lines.push("只回一个 JSON 对象，前后不要任何别的字，形如 {\"move\":\"p2\",\"say\":\"可选的一句话\"}" +
    "（p2 换成你真正要出的那一招的编号）。");
  lines.push("move 只能是上面列出的编号（p1、p2……）或 \"pass\"（列表里有过这一招才能用）。");
  lines.push("say 是一句短嘴炮：可以毒舌调侃但别伤人，不超过 40 字。大多数轮次别说话（大概三轮开一次口就够）——" +
    "出大牌、绝地反杀、被人压死这种时候才值得嘴一句；不想说就整个省掉 say 字段。");
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

// 默认 mover：调本机的 Claude Code CLI 单发一次（不续会话、不喂 system prompt、
// 不给任何工具——就是个便宜的出牌脑子）。前提是这台机器上装了 CLI 并且已登录；
// 可执行名用 env CLAUDE_BIN 换（默认 "claude"）。没装 / 调不通时这一手自动兜底
// 出第一招（见 runAutoTurn），牌局不会卡住。
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

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
      maxBuffer: 16 * 1024 * 1024,
      env: process.env // 直接继承环境，CLI 用的是本机已有的登录态
    }, function (err, stdout, stderr) {
      // CLI 的 stdin-3s 警告是噪音；err.message 带整条命令行（含完整 prompt），绝不外泄。
      const errText = String(stderr || "")
        .replace(/Warning: no stdin data received[^\n]*\n?/g, "").trim();
      if (err) {
        const reason = err.killed
          ? "AI 思考超时（>" + Math.round(AUTO_CLI_TIMEOUT_MS / 1000) + "s）"
          : (CLAUDE_BIN + " 退出 " + (err.code != null ? "码 " + err.code : "信号 " + err.signal) +
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

// ── 叫外接 agent 上桌（通用 webhook）────────────────────────────────────────
// external 座位不由服务端驱动，等外部程序走 X-Internal-Key 通道出牌。轮到它 /
// 牌桌有人说话时，如果配了 WAKE_WEBHOOK_URL（env 或 config.json 的 wake_webhook_url），
// 就往那个地址 POST 一个 JSON，让用户自己桥接到任何通知 / agent 系统；没配就不叫，纯等 API。

const WAKE_WEBHOOK_TIMEOUT_MS = 30 * 1000;

// 人话版牌桌简报（塞进 webhook 的 text 字段，收到通知的人 / agent 直接能读）
function buildTurnBriefing(job) {
  const moveLines = job.moveLines || [];
  const lines = [];
  lines.push(job.briefing || "");
  numberedMoves(moveLines, WAKE_MOVE_CAP).forEach(function (l) { lines.push(l); });
  if (moveLines.length > WAKE_MOVE_CAP) {
    lines.push("(还有 " + (moveLines.length - WAKE_MOVE_CAP) + " 招没列,想看全走 agent view 接口)");
  }
  const chats = (job.chatTail || []).map(function (c) { return "  " + c.name + "：" + c.text; });
  if (chats.length) lines.push("最近闲聊:\n" + chats.join("\n"));
  return lines.join("\n");
}

// webhook 正文里的一句人话（kind=turn 是"轮到你了+简报"，kind=chat 是"牌桌有人说话"）
function buildWakeText(job) {
  const gameName = job.gameName || "牌";
  if (job.kind === "chat") {
    return "房间「" + job.roomName + "」(" + job.code + ") 的" + gameName +
      "牌桌聊天有新消息：\n" + (job.chatLines || []).join("\n");
  }
  return "房间「" + job.roomName + "」(" + job.code + ") 的" + gameName +
    "牌桌轮到你动了，简报如下：\n" + buildTurnBriefing(job);
}

// job → webhook 请求体（字段扁平，方便下游直接映射成通知 / prompt）
function wakePayload(job) {
  return {
    kind: job.kind || "turn",
    code: job.code,
    roomName: job.roomName,
    game: job.game,
    gameName: job.gameName,
    phase: job.phase || null,
    seatName: job.seatName || null,
    agentId: EXTERNAL_AGENT_ID,
    briefing: job.briefing || "",
    moveLines: job.moveLines || [],
    chatLines: job.chatLines || [],
    chatTail: job.chatTail || [],
    text: buildWakeText(job)
  };
}

async function postWakeWebhook(url, job) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, WAKE_WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wakePayload(job)),
      signal: controller.signal
    });
    if (!res.ok) throw new Error("webhook HTTP " + res.status);
    // 正文不关心，读完就散（免得连接挂着）
    try { await res.arrayBuffer(); } catch (e) { /* 对端不给正文也无所谓 */ }
  } finally {
    clearTimeout(timer);
  }
}

// ── 服务工厂 ────────────────────────────────────────────────────────────────

function createServer(options) {
  const opts = options || {};
  const dataDir = opts.dataDir || process.env.BISCA_DATA_DIR || path.join(__dirname, "data");
  const roomsDir = path.join(dataDir, "rooms");
  const configFile = path.join(dataDir, "config.json");
  const publicDir = opts.publicDir || path.join(__dirname, "public");
  // 登录密码：设了就开登录页，没设 = open mode（自托管内网场景，谁进来都是主人）。
  const loginPassword = typeof opts.password === "string" ? opts.password : (process.env.BISCA_PASSWORD || "");
  const openMode = !loginPassword;
  // 引擎注册表：测试注入 stub（值可以是 null = 那个游戏的引擎还没就绪）。
  const engines = opts.engines || ENGINES;
  const GAME_KEYS = Object.keys(engines);
  // 每个 game 的源码路径（GET /cards/engine/:game.js 原样送给前端预判用）
  const enginePaths = {};
  for (const g of GAME_KEYS) {
    enginePaths[g] = (opts.enginePaths && opts.enginePaths[g]) || defaultEnginePath(g);
  }

  ensureDir(roomsDir);

  // cookie 签名密钥：config.json 的 cookie_secret，首次启动自动生成落盘。
  const cookieSecret = opts.cookieSecret || ensureConfig().cookie_secret;

  const rooms = new Map(); // code -> room（内存缓存，盘上是真相）
  const sseClients = new Map(); // code -> Set<{res, playerId}>
  const allSse = new Set();

  // 房间 → 引擎（没就绪 / game 坏了都返回 null，调用方各自兜底）
  function engineOf(room) {
    return (room && room.game && engines[room.game]) || null;
  }

  function metaFor(room) {
    return metaOf(engineOf(room), room && room.game);
  }

  // ── 认证（单密码 cookie；没设密码就是 open mode）──

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

  // 密码比对：先各自 hash 成等长摘要，再 timingSafeEqual（原文长度不同也不泄漏）
  function passwordMatches(given) {
    if (typeof given !== "string" || !given) return false;
    const a = createHmac("sha256", cookieSecret).update(given).digest();
    const b = createHmac("sha256", cookieSecret).update(loginPassword).digest();
    return timingSafeEqual(a, b);
  }

  function isHttps(req) {
    return !!req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  }

  function setAuthCookie(req, res) {
    const value = signCookie("authenticated." + Date.now());
    const parts = [
      COOKIE_NAME + "=" + value,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=" + Math.floor(COOKIE_MAX_AGE_MS / 1000)
    ];
    if (isHttps(req)) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  // ── config.json（热读，缺省自动初始化）──

  function loadConfig() {
    const cfg = readJsonSafe(configFile, null);
    if (!cfg || typeof cfg !== "object") return {};
    return cfg;
  }

  // 首次启动没有 config.json（或缺字段）就生成写回：cookie 签名密钥和内部通道 key
  // 都在这儿随机生成，两者都永不出内网。
  // defaults 按 game 分组，值取各引擎 meta.defaultRules（引擎没就绪就先不写，等它来了再补）。
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
    for (const g of GAME_KEYS) {
      const base = metaOf(engines[g], g).defaultRules;
      const keys = Object.keys(base);
      if (!keys.length) continue; // 引擎还没就绪，别写空壳
      if (!next.defaults[g] || typeof next.defaults[g] !== "object") { next.defaults[g] = {}; dirty = true; }
      for (const k of keys) {
        if (typeof next.defaults[g][k] !== typeof base[k]) { next.defaults[g][k] = base[k]; dirty = true; }
      }
    }
    if (dirty) {
      try {
        writeJsonAtomic(configFile, next);
      } catch (e) {
        console.warn("[cards] config.json 写入失败：" + (e && e.message));
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

  function checkInternalKey(req) {
    const given = req.headers["x-internal-key"];
    const want = internalKey();
    if (!want || typeof given !== "string" || !given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(want);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // rules：只认这个 game 的引擎声明过的开关（且类型要对得上），其余丢掉；config.defaults[game] 打底。
  function resolveRules(game, input) {
    const base = metaOf(engines[game], game).defaultRules;
    const cfgDefaults = (loadConfig().defaults || {})[game] || {};
    const out = {};
    for (const k of Object.keys(base)) {
      const t = typeof base[k];
      out[k] = base[k];
      if (typeof cfgDefaults[k] === t) out[k] = cfgDefaults[k];
      if (input && typeof input[k] === t) out[k] = input[k];
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

  // game 传了就只列那个游戏的房（大厅按 tab 分组用）
  function listRooms(limit, game) {
    return listRoomCodes()
      .map(function (c) { return loadRoom(c); })
      .filter(Boolean)
      .filter(function (r) { return !game || r.game === game; })
      .sort(function (a, b) { return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0); })
      .slice(0, limit || 20);
  }

  function summarize(room) {
    return roomSummary(room, engineOf(room));
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
    if (removed) console.log("[cards] cleanup removed " + removed + " finished room file(s)");
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
    return view;
  }

  function viewOf(room, playerId) {
    if (!room.state) return null;
    const engine = engineOf(room);
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
    const engine = engineOf(room);
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

  // 谁欠动作一律问引擎的 currentActors，服务端不再猜 phase（三个游戏 phase 名各不相同）。
  function isYourTurn(room, playerId) {
    if (!playerId) return false;
    return pendingOwedIds(room).indexOf(playerId) >= 0;
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
    const meta = metaFor(room);
    return {
      code: room.code,
      name: room.name,
      game: room.game,
      gameName: meta.name,
      maxPlayers: meta.maxPlayers,
      minPlayers: meta.minPlayers,
      started: !!room.started,
      closed: !!room.closed,
      rules: room.rules || {},
      seats: publicSeats(room),
      you: playerId || null,
      yourTurn: isYourTurn(room, playerId),
      seq: room.state && typeof room.state.seq === "number" ? room.state.seq : 0,
      chat: chatTail(room),
      state: viewOf(room, playerId || null),
      // SSE 帧直接带自己的合法招(炸金花牌桌页作者点的缺口:不带的话前端每步都要
      // 补拉一次 /state)。观战 [] 。家庭局规模,枚举开销可忽略。
      legal: playerId ? legalOf(room, playerId) : []
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
  // 座位是 AI 且 agent_id 在 AUTO_MODELS 里 = 服务端自己起 Claude Code CLI 替他出牌。
  // 触发点只有一个：broadcast（任何状态变动都会走）+ 懒加载房间的首次落缓存 + 启动扫描。

  const aiMover = typeof opts.aiMover === "function" ? opts.aiMover : cliMover;
  const autoBusy = new Set();   // 每房一把锁，防并发重入
  const autoTimers = new Set(); // stop() 时清掉还没触发的定时器

  // 一份给"脑子"（自动 AI / 外接 agent）看的牌桌资料，两条唤醒路共用。
  function buildJob(room, seat, extra) {
    const engine = engineOf(room);
    const legal = legalOf(room, seat.playerId);
    return Object.assign({
      code: room.code,
      roomName: room.name || room.code,
      game: room.game,
      gameName: metaFor(room).name,
      seatName: seat.name,
      phase: room.state && room.state.phase,
      briefing: room.state ? safeBriefing(engine, room.state, seat.playerId) : "",
      moveLines: legal.map(function (m) { return safeFmtMove(engine, m); }),
      view: viewOf(room, seat.playerId),
      legal: legal
    }, extra || {});
  }

  // ── 轮到外接 agent：按 webhook 捎个信（没配 webhook 就是空操作）────────────
  // 每个"回合身份"（房号:seq:phase）只叫一次，聊天/重连引起的 broadcast 不会重复轰炸。
  // config.json 里 wake_external_on_turn:false 可整体关掉。
  function webhookWaker(job) {
    const url = process.env.WAKE_WEBHOOK_URL || loadConfig().wake_webhook_url || "";
    if (!url) return Promise.resolve(false); // 没配 = 不叫，纯等外部程序自己来 API 出牌
    return postWakeWebhook(url, job).then(function () { return true; });
  }

  const externalWaker = typeof opts.externalWaker === "function" ? opts.externalWaker : webhookWaker;
  const wokenKeys = new Set();
  const WAKE_DELAY_MS = typeof opts.wakeDelayMs === "number" ? opts.wakeDelayMs : 3000;

  function scheduleExternalWake(room) {
    if (!room || !room.state || room.closed) return;
    const cfg = readJsonSafe(configFile, null) || {};
    if (cfg.wake_external_on_turn === false) return;
    const seat = pendingExternalSeat(room);
    if (!seat) return;
    const key = room.code + ":" + room.state.seq + ":" + room.state.phase;
    if (wokenKeys.has(key)) return;
    wokenKeys.add(key);
    if (wokenKeys.size > 500) { wokenKeys.clear(); wokenKeys.add(key); }
    const code = room.code;
    const t = setTimeout(function () {
      autoTimers.delete(t);
      // 叫之前最后确认一次：这几秒里可能有人替他动了 / 局面翻页了
      const fresh = loadRoom(code);
      const still = fresh && pendingExternalSeat(fresh);
      if (!still || still.playerId !== seat.playerId ||
          !fresh.state || (fresh.code + ":" + fresh.state.seq + ":" + fresh.state.phase) !== key) return;
      Promise.resolve(externalWaker(buildJob(fresh, still, {
        kind: "turn",
        // 简报直接带进通知:对端不用再回头拉一次 view
        chatTail: (fresh.chat || []).slice(-3)
      })))
        .catch(function (e) {
          console.warn("[cards] " + code + " 叫外接 agent 出牌失败：" + (e && e.message));
        });
    }, WAKE_DELAY_MS);
    if (typeof t.unref === "function") t.unref();
    autoTimers.add(t);
  }

  // ── 牌桌聊天有新话，外接 agent 不在回合上也捎个信（防轰炸：去抖 + 冷却）──────
  // 人在牌桌贫嘴,想让 agent 接得上——但一次唤醒对下游就是一整个回合,不能一句一叫。
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
    if (pendingExternalSeat(room)) return; // 轮到他,turn wake 会带上聊天,不重复叫
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
      if (pendingExternalSeat(fresh)) return; // 这会儿轮到他了,让 turn wake 管
      const lines = (fresh.chat || []).slice(-5)
        .filter(function (c) { return c.by !== seat.playerId; })
        .map(function (c) { return "  " + c.name + "：" + c.text; });
      if (!lines.length) return;
      Promise.resolve(externalWaker({
        kind: "chat", code: code, roomName: fresh.name || code,
        game: fresh.game, gameName: metaFor(fresh).name,
        phase: fresh.state && fresh.state.phase, seatName: seat.name, chatLines: lines
      })).catch(function (e) {
        console.warn("[cards] " + code + " 聊天捎信给外接 agent 失败：" + (e && e.message));
      });
    }, wait);
    if (typeof t.unref === "function") t.unref();
    autoTimers.add(t);
    st.timer = t;
    chatWakeState.set(code, st);
  }

  // 现在欠动作的 playerId 列表——直接问引擎的 currentActors（游戏各自定义，服务端不猜）。
  function pendingOwedIds(room) {
    const st = room && room.state;
    if (!room || !room.started || !st) return [];
    const engine = engineOf(room);
    if (!engine || typeof engine.currentActors !== "function") {
      return st.current ? [st.current] : []; // 引擎没就绪/没导出时的兜底
    }
    try {
      const ids = engine.currentActors(st);
      return Array.isArray(ids) ? ids.filter(Boolean) : [];
    } catch (e) {
      return [];
    }
  }

  function pendingSeatWhere(room, match) {
    for (const pid of pendingOwedIds(room)) {
      const seat = (room.seats || []).find(function (s) { return s.playerId === pid; });
      if (seat && seat.isAI && match(seat)) return seat;
    }
    return null;
  }

  // 欠动作的人里，有没有需要自动驱动（CLI）的 AI 座位？没有返回 null。
  function pendingAutoSeat(room) {
    return pendingSeatWhere(room, function (s) { return !!AUTO_MODELS[s.agentId]; });
  }

  // 欠动作的是不是外接 agent 座位？轮到它要按 webhook 捎个信。
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
        console.error("[cards] " + code + " 自动出牌异常：" + (e && e.message));
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
      console.warn("[cards] " + code + " " + seat.name + " 没有合法招，自动出牌跳过");
      return false;
    }

    let picked = null;
    let say = "";
    let why = "";
    try {
      const out = await aiMover(buildJob(room, seat, {
        kind: "auto",
        modelKey: AUTO_MODELS[seat.agentId],
        // 人设句可在 config.json 用 ai_persona 整句覆写（支持 {seatName}/{gameName}）
        persona: loadConfig().ai_persona,
        chatTail: (room.chat || []).slice(-6)
      }));
      picked = resolveAutoMove(out && out.move, legal);
      if (picked && out && typeof out.say === "string") say = out.say.trim();
      if (!picked) why = (out && out.error) || ("看不懂的回答：" + JSON.stringify(out && out.move));
    } catch (e) {
      why = (e && e.message) || "mover 抛错";
    }
    if (!picked) {
      // 非法 / 解析失败 / CLI 挂了 —— 兜底出第一招，闭嘴照打
      console.warn("[cards] " + code + " " + seat.name + " 自动出牌兜底（" + why + "）");
      picked = legal[0];
      say = "";
    }

    let out = applyCore(room, seat, picked);
    if (out.error && picked !== legal[0]) {
      // 引擎说非法（局面对不上了）→ 再兜底一次
      console.warn("[cards] " + code + " " + seat.name + " 这招被引擎拒了（" + out.error + "），改出第一招");
      out = applyCore(room, seat, legal[0]);
      say = "";
    }
    if (out.error) {
      console.error("[cards] " + code + " " + seat.name + " 自动出牌失败，放弃这一手：" + out.error);
      return false;
    }
    if (say) pushChat(room, seat.playerId, seat.name, say.slice(0, AUTO_SAY_MAX));
    saveRoom(room);
    broadcast(room);
    return true;
  }

  // 启动扫描：重启前正轮到 AI 的局，接着走完。
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
  // 两套挂载点：裸路径给直连，/cards 前缀给按路径分流的反代。
  const themeStatic = express.static(ASSETS_DIR, { maxAge: STATIC_MAX_AGE });
  const fontStatic = express.static(FONTS_DIR, { maxAge: STATIC_MAX_AGE });
  ["", "/cards"].forEach(function (prefix) {
    app.use(prefix + "/assets-theme", themeStatic);
    app.use(prefix + "/fonts", fontStatic);
  });

  // 认证门：cookie = owner 级；X-Internal-Key = agent 级（视同 owner）；
  // allow_guests 开启时合法 invite = 该房间的 guest；没设登录密码 = open mode，一律 owner。
  function deny(res, req) {
    // 浏览器直接打开页面（cookie 过期/未登录）→ 跳本服务自己的登录页；
    // API/fetch 请求照旧 JSON 403。
    if (req && req.method === "GET" && String(req.headers.accept || "").includes("text/html")) {
      return res.redirect(LOGIN_PATH + "?r=" + encodeURIComponent(req.originalUrl || "/cards/"));
    }
    return res.status(403).json({ error: "未授权：需要登录，或有效的房间邀请链接" });
  }

  // ── 登录页 + 登录接口（都在认证门之前挂，不然永远进不来）──
  // 设了密码才有意义：open mode 下这两个口子直接把人放回大厅。

  // 回跳目标只认本站相对路径，防开放重定向
  function safeReturnTo(raw) {
    const s = typeof raw === "string" ? raw : "";
    return /^\/(?!\/)/.test(s) ? s : "/cards/";
  }

  function loginPage(returnTo, message) {
    return "<!DOCTYPE html>\n<html lang=\"zh\"><head><meta charset=\"UTF-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
      "<title>登录 · 棋牌室</title><style>" +
      "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
      "background:#0a0a0f;color:#e8e8f0;font:15px/1.6 system-ui,-apple-system,'Helvetica Neue',sans-serif}" +
      "form{width:min(340px,88vw);padding:28px 24px;border:1px solid #24243a;border-radius:16px;background:#12121c}" +
      "h1{margin:0 0 4px;font-size:19px}p{margin:0 0 18px;color:#8b8ba7;font-size:13px}" +
      "input{width:100%;padding:11px 13px;border:1px solid #2c2c44;border-radius:10px;background:#0d0d16;" +
      "color:#e8e8f0;font-size:15px}input:focus{outline:none;border-color:#6f6fd8}" +
      "button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:10px;background:#6f6fd8;color:#fff;" +
      "font-size:15px;font-weight:600;cursor:pointer}button:active{opacity:.85}" +
      ".msg{margin-top:12px;min-height:18px;color:#ff7a92;font-size:13px}" +
      "</style></head><body><form id=\"f\" method=\"post\" action=\"/cards/api/login\">" +
      "<h1>棋牌室</h1><p>输入访问密码</p>" +
      "<input type=\"hidden\" name=\"r\" value=\"" +
      String(returnTo).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;") + "\">" +
      "<input id=\"pw\" name=\"password\" type=\"password\" autocomplete=\"current-password\" autofocus>" +
      "<button type=\"submit\">进去</button><div class=\"msg\" id=\"m\">" + (message || "") + "</div>" +
      "<script>var R=" + JSON.stringify(returnTo) + ";" +
      "document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();" +
      "var m=document.getElementById('m');m.textContent='';" +
      "fetch('/cards/api/login',{method:'POST',headers:{'Content-Type':'application/json'}," +
      "body:JSON.stringify({password:document.getElementById('pw').value})})" +
      ".then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})" +
      ".then(function(o){if(o.ok){location.href=R;}else{m.textContent=(o.j&&o.j.error)||'登录失败';}})" +
      ".catch(function(){m.textContent='网络错误，再试一次';});});</script>" +
      "</form></body></html>";
  }

  app.get([LOGIN_PATH, "/login"], function (req, res) {
    const back = safeReturnTo(req.query.r);
    if (openMode || checkCookie(req)) return res.redirect(back);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.send(loginPage(back, ""));
  });

  // urlencoded 也收：登录页的 <form> 在 JS 挂了的时候还能原生提交
  app.post(["/cards/api/login", "/api/login"], express.urlencoded({ extended: false }),
    function (req, res) {
      const body = req.body || {};
      const back = safeReturnTo(body.r);
      // 原生表单提交（不是 fetch）要的是跳转，不是 JSON
      const wantsHtml = String(req.headers.accept || "").includes("text/html");
      if (openMode) {
        if (wantsHtml) return res.redirect(back);
        return res.status(400).json({ error: "本服务没有设置 BISCA_PASSWORD，不需要登录" });
      }
      if (!passwordMatches(body.password)) {
        if (wantsHtml) {
          res.status(401).set("Content-Type", "text/html; charset=utf-8");
          return res.send(loginPage(back, "密码不对"));
        }
        return res.status(401).json({ error: "密码不对" });
      }
      setAuthCookie(req, res);
      if (wantsHtml) return res.redirect(back);
      res.json({ ok: true, redirect: back });
    });

  // 静态子资源（js/css/图/字体/engine/*.js）没有任何秘密，直接放行——
  // 不然访客拿邀请链接能打开页面，script/css 子请求不带 invite 全 403。
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
    // open mode（没设 BISCA_PASSWORD）：自托管内网场景，谁进来都是主人。
    // 公网部署一定要设密码，README 有说明。
    if (openMode) {
      req.authLevel = "owner";
      return next();
    }
    if (checkCookie(req)) {
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
    const engine = engineOf(room);
    if (!engine) return { error: "「" + room.game + "」的引擎还没就绪，这桌暂时动不了" };
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

  // HTTP 版：出牌/过/下注等动作的共同落地——apply → 落盘 → 分视角广播
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
  // external 是外接 agent 座位（外部程序经 X-Internal-Key 通道出牌），
  // 其余三个是自动 AI（服务端起 CLI 替他们出牌，见 AUTO_MODELS）。
  const AI_ROSTER = {
    external: "外接 Agent",
    opus: "AI·Opus",
    sonnet: "AI·Sonnet",
    haiku: "AI·Haiku"
  };

  // 建房时勾选的 AI，等房主（第一个人类）入座后自动落座——
  // 不能在建房时就坐，否则 seats[0] 的 isHost 会落在 AI 头上。
  // 人数上限按这个游戏引擎的 meta.maxPlayers（斗地主 3 人，坐满就不再塞）。
  function seatPendingInvites(room) {
    if (!Array.isArray(room.aiInvites) || !room.aiInvites.length) return false;
    const max = metaFor(room).maxPlayers;
    let changed = false;
    for (const agentId of room.aiInvites) {
      if (!AI_ROSTER[agentId]) continue;
      if (!room.agentSeats) room.agentSeats = {};
      if (seatByAgent(room, agentId)) continue;             // 幂等：已在座
      if ((room.seats || []).length >= max) break;
      const seat = addSeat(room, AI_ROSTER[agentId], { isAI: true, agentId: agentId });
      room.agentSeats[agentId] = seat.playerId;
      changed = true;
    }
    room.aiInvites = [];
    return changed;
  }

  // POST /cards/api/rooms {game, name, rules?, ai_players?} → {code, inviteToken}
  api.post("/rooms", function (req, res) {
    if (req.authLevel === "guest") return deny(res);
    const body = req.body || {};
    const game = String(body.game || "").trim().toLowerCase();
    if (!game || GAME_KEYS.indexOf(game) === -1) {
      return res.status(400).json({
        error: "不认识的游戏「" + (body.game === undefined ? "" : String(body.game)) +
          "」，只能是：" + GAME_KEYS.join(" / ")
      });
    }
    if (!engines[game]) {
      return res.status(503).json({ error: "「" + game + "」的引擎还没就绪，先玩别的" });
    }
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
      game: game,
      createdAt: Date.now(),
      inviteToken: randomBytes(16).toString("hex"),
      rules: resolveRules(game, body.rules),
      seats: [],
      agentSeats: {},
      aiInvites: aiInvites,
      started: false,
      state: null
    };
    saveRoom(room);
    res.json({
      ok: true, code: room.code, name: room.name, game: room.game,
      gameName: metaFor(room).name, rules: room.rules, inviteToken: room.inviteToken
    });
  });

  // GET /cards/api/rooms[?game=ddz] → 大厅列表（近 20 个，可按游戏过滤）
  api.get("/rooms", function (req, res) {
    if (req.authLevel === "guest") return deny(res);
    const game = typeof req.query.game === "string" && req.query.game ? req.query.game : null;
    if (game && GAME_KEYS.indexOf(game) === -1) {
      return res.status(400).json({ error: "不认识的游戏「" + game + "」，只能是：" + GAME_KEYS.join(" / ") });
    }
    res.json({ ok: true, games: gamesCatalog(), rooms: listRooms(20, game).map(summarize) });
  });

  // 大厅要知道有哪些游戏、各自几人、有没有就绪（引擎缺席时前端好把 tab 灰掉）
  function gamesCatalog() {
    return GAME_KEYS.map(function (g) {
      const meta = metaOf(engines[g], g);
      return {
        key: g,
        name: meta.name,
        ready: !!engines[g],
        minPlayers: meta.minPlayers,
        maxPlayers: meta.maxPlayers,
        defaultRules: meta.defaultRules,
        ruleMeta: meta.ruleMeta
      };
    });
  }

  // POST /cards/api/rooms/:code/join {name, playerToken?} → {playerId, playerToken}
  api.post("/rooms/:code/join", scopeGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const body = req.body || {};

    // 带旧 token 回来 = 复座（刷新/断线重进）
    if (body.playerToken) {
      const seat = seatByToken(room, body.playerToken);
      if (seat) {
        return res.json({
          ok: true, code: room.code, game: room.game, playerId: seat.playerId, playerToken: seat.playerToken,
          name: seat.name, color: seat.color, isHost: !!seat.isHost, rejoined: true
        });
      }
    }

    if (room.started) return res.status(400).json({ error: "牌局已开始，无法入座" });
    const max = metaFor(room).maxPlayers;
    if ((room.seats || []).length >= max) {
      return res.status(400).json({ error: "房间已满（最多 " + max + " 人）" });
    }

    const name = String(body.name || "").trim().slice(0, 16) || ("玩家" + (room.seats.length + 1));
    const seat = addSeat(room, name, null);
    seatPendingInvites(room);
    saveRoom(room);
    broadcast(room);
    res.json({
      ok: true, code: room.code, game: room.game, playerId: seat.playerId, playerToken: seat.playerToken,
      name: seat.name, color: seat.color, isHost: seat.isHost, rejoined: false
    });
  });

  // POST /cards/api/rooms/:code/start {playerToken} — 仅房主，人数按引擎 meta 把关
  api.post("/rooms/:code/start", scopeGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const token = (req.body && req.body.playerToken) || "";
    const host = (room.seats || [])[0];
    if (!host || token !== host.playerToken) return res.status(403).json({ error: "只有房主可以开局" });
    if (room.started) return res.status(400).json({ error: "牌局已经开始了" });
    const engine = engineOf(room);
    if (!engine) return res.status(503).json({ error: "「" + room.game + "」的引擎还没就绪，开不了局" });
    const meta = metaFor(room);
    if (room.seats.length < meta.minPlayers) {
      return res.status(400).json({ error: "至少要 " + meta.minPlayers + " 个人才能开局" });
    }

    const rules = resolveRules(room.game, room.rules);
    let state;
    try {
      state = engine.createGame({
        players: room.seats.map(function (s) {
          return { id: s.playerId, name: s.name, isAI: !!s.isAI };
        }),
        // 双保险:引擎读规则的姿势不一(有读 config 平铺的、有读 rules 的),都给
        // (daifugo 当年就是这里握手失败,房间开关空转了一天)
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

  // GET /cards/api/rooms/:code/state?token= → viewFor 脱敏视图（无 token=观战）
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

  // GET /cards/api/rooms/:code/events?token= → SSE（连上先推自己的视图，25s :ping）
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

  // POST /cards/api/rooms/:code/action {playerToken, type, ...}
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

  // POST /cards/api/rooms/:code/chat {playerToken?, name?, text} — 牌桌闲聊
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
    scheduleExternalChatWake(room); // 人话才捎信;agent 通道的发言不叫(它自言自语不用醒)
    res.json({ ok: true });
  });

  // POST /cards/api/rooms/:code/close {playerToken?} — 关房:踢线+删档。
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

  // GET /cards/api/agent/rooms → 大厅列表（含哪些房有 agent 座位）
  api.get("/agent/rooms", agentGuard, function (req, res) {
    res.json({ ok: true, games: gamesCatalog(), rooms: listRooms(20, null).map(summarize) });
  });

  // POST /cards/api/agent/:code/join {agent_id, name} → 入座（幂等）
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
        ok: true, code: room.code, game: room.game, playerId: existing.playerId, name: existing.name,
        isHost: !!existing.isHost, rejoined: true
      });
    }

    if (room.started) return res.status(400).json({ error: "牌局已开始，无法入座" });
    const max = metaFor(room).maxPlayers;
    if ((room.seats || []).length >= max) {
      return res.status(400).json({ error: "房间已满（最多 " + max + " 人）" });
    }

    const name = String(body.name || "").trim().slice(0, 16) || agentId;
    const seat = addSeat(room, name, { isAI: true, agentId: agentId });
    room.agentSeats[agentId] = seat.playerId;
    saveRoom(room);
    broadcast(room);
    res.json({
      ok: true, code: room.code, game: room.game, playerId: seat.playerId, name: seat.name,
      isHost: seat.isHost, rejoined: false
    });
  });

  // GET /cards/api/agent/:code/view?agent_id= → {view, legal, yourTurn}
  api.get("/agent/:code/view", agentGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const agentId = typeof req.query.agent_id === "string" ? req.query.agent_id : "";
    const seat = seatByAgent(room, agentId);
    if (!seat) return res.status(404).json({ error: "这个 agent 还没在这房间入座" });
    const st = room.state;
    const engine = engineOf(room);
    const current = st && st.current
      ? (room.seats.find(function (s) { return s.playerId === st.current; }) || null)
      : null;
    const legal = legalOf(room, seat.playerId);
    res.json({
      ok: true,
      code: room.code,
      name: room.name,
      game: room.game,
      gameName: metaFor(room).name,
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
      legal: legal,
      // 人话层：简报和招式排版由引擎自己出，工具端直接抄，免得每个游戏再写一套
      briefing: st ? safeBriefing(engine, st, seat.playerId) : "",
      moveLines: legal.map(function (m) { return safeFmtMove(engine, m); })
    });
  });

  // POST /cards/api/agent/:code/act {agent_id, type, ...}
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
    const engine = engineOf(room);
    const current = st && st.current
      ? (room.seats.find(function (s) { return s.playerId === st.current; }) || null)
      : null;
    const legal = legalOf(room, seat.playerId);
    res.json({
      ok: true,
      seq: st && typeof st.seq === "number" ? st.seq : 0,
      events: out.events,
      game: room.game,
      currentName: current ? current.name : null,
      yourTurn: isYourTurn(room, seat.playerId),
      view: viewOf(room, seat.playerId),
      legal: legal,
      briefing: st ? safeBriefing(engine, st, seat.playerId) : "",
      moveLines: legal.map(function (m) { return safeFmtMove(engine, m); })
    });
  });

  // POST /cards/api/agent/:code/chat {agent_id, text} — agent 在牌桌上说话
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

  app.use("/cards/api", api);

  // GET /cards/engine/<game>.js → 原样送对应引擎源码（前端复用判定逻辑做预判）
  app.get("/cards/engine/:file", function (req, res) {
    const m = String(req.params.file || "").match(/^([a-z0-9_-]+)\.js$/i);
    const game = m ? m[1].toLowerCase() : null;
    if (!game || GAME_KEYS.indexOf(game) === -1) {
      return res.status(404).json({ error: "没有这个游戏的引擎" });
    }
    fs.readFile(enginePaths[game], "utf8", function (err, src) {
      if (err) return res.status(404).json({ error: "「" + game + "」的引擎还没就位" });
      res.set("Content-Type", "application/javascript; charset=utf-8");
      res.set("Cache-Control", "no-cache");
      res.send(src);
    });
  });

  // 静态托管 public/
  app.use("/cards", express.static(publicDir, { extensions: ["html"], index: "index.html" }));
  app.get("/", function (req, res) { res.redirect("/cards/"); });

  app.use(function (req, res) { res.status(404).json({ error: "路径不存在" }); });

  // eslint-disable-next-line no-unused-vars
  app.use(function (err, req, res, next) {
    console.error("[cards] error", err && err.stack ? err.stack : err);
    if (res.headersSent) return res.end();
    res.status(500).json({ error: (err && err.message) || "服务器内部错误" });
  });

  const server = http.createServer(app);

  const config = ensureConfig();

  // 重启前正轮到自动 AI 的局，起来就接着走
  try {
    resumeAuto();
  } catch (e) {
    console.warn("[cards] 启动扫描自动座位失败：" + (e && e.message));
  }

  return {
    app: app,
    server: server,
    dataDir: dataDir,
    roomsDir: roomsDir,
    configFile: configFile,
    engines: engines,
    enginePaths: enginePaths,
    games: GAME_KEYS,
    internalKey: function () { return internalKey(); },
    openMode: openMode, // true = 没设密码，谁都是主人
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

module.exports = { createServer: createServer, ENGINES: ENGINES, GAMES: GAME_LIST };

if (require.main === module) {
  const inst = createServer({});
  inst.cleanupRooms();
  const missing = inst.games.filter(function (g) { return !inst.engines[g]; });
  if (missing.length) console.warn("[cards] 引擎缺席：" + missing.join(" / ") + "（这些游戏建房会 503）");
  const port = parseInt(process.env.PORT, 10) || DEFAULT_PORT;
  if (inst.openMode) {
    console.warn("[cards] open mode：没设 BISCA_PASSWORD，任何能连上这个端口的人都是主人。" +
      "公网部署请设密码。");
  }
  inst.start(port, process.env.HOST || DEFAULT_HOST).then(function (p) {
    console.log("[cards] listening on " + (process.env.HOST || DEFAULT_HOST) + ":" + p +
      " (data: " + inst.dataDir + ", host: " + os.hostname() + ")");
  }).catch(function (e) {
    console.error("[cards] failed to listen:", e && e.message);
    process.exit(1);
  });
}
