#!/usr/bin/env node
"use strict";
// 大富翁独立服务端。默认监听 127.0.0.1:8078，自成一体、可自由重启。
// 唯一运行时依赖是 express，无 ws、无数据库。
// 落盘即真相：rooms/<code>.json 每步 tmp+rename 原子写，进程内存只是缓存。

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const { createHmac, timingSafeEqual, randomBytes, randomInt } = require("crypto");

const DEFAULT_PORT = 8078;
const DEFAULT_HOST = "127.0.0.1";
const COOKIE_NAME = "bisca_auth";
const COOKIE_MAX_AGE_MS = 90 * 24 * 3600 * 1000; // 登录态有效期 90 天
const MAX_SEATS = 4;
const MAX_ROOM_FILES = 200;
const STALE_ROOM_MS = 7 * 24 * 3600 * 1000;
const SSE_PING_MS = 25000;
// 主题三件套（boot.js / icons.js / base.css）和字体随仓库发布，三个服务共用同一份。
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const FONTS_DIR = path.join(__dirname, "..", "fonts");
const STATIC_MAX_AGE = "1d";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去掉 I L O 0 1
const SEAT_COLORS = ["#ff5c8a", "#5cc8ff", "#ffd45c", "#7dff9e"];
// 随仓库发布的默认棋盘/牌堆，首次启动复制进 data/ 供用户自己改
const DEFAULTS_DIR = path.join(__dirname, "defaults");
const SEED_FILES = ["board.json", "cards.json", "config.json"];

// ── 配置读取 ────────────────────────────────────────────────────────────────

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

// tmp + rename 原子写（跟房间落盘同一套路，写坏了也不会留下半截文件）
function writeJsonAtomic(file, value) {
  const tmp = file + "." + process.pid + "." + randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// cookie 签名密钥落在 data/config.json 的 cookie_secret 字段，首次启动自动生成。
function ensureCookieSecret(dataDir) {
  const file = path.join(dataDir, "config.json");
  const cfg = readJsonSafe(file, null) || {};
  if (typeof cfg.cookie_secret === "string" && cfg.cookie_secret.length >= 32) {
    return cfg.cookie_secret;
  }
  cfg.cookie_secret = randomBytes(32).toString("hex");
  if (cfg.allow_guests === undefined) cfg.allow_guests = false;
  try {
    writeJsonAtomic(file, cfg);
    try { fs.chmodSync(file, 0o600); } catch (e2) { /* 文件系统不支持就算了 */ }
  } catch (e) {
    console.warn("[monopoly] config.json 写不进去（" + (e && e.message) + "），本次用临时密钥，重启后登录态会失效");
  }
  return cfg.cookie_secret;
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function isValidCode(code) {
  return typeof code === "string" && /^[A-Z0-9]{6}$/.test(code);
}

function randomCode() {
  let out = "";
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return out;
}

// 脱敏：座位 token / invite token 绝不出现在 state 或 SSE 里。
function stripTokens(value) {
  if (Array.isArray(value)) return value.map(stripTokens);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      if (k === "playerToken" || k === "inviteToken" || k === "token" || k === "cookie_secret") continue;
      out[k] = stripTokens(value[k]);
    }
    return out;
  }
  return value;
}

function publicSeats(room) {
  return (room.seats || []).map(function (s) {
    return { playerId: s.playerId, name: s.name, color: s.color, isHost: !!s.isHost };
  });
}

function roomSummary(room) {
  const st = room.state || null;
  return {
    code: room.code,
    name: room.name,
    createdAt: room.createdAt,
    started: !!room.started,
    finished: !!(st && st.winner),
    winner: (st && st.winner) || null,
    playerCount: (room.seats || []).length,
    players: publicSeats(room),
    seq: st && typeof st.seq === "number" ? st.seq : 0
  };
}

// ── 服务工厂 ────────────────────────────────────────────────────────────────

