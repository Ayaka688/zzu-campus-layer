// 教务（教学管理平台）采集器。
//
// 实测：CAS 回调是把 30 天 idToken 放进 **URL**（`?idToken=<JWT>`），前端再把它落盘。
// 落盘形式不止一种，这里踩过的坑：
//   1. uni-app 的 H5 存储是 {"type":"string","data":"<jwt>"} 这种 JSON 包装，直接 split('.') 必然失配；
//   2. 键名会随版本变（token_key / idToken / X-Id-Token / userToken / access_token）；
//   3. token 可能只在 URL 里（页面还没落盘时），也可能只在 cookie 里；
//   4. 教务系统有时被门户用 iframe 嵌着，manifest 里对这条脚本开了 all_frames。
// 所以不认死某个键：把「看起来像 JWT 的值」从 URL → localStorage → sessionStorage → cookie 依次捞出来。
(() => {
  const SOURCE = 'jwxt';
  const KNOWN_KEYS = ['idToken', 'X-Id-Token', 'token_key', 'userToken', 'access_token'];
  const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

  /** 任何形态的值 → JWT 字符串（处理 URL 编码、引号、Bearer 前缀、uni-app JSON 包装）。 */
  function asJwt(raw) {
    if (typeof raw !== 'string') return null;
    let v = raw.trim();
    if (!v) return null;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v.startsWith('{')) {
      try {
        const obj = JSON.parse(v);
        // uni-app：{"type":"string","data":"..."}；其他包装里也可能叫 value/token
        for (const key of ['data', 'value', 'token', 'idToken', 'access_token']) {
          const inner = asJwt(obj && obj[key]);
          if (inner) return inner;
        }
        for (const key of Object.keys(obj || {})) {
          const inner = asJwt(obj[key]);
          if (inner) return inner;
        }
      } catch {
        /* 不是 JSON，继续往下试 */
      }
      return null;
    }
    v = v.replace(/^Bearer\s+/i, '');
    try {
      v = decodeURIComponent(v);
    } catch {
      /* 不是编码串就原样用 */
    }
    return JWT_RE.test(v) ? v : null;
  }

  /** CAS 常把 token 放在 ?idToken= 或 hash 里的 query（uni-app 用 #/ 路由）。 */
  function fromUrl() {
    const parts = [location.search, location.hash].filter(Boolean);
    for (const part of parts) {
      const hit = /[?&#](?:idToken|token|access_token)=([^&#]+)/i.exec(part);
      if (hit && hit[1]) {
        const token = asJwt(hit[1]);
        if (token) return token;
      }
    }
    return null;
  }

  function fromStore(store) {
    try {
      for (const key of KNOWN_KEYS) {
        const token = asJwt(store.getItem(key));
        if (token) return token;
      }
      // 兜底：键名可能又变了，扫一遍像 token 的键
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (!key || !/token|auth|jwt|user/i.test(key)) continue;
        const token = asJwt(store.getItem(key));
        if (token) return token;
      }
    } catch {
      /* 某些 iframe / 隐私模式下访问 storage 会抛错 */
    }
    return null;
  }

  function fromCookie() {
    for (const key of KNOWN_KEYS) {
      const hit = new RegExp('(?:^|;\\s*)' + key + '=([^;]+)').exec(document.cookie || '');
      if (hit && hit[1]) {
        const token = asJwt(hit[1]);
        if (token) return token;
      }
    }
    return null;
  }

  /** 依次从四处找，返回 { token, from }；都没有就 null。 */
  function sniff() {
    const url = fromUrl();
    if (url) return { token: url, from: 'url' };
    const ls = fromStore(localStorage);
    if (ls) return { token: ls, from: 'localStorage' };
    const ss = fromStore(sessionStorage);
    if (ss) return { token: ss, from: 'sessionStorage' };
    const ck = fromCookie();
    if (ck) return { token: ck, from: 'cookie' };
    return null;
  }

  let lastFrom = null;

  function push(reason) {
    const hit = sniff();
    if (!hit) return;
    lastFrom = hit.from;
    try {
      chrome.runtime.sendMessage({ type: 'token', source: SOURCE, token: hit.token, reason: reason + ':' + hit.from });
    } catch {
      /* 扩展被重载时 context 失效，忽略 */
    }
  }

  push('load');

  // CAS 回调 / SPA 路由切换都不会重新注入脚本 → 轮询两分钟兜底。
  let ticks = 0;
  const timer = setInterval(() => {
    push('poll');
    if (++ticks >= 24) clearInterval(timer);
  }, 5000);

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === 'ping') {
      const hit = sniff();
      reply({ ok: true, source: SOURCE, hasToken: Boolean(hit), from: hit ? hit.from : null });
    }
  });

  // 排查用：在教务页面控制台跑 __zzuTokenProbe()，能看到找到没、从哪找到、候选键名
  window.__zzuTokenProbe = () => {
    const hit = sniff();
    let keys = [];
    try {
      keys = Object.keys(localStorage).filter((k) => /token|auth|jwt|user/i.test(k));
    } catch {
      /* ignore */
    }
    return {
      found: Boolean(hit),
      from: hit ? hit.from : lastFrom,
      inUrl: Boolean(fromUrl()),
      keys,
      cookieNames: (document.cookie || '')
        .split(';')
        .map((s) => s.split('=')[0].trim())
        .filter(Boolean),
    };
  };
})();
