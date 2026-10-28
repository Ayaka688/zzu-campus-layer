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
| `src/core/renew.ts` | 续票入口：`needsRefresh()`（剩 <2 h 就该换）、`ensureFresh()`（按需）、`mintIntoSession()`（fetch 快路 → 落库）、`renewFromCas()`（标签页慢路，PWA 用） |

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
- PWA / 安卓壳没有 CORS 豁免，`canMintInBrowser()` 为 false，继续走壳里的
  `LoginActivity(silent)`：WebView 的 CookieManager 里留着同一个 TGC，CAS 直接 302 带 ticket 回来，
  用户看不到登录页（`maybeSilentRenew()` 在剩 <120 min 时触发）。

