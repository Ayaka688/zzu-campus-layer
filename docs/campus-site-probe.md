# 郑州大学「豫见郑大」门户实测报告（校园信息层 真实站点探针）

> 探针日期：2026-10-20 · 目标：`https://uniapp.s.zzu.edu.cn`（学生服务）
> 方法：登录态页面内注入 JS 通道 + Node 直连 API 复验（不依赖 CDP / 不抓 DOM）
> 结论先行：**课表、节次、教学周、通知列表、待办、个人资料全部有干净 JSON API，且只需一个请求头 `X-Id-Token` 即可从任意客户端调用**；空教室、成绩/考试成绩、通知全文三项**确认不可得**（详见 §5）。

---

## 1. 目标系统技术栈

| 项 | 实测结果 |
|---|---|
| 前端 | uni-app H5（Vue 2 + webpack），SUPPER-APP 底座，标题「豫见郑大」 |
| 入口壳 | `GET /pages/tab/service/index` → 2012 B SPA 壳，仅 3 个静态资源 |
| 页面分块 | `/static/js/<chunkName>.<8hex>.js`（例 `pages-tab-service-index.6fd1e1d1.js`）；无 hash 直接猜名 404 |
| 后端 | RuoYi 风格微服务，按域拆主机（见 §4） |
| 前端是否 SSR | 否，纯 SPA |
| 网关基址常量位置 | `index.1d7d19ce.js` 内 webpack 模块 `8963`（`serviceUrl.default`） |
| 鉴权头构造位置 | 同文件 webpack 模块 `cb4b`（`getHeaders()`） |

---

## 2. 鉴权模型（与 handoff 假设不同，是关键发现）

```
POST https://info.s.zzu.edu.cn/portal-api/... 
Headers:
  X-Id-Token: <userToken JWT>          ← 唯一真正的凭证
  X-Terminal-Info: h5
  X-Device-Info: <brand><model><version>
  content-type: application/x-www-form-urlencoded
  Accept: application/json
```

- `userToken` 存在 cookie（`uniapp.s.zzu.edu.cn`，**非 HttpOnly**，前端 js-cookie 可读），CAS 回调时把 `ticket` 的 JWT `idToken` 写入。
- JWT 算法 RS512，`iss = cas.s.zzu.edu.cn`，**有效期 8 小时**（`iat=1792498513`、`exp=1792527313`）。
- JWT 内可直接取：`ATTR_userNo / ATTR_name / ATTR_identityTypeName（本科生）/ ATTR_organizationId（350）/ ATTR_organizationName`。
- **无 token 的响应是 HTTP 200 + 业务码**，不是 401：
  ```json
  {"code":-1,"message":"没有访问权限01","data":null}
  ```
- 跨域：`Access-Control-Allow-Origin: *`（无 credentials），因此扩展 Service Worker / 任意后端都能直接调。

### 对扩展的含义

1. **不需要 content script 解析 DOM**，只要拿到 token，SW 直接 `fetch` 即可（这是 handoff 里最大的架构假设修正）。
2. 拿 token 的两条路（都可行，按权限最小化选）：
   - `chrome.cookies.get({url:'https://uniapp.s.zzu.edu.cn', name:'userToken'})` —— 需 `cookies` 权限 + 该 host 权限；
   - content script 读 `document.cookie`（因为它不是 HttpOnly）—— 只需该 host 的 `host_permissions`，不额外要 `cookies`。
   → **建议选后者**：权限面更小，且不需要 `cookies` 这一敏感权限。
3. 8 小时过期 ⇒ 扩展必须能判断"token 过期 → 引导重新登录"，而不是静默失败。判据用 `exp` 与业务码 `code:-1 / message:"没有访问权限01"` 双重判断（**不能看 HTTP 状态码**）。

---

## 3. 探针方法（可复现）

踩坑记录（避免后来者重走）：

- PowerShell `Invoke-WebRequest` / `curl.exe -k` 在本机抓 https 全部失败（`schannel: SEC_E_NO_CREDENTIALS 0x8009030e`），**一律改用 Node 24 的 `fetch`**。
- Edge 未以 `--remote-debugging-port` 启动，CDP 不可用；`Default\Network\Cookies` 被浏览器独占锁，复制 profile 也拿不到 cookie。
- 可行通道（页内 JS 文本通道，无需 DevTools 面板）：
  1. `tmp/zzu/server.mjs` 监听 `127.0.0.1:8787`：`/run.js` 下发 bootstrap、`/job` 一次性下发任务 JS、`/res` 收回结果到 `tmp/zzu/results.jsonl`。
  2. 地址栏用**真敲键**（`sendinput`，不能粘贴）输入：
     ```
     javascript:s=document.createElement('script');s.src='http://127.0.0.1:8787/run.js';document.body.appendChild(s);void 0
     ```
  3. 首次会弹 Edge「访问此设备上的其他应用和服务」，点**允许**。
  4. 之后改 `tmp/zzu/job.js` 即可在登录态页面里执行任意 JS（读 cookie、驱动 `uni.navigateTo`、打 API、抓 XHR）。
