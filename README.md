# 校园信息层 · campus-layer

> 把郑州大学那堆"点进去、再点进去、再找一下"的学生服务，变成**一句话就能问**的东西。
>
> 形态有三个：**浏览器扩展**（侧边栏）、**手机 PWA**（加到主屏幕）、**安卓壳**（WebView + 课前提醒通知）。
> 没有服务器，没有账号体系，数据全在你自己设备上。

[![ci](https://github.com/rebeca-aa/zzu-campus-layer/actions/workflows/ci.yml/badge.svg)](https://github.com/rebeca-aa/zzu-campus-layer/actions/workflows/ci.yml)
[![pages](https://github.com/rebeca-aa/zzu-campus-layer/actions/workflows/pages.yml/badge.svg)](https://github.com/rebeca-aa/zzu-campus-layer/actions/workflows/pages.yml)

**在线演示**：<https://rebeca-aa.github.io/zzu-campus-layer/>
（只是壳，不含任何人的数据；第一次进去要粘一次你自己的登录态，见 [登录态从哪来](#登录态从哪来)）

---

## 它到底解决什么问题

学校的信息在**门户（豫见郑大）、教务、图书馆、事务中心、超星**等一堆站点里，同一个事实经常要在三个地方找：

| 你想知道 | 旧做法 | 这里 |
| --- | --- | --- |
| 明天几点上课、在哪栋楼 | 门户 → 服务 → 教务 → 课表 → 缩放到今天 | 「明天有课吗」 |
| 现在哪间教室能坐两小时 | 教务 → 空闲教室 → 选校区 → 选节次 → 一格格看 | 「现在哪能坐两小时」 |
| 那门课考了多少分 | 教务 → 成绩 → 找课程 | 「高数多少分」 |
| 有没有跟我有关的通知 | 门户、教务各刷一遍 | 「今天有什么讲座」 |
| 图书馆还有位置吗 | 另开一个站点，还要登录 | 「图书馆还有位置吗」 |

它是**只读优先**的：查数据、算空闲、渲染卡片。唯一会"写"的操作（预约图书馆座位）必须你**长按 1.2 秒**确认，而且是在你自己登录的那个标签页里点，扩展不碰你的密码。

---

## 三种用法

| 形态 | 适合 | 能力 | 怎么装 |
| --- | --- | --- | --- |
| **浏览器扩展**（MV3） | 电脑日常用 | 全部 14 个工具 + 通知卡片 + 每日盯梢 | 见 [60 秒上手](#60-秒上手扩展)（没装 Node 就下 [dist.zip](https://github.com/rebeca-aa/zzu-campus-layer/releases/download/dist-latest/campus-layer-dist.zip)） |
| **PWA** | 手机（安卓/iOS 都能加主屏幕） | 除"每日盯梢"外的全部；可带模型 key | 打开 [在线演示](https://rebeca-aa.github.io/zzu-campus-layer/) → 加主屏幕 |
| **安卓壳**（可选） | 想要原生图标 + **课前 30 分钟通知** | PWA 全部 + AlarmManager 提醒 | 从 Actions 下 `campus-layer-debug-apk` |

> 手机 Chrome 至今不支持扩展（Kiwi 已停更），所以手机走 PWA；安卓壳只是把同一个 PWA 包进 WebView，顺便拿到系统通知能力。
>
> 想把它部署到自己的域名/子路径？看 [docs/deploy-pwa.md](docs/deploy-pwa.md)。**仓库里没有 `dist/`**（构建产物不入库），要么本地 `npm run build`，要么直接下 [campus-layer-dist.zip](https://github.com/rebeca-aa/zzu-campus-layer/releases/download/dist-latest/campus-layer-dist.zip) 解压。

---

## 60 秒上手（扩展）

```powershell
npm install --ignore-scripts   # 沙箱里必须加 --ignore-scripts，见「开发」一节的坑
npm run build                  # 产物在 dist/（这个目录不进仓库，见下）
```

> **仓库里没有 `dist/`**——构建产物不入库（避免每次提交一堆带 hash 的 chunk）。
> 两种拿法：
> - 装了 Node：上面两条命令，自己构建出来；
> - **没装 Node**：直接下 [campus-layer-dist.zip](https://github.com/rebeca-aa/zzu-campus-layer/releases/download/dist-latest/campus-layer-dist.zip)（约 110 KB，**不需要登录 GitHub**），解压就是 `dist` 的内容。
>   （另一个来源：任意一次 [pages 运行](https://github.com/rebeca-aa/zzu-campus-layer/actions/workflows/pages.yml)页面底部的 Artifacts，但那个要登录。）

1. `edge://extensions`（或 `chrome://extensions`）→ 打开「开发人员模式」→「加载解压缩的扩展」→ 选构建出来的 `dist` 目录。
2. 浏览器里登录一次 `https://jwxt.zzu.edu.cn/uniapp/index.html`（教务）和/或 `https://uniapp.s.zzu.edu.cn`（门户）。
3. 点工具栏图标打开侧边栏，顶部两枚药丸变绿就能问了。

> 教务 token 有效期 30 天，门户 8 小时。过期了重新打开对应页面就自动续上。

---

## 能问什么

**课表 / 自习**

| 说法 | 做什么 |
| --- | --- |
| 「明天有课吗」「第 8 周课表」 | 按天/按周列课，带教室和教师；答案下面附一张校园地图（可选） |
| 「今天下午我有课吗」 | 按时段收窄，只列那个时段的课 |
| 「明天南核空教室」 | 全部教室 − 当天占用；**认地点词**：南核/北核/北1/物理馆/材料馆/图书馆 |
| 「明天上午哪间教室能坐两小时」 | 给每间教室的**连续空闲窗口**（`08:00–12:00`、`现在就能坐 2 小时 40 分`） |
| 「我想自习两小时」 | 教室 + 图书馆合成一个入口，按时长和步行距离排序；凑不够会分级说「这个只能坐 1 小时」 |

**通知**

| 说法 | 做什么 |
| --- | --- |
| 「今天有什么讲座」「这周有比赛吗」「挑战杯什么时候截止」 | 通知**卡片**：讲座/比赛/活动/会议/教务/生活六类（教务再细分选课/考试/成绩/学籍/毕业/论文/实习），每条带开讲时间、地点、报名截止；可筛分类/时间窗、按发布或截止排序 |
| 「查一下 XX 的通知」 | 教务通知（完整正文）+ 门户通知（摘要）；口语话题自动扩同义词（比赛 → 竞赛/大赛/挑战杯） |

**成绩 / 学分 / 一卡通 / 待办**

| 说法 | 做什么 |
| --- | --- |
| 「我这学期绩点多少」「高数多少分」 | 成绩/考试列表；可按课程名过滤，带出服务端给的构成分（平时/期中/期末/卷面——有什么给什么） |
| 「我还差多少学分毕业」 | 按模块列要求/已通过/在修/还差，带进度条 |
| 「我卡里还有多少钱」「最近消费」 | 一卡通余额 + 最近流水 |
| 「有什么要办的事」 | 待办/在办/待申请计数，紧急与超时单独标出 |

**图书馆**

| 说法 | 做什么 |
| --- | --- |
| 「图书馆还有位置吗」 | 各馆实时空闲/总数（免登录），带楼层明细和百分比 |
| 「一楼大厅哪些座位空着」 | 座位级空闲号 + 按坐标画一张平面图（绿点空、灰点占，每个空座标号） |
| 「帮我订 001」 | 生成**长按 1.2 秒**的确认按钮；确认后才在你自己的页面里点座位、点预约、点确认，并按页面反馈如实回报 |

**其它**

| 说法 | 做什么 |
| --- | --- |
| 「打开座位预约」「报修在哪」「食堂怎么订餐」 | 从 19 项门户服务里认出你要的，给官方入口（面板里是可点按钮） |
| 「把课表导出成日历」 | 生成带 `Asia/Shanghai` 的 `.ics` |

**不用问的（自动）**：每天后台跑最多 3 次，盯「新出成绩」和「7 天内截止的报名/申请类通知」，一条截止一条系统通知，点开直接定位到那张卡；同一条不重复推；首次运行不刷历史。

> **没有模型也能用。** 意图是规则（`src/core/intent.ts`），回答是模板（`src/core/render.ts`）。模型是可选增强，不是前置依赖。

---

## 模型（可选）

规则层先跑（免费、几十毫秒、离线可用）。模型怎么参与，取决于服务商**支不支持 function calling**：

| 模式 | 谁在用 | 模型干什么 |
| --- | --- | --- |
| **Agent 循环** | DeepSeek 官方 / 硅基流动 / 百炼 / Moonshot / OpenRouter | 自己决定调哪个工具、传什么参数 → 拿到真实 JSON 后自己组织回答；一轮不够可继续调（最多 4 步） |
| **判意图** | 学校 DeepSeek（Open WebUI 不暴露 tools） | 只输出 `{tool,args}`，正文由模板渲染 |

护栏写在提示词里：只许用工具返回的内容、不许编数字/课程名/通知标题、相对日期不许自己换算（由用户原话覆盖）、预约报名必须本人操作只能给入口。

界面上会显示这轮调了哪些工具（`模型编排 · find_free_room`），出问题一眼能看出是没调工具还是调错了。追问也能接住——面板和手机版都会带上最近 3 轮对话。

| 预设 | 接口 | 默认模型 | 前提 |
| --- | --- | --- | --- |
| 学校 DeepSeek | `http://chat.zzu.edu.cn/api` | `DeepSeek-R1` | 只在校园网/VPN；页面必须是 http（HTTPS 会被混合内容拦） |
| DeepSeek 官方 | `https://api.deepseek.com` | `deepseek-chat` | 自己的 key，HTTPS 可用 |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` | 同上 |
| 阿里百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 同上 |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | 同上 |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` | 同上 |

代价：非推理模型一次 0.5–2 秒（约 ¥0.001/次）；学校 R1 走老模式，11–25 秒。判断不了就回落成反问，并在气泡下面写清原因（401/402/403/404/429 各有说法）。

---

## 登录态从哪来

令牌是 CAS 在登录成功那一刻发下来的 `idToken`（JWT）。**不要**引导用户去打开 `cas.s.zzu.edu.cn` 根地址（没有 `service` 参数会 404），也**不要**在教务站里输学校账号密码——`jwxt.zzu.edu.cn/uniapp/` 自己那个登录页是**树维的账号体系**，不认统一身份认证。

| 场景 | 做法 | 有效期 |
| --- | --- | --- |
| **手机 PWA（推荐）** | 点应用里的「**打开学校登录页**」→ 统一身份认证登录 → 自动跳回「教学管理平台」→ 此时地址栏带 `idToken=eyJ…`，**长按复制整条网址** → 回来粘贴 | 30 天 |
| 手机（「豫见郑大」App） | 在 App 里「复制链接」，粘进来即可（链接里带 `idToken`）。**鸿蒙版实测可用；安卓版这个复制功能目前是坏的**（剪贴板不变），安卓请用上面那条 | 30 天 |
| 电脑扩展 | 登录门户或教务页面，content script 自动采集（药丸变绿） | 教务 30 天 / 门户 8 小时 |
| 电脑 → 手机 | 扩展 `⚙` →「生成手机同步码」→ 发到手机粘进去 | 同上 |

「打开学校登录页」指向的是带白名单 `service` 的 CAS 地址（教务 uni-app 在白名单内，实测能正常渲染登录表单）：

```
https://cas.s.zzu.edu.cn/cas/login?service=https%3A%2F%2Fjwxt.zzu.edu.cn%2Funiapp%2Findex.html
```

三种粘贴内容都认：**学校页面网址**（含 `idToken` / `userToken` / `token`）、**`eyJ…` 裸 token**、**电脑生成的同步码**。
如果粘的是 `?ticket=ST-…`，会提示你「这是门票不是令牌」——等页面跳到教学管理平台后，再复制地址栏。

## 隐私与安全

- **没有服务器。** 请求从你的浏览器直接发往学校域名（以及你自己选的模型服务商），中间没有本项目的中转。
- **令牌只在本地。** 存在 `chrome.storage.local`（扩展）或 `localStorage`（PWA/壳）。同步码是 **base64 编码，不是加密**——等同登录态，别发到群里。
- **模型 key 的权限**等于你在那家服务的使用权，不含密码、不含教务/门户权限。可以随时在服务商后台重置。
- **只读优先。** 唯一的写操作（图书馆预约）需要长按确认，且在你自己登录的页面里执行。
- **权限**：15 个域（8 个学校域 + `http://chat.zzu.edu.cn/*` + `http://order.lib.zzu.edu.cn/*` + 5 家模型服务商），不申请 `<all_urls>`。API 权限 `storage, alarms, sidePanel, scripting, notifications`——`scripting` 只用来读你自己那个图书馆标签页的 `sessionStorage.token`。

---

## 它是怎么做到的

不走"抓网页"：门户和教务都是 uni-app 的 SPA，DOM 没有稳定语义，`nth-child` 一改版就漂。这两套系统的 App 和网页**共用同一份代码**，只靠 `X-Terminal-Info` 区分渠道——所以只要拿到 `idToken`，能做的事和官方 App 完全一样，还比解析 DOM 稳。

```
CAS 登录 ──> idToken (JWT)
              │
   ┌──────────┴───────────┬───────────────┬──────────────┐
   ▼                      ▼               ▼              ▼
门户 portal-api      教务 eams-*     事务中心 ttc    图书馆 v4
课表/节次/CMS通知    课表/成绩/教室/  待办          馆级余量（免登录）
一卡通             培养方案/通知                   座位图（需页面登录）
   │                      │               │              │
   └──────────┬───────────┴───────────────┴──────────────┘
              ▼
      services.ts（缓存 + 降级）→ tools.ts（14 个工具）
              ▼
      intent.ts（规则，几十毫秒）→ 命中就出答案
              │ 没命中
              ▼
      llm.ts（可选）：agent 循环 or 判意图 → render.ts 模板渲染
```

更多细节：[平台架构](docs/campus-platform-architecture.md)、[接口实测](docs/campus-site-probe.md)、[服务盘点](docs/portal-services-inventory.md)、[通知卡片规则](docs/notice-hub.md)。

---

## 已知限制（诚实版）

**数据本身**

- **成绩**：接口通，但大一当前学期无数据（`data: []`）；构成分（平时/卷面）只能"有什么给什么"，各课字段还不一样，试卷级明细不在任何接口里。
- **一卡通**：只有余额 + 最近流水；**分类统计做不到**——真正账单在 `ecard.v.zzu.edu.cn`，要单独登录。
- **通知全文**：教务侧完整 HTML 可得；门户 CMS 的 `content` 被服务端硬截 200 字，官网原文需登录，不抓。
- **通知的时间/地点/截止是抽出来的**，不是接口给的：抽不到就不显示（宁缺不猜），截止提醒只对正文含明确日期的通知生效。
- **座位状态**：只认 `status_name`；纯数字编码按未知处理（猜错会把占座当空座）。实测 `1=空闲、6=使用中`。
- **座位图是自己按坐标画的**，不是官方那张：没有桌椅门窗，只有"绿点空/灰点占 + 空座标号"。

**能力边界**

- **模型**：只有支持 function calling 的服务商能进 agent 循环；学校那把只能判意图。HTTPS 页面调不了学校 AI（混合内容），会就地提示换服务商。
- **图书馆预约**：必须开着那个已登录的标签页；该站只有 http、仅校内网。我们不复制它的 AES 加密，而是让页面自己发请求。
- **未读消息**：`message-service` 的未读数接口回 500，暂不做。

**性能**

- 空教室：全校 379 间可上课教室，一次约 4 秒（小页 + 12 路并发），之后 60 秒缓存。
- 座位图：216 座约 20 KB 的 SVG（data URI），只在出图时生成。

---

## 开发

```powershell
npm run typecheck     # tsc --noEmit
npm test              # 离线单测（用 test/fixtures 的真实响应快照，已脱敏）
npm run build         # 扩展 + PWA 一起构建到 dist/
npm run verify        # typecheck + test + build
npm run e2e           # 真浏览器：起 Edge + 加载 dist/，用 CDP 跑面板与各工具
npm run pwa:shot      # 无头 Edge + 390×844 移动视口跑一遍 PWA，出 .pwa-*.png
npm run test:live     # 实网：读 tmp/zzu/*.txt 里的 token（见下）
npm run pwa:serve     # 本地起 http://127.0.0.1:8899 看 PWA
```

实网测试需要你自己的登录态，放在仓库根下 `tmp/zzu/`（已在 `.gitignore`）：

```
tmp/zzu/jwxt-token.txt   教务 X-Id-Token
tmp/zzu/token.txt        门户 userToken（可缺）
tmp/zzu/chat-key.txt     模型 sk- key（可缺）
```

**Windows 沙箱里的三个坑**（普通机器不遇到）：`npm install` 可能因缓存目录权限报 `EPERM`，需要 `$env:npm_config_cache = "<仓库>\.npm-cache"`；lifecycle 脚本可能 `spawn EPERM`，用 `--ignore-scripts`；`npx tsc` 会去 registry 下 `tsc` 包，所以稳妥写法是直接跑入口文件：`node node_modules/typescript/lib/tsc.js`、`node node_modules/vitest/vitest.mjs`、`node node_modules/vite/bin/vite.js`。

### 目录

```
src/core/            与环境无关的纯逻辑（node 可单测，扩展与 PWA 共用）
  http.ts            统一请求头、三种信封拆包、ApiError
  jwt.ts             JWT 解码、claims → 用户信息与过期
  portal.ts          门户 portal-api：事件、节次、教学周、CMS 通知、一卡通
  jwxt.ts            教务 eams-door / eams-micro-server：学期、课表、成绩、教室、培养方案
  library.ts         图书馆免登录余量 + 座位图宽容解析 + SVG 平面图
  libtab.ts          和图书馆页面里的 content script 通信
  services.ts        缓存 + 降级（教务优先，无教务时用门户反推）
  tools.ts           14 个工具（schema + run）
  toolspec.ts        给模型看的 tools JSON Schema（手写，描述即提示词）
  intent.ts          规则意图（L0）
  place.ts           地点词 → 教室名前缀（南核 = 南1/南2/南3）
  walk.ts            楼间步行时间表
  study.ts           自习决策器（时长 + 距离 + 可用窗口）
  watch.ts           每日盯梢：新成绩 / 临近截止
  remind.ts          课前提醒分块（连堂课并成一条）
  notice*.ts         通知卡片：分类词表、时间/地点抽取、去重、已读
  llm.ts             六家服务商 + 判意图 + function calling 循环
  agent.ts           ask() → 规则优先 → agent 循环 / 判意图
  render.ts          模板回答（无模型兜底）
  ics.ts             课表 → RFC 5545
  kv.ts / storage.ts 存储抽象（chrome.storage / localStorage）+ 同步码
src/ui/              面板与 PWA 共用组件（markdown、地图、模型设置、通知卡、长按确认）
src/background/      service worker：消息路由、side panel、alarms
sidepanel/           Preact 侧边栏
pwa/                 Preact 手机版（manifest 与 sw 在 public/pwa/）
public/              manifest.json + content scripts（原生 JS，不经构建）+ 图标 + PWA 清单
test/                vitest；fixtures 是脱敏后的真实响应
scripts/             e2e / pwa-shot / serve-pwa / capture / probe-*（接口逆向用）
mobile/android/      安卓壳（Gradle，零第三方依赖）
```

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/campus-platform-architecture.md](docs/campus-platform-architecture.md) | 为什么"网页和 App 是一套东西"、idToken 鉴权链、三层结构 |
| [docs/campus-site-probe.md](docs/campus-site-probe.md) | 接口实测清单与探针方法（逆向用） |
| [docs/portal-services-inventory.md](docs/portal-services-inventory.md) | 22 项门户服务的"能接 / 不能接"盘点 |
| [docs/notice-hub.md](docs/notice-hub.md) | 通知卡片规则：六类分类、时间地点抽取、今日口径 |
| [docs/campus-layer-v0.2.md](docs/campus-layer-v0.2.md) | 设计说明与验收记录（含每次实测数字） |
| [docs/deploy-pwa.md](docs/deploy-pwa.md) | 静态托管三种放法与自检 |

---

## 许可

[MIT](LICENSE)。代码随便用；但**不含**任何学校的版权素材（地图、校徽等都不在仓库里）。

非官方项目，与郑州大学及超星/树维等厂商无隶属关系。它查的是**你自己的账号、你自己的数据**。
接口随时可能变——坏了就按 [docs/campus-site-probe.md](docs/campus-site-probe.md) 的方法重新探。

## 贡献

欢迎 PR，三条要求：

1. 别提交任何 token、`sk-` key、学号姓名、未脱敏的原始响应。
2. 新增能力前先读 [docs/portal-services-inventory.md](docs/portal-services-inventory.md)——哪些服务现实中接不上、为什么。
3. 跑一遍 `npm run verify`；能动 UI 的话再跑 `npm run e2e` 与 `npm run pwa:shot`。
