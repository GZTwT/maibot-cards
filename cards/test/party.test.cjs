"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../server.cjs");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bisca-party-"));
}

async function launch(t, opts) {
  const dir = tmp();
  const inst = createServer(Object.assign({
    dataDir: dir,
    password: "pw",
    botMover: async function () { return { move: "p1" }; },
  }, opts || {}));
  await new Promise(function (ok) { inst.server.listen(0, "127.0.0.1", ok); });
  t.after(function () { inst.server.close(); });
  const key = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).internal_key;
  return { inst: inst, dir: dir, base: "http://127.0.0.1:" + inst.server.address().port, key: key };
}

async function call(s, p, opts) {
  const o = Object.assign({}, opts || {});
  o.headers = Object.assign({ "content-type": "application/json" }, o.headers || {});
  const r = await fetch(s.base + p, o);
  const text = await r.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text }; }
  return { status: r.status, body: body };
}

function party(s, body, key) {
  return call(s, "/cards/api/party", {
    method: "POST",
    headers: key ? { "x-internal-key": key } : {},
    body: JSON.stringify(body || { game: "uno" }),
  });
}

function wait(ms) {
  return new Promise(function (ok) { setTimeout(ok, ms); });
}

// 人类在该局待出牌时，打一手合法动作。只用带座位的 token，别像访客那样误入座。
async function playHuman(s, code, invite, tokens) {
  const played = [];
  for (const tok of tokens) {
    const mine = await call(s, "/cards/api/rooms/" + code + "/state?token=" + tok, {
      headers: { "x-invite-token": invite },
    });
    if (!mine.body.yourTurn || !mine.body.legal || !mine.body.legal.length) continue;
    const mv = mine.body.legal[0];
    const out = await call(s, "/cards/api/rooms/" + code + "/action", {
      method: "POST", headers: { "x-invite-token": invite },
      body: JSON.stringify(Object.assign({ playerToken: tok, type: mv.type }, mv)),
    });
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    played.push(mv);
  }
  return played;
}

async function startTwoHuman(t, opts) {
  const s = await launch(t, opts);
  const made = await party(s, { game: "uno", host_name: "群友桌" }, s.key);
  const code = made.body.code;
  const invite = new URL(made.body.inviteUrl).searchParams.get("invite");
  const humans = [];
  for (const name of ["群友", "群友2", "群友3"]) {
    const joined = await call(s, "/cards/api/rooms/" + code + "/join", {
      method: "POST", headers: { "x-invite-token": invite },
      body: JSON.stringify({ name: name }),
    });
    assert.strictEqual(joined.status, 200, JSON.stringify(joined.body));
    humans.push(joined.body.playerToken);
  }
  const st = await call(s, "/cards/api/rooms/" + code + "/state", {
    headers: { "x-invite-token": invite },
  });
  assert.strictEqual(st.body.started, true, "坐满 4 人应自动开局");
  return {
    s: s, code: code, invite: invite, humans: humans,
  };
}

function botPlayed(last, bot) {
  return ((last.body.state || {}).log || []).some(function (line) {
    return line && String(line.text || "").startsWith(bot.name + " ");
  });
}

// 机器人 mover 坏了时，服务端必须自己挑 legal[0] 落地，不能卡在 MaiBot 的座位。
async function assertBotFallback(t, mover, budget) {
  const g = await startTwoHuman(t, {
    partyBotDelayMs: 0, botTimeoutMs: budget || 600, botMover: mover,
    aiMover: async function () { return { move: "p1" }; },
  });
  const before = await call(g.s, "/cards/api/rooms/" + g.code + "/state?token=" + g.humans[1], {
    headers: { "x-invite-token": g.invite },
  });
  const deadline = Date.now() + 3500;
  let last = before;
  while (Date.now() < deadline) {
    await playHuman(g.s, g.code, g.invite, g.humans);
    last = await call(g.s, "/cards/api/rooms/" + g.code + "/state?token=" + g.humans[1], {
      headers: { "x-invite-token": g.invite },
    });
    const bot = (last.body.seats || []).find(function (x) { return x.agentId === "maibot"; });
    if (bot && botPlayed(last, bot)) break;
    await wait(40);
  }
  const bot = (last.body.seats || []).find(function (x) { return x.agentId === "maibot"; });
  const state = last.body.state || {};
  assert.ok(botPlayed(last, bot),
    "MaiBot 座位应已自动出牌，state=" + JSON.stringify(state));
}

