# campus-layer

郑州大学「校园信息层」—— 一个 MV3 浏览器扩展。它不爬页面：从浏览器里取到学校 CAS 下发的 `idToken`，直接调门户与教务的 JSON API，把**课表 / 空教室 / 通知 / 成绩 / 考试**变成一句话就能问的东西，再支持导出 `.ics`。

规格来源见 `docs/campus-layer-handoff.md`，实测依据见 `docs/campus-site-probe.md` 与 `docs/campus-platform-architecture.md`。

## 它现在能做什么

| 你可以说 | 它做什么 | 数据来源 |
| --- | --- | --- |
| 「明天有课吗」「今天有课吗」「第 8 周课表」 | 按天/按周列课表，含教室与教师；**问答下方附一张郑大主校区地图**（点图放大，方便对着教室找楼） | 教务 `/lesson/student/course-table` + `public/map/campus.jpg` |
| 「明天下午哪里能自习」「明天南核空教室」「主校区 200 人以上的空教室」 | 全部教室 − 当天占用，算出空闲节次；**认地点词**（南核 / 北核 / 北1 / 物理馆 / 材料馆） | 教务 `/room/place/rooms` + `/room/place/room-occupancy` |
| 「今天下午我有课吗」「明天上午有课吗」 | 按时段收窄，只列那个时段的课（不再把整天倒出来） | 教务课表 + 本地时段表 |
| 「查一下 XX 的通知」「学校最近有比赛吗」 | 教务通知（完整正文）+ 门户通知（摘要）；**口语话题自动扩同义词**（比赛→竞赛/大赛/挑战杯…） | 教务 `/protal-notice/get-notices` + 门户 CMS |
| 「我这学期绩点多少」「高数多少分」「考试安排」 | 成绩 / 考试列表；**可按课程名过滤**，并带出服务端给的构成分（平时/期中/期末/卷面，字段因课而异） | 教务 `/grade/student/grades`、`/exam/student/exam` |
| 「图书馆还有位置吗」「明天图书馆有空位吗」 | 各馆**实时空闲/总数**（免登录），给百分比 + 楼层明细 + 选座入口 | 图书馆空间预约 `/v4/space/pcTopFor`（`order.lib.zzu.edu.cn`，仅校内网） |
| 「一楼大厅哪些座位空着」「帮我订 001」 | 打开过图书馆预约页（已登录）后，可读**座位级**空闲号；下单只在**长按确认**后才执行，且是在你自己那个标签页里点，扩展不碰密码 | 页面内 content script（`content/library.js`）+ `/v4/Space/seat` |
| 「我想自习两小时」「找个安静地方看会儿书」 | **教室 + 图书馆合成一个入口**：按时长、步行距离（`walk.ts` 楼间表）排序，凑不够时长会分级说「这个只能坐 1 小时」 | 教务教室占用 + 图书馆余量 + 本地步行表 |
| 「明天上午哪间教室能坐两小时」 | 每间教室给出**连续空闲窗口**：`08:00–12:00`、`现在就能坐 2 小时 40 分`，不再只说「1-4 节空」 | 教务 `/room/place/rooms` + 本地 `freeWindows` |
| （自动，不用问） | 每天后台跑一次：**新出成绩**、**7 天内截止**的报名/申请类通知，弹系统通知；首次运行不刷历史成绩 | 教务成绩/通知 + `chrome.notifications` + `chrome.alarms` |
| 「我还差多少学分毕业」「培养方案完成情况」 | 按模块列要求/已通过/在修/还差，并用进度条画出缺口 | 教务 `/plan/search/completion/info?code=01` |
| 「打开座位预约」「报修在哪」「食堂怎么订餐」 | 从 19 项门户服务里认出你要的，直接给官方入口（面板里是可点按钮） | 本地服务目录 `src/core/catalog.ts`（来自门户 `/v2/service/serviceShowAll`） |
| 「我卡里还有多少钱」「最近消费」 | 一卡通余额 + 最近消费/充值流水 | 门户 `/v2/personalData/getMyECard` |
| 「有什么要办的事」「待办事项」 | 待办/在办/待申请计数，紧急与超时单独标出 | 事务中心 `/ttc/v1/count/ttcCount` + `/ttc/api/ttc/center-list/getToDoList` |
| 「把课表导出成日历」 | 生成带 `Asia/Shanghai` 时区的 `.ics` | 本地生成 |

