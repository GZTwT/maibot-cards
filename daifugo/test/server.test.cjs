"use strict";
// node --test test/server.test.cjs
// 起临时端口实例 + 临时 dataDir，走完 SPEC 第 5 章服务端条目：
// 403 无 cookie → 建房 → 入座 → agent join 幂等 → 开局 → action →
// SSE 分视角脱敏（A 的流里绝不出现 B 的手牌）→ agent 通道出牌 → 重启恢复。
// engine 多数用 stub 注入（发牌写死，好断言）；规则开关那条链路专门用真引擎跑。

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createHmac } = require("node:crypto");

const { createServer } = require("../server.cjs");
const engineStub = require("./engine-stub.cjs");

const SECRET = "test-secret-for-daifugo";
const PASSWORD = "hunter2";   // 测试实例一律开密码档，open mode 单独一条用例
const cookieValue = "authenticated." + Date.now();
const COOKIE = "bisca_auth=" + cookieValue + "." +
  createHmac("sha256", SECRET).update(cookieValue).digest("base64url");

let tmpDir = null;
let inst = null;
let base = "";
let internalKey = "";

// 房间/座位在多个 test 之间传递
const ctx = { code: null, inviteToken: null, host: null, guest: null, agent: null, seqAfterStart: 0 };

async function boot() {
  inst = createServer({
    dataDir: tmpDir,
    engine: engineStub,
    enginePath: require.resolve("./engine-stub.cjs"), // 真引擎并行开发中，/daifugo/engine.js 这里指向 stub
    cookieSecret: SECRET,
    password: PASSWORD,
    // 桩掉唤醒/自动出牌:不注的话外接座位轮到时会真去打 webhook、AI 座位会真起 CLI
    externalWaker: async function () { /* 测试静默 */ },
    aiMover: async function () { return { move: "pass" }; }
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daifugo-test-"));
  await boot();
});

after(async function () {
  if (inst) await inst.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("首次启动自动生成 config.json（allow_guests 关 + cookie_secret + internal_key + 规则默认值）", function () {
  const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf8"));
  assert.strictEqual(cfg.allow_guests, false);
  assert.strictEqual(typeof cfg.cookie_secret, "string");
  assert.ok(cfg.cookie_secret.length >= 64, "cookie_secret 应是 32 字节 hex");
  assert.strictEqual(typeof cfg.internal_key, "string");
  assert.ok(cfg.internal_key.length >= 32, "internal_key 应该够长");
  assert.strictEqual(cfg.defaults.spade3, true);
  assert.strictEqual(cfg.defaults.forbid_finish, true);
  assert.strictEqual(cfg.defaults.shibari, false);
  assert.strictEqual(cfg.defaults.kaidan_revolution, false);
  assert.strictEqual(cfg.defaults.miyako_ochi, false);
});

test("无凭证（无 cookie 无 internal key）一律 403 JSON", async function () {
  const r = await fetch(base + "/daifugo/api/rooms");
  assert.strictEqual(r.status, 403);
  const body = await r.json();
  assert.ok(body.error, "403 应带中文 error 字段");

  const r2 = await fetch(base + "/daifugo/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "偷跑房" })
  });
  assert.strictEqual(r2.status, 403);
});

test("带合法签名 cookie 可以建房；rules 覆盖 config.defaults", async function () {
  const r = await api("/daifugo/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name: "周五牌桌", rules: { shibari: true, nonsense: true } })
  });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.match(body.code, /^[A-Z0-9]{6}$/);
  assert.strictEqual(typeof body.inviteToken, "string");
  assert.strictEqual(body.inviteToken.length, 32);
  assert.strictEqual(body.rules.shibari, true, "传入的 rules 应覆盖默认");
  assert.strictEqual(body.rules.spade3, true, "没传的沿用 config.defaults");
  assert.strictEqual(body.rules.nonsense, undefined, "未知开关应被丢弃");
  ctx.code = body.code;
  ctx.inviteToken = body.inviteToken;
  assert.ok(fs.existsSync(path.join(tmpDir, "rooms", body.code + ".json")), "房间文件应已落盘");
});

test("双人入座，第一个是房主", async function () {
  const r1 = await api("/daifugo/api/rooms/" + ctx.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "小明" })
  });
  assert.strictEqual(r1.status, 200);
  ctx.host = await r1.json();
  assert.strictEqual(ctx.host.isHost, true);
  assert.strictEqual(ctx.host.playerId, "p1");
  assert.strictEqual(typeof ctx.host.playerToken, "string");

  const r2 = await api("/daifugo/api/rooms/" + ctx.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "小红" })
  });
  assert.strictEqual(r2.status, 200);
  ctx.guest = await r2.json();
  assert.strictEqual(ctx.guest.isHost, false);
  assert.strictEqual(ctx.guest.playerId, "p2");
  assert.notStrictEqual(ctx.guest.playerToken, ctx.host.playerToken);
});

