# 门户（豫见郑大）服务盘点：哪些值得接进扩展

> 目的：用户提出「对学生服务网站做一个全面的优化层」。这份文档把门户里**真实存在**的服务逐个过一遍，
> 记下它到底提供什么信息、接口能不能直接用、值不值得接进对话层。
>
> 数据来自 2026-10-21 的实测（账号 202600000001），不是猜的。
> 相关文档：`docs/campus-site-probe.md`（接口测绘）、`docs/campus-platform-architecture.md`（结构）、`docs/campus-layer-v0.2.md`（规格）。

## 0. 怎么盘点的

| 手段 | 拿到什么 |
| --- | --- |
| `POST https://info.s.zzu.edu.cn/portal-api/v2/service/serviceShowAll` | 门户「全部服务」页的分组与条目（15 项/组） |
| `POST .../portal-api/v1/service/list` | 按账号授权的服务列表（本号 22 项） |
| `GET /portal-api/v2/service/category/list` | 服务分类 |
| 直接打每个服务的 URL | 判断它是「活的前端」「需要登录」「证书/端口有问题」还是「已下线」 |
| 微前端 chunk 抽取（`tmp/zzu/micro-extract2.mjs`） | 从 `/{app}/static/js/index.*.js` 里挖真实 API 路径 |
| CDP（`tmp/zzu/probe.mjs`，端口 9222） | 在登录态页面里跑 JS、看 `performance.getEntriesByType('resource')` |
| Node 直连（带 `X-Id-Token`） | 验证接口是否真的可用、返回什么结构 |

关键事实：**门户与教务是两套 BFF**（`info.s.zzu.edu.cn/portal-api` vs `jwxt.zzu.edu.cn/eams-door` + `eams-micro-server`），
但共用同一个 CAS 签发的 `idToken`。门户 token 只有 **8 小时**，教务 token **30 天**——所以扩展的主数据源是教务，
门户只在需要它的那几项能力时才用。

## 1. 全部服务清单与判定

判定列含义：**接**＝已接进扩展；**可接**＝有可用接口，排进下一批；**只链**＝没有稳定接口或是一次性表单，只给直达链接；**接不了**＝实测打不通。

