# 新教务 X-Id-Token 的长期票链路（纯 Node，2026-10 实测）

> 结论先说：**jwxt 新教务 `/student/` 自己的账号登录对本科生账号是死的**（一律 `login_first`），
> 长期票只能走 CAS。CAS 在本环境强制双因子，所以「完全无人值守」不可能，但可以做到
> **人工只碰一次手机短信/扫码（2 分钟），之后 14 天内全靠 `scripts/cas-ticket.mjs` 一条 HTTPS 静默续**。
>
> - CAS 的 `TGC` cookie：`Max-Age=1209600`（14 天），登录时勾 `rememberMe=on` 才发。
> - 它换出来的 `idToken`：**8 小时**（H5 service 只签 8h；30 天票是原生 App 绑定设备才有的，见 §5）。
> - 换票本身不刷新 TGC 的过期时间（服务端不滑窗）→ 14 天后必须重新 `cas:login`。
>
> 脚本：`scripts/cas-login.mjs`（一次性登录）、`scripts/cas-ticket.mjs`（静默换票）、
> 状态目录 `.cas-state/`（已 gitignore）。`npm run cas:login` / `npm run cas:ticket`。

---

## 1. 走不通的路（先看这个，省几小时）

### 1.1 新教务 `/student/` 本地账号登录 → `login_first`

页面本身是树维新一代（vue + sw-ui + requirejs），逻辑在
`/student/static/authc-local/main.js?v=1.0.4`，提交只有三步：

```js
// GET /student/login-salt → 裸 UUID 字符串（36 字符，无引号），例：79db6b90-c620-49c1-9355-82a6f5409532
encryptPassword = new String(CryptoJS.SHA1(salt + '-' + password)) + '';
// POST /student/login  (application/json)
{ username, password: encryptPassword, captchaToken }
// 成功：{ result: true }  → 跳 CONTEXT_PATH + "/home"
```

实测（学号 202615020223，密码已在 CAS 侧验证正确）：

| 输入 | 响应 |
| --- | --- |
| 正确密码 | `{"result":false,"message":"login_first","needCaptcha":true}` |
| 故意错的 sha1 | `{"result":false,"message":"login_first","needCaptcha":true}` |

**决定性对照**：错密码也回 `login_first` → 这是按账号状态的预检查，与密码无关。
该分支前端会 `toPasswordModify()` 跳到 `https://jwxt.zzu.edu.cn/security-center/password-modify?flag=1`，
需要「学号 + 姓名 + 证件号」做身份校验并真的改密码（有副作用），所以此路不通。

附带事实：登录页 `data.ssoLinkList = [{'entiry':''}]`（空）→ `/student` **没有**统一身份认证入口；
假密码第一次尝试就回 `needCaptcha:true`（页面初始 `NEED_CAPTCHA=null` 不显示滑块）→ 想硬试也没第二次机会。

### 1.2 CAS 密码直登 → 被 MFA 拦

```text
GET  https://cas.s.zzu.edu.cn/cas/login?service=…   → 302 /cas/a/login?service=…（133 KB 页面）
GET  https://cas.s.zzu.edu.cn/cas/jwt/publicKey     → PEM 公钥
POST /cas/a/login  username&password=__RSA__(RSA_PKCS1_PADDING)&rememberMe=on&execution=…
```
只交密码时：200 + 新 `execution`，**无 Set-Cookie、`failN` 仍 -1、无 loginError** → 不报错也不放行，
必须过 `/cas/mfa/detect`（`need:true` 且 `mfaTypeSecurePhone/mfaTypeQrCode` 为 true）。
三个不同 `fpVisitorId`（空 / 两个假值）都 `need:true` → **MFA 与设备指纹无关，强制**。

### 1.3 `/cas/qr/*` 已被 nginx 封

`/cas/qr/qrcode`、`/cas/qr/comet`、`/cas/qr/generator.png` 一律 403（548 B nginx 页），
换 Python/HTTP2/JSON 头/带 SESSION 全一样；对照 `/cas/captcha.jpg` 200。
→ 这是旧版直连 QR 接口，真正的扫码在 `/attest` 域（§3.3）。

### 1.4 浏览器自动化在本机不可用（DSH 沙箱）

`msedge --headless=new --remote-debugging-port=…` 启动即崩，stderr：

```text
crashpad_client_win.cc:457 OpenProcess: 拒绝访问 (0x5)
FATAL:mojo\public\cpp\platform\platform_channel.cc:187 Check failed: . : 拒绝访问。 (0x5)
Failed to grant sandbox access to cache directory …\Default\Cache\Cache_Data: 拒绝访问
```