test("party: 开桌需要内部 key 或登录，机器人固定入座，不预占人类房主", async function (t) {
  const s = await launch(t);
  const noKey = await party(s, { game: "uno" });
  assert.strictEqual(noKey.status, 403);
  const made = await party(s, { game: "uno", host_name: "阿青", name: "群友桌" }, s.key);
  assert.strictEqual(made.status, 200, JSON.stringify(made.body));
  assert.ok(made.body.code);
  assert.match(made.body.partyUrl, /\/cards\/party\.html\?c=/);
  assert.match(made.body.inviteUrl, /&invite=/);
  assert.strictEqual(made.body.bot.id, "maibot");
  assert.strictEqual(made.body.host, undefined);

  const st = await call(s, "/cards/api/rooms/" + made.body.code + "/state", {
    headers: { "x-invite-token": new URL(made.body.inviteUrl).searchParams.get("invite") },
  });
  assert.strictEqual(st.body.seats.length, 1, "开桌只落 MaiBot，不占人类座位");
  assert.strictEqual(st.body.seats[0].agentId, "maibot");
  assert.strictEqual(st.body.seats[0].isAI, true);
  assert.strictEqual(st.body.seats[0].isHost || false, false);
});

test("party: 页面刷新用旧 token 复座，不会多占座位", async function (t) {
  const s = await launch(t);
  const made = await party(s, { game: "ddz", host_name: "阿青" }, s.key);
  const code = made.body.code;
  const invite = new URL(made.body.inviteUrl).searchParams.get("invite");
  const joined = await call(s, "/cards/api/rooms/" + code + "/join", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ name: "甲" }),
  });
  assert.strictEqual(joined.status, 200, JSON.stringify(joined.body));

  const again = await call(s, "/cards/api/rooms/" + code + "/join", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ playerToken: joined.body.playerToken }),
  });
  assert.strictEqual(again.status, 200, JSON.stringify(again.body));
  assert.strictEqual(again.body.rejoined, true);
  assert.strictEqual(again.body.playerId, joined.body.playerId);

  const st = await call(s, "/cards/api/rooms/" + code + "/state", {
    headers: { "x-invite-token": invite },
  });
  assert.strictEqual(st.body.seats.length, 2, "刷新复座不能多出一个座位");
  assert.strictEqual(st.body.started, false, "2 人斗地主不能提前开局");
});

const http = require("node:http");

test("party: 牌桌聊天不再叫 MaiBot，整场结束才回调", async function (t) {
  const calls = [];
  const mock = http.createServer(function (req, res) {
    let raw = "";
    req.on("data", function (c) { raw += c; });
    req.on("end", function () {
      try { calls.push(JSON.parse(raw)); } catch (e) { /* ignore */ }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: "" }));
    });
  });
  await new Promise(function (ok) { mock.listen(0, "127.0.0.1", ok); });
  t.after(function () { mock.close(); });

  const s = await launch(t, {
    maibotChatUrl: "http://127.0.0.1:" + mock.address().port,
  });
  const made = await party(s, {
    game: "ddz", host_name: "阿青", stream_id: "stream-test-1",
  }, s.key);
  const code = made.body.code;
  const invite = new URL(made.body.inviteUrl).searchParams.get("invite");
  const h1 = await call(s, "/cards/api/rooms/" + code + "/join", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ name: "H1" }),
  });
  const h2 = await call(s, "/cards/api/rooms/" + code + "/join", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ name: "H2" }),
  });
  assert.strictEqual(h1.status, 200, JSON.stringify(h1.body));
  assert.strictEqual(h2.status, 200, JSON.stringify(h2.body));

  await call(s, "/cards/api/rooms/" + code + "/chat", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ playerToken: h1.body.playerToken, text: "有人吗" }),
  });
  await wait(400);
  assert.strictEqual(calls.length, 0, "牌桌聊天不应再叫 MaiBot");

  const ended = await call(s, "/cards/api/rooms/" + code + "/action", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ playerToken: h1.body.playerToken, type: "end_match" }),
  });
  assert.strictEqual(ended.status, 200, JSON.stringify(ended.body));

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !calls.length) await wait(50);
  assert.strictEqual(calls.length, 1, "整场结束应回调一次 MaiBot");
  assert.strictEqual(calls[0].event, "game_over");
  assert.strictEqual(calls[0].stream_id, "stream-test-1");
  assert.strictEqual(calls[0].result.players.length, 3);

  const view = await call(s, "/cards/api/rooms/" + code + "/state", {
    headers: { "x-invite-token": invite },
  });
  assert.ok(!(view.body.chat || []).some(function (c) { return c.name === "MaiBot"; }),
    "牌桌里不应再出现 MaiBot 聊天");
  assert.ok((view.body.chat || []).some(function (c) { return c.text === "有人吗"; }));
});

