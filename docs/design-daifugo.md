# 大富豪 (Daifugō) — 设计文档

自托管的多人在线大富豪牌桌：2~4 人，标准全套规则 + 可选规则开关，AI 牌友可以上桌，
外接 agent 也能占一个座位。独立进程、独立数据目录，除 express 外零依赖。

这份文档给贡献者看：架构怎么切、引擎和服务之间的契约是什么、规则是怎么拍板的、测试策略在哪。

## 0. 架构

- 单进程 `daifugo/server.cjs`，默认监听 `127.0.0.1:8079`（env `PORT` / `HOST` 可覆盖）。
  所有 URL 带 `/daifugo` 前缀，方便挂在反代的一条 path 路由后面。
- 数据目录默认 `daifugo/data/`（env `BISCA_DATA_DIR` 可覆盖，测试用 `opts.dataDir` 注入）：
  - `rooms/<code>.json` —— 每步 tmp+rename 原子落盘，**盘上是真相**，进程内存只是缓存，
    重启原地恢复；房间文件超 200 个时清理已结束/超 7 天没开局的房。
  - `config.json` —— 热读，首启自动生成：
    ```json
    {
      "allow_guests": false,
      "cookie_secret": "<64 hex>",     // 登录 cookie 的 HMAC 密钥，自动生成
      "internal_key": "<48 hex>",      // bot / agent 通道钥匙，自动生成
      "defaults": { "spade3": true, "shibari": false, "kaidan_revolution": false,
                    "forbid_finish": true, "miyako_ochi": false },
      "ai_persona": "可选：覆写 AI 牌友的开场人设",
      "wake_webhook_url": "可选：轮到外接 agent 时通知谁",
      "wake_external_on_turn": true    // 设 false 可整体关掉外接 agent 的通知
    }
    ```
- 认证三层：
  1. **登录 cookie `bisca_auth`**（HMAC 签名，密钥取 `config.cookie_secret`）= 进门。
     env `BISCA_PASSWORD` 设了就启用：`GET /daifugo/login` 是极简密码页，
     `POST /daifugo/api/login` 校验后下发 cookie（HttpOnly / SameSite=Lax / 90 天 /
     HTTPS 下加 Secure）。**没设 = open mode**：谁能连上谁就是主人，适合内网自托管；
     公网部署务必设密码。
  2. **座位 token**（`randomBytes(16).hex`，只存在房间文件里）= 你是谁，一切动作必带。
     token 绝不进任何视图、SSE 或回执（`stripTokens` 统一过滤）。
  3. **内部 agent 通道**：header `X-Internal-Key` == `config.internal_key` 的请求视同 owner，
     走 `/daifugo/api/agent/*` 路由，供外部 bot / agent 程序接入出牌。
  - 另有**访客 invite token**（`config.allow_guests` 开启时生效）：拿邀请链接的人只能摸
     自己那一间房，建不了房、进不了别的房。
  - 静态子资源（js/css/图/字体）豁免门禁——不然访客拿邀请链接能打开页面，
    但 script/css 子请求不带 invite 全 403。`.html` 页面故意不豁免。

## 1. 引擎 `daifugo/engine.cjs`（纯逻辑零 I/O）

引擎和服务之间只有三个函数的契约，服务端不认识任何牌理：

- `createGame({players, config, rules, seed})` → `state`。players 2~4 个 `{id, name, isAI}`。
  规则表按 `DEFAULT_RULES` ← `config.defaults` ← `rules` 的顺序合并，只留认识的开关。
  确定性 xorshift128 RNG（seed 进 state，洗牌/定先手全走它），整局可回放。
- `apply(state, playerId, action)` → `{state, events}`；非法动作 throw 中文 message（前端直显）。
- `legalMoves(state, playerId)` → 合法出牌列表。**必须导出**——AI 牌友和前端提示都吃它。
- `viewFor(state, playerId|null)` → 脱敏视图：自己手牌全量，他人只有 `handCount`，
  `null` = 观战（谁的手牌都看不到）。换牌阶段给/收的牌只对当事双方可见。

### 牌与强度