**没有 LLM 也能用**：意图解析是规则层（`src/core/intent.ts`），回答是模板渲染（`src/core/render.ts`）。模型是可选的增强，不是前置依赖。

## 模型怎么参与（两种模式，2026-10-22 起）

规则层仍然先跑（免费、几十毫秒、离线可用）。模型是不是「执行核心」取决于服务商**是否支持 function calling**：

| 模式 | 谁在用 | 模型干什么 |
| --- | --- | --- |
| **Agent 循环**（新） | DeepSeek 官方 / 硅基流动 / 百炼 / Moonshot / OpenRouter | 模型自己决定「调哪个工具、传什么参数」→ 拿到真实数据后**自己组织自然语言回答**；一轮不够可以继续调（最多 4 步）。工具规格在 `src/core/toolspec.ts`，10 个工具全覆盖 |
| **判意图**（老） | 学校 DeepSeek（只有 `DeepSeek-R1`，Open WebUI 不暴露 tools） | 只输出 `{tool,args}`，正文由模板渲染 |

Agent 模式下模型看到的是工具返回的**真实 JSON**，提示词里明确写死：只许用工具返回的内容、不许编数字/课程名/通知标题、相对日期不许自己换算（由 `applyTextHints` 按用户原话覆盖）、预约报名这类必须本人操作只能给入口且不许假装成功。所以「模型幻觉」变成「答得不好」，不会变成「编出假课表」。

界面上会显示这轮模型调了哪些工具（例如 `模型编排 · find_free_room`），出问题一眼能看出是它没调工具还是调错了。

**追问能接住**：面板与手机版都会把最近 3 轮对话带上去（`history`），「那明天呢」不用再重复整句。

代价：每条没被规则命中的话都要过一次模型。工具循环通常 1–3 秒（`deepseek-chat` 这类非推理模型），超时上限 45 秒；学校 R1 走老模式，11–25 秒。

服务商是预设的六选一（`src/core/llm.ts` 的 `LLM_PROVIDERS`），换服务商时模型名会自动填成该家的默认值：

| 预设 | 接口 | 默认模型 | 前提 |
| --- | --- | --- | --- |
| 学校 DeepSeek | `http://chat.zzu.edu.cn/api` | `DeepSeek-R1` | **只在校园网 / VPN**，且**页面必须是 http**（HTTPS 会被混合内容拦） |
| DeepSeek 官方 | `https://api.deepseek.com` | `deepseek-chat` | 自己的 key，HTTPS 页面可用 |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` | 同上 |
| 阿里百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 同上 |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | 同上 |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` | 同上 |

第三方这几家都实测过 CORS 预检放行（`allow-headers: authorization,content-type`），所以浏览器能直连，不需要中转。非推理模型一次 **0.5–2 秒**，比学校的 R1（11–18 秒）快一个数量级，费用约 ¥0.001/次。

### 用学校的 DeepSeek

学校给在校生开了 `http://chat.zzu.edu.cn`（自建 Open WebUI 0.5.18）。开法（三步，一次性）：

1. 浏览器打开 `http://chat.zzu.edu.cn`，用 CAS 登录（验证码收不到就用「客户端扫码」那个二维码，豫见郑大 App 扫）。
2. 右上角头像 → 设置 → 账号 → 「API 密钥」→ 显示 → 「+ 创建新安全密钥」，复制 `sk-…`。
3. 侧边栏点 `⚙` → 勾选开关 → 服务商选「学校 DeepSeek」→ 粘贴 key（失焦即存）。

**第 2、3 步可以省掉**：扩展里有 `content/chat.js`，只要你在同一个浏览器登录过 `chat.zzu.edu.cn`，它会把页面里的会话交给扩展，扩展拿会话去换一个 `sk-` key 自动填好（侧边栏「从已登录的 DeepSeek 页面自动获取」也是这个动作）。正常流程是：登录一次 WebUI → 打开侧边栏 → 勾一下开关。

### 用自己的 key

`⚙` → 服务商选一家 → 粘自己的 key。这条路在 **HTTPS 页面上也能用**，所以手机 PWA 装到主屏幕（必须 HTTPS）时，想要模型就选它。