test("party: 第一个真人可以加/移除 AI 补位，补满自动开局", async function (t) {
  const s = await launch(t);
  const made = await party(s, { game: "uno", host_name: "阿青" }, s.key);
  const code = made.body.code;
  const invite = new URL(made.body.inviteUrl).searchParams.get("invite");
  const join = async function (name) {
    const r = await call(s, "/cards/api/rooms/" + code + "/join", {
      method: "POST", headers: { "x-invite-token": invite },
      body: JSON.stringify({ name: name }),
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const alice = await join("Alice");
  const bob = await join("Bob");

  const denied = await call(s, "/cards/api/rooms/" + code + "/ai", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ playerToken: bob.playerToken, agentId: "haiku", action: "add" }),
  });
  assert.strictEqual(denied.status, 403);

  const added = await call(s, "/cards/api/rooms/" + code + "/ai", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ playerToken: alice.playerToken, agentId: "haiku", action: "add" }),
  });
  assert.strictEqual(added.status, 200, JSON.stringify(added.body));
  assert.strictEqual(added.body.started, true, "补满 4 人应自动开局");

  const st = await call(s, "/cards/api/rooms/" + code + "/state", {
    headers: { "x-invite-token": invite },
  });
  assert.strictEqual(st.body.seats.length, 4);
  const ai = st.body.seats.find(function (x) { return x.agentId === "haiku"; });
  assert.ok(ai && ai.isAI, "AI 座位应落桌");
  assert.strictEqual(ai.name, "AI·Haiku");

  const late = await call(s, "/cards/api/rooms/" + code + "/ai", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ playerToken: alice.playerToken, agentId: "haiku", action: "remove" }),
  });
  assert.strictEqual(late.status, 400, "开局后不能再补位");

  // 没开局时可以加也可以撤
  const made2 = await party(s, { game: "uno", host_name: "阿青" }, s.key);
  const code2 = made2.body.code;
  const invite2 = new URL(made2.body.inviteUrl).searchParams.get("invite");
  const a2 = await call(s, "/cards/api/rooms/" + code2 + "/join", {
    method: "POST", headers: { "x-invite-token": invite2 },
    body: JSON.stringify({ name: "Alice" }),
  });
  const add2 = await call(s, "/cards/api/rooms/" + code2 + "/ai", {
    method: "POST", headers: { "x-invite-token": invite2 },
    body: JSON.stringify({ playerToken: a2.body.playerToken, agentId: "sonnet", action: "add" }),
  });
  assert.strictEqual(add2.status, 200, JSON.stringify(add2.body));
  assert.strictEqual(add2.body.started, false);
  const rm = await call(s, "/cards/api/rooms/" + code2 + "/ai", {
    method: "POST", headers: { "x-invite-token": invite2 },
    body: JSON.stringify({ playerToken: a2.body.playerToken, agentId: "sonnet", action: "remove" }),
  });
  assert.strictEqual(rm.status, 200, JSON.stringify(rm.body));
  const st2 = await call(s, "/cards/api/rooms/" + code2 + "/state", {
    headers: { "x-invite-token": invite2 },
  });
  assert.strictEqual(st2.body.seats.length, 2);

  // 斗地主：MaiBot + 你 + 一个 AI = 3，加完直接开局
  const made3 = await party(s, { game: "ddz", host_name: "阿青" }, s.key);
  const code3 = made3.body.code;
  const invite3 = new URL(made3.body.inviteUrl).searchParams.get("invite");
  const a3 = await call(s, "/cards/api/rooms/" + code3 + "/join", {
    method: "POST", headers: { "x-invite-token": invite3 },
    body: JSON.stringify({ name: "Alice" }),
  });
  const add3 = await call(s, "/cards/api/rooms/" + code3 + "/ai", {
    method: "POST", headers: { "x-invite-token": invite3 },
    body: JSON.stringify({ playerToken: a3.body.playerToken, agentId: "opus", action: "add" }),
  });
  assert.strictEqual(add3.status, 200, JSON.stringify(add3.body));
  assert.strictEqual(add3.body.started, true, "斗地主补到 3 人应自动开局");
});

