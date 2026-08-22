"use strict";
// node --test cards/test/server.test.cjs
// 起临时端口实例 + 临时 dataDir，走完 docs/design-cards.md 里的服务端条目：
// 403 无 cookie → 建房必带 game / 非法 game 400 / 引擎缺席 503 → 两个 game 房并存互不干扰 →
// 入座（人数上限走 engine.meta）→ agent join 幂等 → 开局 → action →
// SSE 分视角脱敏（A 的流里绝不出现 B 的手牌和私密字段）→ agent 通道出牌 →
// 牌桌聊天 → 访客邀请 → 关房 → 外接 agent 唤醒/聊天捎信 → 自动 AI → 重启恢复。
// engine 全用多游戏 stub 注入，不依赖并行开发中的三个真引擎。

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac } = require("node:crypto");

const { createServer } = require("../server.cjs");
const { createStub } = require("./engine-stub.cjs");

const SECRET = "test-secret-for-cards";
const PASSWORD = "test-password-1234";
const cookieValue = "authenticated." + Date.now();
const COOKIE = "bisca_auth=" + cookieValue + "." +
  createHmac("sha256", SECRET).update(cookieValue).digest("base64url");

const STUB_FILE = require.resolve("./engine-stub.cjs");

// 三个游戏：ddz = 3 人局（试最小/最大人数），zjh = 2 人局（试 AI 邀请按 maxPlayers 把关），
// uno = 引擎还没就绪（null）——建房该 503。
function makeEngines() {
  return {
    ddz: createStub({ key: "ddz", name: "斗地主", minPlayers: 3, maxPlayers: 3, defaultRules: { allow_four_two: true } }),
    zjh: createStub({ key: "zjh", name: "炸金花", minPlayers: 2, maxPlayers: 2, defaultRules: { blind_play: true, base_bet: 10 } }),
    uno: null
  };
}

// /cards/engine/<game>.js 这里全指向 stub 源码（真引擎不归 server 测试管）；
// uno 故意指到一个不存在的文件，验证"引擎源码不在就 404"。
const ENGINE_PATHS = {
  ddz: STUB_FILE,
  zjh: STUB_FILE,
  uno: path.join(os.tmpdir(), "cards-test-no-such-engine-uno.cjs")
};

let tmpDir = null;
let inst = null;
let base = "";
let internalKey = "";
const mainWakes = []; // 主实例的 externalWaker 一律拦下来，测试不发真 webhook

// 房间/座位在多个 test 之间传递
const ctx = { code: null, inviteToken: null, host: null, guest: null, agent: null, seqAfterStart: 0 };

async function boot() {
  inst = createServer({
    dataDir: tmpDir,
    engines: makeEngines(),
    enginePaths: ENGINE_PATHS,
    cookieSecret: SECRET,
    password: PASSWORD,
    externalWaker: async function (job) { mainWakes.push(job); },
    aiMover: async function () { return { move: "p1" }; }
  });
  const port = await inst.start(0, "127.0.0.1");
  base = "http://127.0.0.1:" + port;
  internalKey = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf8")).internal_key;
}

function api(p, init) {
  const o = Object.assign({}, init);
  o.headers = Object.assign({ "content-type": "application/json", cookie: COOKIE }, o.headers || {});
  return fetch(base + p, o);
}

function agentApi(p, init, key) {
  const o = Object.assign({}, init);
  o.headers = Object.assign(
    { "content-type": "application/json", "x-internal-key": key === undefined ? internalKey : key },
    o.headers || {}
  );
  return fetch(base + p, o);
}

// SSE：开一条流，next() 依次吐出每条 state 事件
async function openStream(p) {
  const ac = new AbortController();
  const r = await fetch(base + p, {
    headers: { cookie: COOKIE, accept: "text/event-stream" },
    signal: ac.signal
  });
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return {
    status: r.status,
    contentType: r.headers.get("content-type") || "",
    close: function () { try { ac.abort(); } catch (e) { /* ignore */ } },
    next: async function () {
      for (;;) {
        const m = buf.match(/event: state\ndata: (.+)\n\n/);
        if (m) {
          buf = buf.slice(m.index + m[0].length);
          return { raw: m[1], payload: JSON.parse(m[1]) };
        }
        const chunk = await reader.read();
        if (chunk.done) return null;
        buf += decoder.decode(chunk.value, { stream: true });
      }
    }
  };
}

// 轮询等一个条件成立（自动 AI 是异步的，没法一 await 就断言）
async function waitFor(fn, ms) {
  const deadline = Date.now() + (ms || 5000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise(function (r) { setTimeout(r, 100); });
  }
}

before(async function () {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cards-test-"));
  await boot();
});