沙箱禁止子进程建命名管道 → mojo 初始化失败 → 进程直接退出（`DevToolsActivePort` 永不生成）。
用户的 Edge profile cookie 库也被运行中的 Edge 独占锁住，取不出既有 CASTGC。
**所以本文全部走纯 HTTP。**

---

## 2. CAS 双因子完整协议（全 HTTP，无浏览器）

```text
1) GET  /cas/login?service=<SERVICE>            → 页面里的 execution + SESSION
2) GET  /cas/jwt/publicKey                      → 公钥（PKCS#1 v1.5，加密后加前缀 __RSA__）
3) POST /cas/mfa/detect   (form)  username, password=__RSA__…, fpVisitorId=
        → {"code":0,"data":{need:true, mfaTypeSecurePhone:true, mfaTypeQrCode:true,
           mfaTypeOtp:false, mfaTypeAppPush:false, mfaTypeFaceVerify:false, state:"l7WwX8"}}
        密码错时 need:false（这就是判断密码对不对的探针）
4) GET  /cas/mfa/initByType/<type>?state=<state>   type ∈ apppush|securephone|secureemail|qrcode|faceverify
        → {"code":0,"data":{gid:"…", securePhone:"195****7500", attestServerUrl:"https://cas.s.zzu.edu.cn/attest"}}
```

### 2.1 安全手机短信（本机首选，实测走通）

```text
POST {attest}/api/guard/securephone/send   {"gid":"…"}      → {"code":0,"data":{"result":"ok"}}
POST {attest}/api/guard/securephone/valid  {"gid":"…","code":"9593"}
     → {"code":0,"data":{"result":"ok","status":2}}         status==2 即通过（500 ms 后页面 submitFm1）
```
验证码 60 秒倒计时；`code!=0 && data.result=='expired'` 时重新 `initByType` 取新 gid。

### 2.2 客户端扫码（豫见郑大 App）

```text
GET  /cas/mfa/initByType/qrcode?state=<state> → gid + attestServerUrl
POST {attest}/api/guard/qrcode/send  {"gid":…}
     → {"code":0,"data":{result:"ok", callbackCode:"1751",
        scanQrcode:"https://cas.s.zzu.edu.cn/attest/api/guard/qrcode/open/scanQrcode/<gid>/<code>.png"}}
     ← 服务端直接给 QR PNG 的 URL，GET 下来就是 256×256 二维码（不用自己渲染）
POST {attest}/api/guard/qrcode/status {"gid":…} → {"data":{"status":1,"statusCode":"SENT"}}
     status: 0 init / 1 sent / 2 valid(手机已确认) / 3 fail / 5 cancel / 8 scaned / 9 expired
```
二维码约 3~5 分钟过期，失效会换新图。**注意**：反复开新 login 会话会把旧 gid 顶掉，
手机上会报「guardToken 已无效」——每轮只留一个会话。

### 2.3 通过后提交表单（拿 ticket）

```text
POST /cas/a/login?service=<SERVICE>   （表单字段）
  username, password=__RSA__…, captcha=(空), rememberMe=on, currentMenu=1, failN=-1,
  mfaState=<detect 的 state>, execution=<登录页里的>, _eventId=submit, geolocation=(空), fpVisitorId=(空)
  → 302 Location: <SERVICE>?ticket=<JWT>
```
`Set-Cookie` 会一次性下发 `TGC`（14 天）+ `CAS_TRACE_ID` + `SESSION`。

---

## 3. 关键发现：哪个 service 才给 JWT ticket

同一个 TGC，`/cas/s/login?service=…` 的返回完全取决于 service：

| service | ticket |
| --- | --- |
| `https://uniapp.s.zzu.edu.cn/` | **JWT** len≈2160，`payload.idToken` 就是 X-Id-Token |
| `https://ehall.s.zzu.edu.cn/` | **JWT** len≈2156（同样 8h） |
| `https://jwxt.zzu.edu.cn/`（含 `/student/`、`/uniapp/index.html`） | 普通 `ST-…` len=41（CAS 属性 XML 用，可过 `/cas/serviceValidate`，**不是** JWT） |
| `com.lantu.MobileCampus.nwpu`、`zzuitOffline://zzu.edu.cn`、`portal.s` / `my.s` / `m.s` / `app.s` | 200 无 ticket |

JWT ticket 的 payload 键：`identityTypeCode, aud, sub, organizationCode, iss, idToken, lang, exp, iat, jti`
（`iss=https://cas.s.zzu.edu.cn/cas`、`aud=https://uniapp.s.zzu.edu.cn/`）。
`idToken` 是 RS512，claims 全 `ATTR_` 前缀：`ATTR_userNo / ATTR_accountName / ATTR_name / ATTR_organizationId / ATTR_uid / ATTR_accountId / ATTR_userId / ATTR_identityTypeCode`。