test("party: 人满自动开局；3 人（含 MaiBot）UNO 不开，斗地主开", async function (t) {
  const s = await launch(t);
  const uno = await party(s, { game: "uno", host_name: "阿青" }, s.key);
  const unoInvite = new URL(uno.body.inviteUrl).searchParams.get("invite");
  for (const name of ["群友", "群友2"]) {
    const joined = await call(s, "/cards/api/rooms/" + uno.body.code + "/join", {
      method: "POST", headers: { "x-invite-token": unoInvite },
      body: JSON.stringify({ name: name }),
    });
    assert.strictEqual(joined.status, 200, JSON.stringify(joined.body));
  }
  const three = await call(s, "/cards/api/rooms/" + uno.body.code + "/state", {
    headers: { "x-invite-token": unoInvite },
  });
  assert.strictEqual(three.body.seats.length, 3);
  assert.strictEqual(three.body.started, false, "3 人 UNO 不能开");

  const fourth = await call(s, "/cards/api/rooms/" + uno.body.code + "/join", {
    method: "POST", headers: { "x-invite-token": unoInvite },
    body: JSON.stringify({ name: "群友3" }),
  });
  assert.strictEqual(fourth.status, 200, JSON.stringify(fourth.body));
  assert.strictEqual(fourth.body.started, true, "坐满 4 人应自动开局");

  const ddz = await party(s, { game: "ddz", host_name: "阿青" }, s.key);
  const ddzInvite = new URL(ddz.body.inviteUrl).searchParams.get("invite");
  let last = null;
  for (const name of ["群友", "群友2"]) {
    last = await call(s, "/cards/api/rooms/" + ddz.body.code + "/join", {
      method: "POST", headers: { "x-invite-token": ddzInvite },
      body: JSON.stringify({ name: name }),
    });
    assert.strictEqual(last.status, 200, JSON.stringify(last.body));
  }
  assert.strictEqual(last.body.started, true, "3 人斗地主坐满应自动开局");
});

test("party: 开局前退出的人立刻腾出座位", async function (t) {
  const s = await launch(t);
  const made = await party(s, { game: "uno", host_name: "阿青" }, s.key);
  const code = made.body.code;
  const invite = new URL(made.body.inviteUrl).searchParams.get("invite");
  const joined = await call(s, "/cards/api/rooms/" + code + "/join", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ name: "路过" }),
  });
  assert.strictEqual(joined.status, 200, JSON.stringify(joined.body));
  const stays = await call(s, "/cards/api/rooms/" + code + "/join", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ name: "留下" }),
  });
  assert.strictEqual(stays.status, 200, JSON.stringify(stays.body));
  const left = await call(s, "/cards/api/rooms/" + code + "/leave", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ playerToken: joined.body.playerToken }),
  });
  assert.strictEqual(left.status, 200, JSON.stringify(left.body));
  const st = await call(s, "/cards/api/rooms/" + code + "/state", {
    headers: { "x-invite-token": invite },
  });
  assert.deepStrictEqual(st.body.seats.map(function (x) { return x.name; }), ["MaiBot", "留下"]);
});