after(async function () {
  if (inst) await inst.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("首次启动自动生成 config.json（allow_guests 关 + internal_key + 各游戏规则默认值分组）", function () {
  const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf8"));
  assert.strictEqual(cfg.allow_guests, false);
  assert.strictEqual(typeof cfg.cookie_secret, "string");
  assert.ok(cfg.cookie_secret.length >= 64, "cookie_secret 应是 32 字节 hex");
  assert.strictEqual(typeof cfg.internal_key, "string");
  assert.ok(cfg.internal_key.length >= 32, "internal_key 应该够长");
  assert.strictEqual(cfg.defaults.ddz.allow_four_two, true, "defaults 按 game 分组，取各引擎 meta.defaultRules");
  assert.strictEqual(cfg.defaults.zjh.blind_play, true);
  assert.strictEqual(cfg.defaults.zjh.base_bet, 10, "非布尔的规则值（筹码/底注）也要落进 defaults");
  assert.strictEqual(cfg.defaults.uno, undefined, "引擎还没就绪的游戏不写空壳");
});

test("无凭证（无 cookie 无 internal key）：API 403 JSON，页面跳登录", async function () {
  const r = await fetch(base + "/cards/api/rooms");
  assert.strictEqual(r.status, 403);
  const body = await r.json();
  assert.ok(body.error, "403 应带中文 error 字段");

  const r2 = await fetch(base + "/cards/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ game: "ddz", name: "偷跑房" })
  });
  assert.strictEqual(r2.status, 403);

  // 浏览器直接开页面（.html 不豁免）→ 302 跳本服务自己的登录页
  const page = await fetch(base + "/cards/index.html", {
    headers: { accept: "text/html" }, redirect: "manual"
  });
  assert.strictEqual(page.status, 302);
  assert.ok(String(page.headers.get("location") || "").indexOf("/cards/login") === 0);
});

test("登录页 + POST /api/login：密码对了发 bisca_auth cookie，凭它能进 API", async function () {
  // 登录页本身免认证（不然永远进不来）
  const page = await fetch(base + "/cards/login");
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.ok(html.indexOf("password") >= 0, "登录页要有密码输入框");

  const bad = await fetch(base + "/cards/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong-password" })
  });
  assert.strictEqual(bad.status, 401);

  const good = await fetch(base + "/cards/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD })
  });
  assert.strictEqual(good.status, 200);
  const setCookie = good.headers.get("set-cookie") || "";
  assert.ok(setCookie.indexOf("bisca_auth=") === 0, "cookie 名是 bisca_auth");
  assert.ok(setCookie.indexOf("HttpOnly") >= 0 && setCookie.indexOf("SameSite=Lax") >= 0);
  assert.ok(setCookie.indexOf("Secure") === -1, "明文 http 下不加 Secure");

  const cookie = setCookie.split(";")[0];
  const ok = await fetch(base + "/cards/api/rooms", { headers: { cookie: cookie } });
  assert.strictEqual(ok.status, 200, "拿着登录 cookie 能进 API");
});

test("open mode（没设密码）：不用登录，谁进来都是主人", async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cards-open-"));
  const open = createServer({
    dataDir: dir,
    engines: makeEngines(),
    enginePaths: ENGINE_PATHS,
    password: ""
  });
  const port = await open.start(0, "127.0.0.1");
  const b = "http://127.0.0.1:" + port;
  try {
    assert.strictEqual(open.openMode, true);
    const list = await fetch(b + "/cards/api/rooms");
    assert.strictEqual(list.status, 200, "open mode 下无 cookie 也能用");
    const page = await fetch(b + "/cards/index.html", { headers: { accept: "text/html" }, redirect: "manual" });
    assert.strictEqual(page.status, 200, "open mode 下页面不跳登录");
    const login = await fetch(b + "/cards/login", { redirect: "manual" });
    assert.strictEqual(login.status, 302, "open mode 下登录页直接放人回大厅");
  } finally {
    await open.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("建房必带合法 game：缺 game / 未知 game → 400，引擎还没就绪的 uno → 503", async function () {
  const noGame = await api("/cards/api/rooms", {
    method: "POST", body: JSON.stringify({ name: "没写游戏" })
  });
  assert.strictEqual(noGame.status, 400);
  assert.ok((await noGame.json()).error.indexOf("ddz") >= 0, "报错要把可选游戏列出来");

  const bogus = await api("/cards/api/rooms", {
    method: "POST", body: JSON.stringify({ game: "mahjong", name: "麻将?" })
  });
  assert.strictEqual(bogus.status, 400);

  const notReady = await api("/cards/api/rooms", {
    method: "POST", body: JSON.stringify({ game: "uno", name: "UNO 房" })
  });
  assert.strictEqual(notReady.status, 503, "引擎缺席应 503 而不是 500/400");
  assert.ok((await notReady.json()).error.indexOf("还没就绪") >= 0);

  // 建房落盘（房间文件带 game 字段）+ rules 只认这个游戏的开关
  const r = await api("/cards/api/rooms", {
    method: "POST",
    body: JSON.stringify({ game: "ddz", name: "小明的牌桌", rules: { allow_four_two: false, blind_play: true, nonsense: 1 } })
  });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.match(body.code, /^[A-Z0-9]{6}$/);
  assert.strictEqual(body.game, "ddz");
  assert.strictEqual(body.gameName, "斗地主", "回执带引擎 meta.name");
  assert.strictEqual(typeof body.inviteToken, "string");
  assert.strictEqual(body.inviteToken.length, 32);
  assert.strictEqual(body.rules.allow_four_two, false, "传入的 rules 应覆盖默认");
  assert.strictEqual(body.rules.blind_play, undefined, "别的游戏的开关不许混进来");
  assert.strictEqual(body.rules.nonsense, undefined, "未知开关应被丢弃");
  ctx.code = body.code;
  ctx.inviteToken = body.inviteToken;
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, "rooms", body.code + ".json"), "utf8"));
  assert.strictEqual(onDisk.game, "ddz", "房间文件要带 game");
});