test("agent 通道：internal_key 错 / 不带 key 一律拒", async function () {
  const bad = await agentApi("/daifugo/api/agent/rooms", {}, "totally-wrong-key");
  assert.ok(bad.status === 401 || bad.status === 403, "错 key 应 401/403，实得 " + bad.status);

  // 有 cookie 但没 internal key 也不给走 agent 通道
  const cookieOnly = await api("/daifugo/api/agent/rooms");
  assert.strictEqual(cookieOnly.status, 403);

  const ok = await agentApi("/daifugo/api/agent/rooms");
  assert.strictEqual(ok.status, 200);
  const body = await ok.json();
  assert.ok(body.rooms.some(function (x) { return x.code === ctx.code; }));
});

test("agent join 幂等：两次同 agent_id 返回同一个座位", async function () {
  const r1 = await agentApi("/daifugo/api/agent/" + ctx.code + "/join", {
    method: "POST", body: JSON.stringify({ agent_id: "external", name: "外接 Agent" })
  });
  assert.strictEqual(r1.status, 200);
  ctx.agent = await r1.json();
  assert.strictEqual(ctx.agent.playerId, "p3");
  assert.strictEqual(ctx.agent.rejoined, false);
  assert.strictEqual(ctx.agent.playerToken, undefined, "agent join 回执不该外泄座位 token");

  const r2 = await agentApi("/daifugo/api/agent/" + ctx.code + "/join", {
    method: "POST", body: JSON.stringify({ agent_id: "external", name: "换个名字再来" })
  });
  assert.strictEqual(r2.status, 200);
  const again = await r2.json();
  assert.strictEqual(again.playerId, ctx.agent.playerId, "同 agent_id 必须复用同座位");
  assert.strictEqual(again.rejoined, true);
  assert.strictEqual(again.name, "外接 Agent", "复座不改名");

  const room = JSON.parse(fs.readFileSync(path.join(tmpDir, "rooms", ctx.code + ".json"), "utf8"));
  assert.strictEqual(room.agentSeats.external, "p3");
  assert.strictEqual(room.seats.length, 3);
  assert.strictEqual(room.seats[2].isAI, true);
});

test("非房主不能 start；房主可以", async function () {
  const bad = await api("/daifugo/api/rooms/" + ctx.code + "/start", {
    method: "POST", body: JSON.stringify({ playerToken: ctx.guest.playerToken })
  });
  assert.strictEqual(bad.status, 403);

  const r = await api("/daifugo/api/rooms/" + ctx.code + "/start", {
    method: "POST", body: JSON.stringify({ playerToken: ctx.host.playerToken })
  });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.ok, true);
  ctx.seqAfterStart = body.seq;
});