### 关于安全的实话

- key 的权限**等同于你在那家服务的使用权**；学校那条等于你 WebUI 账号的用量，不含密码、不含教务/门户权限。
- 只存在 `chrome.storage.local`（手机版是 `localStorage`），扩展没有任何上报通道，请求只发给你选的那家。
- 学校那条走 `http://` 明文（该校 443 的 TLS 是坏的），且只在校园网/VPN 内可达；出了内网根本连不上。
- 同步码里会带 key（方便手机直接用），**别把同步码发到群里**。

### 注意事项

- 想让它「像 GPT 一样能自己查、自己答」，就选**支持 function calling 的服务商**（DeepSeek 官方那家最省事，`deepseek-chat` 一次 1–3 秒）。
- 学校那条（R1）**不支持 tools**，只能走老模式（判意图 + 模板），而且会先想再答，实测一次 **11–25 秒**；所以它只适合偶尔兜底。超时 45 秒后回落成反问。
- HTTPS 页面 + 学校预设 = 直接放弃（不白等），界面会就地提示换服务商。
- 不填 key 就完全离线，功能不受影响（规则层 + 模板）。

### 连不上时会怎样（2026-10-21 修）

以前模型失败是**静默**的：只回落成「我可以直接回答这几类问题…」，你分不清是 key 挂了、断网了，还是模型没听懂。现在：

- 答案气泡底部会直接写原因，例如「模型没帮上忙：DeepSeek 官方的 API Key 无效或已过期（Authentication Fails, Your api key: ****test is invalid）」。401/402/403/404/429 各有各的说法。
- `⚙` 里多了「**测试连接**」按钮：直接打一次最短请求，通就显示 `连通 ✓ 320ms（deepseek-chat 回：ok）`，不通就显示原文错误。
- 学校那条 key 失效时（`Your session has expired`），只要你还在浏览器里登录着 `chat.zzu.edu.cn`，扩展会**自动换一次 key 并重试**，不用手动点同步。
- 找不到原因时跑 `node scripts/diag-llm.mjs`：它在真实扩展环境里分别从「面板页」和「Service Worker」各打一次模型接口，把 status/耗时/错误原文全打出来。


## 快速开始

```powershell
cd campus-layer
npm install --ignore-scripts   # 沙箱里必须加，原因见「npm 的三个坑」
npm run build                  # 产物在 dist/
```

运行环境：Node 24 / npm 11；构建链 vite 8.3.4、vitest 5.0.5、TypeScript 5.6（`npm audit` 干净）。

然后在 Edge / Chrome 打开 `edge://extensions`（或 `chrome://extensions`），开启「开发人员模式」→「加载解压缩的扩展」→ 选 `dist`。

首次使用：

1. 在浏览器登录 `https://uniapp.s.zzu.edu.cn`（门户）和/或 `https://jwxt.zzu.edu.cn/uniapp/index.html`（教务）。
2. 打开一次这两个页面，content script 会自动把 token 交给扩展（面板顶部两枚药丸变绿）。
3. 点工具栏图标 → 侧边栏打开，直接问。

> 教务 token 的 TTL 是 30 天，门户是 8 小时。过期后重新打开对应页面即可续上。

## 手机上用（PWA）

手机上的 Chrome 装不了扩展（Android 至今不支持；Kiwi 已停更），所以同一套 `src/core/` 又打了一个网页版：`dist/pwa/`。加到主屏幕后它就是个 App，走的还是同样的接口。

### 一句话原理

PWA 就是一个**静态网页**，只不过带了 `manifest` 和 service worker。浏览器允许「加到主屏幕」（变成独立图标、全屏、没地址栏），**前提是这个网页跑在 HTTPS 上**。所以要把它放到一个免费静态托管上——不需要服务器、不需要数据库、不需要域名，上传完就有地址。

### 三步上手（不需要懂前端）

```powershell
npm install --ignore-scripts
npm run build
```

跑完会有一个 `dist/` 目录，里面就是要上传的东西。

**第 1 步：把这个目录变成网址。** 三选一，都不用信用卡：