test("两个不同 game 的房并存互不干扰；大厅 ?game= 过滤", async function () {
  const zjh = await (await api("/cards/api/rooms", {
    method: "POST", body: JSON.stringify({ game: "zjh", name: "炸金花小桌" })
  })).json();
  assert.strictEqual(zjh.game, "zjh");
  assert.strictEqual(zjh.rules.base_bet, 10, "没传就用 config.defaults[zjh]");

  const all = await (await api("/cards/api/rooms")).json();
  assert.ok(all.rooms.some(function (x) { return x.code === ctx.code && x.game === "ddz"; }));
  assert.ok(all.rooms.some(function (x) { return x.code === zjh.code && x.game === "zjh"; }));
  assert.ok(Array.isArray(all.games) && all.games.length === 3, "大厅要带游戏目录");
  const uno = all.games.find(function (g) { return g.key === "uno"; });
  assert.strictEqual(uno.ready, false, "引擎缺席的游戏标 ready:false，前端好把 tab 灰掉");
  assert.strictEqual(all.games.find(function (g) { return g.key === "ddz"; }).maxPlayers, 3);

  const onlyDdz = await (await api("/cards/api/rooms?game=ddz")).json();
  assert.ok(onlyDdz.rooms.every(function (x) { return x.game === "ddz"; }));
  assert.ok(onlyDdz.rooms.some(function (x) { return x.code === ctx.code; }));
  const onlyZjh = await (await api("/cards/api/rooms?game=zjh")).json();
  assert.deepStrictEqual(onlyZjh.rooms.map(function (x) { return x.code; }), [zjh.code]);
  assert.strictEqual(onlyZjh.rooms[0].gameName, "炸金花");
  assert.strictEqual(onlyZjh.rooms[0].maxPlayers, 2, "人数上限来自各自引擎的 meta");

  const badFilter = await api("/cards/api/rooms?game=mahjong");
  assert.strictEqual(badFilter.status, 400);

  // 两桌各打各的：zjh 桌开局、出牌，ddz 桌纹丝不动
  const h = await (await api("/cards/api/rooms/" + zjh.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "小明" })
  })).json();
  await api("/cards/api/rooms/" + zjh.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "对家" })
  });
  const st = await api("/cards/api/rooms/" + zjh.code + "/start", {
    method: "POST", body: JSON.stringify({ playerToken: h.playerToken })
  });
  assert.strictEqual(st.status, 200, "zjh 两人就能开（minPlayers=2）");
  const zst = await (await api("/cards/api/rooms/" + zjh.code + "/state?token=" + h.playerToken)).json();
  assert.strictEqual(zst.game, "zjh");
  assert.strictEqual(zst.state.game, "zjh", "state 由 zjh 引擎生成");
  const dst = await (await api("/cards/api/rooms/" + ctx.code + "/state")).json();
  assert.strictEqual(dst.started, false, "另一桌不受影响");
  assert.strictEqual(dst.gameName, "斗地主");
});

test("入座：先来的是房主；人数上限走 engine.meta（ddz 满 3 人）", async function () {
  const r1 = await api("/cards/api/rooms/" + ctx.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "小明" })
  });
  assert.strictEqual(r1.status, 200);
  ctx.host = await r1.json();
  assert.strictEqual(ctx.host.isHost, true);
  assert.strictEqual(ctx.host.playerId, "p1");
  assert.strictEqual(ctx.host.game, "ddz");
  assert.strictEqual(typeof ctx.host.playerToken, "string");

  const r2 = await api("/cards/api/rooms/" + ctx.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "小明的朋友" })
  });
  assert.strictEqual(r2.status, 200);
  ctx.guest = await r2.json();
  assert.strictEqual(ctx.guest.isHost, false);
  assert.strictEqual(ctx.guest.playerId, "p2");
  assert.notStrictEqual(ctx.guest.playerToken, ctx.host.playerToken);
});

test("人数不够不给开局（ddz minPlayers=3）", async function () {
  const r = await api("/cards/api/rooms/" + ctx.code + "/start", {
    method: "POST", body: JSON.stringify({ playerToken: ctx.host.playerToken })
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await r.json()).error, "至少要 3 个人才能开局");
});

test("agent 通道：internal_key 错 / 不带 key 一律拒", async function () {
  const bad = await agentApi("/cards/api/agent/rooms", {}, "totally-wrong-key");
  assert.ok(bad.status === 401 || bad.status === 403, "错 key 应 401/403，实得 " + bad.status);

  // 有 cookie 但没 internal key 也不给走 agent 通道
  const cookieOnly = await api("/cards/api/agent/rooms");
  assert.strictEqual(cookieOnly.status, 403);

  const ok = await agentApi("/cards/api/agent/rooms");
  assert.strictEqual(ok.status, 200);
  const body = await ok.json();
  assert.ok(body.rooms.some(function (x) { return x.code === ctx.code; }));
});

test("agent join 幂等：两次同 agent_id 返回同一个座位；坐满后第四人被拒", async function () {
  const r1 = await agentApi("/cards/api/agent/" + ctx.code + "/join", {
    method: "POST", body: JSON.stringify({ agent_id: "external", name: "Bot" })
  });
  assert.strictEqual(r1.status, 200);
  ctx.agent = await r1.json();
  assert.strictEqual(ctx.agent.playerId, "p3");
  assert.strictEqual(ctx.agent.rejoined, false);
  assert.strictEqual(ctx.agent.playerToken, undefined, "agent join 回执不该外泄座位 token");

  const r2 = await agentApi("/cards/api/agent/" + ctx.code + "/join", {
    method: "POST", body: JSON.stringify({ agent_id: "external", name: "Bot 又来了" })
  });
  assert.strictEqual(r2.status, 200);
  const again = await r2.json();
  assert.strictEqual(again.playerId, ctx.agent.playerId, "同 agent_id 必须复用同座位");
  assert.strictEqual(again.rejoined, true);
  assert.strictEqual(again.name, "Bot", "复座不改名");

  // ddz maxPlayers=3，已经三个人了
  const full = await api("/cards/api/rooms/" + ctx.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "第四个" })
  });
  assert.strictEqual(full.status, 400);
  assert.strictEqual((await full.json()).error, "房间已满（最多 3 人）");

  const agentFull = await agentApi("/cards/api/agent/" + ctx.code + "/join", {
    method: "POST", body: JSON.stringify({ agent_id: "bot2", name: "Bot2" })
  });
  assert.strictEqual(agentFull.status, 400);

  const room = JSON.parse(fs.readFileSync(path.join(tmpDir, "rooms", ctx.code + ".json"), "utf8"));
  assert.strictEqual(room.agentSeats.external, "p3");
  assert.strictEqual(room.seats.length, 3);
  assert.strictEqual(room.seats[2].isAI, true);
});

test("非房主不能 start；房主可以", async function () {
  const bad = await api("/cards/api/rooms/" + ctx.code + "/start", {
    method: "POST", body: JSON.stringify({ playerToken: ctx.guest.playerToken })
  });
  assert.strictEqual(bad.status, 403);

  const r = await api("/cards/api/rooms/" + ctx.code + "/start", {
    method: "POST", body: JSON.stringify({ playerToken: ctx.host.playerToken })
  });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.ok, true);
  ctx.seqAfterStart = body.seq;
});

