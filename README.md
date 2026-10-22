# 校园信息层（campus-layer）

郑州大学「校园信息层」—— 一个 MV3 浏览器扩展 + 一个手机 PWA。它不爬页面：从浏览器里取到学校 CAS 下发的 `idToken`，直接调门户与教务的 JSON API，把**课表 / 空教室 / 通知 / 成绩 / 考试 / 学分 / 一卡通 / 待办**变成一句话就能问的东西，再支持导出 `.ics`。

> 只对**你自己的账号**生效：token 由你本机浏览器登录后采集，只存在本地；没有任何服务端，也不上传数据。
> 非官方项目，与郑州大学无隶属关系；接口随时可能变，坏了就按 `docs/campus-site-probe.md` 的探针方法重新挖。

实测依据见 [`docs/campus-site-probe.md`](docs/campus-site-probe.md) 与 [`docs/campus-platform-architecture.md`](docs/campus-platform-architecture.md)，设计说明见 [`docs/campus-layer-v0.2.md`](docs/campus-layer-v0.2.md)。

## 它现在能做什么

| 你可以说 | 它做什么 | 数据来源 |
| --- | --- | --- |
| 「明天有课吗」「今天有课吗」「第 8 周课表」 | 按天/按周列课表，含教室与教师；**可选附一张校园地图**（自己放图，见下） | 教务 `/lesson/student/course-table` + 可选 `public/map/campus.jpg` |
| 「明天南核空教室」「北1 下午哪间空着」 | 按教学区/楼过滤：全部教室 − 当天占用，算出空闲节次 | 教务 `/room/place/rooms` + `/room/place/room-occupancy` |
| 「查一下 XX 的通知」 | 教务通知（完整正文）+ 门户通知（摘要） | 教务 `/protal-notice/get-notices` + 门户 CMS |
| 「我这学期绩点多少」「考试安排」 | 成绩 / 考试列表 | 教务 `/grade/student/grades`、`/exam/student/exam` |
| 「我还差多少学分毕业」「培养方案完成情况」 | 按模块列要求/已通过/在修/还差，并用进度条画出缺口 | 教务 `/plan/search/completion/info?code=01` |
| 「打开座位预约」「报修在哪」「食堂怎么订餐」 | 从 19 项门户服务里认出你要的，直接给官方入口（面板里是可点按钮） | 本地服务目录 `src/core/catalog.ts`（来自门户 `/v2/service/serviceShowAll`） |
| 「我卡里还有多少钱」「最近消费」 | 一卡通余额 + 最近消费/充值流水 | 门户 `/v2/personalData/getMyECard` |
| 「有什么要办的事」「待办事项」 | 待办/在办/待申请计数，紧急与超时单独标出 | 事务中心 `/ttc/v1/count/ttcCount` + `/ttc/api/ttc/center-list/getToDoList` |
| 「把课表导出成日历」 | 生成带 `Asia/Shanghai` 时区的 `.ics` | 本地生成 |

**没有 LLM 也能用**：意图解析是规则层（`src/core/intent.ts`），回答是模板渲染（`src/core/render.ts`）。模型只是可选的增强，不是前置依赖。

## 模型兜底（可选，两种来源）

意图解析默认是规则层（`src/core/intent.ts`），回答是模板渲染（`src/core/render.ts`）。模型只做**两件事**：

1. 规则没命中时判断该调哪个工具——输出 `{tool, args}`，正文仍由模板渲染，所以它判错最多是查错东西，不会编数据；
2. 这句话压根不用查数据（打招呼、问你是谁、问怎么用、一般常识）——直接用中文正常回答，不再甩一屏功能清单。这类回答在界面上挂「由模型回答」的标记，`via: 'llm-chat'`。

第 2 条是后加的：早先问「hello」只会回一张能力清单，很像坏掉的机器人。代价是每条没被规则命中的话都要过一次模型（R1 11–25 秒，`deepseek-chat` 约 1 秒）。

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

- 学校那条：R1 会先想再答，实测一次意图判定 **11–18 秒**（free-chat 也在这个量级），所以它只是兜底，不是主路径；超时（30s）或失败都回落成反问。
- HTTPS 页面 + 学校预设 = 直接放弃（不白等 30 秒），界面会就地提示换服务商。
- 不填 key 就完全离线，功能不受影响。

