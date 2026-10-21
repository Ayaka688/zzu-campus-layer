# 校园信息层 · v0.2 修订（实测版）

> 取代 `campus-layer-handoff.md`（v0.1）中的架构主路径、权限策略、Schema 与验收标准。
> 修订依据：`campus-site-probe.md`、`campus-platform-architecture.md`，以及 `campus-layer/` 里已跑通的实现。
> 日期：2026-10-20

## 0. 一句话

v0.1 假设「用 content script 解析教务网页的 DOM」。实测后这一层不需要：学生端的门户与教务都是 uni-app SPA，App 与网页共用同一份前端、靠 `X-Terminal-Info` 区分渠道；拿到 CAS 下发的 `idToken` 后，所有数据都能用 JSON API 直取。**v0.2 的主路径 = 取 token + 直连 API + 本地归一化 + 模板回答**，DOM 解析整层删除。

## 1. 与 v0.1 的差异总表

| # | v0.1 的要求 | v0.2 的处理 | 依据 |
| --- | --- | --- | --- |
| 1 | Adapter 层：`parse(input): T[]` / `selfTest()` / `matches(url)`，按页面解析 DOM | **删除**。改为 `src/core/{portal,jwxt}.ts` 里的纯函数，输入 API JSON | 两站点 DOM 无稳定语义；API 稳定且字段齐全 |
| 2 | C5「禁用 `nth-child` 选择器」 | 自动满足（无 DOM 选择器） | — |
| 3 | C1「只申请两个占位教务域」 | 改成 **14 个真实域**白名单（8 个学校域 + 6 家模型服务商，见 §3），仍不申请 `<all_urls>` | 跨源 fetch 必须靠 host_permissions |
| 4 | §7.3 让用户自填 `baseUrl` | **删除**。域名固定，不开放任意端点 | 任意 baseUrl 会引入 `Failed to fetch` 与 SSRF 面 |
| 5 | 巡检（路径 C，判断是否登录） | **删除**。改用 `code:-1 没有访问权限01` + JWT `exp` 双重判定 | 服务端把未登录塞进 HTTP 200，跳转判定必然误判 |
| 6 | `get_schedule(week)` 缺学期首周 | `Term.startDate` 由 `/semester/current-semester` 给出（2026-09-07） | 服务端权威 |
| 7 | `TimeSlot` 手工维护节次时间 | 用 `/room/system/course-units` 的 10 条权威节次表 | 无需硬编码 |
| 8 | `weeks: number[]` 无法表达单双周 | 保留 `number[]`，**不加 `pattern` 字段**：课表已按日期实例化，单双周由 `weekIndex` 集合自然表达 | `/lesson/student/course-table` 的 `schedules[].weekIndex` |
| 9 | `Notice.bodyText` 必填 | 改 `summary`（可选，能拿到的字符串）+ 可选 `contentHtml` | 门户 CMS 硬截 200 字；教务处通知有完整 HTML |
| 10 | L1 LLM / Ollama 作为意图层 | 降级为**可选增强**，默认关闭；2026-10-21 起已接学校自建 Open WebUI（`http://chat.zzu.edu.cn`，`DeepSeek-R1`），只判意图不出数据 | Ollama 默认拒 `chrome-extension://` origin，评委机器跑不起来；学校模型仅在校园网内 |
| 11 | `rag_lookup` 工具 | **删除**。没有语料，且通知全文一半拿不到 | 无数据源 |
| 12 | `export_ics` 无下载通道 | 面板用 `Blob` + `URL.createObjectURL` 直接存 `.ics` | — |
| 13 | 空教室「数据源未知」 | **可用**：全部教室 − 当天占用；占用取自 `rooms` 响应里每间教室的 `roomOccupationInfoVms`（含 `Lesson` 排课），**不是** `room-occupancy`（那个只含借用，一天个位数） | `/room/place/rooms`（带 `date`） |
| 14 | 成绩/考试「无入口」 | **可用**：`/grade/student/grades`、`/exam/student/exam`（本账号当前为空） | 微前端 `eams-student-grade-app` / `eams-exam-student-app` |
| 15 | M2「真实站点逆向 3–4 人日」 | 已完成，不再计入工期 | 本仓库 |