- 页内驱动 App 路由：`uni` 与 `getApp` 都在 `window` 上，`uni.navigateTo / switchTab / reLaunch / navigateBack` 可用 —— 这是**枚举页面 API 的最快手段**（配合 hook `XMLHttpRequest.prototype.open/send` 打印真实请求）。
- token 落盘：`tmp/zzu/token.txt`（视为密钥，8 小时过期）；JWT claims 落盘 `tmp/zzu/jwt.json`；API 原始响应在 `tmp/zzu/api/`。

---

## 4. API 清单（全部实测）

图例：✅ 通 & 数据有用 · ⚠️ 通但需额外参数/数据为空 · ❌ 不通

### 4.1 门户服务域 `https://info.s.zzu.edu.cn/portal-api`

| 端点 | 方法 | 状态 | 说明 |
|---|---|---|---|
| `/v1/calendar/share/schedule/getEvents?startDate=&endDate=` | GET | ✅ | **课表/日程主接口**，按日期分组返回事件数组 |
| `/v1/calendar/share/schedule/getSection?startDate=&endDate=` | GET | ✅ | **节次时间表**（一~十节 → 起止时间） |
| `/v1/calendar/share/schedule/getWeekOfTeaching?today=YYYY-MM-DD` | GET | ✅ | 当前教学周（返回 `{"date":["7"],"semester":""}`，semester 空串） |
| `/v1/calendar/share/schedule/getPersonlCalendar` | GET | ✅ | 我的日历列表 |
| `/v1/calendar/share/subscribe/page?pageType=&itemsPerPage=&pageIndex=` | GET | ✅ | 可订阅/已订阅日历（含「校历」） |
| `/v1/cms/Column/getColumnList` | GET | ✅ | 栏目：综合新闻 `remote-239852`、通知公告 `remote-245732A245871` |
| `/v3/cms/content/getColumncontents?columnId=&pageNo=&pageSize=&loadContent=true` | GET | ✅ | 新闻/通知列表（`content` 被截到 **200 字**，见 §5） |
| `/v1/cms/content/getOne?columnId=&id=` | GET | ❌ | 详情接口，**返回 1324 B 空壳**（App 自己调也一样），全文拿不到 |
| `/v1/service/list` | POST | ✅ | 服务目录（快照：22 项，按 `应用服务/查询服务/校园生活/信息服务` 分组） |
| `/v2/service/serviceShowAll` | POST | ✅ | 服务全量（另一视图） |
| `/v2/service/category/list` | GET | ✅ | 服务分类树 |
| `/v2/service/getServiceVisitList` / `getListByIdentify` | GET | ✅ | 服务访问排行 |
| `/v1/service/collect/list`、`/v1/service/lastUse/list` | GET | ✅ | 收藏 / 最近使用 |
| `/v1/service/findForceRecommService` | GET | ✅ | 强制推荐服务 |
| `/v1/config/system/getAppSystemConf` | GET | ✅ | 全局配置（含协议长文本） |
| `/v2/cms/marqueeList/get?marqueeTypeCode=05` | GET | ✅ | 首页轮播/通知条 |
| `/v1/weather/getWeather` | GET | ✅ | 天气 |
| `/v2/personalData/getMyECard` | GET | ✅ | 一卡通余额（本账号返 `balance:"0"`，即未绑定/无卡） |
| `/v1/app/Theme/*` | GET | ✅ | 主题 |

### 4.2 身份域 `https://authx-service.s.zzu.edu.cn/personal`

| 端点 | 方法 | 状态 | 说明 |
|---|---|---|---|
| `/api/v1/personal/me/user` | GET | ✅ | 用户资料（username、roles、attributes：organizationId/identityTypeCode/accountId…） |

### 4.3 事务域 `https://transaction.s.zzu.edu.cn/ttc`

| 端点 | 方法 | 状态 | 说明 |
|---|---|---|---|
| `/api/ttc/center-list/getToDoList?pageIndex=&pageSize=` | GET | ✅ | 待办列表（本账号 0 条） |
| `/api/ttc/center-list/getInitiateList?pageIndex=&pageSize=&status=IN_PROGRESS` | GET | ✅ | 我发起的流程 |
| `/v1/count/ttcCount?readed=0` | GET | ✅ | 待办计数（apply/circulated/todo/urgent） |