### 连不上时会怎样

早先版本最坑的地方是「静默」：key 过期、断网、模型抽风，界面统一表现成「甩一屏能力清单」，用户根本分不清是坏了还是不认。现在改成显式：

- 气泡下方直接给原因：`模型没帮上忙：<服务商> 的 API Key 无效或已过期（…）`，401/402/403/404/429 各有对应说法；
- `⚙` 里新增「**测试连接**」：打一次 `ping`，回 `连通 ✓ 320ms（model 回：ok）` 或 `失败 ✗ <原因>`；
- 学校那条如果返回鉴权失败，且本地存着 `chat.zzu.edu.cn` 的会话，**会自动换一把新 key 再试一次**；
- 想从命令行看两个上下文（面板页 / Service Worker）各自的连通性：

```powershell
node scripts/diag-llm.mjs
```

它会起一个临时 profile 的 Edge、加载 `dist/`、分别在扩展页面和 SW 里各打一次 `POST /chat/completions`，打印状态码、耗时、原始错误，最后把「界面上看不看得见原因」也断言一遍（截图存 `.diag-llm.png`）。


## 快速开始

```powershell
cd campus-layer
npm install --ignore-scripts   # 沙箱里必须加，原因见「npm 的三个坑」
npm run build                  # 产物在 dist/
```

运行环境：Node 24 / npm 11；构建链 vite 8.3.4、vitest 5.0.5、TypeScript 5.6（`npm audit` 干净）。

然后在 Edge / Chrome 打开 `edge://extensions`（或 `chrome://extensions`），开启「开发人员模式」→「加载解压缩的扩展」→ 选这份仓库里的 `dist`。

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
  services.ts    CampusService：缓存 + 降级（教务优先，无教务时用门户反推）
  ics.ts         课表 → RFC 5545
  render.ts      模板回答（无模型兜底）
  intent.ts      L0 规则意图解析
  catalog.ts     门户服务目录（19 项）+ 关键词匹配，供「一句话直达」用
  place.ts       地点口语词 → 教室名前缀（南核→南1–南3、物理馆→物…）
  llm.ts         L1 兜底：6 家服务商预设（学校 Open WebUI / DeepSeek / 硅基流动 / 百炼 / Moonshot / OpenRouter）+ 意图判定 / 自由回答 + 参数收敛 + 连通性探测
  tools.ts       10 个工具定义（schema + run）
  storage.ts     token / LLM 设置 / 状态（经 kv.ts，两种运行环境通用）
  agent.ts       ask(text) → 一句话 → 工具调用 → 回答
src/ui/rich.tsx  面板与 PWA 共用的渲染件（轻量 markdown、校园地图、下载）
src/ui/llm-fields.tsx  面板与 PWA 共用的模型设置控件（服务商 / key / 模型名）
src/background/  service worker：消息路由、sidePanel、alarms
sidepanel/       Preact 侧边栏
pwa/             Preact 手机网页版（入口 index.html；manifest 与 service worker 在 public/pwa/）
public/          manifest.json + content scripts（原生 JS，不经构建）
  map/           放你自己学校的地图（`campus.jpg`，仓库不带；缺失时答案里就不附图）
  icons/         PWA 图标（192 / 512）
  pwa/pwa.webmanifest, pwa/pwa-sw.js  PWA 的清单与壳缓存（相对路径，支持子路径部署）
test/            vitest：离线用 fixtures，实网用 test:live
scripts/         capture.mjs（抓真实响应脱敏成 fixture）、e2e.mjs（真浏览器验证扩展）、
                 pwa-shot.mjs（无头 Edge 手机视口验证 PWA）、serve-pwa.mjs（本地静态服务）、
                 diag-llm.mjs（两个上下文各打一次模型接口，诊断连通性）、
                 explore*.mjs / probe-*.mjs / grep-chunks.mjs（接口逆向用的小工具）