| 方式 | 适合谁 | 操作 | 最后拿到的地址 |
| --- | --- | --- | --- |
| **GitHub Pages**（推荐，仓库已经配好） | 有这个仓库的人 | 仓库 Settings → Pages → Source 选 **GitHub Actions** → 回到 Actions 页等 `pages` 跑完 | `https://<你的用户名>.github.io/zzu-campus-layer/` |
| **Cloudflare Pages** | 想拖拽上传 | 打开 pages.cloudflare.com → Create → Upload assets → 把 `dist/` **里面的东西**拖进去（不是 `dist` 这个文件夹本身） | `https://<项目名>.pages.dev/` |
| **Netlify Drop** | 最省事，不用注册也行一时 | 打开 app.netlify.com/drop → 把 `dist/` 拖进去 | `https://<随机名>.netlify.app/` |

> 上传时**上传 `dist/` 里的内容**，不要多包一层目录。构建产物全是相对路径，所以放在域名根或子路径都能跑，不用改配置。

**第 2 步：在手机上装成 App。**
用手机浏览器打开上面拿到的地址 → 安卓 Chrome 右上角 `⋮` →「**添加到主屏幕**」/「安装应用」；iOS Safari 是底部分享 →「添加到主屏幕」。
装完之后点图标是独立窗口，跟原生 App 差不多。

**第 3 步：把登录态搬过去。**
手机上没有你的 CAS 登录，所以第一次要「同步」一次：

1. 电脑上：扩展面板 → `⚙` →「**生成手机同步码**」→ 复制那串 `eyJ…`；
2. 用微信/QQ 发给自己（或者任何能跨设备复制的方式）；
3. 手机上：点右上角「**登录态**」→ 粘进去 → 保存 → 药丸变成「教务 · 30 天」就好了。

之后就能问「明天有课吗」「明天南核空教室」「我还差多少学分」这些了。

### 本地先看一眼（不部署）

```powershell
npm run build
npm run pwa:serve      # 打开 http://127.0.0.1:8899/pwa/index.html
npm run pwa:shot       # 或者：无头 Edge + 390×844 移动视口自动跑一遍，出 .pwa-*.png
```

`pwa:serve` 只是看效果用的：`localhost` 也算安全上下文，所以能装；换成局域网 IP（`http://192.168.x.x:8899`）就装不了，只能当普通网页查数据。

### 常见卡点

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| 「添加到主屏幕」不出现 / 装完没有图标 | 不是 HTTPS，或者 manifest 没被取到 | 确认地址是 `https://`；`https://…/pwa/pwa.webmanifest` 能直接打开 |
| 打开是白的 | `dist` 上传时多套了一层目录 | 上传 `dist/` **里面的**文件，站根应该能直接看到 `index.html` |
| 改了配置手机上还是旧的 | service worker 有缓存 | 手机上关掉页面重开；还不行就在浏览器设置里清这个站点的站点数据 |
| 查询报「没有访问权限01」 | 同步码过期（教务 30 天、门户 8 小时） | 回电脑重新生成一次同步码 |
| 手机上选学校 AI 一直失败 | HTTPS 页面调 `http://chat.zzu.edu.cn` 属于混合内容，被浏览器拦 | 换第三方预设（DeepSeek 官方 / 硅基流动 / 百炼 / Moonshot / OpenRouter）+ 自己的 key |
| 想发给同学用 | 这个网页不含任何账号 | 直接发地址就行，**别把同步码发给别人**（那等于发登录态） |

几条实话：

- **必须 HTTPS（或 localhost）**：service worker 与「添加到主屏幕」都要求安全上下文。局域网 `http://192.168.x.x:8899` 能打开页面、也能查数据（接口 CORS 都放行），但**装不了**，只能当普通网页用。
- 构建产物**都是相对路径**（`../assets/…`、`./pwa.webmanifest`、`start_url: './index.html'`），所以放域名根或子路径都能用（GitHub Pages 项目页不需要改配置）。
- **HTTPS 页面调不了学校的 AI**：`chat.zzu.edu.cn` 只有 http（443 上不是 TLS），HTTPS 页面去 fetch 它会被浏览器按**混合内容**拦掉（实测报 `Mixed Content: … This request has been blocked`）。所以要模型就换第三方预设；数据类功能两边都正常。
- 同步码是 **base64 编码，不是加密**：里面就是 `X-Id-Token`（还可能带你的模型 key），等同登录态。别贴到公开的地方；导入后可以在扩展里「清除 token」或等它自然过期（教务 30 天）。
- 手机版**也能用模型兜底**：同步码里会带上桌面端填好的 key，导入即生效；也可以在现场手动填（登录态面板底部）。
## 目录