test("party: 开局后退出，座位由服务端接管继续打", async function (t) {
  const s = await launch(t, { partyBotDelayMs: 0, autoDelayMs: 0,
    aiMover: async function () { return { move: "p1" }; } });
  const made = await party(s, { game: "ddz", host_name: "阿青" }, s.key);
  const code = made.body.code;
  const invite = new URL(made.body.inviteUrl).searchParams.get("invite");
  const joined = await call(s, "/cards/api/rooms/" + code + "/join", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ name: "群友" }),
  });
  assert.strictEqual(joined.status, 200, JSON.stringify(joined.body));
  const second = await call(s, "/cards/api/rooms/" + code + "/join", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ name: "群友2" }),
  });
  assert.strictEqual(second.status, 200, JSON.stringify(second.body));
  assert.strictEqual(second.body.started, true, "3 人斗地主坐满应自动开局");
  const left = await call(s, "/cards/api/rooms/" + code + "/leave", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ playerToken: joined.body.playerToken }),
  });
  assert.strictEqual(left.status, 200, JSON.stringify(left.body));
  assert.strictEqual(left.body.takeover, true);
  const st = await call(s, "/cards/api/rooms/" + code + "/state", {
    headers: { "x-invite-token": invite },
  });
  const seat = st.body.seats.find(function (x) { return x.name === "群友"; });
  assert.ok(seat && seat.isAI, "退出的座位应转成服务端接管");
});

test("party: 带邀请的群友可以手机入座并开局，观战不带 token", async function (t) {
  const s = await launch(t);
  const made = await party(s, { game: "uno", host_name: "阿青" }, s.key);
  const code = made.body.code;
  const invite = new URL(made.body.inviteUrl).searchParams.get("invite");
  const joined = await call(s, "/cards/api/rooms/" + code + "/join", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ name: "群友" }),
  });
  assert.strictEqual(joined.status, 200, JSON.stringify(joined.body));
  assert.ok(joined.body.playerToken);

  const third = await call(s, "/cards/api/rooms/" + code + "/join", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ name: "群友2" }),
  });
  assert.strictEqual(third.status, 200, JSON.stringify(third.body));

  const fourth = await call(s, "/cards/api/rooms/" + code + "/join", {
    method: "POST",
    headers: { "x-invite-token": invite },
    body: JSON.stringify({ name: "群友3" }),
  });
  assert.strictEqual(fourth.status, 200, JSON.stringify(fourth.body));
  assert.strictEqual(fourth.body.started, true);
  const view = await call(s, "/cards/api/rooms/" + code + "/state", {
    headers: { "x-invite-token": invite },
  });
  assert.strictEqual(view.body.started, true);
  assert.strictEqual(view.body.seats.length, 4);
  assert.deepStrictEqual(view.body.you, null);

  const wrong = await call(s, "/cards/api/rooms/" + code + "/state", {
    headers: { "x-invite-token": "not-this-room" },
  });
  assert.strictEqual(wrong.status, 403);
});

test("party: 机器人 token 不可替人类出牌", async function (t) {
  const s = await launch(t);
  const made = await party(s, { game: "ddz", host_name: "阿青" }, s.key);
  const code = made.body.code;
  const invite = new URL(made.body.inviteUrl).searchParams.get("invite");
  for (const name of ["群友", "群友2"]) {
    const joined = await call(s, "/cards/api/rooms/" + code + "/join", {
      method: "POST", headers: { "x-invite-token": invite },
      body: JSON.stringify({ name: name }),
    });
    assert.strictEqual(joined.status, 200, JSON.stringify(joined.body));
  }
  const st = await call(s, "/cards/api/rooms/" + code + "/state", {
    headers: { "x-invite-token": invite },
  });
  assert.strictEqual(st.body.started, true);
  const bot = st.body.seats.find(function (x) { return x.agentId === "maibot"; });
  const tried = await call(s, "/cards/api/rooms/" + code + "/action", {
    method: "POST",
    body: JSON.stringify({ playerToken: bot.playerId, type: "play", card: "?" }),
  });
  assert.strictEqual(tried.status, 403);
});

test("party: 无效游戏被拒；页面与 JSON 都可用", async function (t) {
  const s = await launch(t);
  const bad = await party(s, { game: "chess" }, s.key);
  assert.strictEqual(bad.status, 400);
  const made = await party(s, { game: "zjh" }, s.key);
  const page = await fetch(s.base + "/cards/party.html?c=" + made.body.code);
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /party\.js/);
});

