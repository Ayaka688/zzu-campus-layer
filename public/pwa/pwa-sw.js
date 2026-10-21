/* 手机 PWA 的离线壳：只缓存本页自身与静态资源，绝不碰学校接口。
 *
 * 路径全部相对 SW 自己的 scope（`/pwa/`），这样部署到域名根或子路径都能用：
 * 例如 `https://x.github.io/campus-layer/pwa/pwa-sw.js` → scope 是 `/campus-layer/pwa/`。
 */
const CACHE = 'campus-layer-v2';
const SCOPE = self.registration ? self.registration.scope : '/';
const SHELL = ['index.html', 'pwa.webmanifest', '../icons/icon-192.png', '../icons/icon-512.png', '../map/campus.jpg'].map(
  (p) => new URL(p, SCOPE).href,
);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => undefined));
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