## 2. 架构（v0.2）

```
用户一句话
   │
   ├─ intent.parseIntent(text, today)      L0 规则，命中即出 {tool,args}
   │     └─ 未命中 → 若开启 L1 且配了 key → llm.classifyIntent()
   │                              └─ 模型只回 {tool,args}，仍要过工具 zod
   │
   ├─ tools.runTool(name, args, svc)       zod 校验参数 → 调服务
   │
   ├─ services.CampusService               5 分钟 TTL 缓存
   │     ├─ jwxt（优先）: 学期/课表/教室/成绩/考试/通知
   │     └─ portal（降级）: 课表事件 + 节次表 + CMS 通知
   │
   └─ render.*                             Markdown 模板作答（无模型）
```

L1 已在 `campus-layer/src/core/llm.ts` 落地（2026-10-21，2026-10-21 晚扩成服务商表）：统一 OpenAI 兼容 `/chat/completions`，预设六家 —— 学校自建 Open WebUI（`http://chat.zzu.edu.cn/api`，模型 id `DeepSeek-R1`，用 `sk-` API Key 而非 CAS token，仅校园网 + 仅 http）+ DeepSeek 官方 / 硅基流动 / 阿里百炼 / Moonshot / OpenRouter（自带 key，HTTPS 页面可用）。默认关闭，在 `⚙`（面板或手机版）里选服务商填 key 才启用。

**模型不止判意图（2026-10-21 晚改）**：同一次请求里，模型要么给 `{"tool":…}`，要么直接用中文回答（问候、自我介绍、怎么用、一般常识）。`parseModelReply` 认纯文本与 `{"reply":…}` 两种；`agent.ts` 把自由回答标成 `via:'llm-chat'`（界面徽标「由模型回答」），只有模型既不判工具也不说话时才回落到 `helpText`。为什么改：原先问「hello」只会甩一屏能力清单，用户判断不了是「坏了」还是「不认」。代价是每条未命中的话都要过一次模型（R1 11–25s，`deepseek-chat` 约 1s）。

数据红线不变：模型永远不生成课表/成绩/通知正文，这些只来自学校接口 + 模板渲染。

## 3. 权限与域名（C1 修订）

```json
"permissions": ["storage", "alarms", "sidePanel"],
"host_permissions": [
  "https://cas.s.zzu.edu.cn/*",
  "https://uniapp.s.zzu.edu.cn/*",
  "https://info.s.zzu.edu.cn/*",
  "https://authx-service.s.zzu.edu.cn/*",
  "https://message-service.s.zzu.edu.cn/*",
  "https://transaction.s.zzu.edu.cn/*",
  "https://formflow.s.zzu.edu.cn/*",
  "https://jwxt.zzu.edu.cn/*",
  "http://chat.zzu.edu.cn/*",
  "https://api.deepseek.com/*",
  "https://api.siliconflow.cn/*",
  "https://dashscope.aliyuncs.com/*",
  "https://api.moonshot.cn/*",
  "https://openrouter.ai/*"
],
"minimum_chrome_version": "114"
```

第 9–14 条是模型服务商：第 9 条是学校 LLM（仅校园网、HTTP 明文），其余 5 家是可选的自带 key 通道（HTTPS 页面也能用）。全部不填 key 时不会被请求。

- 不申请 `cookies`：`idToken` 由 content script 从 `localStorage` / `document.cookie` 读，页面自己有权限。
- 不申请 `<all_urls>`，不申请 `optional_host_permissions`（因为不做自定义 `baseUrl`，无需运行时授权）。
- `minimum_chrome_version` 必须是 **114**（`chrome.sidePanel` 自 114 起），v0.1 写的 111 只覆盖 `world:'MAIN'`。

## 4. Schema（v0.2，与 `campus-layer/src/core/types.ts` 一致）