- 54 张：52 + 大小王。牌 id 是字符串：`"S3".."S15"`（S/H/D/C 四花色，11=J 12=Q 13=K 14=A 15=2），
  王是 `"X1"`、`"X2"`。
- 强度：普通牌 rank 3..15；王恒为最强（革命不翻王）。革命时普通牌强度取反（3 最大、2 最小）。

### state 骨架

```
{ seq, phase: 'exchange'|'playing'|'round_over'|'game_over',
  round, turnOrder:[playerId...], current, leader,
  players:[{id,name,isAI,hand:[...],rank:null|'daifugo'|'fugo'|'heimin'|'hinmin'|'daihinmin',
            finished:null|次序, passed:false, foul:null, score}],
  field: null|{cards:[...], by, combo:{type,size,strength}}, lastToPlay,
  revolution:false, suitLock:null|['S',...],
  exchange: null|{pending:[{from,to,count,taken:[...],given:[...]|null}]},
  rules:{...生效开关}, log:[{seq,t,text,type}], rngState }
```

### 规则（标准全套）

- **发牌**：洗牌后顺时针轮发到尽（4 人 = 13/13/14/14）。第 1 轮先手随机；以后各轮大贫民先出。
  换牌回合中富方未回牌前不能开打。
- **牌型**：单张 / 对子 / 三条 / 四条+（同 rank，王可替任意）/ **阶梯**（同花色 3 张以上连号，王可补位）。
- **跟牌**：同型同张数、按当前强度序**严格更大**。同 rank 组比 rank；阶梯比双方**最强一张**。
  王当替身时取所替之牌的 rank；王单出 = 最强单张。
- **过（pass）**：过了本墩内不能再出（锁到清场）。其余在场者全过 → 清场，最后出牌者重新领出；
  若其已出完，顺位下一个未完者领出。
- **八切**：出的牌里含 8（任意张数/牌型）→ 立即清场，出牌者继续领出。革命中同样生效。
- **革命**：四条+（含王替）触发，强度反转直到再次革命或本轮结束。
- **出完与名次**：出完即定次序。4 人：大富豪/富豪/贫民/大贫民；3 人：大富豪/平民/大贫民；
  2 人：大富豪/大贫民。倒数第二人出完即封轮（最后一人自动垫底）→ `round_over`。
- **换牌**（第 2 轮起）：大富豪↔大贫民 2 张、富豪↔贫民 1 张。贫方**自动**上缴当前序最强牌（含王）；
  富方从手牌任选回赠（action `give_back {cards}`）。回齐前 phase 停在 `exchange`。
- **计分**：每轮按名次得分，4 人 3/2/1/0（3 人 2/1/0，2 人 1/0），累计进 `players[].score`。
  不设固定局数——想玩几轮玩几轮，房主可 `end_match` 出总榜（phase `game_over`）。
- 动作集：`play {cards}` · `pass` · `give_back {cards}` · `next_round` · `end_match`（房主）。

### 可选规则开关（建房时勾，落进 `state.rules`）

| key | 默认 | 说明 |
| --- | --- | --- |
| `spade3` | 开 | スペ3 返し：王单出时黑桃 3 可反杀（只对单王，杀完按 S3 留场） |
| `shibari` | 关 | 縛り：本墩内连续两手花色组完全一致 → 本墩锁花色 |
| `kaidan_revolution` | 关 | 阶梯革命：5 张以上阶梯也触发革命 |
| `forbid_finish` | 开 | 禁止上がり：最后一手含 2（革命中为 3）/王/8 或 スペ3 收尾 = 判本轮垫底 |
| `miyako_ochi` | 关 | 都落ち：上轮大富豪没能第一个出完，当场跌成大贫民 |

开关的传递链是：建房 `POST /api/rooms {rules}` → `resolveRules`（只认已知 key，
`config.defaults` 打底）→ 房间文件 `room.rules` → 开局时一并塞进 `createGame({config, rules})`
→ `state.rules`。**改这条链的任何一环都要跑 `test/server.test.cjs` 里那条「规则开关真的传进引擎」**——
它用真引擎从建房一路断言到 `state.rules`，就是为了防这条链再断一次。

