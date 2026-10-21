# 郑大校园 IT 平台结构解析（豫见郑大 + 教务 jwxt）

> 实测日期：2026-10-20
> 目标：回答两个问题 —— ①这个学生服务平台是什么结构？②为什么网页版和 App 看起来是同一套东西？
> 结论：**同一个厂商（上海树维 Supwisdom「DICE / 超级 APP」）的「一云多端」产品，一套 uni-app H5 前端跑在 N 个域名下，App 只是个 WebView 外壳，身份由 CAS 统一签发 idToken 在 URL 里传递。**

---

## 1. 一句话结构

```
                        ┌──────────────────────────────┐
                        │  CAS 身份中心 cas.s.zzu.edu.cn │  ← 签发 idToken（JWT, RS512）
                        └───────────────┬──────────────┘
              ① ?idToken=<JWT> 放进任意接入方的 URL
        ┌───────────────────────┼───────────────────────────┐
        │                       │                           │
┌───────▼─────────┐   ┌─────────▼──────────┐   ┌────────────▼─────────────┐
│ 豫见郑大 门户     │   │ 教学管理平台 jwxt   │   │ 各业务微前端（同域）        │
│ uniapp.s.zzu     │   │ jwxt.zzu.edu.cn    │   │ /eams-*-app/index.html   │
│ .edu.cn          │   │ /uniapp/index.html │   │ 成绩/考试/课表/空教室/校历… │
└───────┬─────────┘   └─────────┬──────────┘   └────────────┬─────────────┘
        │ portal-api             │ eams-door（门面 BFF）      │ eams-micro-server（单一 BFF）
        ▼                        ▼                           ▼
 info.s.zzu.edu.cn      jwxt.zzu.edu.cn/eams-door    jwxt.zzu.edu.cn/eams-micro-server
（CMS/日程/服务目录）      （首页聚合：待办/通知/服务）    （全部教务业务 API）
```

**一句话**：门户和教务是**两个入口、同一套身份、同一套前端技术栈、同一族后端服务**。门户负责「聚合与资讯」，教务负责「教学业务」，CAS 负责「你是谁」。

---

## 2. 为什么网页版和 App「近乎一套东西」

因为**它们就是同一份代码**。这不是巧合，是这类产品（树维「超级 APP」，官方描述为「一云多端」）的架构选择：

| 层面 | 事实（实测） | 含义 |
|---|---|---|
| 前端技术 | 两边都是 **uni-app（Vue 2 + webpack）H5 SPA**，构建产物结构完全一致：`index.html`(1 KB 壳) + `chunk-vendors.<hash>.js` + `index.<hash>.js`，路由是 hash 模式 `#/pages/...` | 同一套源码，可能只是不同构建产物 |
| 入口 | 门户 `/pages/tab/service/index`；教务 `/uniapp/index.html` 后跟 `#/pages/tab/main/main` | 都是「tab 壳 + 页面栈」，App 里的底部导航（首页/日程/待办/消息/我的）就是这套路由 |
| App 是什么 | 一个**原生壳 + WebView**，加载的就是这些 H5 URL；壳只提供原生能力（推送、扫码、定位、离线包） | 网页能看到的，App 里是同一个页面，反之亦然 |
| 差异化方式 | 请求头 `X-Terminal-Info: h5 / app / wechat`、`X-Device-Info` | 同一份前端靠请求头区分渠道，而不是靠两套代码 |
| 主题/语言 | `superApp-userConfig?type=theme / language` 服务端下发 | 多租户/多校复用同一套 UI |
| 复用痕迹 | 教务前端的默认配置里还留着**厂商自己的测试地址**：`http://172.18.255.236:8093/grade/api/v1`、`https://app.supwisdom.com/exam/api/v1`、`http://jw.ahnu.edu.cn/cas/login`（安徽师大） | 一套代码卖多校，郑大只是部署实例 |
| 更早的痕迹 | idToken 里 `req: com.lantu.MobileCampus.nwpu`（西北工业大学包名） | 连 App 包名都是从别的学校模板改的 |

所以「网页和 App 是一套东西」的准确表述是：**一套 uni-app 前端 × 多渠道容器（浏览器 / App WebView / 微信） × 一套 BFF**。你看到的 App 界面，本质是一个全屏浏览器。

---

## 3. 身份：idToken 是唯一钥匙（实测）

