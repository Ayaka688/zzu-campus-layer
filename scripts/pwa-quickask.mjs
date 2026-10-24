/**
 * 常用语（输入框上面那排药丸）的端到端冒烟：
 * 起本地静态服务器 → Edge 无头 + 手机视口 → 断言「+」在 → 点开编辑器 →
 * 加一条 → 上下挪 → 完成 → 刷新看顺序还在 → 删一条。
 *
 * 不需要登录态：这排药丸是纯本地数据（localStorage）。
 * 用法：node scripts/pwa-quickask.mjs（先 npm run build）
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
const WEB_PORT = 8901;
const BASE = `http://127.0.0.1:${WEB_PORT}`;

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

/** 这一排药丸现在长什么样：文字 + 末尾那个「+」 */
const BAR = `(() => {
  const bar = document.querySelector('.quick');
  if (!bar) return null;
  const btns = [...bar.querySelectorAll('button')];
  return {
    pills: btns.filter((b) => !b.classList.contains('quick-add')).map((b) => b.textContent.trim()),
    add: bar.querySelector('.quick-add')?.textContent.trim() ?? null,
    editing: !!document.querySelector('.qa-editor'),
  };
})()`;

const STORED = `(() => {
  try { return JSON.parse(localStorage.getItem('campus-layer:quickAsks') || 'null'); } catch { return 'bad'; }
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

    // 干净起点：清掉这台浏览器里上次跑留下的常用语
    await cdp.send('Page.navigate', { url: `${BASE}/pwa/index.html` });
    await sleep(1200);
    await cdp.eval(`localStorage.removeItem('campus-layer:quickAsks'); 0`);
    await cdp.send('Page.reload');
    await sleep(1200);

    /* 1) 出厂状态：7 条 + 末尾「+」 */
    const initial = await cdp.eval(BAR);
    console.log('初始:', JSON.stringify(initial));
    assert(initial && initial.pills.length === 7, `出厂应该 7 条，实际 ${initial?.pills.length}`);
    assert(initial.pills[0] === '明天有课吗', '第一条应该是「明天有课吗」');
    assert(initial.add === '+', `末尾应该是「+」，实际 ${JSON.stringify(initial.add)}`);
    assert(!initial.editing, '一开始不该展开编辑器');
    await shot('pwa-quick-1-bar.png');

    /* 2) 点「+」展开编辑器 */
    await cdp.eval(`document.querySelector('.quick-add').click(); 0`);
    await sleep(300);
    const opened = await cdp.eval(BAR);
    console.log('展开:', JSON.stringify(opened));
    assert(opened.editing, '点「+」后没展开编辑器');
    assert(opened.add === '×', '展开后「+」应该变成「×」');
    const rows = await cdp.eval(`document.querySelectorAll('.qa-row').length`);
    assert(rows === 7, `编辑器里应该有 7 行，实际 ${rows}`);
    await shot('pwa-quick-2-editor.png');

    /* 3) 加一条：不是真的发出去，只看列表 */
    await cdp.eval(`(() => {
      const el = document.querySelector('.qa-add input');
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (setter) setter.call(el, '图书馆还有座吗');
      else el.value = '图书馆还有座吗';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 0;
    })()`);
    await sleep(120);
    await cdp.eval(`[...document.querySelectorAll('.qa-add button')].find((b) => b.textContent.includes('添加')).click(); 0`);
    await sleep(300);
    const added = await cdp.eval(BAR);
    console.log('加完:', JSON.stringify(added));
    assert(added.pills.length === 8, `加完应该 8 条，实际 ${added.pills.length}`);
    assert(added.pills.at(-1) === '图书馆还有座吗', '新加的应该排在最后');
    const storedAfterAdd = await cdp.eval(STORED);
    assert(storedAfterAdd?.items?.length === 8, `localStorage 里应该存了 8 条，实际 ${storedAfterAdd?.items?.length}`);
    const draft = await cdp.eval(`document.querySelector('.qa-add input').value`);
    assert(draft === '', '加完输入框应该清空');
    await shot('pwa-quick-3-added.png');

    /* 4) 新那条往上挪两格：↑ 按在最后一行 */
    await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('.qa-row')];
      const last = rows[rows.length - 1];
      last.querySelector('.qa-ops button[aria-label=上移]').click();
      return 0;
    })()`);
    await sleep(150);
    await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('.qa-row')];
      const target = rows[rows.length - 2];
      target.querySelector('.qa-ops button[aria-label=上移]').click();
      return 0;
    })()`);
    await sleep(300);
    const moved = await cdp.eval(BAR);
    console.log('挪完:', JSON.stringify(moved));
    assert(moved.pills.at(-3) === '图书馆还有座吗', `挪两格后应该在第 6 位，实际 ${JSON.stringify(moved.pills)}`);
    assert(moved.pills.at(-1) === '导出日历' && moved.pills.at(-2) === '卡里余额', '被顶下去的两条顺序不对');
    await shot('pwa-quick-4-moved.png');

    /* 5) 保持这个「自定义的排在第 6 位」的顺序，点「完成」收起 */
    await cdp.eval(`document.querySelector('.qa-done').click(); 0`);
    await sleep(250);
    const closed = await cdp.eval(BAR);
    assert(!closed.editing, '点「完成」后编辑器没收起');
    assert(closed.add === '+', '收起后应该还是「+」');

    /* 6) 刷新一次：顺序和自定义那条都要还在（顺序是用户自己拖的，不是默认的） */
    await cdp.send('Page.reload');
    await sleep(1400);
    const reloaded = await cdp.eval(BAR);
    console.log('刷新后:', JSON.stringify(reloaded));
    assert(reloaded.pills.length === 8, `刷新后应该还是 8 条，实际 ${reloaded.pills.length}`);
    assert(reloaded.pills[5] === '图书馆还有座吗', `刷新后自定义那条应该还在第 6 位，实际 ${JSON.stringify(reloaded.pills)}`);
    assert(reloaded.pills[6] === '卡里余额' && reloaded.pills[7] === '导出日历', '刷新后顺序没保住');

    /* 7) 删一条：删掉默认的「导出日历」 */
    await cdp.eval(`document.querySelector('.quick-add').click(); 0`);
    await sleep(250);
    await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('.qa-row')];
      const target = rows.find((r) => r.textContent.includes('导出日历'));
      target.querySelector('.qa-ops button[aria-label=删除]').click();
      return 0;
    })()`);
    await sleep(250);
    const deleted = await cdp.eval(BAR);
    console.log('删完:', JSON.stringify(deleted));
    assert(deleted.pills.length === 7, `删一条后应该 7 条，实际 ${deleted.pills.length}`);
    assert(!deleted.pills.includes('导出日历'), '「导出日历」没删掉');
    const storedAfterDelete = await cdp.eval(STORED);
    assert(storedAfterDelete?.items?.length === 7, '删除没落库');
    await shot('pwa-quick-5-deleted.png');

    /* 8) 恢复默认 */
    await cdp.eval(`[...document.querySelectorAll('.qa-link')].find((b) => b.textContent.includes('恢复默认')).click(); 0`);
    await sleep(150);
    await cdp.eval(`[...document.querySelectorAll('.qa-link')].find((b) => b.textContent.includes('确认恢复')).click(); 0`);
    await sleep(250);
    const reset = await cdp.eval(BAR);
    console.log('恢复默认:', JSON.stringify(reset));
    assert(reset.pills.length === 7 && reset.pills[0] === '明天有课吗' && reset.pills.at(-1) === '导出日历', '恢复默认没回到出厂列表');

    /* 9) 上限：加满 12 条后再加要给出中文提示，而不是崩 */
    for (let i = 0; i < 6; i++) {
      /* 每一轮都重新取元素：Preact 重渲染后旧引用会失效 */
      await cdp.eval(`(() => {
        const el = document.querySelector('.qa-add input');
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
        const text = ${JSON.stringify('测试第')} + ' ${i} 句';
        if (setter) setter.call(el, text); else el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 0;
      })()`);
      await sleep(120);
      await cdp.eval(`[...document.querySelectorAll('.qa-add button')].find((b) => b.textContent.includes('添加')).click(); 0`);
      await sleep(180);
    }
    const capped = await cdp.eval(BAR);
    const warn = await cdp.eval(`document.querySelector('.qa-editor .hint.warn')?.textContent ?? ''`);
    console.log('上限:', JSON.stringify({ count: capped.pills.length, warn }));
    assert(capped.pills.length === 12, `上限应该卡在 12 条，实际 ${capped.pills.length}`);
    assert(warn.includes('最多'), '到上限时没有中文提示');
    await shot('pwa-quick-6-limit.png');

    cdp.close();
    console.log('OK 常用语：+ / 添加 / 排序 / 删除 / 恢复默认 / 刷新后保留 / 上限提示 全部通过');
  } finally {
    if (edge) edge.kill();
    server.kill();
  }
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e);
  process.exitCode = 1;
});
