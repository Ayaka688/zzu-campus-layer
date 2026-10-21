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