function createServer(options) {
  const opts = options || {};
  const dataDir = opts.dataDir || process.env.BISCA_DATA_DIR || path.join(__dirname, "data");
  const roomsDir = path.join(dataDir, "rooms");
  const publicDir = opts.publicDir || path.join(__dirname, "public");
  const engine = opts.engine || require(opts.enginePath || "./engine.cjs");
  // 设了 BISCA_PASSWORD = 开启登录；没设 = open mode（自托管内网场景，人人 owner）。
  const password = opts.password !== undefined ? opts.password : (process.env.BISCA_PASSWORD || "");
  const loginRequired = !!password;

  ensureDir(roomsDir);
  seedDefaults();

  const cookieSecret = opts.cookieSecret || ensureCookieSecret(dataDir);

  // 首次启动把随仓库发布的默认棋盘/牌堆复制进 data/，用户改的是自己的副本。
  function seedDefaults() {
    for (const f of SEED_FILES) {
      const dst = path.join(dataDir, f);
      if (fs.existsSync(dst)) continue;
      const src = path.join(DEFAULTS_DIR, f);
      try {
        const data = readJsonSafe(src, null);
        if (data) writeJsonAtomic(dst, data);
      } catch (e) {
        console.warn("[monopoly] 默认 " + f + " 复制失败：" + (e && e.message));
      }
    }
  }

  const rooms = new Map(); // code -> room（内存缓存，盘上是真相）
  const sseClients = new Map(); // code -> Set<res>
  const allSse = new Set();

  // ── 认证 ──
  // cookie 值 = "authenticated.<签发ms>" + "." + HMAC-SHA256(签发值)，密钥来自 config.json。

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

  // ── 数据文件（热读）──

  function loadConfig() {
    const cfg = readJsonSafe(path.join(dataDir, "config.json"), {});
    if (!cfg || typeof cfg !== "object") return {};
    return cfg;
  }

  // 交给引擎的那份配置：cookie_secret 绝不能进 state（state 会整份广播给所有人）。
  function gameConfig() {
    const cfg = loadConfig();
    const out = {};
    for (const k of Object.keys(cfg)) {
      if (k === "cookie_secret" || k === "_readme") continue;
      out[k] = cfg[k];
    }
    return out;
  }

  function guestsAllowed() {
    return loadConfig().allow_guests === true;
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
    return room;
  }

  function saveRoom(room) {
    room.updatedAt = Date.now();
    const target = roomPath(room.code);
    const tmp = target + "." + process.pid + "." + randomBytes(4).toString("hex") + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(room, null, 2));
    fs.renameSync(tmp, target);
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

  function findRoomByInvite(token) {
    if (!token || typeof token !== "string") return null;
    for (const code of listRoomCodes()) {
      const room = loadRoom(code);
      if (room && room.inviteToken && room.inviteToken === token) return room;
    }
    return null;
  }

  // 启动清理：rooms/ 超 200 个文件时删最旧的"已结束"房间
  //（state.winner 非空，或未 started 且超 7 天）。
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
      const finished = !!(room.state && room.state.winner);
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
    if (removed) console.log("[monopoly] cleanup removed " + removed + " finished room file(s)");
    return removed;
  }

  // ── SSE 广播 ──

  function statePayload(room) {
    return {
      code: room.code,
      name: room.name,
      started: !!room.started,
      seats: publicSeats(room),
      seq: room.state && typeof room.state.seq === "number" ? room.state.seq : 0,
      state: room.state ? stripTokens(room.state) : null
    };
  }

  function broadcast(room) {
    const set = sseClients.get(room.code);
    if (!set || !set.size) return;
    const data = "event: state\ndata: " + JSON.stringify(statePayload(room)) + "\n\n";
    for (const res of set) {
      try {
        res.write(data);
      } catch (e) { /* 断开的客户端由 close 事件清理 */ }
    }
  }

  // ── express ──

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));

  // 主题 + 字体：本地静态，挂在认证门之前（登录页自己也要用）。
  // 两套挂载点：裸路径给直连，/monopoly 前缀给按路径分流的反代。
  const themeStatic = express.static(ASSETS_DIR, { maxAge: STATIC_MAX_AGE });
  const fontStatic = express.static(FONTS_DIR, { maxAge: STATIC_MAX_AGE });
  ["", "/monopoly"].forEach(function (prefix) {
    app.use(prefix + "/assets-theme", themeStatic);
    app.use(prefix + "/fonts", fontStatic);
  });

  // ── 登录（只在设了 BISCA_PASSWORD 时才有意义，这两条路由在认证门之前）──

  function isHttps(req) {
    if (req.secure) return true;
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    return proto === "https";
  }

  // 先各自过一遍 HMAC 再比，两边长度恒等，连密码长度都不漏
  function passwordMatches(given) {
    const a = createHmac("sha256", cookieSecret).update(String(given)).digest();
    const b = createHmac("sha256", cookieSecret).update(String(password)).digest();
    return timingSafeEqual(a, b);
  }

  // 只允许跳回本站路径，挡掉 ?r=//evil.com 这类开放重定向
  function safeReturn(raw) {
    const s = typeof raw === "string" ? raw : "";
    return /^\/[^/\\]/.test(s) ? s : "/monopoly/";
  }

  function loginPage(returnTo, failed) {
    return "<!DOCTYPE html><html lang=\"zh\"><head><meta charset=\"UTF-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">" +
      "<title>大富翁 · 登录</title><style>" +
      "*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;" +
      "background:#0a0a0f;color:#e8e8f0;font:16px/1.5 system-ui,-apple-system,\"PingFang SC\",\"Microsoft YaHei\",sans-serif}" +
      "form{width:100%;max-width:320px;padding:28px 24px;background:#15151f;border:1px solid #2a2a38;border-radius:18px}" +
      "h1{margin:0 0 4px;font-size:19px}p{margin:0 0 18px;font-size:13px;color:#8a8a9c}" +
      "input{width:100%;padding:11px 12px;font:inherit;color:#fff;background:#0f0f16;border:1px solid #33334a;" +
      "border-radius:12px;outline:none}input:focus{border-color:#7b7bff}" +
      "button{width:100%;margin-top:14px;min-height:44px;font:inherit;font-weight:600;color:#fff;cursor:pointer;" +
      "background:#4b4bd8;border:none;border-radius:12px}.err{margin:12px 0 0;font-size:13px;color:#ff7b93}" +
      "</style></head><body><form method=\"post\" action=\"/monopoly/api/login\">" +
      "<h1>大富翁</h1><p>输入房主设的密码进门</p>" +
      "<input type=\"hidden\" name=\"r\" value=\"" + escapeHtml(returnTo) + "\">" +
      "<input type=\"password\" name=\"password\" placeholder=\"密码\" autofocus autocomplete=\"current-password\">" +
      "<button type=\"submit\">进门</button>" +
      (failed ? "<p class=\"err\">密码不对，再试一次</p>" : "") +
      "</form></body></html>";
  }

  app.get(["/monopoly/login", "/login"], function (req, res) {
    if (!loginRequired) return res.redirect("/monopoly/");
    res.type("html").send(loginPage(safeReturn(req.query.r), req.query.e === "1"));
  });

  app.post(["/monopoly/api/login", "/api/login"], express.urlencoded({ extended: false, limit: "8kb" }), function (req, res) {
    const wantsJson = String(req.headers.accept || "").includes("application/json");
    const back = safeReturn(req.body && req.body.r);
    if (!loginRequired) {
      return wantsJson ? res.json({ ok: true, redirect: back }) : res.redirect(back);
    }
    const given = (req.body && req.body.password) || "";
    if (!passwordMatches(given)) {
      if (wantsJson) return res.status(401).json({ error: "密码不对" });
      return res.redirect("/monopoly/login?e=1&r=" + encodeURIComponent(back));
    }
    const value = "authenticated." + Date.now();
    res.cookie(COOKIE_NAME, signCookie(value), {
      httpOnly: true,
      sameSite: "lax",
      secure: isHttps(req),
      maxAge: COOKIE_MAX_AGE_MS,
      path: "/"
    });
    return wantsJson ? res.json({ ok: true, redirect: back }) : res.redirect(back);
  });

  // 认证门：open mode 人人 owner；开了登录则 cookie = owner 级，
  // allow_guests 开启时合法 invite = 该房间的 guest。
  function deny(res, req) {
    // 浏览器直接打开页面（未登录/cookie 过期）→ 跳本服务自己的登录页；
    // API/fetch 请求照旧 JSON 403。
    if (req && req.method === "GET" && String(req.headers.accept || "").includes("text/html")) {
      return res.redirect("/monopoly/login?r=" + encodeURIComponent(req.originalUrl || "/monopoly/"));
    }
    return res.status(403).json({ error: "未授权：请先登录，或使用有效的房间邀请链接" });
  }

  app.use(function authGate(req, res, next) {
    if (!loginRequired) {
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

  function requireRoom(req, res) {
    const room = loadRoom(req.params.code);
    if (!room) {
      res.status(404).json({ error: "房间不存在" });
      return null;
    }
    return room;
  }

  const api = express.Router();

  // POST /monopoly/api/rooms {name} → {code, inviteToken}
  api.post("/rooms", function (req, res) {
    if (req.authLevel !== "owner") return deny(res);
    const name = String((req.body && req.body.name) || "").trim().slice(0, 24) || "未命名房间";
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
      seats: [],
      started: false,
      state: null
    };
    saveRoom(room);
    res.json({ ok: true, code: room.code, name: room.name, inviteToken: room.inviteToken });
  });

  // GET /monopoly/api/rooms → 大厅列表（近 20 个）
  api.get("/rooms", function (req, res) {
    if (req.authLevel !== "owner") return deny(res);
    const list = listRoomCodes()
      .map(function (c) { return loadRoom(c); })
      .filter(Boolean)
      .sort(function (a, b) { return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0); })
      .slice(0, 20)
      .map(roomSummary);
    res.json({ ok: true, rooms: list });
  });

  // POST /monopoly/api/rooms/:code/join {name, color, playerToken?} → {playerId, playerToken}
  api.post("/rooms/:code/join", scopeGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const body = req.body || {};

    // 带旧 token 回来 = 复座（刷新/断线重进）
    if (body.playerToken) {
      const seat = (room.seats || []).find(function (s) { return s.playerToken === body.playerToken; });
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
    let color = typeof body.color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : null;
    const taken = room.seats.map(function (s) { return (s.color || "").toLowerCase(); });
    if (!color || taken.indexOf(color.toLowerCase()) !== -1) {
      color = SEAT_COLORS.find(function (c) { return taken.indexOf(c.toLowerCase()) === -1; }) || SEAT_COLORS[0];
    }
    const seat = {
      playerId: "p" + (room.seats.length + 1),
      playerToken: randomBytes(16).toString("hex"),
      name: name,
      color: color,
      isHost: room.seats.length === 0
    };
    room.seats.push(seat);
    saveRoom(room);
    broadcast(room);
    res.json({
      ok: true, code: room.code, playerId: seat.playerId, playerToken: seat.playerToken,
      name: seat.name, color: seat.color, isHost: seat.isHost, rejoined: false
    });
  });

  // POST /monopoly/api/rooms/:code/start {playerToken} — 仅房主，≥2 人
  api.post("/rooms/:code/start", scopeGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const token = (req.body && req.body.playerToken) || "";
    const host = (room.seats || [])[0];
    if (!host || token !== host.playerToken) return res.status(403).json({ error: "只有房主可以开局" });
    if (room.started) return res.status(400).json({ error: "牌局已经开始了" });
    if (room.seats.length < 2) return res.status(400).json({ error: "至少要 2 个人才能开局" });

    const board = readJsonSafe(path.join(dataDir, "board.json"), null);
    const cards = readJsonSafe(path.join(dataDir, "cards.json"), null);
    const config = gameConfig();
    if (!board) console.warn("[monopoly] board.json 缺失：" + path.join(dataDir, "board.json"));
    if (!cards) console.warn("[monopoly] cards.json 缺失：" + path.join(dataDir, "cards.json"));

    let state;
    try {
      state = engine.createGame({
        players: room.seats.map(function (s) {
          return { id: s.playerId, name: s.name, color: s.color };
        }),
        board: board,
        cards: cards,
        config: config,
        seed: randomInt(1, 2147483647)
      });
    } catch (e) {
      return res.status(400).json({ error: e && e.message ? e.message : "开局失败" });
    }
    room.started = true;
    room.startedAt = Date.now();
    room.state = state;
    saveRoom(room);
    broadcast(room);
    res.json({ ok: true, code: room.code, seq: state && state.seq });
  });

  // GET /monopoly/api/rooms/:code/state → 脱敏 state
  api.get("/rooms/:code/state", scopeGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    const payload = statePayload(room);
    payload.ok = true;
    if (req.authLevel === "owner") payload.inviteToken = room.inviteToken;
    res.json(payload);
  });

  // GET /monopoly/api/rooms/:code/events → SSE（连上先推全量 state，25s :ping）
  api.get("/rooms/:code/events", scopeGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write("retry: 3000\n\n");
    res.write("event: state\ndata: " + JSON.stringify(statePayload(room)) + "\n\n");

    if (!sseClients.has(room.code)) sseClients.set(room.code, new Set());
    sseClients.get(room.code).add(res);
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
        set.delete(res);
        if (!set.size) sseClients.delete(room.code);
      }
      allSse.delete(res);
    }
    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  // POST /monopoly/api/rooms/:code/action {playerToken, type, ...}
  api.post("/rooms/:code/action", scopeGuard, function (req, res) {
    const room = requireRoom(req, res);
    if (!room) return;
    if (!room.started || !room.state) return res.status(400).json({ error: "牌局还没开始" });
    const body = req.body || {};
    const seat = (room.seats || []).find(function (s) { return s.playerToken === body.playerToken; });
    if (!seat) return res.status(403).json({ error: "你没有座位（观战中）" });
    if (!body.type) return res.status(400).json({ error: "缺少动作类型" });

    const action = {};
    for (const k of Object.keys(body)) {
      if (k !== "playerToken") action[k] = body[k];
    }

    let out;
    try {
      out = engine.apply(room.state, seat.playerId, action);
    } catch (e) {
      return res.status(400).json({ error: e && e.message ? e.message : "非法动作" });
    }
    const nextState = out && out.state ? out.state : out;
    room.state = nextState;
    saveRoom(room);
    broadcast(room);
    res.json({
      ok: true,
      seq: nextState && typeof nextState.seq === "number" ? nextState.seq : 0,
      events: (out && out.events) || []
    });
  });

  app.use("/monopoly/api", api);

  // 静态托管 public/
  app.use("/monopoly", express.static(publicDir, { extensions: ["html"], index: "index.html" }));
  app.get("/", function (req, res) { res.redirect("/monopoly/"); });

  app.use(function (req, res) { res.status(404).json({ error: "路径不存在" }); });

  // eslint-disable-next-line no-unused-vars
  app.use(function (err, req, res, next) {
    console.error("[monopoly] error", err && err.stack ? err.stack : err);
    if (res.headersSent) return res.end();
    res.status(500).json({ error: (err && err.message) || "服务器内部错误" });
  });

  const server = http.createServer(app);

  return {
    app: app,
    server: server,
    dataDir: dataDir,
    roomsDir: roomsDir,
    engine: engine,
    cleanupRooms: cleanupRooms,
    signCookie: signCookie,
    loginRequired: loginRequired,
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
    console.log("[monopoly] listening on " + (process.env.HOST || DEFAULT_HOST) + ":" + p +
      " (data: " + inst.dataDir + ", host: " + os.hostname() + ")");
    if (!inst.loginRequired) {
      console.log("[monopoly] open mode：没设 BISCA_PASSWORD，任何能连到本端口的人都是房主。" +
        "要暴露到公网请先设密码。");
    }
  }).catch(function (e) {
    console.error("[monopoly] failed to listen:", e && e.message);
    process.exit(1);
  });
}
