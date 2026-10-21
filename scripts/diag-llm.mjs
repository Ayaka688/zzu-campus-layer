// LLM 连通性诊断：在真实扩展运行环境里，分别从「扩展页面」和「扩展 Service Worker」
// 打一次模型接口，把原始错误抓出来。
// 用法：node scripts/diag-llm.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PROFILE = new URL('../.diag-profile/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PORT = 9336;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let CHILD = null;

async function httpJson(path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
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
    const out = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (out.exceptionDetails) {
      return { threw: out.exceptionDetails.text ?? 'exception', detail: out.exceptionDetails.exception?.description };
    }
    return out.result?.value;
  }
  close() {
    this.ws.close();
  }
}

/** 在任意上下文中打一次 fetch，返回结构化结果（不抛异常）。 */
const probe = (url, key) => `(async () => {
  const t0 = Date.now();
  try {
    const res = await fetch(${JSON.stringify(url)}, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + ${JSON.stringify(key)}, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }], stream: false }),
      credentials: 'omit',
      cache: 'no-store',
    });
    const text = (await res.text()).slice(0, 160);
    return { ok: true, status: res.status, ms: Date.now() - t0, body: text };
  } catch (e) {
    return { ok: false, name: e?.name, message: e?.message, ms: Date.now() - t0 };
  }
})()`;