test("state?token= 分视角：自己看得到手牌+私密字段，别人的只有张数；无 token=观战", async function () {
  const mine = await (await api("/cards/api/rooms/" + ctx.code + "/state?token=" + ctx.host.playerToken)).json();
  assert.strictEqual(mine.you, "p1");
  assert.strictEqual(mine.game, "ddz");
  const p1 = mine.state.players.find(function (p) { return p.id === "p1"; });
  const p2 = mine.state.players.find(function (p) { return p.id === "p2"; });
  assert.deepStrictEqual(p1.hand, ["S3", "S4", "S5", "S6"]);
  assert.strictEqual(p1.secret, "SEC-S", "自己的私密字段留着");
  assert.strictEqual(p2.hand, undefined, "别人的手牌不能出现");
  assert.strictEqual(p2.secret, undefined, "别人的私密字段不能出现");
  assert.strictEqual(p2.handCount, 4);
  assert.ok(JSON.stringify(mine).indexOf("H3") === -1, "p1 的视图里不该有 p2 的牌");
  assert.ok(JSON.stringify(mine).indexOf("SEC-H") === -1);

  const watch = await (await api("/cards/api/rooms/" + ctx.code + "/state")).json();
  assert.strictEqual(watch.you, null);
  assert.ok(watch.state.players.every(function (p) { return p.hand === undefined && p.secret === undefined; }),
    "观战看不到任何手牌/私密字段");
  const dump = JSON.stringify(watch);
  assert.ok(dump.indexOf("S3") === -1 && dump.indexOf("H3") === -1, "观战视图不含任何牌面");

  // 任何视图/座位列表都不得带 token
  for (const payload of [mine, watch]) {
    const s = JSON.stringify(payload.state) + JSON.stringify(payload.seats);
    assert.ok(s.indexOf(ctx.host.playerToken) === -1, "不得包含房主 token");
    assert.ok(s.indexOf(ctx.guest.playerToken) === -1, "不得包含玩家 token");
    assert.ok(s.indexOf("playerToken") === -1, "不得出现 playerToken 字段");
  }
  assert.ok(mine.seats.every(function (s) { return s.playerId && !s.playerToken; }));
});

test("action(play) 走对应引擎，seq 增长；非法动作 400；无座位 token 403", async function () {
  const before = await (await api("/cards/api/rooms/" + ctx.code + "/state?token=" + ctx.host.playerToken)).json();
  assert.strictEqual(before.seq, ctx.seqAfterStart);
  assert.strictEqual(before.yourTurn, true, "yourTurn 由 engine.currentActors 定");
  assert.ok(before.legal.length > 0, "轮到自己应给出合法招");

  const r = await api("/cards/api/rooms/" + ctx.code + "/action", {
    method: "POST",
    body: JSON.stringify({ playerToken: ctx.host.playerToken, type: "play", cards: ["S3"] })
  });
  assert.strictEqual(r.status, 200);
  const acted = await r.json();
  assert.strictEqual(acted.seq, before.seq + 1);
  assert.strictEqual(acted.yourTurn, false);
  assert.ok(JSON.stringify(acted).indexOf("H4") === -1, "action 回执也是自己的视角");

  const after = await (await api("/cards/api/rooms/" + ctx.code + "/state?token=" + ctx.host.playerToken)).json();
  assert.deepStrictEqual(after.state.field.cards, ["S3"]);
  assert.deepStrictEqual(
    after.state.players.find(function (p) { return p.id === "p1"; }).hand,
    ["S4", "S5", "S6"]
  );

  const notYourTurn = await api("/cards/api/rooms/" + ctx.code + "/action", {
    method: "POST",
    body: JSON.stringify({ playerToken: ctx.host.playerToken, type: "play", cards: ["S4"] })
  });
  assert.strictEqual(notYourTurn.status, 400);
  assert.strictEqual((await notYourTurn.json()).error, "还没轮到你出牌");

  const spectator = await api("/cards/api/rooms/" + ctx.code + "/action", {
    method: "POST", body: JSON.stringify({ playerToken: "deadbeef", type: "pass" })
  });
  assert.strictEqual(spectator.status, 403);
});

test("SSE 分视角广播：A 的流里绝不出现 B 的手牌和私密字段", async function () {
  const mine = await openStream("/cards/api/rooms/" + ctx.code + "/events?token=" + ctx.host.playerToken);
  const watch = await openStream("/cards/api/rooms/" + ctx.code + "/events");
  try {
    assert.strictEqual(mine.status, 200);
    assert.match(mine.contentType, /text\/event-stream/);

    const first = await mine.next();
    assert.strictEqual(first.payload.you, "p1");
    assert.strictEqual(first.payload.started, true);
    assert.strictEqual(first.payload.game, "ddz");
    await watch.next();

    // p2 出牌 → 两条流各自收到自己的视图
    const act = await api("/cards/api/rooms/" + ctx.code + "/action", {
      method: "POST",
      body: JSON.stringify({ playerToken: ctx.guest.playerToken, type: "play", cards: ["H3"] })
    });
    assert.strictEqual(act.status, 200);

    const mineNext = await mine.next();
    const watchNext = await watch.next();

    // p1 的流：自己的手牌在，p2/p3 的私密东西一律不许出现（H3 已打到场上，不算泄露）
    const p1self = mineNext.payload.state.players.find(function (p) { return p.id === "p1"; });
    assert.deepStrictEqual(p1self.hand, ["S4", "S5", "S6"]);
    assert.strictEqual(p1self.secret, "SEC-S");
    const p2seen = mineNext.payload.state.players.find(function (p) { return p.id === "p2"; });
    assert.strictEqual(p2seen.hand, undefined);
    assert.strictEqual(p2seen.secret, undefined);
    assert.strictEqual(p2seen.handCount, 3);
    for (const leak of ["H4", "H5", "H6", "D3", "D4", "SEC-H", "SEC-D"]) {
      assert.ok(mineNext.raw.indexOf(leak) === -1, "p1 的推送不得含他人私密内容 " + leak);
    }
    assert.deepStrictEqual(mineNext.payload.state.field.cards, ["H3"]);
    assert.ok(mineNext.raw.indexOf(ctx.host.playerToken) === -1, "SSE 不得包含 token");
    assert.ok(mineNext.raw.indexOf("playerToken") === -1);

    // 观战流：谁的手牌都没有
    assert.ok(watchNext.payload.state.players.every(function (p) { return p.hand === undefined; }));
    for (const leak of ["S4", "S5", "H4", "D3", "SEC-S", "SEC-H"]) {
      assert.ok(watchNext.raw.indexOf(leak) === -1, "观战推送不得含私密内容 " + leak);
    }
    assert.deepStrictEqual(watchNext.payload.state.field.cards, ["H3"]);
    assert.strictEqual(watchNext.payload.you, null);
  } finally {
    mine.close();
    watch.close();
  }
});