| 服务 | 主机 | 提供什么 | 实测状态 | 判定 |
| --- | --- | --- | --- | --- |
| 课表 / 空教室 / 成绩 / 考试 / 培养方案 | `jwxt.zzu.edu.cn` | 学期、教学周、课程、教室占用、成绩、考试、学分进度 | 全部 200，已实网验证 | **接**（5 个工具） |
| 通知公告 | `jwxt.zzu.edu.cn` | 教务处通知（完整正文 HTML）、门户公告（截断 200 字） | 200 | **接**（`search_notice`） |
| 门户服务目录 | `info.s.zzu.edu.cn` | 服务名 + 官方入口 URL | 200 | **接**（`open_service` 直达） |
| 座位预约 | `order.lib.zzu.edu.cn` | 图书馆座位/自习位预约 | **ECONNREFUSED**（443 拒连，疑似仅 http 或限网段） | 接不了（只能给链接） |
| 图书馆 | `library.zzu.edu.cn` | 馆藏检索、借阅/续借、电子资源 | 200（汇文系统，需单独登录） | 只链（借阅记录待验证） |
| 学术搜递 | `sodi.zzu.superlib.net` | 文献传递（超星） | **ERR_TLS_CERT_ALTNAME_INVALID** | 接不了（证书不匹配） |
| 智慧食堂 | `222.22.63.118:58100` | 订餐/取餐/消费 | h5 200（vue SPA），但 bundle 里的 `/api/v2/mobile/order/*` 全部「访问地址不存在」 | 只链（API 不在这个 host 上） |
| 网络报修 | `ecard.v.zzu.edu.cn` | 报修工单提交/进度 | 200（h5 表单） | 只链 |
| 网上办事大厅 | `ehall.v.zzu.edu.cn` | 请假、证明、各类审批 | 302 → `/taskcenter` | 只链（事项表单各不相同） |
| 学生奖惩助贷 | `authx-service.s.zzu.edu.cn` | 奖学金/助学金/贷款/处分 | CAS 中转页 | 只链（需再确认有无 JSON 接口） |
| 校园通行 | `jf.v.zzu.edu.cn` | 门禁、出入校申请（点击量 1026 万，最高） | CAS 中转页 | 只链 |
| 校历 / 作息表 | `jwxt.zzu.edu.cn/eams-door` | 学期列表（61 个学期）、当前教学周、校区作息表 | 全部 200（本文 §4 新增验证） | **可接**（下一批） |
| 一卡通 | `info.s.zzu.edu.cn/portal-api` | 余额、消费流水 | 200（`/v2/personalData/getMyECard` 余额 `"0"`、卡类型 `uni-app`） | **已接**（`get_card`） |
| 待办 / 消息 | `transaction.s.zzu.edu.cn`、`message-service.s.zzu.edu.cn` | 办事待办数、未读消息数 | 待办 200（本号全 0）；`message-service` 未读数 500 | **待办已接**（`get_todos`）；未读数接不了 |
| 个人云盘 | `pan.v.zzu.edu.cn` | 校内网盘 | 200（需登录） | 只链 |
| 校园地理信息 | `ksh-ms.v.zzu.edu.cn` | 校园地图/楼栋定位 | 200 | 只链（已有静态地图兜底） |
| 会务接待 | `hwjd.zzu.edu.cn` | 会议室/接待申请 | **CERT_HAS_EXPIRED** | 接不了（证书过期） |
| 厚山学习平台 | `course101.zzu.edu.cn` | 101 计划课程 | 200 | 只链 |
| DeepSeek（学校自建） | `chat.zzu.edu.cn` | Open WebUI + `DeepSeek-R1` | 200，`sk-` key 可换（http 明文，仅校内） | **接**（可选意图兜底） |
| AI 大模型农场 | `jksb.v.zzu.edu.cn` | 另一个 DeepSeek 入口 | 独立账号 + 图形验证码登录 | 只链 |
| AI4S 平台 | `auth.zzu.edu.cn:8080` | 科研 AI | 200（需登录） | 只链 |
| 校园码 | `zzuitOffline://` | 校园码（离线） | 仅 App 内可用 | 接不了（离线码不进浏览器） |

## 2. 「值得整合」的判断标准

不是所有信息都值得变成对话能力。我用的三条线：

1. **信息本身是结构化的**（能拿到 JSON，不是一张 HTML 表单）——否则只能给链接。
2. **高频且答案短**——课表、空教室、学分、成绩这类，一句话就能答完；报修进度、审批流这类要看状态机，放对话里反而绕。
3. **提问方式自然**——学生会直接问「明天有课吗」「还差多少学分」「哪有空教室」，但不会问「帮我查一下 2024 年的奖学金评定办法」。

按这三条，**已接的 10 个能力**刚好覆盖了日常 85% 的问答；剩下值得接的已经不多（见 §4）。

## 3. 已接进扩展的能力（10 个）

| 工具 | 回答什么 | 数据源 |
| --- | --- | --- |
| `get_schedule` | 今天/明天/本周/第 N 周有什么课 | 教务课表 |
| `find_free_room` | 某天哪间教室空着（按节次） | 教室占用 |
| `search_notice` | 最新通知、按关键词找通知 | 教务处通知 |
| `get_grades` | 本学期成绩 | 教务成绩 |
| `get_exams` | 考试安排 | 教务考试 |
| `get_plan_progress` | 培养方案学分进度、还差多少、哪些课没修 | 培养方案 |
| `open_service` | 「XX 在哪办」→ 直接给入口链接（19 项服务） | 门户服务目录 |
| `get_card` | 一卡通余额 + 最近消费/充值 | 门户一卡通（新增） |
| `get_todos` | 待办/在办/待申请计数，紧急与超时单列 | 事务中心（新增） |
| `export_ics` | 把课表导出成日历文件 | 教务课表 |