```

## 实网测试怎么跑

离线测试（`npm test`）不需要任何凭据；实网测试、e2e、PWA 截图需要你自己的登录态，放在**仓库根下** `tmp/zzu/`（已在 `.gitignore` 里）：

```
tmp/zzu/jwxt-token.txt   教务的 X-Id-Token（30 天）
tmp/zzu/token.txt        门户的 userToken（8 小时，可缺）
tmp/zzu/chat-key.txt     模型 key `sk-...`（可缺，缺了跳过 L1 用例）
```

获取方式：在浏览器登录 `https://jwxt.zzu.edu.cn` 与 `https://uniapp.s.zzu.edu.cn`，装上本扩展，面板顶部药丸变绿后，从 `chrome.storage.local` 的 `tokens` 里抄，或者用 `scripts/` 里的探针脚本抓。**这三个文件等同你的登录态，永远不要提交。** 想换目录就用环境变量 `ZZU_TOKEN_DIR`。

## 测试

```powershell
npm run verify           # 等价于 typecheck + test + build
npm run typecheck
npm test                 # 离线：用 test/fixtures 里的真实响应快照
npm run test:live        # 实网：读 tmp/zzu/*.txt 里的 token（见上），需要登录态
npm run build
npm run e2e              # 真浏览器：起 Edge + 加载 dist/，用 CDP 跑一遍面板与 10 个工具
npm run pwa:shot         # 真浏览器：无头 Edge + 移动视口跑 PWA（导入同步码 → 问课表 → 问空教室）
```

> Windows 沙箱里的两个坑（不影响普通机器）：`npm install` 可能因缓存目录权限报 `EPERM`，
> 需要 `$env:npm_config_cache = "<仓库>\.npm-cache"`；lifecycle 脚本在受限沙箱里会 `spawn EPERM`，
> 用 `npm install --ignore-scripts`。`npx tsc` 会去 registry 下 `tsc` 包，所以稳妥跑法是直接跑入口文件：
> `node node_modules/typescript/lib/tsc.js`、`node node_modules/vitest/vitest.mjs`、`node node_modules/vite/bin/vite.js`。

`test/fixtures/` 是从真实接口抓下来、脱敏后的快照（姓名/学号替换），所以归一化逻辑有真实形状兜底，不靠手搓样例。

## 实测接口（全部已跑通）

| 域 | 基址 | 用途 |
| --- | --- | --- |
| 门户 | `https://info.s.zzu.edu.cn/portal-api` | 课表事件、节次表、教学周、CMS 通知、一卡通 |
| 事务中心 | `https://transaction.s.zzu.edu.cn/ttc` | 待办计数与待办列表 |
| 教务门面 | `https://jwxt.zzu.edu.cn/eams-door/api/v1` | 用户信息、今日日程、通知（完整正文）、服务列表 |
| 教务业务 | `https://jwxt.zzu.edu.cn/eams-micro-server/api/v1` | 学期、课表、成绩、考试、教室、占用、培养方案 |

服务目录与「哪些服务能接、哪些接不了」的完整盘点见 [`docs/portal-services-inventory.md`](docs/portal-services-inventory.md)。

统一鉴权头：`X-Id-Token: <JWT>` + `X-Terminal-Info: h5` + `X-Device-Info: PCWin32NT`。服务端把「未登录」也回 HTTP 200，业务码写在 body 里（`code:-1 没有访问权限01`），所以 `http.ts` 拆包时会抛 `ApiError`。

空教室怎么算（踩过坑，记一下）：

- 教室列表 `POST /room/place/rooms` 带上 `date` 参数时，**每间教室自己带 `roomOccupationInfoVms`**，里面既有 `activityType: "Lesson"`（排课）也有 `RoomBorrow`（借用）——这才是真实占用。
- `POST /room/place/room-occupancy` 只返回借用，一天只有个位数（实测 8 条），拿它求差会得出「全天空闲」，是错的。
- `campusAssoc` 必须传数字：传字符串 `"2"` 服务端不报错、静默返回 0 条。
- `roomTypeIds` 默认只查普通教室(1)+多媒体教室(2)：不过滤是 1039 间（多为实验室/办公用房），过滤后 379 间，正好是 `物_505`、`北3_312` 这类真实上课教室。
- `minSeat` 服务端**忽略**，`seatsForLesson` 也常为 0，所以座位筛选实际只能在客户端做，且多数教室没有座位数据。
- 耗时随 `pageSize` 线性增长（30→154ms、500→20s），所以用「小页 + 12 路并发」翻页：全校一次约 4s，之后走 60s 缓存。