**换票的最小 cookie 集（实测）**：

| Cookie | 结果 |
| --- | --- |
| `TGC` 单独 | ✗ 被打回 `/cas/a/login` |
| `TGC + SESSION` | ✗ 同样被打回 |
| `TGC + CAS_TRACE_ID` | ✓ 拿到 JWT ticket |
| `TGC + CAS_TRACE_ID + SESSION`（全量） | ✓ |

所以脚本里三个都带上，别只存 TGC。

---

## 4. 验证：eams-door 认这张票

```bash
curl -H "X-Id-Token: <idToken>" https://jwxt.zzu.edu.cn/eams-door/api/v1/portal/home/user-info
# 200 {"result":0,…"data":{"user":{"nameZh":"…"},"account":"202615020223",
#      "defaultIdentity":"STUDENT","identity":"STUDENT","firstLogin":true,…}}
```
同路径打 `eams-micro-server` → 404（那个域名只吃别的路径）。cookie-only（不带 X-Id-Token）→ 401。

---

## 5. 为什么拿不到 30 天票（诚实记录）

> **已解开，见 §10**：30 天票不在这套 `/cas/` 端点上，而在学校 App 用的 `/token/` 端点族里
> （`/token/password/passwordLogin`）。下面这段保留为「从 `/cas/` 侧尝试过什么」的记录。

仓库里那张历史 30 天票（`tmp/zzu/jwxt-token.txt`）与 H5 票的差异：

| | H5 票（uniapp.s / ehall.s） | 历史 30 天票 |
| --- | --- | --- |
| ttl | 8.0 h | **30 天**（2592000 s） |
| `req` | `https://uniapp.s.zzu.edu.cn/` | `com.lantu.MobileCampus.nwpu` |
| `deviceId` | 无 | `28b9d2e2-…` |
| `jti` 前缀 | `ID-Token-…` | `Id-Token-…` |

即 30 天票 = 原生 App 注册设备后签发的。已探测但没有出口：

- `GET /cas/jwt/device`、`/cas/jwt/device/register`、`/cas/jwt/devicetoken`、`/cas/device(/register)`、
  `/cas/api/device`、`/cas/mfa/device` → 全 404 JSON（Spring 默认 404 体）。
- 换票时附 `&deviceId=<uuid>` 或 `&clientId=web` → 仍是 8.0h、`deviceId` 依旧为空（参数被忽略）。
- `com.lantu.MobileCampus.nwpu` 作为 service 直接换取票返回 200 无 ticket（自定义 scheme 不是可跳转 service）。
- `/cas/oidc/*` 存在（issuer `https://cas.s.zzu.edu.cn/cas/oidc`，`claims_supported` 含 `idToken`），
  但要先 `/cas/oidc/register` 注册客户端，未继续；若将来需要更长的票，这是下一个该看的门。

---

## 6. 运维姿势

```powershell
# 一次性（14 天内只需一次）：短信模式
$env:ZZU_USER='2026150xxxxx'; $env:ZZU_PASS='…'
npm run cas:login
#   脚本打印「短信已发送到 195****7500」，把验证码写入 .cas-state/sms-code.txt 即可
#   扫码模式：npm run cas:login -- --qrcode → 二维码落在 .cas-state/cas-qr.png

# 之后：换票（idToken 8 小时，每 ~7 小时跑一次就永远新鲜）
npm run cas:ticket
#   输出 idToken 到 .cas-state/cas-idtoken.txt，meta 到 .cas-state/cas-meta.json
```

- 也可以把 `{"username":"…","password":"…"}` 写进 `.cas-state/creds.json`（已 gitignore）。
- `cas-ticket.mjs` 可被 import：`mintIdToken()` / `verifyIdToken()` / `ensureIdToken()` / `tgcStatus()`。
- TGC 14 天硬过期，且服务端**不滑窗**（换票响应里没有新的 `Set-Cookie: TGC`）→ 到期必须重登。
- 重登会顶掉老的 `state`/`gid`：别同时开两个登录会话。

---

## 7. 这张票能覆盖哪些站点（实测矩阵）

同一张 `idToken`（8 小时）同时是**新门户、新教务数据面**的钥匙；老门户前端也读同一个
`localStorage.token`。