| 模型 | 字段 |
| --- | --- |
| `Course` | `key, name, teachers[], location?, campus?, weekday(1–7), startTime(HH:mm), endTime, sectionStart?, sectionEnd?, weeks[], date?, source('portal'\|'jwxt')` |
| `Notice` | `id, title, summary(default ''), contentHtml?, publishedAt?, department?, readCount?, url?, source('portal-cms'\|'jwxt-notice')` |
| `Term` | `id, code, startDate, endDate, weeks[], currentWeek?, season?` |
| `Room` | `id, name, code?, buildingId?, buildingName?, campus?, floor?, seats?` |
| `Occupancy` | `roomName, date, startAt(HHmm 整数), endAt, activity?, type?, teacher?` |
| `FreeRoom` | `room, freeSections[]` |
| `Grade` / `Exam` | `.passthrough()` 宽松模型（字段随教务版本变） |
| `CourseUnit` | `indexNo, startTime, endTime, dayPart?` |

要点：`weeks` 是**教学周序号**而非自然周；`startTime/endTime` 统一 `HH:mm` 串（服务端给 `800`/`08:00:00` 两种，入口处归一）；`source` 保留来源便于 UI 标注可信度。

## 5. 工具集（v0.2.2，10 个）

| 工具 | 参数（zod） | 语义 |
| --- | --- | --- |
| `get_schedule` | `{week?: int 0–30, day?: 'today'\|'tomorrow'\|1–7}` | 默认当前教学周；按天过滤 |
| `find_free_room` | `{date?: YYYY-MM-DD, campus?, building?, minSeats?, sections?: int[1–20], limit?}` | 全部教室 − 当天占用；`sections` 要求全闲；`building` 走教室名前缀（南核=南1–南3、北核=北1–北5、物理馆=物） |
| `search_notice` | `{keyword?, limit?}` | 标题+摘要匹配；教务处通知全文、门户 200 字摘要 |
| `get_grades` | `{}` | 成绩/绩点 |
| `get_exams` | `{}` | 考试安排，空则明说 |
| `get_plan_progress` | `{code?: string}` | 培养方案学分进度：按模块列要求/已通过/在修/还差 + 未修课程清单（默认 `code='01'` 主修） |
| `open_service` | `{keyword: string}` | 门户服务直达：从 19 项服务里匹配，返回说明 + 官方 URL（面板渲染成可点按钮） |
| `get_card` | `{}` | 一卡通余额 + 最近消费/充值（门户 `/v2/personalData/getMyECard`） |
| `get_todos` | `{}` | 待办/在办/待申请计数，紧急与超时单列，附第一条事项的办理入口 |
| `export_ics` | `{fromWeek?, toWeek?}` | 生成 `.ics`，带 `Asia/Shanghai` 与 VTIMEZONE |

> **跨域 token 的实测结论**：教务那张 30 天 `idToken` 在 `portal-api` / `transaction` 上同样有效（同一 CAS 签发、受众相同），
> 所以 `services.portal()` 优先用教务票、门户票（8 小时）只作备用——这一条让「一卡通 / 待办」不必等用户重登门户。

> **新增的两个工具解决的是不同性质的问题**：`get_plan_progress` 是「把已有的结构化数据算成人话」，
> `open_service` 是「把做不到的能力老实交还给官方入口」。后者是这次盘点（`docs/portal-services-inventory.md`）的直接产物——
> 座位预约 443 拒连、智慧食堂 API 不在 h5 那台机上、学术搜递证书不匹配，这些短期内都接不了，
> 与其假装能查，不如一句话把人送到门口。

> **渲染层附带**：`get_schedule` 的回答下方会附一张郑大主校区地图（`public/map/campus.jpg`，随扩展打包，默认收成 240px 高的小图，点一下展开整张）。需求来自实操：课表给出「南1_303」「物_505」这类教室编号，学生还需要知道那栋楼在哪儿。这是扩展自身的静态资源，不需要额外 host 权限、不引入新依赖，也不改变工具契约。

## 6. 数据可得性（v0.2 实测矩阵）