## 2. 服务 `daifugo/server.cjs`

### 玩家路由（`/daifugo` 前缀）

- `POST /api/rooms` `{name, rules?, ai_players?}` → `{code, inviteToken, rules}`
- `GET /api/rooms` → 大厅列表 + `defaults`（服务端规则默认值，前端建房面板照它摆开关）
- `POST /api/rooms/:code/join` `{name}` / `{playerToken}`（带旧 token = 复座）
- `POST /api/rooms/:code/start`（房主，≥2 人）
- `GET /api/rooms/:code/state?token=` → **viewFor 脱敏视图**（无 token = 观战视图）
- `GET /api/rooms/:code/events?token=` → SSE，连上先推自己的视图，之后每次变更再推，25s `:ping`
- `POST /api/rooms/:code/action` `{playerToken, type, ...}` → apply → 落盘 → 分视角广播
- `POST /api/rooms/:code/chat` `{playerToken?, name?, text}` → 牌桌闲聊（观战路人也能说）
- `POST /api/rooms/:code/close` → 踢线 + 删档（房主 / owner / agent 通道）

**关键设计：分视角广播。** 不能像普通房间服务那样广播单一 state——每条 SSE 连接记住自己的
`playerId`，各自调 `engine.viewFor` 后推自己的视图，绝不把 A 的手牌推给 B。
同视角的连接共用一次序列化。

### agent 通道（`X-Internal-Key`）

- `GET /api/agent/rooms` — 大厅列表（含哪些房有 agent 座位）
- `POST /api/agent/:code/join` `{agent_id, name}` — 入座，`agentSeats:{agent_id:playerId}`；
  重复 join = 返回已有座位（幂等，断续会话免丢座）
- `GET /api/agent/:code/view?agent_id=` — `{view, legal, yourTurn, chat, currentName}`
- `POST /api/agent/:code/act` `{agent_id, type, cards?}` — 同 action
- `POST /api/agent/:code/chat` `{agent_id, text}` — 用座位身份在牌桌上说话

写一个 bot 的最短路径：读 `data/config.json` 拿 `internal_key` → join → 轮询/等 webhook →
`view` 拿 `legal` → `act`。

## 3. AI 牌友与外接 agent

建房时的「请谁上桌」勾选项（`ai_players`）分两档，房主（第一个人类）入座后服务端自动落座——
不能在建房时就坐，否则 `seats[0]` 的 `isHost` 会落在 AI 头上。

### 自动档：`opus` / `sonnet` / `haiku`

轮到这类座位时服务端自己动手：拼一份牌桌简报（手牌按强度排、场面是谁的什么牌、**编号过的合法招**、
最近闲聊）喂给本机的 Claude Code CLI 单发一次（env `CLAUDE_BIN` 可换可执行名），
要它只回 `{"move":"p2","say":"可选的一句话"}`。

- 人设句可配：`config.ai_persona`（支持 `{seatName}` / `{gameName}` 占位符）。
- 落地前顿 `AUTO_DELAY_MS`(1.2s)，别快得像机器；每房一把锁防并发重入。
- **兜底永不卡局**：机器上没装 CLI、超时、回了看不懂的东西、或者引擎拒了这一招——
  一律改出 `legal[0]` 并闭嘴。启动时还会扫一遍房间，把重启前正轮到 AI 的局接着走完。
- `opts.aiMover` 是注入口，测试用它换掉真 CLI。

### 外接档：`external`

这个座位服务端**不替它出牌**，等外部程序走 agent 通道动手。轮到它时：

- 配了 `WAKE_WEBHOOK_URL`（env 或 `config.wake_webhook_url`）就 POST 一个 JSON 过去，
  字段：`{kind:"turn"|"chat", code, roomName, game, gameName, phase, seatName, agentId,
  briefing, moveLines, chatLines}`——`briefing` 已经是排好版的牌桌简报，收到通知的 agent
  不用再拉一次 view 就能出牌。桥到什么系统（IM 推送、任务队列、另一个 agent runtime）随你。