test("party: 开桌方指定公开地址时用它发链接，非法地址回退到 Host", async function (t) {
  const s = await launch(t);
  const made = await party(
    s, { game: "uno", public_url: "https://games.example.com/" }, s.key);
  assert.match(made.body.inviteUrl,
    /^https:\/\/games\.example\.com\/cards\/party\.html\?c=/);
  const bad = await party(s, { game: "uno", public_url: "javascript:alert(1)" }, s.key);
  assert.match(bad.body.inviteUrl,
    /^http:\/\/127\.0\.0\.1:\d+\/cards\/party\.html\?c=/);
});

test("party: 隧道地址文件优先于 Host，非法内容忽略", async function (t) {
  const s = await launch(t);
  fs.writeFileSync(path.join(s.dir, "public_url.txt"), "https://tunnel.example.com/\n");
  const made = await party(s, { game: "uno" }, s.key);
  assert.match(made.body.inviteUrl,
    /^https:\/\/tunnel\.example\.com\/cards\/party\.html\?c=/);

  const asked = await party(
    s, { game: "uno", public_url: "https://asked.example.com" }, s.key);
  assert.match(asked.body.inviteUrl, /^https:\/\/asked\.example\.com\/cards\/party\.html\?c=/);

  fs.writeFileSync(path.join(s.dir, "public_url.txt"), "javascript:alert(1)");
  const bad = await party(s, { game: "uno" }, s.key);
  assert.match(bad.body.inviteUrl,
    /^http:\/\/127\.0\.0\.1:\d+\/cards\/party\.html\?c=/);
});

test("party: 人类出牌后机器人自动接招，不靠指令", async function (t) {
  let calls = 0;
  const s = await launch(t, {
    partyBotDelayMs: 0,
    botMover: async function () { calls += 1; return { move: "p1" }; },
  });
  const made = await party(s, { game: "uno", host_name: "阿青" }, s.key);
  const code = made.body.code;
  const invite = new URL(made.body.inviteUrl).searchParams.get("invite");
  const joined = await call(s, "/cards/api/rooms/" + code + "/join", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ name: "群友" }),
  });
  assert.strictEqual(joined.status, 200, JSON.stringify(joined.body));
  const tokens = [joined.body.playerToken];
  let last = null;
  for (const name of ["群友2", "群友3"]) {
    last = await call(s, "/cards/api/rooms/" + code + "/join", {
      method: "POST", headers: { "x-invite-token": invite },
      body: JSON.stringify({ name: name }),
    });
    assert.strictEqual(last.status, 200, JSON.stringify(last.body));
    tokens.push(last.body.playerToken);
  }
  assert.strictEqual(last.body.started, true, "坐满 4 人应自动开局");
  const joinedGuest = await call(s, "/cards/api/rooms/" + code + "/join", {
    method: "POST", headers: { "x-invite-token": invite },
    body: JSON.stringify({ name: "群友", playerToken: joined.body.playerToken }),
  });
  assert.strictEqual(joinedGuest.status, 200, JSON.stringify(joinedGuest.body));
  assert.strictEqual(joinedGuest.body.rejoined, true);
  const guestToken = joinedGuest.body.playerToken;
  const humanActions = tokens;
  // 座位可能刚好被开局翻出的 +2 / 跳过牌绕开；先打一手，再等机器人接力。
  assert.ok((await playHuman(s, code, invite, humanActions)).length >= 1,
    "expected a human move");
  const deadline = Date.now() + 4000;
  while (calls === 0 && Date.now() < deadline) {
    await playHuman(s, code, invite, humanActions);
    await wait(50);
  }
  if (calls === 0) {
    const after = await call(s, "/cards/api/rooms/" + code + "/state?token=" + guestToken, {
      headers: { "x-invite-token": invite },
    });
    assert.fail("bot not called; state=" + JSON.stringify(after.body.state) +
      " legal=" + JSON.stringify(after.body.legal));
  }
  assert.ok(calls > 0, "MaiBot worker should be called automatically");
});

test("party: MaiBot mover 抛错时自动选合法动作，不卡局", async function (t) {
  await assertBotFallback(t, async function () { throw new Error("worker down"); });
});

test("party: MaiBot mover 超时后自动选合法动作，不卡局", async function (t) {
  await assertBotFallback(t, function () { return new Promise(function () {}); }, 60);
});

test("party: MaiBot mover 回非法动作时自动选合法动作，不卡局", async function (t) {
  await assertBotFallback(t, async function () {
    return { move: { type: "play", cards: ["not-a-card"] } };
  });
});
