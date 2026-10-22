/**
 * 图书馆空间预约（order.lib.zzu.edu.cn）的页面内代理。
 *
 * 为什么必须放在页面里：
 * - 站点把登录态放在 `sessionStorage.token`，请求头是 `authorization: bearer<token>`；
 * - 下单一类接口 `/v4/space/confirm` 的请求体是页面自己用 AES 加密的（`isCrypto:true`），
 *   我们不想复制那套密钥，所以**执行动作一律通过操作页面来完成**，让页面自己加密。
 *
 * 这个脚本只做三件事：
 * 1. `lib:probe` —— 用页面自己的 token 拉座位数据（只读），把原始 JSON 交给扩展去解析；
 * 2. `lib:book`  —— 按「区域 + 日期 + 座位号」在页面上走一遍点选并提交（**只在用户长按确认后才调用**）；
 * 3. `lib:open`  —— 把页面导航到指定区域/日期。
 *
 * 注意：content script 与页面共享同一个 origin 的 storage，所以能读到 token；
 * 但我们只读 token、不改它。
 */
(() => {
  const TOKEN_KEY = 'token';

  function token() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        authorization: `bearer${token()}`,
      },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { code: -1, message: '返回的不是 JSON', raw: text.slice(0, 500) };
    }
    return { status: res.status, json };
  }

  /** 只读：把座位图 + 座位列表的数据原样带出去 */
  async function probe(args) {
    const areaId = String(args.areaId || '');
    const date = String(args.date || '');
    if (!token()) {
      return { ok: false, error: '这个页面还没登录。请先在浏览器里登录图书馆空间预约，再让我查座位。' };
    }
    const map = await post('/v4/Space/map', { id: areaId, date });
    const seat = await post('/v4/Space/seat', { id: areaId, date });
    return {
      ok: true,
      areaId,
      date,
      map: map.json,
      seat: seat.json,
    };
  }

  function navigate(areaId, date) {
    const href = `#/seat/appointment?id=${encodeURIComponent(areaId)}&date=${encodeURIComponent(date)}`;
    if (location.hash !== href) location.hash = href;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function byText(re, root = document) {
    const nodes = [...root.querySelectorAll('button,div,span,a')];
    return nodes.filter((n) => n.children.length === 0 && re.test((n.textContent || '').trim()));
  }

  async function waitFor(fn, timeoutMs = 8000, stepMs = 250) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const v = fn();
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  }

  /**
   * 在页面上完成一次预约：定位座位 → 点选 → 点「立即预约」→ 确认弹窗。
   * 任何一步失败都会返回 false 并把原因带回去，绝不"假装成功"。
   */
  async function book(args) {
    const areaId = String(args.areaId || '');
    const date = String(args.date || '');
    const seatNo = String(args.seatNo || '');
    if (!token()) return { ok: false, error: '这个页面还没登录，无法预约。' };
    if (!seatNo) return { ok: false, error: '没有给出座位号。' };

    navigate(areaId, date);

    // 座位图是画布 + 覆盖层，座位元素上带座位号文本
    const seatEl = await waitFor(() => byText(new RegExp(`^${seatNo}$`))[0], 12_000);
    if (!seatEl) return { ok: false, error: `页面上找不到座位 ${seatNo}（可能已被占或座位号变了）。` };
    seatEl.click();
    await sleep(600);

    const bookBtn = await waitFor(() => byText(/立即预约/)[0], 6_000);
    if (!bookBtn) return { ok: false, error: '点了座位但没出现「立即预约」按钮。' };
    if (bookBtn.disabled || /disabled/.test(bookBtn.className)) {
      return { ok: false, error: '「立即预约」是灰的，说明这个座位当前不可约。' };
    }
    bookBtn.click();
    await sleep(800);

    // 规则弹窗 / 确认弹窗：文案里带「预约」「确定」「同意」的按钮
    const confirm = await waitFor(() => byText(/^(确定|确认|同意|继续预约|我知道了)$/)[0], 8_000);
    if (!confirm) return { ok: false, error: '没有出现确认弹窗，可能在页面上停住了，请自己看一眼。' };
    confirm.click();
    await sleep(1200);

    const done = byText(/预约成功|成功|已预约/)[0];
    return {
      ok: true,
      seatNo,
      date,
      areaId,
      verified: Boolean(done),
      note: done ? '页面出现成功提示' : '已点确认，但没看到成功提示，请自己核对一下',
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('lib:')) return undefined;
    (async () => {
      try {
        if (msg.type === 'lib:probe') sendResponse(await probe(msg.args || {}));
        else if (msg.type === 'lib:open') {
          navigate(String(msg.args?.areaId || ''), String(msg.args?.date || ''));
          sendResponse({ ok: true });
        } else if (msg.type === 'lib:book') sendResponse(await book(msg.args || {}));
        else sendResponse({ ok: false, error: `未知指令 ${msg.type}` });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true; // 异步回复
  });

  // 让扩展知道这页就绪（也是「能不能用」的信号）
  try {
    chrome.runtime.sendMessage({ type: 'lib:ready', href: location.href, hasToken: Boolean(token()) });
  } catch {
    /* 扩展没起来时会抛，忽略 */
  }
})();
