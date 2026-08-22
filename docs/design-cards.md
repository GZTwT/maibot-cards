# Bisca 棋牌室（cards）设计文档

一个服务装三个游戏：**斗地主 (ddz) / 炸金花 (zjh) / UNO (uno)**。
默认监听 `127.0.0.1:8081`，URL 前缀 `/cards`。给贡献者看的架构说明在这儿，
玩法说明在前端页面里。

## 0. 架构：一个服务装三个游戏

- 单进程 `cards/server.cjs`，唯一运行时依赖是 express（无 ws，无数据库）。
- **落盘即真相**：房间存 `data/cards/rooms/<code>.json`，每步 `tmp + rename` 原子写，
  进程内存只是缓存。重启后牌局、座位、聊天全在。
- 底盘与同仓的 daifugo 服务同构（认证 / 静态资源豁免 / 房间落盘 / SSE 分视角 /
  牌桌聊天 / 访客邀请 / 关房 / AI 邀请落座 / 自动 AI CLI 驱动 / 外接 agent 唤醒 /
  重启恢复），唯一的结构差异是**多游戏**：
  1. 引擎注册表 `ENGINES = {ddz, zjh, uno}`，`safeRequire` 包着——某个引擎坏了 / 缺了，
     服务照起，只在"建这个 game 的房"时回 503。
  2. 房间带 `game` 字段，一切 `engine.*` 调用按房间取 `ENGINES[room.game]`。
  3. 人数上限 / 规则默认值 / 牌桌简报 / 招式人话全走
     `engine.meta` / `engine.briefing` / `engine.fmtMove`——服务端不认识任何一个游戏的规则。
- 数据目录默认 `<服务目录>/data`，env `BISCA_DATA_DIR` 可覆盖；
  端口默认 8081，env `PORT` / `HOST` 可覆盖。

## 1. 引擎统一契约

三个引擎都是**纯逻辑、零 I/O** 的 CommonJS 模块，可以单独 `node --test`，
也可以被前端当模块加载（`GET /cards/engine/<game>.js` 原样送源码，前端拿它做出牌预判）。

模块导出：

- `meta` = `{ key, name, minPlayers, maxPlayers, defaultRules, ruleMeta:[{key,label,note,def}] }`
- `createGame({players, config, rules, seed})` → state。确定性 xorshift128 RNG，
  同 seed 必得同一局（压测和复现靠它）。
- `apply(state, playerId, action)` → `{state, events}`；非法动作 throw 中文 message。
- `legalMoves(state, playerId)` → 合法动作数组（不轮到他返回 `[]`；`round_over` 返回 `[{type:'next_round'}]`）。
- `viewFor(state, playerId|null)` → 脱敏视图（自己的私密信息全量；他人只有可公开信息；`null` = 观战）。
- `currentActors(state)` → 现在欠动作的 playerId 数组（自动 AI / 唤醒驱动靠它，`game_over` 返回 `[]`）。
- `briefing(state, playerId)` → 中文局面简报（手牌 / 桌面 / 筹码等，不含合法招列表）。
- `fmtMove(move)` → 一招的人话（"跟注 20" / "出 ♠3♠4♠5" / "红5"）。

state 骨架必须有：`seq, phase, round, players:[{id,name,isAI,score,...}], log:[{seq,t,text}], rngState`。
计分累计进 `players[].score`；`end_match` 动作由房主结束整场（`phase → game_over`）。

**服务端不猜回合**：谁欠动作一律问 `currentActors`，因为三个游戏的 phase 名各不相同。
`round_over` 故意不列人——开下一局是真人的决定，不让自动 AI 自己续摊烧 CLI。

## 2. 三个游戏的规则拍板

### 斗地主 (ddz) — 恰好 3 人

经典：17×3 + 3 底牌；叫分 1/2/3（`bid`，0 = 不叫，全不叫重发）；地主得底牌明示。
牌型：单 / 对 / 三条 / 三带一 / 三带对 / 顺子(5+) / 连对(3+) / 飞机(±翅膀) / 四带二 / 炸弹 / 王炸。
2 不入顺；炸弹王炸砸一切。计分：底分 × 倍数（炸弹 / 王炸每响 ×2，春天 / 反春 ×2），
地主赢收两家、输赔两家。开关：`allow_four_two`（四带二，默认开）。
牌 id：`S3..S15, X1, X2`（**X1 是小王、X2 是大王**）。