```
CAS 登录 → 回调把 JWT 塞进 URL：?idToken=<JWT>
   ↓ 前端（uni.setStorage / cookie）
localStorage: token_key / idToken / X-Id-Token
cookie:       X-Id-Token=<JWT>
   ↓ 每个请求
Header: X-Id-Token: <JWT>   （+ X-Terminal-Info, X-Device-Info）
```

JWT claims（实测）：

| claim | 值 |
|---|---|
| `iss` | `cas.s.zzu.edu.cn` |
| `userNo` / `sub` / `accountName` | 学号 |
| `name` / `userName` | 姓名 |
| `identityTypeCode` / `Name` | `S02` / 本科生 |
| `organizationId` / `Code` | `350` |
| `organizationName` | 计算机与人工智能学院、软件学院、国家超级计算郑州中心 |
| `deviceId`、`jti` | 设备/令牌标识 |
| `iat` → `exp` | **30 天**（2592000 s） |

对比：门户自己发的 `userToken` 只有 **8 小时**（`X-Id-Token` 同一套头），而 CAS 这张 idToken 是 **30 天**。两者结构相同（同一个 `iss`），但门户那张是「门户会话 token」，教务这张是「CAS 长效 token」。

**关键性质（对扩展极重要）**：token 走 header，不走 cookie 鉴权；服务端返回 `Access-Control-Allow-Origin: *`。所以**任何能拿到 token 的客户端都能直连所有 API**，不需要浏览器上下文、不需要同源 cookie、不需要解析 DOM。

**安全提示**：`?idToken=` 放在 URL 里，会进浏览器历史、可能进 Referer；且 30 天有效。扩展里若要保存，应存 `chrome.storage.session` 或至少不落日志。

---

## 4. 教务（jwxt）的详细结构

### 4.1 三层

```
jwxt.zzu.edu.cn/uniapp/index.html          ← ① 超级 APP 壳（1022 B），title「教学管理平台」
        │  调 /eams-door/api/v1/*          ← ② 门面 BFF：首页聚合
        ▼
jwxt.zzu.edu.cn/eams-micro-server/api/v1/* ← ③ 业务 BFF：教务全部数据
        ▲
        │  各微前端独立 SPA（点服务 → 打开一个 index.html）
jwxt.zzu.edu.cn/<service>-app/index.html
```

- ① 壳的构建产物：`/uniapp/static/js/chunk-vendors.1b95dae0.js`（727,777 B）+ `/uniapp/static/js/index.fb0cf6d5.js`（135,988 B）。
- ③ 每个微前端都有自己的 `index.html` + 自己的 `chunk-vendors`，但都指向**同一个** `eams-micro-server`。即「多前端、单后端」。
- 旧入口 `jwxt.zzu.edu.cn/` → 301 → `/eams`，但 `/eams` 现在 404（老版 EAMS 网页入口已下线，只剩这套移动端 H5）。

### 4.2 门面 BFF：`/eams-door/api/v1/*`（实测全部 200）

| 端点 | 数据 |
|---|---|
| `portal/home/user-info` | 姓名、学号、身份 `STUDENT`、`firstLogin` |
| `protal-schedule/getSchedules` | 日程（按日期分组，含 `place`、`context`、`startTime`、`weekIndex`） |
| `protal-notice/get-notices` | 教务通知（含 HTML `content`、发布部门、阅读数） |
| `service/myServices/list`、`service/myServices/tea-std-list` | 我的服务（含 `serviceUrl`，即微前端地址） |
| `service/list-app?keyWord=` | 全部服务（按标签分组） |
| `service/label/list` | 标签：学籍/培养方案/选课/考试/成绩/评教/教材/课表/公共查询/课程 |
| `todo/getTodos` | 待办 + 计数 |

### 4.3 全部服务清单（决定「能做什么」）

