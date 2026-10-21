/**
 * 手机 PWA 的端到端冒烟：起本地静态服务器 → 用 Edge 无头 + 移动视口打开 →
 * 把真 token 写进 localStorage → 问两句话 → 截图。
 * 用法：node scripts/pwa-shot.mjs（先 npm run build）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const abs = (p) => new globalThis.URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = abs('../dist/');
const PROFILE = abs('../.pwa-profile/');
const SHOTS = abs('../');
const CDP_PORT = 9334;
const WEB_PORT = 8899;
const BASE = `http://127.0.0.1:${WEB_PORT}`;

const tokenFile = (f) => {
  const p = abs(`../tmp/zzu/${f}`);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error(`等不到 ${url}`);
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(undefined));
      this.ws.addEventListener('error', () => reject(new Error('ws error')));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const out = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) {
      const d = out.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text ?? 'eval failed');
    }
    return out.result?.value;
  }
  close() {
    this.ws.close();
  }
}

async function main() {
  if (!existsSync(DIST)) throw new Error('没找到 dist/，先 npm run build');
  if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  const server = spawn(process.execPath, [abs('./serve-pwa.mjs')], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(WEB_PORT) },
  });

  let edge;
  try {
    await waitForHttp(`${BASE}/pwa/index.html`);

    edge = spawn(
      EDGE,
      [
        `--user-data-dir=${PROFILE}`,
        `--remote-debugging-port=${CDP_PORT}`,
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    // 等 CDP 起来
    let version;
    for (let i = 0; i < 60; i++) {
      try {
        version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!version) throw new Error('CDP 没起来');
    console.log('edge:', version['Browser']);

    const page = await (
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
    ).json();

    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.ready();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
      platform: 'Android',
    });

    const shot = async (name) => {
      const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const out = `${SHOTS}.${name}`;
      await writeFile(out, Buffer.from(res.data, 'base64'));
      console.log('screenshot:', out);
    };

    await cdp.send('Page.navigate', { url: `${BASE}/pwa/index.html` });
    await sleep(1500);

    // 走真实用户路径：清空本地 → 点「登录态」→ 粘贴同步码 → 保存
    const jwxt = tokenFile('jwxt-token.txt');
    const portal = tokenFile('token.txt');
    const chatKey = tokenFile('chat-key.txt');
    if (!jwxt) throw new Error('没找到 tmp/zzu/jwxt-token.txt');
    const code = Buffer.from(
      JSON.stringify({
        v: 1,
        jwxt,
        ...(portal ? { portal } : {}),
        ...(chatKey ? { llm: { apiKey: chatKey, model: 'DeepSeek-R1', enabled: true } } : {}),
        at: Date.now(),
      }),
      'utf8',
    )
      .toString('base64')
      .replace(/=+$/, '');

    await cdp.eval(`localStorage.removeItem('campus-layer:tokens'); 0`);
    await cdp.send('Page.reload');
    await sleep(1500);

    const before = await cdp.eval(`document.querySelector('header .chip')?.textContent ?? ''`);
    await cdp.eval(`document.querySelector('header .chip')?.click()`);
    await sleep(300);
    await cdp.eval(`(() => {
      const ta = document.querySelector('.sheet textarea');
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value')?.set;
      if (setter) setter.call(ta, ${JSON.stringify(code)});
      else ta.value = ${JSON.stringify(code)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);
    await shot('pwa-login.png');
    await cdp.eval(`[...document.querySelectorAll('.sheet button')].find((b) => b.textContent.includes('保存'))?.click()`);
    await sleep(1500);

    const after = await cdp.eval(`(() => ({
      chip: document.querySelector('header .chip')?.textContent ?? '',
      sheetOpen: !!document.querySelector('.sheet'),
      note: document.querySelector('.note')?.textContent ?? '',
      llm: (() => { try { return JSON.parse(localStorage.getItem('campus-layer:llm') || '{}'); } catch { return {}; } })(),
    }))()`);
    console.log('import:', JSON.stringify({ before, codeLen: code.length, ...after }));
    await shot('pwa-home.png');

    // 装到主屏幕的前提：安全上下文 + manifest 可取 + SW 真的注册上了
    const pwa = await cdp.eval(`(async () => {
      const link = document.querySelector('link[rel=manifest]');
      const href = link ? new URL(link.getAttribute('href'), location.href).href : null;
      const mf = href ? await fetch(href).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
      const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
      return {
        secure: isSecureContext,
        standalone: matchMedia('(display-mode: standalone)').matches,
        manifest: mf ? { name: mf.name, short: mf.short_name, display: mf.display, start: mf.start_url, icons: (mf.icons ?? []).length } : null,
        sw: regs.map((r) => r.scope),
        controlled: !!navigator.serviceWorker?.controller,
      };
    })()`);
    console.log('pwa:', JSON.stringify(pwa));
    if (!pwa.secure) throw new Error('不是安全上下文，装不了主屏幕');
    if (!pwa.manifest || pwa.manifest.display !== 'standalone') throw new Error('manifest 没取到或 display 不是 standalone');
    if (!pwa.sw.length) throw new Error('service worker 没注册上');

    const ask = async (text, waitMs = 4500) => {
      await cdp.eval(`(async () => {
        const el = document.querySelector('.composer input');
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(text)});
        else el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 80));
        el.closest('form').requestSubmit();
        await new Promise((r) => setTimeout(r, ${waitMs}));
      })()`);
      return cdp.eval(`(() => {
        const bubbles = [...document.querySelectorAll('.msg.assistant .bubble')];
        const last = bubbles[bubbles.length - 1];
        const img = [...document.querySelectorAll('.map img')].at(-1);
        const go = [...document.querySelectorAll('.msg.assistant .go')].at(-1);
        return {
          text: (last?.innerText ?? '').slice(0, 220),
          map: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
          go: go?.textContent ?? null,
          via: last?.querySelector('.via')?.textContent ?? null,
        };
      })()`);
    };

    console.log('ask 明天有课吗:', JSON.stringify(await ask('明天有课吗')));
    await shot('pwa-schedule.png');

    console.log('ask 今天空教室:', JSON.stringify(await ask('今天上午的空教室', 9000)));
    await shot('pwa-answer.png');

    if (chatKey) {
      console.log('ask 模型兜底:', JSON.stringify(await ask('后天下午哪个屋子能让我安静看会儿书', 22000)));
    }

    cdp.close();
  } finally {
    if (edge) edge.kill();
    server.kill();
  }
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e);
  process.exitCode = 1;
});
