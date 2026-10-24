/**
 * 聊天记录的端到端冒烟：换页面/重开之后，最近 5 条还在。
 *
 * 起本地静态服务器 → Edge 无头 + 手机视口 → 往 localStorage 塞 7 条 →
 * 刷新 → 只显示后 5 条 → 再发一句话 → 仍然只有 5 条（最旧的被顶掉）→
 * 再刷新 → 落盘的是 5 条、顺序没变、图片这类重字段没进存档。
 *
 * 不需要登录态：没 token 时会走「还没有登录态」那条分支，正好能验证实时截断。
 * 用法：node scripts/pwa-transcript.mjs（先 npm run build）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const abs = (p) => new globalThis.URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = abs('../dist/');
const PROFILE = abs('../.pwa-profile/');
const SHOTS = abs('../');
const CDP_PORT = 9336;
const WEB_PORT = 8902;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const KEY = 'campus-layer:transcript';

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

/** 界面上现在显示着几条、分别是什么 */
const SHOWN = `(() => {
  const nodes = [...document.querySelectorAll('.msg')];
  return nodes
    .filter((n) => !n.querySelector('.bubble')?.textContent.includes('查询中'))
    .map((n) => n.querySelector('.bubble')?.textContent.trim() ?? '');
})()`;

const STORED = `(() => {
  const raw = localStorage.getItem('${KEY}');
  return raw ? JSON.parse(raw) : null;
})()`;

function assert(ok, message) {
  if (!ok) throw new Error(message);
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
      { stdio: 'ignore', env: { ...process.env } },
    );

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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
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

    /* 1) 干净起点：没有存档就不该显示任何气泡 */
    await cdp.send('Page.navigate', { url: `${BASE}/pwa/index.html` });
    await sleep(1200);
    await cdp.eval(`localStorage.removeItem('${KEY}'); 0`);
    await cdp.send('Page.reload');
    await sleep(1200);
    const blank = await cdp.eval(SHOWN);
    console.log('空存档:', JSON.stringify(blank));
    assert(blank.length === 0, `没有存档时不该有气泡，实际 ${blank.length}`);

    /* 2) 塞 7 条进去（带一张座位图，验证重字段不会进存档） */
    await cdp.eval(`(() => {
      const items = Array.from({ length: 7 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: '第 ' + (i + 1) + ' 条',
        ...(i === 1 ? { tool: 'find_seat', data: { image: 'data:image/png;base64,AAAA', count: 2 } } : {}),
      }));
      localStorage.setItem('${KEY}', JSON.stringify({ v: 1, at: Date.now(), items }));
      return 0;
    })()`);

    /* 3) 刷新：只该显示后 5 条，顺序不变 */
    await cdp.send('Page.reload');
    await sleep(1500);
    const restored = await cdp.eval(SHOWN);
    console.log('恢复:', JSON.stringify(restored));
    assert(restored.length === 5, `应该只显示 5 条，实际 ${restored.length}`);
    assert(restored[0].includes('第 3 条'), `最上面应该是「第 3 条」，实际 ${JSON.stringify(restored[0])}`);
    assert(restored[4].includes('第 7 条'), `最下面应该是「第 7 条」，实际 ${JSON.stringify(restored[4])}`);
    await shot('pwa-transcript-1-restored.png');

    /* 4) 落盘里也没有大图字段（第 2 条被截掉了，所以这里只验证整体） */
    const stored = await cdp.eval(STORED);
    assert(stored?.items?.length === 5, `存档应该 5 条，实际 ${stored?.items?.length}`);
    assert(!JSON.stringify(stored).includes('data:image'), '座位图这种重字段不该进存档');

    /* 5) 现场再发一句：没 token 会回「还没有登录态」，最旧的一条被顶掉 */
    await cdp.eval(`[...document.querySelectorAll('.quick-scroll button')][0].click(); 0`);
    await sleep(900);
    const afterAsk = await cdp.eval(SHOWN);
    console.log('发一句后:', JSON.stringify(afterAsk));
    assert(afterAsk.length === 5, `发完还应该只显示 5 条，实际 ${afterAsk.length}`);
    assert(afterAsk[4].includes('还没有登录态'), `最后一条应该是登录提醒，实际 ${JSON.stringify(afterAsk[4])}`);
    assert(!afterAsk.some((t) => t.includes('第 3 条')), '最旧的「第 3 条」应该被顶掉了');
    await shot('pwa-transcript-2-after-ask.png');

    /* 6) 再刷新：刚才那句还在，仍然 5 条 */
    await cdp.send('Page.reload');
    await sleep(1500);
    const again = await cdp.eval(SHOWN);
    console.log('再刷新:', JSON.stringify(again));
    assert(again.length === 5, `刷新后应该还是 5 条，实际 ${again.length}`);
    assert(again[4].includes('还没有登录态'), '刷新后最后一条丢了');
    const stored2 = await cdp.eval(STORED);
    assert(stored2?.items?.length === 5, '存档没截到 5 条');
    assert(stored2.items[4].text.includes('还没有登录态'), '存档里最后一条不对');

    cdp.close();
    console.log('OK 聊天记录：刷新后恢复最近 5 条 / 现场截断 / 落盘只有 5 条 / 重字段不进存档');
  } finally {
    if (edge) edge.kill();
    server.kill();
  }
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e);
  process.exitCode = 1;
});
