# MaiBot 牌桌（MaiBot 插件）

> **开发声明**：本插件围绕 [MaiBot](https://github.com/Mai-with-u/MaiBot) 生态开发，
> **基于开源项目 [29-Cu/bisca](https://github.com/29-Cu/bisca) 二次开发**，
> 由 **DeepSeek V4.1 Flash 1017** 参与编写与调试，非 MaiBot 官方项目，也不代表官方立场。
> **仅供娱乐**：牌桌只玩虚拟筹码、不涉及任何真实货币或赌博行为；AI 出牌可能不合常理、
> 也可能出错，请勿用于任何正式或高风险用途。完整免责条款见文末 [免责声明](#免责声明)。

## 开源来源与二次开发声明

本项目基于 **[29-Cu/bisca](https://github.com/29-Cu/bisca)** 二次开发，
原项目以 [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) 许可发布。
本项目不是上游官方版本，与上游作者无隶属或背书关系。

- **沿用上游**：牌桌前端页面与样式、游戏引擎（`cards/engines/`）、
  牌桌服务（`cards/server.cjs`，打包为 `bisca_server/`）、字体与主题资源。
- **本仓库新增 / 修改**：MaiBot 插件层（`plugin.py`、`config.py`、
  `server_runtime.py`、`tunnel.py`、插件详情页配置）、群聊开桌与聊天桥、
  `party` 开桌页、斗地主与炸金花 AI 策略（`ddz-strategy.cjs`、
  `zjh-strategy.cjs`）、内置服务打包与自检工具（`bisca_server/`、`tools/`）。
- 上游代码版权归原作者（`Cu & Lunedì`）所有；本仓库的修改部分同样按
  CC-BY-4.0 发布，完整署名见 [LICENSE](LICENSE)。

想用原版上游，请直接访问 [29-Cu/bisca](https://github.com/29-Cu/bisca)。

群友在群里发一句 `uno`、`炸金花` 或 `斗地主`，MaiBot 开一桌并回一条入座链接。
群友点开链接用手机网页入座、出牌；MaiBot 固定占一个座位，人满自动开局，由 Bisca 服务端
自动出牌，不需要任何人在群里发指令。

插件本身只做三件事：调 `POST /cards/api/party` 开桌，把 `inviteUrl` 发回群里，
并在内网开一个聊天桥，把牌桌聊天/赛果写进这个群的 MaiBot 记忆并回一句。
它不派生玩家 token，也不替人出牌。

## 安装

**暂未上传 MaiBot 插件市场**，目前只能手动安装（复制目录或解压 zip）。
仓库地址：[GZTwT/maibot-cards](https://github.com/GZTwT/maibot-cards)，插件位于
仓库的 `maibot-plugin/` 子目录。

### 手动安装

```powershell
git clone https://github.com/GZTwT/maibot-cards.git
```

把仓库里的 `maibot-plugin\` 整个复制到 MaiBot 的插件目录，并重命名为任意目录名，例如：

```text
E:\github\MaiBot\data\MaiMBot\plugins\maibot-cards\
```

`plugin.py` / `_manifest.json` 必须直接位于 `maibot-cards\` 下，不要再多套一层。
`bisca_server\`、`config.py`、`server_runtime.py`、`tunnel.py` 要一起复制。

也可以用 `tools/pack.ps1` 打出的 zip 解压到同一位置。

装好后到 WebUI → 插件管理里启用。**不用另起服务、不用改 toml**：

- 插件自带牌桌服务（`bisca_server/`，已把 express 等依赖打进一个文件）和
  node 运行时依赖（`nodejs-wheel-binaries`）。
- 启用后插件自动拉起内置服务，只监听 `127.0.0.1` 的随机空闲端口。
- 参数全部在插件详情页的「配置」里改，保存即生效。

## 两种运行方式

| 方式 | 怎么配 | 说明 |
| --- | --- | --- |
| 内置服务（默认） | `base_url` 留空 | 插件自己跑 `bisca_server/cards/server.cjs`，数据在插件数据目录的 `server/` 下 |
| 外部服务 | `base_url` + `internal_key` | 连自己部署的 Bisca（例如 compose 里的 `bisca:8081`），行为和旧版一致 |

内置服务首次启动会自己生成 `config.json`（含 `internal_key`）和登录密码，都落在数据目录里；
`internal_key` 填了也以内置服务生成的为准。

登录密码：内置服务默认自动生成（`server/password.txt`），所以直接打开大厅要密码，
但群里的邀请链接不需要。想自己定就在配置里填 `password`。

公网隧道：`public_url` 留空时，开桌会现起一条 cloudflared 快速隧道
（`https://xxx.trycloudflare.com`），闲置 30 分钟自动关。容器里没有 cloudflared 时
插件自动下载到 `/tmp/bisca-cloudflared`；下载不了就在配置里填 `cloudflared_path`，
或者改用固定域名（填 `public_url`）。

## 配置项

插件详情页里都有中文标签和提示，对应 `config.toml` 的 `[bisca]`：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 群聊开桌总开关 |
| `base_url` | 空 | 留空用内置服务；填了连外部服务（兼容带 `/cards/api` 的旧写法） |
| `public_url` | 空 | 群友手机能打开的固定地址；留空用临时隧道 |
| `internal_key` | 空 | 外部服务的 `internal_key`；内置服务留空自动管理 |
| `password` | 空 | 内置服务网页登录密码；留空自动生成落盘 |
| `server_port` | `0` | 内置服务端口，0 = 自动挑空闲端口 |
| `server_data_dir` | 空 | 内置服务数据目录，留空 = 插件数据目录下的 `server` |
| `node_path` | 空 | node 可执行文件，留空自动找 PATH / nodejs-wheel-binaries / venv |
| `tunnel_enabled` | `true` | `public_url` 留空时是否起隧道 |
| `tunnel_idle_minutes` | `30` | 隧道闲置多久关 |
| `cloudflared_path` | 空 | 指定 cloudflared；留空用 `bin/` 里的或自动下载 |
| `chat_enabled` | `true` | 是否让 MaiBot 在牌桌接话、把赛果写回群记忆 |
| `chat_port` | `8098` | 服务端回调插件的本机端口，不用对公网开放 |
| `request_timeout` | `10.0` | 调用牌桌服务超时（3~30 秒） |
| `strategy_prompts` | `{}` | 按 `ddz`/`zjh`/`uno` 覆盖策略提示词，留空用内置 |

装好后重启 MaiBot。日志出现 `maibot_cards loaded` 即加载成功；用内置服务时还会有
`bisca 内置服务已启动 http://127.0.0.1:<端口>`。

## 群聊用法

| 群里发 | 结果 |
| --- | --- |
| `uno` / `开始uno` / `来一局uno` | 开 4 人 UNO 桌（要坐满 4 人才能开局） |
| `炸金花` / `开一桌炸金花` | 开 4 人炸金花桌（要坐满 4 人才能开局） |
| `斗地主` / `打斗地主` | 开 3 人斗地主桌（3 人就能开） |
| `关桌` / `关闭房间` / `结束` | 关掉本群最近开的那桌 |
| `重开uno` / `重开炸金花` / `重开斗地主` | 先关旧桌，再开新房发链接 |

MaiBot 回复房号、人数和入座链接。群友点链接 → 自动昵称 → 入座；人满后服务端自动
开局，谁都不用点按钮；之后全部在网页里点按，不再需要群指令。群里发命令的人不会
预占座位，桌上只有 MaiBot 和真正点链接进来的人。

### 人数规则

群聊桌固定带 MaiBot 一个座位：

- **3 人（含 MaiBot）只开斗地主**；UNO / 炸金花要坐满 4 人（也就是再来 3 个群友）才会自动开局。
- 网页大厅自己建房不受这条限制，3 人 UNO 照样能开。

### AI 补位

- 第一个入座的真人（开局前）可以在手机页的「AI 补位」里加/移除
  AI·Opus / AI·Sonnet / AI·Haiku；MaiBot 固定座位不能动，其他人看不到这个区域。
- 补满会自动开局；不想跟 AI 打可以再移掉。第一个真人退出后，下一个真人自动接手这个面板。
- 服务端接口：`POST /cards/api/rooms/:code/ai`
  `{playerToken, agentId, action: "add" | "remove"}`，只允许第一个真人、开局前调用。
- AI 座位走服务端自动出牌；没配 CLI 时每步选第一个合法动作，牌力很弱，只适合补位。

### 退出与占位

- 入座后页面上有「离开这桌」：没开局直接腾座位；已开局则由服务端接管这个座位，
  按合法动作继续出牌，牌局不会因为缺人卡住。
- 刷新页面 / 重新点链接会用原座位 token 复座，不会多占一个座位。旧版刷新会重复
  入座，2 人斗地主直接被填满并提前开局，多出来的空位没人叫分，牌局就卡住。
- 直接关页面没点退出的：5 分钟没有连接也没有请求，座位会在下一次入座/开局时自动清掉。
- 群聊桌没有房主，桌上也不会出现「群友·房主」这种占位：开桌只落 MaiBot，真人点
  链接才入座。群里没人了会自动散桌。

## 机器人出牌

- 群聊桌默认把出牌交给插件的 `/bisca/move`（同一台 MaiBot、同一份策略字典），
  服务端 10 秒超时、插件 8 秒模型超时；插件用 `llm.generate` 从合法动作里选编号，返回 `{"move":"pN"}`。
- 想换成别的模型/端点：配 `MAIBOT_AGENT_URL`，服务端会把同一份简报 POST 过去。
- 插件没部署、模型超时/乱答：回落到服务端内置策略
  （`cards/engines/ddz-strategy.cjs`、`zjh-strategy.cjs`），牌局不卡。
- 内置策略只用自己能看到的信息（手牌、各家剩牌数/筹码、场上已出的牌），不偷看别人的手牌。
- 炸金花策略：用引擎 `evalHand` 的结构化牌力（不只中文标签）+ 底池赔率 + 位置 +
  对手跟/加/弃统计；强/中牌保守比牌（挑筹码少/闷牌对手），弱牌不比；闷牌小注才闷跟。
  比牌/诈唬在服务端统一后处理，MaiBot 和补充 AI 共用同一套。
  模型选跟/弃时，插件还有 35% 概率改成小加注，专门演“小牌装大牌”。
- 斗地主策略：不每手都出最小，需要抢回出牌权时用中等牌压；农民不压队友、残局提速。

## 对局策略提示词（动态注入）

- 插件按 `stream_id` 记当前游戏：开桌或第一次请求出牌时写入，关桌、整场结束
  （聊天桥的 `game_over`）时清除，最长保留 6 小时。
- Hook `maisaka.replyer.before_model_request`（已确认当前版本可用）只对命中的
  `session_id` 生效，把策略文本追加到 system message；其他群、局外一律不注入；
  同一请求用 `[bisca-strategy:<game>]` marker 去重。
- `/bisca/move` 和牌桌聊天都用同一个策略字典拼 prompt；普通群聊回复走 replyer Hook，也吃同一个字典。
- 全局 `personality` / `reply_style` 保持通用，不写具体游戏策略；对局结束自动恢复。
- 联网搜索只用于规则疑问或开局前查攻略，不写进对局策略，也不引导模型在对局中搜索；
  核心规则直接写在策略文本里。
- 覆盖策略（留空用内置默认，每个游戏一两句话）：

  ```toml
  [bisca.strategy_prompts]
  ddz = "你正在打斗地主……只输出合法动作。"
  zjh = "你正在打炸金花……只输出合法动作。"
  uno = "你正在打 UNO……只输出合法动作。"
  ```

## 群内赛后吐槽

开桌时插件把当前群的 `stream_id` 一并交给 Bisca。牌桌里 **MaiBot 不再聊天**，
人类聊天只留在牌桌；赛后另发一条群消息：

- 整场结束（`game_over`）或群里发 `关桌` 时，服务端把最近过程、赛果和牌桌聊天
  交给插件；插件用快模型生成 1-2 句吐槽，**发到 QQ 群**（不是牌桌），并写进
  该群的 Maisaka 记忆。
- 一局结束不刷屏，只在整场结束/关桌发；同一个房 `game_over` 和关桌只发一次。
- 关桌的吐槽在后台生成，不会拖住“牌桌已关”的回复。
- 聊天桥只绑在 docker 内网，用 `x-internal-key` 鉴权，不经过公网隧道。
- 普通群聊回复仍走 replyer；牌局进行中会由 Hook 注入策略，局外不注入。

因此 QQ 群里的 MaiBot 下次被 @ 时，能接上牌桌的过程和结果，但牌桌内保持安静。

## 反向代理

至少转发 `/cards`（静态页）和 `/cards/api`（接口）。SSE 需要关闭缓冲：

```nginx
location /cards/ {
    proxy_pass http://127.0.0.1:18081;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

Cloudflare 快速隧道实测会把 SSE 响应整段缓冲住（页面要重进才看到新状态）。
所以前端除了 SSE 还常开 3 秒轮询，隧道下聊天、出牌、座位变化最多 3 秒内出现；
反向代理能关缓冲的话 SSE 仍是先到先得的快通道。

## 与旧插件的关系

旧的 `local.bisca`（群内 `#牌` 指令出牌）与新插件 `github.GZTwT.maibot-cards` 功能重叠。
新插件上线后请把旧插件 `[plugin] enabled` 设为 `false`，避免同一句话回两条消息。

## 自检

```powershell
# 全量测试（含群聊开桌 16 条、斗地主策略 6 条、炸金花策略 7 条 + 整局模拟 1 条）
npm test --prefix E:\github\bisca\cards

# 内置服务自检：起服务、开一桌炸金花、校验 inviteUrl 后自动关掉
python maibot-plugin\tools\smoke_embed.py

# 直接验证开桌接口；internal_key 从 config.json 读
$key = (Get-Content E:\github\MaiBot\docker-config\bisca-data\config.json -Raw | ConvertFrom-Json).internal_key
Invoke-RestMethod -Method Post http://127.0.0.1:18081/cards/api/party `
  -Headers @{ "x-internal-key" = $key } `
  -ContentType "application/json" `
  -Body '{"game":"uno","host_name":"自检","public_url":"https://games.example.com"}'
```

返回里的 `inviteUrl` 应该以配置的 `public_url` 开头。

## 打包（本地分发）

插件包就是这个目录（`maibot-plugin/`）。没有上架市场，zip 只做本地备份/分发：

```powershell
# 改了 cards/ 之后必须重新生成内置服务（把 express 等依赖打进一个文件）
npm install --prefix E:\github\bisca
node maibot-plugin\tools\bundle-server.mjs

# 打成可直接解压使用的 zip（输出到 dist/）
powershell -File maibot-plugin\tools\pack.ps1
```

解压后确认根目录直接是 `plugin.py` / `_manifest.json`，且没有 `config.toml`
（本目录只有 `config.py`，没问题）；许可证要与 `_manifest.json` 的 `license` 一致。

## 已知限制

- 链接有效期 7 天；房间在服务端重启后从磁盘恢复，但进行中的牌局不保证续上。
- 临时隧道走 Cloudflare 快速隧道：国内网络偶尔连不上，连不上时插件只写 warning，
  链接会退回内网地址；这种情况配固定 `public_url`，或用手动脚本重试。
- 公开地址必须是群友手机可直达的；只在 `127.0.0.1` 监听时链接不可用。
- 机器人默认走内置斗地主策略；想让 MaiBot 用别的模型打，需自备
  `MAIBOT_AGENT_URL` 端点。
- 牌桌聊天要调一次大模型，通常 1~3 秒才回；2.5 秒冷却，失败就不说话。
  不想让它聊天就把插件的 `chat_enabled` 设为 `false`。

## 免责声明

1. **仅供娱乐**。本插件及配套牌桌服务只提供纯虚拟筹码的卡牌游戏，不含充值、提现、
   兑换、抽奖或任何真实货币结算功能，也不得用于赌博或变相赌博。使用者若自行改造出
   涉赌功能，后果自负，与作者无关。
2. **非官方项目**。本插件由个人围绕 MaiBot 开发（DeepSeek V4.1 Flash 1017 参与编写），
   与 MaiBot 官方及任何第三方游戏/商标持有者无隶属、赞助或背书关系。
3. **AI 行为不可控**。出牌、聊天、赛后吐槽均由大模型生成，可能答错规则、出非法牌、
   说错话或冒犯他人。请自行判断内容，不要把它当作规则依据或决策建议。
4. **公网暴露风险自负**。启用临时隧道或自建反代会把牌桌暴露到公网，请自行评估并承担
   访问控制、隐私、数据留存与当地法律法规（含所在群聊平台规则）方面的责任。
5. **无担保**。软件按“现状”提供，不保证可用性、连续性或数据不丢失；房间和牌局记录
   可能因重启、隧道断开、依赖升级而丢失或损坏。请勿在生产环境或重要场合依赖它。
6. **责任限制**。在法律允许的最大范围内，作者不对因使用或无法使用本插件导致的任何
   直接或间接损失（含数据丢失、账号受限、纠纷、时间损失）承担责任。
7. 使用即表示你已阅读并接受以上条款；不同意请停止使用并删除本插件。