async function main() {
  if (!existsSync(DIST)) throw new Error(`没找到 ${DIST}，先 npm run build`);
  if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  CHILD = spawn(
    EDGE,
    [
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${DIST}`,
      `--disable-extensions-except=${DIST}`,
      `--remote-debugging-port=${PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      version = await httpJson('/json/version');
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!version) throw new Error('连不上 CDP');
  console.log('browser:', version.Browser);

  // 找扩展 id：devtools 页面 /json/list 里会有 chrome-extension:// 的 SW
  // 找我们自己的扩展：targets 里会有很多别的扩展，认 background.js 那个
  let extId = null;
  for (let i = 0; i < 40 && !extId; i++) {
    const list = await httpJson('/json/list');
    const hit = list.find((t) => String(t.url).includes('/background.js'));
    if (hit) extId = new URL(hit.url).host;
    else await sleep(500);
  }
  if (!extId) throw new Error('没找到扩展（未加载成功？）');
  console.log('extension id:', extId);

  const panelUrl = `chrome-extension://${extId}/sidepanel/index.html`;
  await httpJson(`/json/new?${encodeURIComponent(panelUrl)}`, 'PUT');
  await sleep(2500);

  const list = await httpJson('/json/list');
  const panel = list.find((t) => String(t.url).includes('sidepanel/index.html'));
  const sw = list.find((t) => String(t.url).includes('background.js'));
  console.log('targets:', list.map((t) => `${t.type}:${String(t.url).slice(0, 60)}`).join(' | '));

  if (!panel) throw new Error('没有面板 target');
  const page = new Cdp(panel.webSocketDebuggerUrl);
  await page.ready();
  await page.send('Runtime.enable');

  // 让 SW 醒过来
  await page.eval(`chrome.runtime.sendMessage({ type: 'ping' }).catch(() => null)`);
  await sleep(800);

  const settings = await page.eval(`chrome.storage.local.get(null).then((v) => JSON.parse(JSON.stringify(v, null, 2)))`);
  console.log('\n--- chrome.storage.local ---');
  console.log(JSON.stringify(settings, null, 2).slice(0, 1200));

  console.log('\n--- 面板（扩展页面）里直接 fetch ---');
  console.log('school  :', JSON.stringify(await page.eval(probe('http://chat.zzu.edu.cn/api/chat/completions', 'sk-invalid'))));
  console.log('deepseek:', JSON.stringify(await page.eval(probe('https://api.deepseek.com/chat/completions', 'sk-invalid'))));
  console.log('moonshot:', JSON.stringify(await page.eval(probe('https://api.moonshot.cn/v1/chat/completions', 'sk-invalid'))));

  // 再在 SW 里打一次（扩展里真正的调用发生在这里）
  const list2 = await httpJson('/json/list');
  const sw2 = list2.find((t) => String(t.url).includes('background.js'));
  if (sw2) {
    const bg = new Cdp(sw2.webSocketDebuggerUrl);
    await bg.ready();
    await bg.send('Runtime.enable');
    console.log('\n--- Service Worker 里直接 fetch ---');
    console.log('school  :', JSON.stringify(await bg.eval(probe('http://chat.zzu.edu.cn/api/chat/completions', 'sk-invalid'))));
    console.log('deepseek:', JSON.stringify(await bg.eval(probe('https://api.deepseek.com/chat/completions', 'sk-invalid'))));
    bg.close();
  } else {
    console.log('\n!! 没有 background.js 的 SW target（可能已在休眠）');
  }

  // 走正常链路问一句（会命中 L1）
  console.log('\n--- 走 ask 链路（规则不命中 → L1） ---');
  const tokFile = (f) => {
    const p = new URL(`../tmp/zzu/${f}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : '';
  };
  const jwxt = tokFile('jwxt-token.txt');
  const schoolKey = tokFile('chat-key.txt');
  console.log('tokens in tmp/zzu:', { jwxt: jwxt.length, schoolKey: schoolKey.length });

  await page.eval(`chrome.storage.local.set({ tokens: { jwxt: ${JSON.stringify(jwxt ? { token: jwxt, savedAt: Date.now() } : null)} } }).then(() => 1)`);

  const askWith = (provider, key, model) => page.eval(`(async () => {
    await chrome.storage.local.set({ llm: { enabled: true, provider: ${JSON.stringify(provider)}, apiKey: ${JSON.stringify(key)}, model: ${JSON.stringify(model)} } });
    const stored = await chrome.storage.local.get('llm');
    const t0 = Date.now();
    const r = await chrome.runtime.sendMessage({ type: 'ask', text: '后天下午哪个屋子能让我安静看会儿书' });
    return { ms: Date.now() - t0, storedLlm: stored.llm, r: JSON.parse(JSON.stringify(r)) };
  })()`);

  const show = (label, v) => {
    const s = JSON.stringify(v);
    const text = v?.r?.data?.text ?? '';
    console.log(
      label,
      '| ms:', v?.ms,
      '| via:', v?.r?.data?.via,
      '| tool:', v?.r?.data?.tool ?? '-',
      '| err:', v?.r?.data?.error ?? v?.r?.error ?? '-',
      '| llmError:', String(v?.r?.data?.llmError ?? '-').slice(0, 120),
      '| llmMs:', v?.r?.data?.llmMs ?? '-',
      '| stored.enabled:', v?.storedLlm?.enabled,
      '| stored.provider:', v?.storedLlm?.provider,
      '| keyLen:', (v?.storedLlm?.apiKey ?? '').length,
      '| text:', String(text).slice(0, 60).replace(/\n/g, ' '),
    );
    void s;
  };

  show('school   ', await askWith('school', schoolKey, 'DeepSeek-R1'));
  show('deepseek ', await askWith('deepseek', 'sk-invalid', 'deepseek-chat'));

  // 界面上到底看不看得见原因：走一次真实的输入 → 提交 → 读气泡
  await page.eval(`chrome.storage.local.set({ llm: { enabled: true, provider: 'deepseek', apiKey: 'sk-invalid-for-test', model: 'deepseek-chat' } }).then(() => 1)`);
  const ui = await page.eval(`(async () => {
    const el = document.querySelector('.composer input, .composer textarea');
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, '后天下午哪个屋子能让我安静看会儿书');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    el.closest('form')?.requestSubmit();
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const warn = [...document.querySelectorAll('.bubble .hint.warn')].pop();
      if (warn) return { shown: warn.textContent.slice(0, 140) };
    }
    return { shown: null };
  })()`);
  console.log('\n--- 面板里是否显示原因 ---');
  console.log(JSON.stringify(ui));

  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  const out = new URL('../.diag-llm.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', out);

  page.close();
}

main()
  .catch((e) => {
    console.error('DIAG FAILED:', e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sleep(300);
    if (CHILD) CHILD.kill();
  });