地点词（「南核」这类）走**教室名前缀**，不用服务端 `buildingIds`：

- 教室名形如 `南1_303`、`北3_403`、`物_505`，前缀就是学生嘴里的楼，好认也稳定。
- `buildingIds` 是不透明 id、跨学期可能变，而且「南核心教学区」根本不是它的一个 building。
- 映射表在 `src/core/place.ts`：南核→南1–南3、北核→北1–北5、核心教学区→南北全、物理馆→物、材料馆→材、化学馆→化、数学馆→数、图书馆→图，再退化到单个楼号。
- 前缀后一位不能是数字，所以 `北1` 不会吃掉 `北区2_101`；`南校区` 也不会被当成「南核」。
- 早先没有这层过滤时问「明天南核空教室」会回 590 间（全校教室），现在回 48 间（真在 南1–南3 里的）。

## 已知限制（诚实版）

- **成绩 / 考试**：接口通，但大一当前学期无数据（`data: []`），不是实现问题。
- **通知全文**：教务侧完整 HTML 可得；门户 CMS 的 `content` 被服务端硬截 200 字，官网原文需要登录才能抓，不抓。
- **空教室**：见上，全校 379 间可上课教室，一次约 4s（并发翻页），之后 60s 缓存；教室座位数基本为空。
- **模型兜底是可选、且慢**：L0 规则没命中时才会问模型；它要么判工具（`{tool,args}`，正文仍模板渲染），要么直接闲聊回答。学校 R1 有推理段，一次 11–25 秒（校外连不上）；换成第三方预设（DeepSeek 官方 / 硅基流动 / 百炼 / Moonshot / OpenRouter）是 0.5–2 秒。不填 key 就完全离线。
- **权限**：只申请 14 个域（8 个学校域 + `http://chat.zzu.edu.cn/*` + 5 家模型服务商），不申请 `<all_urls>`；没有自定义 `baseUrl`，所以不需要 `optional_host_permissions` 去弹授权。
- **一卡通 / 待办**：接口通，本号余额 `¥0`、待办全 0（确实没消费、没待办）；`message-service` 的未读数接口回 500，未读消息暂不做。
- **token 存储**：只在 `chrome.storage.local`，不出本机。`X-Id-Token` 等同于登录态，别导出这个扩展的存储。

## 为什么不是「抓网页」

门户和教务都是 uni-app 的 SPA，DOM 里没有稳定语义，且 `nth-child` 类选择器在构建间会漂。这两套系统的 App 与网页共用同一份代码，只靠 `X-Terminal-Info` 区分渠道——也就是说，只要拿到 `idToken`，能做的事和 App 完全一样，还比解析 DOM 稳。详见 `docs/campus-platform-architecture.md`。

## 安全边界（请先读）

- **token 等同登录态。** 扩展把 `X-Id-Token` 存在 `chrome.storage.local`（手机版存 `localStorage`），同步码是 base64 编码、**不是加密**，别发到群里、别贴到公开的地方。
- **没有任何后端。** 请求从你的浏览器直接发往学校的域名（以及你自己选的模型服务商），中间没有我的服务器。
- **模型只判意图。** 它返回 `{tool, args}`，正文一律由模板渲染——模型胡说不会变出假课表。
- **你能随时撤销**：清扩展存储、在模型服务商后台重置 key、或在 CAS 侧退出登录。
- 接口是逆向得到的非公开端点，**学校随时可能改**。改了就按 `docs/campus-site-probe.md` 里的方法重新探。

## 许可

[MIT](LICENSE)。代码可以随便用；但**不含**任何学校的版权素材（地图图片、校徽等都不在仓库里）。

非官方项目，与郑州大学及超星/树维等厂商均无隶属关系。用它查的是你自己的账号、你自己的数据，出问题自己负责。

## 贡献

欢迎 PR，但注意几条：

1. 别提交任何 token、`sk-` key、学号姓名、抓下来的原始响应（fixtures 必须脱敏）。
2. 新增能力前先读 `docs/portal-services-inventory.md`：里面记了哪些服务现实中接不上、为什么。
3. 跑一遍 `npm run verify`；能动 UI 的话再跑 `npm run e2e` 与 `npm run pwa:shot`。
