# 大富翁（Monopoly 风格）— 设计文档

Bisca 三个服务之一。一句话：自托管的多人大富翁，浏览器直连、房间落盘、
断线重进原地续玩，除了 express 没有别的运行时依赖。

面向想改规则、改棋盘、或者往里加东西的人。想直接玩的看 README。

## 0. 架构总览

- 独立服务：`monopoly/server.cjs`，默认监听 `127.0.0.1:8078`（env `PORT` / `HOST` 可改）。
  三个游戏各跑各的进程，谁挂了不影响谁，重启也随意。
- 所有 URL 一律带 `/monopoly` 前缀（本地直连 8078 时也一样），方便一个反向代理
  按路径把三个服务挂在同一个域名下。
- 数据目录：默认 `monopoly/data/`，env `BISCA_DATA_DIR` 可覆盖，
  测试则用 `createServer({dataDir})` 注入。
  - `rooms/<code>.json` — 每房间一文件，**每步操作 tmp+rename 原子落盘**（服务重启棋局原地恢复）
  - `board.json` — 棋盘 40 格（首次启动从 `monopoly/defaults/` 复制一份进来，随便改）
  - `cards.json` — 机会/命运两副牌（同上）
  - `config.json` — 全局配置（热读）+ 服务自己生成的 `cookie_secret`
- 依赖：只有 express。**不用 ws**（SSE 够了，还免了代理层对 WebSocket 的额外配置）。

## 1. 认证

两档，取决于有没有设 env `BISCA_PASSWORD`：

- **没设 = open mode**：任何能连到这个端口的人都是 owner 级。自托管在内网/局域网
  时最省事的形态，也是默认。要暴露到公网就别用它。
- **设了 = 登录模式**：
  - `GET /monopoly/login` 出一个极简登录页（只有一个密码框，无用户名）。
  - `POST /monopoly/api/login` 校验密码（`timingSafeEqual`，不给计时侧信道），
    通过就下发 cookie `bisca_auth` = `authenticated.<签发ms>.<HMAC-sha256-base64url>`，
    `HttpOnly` + `SameSite=Lax` + 90 天，HTTPS 下（`req.secure` 或 `x-forwarded-proto`）加 `Secure`。
  - 未认证的**页面**请求 302 到本服务自己的登录页；API/fetch 请求照旧 JSON 403。
  - 表单口径和 JSON 口径都支持：登录页是原生 `<form>`，没有 JS 也能登进去；
    带 `Accept: application/json` 时返回 `{ok:true}` / 401。
  - 跳转参数 `?r=` 只接受本站绝对路径，挡开放重定向。

签名密钥 `cookie_secret` 放在 `data/config.json`，首次启动 `randomBytes(32)` 生成落盘，
没有任何硬编码兜底值。这个字段永远不会进 state、不会随 SSE 广播出去
（`gameConfig()` 剥掉它，`stripTokens()` 再兜一层）。

**座位 token**：每个座位入座时发 `playerToken`（`randomBytes(16).hex`），存在房间 JSON 里。
**所有游戏动作必须带座位 token** —— cookie 只是"进门"，token 定"你是谁"。
token 从不出现在 state / SSE / 大厅列表里。

**访客通道**（默认关）：`config.allow_guests=true` 时，没登录但带合法
`?invite=<房间 inviteToken>` 的请求可以观战/入座**该房间**，摸不到别的路由、
建不了房。房间创建时生成 `inviteToken`。开这个开关等于放宽认证边界，公网部署前想清楚。

## 2. 引擎 `monopoly/engine.cjs`（纯逻辑零 I/O，可单测）

- `createGame({players, board, cards, config, seed})` → state。players 2~4：`{id, name, color}`。
- `apply(state, playerId, action)` → `{state, events}`；非法动作 throw（带中文 message，前端直接显示）。
  **纯函数风格**：不改入参，返回新 state（浅拷贝够用，不上 immutable 库）。
