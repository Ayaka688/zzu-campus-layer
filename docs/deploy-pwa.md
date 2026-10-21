# 把手机版（PWA）放上线

> 目标：手机上有一个图标，点开就能一句话查课表 / 空教室 / 通知 / 学分 / 一卡通，**不需要任何常开服务器**。
>
> 前置：`cd campus-layer && npm install --ignore-scripts && npm run build`，产物在 `campus-layer/dist/`。

## 为什么是静态托管

PWA 要能"加到主屏幕"，浏览器要求它跑在**安全上下文**（HTTPS 或 localhost）里 —— 这是 `navigator.serviceWorker` 和 manifest 的硬性前提，跟有没有后端无关。

而数据接口本来就能公网直连（见下表），所以整条链路里唯一"要放个地方"的，只有那堆静态文件。

| 目标 | 公网可达 | CORS | 备注 |
| --- | --- | --- | --- |
| `https://jwxt.zzu.edu.cn` | ✅（境外节点 301） | 回显 Origin | 教务：课表/成绩/学分/空教室 |
| `https://info.s.zzu.edu.cn/portal-api` | ✅（境外节点 200） | `*` | 门户：通知/一卡通/待办 |
| `https://cas.s.zzu.edu.cn` | ✅（境外节点 302） | — | 只用于登录页 |
| `http://chat.zzu.edu.cn` | ❌（私网 `10.67.16.3`） | 回显 Origin | 学校模型，仅校园网，且只有 http |

结论：**数据在 4G 下也能查**；学校模型只有校园网内、且只能在 http 页面里用（HTTPS 页面会被混合内容拦），所以手机上要模型就填自己的 key。

## 三种放法

### A. Cloudflare Pages（推荐：免费、免登录域名、传就完事）

1. 打开 <https://pages.cloudflare.com> → Create → **Upload assets**（不用接 Git）。
2. 起个项目名，比如 `campus`，把 `campus-layer/dist/` **里面的内容**整个拖进去（不是拖 dist 目录本身）。
3. 得到 `https://campus.pages.dev`，打开 → 右上角「登录态」→ 粘同步码。
4. 手机 Chrome：地址栏右侧「⋮」→ **添加到主屏幕**。

命令行版（有 Node 即可，不需要常开机器）：

```bash
npx wrangler pages deploy campus-layer/dist --project-name campus
```

### B. GitHub Pages（免费，但走子路径）

1. 把 `dist/` 的内容推到仓库的 `gh-pages` 分支（或把 `dist` 设为 Pages 的发布目录）。
2. Settings → Pages → Source 选该分支 / 目录。
3. 地址形如 `https://<user>.github.io/<repo>/pwa/index.html`。

产物里的路径**都是相对的**（`../assets/…`、`./pwa.webmanifest`、`../map/campus.jpg`），所以子路径能直接用。
唯一注意：**别用仓库根当发布目录**（否则 `/pwa/` 会和源码目录混在一起），用 `dist` 或独立分支。

### C. Netlify Drop / Vercel（同样免费）

- Netlify：<https://app.netlify.com/drop>，把 `dist` 拖进去即可，拿到 `https://xxx.netlify.app`。
- Vercel：`npx vercel --prod`（首次会问目录，选 `dist`）。

三种都一样：**没有后端、没有数据库、没有任何进程需要保持运行**。

## 为什么不用"本机 http 起服务"

`npm run pwa:serve` 只适合**调试**：它监听局域网 IP，手机同 Wi-Fi 下能查数据，但

- `http://192.168.x.x:8899` 不是安全上下文 → **装不了主屏幕**、没有 service worker；
- 电脑一关机就没了；
- 换网段（回家/换 Wi-Fi）IP 就变，`localStorage` 按 origin 隔离，登录态会"消失"（其实还在旧 origin 下）。

静态托管把这三条全解决，而且免费。

## 上线后怎么自检

1. 手机 4G（关 Wi-Fi）打开站点 → 右上角应显示「登录态」。
2. 粘同步码 → 顶部药丸变成「教务 N 天」。
3. 问「明天有课吗」→ 出课表 + 校园地图。
4. 问「明天下午哪间教室空着」→ 出空教室（默认前 12 间）。
5. 设置里勾「用模型兜底」，服务商选 **DeepSeek 官方**（或硅基流动/百炼/Moonshot/OpenRouter），填 key → 问一句规则认不出的话（如「后天下午哪个屋子能让我安静看会儿书」）→ 回答上应有「由模型判定」。

本机已经有一层自动断言（`npm run pwa:shot`，无头 Edge + 390×844）：安全上下文、manifest 的 `name/display: standalone/start_url/icons`、service worker 是否注册并接管页面。当前实测输出：

```json
{"secure":true,"manifest":{"name":"校园信息层","short":"校园信息","display":"standalone","start":"./index.html","icons":3},
 "sw":["http://127.0.0.1:8899/pwa/"],"controlled":true}
```

换句话说：只要把 `dist/` 放上 HTTPS，装到主屏幕这一步的硬性条件都满足。

## 常见问题

**Q: 加了主屏幕，图标点开还是浏览器界面？**
manifest 里 `display: standalone`；如果仍是浏览器界面，多半是 manifest 没取到 —— 检查 `/pwa/pwa.webmanifest` 是否 200、`start_url` 是否在 scope 内。iOS 用 Safari「添加到主屏幕」，不支持 SW 之外的部分特性但够用。

**Q: 学校数据要 VPN 吗？**
不用。教务/门户都是公网地址，境外节点实测可连。只有 `chat.zzu.edu.cn` 是内网。

**Q: 同步码多久过期？**
教务票 30 天、门户票 8 小时。教务票够用；过期后回电脑打开扩展侧边栏 ⚙ → 「生成手机同步码」→ 重新粘一次。

**Q: 我填了第三方 key，安全吗？**
key 只存在手机 `localStorage`（键前缀 `campus-layer:`），代码里没有上报通道（`credentials: 'omit'`，只往你选的服务商发）。但：**部署在谁的域名上，谁就能读到** —— 所以用自己的账号部署，别用别人给的站点。同步码里也会带 key，别发群。

**Q: 能改成真正安装的 APK 吗？**
可以，但**没必要**：PWA 加到主屏幕后是全屏、独立图标、可离线开壳，观感与 APK 基本一致。真要 APK 可用 [PWABuilder](https://www.pwabuilder.com/) 把同一个站点包成 TWA，仍然不需要服务器。