| 数据 | 结论 | 端点 | 备注 |
| --- | --- | --- | --- |
| 学期与首周 | ✅ | `/eams-micro-server/api/v1/semester/current-semester` | `2026-09-07` → `2027-01-17`，19 周 |
| 当前教学周 | ✅ | `/semester/current-week/{termId}` | `7` |
| 课表 | ✅ | `/lesson/student/course-table/{termId}` | 11 门 / 40 条日期实例 / 154KB |
| 节次表 | ✅ | `/room/system/course-units` | 10 节，含 `800-845` 等 |
| 全部教室 | ✅ | `POST /room/place/rooms` | 全部 1614 间；只查普通+多媒体教室是 379 间，30 条/页 |
| 教室占用 | ✅ | 同上响应里的 `roomOccupationInfoVms` | 每间自带若干 `Lesson`/`RoomBorrow` 时段（`startTime`/`endTime` 为 HHmm 整数） |
| 教室占用（借用表） | ⚠️ 只含借用 | `POST /room/place/room-occupancy` `{date}` | 一天仅 8 条，**不能**用来算空教室 |
| 空教室 | ✅ | 教室 − `roomOccupationInfoVms` 求差 | 12 路并发翻页约 4s，之后 60s 缓存 |
| 成绩 | ✅接口 / ⚠️无数据 | `/grade/student/grades` | 大一本学期空 |
| 考试 | ✅接口 / ⚠️无数据 | `/exam/student/exam` | 学期中未发布 |
| 通知（教务） | ✅ 完整正文 | `/eams-door/api/v1/protal-notice/get-notices` | HTML，`readCount` 可读 |
| 通知（门户 CMS） | ⚠️ 摘要仅 200 字 | `/portal-api/v3/cms/content/getColumncontents` | `getOne` 返回空壳，官网原文需登录 |
| 门户课表 | ✅ 可作为降级源 | `/portal-api/v1/calendar/share/schedule/getEvents` | 一次整学期 207 条 |
| 校历/可订阅日历 | ✅ | `/portal-api/.../subscribe/page` | 含「校历」 |
| 待办（教务门面） | ✅ 接口通 / 空 | `/eams-door/api/v1/todo/getTodos` | 无待办 |
| 培养方案学分 | ✅ | `/eams-micro-server/api/v1/plan/search/completion/info?code=01` | 30,920B；本号 166 要求 / 0 已通过 / 25 在修；缺 `code` 报 500 |
| 门户服务目录 | ✅ | `/portal-api/v2/service/serviceShowAll`、`/v1/service/list` | 本号 22 项；已整理成 19 项目录并带口语别名 |
| 当前教学周（一次调用） | ✅ | `/eams-door/api/v1/calendar/get-current-teach-week` | `{currentSemesterId:194, weekIndex:7, inSemester:true}`，可替掉两步调用（v0.3） |
| 校区作息表 | ✅ | `/eams-door/api/v1/calendar/get-campus-layout-table` | 35,278B / 10 条，含校区与作息模板（v0.3） |
| 一卡通余额 | ✅ 已接（用教务票） | `/portal-api/v2/personalData/getMyECard` | 余额是字符串 `"0"`；卡类型 `uni-app`；流水为空 |
| 待办（事务中心） | ✅ 已接 | `/ttc/v1/count/ttcCount?readed=0` + `/ttc/api/ttc/center-list/getToDoList` | 本号全 0；`message-service` 未读数接口回 500，暂不做 |

## 7. 鉴权（v0.2 主路径）

1. content script 在 `uniapp.s.zzu.edu.cn` 读 cookie `userToken`（门户，8h）。
2. content script 在 `jwxt.zzu.edu.cn` 读 `localStorage['X-Id-Token'|'idToken'|'token_key']` 或 cookie `X-Id-Token`（教务，30d）。
3. `chrome.runtime.sendMessage({type:'token', token, source})` → 存 `chrome.storage.local`。
4. SW 发请求时带 `X-Id-Token`、`X-Terminal-Info: h5`、`X-Device-Info: PCWin32NT`，`credentials:'omit'`（不需要 cookie）。
5. 过期判定 = JWT `exp` 到期 **或** 业务码 `code:-1` / `没有访问权限` → 面板标红，提示重新登录。

**安全边界**：token 只存本机 `chrome.storage.local`；不打印、不远程上报；面板只显示剩余时长与姓名/学号末位。

