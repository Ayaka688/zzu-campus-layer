// cht.zzu.edu.cn —— 学校 DeepSeek(Open WebUI) 的页面。
// Open WebUI 把会话 JWT 放在 localStorage 的 "token" 里。
// 这里只做一件事：把会话交给扩展，用来一键换 API Key（免得用户手动粘贴）。
// 不读聊天内容、不改页面。
(() => {
  const seen = new Set();

  function pick() {
    const keys = ['token'];
    for (const k of keys) {
      let v = null;
      try {
        v = window.localStorage.getItem(k);
      } catch {
        /* 隐私模式下可能抛 */
      }
      if (typeof v === 'string' && v.split('.').length === 3 && v.length > 40) return v;
    }
    return null;
  }

  function push() {
    const token = pick();
    if (!token || seen.has(token)) return;
    seen.add(token);
    try {
      chrome.runtime.sendMessage({ type: 'token', source: 'chat', token });
    } catch {
      /* 扩展刚被 reload 时 sender 会失效，下一次轮询再试 */
    }
  }

  push();
  // SPA 登录成功后不会刷新页面，轮询兜底
  let n = 0;
  const timer = setInterval(() => {
    push();
    if (++n > 24) clearInterval(timer);
  }, 5000);
})();
