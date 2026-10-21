# 学校自带 LLM 能不能顶替第三方 LLM —— 实测评估

> 2026-10-21 实机探测（本机在校园网内：WLAN `10.172.10.123`，DNS `10.10.8.8`）
> 结论先行：**能用，而且已经接上了** —— 走 WebUI 的 API Key，不碰 CAS token。已实现为扩展的可选 L1 意图层。
> 下面 §1–§6 是评估与接法，§7 记录了当时 CAS 卡住的过程（后来用「客户端扫码」绕过）。

---

## 0. 最终状态（2026-10-21 更新）

**已接入，作为可选的 L1 意图层。**

- 卡点是 CAS 风控「安全手机验证 → 发送失败」，后来由用户用**豫见郑大 App 扫二维码**（弹窗右上角那个「俩矩形」图标）通过验证，成功登录 WebUI。
- 登录后在 设置 → 账号 → API 密钥 里生成 `sk-…`，已实测可用（见 §3.4）。
- 扩展侧实现：`campus-layer/src/core/llm.ts` + 侧边栏 `⚙` 设置（启用开关 / API Key / 模型名），只在 L0 规则没命中时调用，返回 `{tool,args}`，正文仍由模板渲染。
- 边界：**仅校园网内**、HTTP 明文、R1 有推理段导致一次判定 **11–18 秒**、默认关闭。

要不要默认开启是使用者的选择：不填 key 时扩展完全离线，与接入前行为一致。

---

## 1. 结论

| 问题 | 答案 |
| --- | --- |
| 学校有对校内开放的 LLM 吗？ | 有，`http://chat.zzu.edu.cn`（**仅校内网 / 10.67.16.3**） |
| 它是什么？ | **Open WebUI 0.5.18**，前端标题被改成「DeepSeek」，跑在 uvicorn/FastAPI 上 |
| 能当 LLM 后端喂给扩展吗？ | **能**。它开了 `enable_api_key`，用 `Authorization: Bearer sk-...` 调 `/api/chat/completions` |
| 能用现有 CAS `idToken` 直接换吗？ | **不能**。两套鉴权完全无关（详见 §3.3） |
| 代价是什么？ | 只在校园网内可用；HTTP 明文；Key 要你自己登录后建一次；R1 判定一次 11–18 秒 |
| 现在能接吗？ | **已经接上了**（§0），扩展里是可选项 |

---

## 2. 它到底是什么（证据）

### 2.1 指纹

```
GET http://chat.zzu.edu.cn/api/config
{"status":true,"name":"WebUI","version":"0.5.18","default_locale":"",
 "oauth":{"providers":{}},
 "features":{"auth":true,"auth_trusted_header":false,"enable_ldap":false,
             "enable_api_key":true,"enable_signup":false,
             "enable_login_form":true,"enable_websocket":true}}
```

`name:"WebUI"`、`version:"0.5.18"`、`enable_api_key:true` —— 这是 Open WebUI 的标准配置回显，一字不差。

```
GET http://chat.zzu.edu.cn/api/version  →  {"version":"0.5.18"}
server: uvicorn
```

### 2.2 为什么必须用 http 而不是 https

| 请求 | 结果 |
| --- | --- |
| `https://chat.zzu.edu.cn/` | `ERR_SSL_WRONG_VERSION_NUMBER`（443 端口上没有 TLS，是明文 HTTP 服务） |
| `http://chat.zzu.edu.cn/` | 200，6,582 B，SPA 外壳，`<meta name="apple-mobile-web-app-title" content="DeepSeek">` |

所以扩展里对它的 host_permission 要写 `http://chat.zzu.edu.cn/*`（**不是 https**）。

### 2.3 路由测绘（匿名，只看状态码）