| 站点 / 接口 | 鉴权方式 | 无票 | 带 `X-Id-Token` | 备注 |
| --- | --- | --- | --- | --- |
| `https://info.s.zzu.edu.cn/main.html`（新门户 SPA） | `X-Id-Token`（读 `localStorage.token`） | — | 页面可进 | 前端直接拿 token 打 `/portal-api/*` |
| `info.s.zzu.edu.cn/portal-api/diversion/getUserDiversionList?terminal=1` | `X-Id-Token` + `X-Terminal-Info: PC` | `{"code":-1,"message":"没有访问权限"}` | `{"code":0,"message":"查询成功","data":[]}` | 现成的最小验票探针 |
| `jwxt.zzu.edu.cn/eams-door/api/v1/portal/home/user-info` | `X-Id-Token` | 401 `Token 失效` | 200 + 用户信息 | 新教务 / 老教务的数据面 |
| `jwxt.zzu.edu.cn/uniapp/index.html?idToken=…`（老教务） | URL / localStorage | — | 可进 | 也可以传 `?ticket=ST-…` |
| `uniapp.s.zzu.edu.cn/pages/tab/index/index`（老门户） | 同上 | — | 可进 | SPA 对未知 API 一律回 HTML，别用 404 判断 |
| `jwxt.zzu.edu.cn/student/home`（新教务页面本体） | **cookie 会话** | 302 登录页 | 302 登录页 | 不吃 CAS 票，见 §1.1 |

→ 结论：**一张 8 小时 idToken 通吃新旧门户 + 教务数据面**，不需要为每个站点单独登录。
唯一例外是新教务 `/student` 的页面会话（树维本地账号，本科生 `login_first`），它本来也不接受 CAS。

---

## 8. 不用 cron：按需换票（安卓/移动端首选）

手机上的定时任务会被 Doze、厂商省电、网络切换打断，「每 7 小时刷一次」在安卓上不可靠。
正确姿势是**用时才换**：TGC 存在文件里，谁需要票谁先 `ensureIdToken()`。

```js
import { ensureIdToken, tgcStatus } from './scripts/cas-ticket.mjs';

const { idToken, reused } = await ensureIdToken({ maxAgeH: 6.5 });
// meta.mintedAt 距今 < 6.5h 且 exp 余量 > 1h → 直接复用缓存票（0 请求）
// 否则静默换票（1 个 HTTPS 往返，~300 ms）
```

TGC 死了会抛带 `needsLogin: true` 的错误，CLI 对应退出码 **3**，调用方看到就提示「该重新短信验证一次」。

```powershell
node scripts/cas-ticket.mjs --if-stale=6.5 --verify   # 幂等：新鲜就复用，过期才换
node scripts/cas-ticket.mjs --json                    # 给别的程序吃
node scripts/cas-ticket.mjs                           # 打印 TGC 剩余寿命
```

实测输出（`.cas-state` 完好时的第二次调用）：

```text
reuse（缓存票还新鲜，剩 8h） · idToken len 1278 · exp 2026-10-28T13:03:09.000Z
TGC 剩余 335.7h（2026-11-11T04:48:15.000Z）
```

要点：

- **人工介入频率 = TGC 的 14 天**，不是 8 小时。8 小时只是单张票的寿命，换票免费。
- `cas-meta.json` 里记 `tgcExpiresAt`（来自登录时 `TGC` 的 `Max-Age=1209600`）；
  `tgcStatus()` 在剩余 < 24 h 时返回 `stale: true`，可以在 UI 上提前提示「该重登了」。
- 设备休眠多久都没关系：醒来第一次调用会缓存过期检查 → 换票 → 继续。
- 想让多台设备共用：把 `.cas-state/` 整个目录拷过去即可（≤ 3 K，纯 cookie + token，无设备指纹绑定；
  实测换票不校验客户端指纹，`fpVisitorId` 只在 MFA 登录那一步有用）。

---

## 9. 文件与命令一览