```
src/core/        与运行环境无关的纯逻辑（可 node 下单测，扩展与 PWA 共用）
  types.ts       zod 模型：Course / Notice / Term / Room / FreeRoom / Grade / Exam / Card / Todo
  kv.ts          存储抽象（扩展用 chrome.storage.local，网页用 localStorage）+ 同步码编码
  http.ts        统一请求头、三种信封拆包、ApiError
  jwt.ts         atob 解码 JWT、claims → 用户信息与过期时间
  portal.ts      门户 portal-api：事件、节次表、教学周、CMS 通知、一卡通、待办
  jwxt.ts        教务 eams-door / eams-micro-server：学期、课表、成绩、考试、教室、占用、通知、培养方案
  library.ts     图书馆空间预约的免登录余量接口（`order.lib.zzu.edu.cn`，只有 http）+ 座位图宽容解析
libtab.ts      和图书馆页面里的 content script 说话（找标签页、发消息、把错误翻成人话）
  services.ts    CampusService：缓存 + 降级（教务优先，无教务时用门户反推）
  ics.ts         课表 → RFC 5545
  render.ts      模板回答（无模型兜底）
  intent.ts      L0 规则意图解析
  catalog.ts     门户服务目录（19 项）+ 关键词匹配，供「一句话直达」用
  llm.ts         L1 兜底：6 家服务商预设（学校 Open WebUI / DeepSeek / 硅基流动 / 百炼 / Moonshot / OpenRouter）+ 意图判定 + 参数收敛 + `llmChatWithTools`（function calling）
  toolspec.ts    给模型看的工具规格（OpenAI tools JSON Schema，手写，描述即提示词）
  tools.ts       10 个工具定义（schema + run）
  storage.ts     token / LLM 设置 / 状态（经 kv.ts，两种运行环境通用）
  agent.ts       ask(text) → 规则优先；能调工具时进 runAgent 循环（最多 4 步，带 history），否则走老的判意图路径
src/ui/rich.tsx  面板与 PWA 共用的渲染件（轻量 markdown、校园地图、下载）
src/ui/llm-fields.tsx  面板与 PWA 共用的模型设置控件（服务商 / key / 模型名）
src/background/  service worker：消息路由、sidePanel、alarms
sidepanel/       Preact 侧边栏
pwa/             Preact 手机网页版（入口 index.html；manifest 与 service worker 在 public/pwa/）
public/          manifest.json + content scripts（原生 JS，不经构建）
  map/campus.jpg 郑大主校区手绘地图（1280×2044），课表回答里附在答案下面
  icons/         PWA 图标（192 / 512）
  pwa/pwa.webmanifest, pwa/pwa-sw.js  PWA 的清单与壳缓存（相对路径，支持子路径部署）
test/            vitest：离线用 fixtures，实网用 test:live
scripts/         capture.mjs（抓真实响应脱敏成 fixture）、e2e.mjs（真浏览器验证扩展）、
                 pwa-shot.mjs（无头 Edge 手机视口验证 PWA）、serve-pwa.mjs（本地静态服务）、
                 explore*.mjs / probe-*.mjs / grep-chunks.mjs（接口逆向用的小工具）
```

## 测试

```powershell
npm run verify           # 等价于 typecheck + test + build（直接跑 node 入口，见下）
npm run typecheck
npm test                 # 离线：用 test/fixtures 里的真实响应快照
npm run test:live        # 实网：读 ../tmp/zzu/*.txt 里的 token，需要登录态
npm run build
npm run e2e              # 真浏览器：起 Edge + 加载 dist/，用 CDP 跑一遍面板与 10 个工具
npm run pwa:shot         # 真浏览器：无头 Edge + 移动视口跑 PWA（导入同步码 → 问课表 → 问空教室）
```

