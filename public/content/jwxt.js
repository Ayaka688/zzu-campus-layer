// 教务（教学管理平台）采集器：token 可能落在 localStorage 的几个键上，也可能在 cookie 里。
// 实测：localStorage 的 token_key / idToken / X-Id-Token，以及 cookie 的 X-Id-Token。
(() => {
  const SOURCE = 'jwxt';
  const KEYS = ['idToken', 'X-Id-Token', 'token_key', 'userToken'];

  /** @returns {string|null} */
  function readToken() {
    for (const key of KEYS) {
      const v = localStorage.getItem(key);
      if (v && v.split('.').length === 3) return v;
    }
    for (const key of KEYS) {
      const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + key + '=([^;]+)'));
      if (m && m[1]) {
        const v = decodeURIComponent(m[1]);
        if (v.split('.').length === 3) return v;
      }
    }
    return null;
  }

  function push(reason) {
    const token = readToken();
    if (!token) return;
    try {
      chrome.runtime.sendMessage({ type: 'token', source: SOURCE, token, reason });
    } catch {
      /* ignore */
    }
  }

  push('load');

  let ticks = 0;
  const timer = setInterval(() => {
    push('poll');
    if (++ticks >= 24) clearInterval(timer);
  }, 5000);

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === 'ping') {
      reply({ ok: true, source: SOURCE, hasToken: Boolean(readToken()) });
    }
  });
})();