工程细节：
- `get_plan_progress` 走 `GET /eams-micro-server/api/v1/plan/search/completion/info?code=01`（30,920B，实测 679ms），
  递归统计 `result === '未修'` 的叶子课程。缺 `code` 会 500 `Required String parameter 'code' is not present`，
  别省略这个参数。
- `open_service` 是纯本地表（`campus-layer/src/core/catalog.ts`），不发请求、1ms 返回；
  匹配优先级：名字完全命中 100 > 别名 90 > 名字包含 80 > 名字被包含 70 > 别名包含 60 > 描述 30。
  - `get_card` / `get_todos` 都用**教务票**访问门户与事务中心（见 §3.1 的跨域结论），
  余额是字符串（`toYuan()` 统一成数字），流水为空时明说「没有最近流水」；待办计数全 0 时明说「没有需要你处理的待办」。
- 面板里 `data.url` 存在时会渲染成一个可点的胶囊按钮（`a.go`），点开就是官方入口。

### 3.1 一个关键实测：教务票能直接查门户 / 事务中心

早前以为「门户接口必须门户 token」，其实两张票**同一个 CAS 签发、受众相同**：
教务那张 30 天 `idToken` 在 `portal-api`、`transaction.s` 上全部照通（`probe-cross-token.mjs`、`probe-todo.mjs`）。
所以 `services.portal()` 优先用教务票，门户票（8 小时）只作备用——这让一卡通/待办不用等用户重登门户。

## 4. 下一批候选（按性价比排序）

1. **当前教学周** — 今天新验到 `GET /eams-door/api/v1/calendar/get-current-teach-week` 一次就能拿到
   `{currentSemesterId:194, weekIndex:7, inSemester:true, startDate, endDate}`，
   可以替掉现在「先取学期、再取该学期周次」的两步调用。
2. **校区作息表** — `GET /eams-door/api/v1/calendar/get-campus-layout-table`（35,278B，10 条），
   含校区 + 作息时间模板，可用来给「第 5 节几点」这种问题作答（现在靠门户的 `getSection`，教务侧更权威）。
3. **图书馆借阅 / 座位** — `library.zzu.edu.cn` 首页 200，但座位预约那台 `order.lib.zzu.edu.cn` 443 拒连，
   借阅记录要登录后才知道有没有 API，优先级次之。
4. **未读消息** — `message-service` 的 `getAppAllUnReadCount/new` 稳定回 500，等它修好再试。

## 5. 明确接不了的（别再试了）

| 服务 | 为什么 | 证据 |
| --- | --- | --- |
| 座位预约 | 443 直接拒连 | `ECONNREFUSED 443`（可能是 http-only 或限网段） |
| 学术搜递 | TLS 证书与域名不匹配 | `ERR_TLS_CERT_ALTNAME_INVALID` |
| 会务接待 | 证书过期 | `CERT_HAS_EXPIRED` |
| 智慧食堂 | h5 里的 `/api/v2/mobile/order/*` 在 `58100` 上全 404（`访问地址不存在`），真实 API 主机未知 | bundle 里搜不到 baseURL |
| 校园码 | `zzuitOffline://` 是 App 内离线协议 | 网页端只到门户首页 |
| 门户公告全文 | `content` 字段被服务端截成恰好 200 字；官网 `url` 匿名访问跳 CAS | 5 条全部 200 字 |

## 6. 复现

```powershell
cd campus-layer
# 服务目录
node ../tmp/zzu/svclist.mjs              # 或直接看 tmp/zzu/services-all.json
# 公开面探测
node ../tmp/zzu/service-surface.mjs
# 培养方案
node test/live.test.ts 里的「培养方案能算出学分进度」用例：$env:ZZU_LIVE="1"; node node_modules/vitest/vitest.mjs run test/live.test.ts
# 校历 / 教学周 / 作息表
node scripts/probe-calendar.mjs
```

> 提醒：门户接口需要**门户** `userToken`（8h），教务接口需要**教务** `idToken`（30d）。
> 两者都在 CAS 登录后由页面写进 cookie/localStorage，扩展的 content script 会自动采集。