| 标签 | 服务 | 微前端地址 | permCode |
|---|---|---|---|
| 学籍 | 学籍信息查询 | `/eams-student-status-app/` | `for-std-status-info` |
| 培养方案 | 培养方案完成情况 | `/eams-student-plan-complete-app/` | `for-std-completion-program` |
| 选课 | 选课 | `/course-selection/` | `for-std-course-selection` |
| 考试 | **考试查询** | `/eams-exam-student-app/` | `for-std-my-exam` |
| 成绩 | **成绩查询** | `/eams-student-grade-app/` | `for-std-my-grades` |
| 成绩 | 学业预警查询 | `/eams-study-precaution-search-app/` | `for-std-academic-warning` |
| 课表 | **课表查询** | `/eams-student-course-table-app/` | `for-std-my-schedule` |
| 公共查询 | 全校开课查询 | `/eams-lesson-search-app/` | `for-std-class-inquiry` |
| 公共查询 | **校历** | `/eams-school-calendar-app/` | `for-std-school-calendar` |
| 公共查询 | **空闲教室查询** | `/eams-room-occupy-app/` | `for-std-free-classroom` |
| 课程 | 教室课表 | `/eams-room-course-table-app/` | `for-std-room-course-table` |

### 4.4 业务 BFF 实测端点：`/eams-micro-server/api/v1/*`

**学期与周次（解决了「教学周首周日期」缺口）**

| 端点 | 实测返回 |
|---|---|
| `GET /semester/current-semester` | `{id:194, code:"2026-2027-1", startDate:"2026-09-07", endDate:"2027-01-17", weekIndices:[1..19], season:"AUTUMN"}` |
| `GET /semester/std-semesters` | 18 个学期（含历史） |
| `GET /semester/bizType-semesters?bizTypeId=2` | 同上（`bizTypeId` 必填，缺则 500） |
| `GET /semester/current-week/194` | `7` |

**课表**

| 端点 | 实测 |
|---|---|
| `GET /lesson/student/course-table/{semesterId}` | `194` → **153,957 B**，按课程返回：`campus`、`course{code,nameZh,credits,periodInfo{total,weeks,periodsPerWeek}}`、`code`、`bizTypeId`、`cultivateType` 等 |
| `GET /system/course-units` / `POST /system/week-indices-digest` | 节次单元 / 周次摘要（POST） |
| `GET /lesson/student/class-mates-exp?code=` | 同班同学（`code` 必填） |

**成绩 / 考试**（接口通，本账号数据为空：大一无成绩、学期中无考试）

| 端点 | 实测 |
|---|---|
| `GET /grade/student/grades` | `{"result":0,"data":[]}` |
| `GET /grade/student/gpa-rank` | `{total:null, flag:false, gpa:null, rank:null}` |
| `GET /grade/cultivateTypes` | `[{nameZh:"主修", code:"01"}]` |
| `GET /exam/student/exam` | `{"result":0,"data":[]}` |

**空闲教室（推翻了「无数据源」的结论）**

| 端点 | 说明 |
|---|---|
| `GET /room/place/campus` | 主校区/南/北/… |
| `GET /room/place/roomTypes` | 普通教室/多媒体/制图室/… |
| `GET /room/place/building?campusAssoc=` | 教学楼（19,978 B） |
| `GET /room/place/floors` | `[1..20]` |
| `GET /room/system/course-units` | 节次表，含 `startTime: 800 / endTime: 845` 等整数时间 |
| `POST /room/place/rooms` | 教室分页列表（实测 30 条/页，10,226 B） |
| `POST /room/place/room-occupancy` | **占用明细**（按日期，实测 3,316 B） |

`POST /room/place/rooms` 请求体（从页面 XHR 抓到的原样）：

```json
{"currentPage":1,"pageSize":30,"campusAssoc":null,"buildingIds":[],
 "roomTypeIds":[],"floors":[],"minSeat":"","maxSeat":"","date":"2026-10-21"}
```

`POST /room/place/room-occupancy` 最少只需：

```json
{"date":"2026-10-21"}
```

返回每条占用：`{roomName:"N202A", date, startTime:1010, endTime:1055, startTimeString:"10:10", activityType:"RoomBorrow", activityName:"活动名称：…", teacherName:"沈老师"}`。
**空教室 = 全部教室 − 占用**，两个接口一减就得到，不需要任何爬虫。

---

## 5. 对「校园信息层」扩展的影响（重写结论）