### 炸金花 (zjh) — 2~4 人

52 张无王，每人 3 张。入局每人 1000 筹码，底注 10（rules 可调）。
轮流行动：`look`（看牌）/ `bet {amount}`（跟或加，闷牌减半计）/ `fold` / `compare {target}`
（比牌，付当前注，输家弃）。牌力：豹子 > 顺金 > 金花 > 顺子 > 对子 > 散牌；A23 算最小顺。
只剩一人或比到只剩一人 → 本局结束赢池。
开关：`blind_play`（闷牌，默认开）、`special_235`（235 克豹子，默认关）、`base_bet`、`start_chips`。
牌 id 同上（无王），**A 最大 2 最小的强度映射由引擎内部自管，id 不变**。

### UNO (uno) — 2~4 人

官方基础规则：每人 7 张；数字 0-9、Skip、Reverse、+2 各色，万能 W、W+4。
动作：`play {card, color?}`（万能牌必带 color）/ `draw`（摸一张，能出可立刻 `play`，不出 `keep`）。
+4 不做质疑规则；喊 UNO 自动（不做罚则）。一人出完 → 本局结束，
按对手手牌计分（数字面值 / 功能 20 / 万能 50）累计。开关：`stack_draw2`（+2 可叠加，默认关）。
牌 id **每张物理牌唯一**（如 `R5#1`、`R5#2`、`W4#3`），viewFor / 前端都认 id。

## 3. 认证与访问控制

三层身份，authGate 一处判：

| 身份 | 凭证 | 能做什么 |
| --- | --- | --- |
| `owner` | `bisca_auth` cookie（或 open mode） | 全部 |
| `agent` | `X-Internal-Key` 头 | 内部 agent 通道（见 §5） |
| `guest` | 房间 invite token | 只能摸自己那一个房间 |

- **登录两档**：设了 env `BISCA_PASSWORD` → 启用登录，`GET /cards/login` 是本服务自带的
  极简登录页，`POST /cards/api/login {password}` 密码对上就发 cookie
  （HMAC 签名、HttpOnly、SameSite=Lax、Max-Age 90 天，HTTPS 下加 Secure）。
  没设 → **open mode**：谁能连上端口谁就是 owner，给自托管内网用。**公网部署一定要设密码。**
- cookie 签名密钥 `cookie_secret` 首次启动随机生成落进 `data/cards/config.json`，不入库。
- 访客邀请：`config.json` 的 `allow_guests` 打开后，带房间 inviteToken 的人可以进那一个房间
  （建房 / 关房 / 摸别的房一律 403）。
- **静态子资源（js/css/图/字体/engine 源码）免凭证**：不然访客拿邀请链接打开页面，
  script/css 子请求不带 invite 会全 403。`.html` 页面故意不豁免——没凭证就该去登录页。

## 4. AI 座位

建房时可以勾 AI 玩家，房主（第一个真人）入座后它们自动落座
（不能在建房时就坐，否则 `seats[0]` 的 isHost 会落在 AI 头上）。两类：

- **自动 AI**（`opus` / `sonnet` / `haiku`）：服务端起本机的 Claude Code CLI 单发一次
  （不续会话、不喂 system prompt、不给工具，就是个便宜的出牌脑子），把引擎写的简报 +
  编号过的合法招喂进去，要它回 `{"move":"p2","say":"可选的一句话"}`。
  可执行名用 env `CLAUDE_BIN` 换（默认 `claude`）。
  **没装 CLI / 超时 / 回话看不懂 → 自动兜底出第一招**，牌局永远不卡住。
  开场人设句可在 `config.json` 用 `ai_persona` 覆写（支持 `{seatName}` / `{gameName}` 占位）。
- **外接 agent**（`external`）：服务端不驱动，等外部程序走 `X-Internal-Key` 通道出牌。
  轮到它、或牌桌有人说话时，如果配了 `WAKE_WEBHOOK_URL`（env 或 `config.json` 的
  `wake_webhook_url`），就往那个地址 POST 一个 JSON
  （`kind/code/roomName/game/gameName/phase/seatName/briefing/moveLines/chatLines/text`），
  自己桥接到任何通知或 agent 系统；没配就不叫，纯等 API。
  `config.json` 里 `wake_external_on_turn:false` 可整体关掉。