- 没配就不叫，纯等 API 轮询。
- 防轰炸：每个「回合身份」(`code:seq:phase`) 只叫一次，聊天/重连引起的 broadcast 不重复触发；
  牌桌闲聊的捎信另有去抖（10s）+ 冷却（120s）。
- `opts.externalWaker` 是注入口（测试用）；`config.wake_external_on_turn:false` 整体关掉。

## 4. 前端 `daifugo/public/`（vanilla，手机优先）

- `index.html` 大厅：建房（房间名/昵称 + 规则开关折叠面板 + 请谁上桌）+ 房间列表轮询。
- `room.html` 牌桌：
  - 中央场面（当前墩的牌 + 谁出的 + 革命/縛り徽标），上方对手条（名/剩余张数/轮到高亮/名次徽章），
    底部**自己的手牌扇面**：横向可滚、点选多张（选中上浮），「出牌」「过」大按钮。
  - 合法性前端预判走 `js/rules.js`（服务端把 `engine.cjs` 原样挂在 `/daifugo/engine.js`，
    前端复用同一套判定逻辑），非法置灰并给原因——**只是体验优化，真判定永远在服务端**。
  - 牌面是纯 CSS 画的（rank 大字 + 花色符，红黑分色，王画 ★），没有图片资源。
  - 换牌阶段 UI、计分板抽屉、名次揭晓卡、革命特效（全场旋转翻色）。
  - 断线复座（localStorage 存座位 token）、SSE 重连 3s 退避、连续失败退化成 3s 轮询、
    `seq` 只前进不回退。
  - 观战：没座位自动只读，看得到场面与张数，看不到任何手牌。
- `js/api.js` 是唯一的后端封装层（REST + `openSync` 同步 + 座位 token 存取）。
  改协议只改这一处。
- 主题三件套走 `/assets-theme`（仓库根 `assets/`），字体走 `/fonts`（仓库根 `fonts/`），
  服务端本地静态服务，挂在认证门之前。图标库全局名 `BiscaIcons`，取不到就渲染空字符串。

## 5. 测试策略

- `test/engine.test.cjs` —— 纯引擎：牌型判定 / 跟牌合法性（同型同数严格大）/ 王替身与王单 /
  スペ3 反杀 / 八切清场 / 革命与反转比大小 / 阶梯（含王补位、比最强张）/ pass 锁墩与清场归属 /
  领出权继承 / 换牌自动上缴 + 回赠 / 禁止上がり判垫底 / 都落ち / 縛り / 2·3·4 人名次表 /
  计分累计 / 固定 seed 整轮确定性回放；外加随机压测：随机合法动作打满多轮不 throw、
  手牌总数守恒 54、无死锁（每个状态至少一个合法动作，或 phase 已转移）。
- `test/server.test.cjs` —— 临时端口 + 临时 dataDir 起真服务：
  认证两档（open mode / 密码档登录流程）、建房、入座、agent join 幂等、出牌、
  **SSE 分视角脱敏（A 的推送里绝不含 B 的手牌，逐张断言）**、访客 invite 边界、
  牌桌聊天、外接 agent 通知的去重与冷却、自动 AI 座位替打、规则开关传递链、重启恢复。
- 大部分服务端用例注入 `test/engine-stub.cjs`（发牌写死成「每家一个花色」，断言起来干净）；
  规则开关那条用例专门用真引擎，因为它测的就是服务→引擎的参数传递。
- 注入口一览：`opts.dataDir` / `opts.engine` / `opts.enginePath` / `opts.cookieSecret` /
  `opts.password` / `opts.aiMover` / `opts.externalWaker` / `opts.externalWakeDelayMs` /
  `opts.chatWakeDebounceMs` / `opts.chatWakeCooldownMs`。
  **新写涉及 AI 座位或外接座位的用例，一定要注 `aiMover` / `externalWaker`**，
  否则测试会真去起 CLI、真去打 webhook。

## 6. 边界与未做

- 不做：出牌倒计时/托管、观战回放、音效。
- 洗牌公平性：确定性 RNG 够用，不上加密洗牌。
- 房间数量上限与旧房清理是启动时扫一遍，不做后台定时任务。