| 端点 | 返回 | 说明 |
| --- | --- | --- |
| `POST /api/chat/completions` | 403 `{"detail":"Not authenticated"}` | **主对话接口在**，要鉴权 |
| `GET /api/models` | 403 同上 | 模型列表接口在 |
| `GET /api/v1/auths/` | 403 | 当前用户信息 |
| `GET /ollama/api/tags`、`POST /ollama/api/chat` | 403 | Ollama 兼容层也开着 |
| `POST /openai/chat/completions` | 403 | OpenAI 兼容转发也在 |
| `POST /api/v1/auths/signin` | 400 `The email or password provided is incorrect…` | 本地账号表单开着，注册关着 |
| `POST /api/v1/auths/ldap` | 400 `LDAP authentication is not enabled` | 不走 LDAP |
| `GET /api/models` + `Authorization: Bearer sk-fake` | **401** `Your session has expired or the token is invalid.` | **证明 Bearer + sk- 就是 API Key 通道**，只是 key 是假的 |

`GET /openapi.json` 与 `/docs` 都返回前端 HTML —— FastAPI 文档被关掉了，只能按 Open WebUI 的已知路由表来猜。

### 2.4 三条入口的关系

```
豫见郑大「deepseek超算版」
  → https://cas.s.zzu.edu.cn/cas/login?service=http://chat.zzu.edu.cn/auth
  → CAS 登录 → 落到 chat.zzu.edu.cn/auth → Open WebUI 会话

门户「AI大模型农场」
  → https://jf.v.zzu.edu.cn/Aifarm/api/deepseek（302 到 CAS）
  → 落地页 https://jksb.v.zzu.edu.cn/ds2025.htm「郑州大学AI大模型农场」
  → 一套独立的 账号+密码+图形验证码（/vls6sss/zzjlogin6_ds.dll/login）
  → 登录后进「郑州大学DeepSeek平台」（iframe 里还是那套 zzjlogin DLL）
```

也就是说：**同一个 Open WebUI，有两条前置认证**——CAS（超算版入口）和老式的 `zzjlogin` 准入（AI大模型农场入口）。两条路的终点都是 `chat.zzu.edu.cn`。

### 2.5 顺带澄清：门户里那个「AI 对话」不是这个

豫见郑大代码里有 `/pages/robot/AI`、`/pages/robot/robot`、`/kf/chat`。把 chunk 拆开看，`pages-robot-AI` 是个**知识库客服机器人**，不是 LLM：

```js
sendQuestion(inputTxt, sessionId, knowledgeId)   // POST
getHostQuestionList()                            // 热门问题
commentQuestion(commentType, id)                 // 点赞/踩
```

UI 文案是「没有为你找到答案，请重新试试吧」「为您找到您可能在问的问题」，`BaseUrl` 甚至是**河南科技大学**的模板残留（`https://superapp.haust.edu.cn/study`）。它按 `knowledgeId` 检索问答对，接不上 LLM。

真正能当 LLM 用的只有 `chat.zzu.edu.cn` 那套。

---

## 3. 为什么现有 token 用不上

### 3.1 我们手里有什么

`token.txt` / `jwxt-token.txt` 里那两张 JWT，`iss` 都是 `cas.s.zzu.edu.cn`，能被 `info.s` / `jwxt` 的网关当 `X-Id-Token` 认。它们的作用域是**那两个微服务网关**。

### 3.2 Open WebUI 认什么

Open WebUI 只认两种东西：

1. 它自己的会话 cookie / JWT（`/api/v1/auths/` 那一套，登录后由它自己签发）；
2. **API Key**（`sk-` 开头，Bearer 传，可以在「设置 → 账号 → API Keys」里自己建）。

它不知道 `X-Id-Token` 是什么，也没有任何接口接受 CAS ticket 换 token —— CAS 只是它前面那道门，门开了它自己发钥匙。

### 3.3 实测否证（`tmp/zzu/chat-token-test.mjs`，两张真 token 都试了）

