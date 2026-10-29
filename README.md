# MaiBot 牌桌（MaiBot 插件）

> **本仓库是 [GZTwT](https://github.com/GZTwT) 的 MaiBot 插件分支**：
> 在上游 [29-Cu/bisca](https://github.com/29-Cu/bisca)（CC-BY-4.0）基础上二次开发了
> **MaiBot 牌桌插件**——群里发一句 `uno` / `炸金花` / `斗地主`，MaiBot 自动开桌、
> 占一个座位陪打，赛后在群里吐槽。
>
> - 插件目录：[`maibot-plugin/`](maibot-plugin/)
> - 安装、配置、群聊用法：[插件 README](maibot-plugin/README.md)
> - 插件部分由 **DeepSeek V4.1 Flash 1017** 参与编写与调试，**仅供娱乐**，
>   只玩虚拟筹码、不涉赌；AI 出牌可能出错。详见插件 README 的免责声明。
> - 下面是上游 Bisca 的原版说明，牌桌前端、游戏引擎与服务端均来自上游。

---

# Bisca

A self-hosted game den where **AI players pull up a chair** — play a
Monopoly-style board game, Daifugō, Dou Dizhu, Zhajinhua and UNO with friends,
family, and Claude at the same table.
一套可自托管的「家庭牌窝」——大富翁、大富豪、斗地主、炸金花、UNO，
朋友家人和 **AI 牌友同桌打牌**，还会嘴炮。

*Bisca* is Italian for "gambling den" — the smoky back room where the cards
come out and everybody talks too much. It is the sibling of
[Atrio](https://github.com/29-Cu/atrio): guests enter through the respectable
entrance hall, then someone opens the wrong door and finds the bisca.
（bisca 是意大利语的「赌窝」——烟雾缭绕、人声鼎沸的后屋牌室，就是你家楼下
那间棋牌室。它是 [Atrio](https://github.com/29-Cu/atrio) 门厅的邻居：客人从
体面的门厅进来，推开后屋的小门——好了，开牌。）

No real money anywhere, of course. The only thing anyone loses here is face.
（当然全程没有真钱。在这里输掉的只有面子。）

[English](#english) · [中文](#中文)

---

## English

### What's inside

Three **independent, single-file Node services**. Run one, or all three:

| Service | Games | Port |
|---|---|---|
| `monopoly/` | Monopoly-style board game (Chinese board, custom rules) | 8078 |
| `daifugo/` | Daifugō (大富豪), the Japanese climbing card game | 8079 |
| `cards/` | Cards hub: Dou Dizhu (斗地主), Zhajinhua (炸金花), UNO — one service, pluggable engines | 8081 |

Common architecture across all three:

- **Zero build, one dependency.** Plain CommonJS + Express. `npm install`, `node server.cjs`, done. Frontend is vanilla HTML/CSS/JS, no framework, no bundler.
- **Server-authoritative engines.** Pure-logic game engines (`engine.cjs` / `engines/*.cjs`) with deterministic seeded RNG, fully unit-tested with `node --test`.
- **Per-seat redacted views.** Each player's SSE stream only ever contains what that player is allowed to see — hands stay secret at the transport level, not just in the UI.
- **Guest invites.** Share a tokenized invite link; guests join from their phone without an account.
- **Atomic on-disk rooms.** Rooms survive restarts; no database needed.

### AI players (the fun part)

Every card game seat can be taken by an AI, three ways:

1. **CLI auto-players** — if you have [Claude Code](https://claude.com/claude-code)
   installed and logged in, seats named `opus` / `sonnet` / `haiku` are driven by
   one-shot `claude` CLI calls. The server hands the model a redacted briefing
   plus the legal moves, and it plays — and occasionally talks trash in table
   chat (persona configurable via `ai_persona` in `data/config.json`). If the
   CLI is missing or times out, the server falls back to a legal move, so a
   game can never get stuck.
2. **External agent seats** — a seat can be marked `external` and driven by any
   program through the bot API (`X-Internal-Key` header, key auto-generated in
   `data/config.json`). Point your own agent, bot, or MCP tool at it.
3. **Wake webhooks** — set `WAKE_WEBHOOK_URL` and the server POSTs a JSON
   briefing whenever it's an external seat's turn (or someone talks to it in
   table chat), so you can bridge turns into any notification or agent system.

No AI configured? Everything works as a plain human multiplayer game.

### Quick start

```bash
git clone https://github.com/29-Cu/bisca.git
cd bisca
npm install

node cards/server.cjs      # → http://localhost:8081/cards
node daifugo/server.cjs    # → http://localhost:8079/daifugo
node monopoly/server.cjs   # → http://localhost:8078/monopoly
```

### Configuration

All via environment variables (or `data/config.json`, auto-created on first run):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8078 / 8079 / 8081 | Listen port |
| `BISCA_PASSWORD` | *(unset)* | If set, the service shows a login page and gates everything behind it. **Unset = open mode: anyone who can reach the port is an owner — fine on a LAN, do NOT expose to the internet like that.** |
| `BISCA_DATA_DIR` | `./data` | Where rooms/config are stored |
| `CLAUDE_BIN` | `claude` | Claude Code CLI binary for AI auto-players |
| `WAKE_WEBHOOK_URL` | *(unset)* | POST target for external-seat turn notifications |

### Deploying

Example systemd units are in [`deploy/`](deploy/). Put the services behind any
reverse proxy (nginx/Caddy/Cloudflare Tunnel) with path routes like
`/cards → :8081`, `/daifugo → :8079`, `/monopoly → :8078` — the apps already
serve under those prefixes. Set `BISCA_PASSWORD` before exposing anything.

### Design docs & tests

Each service ships its original (translated/cleaned) design spec in
[`docs/`](docs/) — engine contracts, rule decisions, testing strategy. Run all
tests with `npm test` (hundreds of engine/server tests, including random
full-game stress runs that assert card conservation and no deadlocks).

### License

[CC BY 4.0](LICENSE) — do anything, just credit **Cu & Lunedì**.

Bundled fonts (`fonts/`) — Manrope, Newsreader, Cormorant Garamond — are
licensed separately under the [SIL Open Font License 1.1](fonts/README.md).

---

## 中文

### 里面有什么

三个**彼此独立的单文件 Node 服务**，想跑哪个跑哪个：

| 服务 | 游戏 | 端口 |
|---|---|---|
| `monopoly/` | 大富翁（中文棋盘，自定规则） | 8078 |
| `daifugo/` | 大富豪（日式爬牌） | 8079 |
| `cards/` | 棋牌室三合一：斗地主 / 炸金花 / UNO，一个服务、引擎可插拔 | 8081 |

三个服务同一套架构底盘：

- **零构建、单依赖。** 纯 CommonJS + Express，`npm install` 完直接 `node server.cjs`。前端是原生 HTML/CSS/JS，没有框架没有打包器。
- **服务端权威引擎。** 纯逻辑引擎 + 确定性种子随机数，`node --test` 全覆盖单测。
- **分视角脱敏。** 每个玩家的 SSE 流里只有他有权看到的信息——手牌保密是传输层的事，不是前端糊弄。
- **访客邀请链接。** 一条带 token 的链接发过去，家人朋友手机点开就能上桌，不用注册。
- **房间原子落盘。** 重启不丢局，不需要数据库。

### AI 牌友（灵魂功能）

牌桌上的任何座位都可以让 AI 坐，三种接法：

1. **CLI 自动分身** —— 装了 [Claude Code](https://claude.com/claude-code) 并登录的话，
   `opus` / `sonnet` / `haiku` 座位由 `claude` CLI 单发驱动：服务端把脱敏局面简报和
   合法招列表喂给模型，它出牌，偶尔还在牌桌聊天里嘴一句（人设可在
   `data/config.json` 的 `ai_persona` 里自定义）。CLI 没装或超时会兜底出合法招，
   **牌局永远不会卡死**。
2. **外接 agent 座位** —— 座位标记为 `external`，由任何外部程序经 bot API
   （`X-Internal-Key` 请求头，key 首启自动生成在 `data/config.json`）驱动。
   接你自己的 agent、bot、MCP 工具都行。
3. **唤醒 webhook** —— 配置 `WAKE_WEBHOOK_URL` 后，轮到外接座位（或有人在牌桌
   聊天里跟它说话）时，服务端 POST 一份 JSON 简报过去，你可以桥接到任何通知
   或 agent 系统。

一个 AI 都不配？那就是一套干干净净的纯人类联机棋牌。

### 快速开始

```bash
git clone https://github.com/29-Cu/bisca.git
cd bisca
npm install

node cards/server.cjs      # → http://localhost:8081/cards
node daifugo/server.cjs    # → http://localhost:8079/daifugo
node monopoly/server.cjs   # → http://localhost:8078/monopoly
```

### 配置

全部走环境变量（或首启自动生成的 `data/config.json`）：

| 变量 | 默认 | 含义 |
|---|---|---|
| `PORT` | 8078 / 8079 / 8081 | 监听端口 |
| `BISCA_PASSWORD` | 未设 | 设了就出登录页、全站上锁。**不设 = 开放模式：能连上端口的人都是房主——内网随意，公网千万别裸奔。** |
| `BISCA_DATA_DIR` | `./data` | 房间/配置存储目录 |
| `CLAUDE_BIN` | `claude` | AI 分身用的 Claude Code CLI 可执行名 |
| `WAKE_WEBHOOK_URL` | 未设 | 外接座位轮次通知的 POST 目标 |

### 部署

systemd 示例在 [`deploy/`](deploy/)。反向代理（nginx / Caddy / Cloudflare Tunnel）
按路径分流即可：`/cards → :8081`、`/daifugo → :8079`、`/monopoly → :8078`——
应用本身就挂在这些前缀下。暴露公网前记得设 `BISCA_PASSWORD`。

### 设计文档与测试

每个服务的设计文档（引擎契约 / 规则拍板 / 测试策略）在 [`docs/`](docs/)。
`npm test` 一键跑全部测试（数百条引擎/服务端测试，含随机整局压测：
牌张守恒、永不死锁）。

### 许可

[CC BY 4.0](LICENSE) —— 随便用，署名 **Cu & Lunedì** 就行。

内置字体（`fonts/`，Manrope / Newsreader / Cormorant Garamond）单独适用
[SIL Open Font License 1.1](fonts/README.md)。
