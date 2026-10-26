/* 手机 PWA 的离线壳：只缓存本页自身与静态资源，绝不碰学校接口。
 *
 * 路径全部相对 SW 自己的 scope（`/pwa/`），这样部署到域名根或子路径都能用：
 * 例如 `https://x.github.io/campus-layer/pwa/pwa-sw.js` → scope 是 `/campus-layer/pwa/`。
 *
 * 策略（2026-10-23 修）：**index.html 走网络优先**，assets 走缓存优先。
 * 原因：assets 文件名带 hash 不会变内容，缓起来最划算；但 index.html 决定这次要用哪套 assets，
 * 一旦被永久缓存，新部署的代码就永远进不来——安卓壳里尤其明显（它就是一个长期不关的 WebView）。
 */
const CACHE = 'campus-layer-v7';
const SCOPE = self.registration ? self.registration.scope : '/';
/*
 * 预缓存清单：只放**仓库里一定存在**的文件。
 * 以前这里还列了 ../map/campus.jpg，但那张地图是学校版权素材、仓库里默认不带，
 * 于是 cache.addAll 整个失败（它是原子的），离线壳一次都没装上过。
 * 现在改成逐个 add + allSettled：缺哪个都不影响其它文件。
 */
const SHELL = ['index.html', 'pwa.webmanifest', '../icons/icon-192.png', '../icons/icon-512.png'].map(
  (p) => new URL(p, SCOPE).href,
);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // 只处理自家静态资源；跨域（学校 API）一律原样放行，不进缓存。
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  // 1) 入口文档：网络优先，离线才用缓存（保证拿到最新 assets 清单）
  const isDocument = url.pathname.endsWith('/pwa/index.html') || url.pathname.endsWith('/pwa/');
  if (isDocument || event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) void caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(event.request).then((hit) => hit || caches.match(SHELL[0]))),
    );
    return;
  }

  // 2) 其余静态资源：缓存优先 + 后台更新
  const isShell = SHELL.includes(url.href) || url.href.includes('/assets/');
  if (!isShell) return;

  event.respondWith(
    caches.match(event.request).then((hit) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) void caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