| 请求 | 结果 |
| --- | --- |
| `GET /api/v1/auths/` + `X-Id-Token: <门户 token>` | 403 `{"detail":"Not authenticated"}` |
| `GET /api/v1/auths/` + `X-Id-Token: <教务 token>` | 403 `{"detail":"Not authenticated"}` |
| `POST /api/chat/completions` + `X-Id-Token: <任一张>` | 403 `{"detail":"Not authenticated"}` |
| `GET /api/v1/auths/` + `Authorization: Bearer <JWT>` | 401 `{"detail":"401 Unauthorized"}` |
| `GET /api/v1/auths/` + `Cookie: token=<JWT>` | 401 `{"detail":"401 Unauthorized"}` |
| `GET /api/models` + `Authorization: Bearer sk-fake` | 401 `{"detail":"Your session has expired or the token is invalid…"}` |

最后两行是关键的形态差异：**`sk-` 开头的走 API Key 校验路径**（报「token 无效」），裸 JWT 只得到泛化的 `401 Unauthorized`。所以「CAS JWT 当 API Key 用」这条路是死的，不是缺个头而已。

---

## 4. 怎么接（可行方案）

### 4.1 一次性准备（你来做，约 30 秒）

1. 在校园网（或学校 VPN）下打开 `http://chat.zzu.edu.cn`；
2. 用 CAS 登录（就是「deepseek超算版」那条路）；
3. 左下角头像 → **设置 → 账号 → API Keys → 新建**；
4. 复制 `sk-...` 给我，或直接填进扩展设置。

### 4.2 扩展侧要改什么

现在 `campus-layer/src/core/` 里没有 LLM 层（v0.2 明确把 LLM 降级为可选）。接的话新增一个小模块即可：

```ts
// src/core/llm.ts（示意）
const CHAT = 'http://chat.zzu.edu.cn';

export async function chat(apiKey: string, model: string, messages: Msg[]) {
  const res = await fetch(`${CHAT}/api/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text(), res.status === 401);
  const json = await res.json();
  return json.choices[0].message.content as string;
}
```

配套改动：

| 位置 | 改法 |
| --- | --- |
| `campus-layer/public/manifest.json` | `host_permissions` 加 `http://chat.zzu.edu.cn/*` |
| `campus-layer/src/core/storage.ts` | 存 `{ apiKey, model }`，与两个 token 并列 |
| `campus-layer/sidepanel/main.tsx` | 设置区一个 key 输入框 + 一个模型下拉（从 `/api/models` 拉） |
| `campus-layer/src/core/intent.ts` | L1 分支：规则没命中时交给 `chat()` 做意图分类，失败仍回落到反问 |
| `campus-layer/src/core/render.ts` | 工具结果仍走模板渲染；**LLM 只负责「听懂问题」，不负责编数据** |

### 4.3 建议的分层

```
L0 规则匹配（现在这层，覆盖 90% 的「今天有课吗/空教室/通知」）
  ↓ 没命中
L1 学校 LLM 判意图 → 返回 {tool, args}（严格 JSON Schema 校验）
  ↓ 校验失败 / 网络不通 / key 不在
L2 反问用户（现状）
```

关键点：**LLM 永远不直接生成课表/通知内容**，只做「这句话想调哪个工具」的判断。这样模型幻觉不会污染数据，也避开了「学校模型质量未知」的风险。

---

## 5. 与第三方 LLM 的取舍

| 维度 | 学校 Open WebUI | 第三方（DeepSeek/OpenAI API） |
| --- | --- | --- |
| 合规 | **最好**——数据留在校内服务器，用户协议上说得清 | 要说明数据出境/出境到第三方 |
| 成本 | 免费（学校买单） | 按 token 计费 |
| 可用性 | **只在校园网/VPN 内**，回家就断 | 全球可达 |
| 传输安全 | **HTTP 明文**（校园网内） | HTTPS |
| 模型质量 | 未知（要拿到 key 才能看模型列表） | 明确 |
| 配额/限流 | 未知，可能按院系限 | 明确 |
| 密钥管理 | 用户自己建 `sk-`，可随时吊销 | 平台侧 |