test("state?token= 分视角：自己看得到手牌，别人的只有张数；无 token=观战", async function () {
  const mine = await (await api("/daifugo/api/rooms/" + ctx.code + "/state?token=" + ctx.host.playerToken)).json();
  assert.strictEqual(mine.you, "p1");
  const p1 = mine.state.players.find(function (p) { return p.id === "p1"; });
  const p2 = mine.state.players.find(function (p) { return p.id === "p2"; });
  assert.deepStrictEqual(p1.hand, ["S3", "S4", "S5", "S6"]);
  assert.strictEqual(p2.hand, undefined, "别人的手牌不能出现");
  assert.strictEqual(p2.handCount, 4);
  assert.ok(JSON.stringify(mine).indexOf("H3") === -1, "p1 的视图里不该有 p2 的牌");

  const watch = await (await api("/daifugo/api/rooms/" + ctx.code + "/state")).json();
  assert.strictEqual(watch.you, null);
  assert.ok(watch.state.players.every(function (p) { return p.hand === undefined; }), "观战看不到任何手牌");
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

test("action(play) 走引擎，seq 增长；非法动作 400；无座位 token 403", async function () {
  const before = await (await api("/daifugo/api/rooms/" + ctx.code + "/state?token=" + ctx.host.playerToken)).json();
  assert.strictEqual(before.seq, ctx.seqAfterStart);
  assert.strictEqual(before.yourTurn, true);
  assert.ok(before.legal.length > 0, "轮到自己应给出合法招");

  const r = await api("/daifugo/api/rooms/" + ctx.code + "/action", {
    method: "POST",
    body: JSON.stringify({ playerToken: ctx.host.playerToken, type: "play", cards: ["S3"] })
  });
  assert.strictEqual(r.status, 200);
  const acted = await r.json();
  assert.strictEqual(acted.seq, before.seq + 1);
  assert.strictEqual(acted.yourTurn, false);
  assert.ok(JSON.stringify(acted).indexOf("H4") === -1, "action 回执也是自己的视角");

  const after = await (await api("/daifugo/api/rooms/" + ctx.code + "/state?token=" + ctx.host.playerToken)).json();
  assert.deepStrictEqual(after.state.field.cards, ["S3"]);
  assert.deepStrictEqual(
    after.state.players.find(function (p) { return p.id === "p1"; }).hand,
    ["S4", "S5", "S6"]
  );

  const notYourTurn = await api("/daifugo/api/rooms/" + ctx.code + "/action", {
    method: "POST",
    body: JSON.stringify({ playerToken: ctx.host.playerToken, type: "play", cards: ["S4"] })
  });
  assert.strictEqual(notYourTurn.status, 400);
  assert.strictEqual((await notYourTurn.json()).error, "还没轮到你出牌");

  const spectator = await api("/daifugo/api/rooms/" + ctx.code + "/action", {
    method: "POST", body: JSON.stringify({ playerToken: "deadbeef", type: "pass" })
  });
  assert.strictEqual(spectator.status, 403);
});

test("SSE 分视角广播：A 的流里绝不出现 B 的手牌", async function () {
  const mine = await openStream("/daifugo/api/rooms/" + ctx.code + "/events?token=" + ctx.host.playerToken);
  const watch = await openStream("/daifugo/api/rooms/" + ctx.code + "/events");
  try {
    assert.strictEqual(mine.status, 200);
    assert.match(mine.contentType, /text\/event-stream/);

    const first = await mine.next();
    assert.strictEqual(first.payload.you, "p1");
    assert.strictEqual(first.payload.started, true);
    await watch.next();

    // p2 出牌 → 两条流各自收到自己的视图
    const act = await api("/daifugo/api/rooms/" + ctx.code + "/action", {
      method: "POST",
      body: JSON.stringify({ playerToken: ctx.guest.playerToken, type: "play", cards: ["H3"] })
    });
    assert.strictEqual(act.status, 200);

    const mineNext = await mine.next();
    const watchNext = await watch.next();

    // p1 的流：自己的手牌在，p2 剩下的牌一张都不许出现（H3 已打到场上，不算泄露）
    const p1self = mineNext.payload.state.players.find(function (p) { return p.id === "p1"; });
    assert.deepStrictEqual(p1self.hand, ["S4", "S5", "S6"]);
    const p2seen = mineNext.payload.state.players.find(function (p) { return p.id === "p2"; });
    assert.strictEqual(p2seen.hand, undefined);
    assert.strictEqual(p2seen.handCount, 3);
    for (const card of ["H4", "H5", "H6", "D3", "D4"]) {
      assert.ok(mineNext.raw.indexOf(card) === -1, "p1 的推送不得含他人手牌 " + card);
    }
    assert.deepStrictEqual(mineNext.payload.state.field.cards, ["H3"]);
    assert.ok(mineNext.raw.indexOf(ctx.host.playerToken) === -1, "SSE 不得包含 token");
    assert.ok(mineNext.raw.indexOf("playerToken") === -1);

    // 观战流：谁的手牌都没有
    assert.ok(watchNext.payload.state.players.every(function (p) { return p.hand === undefined; }));
    for (const card of ["S4", "S5", "H4", "D3"]) {
      assert.ok(watchNext.raw.indexOf(card) === -1, "观战推送不得含手牌 " + card);
    }
    assert.deepStrictEqual(watchNext.payload.state.field.cards, ["H3"]);
    assert.strictEqual(watchNext.payload.you, null);
  } finally {
    mine.close();
    watch.close();
  }
});

test("agent 通道：view 看自己的牌 + 合法招，act 出牌", async function () {
  const v = await (await agentApi("/daifugo/api/agent/" + ctx.code + "/view?agent_id=external")).json();
  assert.strictEqual(v.you, "p3");
  assert.strictEqual(v.yourTurn, true, "p1、p2 出过后轮到 agent");
  assert.deepStrictEqual(v.view.players.find(function (p) { return p.id === "p3"; }).hand,
    ["D3", "D4", "D5", "D6"]);
  assert.ok(v.legal.length > 0);
  assert.ok(JSON.stringify(v).indexOf("S4") === -1, "agent 视图不含他人手牌");

  const r = await agentApi("/daifugo/api/agent/" + ctx.code + "/act", {
    method: "POST", body: JSON.stringify({ agent_id: "external", type: "play", cards: ["D3"] })
  });
  assert.strictEqual(r.status, 200);
  const acted = await r.json();
  assert.deepStrictEqual(acted.view.field.cards, ["D3"]);
  assert.strictEqual(acted.yourTurn, false);
  assert.strictEqual(acted.currentName, "小明", "回执要说下一个轮到谁");

  const unknown = await agentApi("/daifugo/api/agent/" + ctx.code + "/view?agent_id=nobody");
  assert.strictEqual(unknown.status, 404);
});

test("销毁实例重建（同 dataDir）后牌局还在 —— 重启恢复", async function () {
  const before = await (await api("/daifugo/api/rooms/" + ctx.code + "/state?token=" + ctx.host.playerToken)).json();
  await inst.stop();
  await boot();

  const after = await (await api("/daifugo/api/rooms/" + ctx.code + "/state?token=" + ctx.host.playerToken)).json();
  assert.strictEqual(after.seq, before.seq);
  assert.strictEqual(after.started, true);
  assert.deepStrictEqual(after.state.players.map(function (p) { return p.name; }), ["小明", "小红", "外接 Agent"]);

  // 旧 token / 旧 agent_id 依然能行动（座位存在盘上）
  const r = await api("/daifugo/api/rooms/" + ctx.code + "/action", {
    method: "POST",
    body: JSON.stringify({ playerToken: ctx.host.playerToken, type: "play", cards: ["S4"] })
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).seq, before.seq + 1);

  const v = await (await agentApi("/daifugo/api/agent/" + ctx.code + "/view?agent_id=external")).json();
  assert.strictEqual(v.you, "p3");
});

test("engine.js 路由把引擎源码原样送出（前端复用判定逻辑）", async function () {
  const r = await api("/daifugo/engine.js");
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /javascript/);
  const src = await r.text();
  assert.ok(src.indexOf("createGame") !== -1, "应包含引擎源码");
});

test("牌桌聊天：有座位的人发言落盘，state 接口带 chat", async function () {
  const r = await api("/daifugo/api/rooms/" + ctx.code + "/chat", {
    method: "POST", body: JSON.stringify({ playerToken: ctx.host.playerToken, text: "  这把稳了  " })
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).ok, true);

  const st = await (await api("/daifugo/api/rooms/" + ctx.code + "/state?token=" + ctx.host.playerToken)).json();
  const last = st.chat[st.chat.length - 1];
  assert.strictEqual(last.by, "p1");
  assert.strictEqual(last.name, "小明");
  assert.strictEqual(last.text, "这把稳了", "首尾空白要 trim 掉");
  assert.ok(last.ts > 0);

  const room = JSON.parse(fs.readFileSync(path.join(tmpDir, "rooms", ctx.code + ".json"), "utf8"));
  assert.strictEqual(room.chat[room.chat.length - 1].text, "这把稳了", "聊天要落盘");
});

test("牌桌聊天：观战没 token 也能说（name 兜底「观战」）；空/超长 400", async function () {
  const anon = await api("/daifugo/api/rooms/" + ctx.code + "/chat", {
    method: "POST", body: JSON.stringify({ text: "路过看看" })
  });
  assert.strictEqual(anon.status, 200);
  const named = await api("/daifugo/api/rooms/" + ctx.code + "/chat", {
    method: "POST", body: JSON.stringify({ name: "隔壁老王的名字长得离谱根本放不下所以要被截断", text: "牌打得真烂" })
  });
  assert.strictEqual(named.status, 200);

  const st = await (await api("/daifugo/api/rooms/" + ctx.code + "/state")).json();
  const tail = st.chat.slice(-2);
  assert.strictEqual(tail[0].by, null);
  assert.strictEqual(tail[0].name, "观战");
  assert.strictEqual(tail[1].name.length, 16, "观战名字截到 16 字");

  const empty = await api("/daifugo/api/rooms/" + ctx.code + "/chat", {
    method: "POST", body: JSON.stringify({ text: "   " })
  });
  assert.strictEqual(empty.status, 400);
  assert.ok((await empty.json()).error);

  const tooLong = await api("/daifugo/api/rooms/" + ctx.code + "/chat", {
    method: "POST", body: JSON.stringify({ text: "话".repeat(281) })
  });
  assert.strictEqual(tooLong.status, 400);
});

test("牌桌聊天：agent 通道用座位身份说话；没入座的 agent 400", async function () {
  const r = await agentApi("/daifugo/api/agent/" + ctx.code + "/chat", {
    method: "POST", body: JSON.stringify({ agent_id: "external", text: "你们两个人类真慢" })
  });
  assert.strictEqual(r.status, 200);

  const v = await (await agentApi("/daifugo/api/agent/" + ctx.code + "/view?agent_id=external")).json();
  const last = v.chat[v.chat.length - 1];
  assert.strictEqual(last.by, "p3");
  assert.strictEqual(last.name, "外接 Agent");
  assert.strictEqual(last.text, "你们两个人类真慢");

  const nobody = await agentApi("/daifugo/api/agent/" + ctx.code + "/chat", {
    method: "POST", body: JSON.stringify({ agent_id: "nobody", text: "我也想说话" })
  });
  assert.strictEqual(nobody.status, 400);
});

test("牌桌聊天：发言会走 SSE 推给所有人", async function () {
  const stream = await openStream("/daifugo/api/rooms/" + ctx.code + "/events");
  try {
    await stream.next(); // 连上的首帧
    const r = await api("/daifugo/api/rooms/" + ctx.code + "/chat", {
      method: "POST", body: JSON.stringify({ playerToken: ctx.guest.playerToken, text: "闭嘴出牌" })
    });
    assert.strictEqual(r.status, 200);
    const pushed = await stream.next();
    const last = pushed.payload.chat[pushed.payload.chat.length - 1];
    assert.strictEqual(last.text, "闭嘴出牌");
    assert.strictEqual(last.name, "小红");
  } finally {
    stream.close();
  }
});

test("访客邀请：静态资源免凭证；invite 可进房入座，摸不到别的房，建不了房", async function () {
  const cfgPath = path.join(tmpDir, "config.json");
  const cfg0 = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({}, cfg0, { allow_guests: true })));
  try {
    // 静态子资源不带任何凭证也应 200（monopoly 老坑：页面能开、js/css 全 403）
    const js = await fetch(base + "/daifugo/js/room.js");
    assert.strictEqual(js.status, 200);
    const eng = await fetch(base + "/daifugo/engine.js");
    assert.strictEqual(eng.status, 200);

    const roomA = await (await api("/daifugo/api/rooms", { method: "POST", body: JSON.stringify({ name: "客房A" }) })).json();
    const roomB = await (await api("/daifugo/api/rooms", { method: "POST", body: JSON.stringify({ name: "客房B" }) })).json();
    const guestHdr = { "content-type": "application/json", "x-invite-token": roomA.inviteToken };

    // 页面请求带 ?invite= 应 200（不是跳登录）
    const page = await fetch(base + "/daifugo/room.html?c=" + roomA.code + "&invite=" + roomA.inviteToken,
      { headers: { accept: "text/html" }, redirect: "manual" });
    assert.strictEqual(page.status, 200);

    // 访客入座自己的房
    const join = await fetch(base + "/daifugo/api/rooms/" + roomA.code + "/join", {
      method: "POST", headers: guestHdr, body: JSON.stringify({ name: "真人朋友" })
    });
    assert.strictEqual(join.status, 200);
    const seat = await join.json();
    assert.strictEqual(typeof seat.playerToken, "string");

    // query 形式的 invite 也认（SSE/state 走这条）
    const st = await fetch(base + "/daifugo/api/rooms/" + roomA.code + "/state?token=" + seat.playerToken +
      "&invite=" + roomA.inviteToken);
    assert.strictEqual(st.status, 200);
    assert.strictEqual((await st.json()).inviteToken, undefined, "访客视角不该看到 inviteToken");

    // 摸别人的房 403；建房 403
    const other = await fetch(base + "/daifugo/api/rooms/" + roomB.code + "/state", { headers: guestHdr });
    assert.strictEqual(other.status, 403);

    // 访客不是自家人,没有房主 token 关不了房
    const gclose = await fetch(base + "/daifugo/api/rooms/" + roomA.code + "/close", {
      method: "POST", headers: guestHdr, body: JSON.stringify({})
    });
    assert.strictEqual(gclose.status, 403);
    const create = await fetch(base + "/daifugo/api/rooms", {
      method: "POST", headers: guestHdr, body: JSON.stringify({ name: "偷开的房" })
    });
    assert.strictEqual(create.status, 403);
  } finally {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg0));
  }
});

