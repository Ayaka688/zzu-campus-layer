// 门户（豫见郑大）采集器：只读 cookie 里的 userToken，不做任何 DOM 解析。
// 说明：该站把 CAS 换来的 JWT 写在非 HttpOnly 的 userToken cookie 中，
// 内容脚本是唯一能读到它的地方（扩展 SW 不能直接读 document.cookie）。
(() => {
  const SOURCE = 'portal';

  /** @returns {string|null} */
  function readToken() {
    const m = document.cookie.match(/(?:^|;\s*)userToken=([^;]+)/);
    if (!m || !m[1]) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }

  function push(reason) {
    const token = readToken();
    if (!token) return;
    try {
      chrome.runtime.sendMessage({ type: 'token', source: SOURCE, token, reason });
    } catch {
      /* 扩展被重载时 context 失效，忽略 */
    }
  }

  push('load');

  // 命中 CAS 回调后 cookie 才出现，SPA 路由切换也不会重新注入脚本 -> 轮询一段时间兜底。
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