test("agent 通道：view 看自己的牌 + 合法招 + 引擎写的人话简报，act 出牌", async function () {
  const v = await (await agentApi("/cards/api/agent/" + ctx.code + "/view?agent_id=external")).json();
  assert.strictEqual(v.you, "p3");
  assert.strictEqual(v.game, "ddz");
  assert.strictEqual(v.gameName, "斗地主");
  assert.strictEqual(v.yourTurn, true, "p1、p2 出过后轮到 agent");
  assert.deepStrictEqual(v.view.players.find(function (p) { return p.id === "p3"; }).hand,
    ["D3", "D4", "D5", "D6"]);
  assert.ok(v.legal.length > 0);
  assert.ok(v.briefing.indexOf("斗地主") >= 0, "briefing 由引擎自己写");
  assert.ok(v.moveLines.length === v.legal.length && v.moveLines[0].indexOf("出 D3") >= 0,
    "moveLines 逐条走 engine.fmtMove");
  assert.ok(JSON.stringify(v).indexOf("S4") === -1, "agent 视图不含他人手牌");

  const r = await agentApi("/cards/api/agent/" + ctx.code + "/act", {
    method: "POST", body: JSON.stringify({ agent_id: "external", type: "play", cards: ["D3"] })
  });
  assert.strictEqual(r.status, 200);
  const acted = await r.json();
  assert.deepStrictEqual(acted.view.field.cards, ["D3"]);
  assert.strictEqual(acted.yourTurn, false);
  assert.strictEqual(acted.currentName, "小明", "回执要说下一个轮到谁");

  const unknown = await agentApi("/cards/api/agent/" + ctx.code + "/view?agent_id=nobody");
  assert.strictEqual(unknown.status, 404);
});

test("销毁实例重建（同 dataDir）后牌局还在 —— 重启恢复", async function () {
  const before = await (await api("/cards/api/rooms/" + ctx.code + "/state?token=" + ctx.host.playerToken)).json();
  await inst.stop();
  await boot();

  const after = await (await api("/cards/api/rooms/" + ctx.code + "/state?token=" + ctx.host.playerToken)).json();
  assert.strictEqual(after.seq, before.seq);
  assert.strictEqual(after.started, true);
  assert.strictEqual(after.game, "ddz", "重启后房间还认得自己是哪个游戏");
  assert.deepStrictEqual(after.state.players.map(function (p) { return p.name; }), ["小明", "小明的朋友", "Bot"]);

  // 旧 token / 旧 agent_id 依然能行动（座位存在盘上）
  const r = await api("/cards/api/rooms/" + ctx.code + "/action", {
    method: "POST",
    body: JSON.stringify({ playerToken: ctx.host.playerToken, type: "play", cards: ["S4"] })
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).seq, before.seq + 1);

  const v = await (await agentApi("/cards/api/agent/" + ctx.code + "/view?agent_id=external")).json();
  assert.strictEqual(v.you, "p3");
});

test("engine/<game>.js 路由按 game 送对应引擎源码；未知/缺席的 404", async function () {
  const r = await api("/cards/engine/ddz.js");
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /javascript/);
  const src = await r.text();
  assert.ok(src.indexOf("createGame") !== -1, "应包含引擎源码");

  const zjh = await api("/cards/engine/zjh.js");
  assert.strictEqual(zjh.status, 200);

  const uno = await api("/cards/engine/uno.js");
  assert.strictEqual(uno.status, 404, "引擎文件不在就 404");

  const bogus = await api("/cards/engine/mahjong.js");
  assert.strictEqual(bogus.status, 404);

  // 静态子资源免凭证（不然访客拿邀请链接开页面，js 子请求会全 403）
  const noCred = await fetch(base + "/cards/engine/ddz.js");
  assert.strictEqual(noCred.status, 200);
});

test("牌桌聊天：有座位的人发言落盘，state 接口带 chat", async function () {
  const r = await api("/cards/api/rooms/" + ctx.code + "/chat", {
    method: "POST", body: JSON.stringify({ playerToken: ctx.host.playerToken, text: "  这把稳了  " })
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).ok, true);

  const st = await (await api("/cards/api/rooms/" + ctx.code + "/state?token=" + ctx.host.playerToken)).json();
  const last = st.chat[st.chat.length - 1];
  assert.strictEqual(last.by, "p1");
  assert.strictEqual(last.name, "小明");
  assert.strictEqual(last.text, "这把稳了", "首尾空白要 trim 掉");
  assert.ok(last.ts > 0);

  const room = JSON.parse(fs.readFileSync(path.join(tmpDir, "rooms", ctx.code + ".json"), "utf8"));
  assert.strictEqual(room.chat[room.chat.length - 1].text, "这把稳了", "聊天要落盘");
});