| 路径 | 作用 |
| --- | --- |
| `scripts/cas-login.mjs` | 一次性人工登录（短信 / `--qrcode`），产出 `.cas-state/cas-jar.json` + `cas-meta.json`（含 `tgcExpiresAt`） |
| `scripts/cas-ticket.mjs` | TGC → JWT ticket → `idToken`；`ensureIdToken()` 按需换票、`tgcStatus()` 看 TGC 寿命；`--if-stale=6.5` / `--force` / `--verify` / `--json`；退出码 3 = TGC 死了该重登 |
| `.cas-state/` | `cas-jar.json` / `cas-ticket.txt` / `cas-idtoken.txt` / `cas-meta.json` / `sms-code.txt` / `cas-qr.png`（整个目录可拷到别的设备用） |
| `src/core/casMint.ts` | 浏览器内的**一条 fetch 换票**（`mintViaFetch()`）：靠扩展的 `host_permissions` 带 Cookie 访问 CAS，读到 302 后的 `response.url` 就能抠出 ticket |
| `src/core/renew.ts` | 续票入口：`needsRefresh()`（剩 <2 h 就该换）、`ensureFresh()`（按需）、`mintIntoSession()`（账密 30 天 → CAS fetch 8h → 落库）、`renewFromCas()`（标签页慢路，PWA 用） |
| `src/core/appMint.ts` | 浏览器内**账密直换 30 天票**（`mintViaApp()`）：手写 RSA PKCS#1 v1.5 + `fetch`，不需要 cookie、不需要浏览器 |
| `src/core/appBind.ts` | **绑定向导**（§10.3）：`startBind()`（detect → init → 发短信）、`submitCode()`（校验）、`canBindInShell()` / `startBindInShell()` / `submitCodeInShell()`（安卓壳那条桥） |
| `src/core/creds.ts` | 学号/密码/deviceId 的本机存储（KV key `appCreds`，含 `trustedAt`），`newDeviceId()` 生成 `zzu-layer-<16 hex>` |
| `src/ui/app-creds.tsx` | 侧边栏与 PWA 设置里的「学号密码 + 绑定向导」（`<AppCreds />`）：填密码 → 点绑定 → 填短信码 → 完成 |
| `scripts/app-login.mjs` | 一次性绑定（§10.3 的命令行做法）：短信验证一次 → 登记可信设备 → 立刻换一张 30 天票 |
| `scripts/app-ticket.mjs` | 账密换 30 天票：`ensureAppToken()` / `mintAppToken()` / `verifyToken()` / `deviceStatus()`；`--if-stale=24` / `--force` / `--verify` / `--json` |
| `mobile/.../AppMint.java` | 安卓壳里的同一套协议（纯 `HttpURLConnection` + 手写 RSA），续票第一级台阶 |
| `mobile/.../AppBind.java` | 安卓壳里的绑定向导（发短信 / 校码 / 顺手换票），经 `CampusNotify.appBindStart/appBindSubmit` 暴露给页面 |
| `test/appmint.test.ts` | 19 例：base64 往返、DER 剥 n/e、`__RSA__` 密文用 Node `privateDecrypt` 解回原文、`mintViaApp` 四条分支、creds 存取 |
| `test/appbind.test.ts` | 16 例：init/send/valid 的顺序与参数、status 2/3 的翻译、限流与网络错、壳桥的 code/done/error/超时 |

### 9.1 浏览器里怎么用（扩展 = 快路；PWA/App = 慢路）

扩展里 host_permissions 已经包含 `cas.s.zzu.edu.cn` / `uniapp.s.zzu.edu.cn`，
所以**一条 fetch 就能换票**，不需要开标签页、不需要内容脚本：

```
GET https://cas.s.zzu.edu.cn/cas/s/login?service=https://uniapp.s.zzu.edu.cn/
  → 302 …/?redirect=true&ticket=<JWT>
  → JSON.parse(atob(ticket.split('.')[1])).idToken
```

- `ensureFresh()` 只在「有票且剩不到 2 小时（或已过期）」时才动手，平时零请求；
  检查点有两处：任何一次问答前（`sessionOrRenew()`），以及 6 小时一次的推送闹钟（`dailyWatch()`）。
- 缓存节流：`mintIntoSession()` 60 秒内只发一次，避免并发请求各换一张。
- 同一张 idToken **同时写进 `jwxt` 与 `portal` 两个槽位**（实测两边都认，见 §7）。
- 扩展换不到（CAS 会话真没了）→ 退回 `renewFromCas()` 的标签页慢路 → 再不行就让用户重登。
- PWA / 安卓壳没有 CORS 豁免，`canMintInBrowser()` 为 false，走壳里的两级台阶：
  1. **Java 快路** `mobile/.../CasMint.java`：`CookieManager.getCookie("https://cas.s.zzu.edu.cn/cas/")`
     取出 TGC/SESSION/CAS_TRACE_ID，`HttpURLConnection` 关闭自动重定向，读 3xx 的 `Location`，
     抠出 `ticket=` 后交给网页的 `__campusImport`。不打开任何页面，用户看不到闪烁。
  2. **登录页慢路**：快路拿不到（CAS 会话真过期）才 `LoginActivity(silent=true)` 走一遍，
     那里可能还要补一次短信/扫码 MFA。
- 注意取 cookie 的路径必须是 `/cas/`：`CookieManager.getCookie()` 按路径匹配，
  用站点根路径问会拿到空串，快路会静默失败（踩过一次）。

---

## 10. 更好的那条路：学号+密码直换 **30 天**票（App 端点族）

§1–§9 那一整套（CAS 表单、MFA、TGC、8 小时票）是在 `/cas/` 上找票。学校「豫见郑大」App 走的是
**另一套端点在 `/token/` 下**，能直接签 30 天的票，而且不需要浏览器。