> 装依赖的两个坑（本机实测）：`npm install` 会因沙箱挡 `%LOCALAPPDATA%\npm-cache` 报 `EPERM`，
> 需要 `$env:npm_config_cache = "<工作区>\.npm-cache"`；lifecycle 脚本会 `spawn EPERM`，
> 用 `npm install --ignore-scripts`。`npx tsc` 会去 registry 下 `tsc` 包，所以一律跑入口文件：
> `node node_modules/typescript/lib/tsc.js`、`node node_modules/vitest/vitest.mjs`、`node node_modules/vite/bin/vite.js`。

`test/fixtures/` 是从真实接口抓下来、脱敏后的快照（姓名/学号替换），所以归一化逻辑有真实形状兜底，不靠手搓样例。

## 实测接口（全部已跑通）

| 域 | 基址 | 用途 |
| --- | --- | --- |
| 门户 | `https://info.s.zzu.edu.cn/portal-api` | 课表事件、节次表、教学周、CMS 通知、一卡通 |
| 事务中心 | `https://transaction.s.zzu.edu.cn/ttc` | 待办计数与待办列表 |
| 教务门面 | `https://jwxt.zzu.edu.cn/eams-door/api/v1` | 用户信息、今日日程、通知（完整正文）、服务列表 |
| 教务业务 | `https://jwxt.zzu.edu.cn/eams-micro-server/api/v1` | 学期、课表、成绩、考试、教室、占用、培养方案 |
| 图书馆空间预约 | `http://order.lib.zzu.edu.cn/v4` | 各馆实时座位余量（免登录；座位图/下单需学号密码） |

服务目录与「哪些服务能接、哪些接不了」的完整盘点见 [`docs/portal-services-inventory.md`](docs/portal-services-inventory.md)。

统一鉴权头：`X-Id-Token: <JWT>` + `X-Terminal-Info: h5` + `X-Device-Info: PCWin32NT`。服务端把「未登录」也回 HTTP 200，业务码写在 body 里（`code:-1 没有访问权限01`），所以 `http.ts` 拆包时会抛 `ApiError`。

空教室怎么算（踩过坑，记一下）：

- 教室列表 `POST /room/place/rooms` 带上 `date` 参数时，**每间教室自己带 `roomOccupationInfoVms`**，里面既有 `activityType: "Lesson"`（排课）也有 `RoomBorrow`（借用）——这才是真实占用。
- `POST /room/place/room-occupancy` 只返回借用，一天只有个位数（实测 8 条），拿它求差会得出「全天空闲」，是错的。
- **地点词走教室名前缀**，不走服务端的 `buildingIds`（那套 id 不透明、跨学期会变）：教室名长这样 `南1_303` / `北3_403` / `物_505` / `北区2_101`，所以「南核」= 前缀 `南1/南2/南3`、「北核」= `北1–北5`、「物理馆」= `物`。见 `src/core/place.ts`。
  - 谁踩过：早先「明天南核空教室」被当成「不限楼」，回了一屏北1/北2，`共 590 间`。现在会回 `共 48 间`，标题写清「南核心教学区（南1–南3）」。
- `campusAssoc` 必须传数字：传字符串 `"2"` 服务端不报错、静默返回 0 条。
- `roomTypeIds` 默认只查普通教室(1)+多媒体教室(2)：不过滤是 1039 间（多为实验室/办公用房），过滤后 379 间，正好是 `物_505`、`北3_312` 这类真实上课教室。
- `minSeat` 服务端**忽略**，`seatsForLesson` 也常为 0，所以座位筛选实际只能在客户端做，且多数教室没有座位数据。
- 耗时随 `pageSize` 线性增长（30→154ms、500→20s），所以用「小页 + 12 路并发」翻页：全校一次约 4s，之后走 60s 缓存。

## 已知限制（诚实版）

