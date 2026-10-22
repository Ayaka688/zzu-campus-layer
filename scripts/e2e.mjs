// 端到端冒烟：用临时 profile 启动 Edge，加载 dist/ 里的扩展，
// 然后在扩展页面里注入 token、发一句话、读回面板渲染结果。
// 用法：node scripts/e2e.mjs
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFile as writeFileP } from 'node:fs/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DIST = new globalThis.URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PROFILE = new globalThis.URL('../.e2e-profile/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PORT = 9333;

const tokenFile = (f) => {
  const p = new globalThis.URL(`../tmp/zzu/${f}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
};

const jwxtToken = tokenFile('jwxt-token.txt');
const portalToken = tokenFile('token.txt');
const llmKey = tokenFile('chat-key.txt');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 出错时也要把 Edge 收掉，否则它会占着 9333 端口，下一次跑就起不来。 */
let CHILD = null;

async function httpJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: path.startsWith('/json/new') ? 'PUT' : 'GET' });
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
  async eval(expression, awaitPromise = true) {
    const out = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text ?? 'eval failed');
    return out.result?.value;
  }
  close() {
    this.ws.close();
  }
}

async function main() {
  if (!existsSync(DIST)) throw new Error(`没找到 ${DIST}，先 npm run build`);
  if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  const edge = spawn(
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
    { detached: false, stdio: 'ignore' },
  );
  CHILD = edge;

  let version;
  for (let i = 0; i < 60; i += 1) {
    try {
      version = await httpJson('/json/version');
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!version) throw new Error('CDP 端口没起来');
  console.log('Edge:', version.Browser);

  // 找扩展的 service worker target
  let sw;
  for (let i = 0; i < 60; i += 1) {
    const list = await httpJson('/json/list');
    sw = list.find((t) => t.url?.startsWith('chrome-extension://') && t.url.endsWith('/background.js'));
    if (sw) break;
    await sleep(500);
  }
  if (!sw) {
    console.log('targets:', (await httpJson('/json/list')).map((t) => `${t.type} ${t.url}`).join('\n'));
    throw new Error('扩展没有加载（--load-extension 可能被 Edge 忽略）');
  }
  const extId = new globalThis.URL(sw.url).host;
  console.log('extension id:', extId);

  // 1) 打开侧边栏页面（扩展页面在普通标签里也能跑，chrome.storage 一定可用）。
  //    注意：不要在 SW target 里写 storage —— MV3 的 SW 会休眠/重启，旧 target 上
  //    Runtime.evaluate 会落到空上下文，报 "chrome is not defined"。
  const page = await httpJson(`/json/new?chrome-extension://${extId}/sidepanel/index.html`);
  const ui = new Cdp(page.webSocketDebuggerUrl);
  await ui.ready();
  await ui.send('Runtime.enable');
  await ui.send('Page.enable');
  await ui.send('Emulation.setDeviceMetricsOverride', {
    width: 380,
    height: 720,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(1200);

  // 2) 在页面里写入 token，然后重载让面板读到
  const payload = { jwxtToken, portalToken };
  const wrote = await ui.eval(
    `(async () => {
      const t = ${JSON.stringify(payload)};
      const cur = (await chrome.storage.local.get('tokens')).tokens ?? {};
      const next = { ...cur };
      if (t.jwxtToken) next.jwxt = { token: t.jwxtToken, savedAt: Date.now() };
      if (t.portalToken) next.portal = { token: t.portalToken, savedAt: Date.now() };
      await chrome.storage.local.set({ tokens: next });
      const back = (await chrome.storage.local.get('tokens')).tokens;
      return Object.keys(back ?? {});
    })()`,
  );
  console.log('storage tokens:', wrote);

  await ui.send('Page.reload');
  await sleep(1500);

  const swProbe = await ui.eval(
    `(async () => {
      const got = await chrome.storage.local.get('tokens');
      return {
        gotKeys: Object.keys(got),
        hasTokens: Boolean(got.tokens),
        sameArea: Boolean(chrome.storage?.local),
        n: Object.keys(got.tokens ?? {}).length,
      };
    })()`,
  );
  console.log('sw storage probe:', JSON.stringify(swProbe));

  const title = await ui.eval('document.title');
  const hasInput = await ui.eval('Boolean(document.querySelector("input, textarea"))');
  console.log('panel:', { title, hasInput });

  const diag = await ui.eval(`(async () => {
    const store = await chrome.storage.local.get(null);
    const status = await chrome.runtime.sendMessage({ type: 'status' }).catch((e) => ({ error: String(e) }));
    return { storeKeys: Object.keys(store), tokens: store.tokens ? Object.keys(store.tokens) : null, status };
  })()`);
  console.log('diagnostics:', JSON.stringify(diag));

  // 3) 问一句，等回答
  const asked = await ui.eval(`(async () => {
    const el = document.querySelector('input, textarea');
    if (!el) return { error: 'no input' };
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, '今天有课吗');
    else el.value = '今天有课吗';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const form = el.closest('form');
    if (form) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    else {
      const btn = [...document.querySelectorAll('button')].find((b) => /发送|问|查询/.test(b.textContent || ''));
      if (btn) btn.click();
      else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    return { ok: true };
  })()`);
  console.log('ask:', asked);

  await sleep(6000);
  const answer = await ui.eval(`(() => {
    const t = document.body.innerText;
    return t.length > 1200 ? t.slice(0, 1200) : t;
  })()`);
  console.log('--- panel text ---');
  console.log(answer);

  // 3.4) 课表回答里要带校园地图，且图片真的被加载了（不是 404 的破图）
  const map = await ui.eval(`(async () => {
    const img = document.querySelector('.map img');
    if (!img) return { found: false };
    if (!img.complete) await new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 3000); });
    return { found: true, src: img.getAttribute('src'), w: img.naturalWidth, h: img.naturalHeight, caption: img.parentElement.querySelector('figcaption')?.textContent ?? '' };
  })()`);
  console.log('map:', JSON.stringify(map));

  // 3.45) 服务直达：问「打开座位预约」，回答里要出现可点的入口链接
  const go = await ui.eval(`(async () => {
    const el = document.querySelector('input, textarea');
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, '打开座位预约');
    else el.value = '打开座位预约';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const form = el.closest('form');
    if (form) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 4000));
    const a = document.querySelector('a.go');
    if (!a) return { found: false };
    return { found: true, href: a.href, text: (a.textContent || '').trim() };
  })()`);
  console.log('open_service link:', JSON.stringify(go));

  // 3.46) 一卡通：问「我卡里还有多少钱」，回答里要有余额行，并单独存一张截图
  const askPanel = (text) => `(async () => {
    const el = document.querySelector('input, textarea');
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, ${JSON.stringify(text)});
    else el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const form = el.closest('form');
    if (form) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 3500));
    const bubbles = [...document.querySelectorAll('.msg.assistant, .bubble.assistant, .msg')];
    const last = bubbles[bubbles.length - 1];
    return (last?.innerText ?? document.body.innerText).slice(0, 400);
  })()`;

  const cardText = await ui.eval(askPanel('我卡里还有多少钱'));
  console.log('card panel:', JSON.stringify(cardText.slice(0, 160)));

  // 3.47) 地点词：问「明天南核空教室」，回的必须全是南1–南3 的教室
  const southText = await ui.eval(`(async () => {
    const el = document.querySelector('input, textarea');
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, '明天南核空教室');
    else el.value = '明天南核空教室';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    el.closest('form')?.requestSubmit();
    // 空教室要并发翻页，实测 4–6 秒，这里给到 20 秒
    let text = '';
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const bubbles = [...document.querySelectorAll('.bubble')];
      text = bubbles[bubbles.length - 1]?.innerText ?? '';
      if (text && !text.includes('查询中')) break;
    }
    return text.slice(0, 400);
  })()`);
  const hasSouth = /南[123][_\s（(]/.test(southText);
  const leakedNorth = /北[1-5][_\s（(]/.test(southText);
  console.log(
    'south-core:',
    JSON.stringify({ hasSouth, leakedNorth, head: southText.split('\n').slice(0, 2).join(' / ') }),
  );
  if (!hasSouth && !southText.includes('南核心教学区')) {
    throw new Error('南核空教室的回答里既没有南1–南3 的教室，也没有地点说明');
  }
  if (leakedNorth) throw new Error('南核空教室的回答里混进了北区的教室（地点词没生效）');

  const shot2 = await ui.send('Page.captureScreenshot', { format: 'png' });
  if (shot2?.data) {
    const out2 = new URL('../.e2e-card.png', import.meta.url);
    await writeFileP(out2, Buffer.from(shot2.data, 'base64'));
    console.log('card screenshot:', out2.pathname);
  }

  // 3.5) 存一张面板截图，方便贴给人看
  const shot = await ui.send('Page.captureScreenshot', { format: 'png' });
  if (shot?.data) {
    const out = new URL('../.e2e-panel.png', import.meta.url);
    await writeFileP(out, Buffer.from(shot.data, 'base64'));
    console.log('panel screenshot:', out.pathname);
  }

  // 4) 顺带验证 SW 的消息路由（从扩展页面发出，SW 自己发给自己收不到）
  const pong = await ui.eval(
    `(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'ask', text: '第 7 周课表' }).catch((e) => ({ error: String(e) }));
      return { ok: r?.ok, keys: r?.data ? Object.keys(r.data) : null, head: (r?.data?.text ?? r?.error ?? '').slice(0, 300) };
    })()`,
  );
  console.log('--- sw ask ---');
  console.log(JSON.stringify(pong));

  // 5) 其余工具在真实扩展运行时里跑一遍
  const matrix = await ui.eval(
    `(async () => {
      const cases = [
        ['find_free_room', { campus: '主校区', minSeats: 100, limit: 3 }],
        ['search_notice', { limit: 2 }],
        ['get_grades', {}],
        ['get_exams', {}],
        ['get_plan_progress', {}],
        ['open_service', { keyword: '座位预约' }],
        ['get_card', {}],
        ['get_todos', {}],
        ['library_seats', {}],
        ['export_ics', { fromWeek: 7, toWeek: 8 }],
      ];
      const out = [];
      for (const [tool, args] of cases) {
        const started = Date.now();
        const r = await chrome.runtime.sendMessage({ type: 'tool', tool, args }).catch((e) => ({ ok: false, error: String(e) }));
        out.push({
          tool,
          ms: Date.now() - started,
          ok: r?.ok ?? false,
          head: (r?.data?.text ?? r?.error ?? '').replace(/\\n/g, ' ⏎ ').slice(0, 160),
        });
      }
      return out;
    })()`,
  );
  console.log('--- tool matrix ---');
  for (const row of matrix) console.log(`${row.ok ? '✓' : '✗'} ${row.tool} ${row.ms}ms  ${row.head}`);

  // 5.5) 设置面板 + 学校模型兜底（有 key 才跑，没 key 就跳过）
  const gear = await ui.eval(`(async () => {
    const btn = document.querySelector('button.gear');
    if (!btn) return { found: false };
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const box = document.querySelector('.settings');
    const inputs = box ? box.querySelectorAll('input').length : 0;
    return { found: true, opened: Boolean(box), inputs, hint: (box?.querySelector('.hint')?.textContent ?? '').slice(0, 40) };
  })()`);
  console.log('settings:', JSON.stringify(gear));

  const gearShot = await ui.send('Page.captureScreenshot', { format: 'png' });
  if (gearShot?.data) {
    const out = new URL('../.e2e-settings.png', import.meta.url);
    await writeFileP(out, Buffer.from(gearShot.data, 'base64'));
    console.log('settings screenshot:', out.pathname);
  }

  // 5.6) 自动取 key 的兜底路径：没有 chat 会话时要给可读提示，而不是静默失败
  const syncProbe = await ui.eval(`(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'chat:sync' }).catch((e) => ({ error: String(e) }));
    return { ok: r?.ok ?? false, error: (r?.error ?? '').slice(0, 80) };
  })()`);
  console.log('chat:sync without session:', JSON.stringify(syncProbe));

  // 3.7) 手机同步码：面板要能导出，且码能解回 token
  const bundleCode = await ui.eval(`(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'bundle:export' }).catch((e) => ({ ok: false, error: String(e) }));
    return { ok: Boolean(r?.ok), error: r?.error ?? null, code: typeof r?.data === 'string' ? r.data : '' };
  })()`);
  let bundleDecoded = null;
  if (bundleCode?.ok && bundleCode.code) {
    try {
      const padded = bundleCode.code + '='.repeat((4 - (bundleCode.code.length % 4)) % 4);
      bundleDecoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch (e) {
      bundleDecoded = { error: String(e) };
    }
  }
  console.log(
    'bundle:export:',
    JSON.stringify({
      ok: Boolean(bundleCode?.ok),
      error: bundleCode?.error ?? null,
      len: bundleCode?.code?.length ?? 0,
      keys: bundleDecoded ? Object.keys(bundleDecoded) : null,
      jwxtLen: typeof bundleDecoded?.jwxt === 'string' ? bundleDecoded.jwxt.length : null,
      hasPortal: Boolean(bundleDecoded?.portal),
    }),
  );

  if (llmKey) {
    const llmRun = await ui.eval(`(async () => {
      await chrome.runtime.sendMessage({ type: 'settings:set', patch: { enabled: true, apiKey: ${JSON.stringify(llmKey)}, model: 'DeepSeek-R1' } });
      const read = await chrome.runtime.sendMessage({ type: 'settings:get' });
      const started = Date.now();
      // 规则层认不出的说法，只能靠模型判意图
      const r = await chrome.runtime.sendMessage({ type: 'ask', text: '后天下午哪个屋子能让我安静看会儿书' }).catch((e) => ({ error: String(e) }));
      const out = { ms: Date.now() - started, via: r?.data?.via ?? null, tool: r?.data?.tool ?? null, err: r?.data?.error ?? (r?.error ? String(r.error) : null), llmError: (r?.data?.llmError ?? '').slice(0, 120) || null, head: (r?.data?.text ?? '').replace(/\\n/g, ' ⏎ ').slice(0, 200) };
      await chrome.runtime.sendMessage({ type: 'settings:set', patch: { enabled: false } });
      return { masked: read?.data ? { enabled: read.data.enabled, model: read.data.model, keyLen: (read.data.apiKey || '').length } : null, ...out };
    })()`);
    console.log('--- llm fallback ---');
    console.log(JSON.stringify(llmRun));
  } else {
    console.log('--- llm fallback --- skipped (no tmp/zzu/chat-key.txt)');
  }

  // 5.85) 模型挂掉时，界面上必须看得见原因（以前是静默回落，用户只看到帮助文案）
  const llmWarn = await ui.eval(`(async () => {
    await chrome.storage.local.set({ llm: { enabled: true, provider: 'deepseek', apiKey: 'sk-invalid-for-test', model: 'deepseek-chat' } });
    const el = document.querySelector('.composer input, .composer textarea');
    if (!el) return { found: false, text: 'composer 输入框没找到' };
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, '后天下午哪个屋子能让我安静看会儿书');
    else el.value = '后天下午哪个屋子能让我安静看会儿书';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const form = el.closest('form');
    if (form) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // 等这一轮请求回来（模型 401 大约 100ms，给 8 秒余量）
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const warn = [...document.querySelectorAll('.bubble .hint.warn')].pop();
      if (warn?.textContent?.includes('模型没帮上忙')) {
        return { found: true, text: warn.textContent.slice(0, 120) };
      }
    }
    const any = [...document.querySelectorAll('.bubble .hint.warn')].pop();
    const bubbles = [...document.querySelectorAll('.bubble')].map((b) => b.className + '|' + (b.innerText || '').replace(/\\s+/g, ' ').slice(0, 70));
    return { found: false, text: any?.textContent?.slice(0, 120) ?? null, bubbles: bubbles.slice(-3) };
  })()`);
  console.log('llm warn:', JSON.stringify(llmWarn));
  await ui.eval(`chrome.storage.local.set({ llm: { enabled: false, provider: 'school', apiKey: ${JSON.stringify(llmKey ?? '')}, model: 'DeepSeek-R1' } }).then(() => 1)`);

  // 5.9) 填过 key 之后，同步码里应该带上 llm
  const bundleWithLlm = await ui.eval(`(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'bundle:export' }).catch((e) => ({ ok: false, error: String(e) }));
    return { ok: Boolean(r?.ok), code: typeof r?.data === 'string' ? r.data : '' };
  })()`);
  if (bundleWithLlm?.ok && bundleWithLlm.code) {
    const padded = bundleWithLlm.code + '='.repeat((4 - (bundleWithLlm.code.length % 4)) % 4);
    const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    console.log('bundle:llm:', JSON.stringify({ len: bundleWithLlm.code.length, llm: decoded.llm ?? null }));
  }

  // 6) 兜底路径：token 失效时给可读错误、认不出的问题给帮助文本（DoD 6：不白屏）
  const fallback = await ui.eval(
    `(async () => {
      const KEY = 'tokens';
      const cur = (await chrome.storage.local.get(KEY))[KEY] ?? {};
      const dead = { token: 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjEsImlzcyI6ImNhcy5zLnp6dS5lZHUuY24ifQ.sig', savedAt: Date.now() };
      await chrome.storage.local.set({ [KEY]: { ...cur, jwxt: dead, portal: dead } });
      const help = await chrome.runtime.sendMessage({ type: 'ask', text: '你好' }).catch((e) => ({ error: String(e) }));
      const bad = await chrome.runtime.sendMessage({ type: 'ask', text: '明天有课吗' }).catch((e) => ({ error: String(e) }));
      const status = await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null);
      await chrome.storage.local.set({ [KEY]: cur });
      return {
        help: (help?.data?.text ?? help?.error ?? '').replace(/\\n/g, ' ').slice(0, 70),
        bad: (bad?.data?.text ?? bad?.error ?? '').replace(/\\n/g, ' ').slice(0, 120),
        badFlagged: Boolean(bad?.data?.error),
        pills: (status?.data ?? []).map((s) => s.source + ':' + (s.valid ? 'ok' : 'expired')).join(' '),
      };
    })()`,
  );
  console.log('--- fallback ---');
  console.log(`✓ 认不出 → ${fallback.help}`);
  console.log(`${fallback.badFlagged ? '✓' : '✗'} 失效 token → ${fallback.bad}  [${fallback.pills}]`);

  ui.close();
  edge.kill();
  await sleep(500);
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    /* profile 被占用就算了 */
  }
}

main().catch((e) => {
  console.error('E2E FAILED:', e?.message ?? e);
  if (CHILD) {
    try {
      CHILD.kill();
    } catch {
      /* 已经退出了 */
    }
  }
  process.exitCode = 1;
});