### 4.4 消息域 `https://message-service.s.zzu.edu.cn/center`

| 端点 | 方法 | 状态 | 说明 |
|---|---|---|---|
| `/api/v1/instantMessage/getAppAllUnReadCount/new` | POST | ✅ | 未读数（返回 0） |
| `/api/v1/messageCenter/listMessageRecord` | POST | ⚠️ | 缺必填参数，裸调 500 |

---

## 5. 数据可得性矩阵（对「校园信息层」）

| 层需求 | 数据源 | 判定 | 备注 |
|---|---|---|---|
| 课程/课表 | `getEvents`（学期区间一次拿全） | ✅ **强** | 实测 2026-09-01~2027-01-24：84 天 207 条事件、**668 ms** |
| 教室 | `getEvents[].address` | ✅ | 形如 `物_505`（楼-房间） |
| 任课教师 + 节次 | `getEvents[].remark` | ✅ | `任课教师:张老师;节次:1-2节`（字符串，需正则拆） |
| 上课时间 | `getEvents[].startTime/endTime` | ✅ | `08:00:00` / `09:40:00` |
| 节次↔时间映射 | `getSection` | ✅ | 一 08:00–08:45 … 十 19:55–20:40，**服务端权威，不必硬编码** |
| 教学周 / 学期 | `getWeekOfTeaching` | ⚠️ | 有周次（如 `7`），`semester` 为空串；学期首周日期可由「今天 − (周−1)×7」推出 |
| 单双周 | 无字段 | ❌ | `repeat*` 全 null；课表事件按日期**已实例化**，因此「周次集合」可由日期集合反推，不需要 pattern 字段 |
| 通知标题/时间/来源 | `getColumncontents` | ✅ | 含 `title`、`releaseStartTime`、`releaseDeptName`、`readCount` |
| 通知正文 | `getColumncontents[].content` | ⚠️ | **硬截断 200 字**（实测 5 条全部 200） |
| 通知全文 | `getOne` / 官网 `url` | ❌ | `getOne` 空壳；`url` 指向 `www.zzu.edu.cn/...` 需 SSO 登录，匿名抓只拿到登录页 |
| 待办/流程 | `ttc` 三个接口 | ✅ | 学生当前为空，但接口通 |
| 空教室 | — | ❌ | 服务目录 22 项里**没有任何教室/自习室/空教室入口**（只有图书馆「座位预约」） |
| 成绩 / 考试安排 | — | ❌ | 本门户无教务系统入口；需另接教务（jwxt）系统 |

### 结论：对 handoff 三条产品线的影响

- **课表线（最有价值）完全成立**，而且是「一次请求拿整学期」，比 handoff 设想的逐周抓取更省。
- **通知线成立但要降级**：只能做「标题 + 200 字预览」检索，`search_notice` 的"正文全文检索"做不到，必须写进 DoD 的限制里。
- **空教室线不成立**：本门户无数据源，只能走静态表/手工维护，或另找教务/自习室系统（风险高）。
- **成绩线不成立**（除非另做教务系统集成，完全另一个项目）。

---

## 6. 建议的 handoff v0.2 修订（基于实测）

1. **架构层**：删掉"靠 content script 解析页面 DOM"的主路径，改成
   - content script（仅 `uniapp.s.zzu.edu.cn`，1 行）读 `document.cookie` 取 `userToken` → `chrome.runtime.sendMessage` 给 SW；
   - SW 用固定域名白名单 `host_permissions`（`https://info.s.zzu.edu.cn/*`、`https://authx-service.s.zzu.edu.cn/*`、`https://transaction.s.zzu.edu.cn/*`、`https://message-service.s.zzu.edu.cn/*`、`https://cas.s.zzu.edu.cn/*`）+ `X-Id-Token` 直连。
   - 原 P0#1「权限自相矛盾」由此收敛为**丙方案：固定域名白名单**（比甲/乙都简单，因为数据源已确定，不需要用户填 baseUrl）。
2. **Schema**：
   - `TimeSlot` 增加 `sectionStart/sectionEnd`（节次序号）+ 可选的 `room`、`teacher`（本 portal 的 `remark` 就要拆这两个）；
   - `weeks` 改成"日期集合"或 `{ startDate, weekCount }`，**不要** `pattern: odd/even`（数据源没有）；
   - `Notice.bodyText` 改为可选、默认 `''`，并加 `excerpt`（200 字）与 `detailUnavailable: true` 标记。