test("牌桌聊天：观战没 token 也能说（name 兜底「观战」）；空/超长 400；agent 用座位身份说", async function () {
  const anon = await api("/cards/api/rooms/" + ctx.code + "/chat", {
    method: "POST", body: JSON.stringify({ text: "路过看看" })
  });
  assert.strictEqual(anon.status, 200);
  const named = await api("/cards/api/rooms/" + ctx.code + "/chat", {
    method: "POST", body: JSON.stringify({ name: "隔壁老王的名字长得离谱根本放不下所以要被截断", text: "牌打得真烂" })
  });
  assert.strictEqual(named.status, 200);

  const st = await (await api("/cards/api/rooms/" + ctx.code + "/state")).json();
  const tail = st.chat.slice(-2);
  assert.strictEqual(tail[0].by, null);
  assert.strictEqual(tail[0].name, "观战");
  assert.strictEqual(tail[1].name.length, 16, "观战名字截到 16 字");

  const empty = await api("/cards/api/rooms/" + ctx.code + "/chat", {
    method: "POST", body: JSON.stringify({ text: "   " })
  });
  assert.strictEqual(empty.status, 400);
  assert.ok((await empty.json()).error);

  const tooLong = await api("/cards/api/rooms/" + ctx.code + "/chat", {
    method: "POST", body: JSON.stringify({ text: "话".repeat(281) })
  });
  assert.strictEqual(tooLong.status, 400);

  const ag = await agentApi("/cards/api/agent/" + ctx.code + "/chat", {
    method: "POST", body: JSON.stringify({ agent_id: "external", text: "你们两个人类真慢" })
  });
  assert.strictEqual(ag.status, 200);
  const v = await (await agentApi("/cards/api/agent/" + ctx.code + "/view?agent_id=external")).json();
  const agLast = v.chat[v.chat.length - 1];
  assert.strictEqual(agLast.by, "p3");
  assert.strictEqual(agLast.name, "Bot");

  const nobody = await agentApi("/cards/api/agent/" + ctx.code + "/chat", {
    method: "POST", body: JSON.stringify({ agent_id: "nobody", text: "我也想说话" })
  });
  assert.strictEqual(nobody.status, 400);
});

test("牌桌聊天：发言会走 SSE 推给所有人", async function () {
  const stream = await openStream("/cards/api/rooms/" + ctx.code + "/events");
  try {
    await stream.next(); // 连上的首帧
    const r = await api("/cards/api/rooms/" + ctx.code + "/chat", {
      method: "POST", body: JSON.stringify({ playerToken: ctx.guest.playerToken, text: "闭嘴出牌" })
    });
    assert.strictEqual(r.status, 200);
    const pushed = await stream.next();
    const last = pushed.payload.chat[pushed.payload.chat.length - 1];
    assert.strictEqual(last.text, "闭嘴出牌");
    assert.strictEqual(last.name, "小明的朋友");
  } finally {
    stream.close();
  }
});

test("访客邀请：invite 可进房入座，摸不到别的房，建不了房", async function () {
  const cfgPath = path.join(tmpDir, "config.json");
  const cfg0 = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({}, cfg0, { allow_guests: true })));
  try {
    const roomA = await (await api("/cards/api/rooms", {
      method: "POST", body: JSON.stringify({ game: "zjh", name: "客房A" })
    })).json();
    const roomB = await (await api("/cards/api/rooms", {
      method: "POST", body: JSON.stringify({ game: "ddz", name: "客房B" })
    })).json();
    const guestHdr = { "content-type": "application/json", "x-invite-token": roomA.inviteToken };

    // 访客入座自己的房
    const join = await fetch(base + "/cards/api/rooms/" + roomA.code + "/join", {
      method: "POST", headers: guestHdr, body: JSON.stringify({ name: "真人朋友" })
    });
    assert.strictEqual(join.status, 200);
    const seat = await join.json();
    assert.strictEqual(typeof seat.playerToken, "string");

    // query 形式的 invite 也认（SSE/state 走这条）
    const st = await fetch(base + "/cards/api/rooms/" + roomA.code + "/state?token=" + seat.playerToken +
      "&invite=" + roomA.inviteToken);
    assert.strictEqual(st.status, 200);
    assert.strictEqual((await st.json()).inviteToken, undefined, "访客视角不该看到 inviteToken");

    // 摸别人的房 403；关房 403；建房 403
    const other = await fetch(base + "/cards/api/rooms/" + roomB.code + "/state", { headers: guestHdr });
    assert.strictEqual(other.status, 403);
    const gclose = await fetch(base + "/cards/api/rooms/" + roomA.code + "/close", {
      method: "POST", headers: guestHdr, body: JSON.stringify({})
    });
    assert.strictEqual(gclose.status, 403);
    const create = await fetch(base + "/cards/api/rooms", {
      method: "POST", headers: guestHdr, body: JSON.stringify({ game: "ddz", name: "偷开的房" })
    });
    assert.strictEqual(create.status, 403);
  } finally {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg0));
  }
});

test("房主关闭房间：关闭后房间文件删除、再访 404", async function () {
  const created = await (await api("/cards/api/rooms", {
    method: "POST", body: JSON.stringify({ game: "zjh", name: "要拆的房" })
  })).json();
  await api("/cards/api/rooms/" + created.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "小明" })
  });

  // owner cookie = 自家人,不带座位 token 也能关(大厅跨设备清理场景)
  const ok = await api("/cards/api/rooms/" + created.code + "/close", {
    method: "POST", body: JSON.stringify({})
  });
  assert.strictEqual(ok.status, 200);

  const gone = await waitFor(async function () {
    return fs.existsSync(path.join(tmpDir, "rooms", created.code + ".json")) ? null : true;
  }, 3000);
  assert.ok(gone, "房间文件应在关闭后删除");
  const r404 = await api("/cards/api/rooms/" + created.code + "/state");
  assert.strictEqual(r404.status, 404);
});