灵感来源：`https://github.com/Illustar0/ZZU.Py`（Python 版封装）。下面是实测（2026-10）的结论。

### 10.1 协议

```
GET  https://cas.s.zzu.edu.cn/token/jwt/publicKey
     → 200，444 B，和 /cas/jwt/publicKey 是同一把 RSA 公钥（PEM 或裸 base64 都行）

POST https://cas.s.zzu.edu.cn/token/mfa/detect?username=<__RSA__…>&password=<__RSA__…>&deviceId=<id>
     → { "code":0, "data": { "need": true, "state": "ETFwJM", … } }
       need:false = 这台设备已是「可信设备」，可以直接登录（不要验证码）

POST https://cas.s.zzu.edu.cn/token/password/passwordLogin?username=<__RSA__…>&password=<__RSA__…>
     &appId=com.supwisdom.zzu&osType=android&geo=&deviceId=<id>&clientId=&mfaState=<state>
     → { "code":0, "data": { "idToken": "…", "refreshToken": "…" } }
```

- Header 用 `User-Agent: SWSuperApp/1.1.1()`（取自 ZZU.Py 的 `f"{APP_VERSION}()"`）；取公钥时用 `okhttp/3.12.1` 也成。
- `<__RSA__…>` = RSA **PKCS#1 v1.5** 加密 → base64 → 前面加 `__RSA__` → **URL 编码**（base64 里有 `+ / =`）。
- 两个票的真实寿命（解码 jwt 实测）：`idToken` **720 h = 30 天**（`req=com.supwisdom.zzu`、带 `deviceId`、
  jti `Id-Token-…`）；`refreshToken` **1440 h = 60 天**（jti `Refresh-Token-…`）。
- 单次换票耗时 **74–113 ms**（两次实测）。

### 10.2 关键：deviceId + 可信设备

- `mfa/detect` 只看 `username` + `deviceId`（`password` 可选）。**同一台设备过一次 MFA 后，`need` 变 `false`。**
- 实测：`zzu-probe-mvrum1j6` 过完短信 → 再 detect `need:false`；随手新造 `zzu-probe-mvruv4hq` → `need:true`。
  于是「一次人工短信 → 之后纯账密、零人工、100 ms 换 30 天票」成立（连做两次 A/B 都是 720 h）。
- 可信设备也可以在安全中心看/管：`https://authx-service.s.zzu.edu.cn/security-center/eqIP-management`。
- 可信设备多久失效没测出来（只知道刚登记就生效）。所以 `deviceId` 要**持久化**：丢了就等于换了台新机器。

### 10.3 第一次怎么绑定（一次短信）

三种做法，选一个：

1. **App 内绑定向导（推荐，手机上就能做）**：设置里填学号密码 → 点「绑定（换 30 天票）」→
   App 自己发短信（原生 `AppBind.java`）→ 填收到的 4~6 位码 → 这台手机的 `deviceId` 登记为可信设备，
   顺手换一张 30 天票。页面与原生之间的协议：
   `CampusNotify.appBindStart(credsJson)` / `appBindSubmit(code)` → 回调 `window.__campusBind(json)`，
   `step` 取 `code|done|error`（`src/core/appBind.ts` ↔ `AppBind.java`）。
2. **扩展侧边栏**：同一个设置块，浏览器里由 `src/core/appBind.ts` 直接 `fetch`（host_permissions 豁免 CORS）。
3. **命令行**（电脑上，无 UI 时用）：

```powershell
$env:ZZU_USER='2026150xxxxx'; $env:ZZU_PASS='…'
npm run app:login
#   打印「短信已发到 195****7500」，把收到的 4~6 位码写进 .cas-state/sms-code.txt
#   成功后 .cas-state/app.json 里记下 account / password / deviceId / trustedAt
```

> 为什么向导要放在壳里：`cas.s.zzu.edu.cn` 不给我们 `Access-Control-Allow-Origin`，预检还回 403，
> 所以网页里连一个 POST 都发不出去。扩展和安卓壳各有各的豁免，浏览器页面没有。

之后（不需要任何人工、不需要浏览器）：

```powershell
npm run app:ticket -- --verify     # 需要就换一张 30 天票，然后打 eams-door 验一次
npm run app:ticket -- --if-stale=24
npm run app:ticket -- --json       # {"idToken": "…", "leftH": 719.9, …}
```

### 10.4 在三个宿主里怎么用