## 8. 风险与限制

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 门户 token 8 小时过期 | 门户降级源失效 | 面板标红 + 提示重开页面；有教务 token 时主功能不受影响 |
| 成绩/考试为空 | 演示时像"没实现" | 回答里明说「当前学期尚未发布」，不报错 |
| 门户通知只有 200 字 | 全文检索体验差 | UI 标注来源；检索只用标题+摘要 |
| 教室 379 间（限普通+多媒体） | 首次空教室约 4s | 12 路并发翻页 + 60s 缓存 + 只在需要时拉 |
| 教室座位数据为空 | 按座位筛选无效 | 客户端兜底 + UI 说明，不当成必选条件 |
| 接口无版本契约 | 学校升级会断 | 全部 zod 校验 + fixture 回归，断了能定位到字段 |
| `X-Device-Info` 等头可能被收紧 | 401/业务码变化 | 判据写成「业务码非 0 即失败」，不白屏（C9） |

## 9. DoD（v0.2 验收）

1. `npm run typecheck` 零错误；`npm test` 全绿（离线 fixture）。
2. `npm run build` 产出 `dist/`，可在 Edge 114+ 以「加载解压缩扩展」安装。
3. 登录门户与教务后，面板两枚 token 状态正确显示剩余时长。
4. 五句话跑通：`本周课表` / `明天有课吗` / `明天下午的空教室` / `最新通知` / `导出日历`。
5. 导出 `.ics` 能被手机日历导入，时间落在北京时间正确时段，周次裁剪有效。
6. 断网状态下，除数据类回答外，帮助文本与错误提示仍可读（不白屏）。
7. 无 LLM 环境（无 Ollama、无云端 key）下，上述 4 全部成立。

验收记录（真浏览器 + 真 token，Edge 155.0.4283.62，2026-10-20）：