test("AI 邀请按 engine.meta.maxPlayers 把关（zjh 只坐 2 人，第三个坐不下）", async function () {
  const created = await (await api("/cards/api/rooms", {
    method: "POST", body: JSON.stringify({ game: "zjh", name: "两人小桌", ai_players: ["external", "haiku"] })
  })).json();

  const host = await (await api("/cards/api/rooms/" + created.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "小明" })
  })).json();
  assert.strictEqual(host.isHost, true);

  const st = await (await api("/cards/api/rooms/" + created.code + "/state")).json();
  assert.deepStrictEqual(st.seats.map(function (s) { return s.name; }), ["小明", "外接 Agent"],
    "maxPlayers=2，勾了两个 AI 也只坐得下第一个");
  assert.strictEqual(st.maxPlayers, 2);

  // 第三人（人类或 agent）一律拒
  const human = await api("/cards/api/rooms/" + created.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "第三个" })
  });
  assert.strictEqual(human.status, 400);
  assert.strictEqual((await human.json()).error, "房间已满（最多 2 人）");

  const ag = await agentApi("/cards/api/agent/" + created.code + "/join", {
    method: "POST", body: JSON.stringify({ agent_id: "bot2", name: "Bot2" })
  });
  assert.strictEqual(ag.status, 400);

  // 已在座的 AI 走 agent join = 幂等拿回同一座位
  const ext = await agentApi("/cards/api/agent/" + created.code + "/join", {
    method: "POST", body: JSON.stringify({ agent_id: "external", name: "Bot" })
  });
  assert.strictEqual(ext.status, 200);
  assert.strictEqual((await ext.json()).playerId, "p2");
});

test("建房勾选 AI 玩家：房主入座后 AI 自动落座，isHost 仍在人类头上", async function () {
  const created = await (await api("/cards/api/rooms", {
    method: "POST",
    body: JSON.stringify({ game: "ddz", name: "选人房", ai_players: ["external", "opus", "external", "bogus"] })
  })).json();

  // 建房后 AI 还没坐（房主未入座），座位 0 个
  const l1 = await (await api("/cards/api/rooms/" + created.code + "/state")).json();
  assert.strictEqual((l1.seats || []).length, 0);

  const host = await (await api("/cards/api/rooms/" + created.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "小明" })
  })).json();
  assert.strictEqual(host.isHost, true);

  const st = await (await api("/cards/api/rooms/" + created.code + "/state")).json();
  assert.deepStrictEqual((st.seats || []).map(function (p) { return p.name; }), ["小明", "外接 Agent", "AI·Opus"],
    "去重 + 未知 id 丢弃");
  assert.strictEqual(!!st.seats[0].isAI, false);
  assert.strictEqual(st.seats[1].isAI, true);
  assert.strictEqual(st.seats[2].isAI, true);
});

