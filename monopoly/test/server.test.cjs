"use strict";
// node --test test/server.test.cjs
// 起临时端口实例 + 临时 dataDir，走完：403 → 建房 → 双人入座 → start → action →
// state seq 增长 → SSE 收到 state → 重启恢复。engine 用 stub 注入。
// 主体这一串跑在「设了密码」的登录模式下；文件末尾另有 open mode / 登录页 / 访客邀请三组。

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac } = require("node:crypto");

const { createServer } = require("../server.cjs");
const engineStub = require("./engine-stub.cjs");

const SECRET = "test-secret-for-monopoly";
const PASSWORD = "test-password";
const cookieValue = "authenticated." + Date.now();
const COOKIE = "bisca_auth=" + cookieValue + "." +
  createHmac("sha256", SECRET).update(cookieValue).digest("base64url");

let tmpDir = null;
let inst = null;
let base = "";

// 房间/座位在多个 test 之间传递
const ctx = { code: null, inviteToken: null, host: null, guest: null, seqAfterStart: 0 };

async function boot() {
  inst = createServer({ dataDir: tmpDir, engine: engineStub, cookieSecret: SECRET, password: PASSWORD });
  const port = await inst.start(0, "127.0.0.1");
  base = "http://127.0.0.1:" + port;
}

function api(p, init) {
  const o = Object.assign({}, init);
  o.headers = Object.assign({ "content-type": "application/json", cookie: COOKIE }, o.headers || {});
  return fetch(base + p, o);
}

before(async function () {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "monopoly-test-"));
  await boot();
});

after(async function () {
  if (inst) await inst.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("无凭证（无 cookie 无 invite）一律 403 JSON", async function () {
  const r = await fetch(base + "/monopoly/api/rooms");
  assert.strictEqual(r.status, 403);
  const body = await r.json();
  assert.ok(body.error, "403 应带中文 error 字段");

  const r2 = await fetch(base + "/monopoly/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "偷跑房" })
  });
  assert.strictEqual(r2.status, 403);
});

test("带合法签名 cookie 可以建房", async function () {
  const r = await api("/monopoly/api/rooms", { method: "POST", body: JSON.stringify({ name: "测试房间" }) });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.match(body.code, /^[A-Z0-9]{6}$/);
  assert.strictEqual(typeof body.inviteToken, "string");
  assert.strictEqual(body.inviteToken.length, 32);
  ctx.code = body.code;
  ctx.inviteToken = body.inviteToken;
  assert.ok(fs.existsSync(path.join(tmpDir, "rooms", body.code + ".json")), "房间文件应已落盘");
});

test("双人入座，第一个是房主", async function () {
  const r1 = await api("/monopoly/api/rooms/" + ctx.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "甲", color: "#ff5c8a" })
  });
  assert.strictEqual(r1.status, 200);
  ctx.host = await r1.json();
  assert.strictEqual(ctx.host.isHost, true);
  assert.strictEqual(ctx.host.playerId, "p1");
  assert.strictEqual(typeof ctx.host.playerToken, "string");

  const r2 = await api("/monopoly/api/rooms/" + ctx.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "乙" })
  });
  assert.strictEqual(r2.status, 200);
  ctx.guest = await r2.json();
  assert.strictEqual(ctx.guest.isHost, false);
  assert.strictEqual(ctx.guest.playerId, "p2");
  assert.notStrictEqual(ctx.guest.playerToken, ctx.host.playerToken);
});

test("非房主不能 start；房主可以", async function () {
  const bad = await api("/monopoly/api/rooms/" + ctx.code + "/start", {
    method: "POST", body: JSON.stringify({ playerToken: ctx.guest.playerToken })
  });
  assert.strictEqual(bad.status, 403);

  const r = await api("/monopoly/api/rooms/" + ctx.code + "/start", {
    method: "POST", body: JSON.stringify({ playerToken: ctx.host.playerToken })
  });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.ok, true);
  ctx.seqAfterStart = body.seq;
});

