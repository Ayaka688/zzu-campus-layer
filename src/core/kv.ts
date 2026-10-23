/**
 * 极小的键值存储抽象。
 * 扩展里是 `chrome.storage.local`，网页（PWA）里是 `localStorage`。
 * 之所以单独抽出来：`src/core/*` 要同时跑在扩展和手机网页里，不能直接吃 `chrome.*`。
 */

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

const PREFIX = 'campus-layer:';

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
}

const chromeKV: KV = {
  async get<T>(key: string) {
    const got = await chrome.storage.local.get(key);
    return got[key] as T | undefined;
  },
  async set(key: string, value: unknown) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key: string) {
    await chrome.storage.local.remove(key);
  },
};

const localKV: KV = {
  async get<T>(key: string) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
      return undefined;
    }
  },
  async set(key: string, value: unknown) {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  },
  async remove(key: string) {
    localStorage.removeItem(PREFIX + key);
  },
};

/** 当前环境可用的存储。每次调用都重新判断，便于测试里换环境。 */
export function getKV(): KV {
  return hasChromeStorage() ? chromeKV : localKV;
}

/** 手机端「整套登录态」的导出/导入格式（一次性粘贴）。 */
export interface BundleLlm {
  apiKey: string;
  /** 预设 id（school/deepseek/…），空 = 学校 */
  provider?: string;
  model?: string;
  enabled?: boolean;
}

export interface TokenBundle {
  v: 1;
  jwxt?: string;
  portal?: string;
  /** 模型的 key 与预设：桌面端填过一次，手机端就不用再填。 */
  llm?: BundleLlm;
  at: number;
}

export function encodeBundle(bundle: TokenBundle): string {
  const json = JSON.stringify(bundle);
  // 只含 ASCII（JWT 是 base64url），直接 btoa 即可
  return btoa(json).replace(/=+$/, '');
}

export function decodeBundle(code: string): TokenBundle {
  const trimmed = code.trim().replace(/\s+/g, '');
  const padded = trimmed + '='.repeat((4 - (trimmed.length % 4)) % 4);
  let parsed: Partial<TokenBundle>;
  try {
    parsed = JSON.parse(atob(padded)) as Partial<TokenBundle>;
  } catch {
    throw new Error('这段验证码不是本项目的格式');
  }
  if (parsed.v !== 1) throw new Error('这段验证码不是本项目的格式');
  const jwxt = typeof parsed.jwxt === 'string' && parsed.jwxt.split('.').length === 3 ? parsed.jwxt : undefined;
  const portal = typeof parsed.portal === 'string' && parsed.portal.split('.').length === 3 ? parsed.portal : undefined;
  const rawLlm = (parsed as { llm?: unknown }).llm;
  let llm: BundleLlm | undefined;
  if (rawLlm && typeof rawLlm === 'object') {
    const o = rawLlm as Record<string, unknown>;
    if (typeof o.apiKey === 'string' && o.apiKey.startsWith('sk-')) {
      llm = {
        apiKey: o.apiKey,
        ...(typeof o.provider === 'string' && o.provider ? { provider: o.provider } : {}),
        ...(typeof o.model === 'string' && o.model ? { model: o.model } : {}),
        ...(typeof o.enabled === 'boolean' ? { enabled: o.enabled } : {}),
      };
    }
  }
  if (!jwxt && !portal) throw new Error('这段验证码里没有可用的登录态');
  return {
    v: 1,
    ...(jwxt ? { jwxt } : {}),
    ...(portal ? { portal } : {}),
    ...(llm ? { llm } : {}),
    at: Date.now(),
  };
}

/** 三段式 JWT 的最简判据（不校验签名，只看结构） */
const looksJwt = (v: string): boolean => v.split('.').length === 3 && v.length > 20;

/**
 * 从「手机上粘过来的东西」里认出登录态。
 *
 * 支持三种粘贴内容：
 *  - 学校页面的完整地址（…/uniapp/index.html?idToken=eyJ…），手机上登录完直接复制地址栏即可；
 *  - 直接粘 X-Id-Token（eyJ…）；
 *  - 桌面面板生成的同步码（base64 bundle，走 decodeBundle）。
 *
 * ticket= 是一次性 CAS 服务票据，不是 idToken，所以明确拒绝并给出替代办法。
 */
export function parseImportLink(raw: string): TokenBundle {
  const text = raw.trim();
  if (!text) throw new Error('粘的东西是空的');

  /* 1) 同步码（base64 bundle） */
  if (!/^https?:/i.test(text) && !looksJwt(text) && /^[A-Za-z0-9+/=_-]+$/.test(text) && text.length > 40) {
    try {
      return decodeBundle(text);
    } catch {
      /* 不是同步码，继续往下试 */
    }
  }

  /* 2) 直接就是 token */
  if (looksJwt(text)) return { v: 1, jwxt: text, at: Date.now() };

  /* 3) 学校页面的地址 */
  if (/^https?:/i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error('这段链接看起来不完整，重新复制一次地址栏');
    }
    const hash = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : '';
    const params = new URLSearchParams(url.search || hash);
    for (const key of ['idToken', 'userToken', 'token', 'X-Id-Token']) {
      const v = params.get(key);
      if (v && looksJwt(v)) return { v: 1, jwxt: v, at: Date.now() };
    }
    if (hash) {
      const q = new URLSearchParams(hash.startsWith('?') ? hash.slice(1) : hash);
      for (const key of ['idToken', 'userToken', 'token']) {
        const v = q.get(key);
        if (v && looksJwt(v)) return { v: 1, jwxt: v, at: Date.now() };
      }
    }
    if (params.get('ticket') || url.search.includes('ticket=')) {
      throw new Error('这是 CAS 的一次性 ticket（已经用掉了），要复制登录成功之后那一页的地址，里面才有 idToken');
    }
    throw new Error('这个链接里没有 idToken。手机上登录后停在「教学管理平台」首页，再复制地址栏');
  }

  throw new Error('没认出这是什么。可以粘学校页面的地址、eyJ… 开头的 token，或桌面生成的同步码');
}