test("牌桌聊天捎信外接 agent：去抖后叫一次（kind=chat 带聊天行+游戏名），冷却期内不再叫", async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cards-chatwake-"));
  const wakes = [];
  const cw = createServer({
    dataDir: dir,
    engines: makeEngines(),
    enginePaths: ENGINE_PATHS,
    cookieSecret: SECRET,
    wakeDelayMs: 100,
    chatWakeDebounceMs: 150,
    chatWakeCooldownMs: 60000,
    password: PASSWORD,
    externalWaker: async function (job) { wakes.push(job); }
  });
  const port = await cw.start(0, "127.0.0.1");
  const b = "http://127.0.0.1:" + port;
  function call(p, init) {
    const o = Object.assign({}, init);
    o.headers = Object.assign({ "content-type": "application/json", cookie: COOKIE }, o.headers || {});
    return fetch(b + p, o);
  }
  try {
    const created = await (await call("/cards/api/rooms", {
      method: "POST", body: JSON.stringify({ game: "zjh", name: "唠嗑房", ai_players: ["external"] })
    })).json();
    const host = await (await call("/cards/api/rooms/" + created.code + "/join", {
      method: "POST", body: JSON.stringify({ name: "小明" })
    })).json();

    // 连发两条 → 去抖窗口里攒成一次
    await call("/cards/api/rooms/" + created.code + "/chat", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken, text: "在吗" })
    });
    await call("/cards/api/rooms/" + created.code + "/chat", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken, text: "打牌吗" })
    });
    const woke = await waitFor(async function () { return wakes.length >= 1 ? wakes : null; }, 3000);
    assert.ok(woke, "聊天后应捎信给外接 agent");
    assert.strictEqual(wakes[0].kind, "chat");
    assert.strictEqual(wakes[0].gameName, "炸金花", "捎信要带游戏名");
    assert.ok(wakes[0].chatLines.some(function (l) { return l.indexOf("打牌吗") >= 0; }), "带上最近聊天");

    // 冷却期内再发 → 不该立刻再叫
    await call("/cards/api/rooms/" + created.code + "/chat", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken, text: "又来一条" })
    });
    await new Promise(function (r) { setTimeout(r, 500); });
    assert.strictEqual(wakes.length, 1, "冷却期内不重复叫");
  } finally {
    await cw.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("轮到外接 agent：叫醒一次（带引擎简报+编号招），聊天广播不重复叫，人类回合不叫", async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cards-extwake-"));
  const wakes = [];
  const mw = createServer({
    dataDir: dir,
    engines: makeEngines(),
    enginePaths: ENGINE_PATHS,
    cookieSecret: SECRET,
    wakeDelayMs: 100,
    password: PASSWORD,
    externalWaker: async function (job) { wakes.push(job); }
  });
  const port = await mw.start(0, "127.0.0.1");
  const b = "http://127.0.0.1:" + port;
  function call(p, init) {
    const o = Object.assign({}, init);
    o.headers = Object.assign({ "content-type": "application/json", cookie: COOKIE }, o.headers || {});
    return fetch(b + p, o);
  }

  try {
    const created = await (await call("/cards/api/rooms", {
      method: "POST", body: JSON.stringify({ game: "zjh", name: "叫醒测试", ai_players: ["external"] })
    })).json();
    const host = await (await call("/cards/api/rooms/" + created.code + "/join", {
      method: "POST", body: JSON.stringify({ name: "小明" })
    })).json();
    await call("/cards/api/rooms/" + created.code + "/start", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken })
    });

    // 开局轮到人类（stub 先手 p1）→ 不该叫
    await new Promise(function (r) { setTimeout(r, 400); });
    assert.strictEqual(wakes.length, 0, "人类回合不该叫外接 agent");

    // 人类出牌 → 轮到外接 agent（p2）→ 该叫且只叫一次
    await call("/cards/api/rooms/" + created.code + "/action", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken, type: "play", cards: ["S3"] })
    });
    const woke = await waitFor(async function () { return wakes.length >= 1 ? wakes : null; }, 3000);
    assert.ok(woke, "轮到外接 agent 应触发叫醒");
    assert.strictEqual(wakes[0].kind, "turn");
    assert.strictEqual(wakes[0].code, created.code);
    assert.strictEqual(wakes[0].roomName, "叫醒测试");
    assert.strictEqual(wakes[0].game, "zjh");
    assert.strictEqual(wakes[0].gameName, "炸金花");
    assert.strictEqual(wakes[0].phase, "playing");
    assert.ok(wakes[0].briefing.indexOf("炸金花") >= 0, "简报由 engine.briefing 写");
    assert.ok(wakes[0].moveLines.some(function (l) { return l.indexOf("出 H3") >= 0; }), "招式走 engine.fmtMove");

    // 同一回合里发聊天（会触发 broadcast）→ 不该再叫
    await call("/cards/api/rooms/" + created.code + "/chat", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken, text: "快点啦" })
    });
    await new Promise(function (r) { setTimeout(r, 500); });
    assert.strictEqual(wakes.length, 1, "同回合重复 broadcast 不该重复叫");
  } finally {
    await mw.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("自动 AI 玩家：轮到 haiku 座位时服务端替他出牌，say 落进牌桌聊天", async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cards-auto-"));
  const calls = [];
  const auto = createServer({
    dataDir: dir,
    engines: makeEngines(),
    enginePaths: ENGINE_PATHS,
    cookieSecret: SECRET,
    aiMover: async function (job) {
      calls.push(job);
      return { move: "p1", say: "测试嘴一句" };
    }
  });
  const port = await auto.start(0, "127.0.0.1");
  const b = "http://127.0.0.1:" + port;
  function call(p, init) {
    const o = Object.assign({}, init);
    o.headers = Object.assign({ "content-type": "application/json", cookie: COOKIE }, o.headers || {});
    return fetch(b + p, o);
  }

  try {
    // 建房勾 haiku → 房主入座后自动落座
    const created = await (await call("/cards/api/rooms", {
      method: "POST", body: JSON.stringify({ game: "zjh", name: "AI 陪打", ai_players: ["haiku"] })
    })).json();
    const host = await (await call("/cards/api/rooms/" + created.code + "/join", {
      method: "POST", body: JSON.stringify({ name: "小明" })
    })).json();
    assert.strictEqual(host.playerId, "p1");

    const seated = await (await call("/cards/api/rooms/" + created.code + "/state")).json();
    assert.deepStrictEqual(seated.seats.map(function (s) { return s.name; }), ["小明", "AI·Haiku"]);
    assert.strictEqual(seated.seats[1].isAI, true);

    const started = await call("/cards/api/rooms/" + created.code + "/start", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken })
    });
    assert.strictEqual(started.status, 200);

    // 人类先出一张 → 轮到 AI → 驱动器自己动
    const acted = await call("/cards/api/rooms/" + created.code + "/action", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken, type: "play", cards: ["S3"] })
    });
    assert.strictEqual(acted.status, 200);
    assert.strictEqual((await acted.json()).seq, 1);

    const done = await waitFor(async function () {
      const st = await (await call("/cards/api/rooms/" + created.code + "/state?token=" + host.playerToken)).json();
      return st.seq >= 2 ? st : null;
    }, 6000);
    assert.ok(done, "AI 应在几秒内自己出牌（seq 涨到 2）");
    assert.strictEqual(done.state.current, "p1", "出完该轮回人类");
    assert.deepStrictEqual(done.state.field.cards, ["H3"], "AI 出的是 legal[0]（p1）");
    assert.strictEqual(done.state.players[1].handCount, 3);

    const last = done.chat[done.chat.length - 1];
    assert.strictEqual(last.text, "测试嘴一句");
    assert.strictEqual(last.by, "p2");
    assert.strictEqual(last.name, "AI·Haiku");

    assert.strictEqual(calls.length, 1, "只该问一次 AI");
    assert.strictEqual(calls[0].modelKey, "haiku");
    assert.strictEqual(calls[0].seatName, "AI·Haiku");
    assert.strictEqual(calls[0].game, "zjh");
    assert.strictEqual(calls[0].gameName, "炸金花");
    assert.strictEqual(calls[0].phase, "playing");
    assert.ok(calls[0].legal.length > 0);
    assert.ok(calls[0].briefing.indexOf("炸金花") >= 0, "AI 也拿引擎写的简报");
    assert.ok(calls[0].moveLines[0].indexOf("出 H3") >= 0);
    assert.deepStrictEqual(calls[0].view.players[1].hand, ["H3", "H4", "H5", "H6"], "AI 拿到的是自己的视角");
    assert.strictEqual(calls[0].view.players[0].hand, undefined, "AI 也看不到人类的手牌");
    assert.strictEqual(calls[0].view.players[0].secret, undefined);
  } finally {
    await auto.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("未知房间 404，未知路径 404", async function () {
  const r = await api("/cards/api/rooms/ZZZZZZ/state");
  assert.strictEqual(r.status, 404);
  const r2 = await api("/cards/api/nope");
  assert.strictEqual(r2.status, 404);
});