| 宿主 | 能不能直接调 `/token/` | 做法 |
| --- | --- | --- |
| 浏览器扩展 | **能**（`host_permissions` 含 `cas.s.zzu.edu.cn`，不受 CORS 限制） | `src/core/renew.ts` 的 `mintIntoSession()` 先试 `mintViaApp()`（`src/core/appMint.ts`：手写 RSA PKCS#1 v1.5 + 原生 `fetch`），失败再落 `/cas/` fetch 快路；绑定跑 `src/core/appBind.ts` |
| PWA（网页） | **不能**：`cas.s.zzu.edu.cn/token/*` 没有任何 `Access-Control-Allow-Origin`，预检 403 | 设置里填学号密码（存 `localStorage` 的 `campus-layer:appCreds`），绑定与换票都交给壳；页面上是同一个 `<AppCreds />`，只是走了 `CampusNotify.appBindStart/appBindSubmit` 这条桥 |
| 安卓壳 | **能**（原生） | `AppMint.java` 换票、`AppBind.java` 发/校短信；读 PWA 的 `localStorage` 凭据 → 交给页面 `__campusImport`；失败才退 `CasMint`，再失败才开登录页 |

于是安卓端的续票顺序是 **AppMint（30 天，静默）→ CasMint（8 小时，靠 TGC）→ 登录页（要人工 MFA）**；
第一次绑定在 App 里就能做完（设置 → 绑定 → 填一次短信码），不必再开电脑。

### 10.5 两个诚实的限制

- **`refreshToken` 目前没有可用端点**：`/token/password/refreshToken`、`/token/password/refresh` 都回
  `400 exception.mfa.verify.error`（被 MFA 过滤器挡住），`/token/oauth/token` 404。所以 30 天到期就再
  `passwordLogin` 一次——反正它零人工、100 ms，用不上刷新票。
- **实测范围**：eams-door（`X-Id-Token` 与 `Authorization` 都 200）与新门户 `info.s.zzu.edu.cn/portal-api`
  都认这张票；新教务 `/student` 页面本体仍然只认它自己的 cookie 会话（§1.1），跟 CAS 票一样不吃。
- **验证程度**：协议本身在 Node 里实测透了（CLI 出票 150 ms、`--verify` eams-door 200、reuse 分支剩 720 h），
  安卓壳的 Java 版（`AppMint` / `AppBind`）编进了 0.2.72 的 APK（`classes2.dex` 里能查到类名与方法名，
  CI 里 `gradle assembleDebug` 通过），但**没在真机上点过一遍**——本机没有 JDK / Android SDK / 手机，
  只有 CI 的编译结果；扩展里的 `mintViaApp()` 与绑定向导同样**没在真浏览器跑过**（本机没有 Chrome，
  Edge 起不来）。它们与 CLI 是同一套协议、同样的请求形状，差别只在谁发请求。
  真出问题时：换票会落 CAS 那条路，绑定只影响「要不要填一次码」，不会把已经能用的票弄坏。
- **可信设备会过期**：登记后立刻 `need=false`，但实测同一台设备**几小时后就会重新要求验证**（见 §10.5.3）。
  真失效的表现是 `need` 变回 true → 上层退 CAS 慢路 → 设置页重新点一次「绑定」。
- **短信有频率限制**：一分钟内连点会回「验证码发送过于频繁，请稍后再试」，界面上会原样显示这句。
  校验失败不消耗设备登记（可以重发、重填）；校验成功才登记，登记后这条 `gid` 就作废了。

#### 10.5.1 踩过的坑：点「绑定」直接闪退（0.2.72 → 0.2.73）

0.2.72 在真机上第一次点「绑定」就闪退，根因是**手写的 DER 解析少跳了一层**：

```
SPKI = SEQ { SEQ { OID, NULL }, BIT STRING { SEQ { INT n, INT e } } }
               ^^^^^^^^^^^^^^^^  AlgorithmIdentifier（0.2.72 把它的第一个孩子 OID 当成了 BIT STRING）
```

于是「长度」被当成 OID 里的某个字节读出来（实测 `1472509587`），接着
`new byte[1472509587]`（约 1.4 GB）抛的是 **`OutOfMemoryError`**——它是 `Error` 不是 `Exception`，
从 `catch (Exception)` 底下漏出去，在 `bind-start` 线程里没人接 → 进程被系统带走。

修法（0.2.73）：

1. `AppMint.parseKey()` 改成按 `alg.bodyStart + alg.length` 跳过整个 AlgorithmIdentifier 再取 BIT STRING；
2. `readTlv()` / `sub()` 加严格边界（`len` 必须落在数组内、长度字段最多 4 字节），越界抛 `IllegalArgumentException`
   而不是按那个数字去分配；