- **成绩 / 考试**：接口通，但大一当前学期无数据（`data: []`），不是实现问题。
- **通知全文**：教务侧完整 HTML 可得；门户 CMS 的 `content` 被服务端硬截 200 字，官网原文需要登录才能抓，不抓。
- **空教室**：见上，全校 379 间可上课教室，一次约 4s（并发翻页），之后 60s 缓存；教室座位数基本为空。
- **模型是可选增强，但「工具循环」有条件**：只有支持 function calling 的服务商才会进 agent 循环（DeepSeek 官方 / 硅基流动 / 百炼 / Moonshot / OpenRouter）；学校那把只有 R1、Open WebUI 不暴露 tools，只能走老的「判意图 + 模板」路径。不填 key 就完全离线。
- **规则层仍然先跑**：像「明天南核空教室」「今天下午有课吗」「学校最近有比赛吗」这类高频说法，规则层直接命中（几十毫秒），根本不会花模型的钱。
- **成绩明细（平时分/卷面分）只能「有什么给什么」**：教务的 `/grade/student/grades` 是本号唯一能拿到的成绩接口，返回里带哪些构成分字段由学校决定，不同课还不一样——扩展会按语义（`平时/期中/期末/卷面/usual/midterm/final`…）把它们捞出来展示，但**不能保证每门课都有**。更细的试卷级明细（每道题得分）不在任何接口里。
- **一卡通的「消费分类统计」做不到**：门户 `getMyECard` 只给余额和最近流水，`getECardDataList` 返回的是一堆深链配置（里面还夹着 `ecard-app.jci.edu.cn` 这种外校残留），**真正的账单明细在 `ecard.v.zzu.edu.cn`，要单独登录**。本号余额 `¥0`、无流水，所以这条只做了「余额 + 有什么流水列什么」，没做分类聚合。
- **图书馆座位：读得到座位级，下单靠"在你的页面里点"**。座位列表来自 `/v4/Space/seat`，需要那个标签页已登录（`sessionStorage.token`），所以扩展会复用你自己打开的 `order.lib.zzu.edu.cn` 页面；下单接口 `/v4/space/confirm` 的请求体是页面自己用 AES 加密的（key 由时间派生，iv 固定 `ZZWBKJ_ZHIHUAWEI`），我们**不复制这套加密**，而是让页面自己发：长按确认后，content script 在页面上点座位 → 点「立即预约」→ 点确认弹窗，最后按页面有没有出现成功提示如实回报。代价：必须开着那个标签页；该服务只有 **http**、仅校内网可达。
- **数字编码的座位状态不敢猜**：如果服务端只给 `state: 1/0` 这类数字，扩展不会替你判定"空/占"（猜错会把占着的座位当成空的），会明说"看页面上的绿色座位"。目前实测的映射是 `1=空闲、6=使用中`（写进 `STATUS_NUM`），其它数字仍按未知处理。
- **座位「图」看不到**：我们只有座位号列表（`/v4/Space/seat` 返回 `no/status/point_x/point_y`），**没有把坐标渲染成平面图**。所以问「能看图吗」会如实回答看不了，只能说哪些号空着、某个号能不能订。想要图得自己在预约页看。
- **出分监控暂时没数据**：`/grade/student/grades` 本号返回 `[]`（大一当前学期还没出分），所以后台盯梢里"新成绩"这一路目前是空转，等学校出分才会真的弹通知。
- **截止提醒只对"正文里写了日期"的通知生效**：教务通知接口的 `content` 被服务端压成了标题（`<p>标题</p>`），里面没有日期；只有当通知正文自己带 `2026-11-20` / `11 月 5 日` 这类日期时，才能算出"还剩几天"。
- **权限**：只申请 15 个域（8 个学校域 + `http://chat.zzu.edu.cn/*` + `http://order.lib.zzu.edu.cn/*` + 5 家模型服务商），不申请 `<all_urls>`；没有自定义 `baseUrl`，所以不需要 `optional_host_permissions` 去弹授权。API 权限是 `storage, alarms, sidePanel, scripting, notifications`——`scripting` 只用来读你自己那个图书馆标签页的 `sessionStorage.token`，`notifications` 只用来弹每日盯梢。
- **一卡通 / 待办**：接口通，本号余额 `¥0`、待办全 0（确实没消费、没待办）；`message-service` 的未读数接口回 500，未读消息暂不做。
- **token 存储**：只在 `chrome.storage.local`，不出本机。`X-Id-Token` 等同于登录态，别导出这个扩展的存储。

## 为什么不是「抓网页」

门户和教务都是 uni-app 的 SPA，DOM 里没有稳定语义，且 `nth-child` 类选择器在构建间会漂。这两套系统的 App 与网页共用同一份代码，只靠 `X-Terminal-Info` 区分渠道——也就是说，只要拿到 `idToken`，能做的事和 App 完全一样，还比解析 DOM 稳。详见 `docs/campus-platform-architecture.md`。