- `legalActions(state, playerId)` / `buildableCells` / `rentFor` 导出给前端画按钮和测试驱动。
- RNG：确定性 xorshift128（seed 存 state，掷骰/洗牌/抽卡都走它）→ 单测可复现整局。
- 规则表（board / cards / config）随 state 走：开局那一刻的快照，之后改文件不影响进行中的局。
- state 骨架：
  ```
  { seq, createdAt, phase: 'awaiting_roll'|'awaiting_buy'|'awaiting_end'|'game_over',
    currentPlayer, dice: [a,b]|null, doublesCount, extraRoll,
    players: [{id,name,color,cash,pos,inJail,jailTurns,getOutFree,jailCards,bankrupt}],
    cells: { <idx>: {owner, houses} },        // 只存有主的格
    decks: { chance: {draw:[...], discard:[...]}, community: {...} },
    pendingCard: null | {deck, card},          // 抽到待确认的卡
    pendingDebt: null | {playerId, amount, creditor},  // 现金不足待破产确认
    debtQueue: [...],                          // 同一时刻第二笔付不起的欠款排队
    log: [ {seq, t, text, type} ],             // 追加式中文日志，前端直读
    winner: null, rngState, board, cards, config }
  ```
- 动作集：`roll` · `buy` · `decline`（不买即留空，无拍卖）· `build {cellIdx}` ·
  `sell_house {cellIdx}`（半价回收）· `end_turn` · `pay_bail` · `use_jail_card` ·
  `card_ack`（确认卡面后结算）· `declare_bankrupt`。

### 规则拍板（简化经典）

- 起点工资：过路 +salary（默认 2000）；踩上起点同。
- 地租：裸地 base；集齐同色全组且未盖房 ×2；房 1~4 + 旅馆（第 5 档）查 board 的 rents 表。
- 铁路 4 张：拥 n 条租 250·500·1000·2000。公用事业 2 张：拥 1 = 骰点×40，拥 2 = 骰点×100。
- 盖房：须集齐同色组、均衡建房（同组各格房数差 ≤1）、人在监狱里不能盖；卖房半价回收。
- 监狱：掷双数出狱 / 蹲满 3 回合强制交保 / 保释金 500 / 出狱卡。连掷三次双数 → 进监狱。
- 双数再掷一次（因双数进监狱那次除外）。
- 奢侈税（`type: 'luxury_tax'`）：踩到交 `config.luxury_tax`（默认 1000）给银行，
  日志随机抽一条该格 `flavor[]` 里的文案 —— 这是留给自定义梗的钩子。
- 破产：欠款时先自动半价卖房抵债（先卖贵的）；仍不足 → 挂 `pendingDebt`，
  该玩家只剩 `declare_bankrupt` 一个动作：地产归债主（欠银行则收归公），出局。
  剩一人即胜。同一时刻的第二笔欠款进 `debtQueue`，排队处理。
- 不做：交易、拍卖、抵押。这三样都需要多人协商 UI，跟"手机上随手玩两把"的定位冲突。

### 卡牌 effect DSL

牌面 `{id, text, effect}`，effect 七种：

```
{type:'money', amount}              正数进账、负数支出（对银行）
{type:'move_to', cell, collectGo}   移动到指定格；collectGo=false 表示路过起点不发工资
{type:'move_rel', n}                相对移动，负数后退（后退不发工资）
{type:'goto_jail'}                  直接进监狱，不过起点
{type:'get_out_free'}               拿一张出狱卡，持有期间此牌不回牌堆
{type:'per_player', amount}         正数向其他每人各收，负数向每人各付
{type:'repairs', perHouse, perHotel} 按自己名下房屋/旅馆数向银行付修缮费
```

抽完自动把弃牌堆洗回来，所以每副牌几张都行；加牌只要保证 id 不撞。

## 3. 棋盘 `data/board.json`

40 格数组，idx 0 = 起点，顺时针。每格：

```
{ idx, type: 'go'|'prop'|'rail'|'util'|'tax'|'luxury_tax'|'chance'|'community'|'jail'|'goto_jail'|'parking',
  name, group?, price?, rents?: [裸,1,2,3,4,旅馆], houseCost?, amount?, flavor?[] }
```

- 8 个颜色组 `group: 'g1'..'g8'`，前端按组配色；同组必须买齐才能盖房。
- 格子数必须正好 40 且 idx 连续 —— 前端棋盘是 11×11 周圈硬布局，多一格少一格都会错位。
- 默认数值参考经典美版 ×10 的手感（起始现金 15000、工资 2000、保释 500）。
- 文件顶部有 `_readme` 键写明怎么改，改完新开的房间即生效（进行中的局用开局快照）。

## 4. 服务 `monopoly/server.cjs`

路由（全部 `/monopoly` 前缀）：

- 静态 `public/`（`/monopoly/` → 大厅，`/monopoly/room.html?c=<code>` → 房间）
- `GET  /monopoly/login`、`POST /monopoly/api/login` —— 登录模式下的两条，在认证门之前
  （也认不带前缀的 `/login` `/api/login`，方便反向代理把前缀剥掉的部署）