test("action(roll) 后 seq 增长，state 里没有任何座位 token", async function () {
  const before = await (await api("/monopoly/api/rooms/" + ctx.code + "/state")).json();
  assert.strictEqual(before.seq, ctx.seqAfterStart);

  const r = await api("/monopoly/api/rooms/" + ctx.code + "/action", {
    method: "POST", body: JSON.stringify({ playerToken: ctx.host.playerToken, type: "roll" })
  });
  assert.strictEqual(r.status, 200);
  const acted = await r.json();
  assert.strictEqual(acted.ok, true);
  assert.strictEqual(acted.seq, before.seq + 1);

  const after = await (await api("/monopoly/api/rooms/" + ctx.code + "/state")).json();
  assert.strictEqual(after.seq, before.seq + 1);
  assert.deepStrictEqual(after.state.dice, [3, 4]);

  const dump = JSON.stringify(after.state);
  assert.ok(dump.indexOf(ctx.host.playerToken) === -1, "state 不得包含房主 token");
  assert.ok(dump.indexOf(ctx.guest.playerToken) === -1, "state 不得包含玩家 token");
  assert.ok(JSON.stringify(after.seats).indexOf(ctx.host.playerToken) === -1, "seats 不得包含 token");
  assert.ok(after.seats.every(function (s) { return s.playerId && !s.playerToken; }));
});

test("非法动作 → 400 + 中文 error；无座位 token → 403", async function () {
  const r = await api("/monopoly/api/rooms/" + ctx.code + "/action", {
    method: "POST", body: JSON.stringify({ playerToken: ctx.guest.playerToken, type: "roll" })
  });
  assert.strictEqual(r.status, 400);
  const body = await r.json();
  assert.strictEqual(body.error, "还没轮到你行动");

  const spectator = await api("/monopoly/api/rooms/" + ctx.code + "/action", {
    method: "POST", body: JSON.stringify({ playerToken: "deadbeef", type: "roll" })
  });
  assert.strictEqual(spectator.status, 403);
});

test("SSE 连上能收到 state 事件", async function () {
  const ac = new AbortController();
  const r = await fetch(base + "/monopoly/api/rooms/" + ctx.code + "/events", {
    headers: { cookie: COOKIE, accept: "text/event-stream" },
    signal: ac.signal
  });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/event-stream/);

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let payload = null;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const m = buf.match(/event: state\ndata: (.+)\n\n/);
      if (m) { payload = JSON.parse(m[1]); break; }
    }
  } finally {
    ac.abort();
  }
  assert.ok(payload, "应收到至少一条 state 事件");
  assert.strictEqual(payload.code, ctx.code);
  assert.strictEqual(payload.started, true);
  assert.strictEqual(payload.state.players.length, 2);
  assert.ok(JSON.stringify(payload).indexOf(ctx.host.playerToken) === -1, "SSE 不得包含 token");
});

test("大厅列表能看到这个房间", async function () {
  const body = await (await api("/monopoly/api/rooms")).json();
  const found = body.rooms.find(function (x) { return x.code === ctx.code; });
  assert.ok(found, "大厅应列出该房间");
  assert.strictEqual(found.started, true);
  assert.strictEqual(found.playerCount, 2);
});

test("销毁实例重建（同 dataDir）后棋局还在 —— 重启恢复", async function () {
  const before = await (await api("/monopoly/api/rooms/" + ctx.code + "/state")).json();
  await inst.stop();
  await boot();

  const after = await (await api("/monopoly/api/rooms/" + ctx.code + "/state")).json();
  assert.strictEqual(after.seq, before.seq);
  assert.strictEqual(after.started, true);
  assert.deepStrictEqual(after.state.players.map(function (p) { return p.name; }), ["甲", "乙"]);

  // 旧 token 依然能行动（座位存在盘上）
  const r = await api("/monopoly/api/rooms/" + ctx.code + "/action", {
    method: "POST", body: JSON.stringify({ playerToken: ctx.host.playerToken, type: "end_turn" })
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).seq, before.seq + 1);
});

test("未知房间 404，未知路径 404", async function () {
  const r = await api("/monopoly/api/rooms/ZZZZZZ/state");
  assert.strictEqual(r.status, 404);
  const r2 = await api("/monopoly/api/nope");
  assert.strictEqual(r2.status, 404);
});

// ── 认证模式 ───────────────────────────────────────────────────────────────