**判断**：校内场景（宿舍、教学楼、图书馆）用学校这套是对的；一旦离开校园网必须能自动回落，否则体验会「昨天好好的今天全红」。

---

## 6. 不建议做的事

1. **不要拿 CAS idToken 去试 Open WebUI** —— 已经实测 403，两套体系。
2. **不要替用户走 CAS 登录**。这次实测里 CAS 直接弹「当前登录环境异常，需安全手机验证」，发码还失败（`发送失败`）——自动化登录这条路在校方风控下不可靠，也不该做。
3. **不要抓 `zzjlogin` 那套图形验证码** —— 那是老式准入认证，破解验证码属于越界。
4. **不要默认开启**。学校服务可能有使用条款限制「仅限本人使用」，做成扩展内置后台调用有风险，应该是用户显式填入自己的 key。

---

## 7. 登录受阻记录（以及后来的绕过）

2026-10-21 按用户要求实际去登了一次，第一轮是失败的：

| 步骤 | 结果 |
| --- | --- |
| 打开 `https://cas.s.zzu.edu.cn/cas/login?service=http://chat.zzu.edu.cn/auth` | 正常，页面标题「超算统一身份认证对接」 |
| 账号 `202600000001` + 密码（浏览器自动填充，我未输入）→ 点「登录」 | 弹出「安全验证：当前登录环境异常，需通过安全验证确认是本人操作」 |
| 验证方式 | 只有一种：**使用安全手机验证 +86 1xx\*\*\*\*xxxx** |
| 点「获取验证码」（两次，间隔数分钟） | 两次都返回红色 **「发送失败」** |
| 用户手机 | **没有收到任何短信**（可确认是学校侧问题） |
| WebUI 自有账密 | 系统生成，用户网页端不知道；手机 App 未开放 API Key 入口 |

**绕过办法（用户提供，实测有效）**：风控弹窗里「其他方式」右侧有两个小图标——手机 / **两个套在一起的矩形**。点后者会把弹窗切换成「使用客户端扫码 / 支持豫见郑大的扫一扫功能」，显示二维码。

| 步骤 | 结果 |
| --- | --- |
| 点「俩矩形」图标 | 弹窗出现二维码 |
| 截图裁出二维码（原生 2488×1440 截图里密集像素 bbox 约 `x 1179..1347 / y 761..959`）→ QQ 发给用户 | 用户用豫见郑大 App 扫 |
| 扫码后页面 | 显示「已确认 确认码: xxxx / 请在手机上点击同意」 |
| 手机点「同意」 | **登录成功**，跳到 `http://chat.zzu.edu.cn`（WebUI + DeepSeek 界面） |

教训：CAS 的短信通道坏了，但「客户端扫码」是通的，而且是**唯一**可行的自助入口。

### 7.1 拿到 key 的过程

1. 右上角头像 → 设置 → 账号 → 「API 密钥」点「显示」→「+ 创建新安全密钥」→ toast「API 密钥已创建」。
2. 页面上的复制按钮**无效**（`http://` 下 `navigator.clipboard` 不可用），改用地址栏执行：
   ```js
   javascript:fetch('/api/v1/auths/api_key',{headers:{Authorization:'Bearer '+localStorage.token}})
     .then(r=>r.text()).then(t=>{document.title='K'+t.slice(0,150)});void 0
   ```
   窗口标题变成 `K{"api_key":"sk-…"}`，读窗口标题即可取回。**这是从页面里回读数据的通用手法（结果写进 `document.title`）。**
3. key 存本地 `tmp/zzu/chat-key.txt`（不入库）。

### 7.2 实测（2026-10-21）