- `POST /monopoly/api/rooms` `{name}` → `{code, inviteToken}`（code 6 位可读字符，去掉了 I L O 0 1）
- `GET  /monopoly/api/rooms` → 大厅列表（近 20 个，含状态/人数）
- `POST /monopoly/api/rooms/:code/join` `{name, color, playerToken?}` → `{playerId, playerToken}`
  （带旧 token 回来 = 复座；满 4 人拒绝；开局后不能再入座）
- `POST /monopoly/api/rooms/:code/start` `{playerToken}`（房主 = 第一个入座者，≥2 人）
- `GET  /monopoly/api/rooms/:code/state` → `{seq, state}`（脱敏：不含任何座位 token）
- `GET  /monopoly/api/rooms/:code/events` → SSE：连上先推全量 `state`，之后每次动作推全量
  （state 才几 KB，全量最稳，不用做增量对账）；25s 心跳 `:ping`
- `POST /monopoly/api/rooms/:code/action` `{playerToken, type, ...}` → engine.apply →
  原子落盘 → 广播 → `{ok, seq, events}` / `{error: 中文}`
- 静态主题/字体：`/assets-theme` → 仓库根的 `assets/`，`/fonts` → 仓库根的 `fonts/`，
  两者都挂在认证门之前（登录页自己也要用），同时注册裸路径与 `/monopoly` 前缀两套挂载点。

其它：

- 观战 = 通过了认证但没有座位 token：能看 state / SSE，动不了。
- 落盘即真相：进程内存只是缓存，重启后 lazy load 房间文件继续玩。
- 房间 code 碰撞重试 30 次；`rooms/` 超 200 个文件时启动清理最旧的"已结束"房间
  （有 winner，或没开局且超 7 天）。

## 5. 前端 `monopoly/public/`（vanilla，无构建）

- `index.html` 大厅：建房间（房间名 + 昵称 + 棋子色）、房间列表（等人中/进行中/已结束）。
- `room.html` 房间：
  - **棋盘**：11×11 CSS grid 周圈 40 格，中央区放骰子和日志。格子显示名、价、组色条、
    房子（1~4 小方块 / 旅馆一枚）、在场棋子（玩家色圆点）。
  - **手机**：棋盘支持双指缩放 + 单指拖动（自写 pointer events，transform 缩放 0.6x~2.5x），
    默认缩到适配屏宽；桌面滚轮缩放。不做完整响应式，能玩即可。
  - **骰子**：两枚 CSS 3D 骰子，摇 0.8s 后定格真实点数。
  - **操作条**：底部固定，随 phase 显示合法按钮；轮不到你时显示"等 xx 行动"。
  - **格子详情**：点格子弹 popover（租金表 / 归属 / 盖房按钮）。
  - **卡牌**：抽到机会/命运居中翻牌，点确认才结算（发 `card_ack`）。
  - **胜利屏**：winner 定格 + CSS 粒子撒花（不引库）。
  - SSE 断线自动重连（3s 退避），连续失败退化成 3s 轮询 state；`seq` 只前进不回退。
- `js/rules.js` 是 `engine.legalActions` 的浏览器只读版，**只用来决定画哪几个按钮**，
  合法性最终以后端为准（400 会带中文原因，直接 toast）。改引擎规则记得同步这份。
- 座位 token 存 localStorage（按房间码分键），刷新/重进凭它复座。

## 6. 测试

- `test/engine.test.cjs`：过路工资 / 各档租金 / 铁路公用 / 监狱三条出路 / 三连双 /
  均衡建房与非法盖房 / 卡牌七种 effect / 自动卖房抵债 / 破产清算与欠条排队 / 奢侈税 /
  固定 seed 两人整局打到分胜负的确定性回放（跑两遍必须逐字节一致）/ 默认棋盘牌堆结构校验。
- `test/server.test.cjs`：起临时端口 + 临时 dataDir 的实例（engine 用 `test/engine-stub.cjs` 注入），
  走完 403 → 建房 → 双人入座 → start → action → state seq 增长 → SSE 收到广播 → 重启恢复；
  另有三组认证测试：open mode 全 owner、登录模式（302 到登录页 / 密码错 401 / 密码对发 cookie /
  开放重定向被挡）、访客 invite（开关没开不认、只摸得到自己那间房、建不了房）。
- `npm test` = `node --test test/*.test.cjs`。
- `test/ui-check.mjs` 是 playwright 的手动验收脚本（两个 context 同房对局 + 截图 + 手机视口），
  不进 `npm test`，需要自己装 playwright。