3. `parseKey` / `mint` / `AppBind.start` / `AppBind.submit` / 桥方法全部改 `catch (Throwable)`；
   `pushBind()` 也包起来（页面正在重载时 `evaluateJavascript` 会抛）；
4. 新增 `CrashLog.java`：`Thread.setDefaultUncaughtExceptionHandler` 把栈记进 SharedPreferences
   （**记完仍交回系统原 handler**，不吞异常），页面通过 `CampusNotify.lastCrash()` 读出来显示在设置块里；
5. `test/appmint.test.ts` 加了三条边界用例（DER 截断、长度字段指到数组外、取出来的必须是真 2048 位 n），
   把这层「少跳一层」的错钉死在 TS 侧。

教训：**`catch (Exception)` 挡不住 `Error`**；手写二进制解析一定要先把长度和数组边界对上，
再谈分配内存。安卓侧没有本地 JDK，这类错只能靠 CI 编译 + 真机点一次才发现，所以干脆把崩溃栈也带回来了。

#### 10.5.2 踩过的坑：闪退修好后，点「绑定」收不到短信（0.2.73 → 0.2.74）

闪退没了，但点「绑定」立刻失败、没有短信，界面显示「学校没认出这个账号」——
这句话是我自己编的，其实是**把 HTTP 500 当成「账号不对」**。真因是 RSA 填充块类型写错了：

```
PKCS#1 v1.5 加密块：EM = 0x00 || 0x02 || PS(随机非零) || 0x00 || M
                                        ^^^^ 0x02 是「公钥加密」
0.2.72/0.2.73 的 AppMint.rsaEncrypt() 写成了 0x01（那是签名用的块类型）
```

服务端解不开就回：

```
HTTP 500 {"timestamp":"…","status":500,"error":"Internal Server Error",
          "message":"解密字符串[r8gkGs1lf5IGU4wl…]"}
```

这个 JSON 里**没有 `code` 字段**，而壳里判断的是 `optInt("code", -1) != 0`，
于是 `-1` 命中了「账号不对」那条分支。同一份密码、同一个 deviceId，
用 0x02 的填充重放一次就正常回 `{"code":0,…,"need":true,"state":"…"}`。

修法（0.2.74）：

1. `AppMint.rsaEncrypt()` 的块类型改成 `0x02`（和 `src/core/appMint.ts` 的 `block[1] = 0x02` 对齐——
   扩展那边一直是对的，CLI 走 `node:crypto` 也一直是对的，**只有安卓手写那份错**）；
2. `AppMint` 增加 `Resp{status, body}` 与 `postResp()`，`AppBind` 出错时把 **HTTP 状态码**和服务端
   `message`（截 120 字）一起塞进提示，不再用一句自造的「学校没认出这个账号」；
3. 换票失败的那条提示补上「多半是密码不对」——因为学校的 `/token/mfa/detect`
   对**错密码也回 `need:false`**（很阴，实测：错密码 → `code:0, need:false`），
   只能靠后面的 `passwordLogin` 失败反推。

教训：**服务端错误码缺失时不要自己编语义**。`code` 不存在 ≠ 账号错；先看清楚 HTTP 状态码和 body。

#### 10.5.3 可信设备到底能活多久（实测补充）

同一天里的观测（deviceId → `need`）：

| 时刻 | deviceId | need |
| --- | --- | --- |
| 08:43 短信验证通过后 | `zzu-probe-mvrum1j6` | `false` |
| 12:00 | `zzu-probe-mvrum1j6` | `false` |
| 17:59（同一台设备、同一份密码） | `zzu-probe-mvrum1j6` | **`true`** |
| 17:59 | `zzu-layer-29a5ca7c6b230f33`（新设备） | `true`（从未登记） |

即「可信设备」**会过期**，几小时到十几小时的量级（未精确测）。所以准确的预期是：

- **一次短信 → 一张 30 天票**（这才是主要收益）；
- 「可信设备」只保证**短期内**再换票不用再验，不能当成永久免验；
- 30 天票到期时，还是要再走一次短信（或者靠 §2–§9 的 TGC 兜底，如果它还在有效期内）。

### 10.6 与旧方案的关系

| | §2–§9（`/cas/` + TGC） | §10（`/token/` + 账密） |
| --- | --- | --- |
| 票寿命 | 8 h（TGC 14 天兜底） | **30 天**（+60 天 refresh） |
| 需要浏览器 | 扩展/壳要带 cookie 或开标签页 | **不需要** |
| 人工 | 14 天一次扫码/短信 | **30 天一次短信**（换设备/清数据也要） |
| 前置条件 | CAS 会话（TGC） | 学号密码 + 一个可信 deviceId |

旧的 TGC 路线保留作兜底：没填账密、或设备被吊销时仍然能用。