| 调用 | 结果 |
| --- | --- |
| `GET /api/v1/auths/` | `{"email":"202600000001@nscc.ai","name":"某同学","role":"user"}` |
| `GET /api/models` | 只有一个：`id: "DeepSeek-R1"`，`name: "DeepSeek"` |
| `POST /api/chat/completions` `model:"DeepSeek-R1"` | 200，响应含 `<think>…</think>` 推理段；示例 5.4s / completion 186 tokens |
| `model:"DeepSeek"` 或 `"deepseek-r1"` | 400 `{"detail":"Model not found"}` —— **id 必须写 `DeepSeek-R1`** |

### 7.3 扩展里的落地

- `campus-layer/src/core/llm.ts`：`llmChat()`（20s 超时）、`stripThink()`、`parseIntentsJson()`（抠 JSON + 工具白名单 + 参数类型收敛）、`classifyIntent()`。
- `campus-layer/src/core/agent.ts`：L0 规则 → 未命中且开关打开 → L1 模型判意图 → 同一套 `runTool`。
- 侧边栏 `⚙`：启用开关 / API Key / 模型名，存 `chrome.storage.local`。
- `manifest.json` 加 `http://chat.zzu.edu.cn/*`（第 9 个 host 权限）。
- 端到端实测：问「后天下午哪个屋子能让我安静看会儿书」（规则层认不出）→ `via: "llm"` → `find_free_room` → 返回 2026-10-23 的真实空教室，11.6–17.5s。
- 模型给的参数类型常不对（`campus: 1`、`sections: 5`、`minSeats: "100"`），`coerceArgs()` 会收敛/丢弃，最后再过工具自己的 zod schema，兜不住就退回空参数——保证「模型判错也不会崩」。
- 模型算日期也不可信：一次 e2e 里「后天」（当天 2026-10-21）被算成 `2026-10-22`。所以 `via: "llm"` 之后，`agent.ts` 用规则层的 `relativeDayOffset()` 重新覆盖 `date`/`day` 参数，模型只负责「挑哪个工具」。

### 7.4 现在是一键的（2026-10-21 收尾）

不再需要手工复制 key：

- `campus-layer/public/content/chat.js` 在 `http://chat.zzu.edu.cn/*` 上读 WebUI 的登录会话（`localStorage.token`），交给扩展。
- 扩展 `POST /api/v1/auths/api_key`（`mintApiKey()`）换出 `sk-…` 写进 `chrome.storage.local`；已有 key 不覆盖。
- 面板打开时自动试一次，设置里也有「从已登录的 DeepSeek 页面自动获取」（`chat:sync`）。
- 会话只用来换一次 key，之后不再参与请求；key 失效就再打开一次 WebUI。

安全边界（同样写在 `campus-layer/README.md`）：

| 项 | 事实 |
|---|---|
| key 权限 | 等同本人 WebUI 使用权（问模型、看自己的对话），不含教务/门户权限，不含密码 |
| 存储 | 只在 `chrome.storage.local`，扩展无任何上报通道 |
| 传输 | `http://`（该校 443 的 TLS 是坏的），仅校园网/VPN 可达 |
| 撤销 | WebUI「重置密钥」、删扩展或「清除 token」 |
| 「内网裸奔」 | 成立：鉴权只有 `sk-`/会话，没有额外来源校验。风险面 = 校内网 + 本机浏览器 |

---

## 8. 复现

```powershell
cd campus-layer
node ../tmp/zzu/chat-routes.mjs      # 匿名路由测绘
node ../tmp/zzu/chat-api.mjs         # 配置/版本/接口形态
node ../tmp/zzu/chat-token-test.mjs  # 拿真 CAS JWT 去试（证明用不上）
```

三个脚本都在仓库里，脚本里没有任何凭据；`chat-token-test.mjs` 从 `tmp/zzu/token.txt`、`tmp/zzu/jwxt-token.txt` 本地读取。