| # | 怎么验的 | 结果 |
| --- | --- | --- |
| 1 | `tsc --noEmit` + `vitest run` | 零错误；35 passed / 6 skipped（跳过的是实网用例） |
| 2 | `vite build` → `dist/` 7 个文件；`--load-extension` 起 Edge | 扩展 id 正常、SW 注册、面板可打开 |
| 3 | 面板 token 药丸 | 「教务 · 28 天」「门户 · 5 小时」 |
| 4 | 面板 + SW 各问一遍 | 五句全部答对（含「明天有课吗」精确到 2 门课/教室/教师） |
| 5 | `ics.test.ts` + `export_ics` | 33 个日程 / 26 门课，`DTSTART;TZID=Asia/Shanghai`、周次裁剪、折行与转义均过；**手机日历实机导入未验** |
| 6 | 把 token 换成已过期的 JWT 再问 | 提示「教务登录态已失效，请重新打开 https://jwxt.zzu.edu.cn 登录一次」，不白屏；认不出的问题返回帮助文本 |
| 7 | 全流程无模型调用 | 成立（不填 key 时代码路径完全不碰网络模型） |
| 8 | L1 兜底（2026-10-21 补测） | 填学校 key 后问「后天下午哪个屋子能让我安静看会儿书」（规则层认不出）→ `via: "llm"` → `find_free_room` → 2026-10-23 真实空教室（北1_102 空闲 1-4 节 等），11.6–17.5s |
| 9 | 培养方案 + 服务直达（2026-10-21 补测） | `get_plan_progress` 740ms 答「要求 166 / 已通过 0 / 在修 25 / 还差 141，未修 54 门」；`open_service`「打开座位预约」→ 面板出现可点按钮「打开 座位预约 ↗」指向 `https://order.lib.zzu.edu.cn/`；69 passed / 6 skipped |
| 10 | 一卡通 + 待办（2026-10-21 补测） | `get_card` 163ms「余额 ¥0 / 卡类型 uni-app / 没有最近流水」；`get_todos` 110ms「目前没有需要你处理的待办」；live 9/9 通过（全部用教务票访问门户与事务中心）；86 passed / 7 skipped |
| 11 | 手机 PWA（2026-10-21 补测） | `npm run pwa:shot`：无头 Edge 155 + 390×844 移动视口 → 清空本地 → 点「登录态」→ 粘贴 3,496 字符同步码 → 药丸变「教务 27 天」→ 问「明天有课吗」得课表 + 校园地图（1280×2044）→ 问「今天上午的空教室」得 1-4 节空闲列表（只列前 12 间 + 「共 N 间」提示）；`tsc` 0 错、94 passed / 9 skipped、`dist/pwa/index.html` 0.93 kB、`background.js` 2.02 kB（共享 chunk 102.40 kB） |
| 12 | 扩展同步码 + e2e 加固（2026-10-21） | `bundle:export` 从面板发出 → 3,496 字符码，解回 `{v,jwxt,portal,at}`（jwxt 1,298 字符、含门户票）；顺手修了 e2e 的一个真 bug：token 不再写进 SW target（`Runtime.evaluate` 打到已休眠的 SW 会报 `chrome is not defined`），改成在扩展页面里写并 `Page.reload`，失败路径也会 kill 掉 Edge 不再挂住端口 |
| 13 | 服务商预设 + 相对路径（2026-10-21） | `tsc` 0 错、**101 passed / 9 skipped**；`vite build` 产物 `dist/pwa/{index.html,pwa-sw.js,pwa.webmanifest}` 且 HTML 全引用 `../assets/…`（子路径可部署）；`pwa-shot` 绿（L1 徽标「由模型判定」、2026-10-23 空教室）；`e2e` 绿（10 工具、`settings inputs:3`、`bundle:llm {provider:"school", model:"DeepSeek-R1"}`、L1 `15.6s via:llm`）；新增 4 条 `llm.test.ts` 用例（换服务商改地址、未知回落学校、402/429 文案、HTTPS+http 服务商直接放弃） |
| 14 | 地点词 + 模型自由回答（2026-10-21 深夜） | ①`src/core/place.ts`：南核→南1–南3、北核→北1–北5、物理馆→物，按教室名前缀过滤（不用不透明的 `buildingIds`）。实网 `ask('明天南核空教室')` → `count 48`，全部 `^南[123]_`；`e2e` 新增断言 `south-core {"hasSouth":true,"leakedNorth":false}`，标题「2026-10-22 空教室 · 南核心教学区（南1–南3）」。②`parseModelReply` + `via:'llm-chat'`：问「hello」由模型直接作答（徽标「由模型回答」），不再甩能力清单。`tsc` 0 错、**134 passed / 10 skipped**、live 10/10（含新用例）、`e2e` 与 `pwa-shot` 全绿 |

## 9.1 移动端（PWA，2026-10-21 追加）

安卓 Chrome 至今不支持扩展（Kiwi 已停更），所以 v0.2.3 起同一套 `src/core/` 又打了一个网页版 `dist/pwa/`：

- 存储抽象 `src/core/kv.ts`：`chrome.storage.local` ↔ `localStorage`（前缀 `campus-layer:`）运行时二选一，`storage.ts` 全部改走它，所以核心逻辑零分叉。
- 登录态搬运：`exportTokenBundle()` → base64 同步码（`{v:1,jwxt,portal,at}`）→ 手机 `importTokenBundle()`。**编码不是加密**，等同 `X-Id-Token`。
- 部署约束：service worker 与「添加到主屏幕」要求**安全上下文**，所以必须 HTTPS 或 localhost；局域网 `http://192.168.x.x:8899` 能跑数据查询但装不了。
- 手机版**也能有 L1**：登录态面板底部就是模型设置（服务商 / key / 模型名），同步码里也会带上。
- 验证脚本：`scripts/serve-pwa.mjs`（静态服务，绑 `0.0.0.0` 便于同网段手机预览）、`scripts/pwa-shot.mjs`（CDP 移动视口端到端）。

### 9.1.1 模型来源：从「只有学校」到「六家预设」（2026-10-21 追加）

`src/core/llm.ts` 改成服务商表 + 统一 OpenAI 兼容调用：

