/**
 * 本地静态服务器，只为在手机上预览 PWA：`npm run pwa:serve`。
 * 之所以要它：PWA 的 service worker 与「添加到主屏幕」都要求 http(s) 来源，
 * 直接双击 `dist/pwa/index.html`（file://）是不行的。
 *
 * 监听 0.0.0.0，这样手机在同一 Wi-Fi 下可以用电脑的局域网 IP 打开。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', 'dist');
const PORT = Number(process.env.PORT ?? 8899);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ics': 'text/calendar; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/pwa/index.html';

    const target = join(ROOT, normalize(pathname).replace(/^([/\\])+/, ''));
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`404 ${pathname}`);
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'service-worker-allowed': '/',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(e));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log(`PWA 预览：http://127.0.0.1:${PORT}/pwa/index.html`);
  for (const ip of lan) console.log(`手机同一 Wi-Fi：http://${ip}:${PORT}/pwa/index.html`);
});