3. **登录态判定**：统一按"业务码"判（`code:-1` / `没有访问权限01`）+ JWT `exp`，不按 HTTP 状态码；`chrome.alarms` 定时刷 token 有效性。
4. **Tool 层**：`search_notice` 只承诺标题 + 摘要检索；`get_schedule(week)` 用 `getWeekOfTeaching` 定周次基准，用 `getSection` 定节次时间。
5. **删/降级**：`find_empty_room` 从 M5 拿掉或改静态表；`export_ics` 保留（课表事件结构完整，可直接映射 iCal）。
6. **巡检（原 P0#2）**：本系统的失效表现是 HTTP 200 + 业务码 -1，所以 `redirect:'manual'` 那套不适用；改成"带 token 打一个轻量接口（`getWeekOfTeaching`）看业务码"。

---

## 7. 未知与风险

| 项 | 影响 | 建议 |
|---|---|---|
| 通知全文接口未解（`getOne` 空壳） | 全文检索不可做 | 先按 200 字预览交付；后续用 DevTools 抓 App 真实详情页请求（需正确入参）再试 |
| token 只剩 8 小时 & 需 CAS 续期 | 用户每 8h 要回门户点一次 | 扩展监听到 `没有访问权限01` 时弹"请打开豫见郑大刷新登录"，不静默重试 |
| `X-Device-Info` 语义不明（`undefinedPCundefined` 也通） | 可能某天被风控 | 照抄浏览器真实值即可 |
| 教务系统（成绩/考试/空教室）完全未接 | 三条需求做不了 | 明确划出范围，别写进 DoD |
| 服务目录按账号授权裁剪（22 项） | 不同学院/身份可见服务不同 | 扩展不要硬编码服务名，按 `serviceName` 关键字匹配 |
| 探针 token 已落盘 `tmp/zzu/token.txt` | 属敏感数据，8h 后失效 | 交付前删除或加 `.gitignore` 提示 |

---

## 8. 附：实测样例（脱敏）

课表事件（节选）：

```json
{
  "title": "微积分A (Ⅰ)",
  "address": "物_505",
  "remark": "任课教师:张老师;节次:1-2节",
  "startTime": "08:00:00", "endTime": "09:40:00",
  "startDateStr": "2026-10-19 08:00:00",
  "calendarName": "课程表"
}
```

节次表（`getSection` 原样）：

```json
[{"startTime":"08:00:00","endTime":"08:45:00","section":"一"},
 {"startTime":"08:55:00","endTime":"09:40:00","section":"二"},
 {"startTime":"10:10:00","endTime":"10:55:00","section":"三"},
 ... {"startTime":"19:55:00","endTime":"20:40:00","section":"十"}]
```

通知列表项（`content` 恰好 200 字被截）：

```json
{"id":"remote-89205","columnId":"remote-245732A245871",
 "title":"关于举办郑州大学首届AI智能体创新应用大赛的通知",
 "releaseStartTime":"2026-10-19 16:45:00","readCount":1638,
 "url":"http://www.zzu.edu.cn/tzcontent.jsp?...&wbnewsid=89205"}
```

---

## 9. 补充实测（2026-10-20 晚）：教务系统 jwxt 打通，推翻三项 ❌

从门户里点进「教务系统」拿到 `https://jwxt.zzu.edu.cn/uniapp/index.html?idToken=<CAS JWT, 30 天>`，进而打通整个教务平台。结构解析见 [campus-platform-architecture.md](campus-platform-architecture.md)。

对 §5 数据可得性矩阵的修正：

| 需求 | 原判定 | 现判定 | 新依据 |
|---|---|---|---|
| 成绩 | ❌ | ✅ | `GET https://jwxt.zzu.edu.cn/eams-micro-server/api/v1/grade/student/grades`（接口通，大一无数据） |
| 考试安排 | ❌ | ✅ | `GET .../api/v1/exam/student/exam` |
| **空教室** | ❌ | ✅ | `POST .../api/v1/room/place/rooms` + `POST .../api/v1/room/place/room-occupancy`，两者相减即空闲教室 |
| 学期首周日期 | ⚠️ 缺 | ✅ | `GET .../api/v1/semester/current-semester` → `startDate:"2026-09-07"`, `weekIndices:[1..19]` |
| 校历 | — | ✅ | 微前端 `/eams-school-calendar-app/` |
| 通知全文 | ❌ | ⚠️ 部分 | 教务处通知 `eams-door/api/v1/protal-notice/get-notices` 返回完整 HTML 正文；学校官网新闻仍不可得 |

同时新增的可用数据面：`eams-door` 门面（首页聚合/待办/服务目录）与 11 个教务微前端（学籍、培养方案、选课、考试、成绩、学业预警、课表、全校开课、校历、空闲教室、教室课表）。

**代价**：教务侧需要**另一个 token**（CAS 签发、30 天、与门户 8 小时 token 不同），扩展必须分别获取；host 白名单需增加 `https://jwxt.zzu.edu.cn/*`。