test("房主关闭房间：非房主 403，关闭后房间文件删除、再访 404", async function () {
  const rc = await api("/daifugo/api/rooms", {
    method: "POST", body: JSON.stringify({ name: "要拆的房" })
  });
  const created = await rc.json();
  const host = await (await api("/daifugo/api/rooms/" + created.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "小明" })
  })).json();
  const other = await (await api("/daifugo/api/rooms/" + created.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "路人" })
  })).json();

  // owner cookie = 自家人,不带座位 token 也能关(大厅跨设备清理场景)
  void host; void other;
  const ok = await api("/daifugo/api/rooms/" + created.code + "/close", {
    method: "POST", body: JSON.stringify({})
  });
  assert.strictEqual(ok.status, 200);

  const gone = await waitFor(async function () {
    return fs.existsSync(path.join(tmpDir, "rooms", created.code + ".json")) ? null : true;
  }, 3000);
  assert.ok(gone, "房间文件应在关闭后删除");
  const r404 = await api("/daifugo/api/rooms/" + created.code + "/state");
  assert.strictEqual(r404.status, 404);
});

test("牌桌聊天捎信外接 agent：去抖后叫一次（kind=chat 带聊天行），冷却期内不再叫", async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daifugo-chatwake-"));
  const wakes = [];
  const cw = createServer({
    dataDir: dir,
    engine: engineStub,
    enginePath: require.resolve("./engine-stub.cjs"),
    cookieSecret: SECRET,
    password: PASSWORD,
    externalWakeDelayMs: 100,
    chatWakeDebounceMs: 150,
    chatWakeCooldownMs: 60000,
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
    const created = await (await call("/daifugo/api/rooms", {
      method: "POST", body: JSON.stringify({ name: "唠嗑房", ai_players: ["external"] })
    })).json();
    const host = await (await call("/daifugo/api/rooms/" + created.code + "/join", {
      method: "POST", body: JSON.stringify({ name: "小明" })
    })).json();

    // 连发两条 → 去抖窗口里攒成一次
    await call("/daifugo/api/rooms/" + created.code + "/chat", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken, text: "在吗" })
    });
    await call("/daifugo/api/rooms/" + created.code + "/chat", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken, text: "打牌吗" })
    });
    const woke = await waitFor(async function () { return wakes.length >= 1 ? wakes : null; }, 3000);
    assert.ok(woke, "聊天后应捎信给外接 agent");
    assert.strictEqual(wakes[0].kind, "chat");
    assert.ok(wakes[0].chatLines.some(function (l) { return l.indexOf("打牌吗") >= 0; }), "带上最近聊天");

    // 冷却期内再发 → 不该立刻再叫
    await call("/daifugo/api/rooms/" + created.code + "/chat", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken, text: "又来一条" })
    });
    await new Promise(function (r) { setTimeout(r, 500); });
    assert.strictEqual(wakes.length, 1, "冷却期内不重复叫");
  } finally {
    await cw.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("轮到外接 agent 座位：通知一次，聊天广播不重复通知，人类回合不通知", async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daifugo-monwake-"));
  const wakes = [];
  const mw = createServer({
    dataDir: dir,
    engine: engineStub,
    enginePath: require.resolve("./engine-stub.cjs"),
    cookieSecret: SECRET,
    password: PASSWORD,
    externalWakeDelayMs: 100,
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
    const created = await (await call("/daifugo/api/rooms", {
      method: "POST", body: JSON.stringify({ name: "叫醒测试", ai_players: ["external"] })
    })).json();
    const host = await (await call("/daifugo/api/rooms/" + created.code + "/join", {
      method: "POST", body: JSON.stringify({ name: "小明" })
    })).json();
    await call("/daifugo/api/rooms/" + created.code + "/start", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken })
    });

    // 开局轮到人类（stub 先手 p1）→ 不该叫
    await new Promise(function (r) { setTimeout(r, 400); });
    assert.strictEqual(wakes.length, 0, "人类回合不该叫外接 agent");

    // 人类出牌 → 轮到外接座位（p2）→ 该叫且只叫一次
    await call("/daifugo/api/rooms/" + created.code + "/action", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken, type: "play", cards: ["S3"] })
    });
    const woke = await waitFor(async function () { return wakes.length >= 1 ? wakes : null; }, 3000);
    assert.ok(woke, "轮到外接 agent 应触发通知");
    assert.strictEqual(wakes[0].code, created.code);
    assert.strictEqual(wakes[0].roomName, "叫醒测试");
    assert.strictEqual(wakes[0].phase, "playing");

    // 同一回合里发聊天（会触发 broadcast）→ 不该再叫
    await call("/daifugo/api/rooms/" + created.code + "/chat", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken, text: "快点啦" })
    });
    await new Promise(function (r) { setTimeout(r, 500); });
    assert.strictEqual(wakes.length, 1, "同回合重复 broadcast 不该重复叫");
  } finally {
    await mw.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("自动 AI 玩家：轮到 haiku 座位时服务端替它出牌，say 落进牌桌聊天", async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daifugo-auto-"));
  const calls = [];
  const auto = createServer({
    dataDir: dir,
    engine: engineStub,
    enginePath: require.resolve("./engine-stub.cjs"),
    cookieSecret: SECRET,
    password: PASSWORD,
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
    const created = await (await call("/daifugo/api/rooms", {
      method: "POST", body: JSON.stringify({ name: "AI 陪打", ai_players: ["haiku"] })
    })).json();
    const host = await (await call("/daifugo/api/rooms/" + created.code + "/join", {
      method: "POST", body: JSON.stringify({ name: "小明" })
    })).json();
    assert.strictEqual(host.playerId, "p1");

    const seated = await (await call("/daifugo/api/rooms/" + created.code + "/state")).json();
    assert.deepStrictEqual(seated.seats.map(function (s) { return s.name; }), ["小明", "AI·Haiku"]);
    assert.strictEqual(seated.seats[1].isAI, true);

    const started = await call("/daifugo/api/rooms/" + created.code + "/start", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken })
    });
    assert.strictEqual(started.status, 200);

    // 人类先出一张 → 轮到 AI → 驱动器自己动
    const acted = await call("/daifugo/api/rooms/" + created.code + "/action", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken, type: "play", cards: ["S3"] })
    });
    assert.strictEqual(acted.status, 200);
    assert.strictEqual((await acted.json()).seq, 1);

    const done = await waitFor(async function () {
      const st = await (await call("/daifugo/api/rooms/" + created.code + "/state?token=" + host.playerToken)).json();
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
    assert.strictEqual(calls[0].phase, "playing");
    assert.ok(calls[0].legal.length > 0);
    assert.deepStrictEqual(calls[0].view.players[1].hand, ["H3", "H4", "H5", "H6"], "AI 拿到的是自己的视角");
    assert.strictEqual(calls[0].view.players[0].hand, undefined, "AI 也看不到人类的手牌");
  } finally {
    await auto.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("建房勾选 AI 玩家：房主入座后 AI 自动落座，isHost 仍在人类头上", async function () {
  const rc = await api("/daifugo/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name: "选人房", ai_players: ["external", "opus", "external", "bogus"] })
  });
  assert.strictEqual(rc.status, 200);
  const created = await rc.json();

  // 建房后 AI 还没坐（房主未入座），座位 0 个
  const l1 = await (await api("/daifugo/api/rooms/" + created.code + "/state")).json();
  assert.strictEqual((l1.seats || []).length, 0);

  // 房主入座 → external/opus 自动落座（去重 + 未知 id 丢弃）
  const rj = await api("/daifugo/api/rooms/" + created.code + "/join", {
    method: "POST", body: JSON.stringify({ name: "小明" })
  });
  assert.strictEqual(rj.status, 200);
  const host = await rj.json();
  assert.strictEqual(host.isHost, true);

  const st = await (await api("/daifugo/api/rooms/" + created.code + "/state")).json();
  const names = (st.seats || []).map(function (p) { return p.name; });
  assert.deepStrictEqual(names, ["小明", "外接 Agent", "AI·Opus"]);
  assert.strictEqual(!!st.seats[0].isAI, false);
  assert.strictEqual(st.seats[1].isAI, true);
  assert.strictEqual(st.seats[2].isAI, true);

  // 被邀请的 AI 再走 agent join = 幂等拿回同一座位
  const aj = await agentApi("/daifugo/api/agent/" + created.code + "/join", {
    method: "POST", body: JSON.stringify({ agent_id: "external", name: "外接 Agent" })
  });
  assert.strictEqual(aj.status, 200);
  const seat = await aj.json();
  assert.strictEqual(seat.playerId, st.seats[1].playerId || "p2");
});

test("未知房间 404，未知路径 404", async function () {
  const r = await api("/daifugo/api/rooms/ZZZZZZ/state");
  assert.strictEqual(r.status, 404);
  const r2 = await api("/daifugo/api/nope");
  assert.strictEqual(r2.status, 404);
});

test("open mode（没设密码）：不带任何凭证也是主人", async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daifugo-open-"));
  const open = createServer({
    dataDir: dir,
    engine: engineStub,
    enginePath: require.resolve("./engine-stub.cjs"),
    password: ""            // = 没设 BISCA_PASSWORD
  });
  const port = await open.start(0, "127.0.0.1");
  const b = "http://127.0.0.1:" + port;
  try {
    const list = await fetch(b + "/daifugo/api/rooms");
    assert.strictEqual(list.status, 200, "open mode 下裸请求就该放行");

    const made = await fetch(b + "/daifugo/api/rooms", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "自家局域网" })
    });
    assert.strictEqual(made.status, 200);

    // 页面也不跳登录；/login 直接打回首页
    const page = await fetch(b + "/daifugo/", { headers: { accept: "text/html" }, redirect: "manual" });
    assert.strictEqual(page.status, 200);
    const login = await fetch(b + "/daifugo/login", { redirect: "manual" });
    assert.strictEqual(login.status, 302);
    assert.strictEqual(login.headers.get("location"), "/daifugo/");
  } finally {
    await open.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("设了密码：页面跳自家 login，密码对了发 bisca_auth cookie", async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daifugo-login-"));
  const gated = createServer({
    dataDir: dir,
    engine: engineStub,
    enginePath: require.resolve("./engine-stub.cjs"),
    password: PASSWORD
  });
  const port = await gated.start(0, "127.0.0.1");
  const b = "http://127.0.0.1:" + port;
  try {
    // 未登录的页面请求 → 302 到本服务自己的登录页（带回跳地址）
    const page = await fetch(b + "/daifugo/", { headers: { accept: "text/html" }, redirect: "manual" });
    assert.strictEqual(page.status, 302);
    assert.match(page.headers.get("location") || "", /^\/daifugo\/login\?r=/);

    // 登录页本身不用凭证
    const loginPage = await fetch(b + "/daifugo/login?r=%2Fdaifugo%2F");
    assert.strictEqual(loginPage.status, 200);
    assert.match(loginPage.headers.get("content-type") || "", /text\/html/);
    assert.ok((await loginPage.text()).indexOf("/daifugo/api/login") !== -1, "登录页要能提交到登录接口");

    // 密码错 403，不发 cookie
    const bad = await fetch(b + "/daifugo/api/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" })
    });
    assert.strictEqual(bad.status, 403);
    assert.strictEqual(bad.headers.get("set-cookie"), null);

    // 密码对 → Set-Cookie，且拿着它能进 API
    const ok = await fetch(b + "/daifugo/api/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD })
    });
    assert.strictEqual(ok.status, 200);
    const setCookie = ok.headers.get("set-cookie") || "";
    assert.match(setCookie, /^bisca_auth=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.ok(setCookie.indexOf("Secure") === -1, "明文 http 下不该加 Secure");

    const cookie = setCookie.split(";")[0];
    const listed = await fetch(b + "/daifugo/api/rooms", { headers: { cookie: cookie } });
    assert.strictEqual(listed.status, 200);

    // 伪造签名进不来
    const forged = await fetch(b + "/daifugo/api/rooms", {
      headers: { cookie: "bisca_auth=authenticated." + Date.now() + ".bogus" }
    });
    assert.strictEqual(forged.status, 403);
  } finally {
    await gated.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 老账：建房时勾的规则开关到底有没有传进引擎。这条用真引擎跑，一路查到 state.rules。
test("规则开关真的传进引擎：建房勾的开关落到 state.rules，默认值也下发给大厅", async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daifugo-rules-"));
  const realEngine = require("../engine.cjs");
  const srv = createServer({ dataDir: dir, engine: realEngine, password: "" });
  const port = await srv.start(0, "127.0.0.1");
  const b = "http://127.0.0.1:" + port;
  function call(p, init) {
    const o = Object.assign({}, init);
    o.headers = Object.assign({ "content-type": "application/json" }, o.headers || {});
    return fetch(b + p, o);
  }
  try {
    // 大厅接口要下发服务端默认值（前端建房面板照它摆开关）
    const lobby = await (await call("/daifugo/api/rooms")).json();
    assert.strictEqual(lobby.defaults.spade3, true);
    assert.strictEqual(lobby.defaults.kaidan_revolution, false);

    // 反着默认值勾一遍
    const created = await (await call("/daifugo/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name: "规则房",
        rules: { kaidan_revolution: true, shibari: true, spade3: false, miyako_ochi: true }
      })
    })).json();
    assert.strictEqual(created.rules.kaidan_revolution, true);
    assert.strictEqual(created.rules.spade3, false);

    const host = await (await call("/daifugo/api/rooms/" + created.code + "/join", {
      method: "POST", body: JSON.stringify({ name: "小明" })
    })).json();
    await call("/daifugo/api/rooms/" + created.code + "/join", {
      method: "POST", body: JSON.stringify({ name: "小红" })
    });
    const started = await call("/daifugo/api/rooms/" + created.code + "/start", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken })
    });
    assert.strictEqual(started.status, 200);

    // 引擎里生效的那份规则表（不是房间文件上的那份）
    const st = await (await call("/daifugo/api/rooms/" + created.code + "/state?token=" + host.playerToken)).json();
    assert.deepStrictEqual(st.state.rules, {
      kaidan_revolution: true,
      spade3: false,
      shibari: true,
      forbid_finish: true,   // 没勾的沿用默认
      miyako_ochi: true
    }, "建房勾的开关必须原样进引擎 state.rules");
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("外接 agent 通知走通用 webhook：config.wake_webhook_url 收到 turn 通知（带简报）", async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daifugo-webhook-"));
  const hits = [];
  // 假装用户桥接过去的那个系统
  const sink = http.createServer(function (req, res) {
    let body = "";
    req.on("data", function (c) { body += c; });
    req.on("end", function () {
      hits.push(JSON.parse(body || "{}"));
      res.writeHead(204).end();
    });
  });
  await new Promise(function (r) { sink.listen(0, "127.0.0.1", r); });
  const hookUrl = "http://127.0.0.1:" + sink.address().port + "/hook";

  // config.json 先写好 webhook 地址（服务端热读）
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ wake_webhook_url: hookUrl }));

  const srv = createServer({
    dataDir: dir,
    engine: engineStub,
    enginePath: require.resolve("./engine-stub.cjs"),
    password: "",
    externalWakeDelayMs: 100
  });
  const port = await srv.start(0, "127.0.0.1");
  const b = "http://127.0.0.1:" + port;
  function call(p, init) {
    const o = Object.assign({}, init);
    o.headers = Object.assign({ "content-type": "application/json" }, o.headers || {});
    return fetch(b + p, o);
  }
  try {
    const created = await (await call("/daifugo/api/rooms", {
      method: "POST", body: JSON.stringify({ name: "外接房", ai_players: ["external"] })
    })).json();
    const host = await (await call("/daifugo/api/rooms/" + created.code + "/join", {
      method: "POST", body: JSON.stringify({ name: "小明" })
    })).json();
    await call("/daifugo/api/rooms/" + created.code + "/start", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken })
    });
    // 人类出一张 → 轮到外接座位 → 该发 webhook
    await call("/daifugo/api/rooms/" + created.code + "/action", {
      method: "POST", body: JSON.stringify({ playerToken: host.playerToken, type: "play", cards: ["S3"] })
    });
    const got = await waitFor(async function () { return hits.length ? hits : null; }, 3000);
    assert.ok(got, "轮到外接座位应 POST webhook");
    assert.strictEqual(hits[0].kind, "turn");
    assert.strictEqual(hits[0].code, created.code);
    assert.strictEqual(hits[0].game, "daifugo");
    assert.strictEqual(hits[0].agentId, "external");
    assert.ok(hits[0].briefing.indexOf("手牌") !== -1, "通知里要带排好版的简报");
    assert.ok(hits[0].moveLines.length > 0, "通知里要带编号过的合法招");
  } finally {
    await srv.stop();
    await new Promise(function (r) { sink.close(r); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