防轰炸：每个"回合身份"（`房号:seq:phase`）只叫一次，聊天 / 重连引起的 broadcast 不会重复叫；
聊天捎信另有去抖（10s）+ 冷却（120s）。

## 5. HTTP 接口

人类通道（cookie / invite）：

- `POST /cards/api/rooms` `{game, name, rules?, ai_players?}` → `{code, inviteToken}`
- `GET /cards/api/rooms[?game=]` → 游戏目录 + 房间列表
- `POST /cards/api/rooms/:code/join` `{name, playerToken?}` → 座位（带旧 token 回来 = 复座）
- `POST /cards/api/rooms/:code/start` `{playerToken}` — 仅房主，人数按 `engine.meta` 把关
- `GET /cards/api/rooms/:code/state?token=` → 分视角视图（无 token = 观战）
- `GET /cards/api/rooms/:code/events?token=` → SSE，**每条连接按自己的 playerId 单独算视图**，
  25s `:ping`
- `POST /cards/api/rooms/:code/action` `{playerToken, type, ...}`
- `POST /cards/api/rooms/:code/chat` `{playerToken?, name?, text}`
- `POST /cards/api/rooms/:code/close` `{playerToken?}` — 踢线 + 删档

内部 agent 通道（`X-Internal-Key`，key 在 `config.json`，供外部 bot / agent 程序接入出牌）：

- `GET /cards/api/agent/rooms`
- `POST /cards/api/agent/:code/join` `{agent_id, name}`（幂等，同 id 复用同座位）
- `GET /cards/api/agent/:code/view?agent_id=` → 视图 + 合法招 + `briefing` + `moveLines`
- `POST /cards/api/agent/:code/act` `{agent_id, type, ...}`
- `POST /cards/api/agent/:code/chat` `{agent_id, text}`

**脱敏是硬要求**：座位 token / invite token 绝不出现在 state、视图或 SSE 里
（`stripTokens` 递归剥），别人的手牌和私密字段一律由 `engine.viewFor` 摘掉，
引擎没导出 `viewFor` 时服务端还有一层保底脱敏。

## 6. 测试策略

`npm test`（`node --test test/`）：

- 每引擎 `test/<key>.test.cjs`：牌型 / 比大小 / 流程判定全覆盖，外加**随机压测**——
  随机合法动作打满 N 局不 throw、牌张（和筹码）守恒、永不死锁
  （每个非终局状态 `currentActors` 非空且各有合法招）。
- `test/server.test.cjs`：临时端口 + 临时 dataDir + **stub 引擎**（不依赖真引擎），
  覆盖认证 / 登录 / open mode / 建房分流 / 人数上限 / SSE 分视角脱敏 / agent 通道 /
  牌桌聊天 / 访客邀请 / 关房 / 外接 agent 唤醒 / 自动 AI / 重启恢复。
  唤醒和 AI 出牌都用注入的假实现（`opts.externalWaker` / `opts.aiMover`），测试不发真请求、
  不烧真 CLI。

## 7. 前端

`cards/public/`，vanilla JS + 375px 优先：

- `index.html` 大厅：三个游戏 tab、建房面板（规则开关表**不写死**，
  由 `CdAPI.gameMeta(game)` 把引擎源码当模块加载，读它的 `meta.ruleMeta` 现渲染）+ AI 邀请。
- `room.html?c=` 只做一件事：拿房间码问服务端这间房是什么游戏，然后跳对应牌桌页，
  invite 参数原样传下去。
- 每游戏一张牌桌页：`ddz.html` / `zjh.html` / `uno.html`，共享 `js/api.js` + `js/ui.js`，
  各自的牌面 / 牌桌逻辑在各自的 `js/<game>-room.js`。
- UNO 牌面色块 + 符号双编码（色盲友好）；炸金花暗牌背面 + 看牌翻面 + 筹码池；
  斗地主手牌扇面 + 地主徽标 + 底牌明示区。
- 图标是线框 SVG（`BiscaIcons` 或同规格手写 24×24 stroke 1.8），零 emoji 当图标。

## 8. 边界（v1 不做）

炸金花真钱 / 跨房钱包（每房独立筹码）；UNO 质疑与罚喊；斗地主明牌 / 加倍抢地主变体；
观战回放；音效。旧房清理：`rooms/` 超 200 个文件时删最旧的已结束房间
（`game_over`，或未开局且超 7 天）。