- `LLM_PROVIDERS` 六项：`school`（`http://chat.zzu.edu.cn/api`，`DeepSeek-R1`，`campusOnly`）、`deepseek`（`https://api.deepseek.com`，`deepseek-chat`）、`siliconflow`（`https://api.siliconflow.cn/v1`）、`dashscope`（`https://dashscope.aliyuncs.com/compatible-mode/v1`）、`moonshot`（`https://api.moonshot.cn/v1`）、`openrouter`（`https://openrouter.ai/api/v1`）；`chatEndpoint(provider)` 统一拼 `/chat/completions`，模型名留空则用预设默认。
- **只做预设、不做自定义 `baseUrl`**：自定义域名要么全放开（`optional_host_permissions` + 每次弹授权、`<all_urls>` 味道），要么维护一张永远不全的名单。六家常见的够覆盖「想自带 key」的需求。
- `host_permissions` 由 9 域增到 **14 域**（+5 家服务商）。仍不申请 `<all_urls>` / `optional_host_permissions`。
- 错误翻译 `friendlyHttpError()`：401 说「key 无效或过期」、402「余额不足」、403「地域或额度限制」、404「模型名不对」、429「限流」，不再把裸 `HTTP 401` 甩给用户。
- **HTTPS 页面 + 学校预设 = 立刻放弃**（`classifyIntent` 开头判断 `baseUrl.startsWith('http:') && isHttpsPage()` 直接 `return null`），不白等 30s；界面就地提示换服务商。
- 同步码扩成 `{v, jwxt?, portal?, llm?: {provider, apiKey, model, enabled}, at}`。
- 共用 UI：`src/ui/llm-fields.tsx`（面板与 PWA 同一份控件）。
- 部署改为**相对路径**（`vite.config.ts` 的 `base: './'`），manifest/SW 移到 `public/pwa/` 并用 `self.registration.scope` 拼壳缓存路径，因此可放域名根也可放子路径（GitHub Pages 项目页）。部署三种免费放法与自检清单见 [`deploy-pwa.md`](deploy-pwa.md)。

### 9.1.2 「不部署服务器」的可行性依据（实测）

| 目标 | 公网可达 | CORS | 结论 |
| --- | --- | --- | --- |
| `jwxt.zzu.edu.cn` | ✅（境外节点 301，1.7–2.3s） | 回显 Origin | 4G 直查 |
| `info.s.zzu.edu.cn/portal-api` | ✅（境外节点 200） | `*` | 4G 直查 |
| `cas.s.zzu.edu.cn` | ✅（境外节点 302） | — | 只用于登录页 |
| `chat.zzu.edu.cn` | ❌ 私网 `10.67.16.3` | 回显 | 仅校园网 + 仅 http |

也就是说：**数据能力零服务器**，只要一个免费静态托管；唯一离不开校园网的是学校模型，且已被「自带 key」这条预设覆盖。

## 10. 未决（v0.3 候选）

- 成绩接口的真实字段（等期末有数据后补 fixture）。
- 门户 `getOne` 的空壳是否为权限问题（换账号/换栏目再试）。
- 是否需要 `chrome.alarms` 主动刷新 token 状态（当前面板轮询 15s）。
- 一卡通余额 / 最近流水、办事待办 + 未读：接口早前实测通过，但门户 token 只有 8h，
  要等采集到新 token 才能实网验证，故未纳入本轮（见 `docs/portal-services-inventory.md` §4）。
- 座位预约 / 智慧食堂 / 学术搜递 / 会务接待：实测打不通（443 拒连、API 不在 h5 主机、证书不匹配/过期），
  当前只做「一句话给官方入口」。等它们恢复再做。
- 学校 R1 延迟：一次 11–18s。若学校侧新增非推理模型（或 Open WebUI 支持 `think:false`）应切过去；否则用第三方预设。
- 自定义 `baseUrl`（自建反代 / 其它兼容网关）：暂不做，理由见 §9.1.1；真要做需引入 `optional_host_permissions` + 授权流程。
- 自动化部署：`docs/deploy-pwa.md` 里给了三种手工/CLI 放法，还没写成 `scripts/deploy.mjs`（需要用户的托管账号凭据，不适合默认自动化）。