| 需求 | 上一版结论 | 现在 | 依据 |
|---|---|---|---|
| 课表 | ✅ 门户 getEvents | ✅✅ 双源：门户 `getEvents`（按日期实例化）+ 教务 `course-table/{semesterId}`（含学分/周次） | 实测 |
| 教室/教师 | ✅ 门户 `address`/`remark` | ✅ 门户 + 教务 `campus`/教室课表更规整 | 实测 |
| 学期首周日期 | ⚠️ 缺（`semester` 空串） | ✅ `current-semester.startDate = 2026-09-07`，`weekIndices 1..19` | 实测 |
| 成绩 | ❌ | ✅ `grade/student/grades`（接口通，数据待期末） | 实测 |
| 考试安排 | ❌ | ✅ `exam/student/exam`（同上） | 实测 |
| **空教室** | ❌ 无数据源 | ✅ `room/place/rooms` + `room-occupy` 相减 | 实测 |
| 校历 | — | ✅ `eams-school-calendar-app` | 服务清单 |
| 通知 | ⚠️ 200 字截断 | ⚠️ 门户仍是 200 字；**教务 `protal-notice/get-notices` 返回完整 HTML `content`** | 实测 |
| 公告全文 | ❌ | ⚠️ 教务处自己的通知全文可得；学校官网新闻仍不可得 | 实测 |

**重要**：教务这套需要的是**教务系统权限**（`permCode` 形如 `for-std-my-grades:micro-server`）。当前账号学生身份可以全部访问，但 token 来自 CAS，**扩展要能同时拿到「门户 token」和「教务 token」**——两者是不同域的不同 token（门户 8h，教务 30d），不能互相替代。

### 扩展需要的 host_permissions（收敛后）

```
https://cas.s.zzu.edu.cn/*            # CAS（可选，仅登录跳转）
https://uniapp.s.zzu.edu.cn/*         # 门户前端（读 cookie 取 userToken）
https://info.s.zzu.edu.cn/*           # 门户 BFF
https://authx-service.s.zzu.edu.cn/*  # 身份
https://message-service.s.zzu.edu.cn/*# 消息（可选）
https://transaction.s.zzu.edu.cn/*    # 待办（可选）
https://jwxt.zzu.edu.cn/*             # 教务（eams-door + eams-micro-server + 微前端）
```

---

## 6. 这套架构的「性格」（做扩展时要记住）

1. **一套前端、多入口、多服务**：改一个域名下的路径，往往能在另一个域名下找到同构实现（例如 `/uniapp/static/js/index.*.js` 在门户和教务都存在）。
2. **微前端各自为战**：成绩/考试/课表/空教室是**独立 SPA**，彼此不共享运行时；但共享同一个 BFF，所以 API 风格一致（`{result:0, data:...}` 或 `{code:0, data:...}`，注意**两种包装混用**）。
3. **错误码不统一**：门户是 `{code:-1,message:"没有访问权限01"}`；教务是 Spring 原生 `{status:500,error:"Internal Server Error",...}` 或 `{result:0}`。**判定登录态要按业务字段，不能只看 HTTP 200**。
4. **参数校验很硬**：缺参数直接 500（`MissingServletRequestParameterException`），不会给你友好提示；这反而是**探测利器**——400/404 说明路径不对，500 缺参说明路径对、参数差。
5. **厂商默认配置会泄漏内网地址**：`172.18.255.236:8093` 这类地址留在生产包里，说明是多校同一套代码 + 配置下发。
6. **app 与 web 的差异只在容器能力**：网页版拿不到推送/扫码，但业务数据一模一样。

---

## 7. 复现方式（本次用的手法）

1. 门户登录态页面内注入 JS 通道（`tmp/zzu/server.mjs` + 地址栏 `javascript:` 真敲），拿 `document.cookie` 里的 `userToken`。
2. 用 Node `fetch` 直连 `info.s.zzu.edu.cn`，验证矩阵。
3. 从门户里点「教务系统」→ 拿到 `https://jwxt.zzu.edu.cn/uniapp/index.html?idToken=<30d token>`。
4. 同一通道在 jwxt 页面执行 `performance.getEntriesByType('resource')`，一次拿到 `eams-door` 全部端点。
5. 下载每个微前端的 `index.html` → 找 `index.<hash>.js` → 读 webpack chunk map → 下载 page chunk → 正则抽 `/xxx` 路径 → 用 Node 直接打（404=路径错，500=缺参，200=通）。
6. 空教室的 POST 体是**在页面里 hook `XMLHttpRequest.prototype.open/send` 再点日期**抓到的（纯静态逆向拿不到，因为请求体在模板里拼）。

脚本都在 `tmp/zzu/`：`jwxt-shell.mjs`、`jwxt-door.mjs`、`micro-extract.mjs`、`room-api2.mjs`、`ct-probe.mjs`。