/** 起一个一次性实例，跑完回收 */
async function withServer(options, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monopoly-auth-"));
  const one = createServer(Object.assign({ dataDir: dir, engine: engineStub }, options || {}));
  const port = await one.start(0, "127.0.0.1");
  try {
    await fn("http://127.0.0.1:" + port, one, dir);
  } finally {
    await one.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("open mode（没设密码）：无 cookie 也是 owner 级", async function () {
  await withServer({ password: "" }, async function (b, one) {
    assert.strictEqual(one.loginRequired, false);
    const r = await fetch(b + "/monopoly/api/rooms");
    assert.strictEqual(r.status, 200);
    const mk = await fetch(b + "/monopoly/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "裸奔房" })
    });
    assert.strictEqual(mk.status, 200);
    assert.match((await mk.json()).code, /^[A-Z0-9]{6}$/);

    // open mode 下登录页没意义，直接跳回大厅
    const login = await fetch(b + "/monopoly/login", { redirect: "manual" });
    assert.strictEqual(login.status, 302);
    assert.strictEqual(login.headers.get("location"), "/monopoly/");
  });
});

test("cookie_secret 首次启动自动生成并落 config.json", async function () {
  await withServer({ password: "" }, async function (b, one, dir) {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.match(cfg.cookie_secret, /^[0-9a-f]{64}$/, "应是 32 字节 hex");
    assert.strictEqual(cfg.allow_guests, false);
    // 默认棋盘/牌堆也该被复制进 data/
    assert.ok(fs.existsSync(path.join(dir, "board.json")));
    assert.ok(fs.existsSync(path.join(dir, "cards.json")));
  });
});

test("登录模式：页面请求 302 到登录页，密码对了才发 cookie", async function () {
  await withServer({ password: "hunter2", cookieSecret: SECRET }, async function (b) {
    // 未登录的 HTML 请求 → 跳本服务自己的登录页
    const page = await fetch(b + "/monopoly/", { headers: { accept: "text/html" }, redirect: "manual" });
    assert.strictEqual(page.status, 302);
    assert.match(page.headers.get("location") || "", /^\/monopoly\/login\?r=/);

    // 登录页本身可访问
    const form = await fetch(b + "/monopoly/login");
    assert.strictEqual(form.status, 200);
    assert.match(await form.text(), /<form[^>]+action="\/monopoly\/api\/login"/);

    // 密码错 → 401（JSON 口径）
    const bad = await fetch(b + "/monopoly/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ password: "nope" })
    });
    assert.strictEqual(bad.status, 401);
    assert.ok(!(bad.headers.get("set-cookie") || "").includes("bisca_auth"));

    // 密码对 → 发 cookie
    const ok = await fetch(b + "/monopoly/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ password: "hunter2", r: "/monopoly/" })
    });
    assert.strictEqual(ok.status, 200);
    const setCookie = ok.headers.get("set-cookie") || "";
    assert.match(setCookie, /bisca_auth=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);

    // 拿这枚 cookie 就能进门了
    const jar = setCookie.split(";")[0];
    const listed = await fetch(b + "/monopoly/api/rooms", { headers: { cookie: jar } });
    assert.strictEqual(listed.status, 200);

    // 表单口径（无 JS）：密码错回登录页带 e=1，对了 302 回原路径
    const formBad = await fetch(b + "/monopoly/api/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=nope&r=/monopoly/",
      redirect: "manual"
    });
    assert.strictEqual(formBad.status, 302);
    assert.match(formBad.headers.get("location") || "", /^\/monopoly\/login\?e=1/);

    const formOk = await fetch(b + "/monopoly/api/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=hunter2&r=//evil.example.com",
      redirect: "manual"
    });
    assert.strictEqual(formOk.status, 302);
    assert.strictEqual(formOk.headers.get("location"), "/monopoly/", "外站跳转必须被挡回大厅");
  });
});

test("访客邀请：allow_guests 开了才认 invite，且只摸得到自己那间房", async function () {
  await withServer({ password: "hunter2", cookieSecret: SECRET }, async function (b, one, dir) {
    const mk = await fetch(b + "/monopoly/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: COOKIE },
      body: JSON.stringify({ name: "邀请房" })
    });
    const room = await mk.json();
    const other = await (await fetch(b + "/monopoly/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: COOKIE },
      body: JSON.stringify({ name: "别人的房" })
    })).json();

    const guestUrl = "/monopoly/api/rooms/" + room.code + "/state?invite=" + room.inviteToken;
    // 开关没开 → invite 也不认
    assert.strictEqual((await fetch(b + guestUrl)).status, 403);

    const cfgFile = path.join(dir, "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    cfg.allow_guests = true;
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));   // 热读，不用重启

    const seen = await fetch(b + guestUrl);
    assert.strictEqual(seen.status, 200);
    const payload = await seen.json();
    assert.strictEqual(payload.code, room.code);
    assert.ok(!payload.inviteToken, "guest 看不到 inviteToken");

    // 换个房间码就摸不到了
    const cross = await fetch(b + "/monopoly/api/rooms/" + other.code + "/state?invite=" + room.inviteToken);
    assert.strictEqual(cross.status, 403);
    // 建房是 owner 专属
    const mkAsGuest = await fetch(b + "/monopoly/api/rooms?invite=" + room.inviteToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "访客想建房" })
    });
    assert.strictEqual(mkAsGuest.status, 403);
  });
});
