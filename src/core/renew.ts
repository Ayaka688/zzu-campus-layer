/**
 * 登录态「自己续一下」。
 *
 * 现在的问题：门户票 8 小时、教务票 30 天，票一过期就得手动去登录页走一遍。
 * 但 CAS 那边是有会话的（勾了「记住我」之后能活很久），浏览器里还留着 CASTGC，
 * 所以只要拿它再走一次 CAS 拿新票就行——不用密码、不用用户操作。
 *
 * 做法：后台开一个**非激活**标签页到
 *   https://cas.s.zzu.edu.cn/cas/login?service=<教务首页>
 * 如果 CAS 会话还在，会 302 回教务页并带上 ?ticket=…，那边的内容脚本会把 token
 * 发回后台存起来；等到存储里出现新票就把标签页关掉。会话没了就停在登录页，
 * 超时关掉、返回 false，前端照旧提示「去登录一次」。
 *
 * 只在「手上的票全过期了、用户正好要问东西」时试，且有冷却，避免打扰。
 */
import { tokenStatuses, type TokenStatus } from './storage';

/** 冷却：同一段时间内只自动试一次 */
const COOLDOWN_MS = 10 * 60_000;
/** 等 CAS 回跳 + 内容脚本上报的最长时间 */
const WAIT_MS = 20_000;
const POLL_MS = 400;

export const CAS_LOGIN = 'https://cas.s.zzu.edu.cn/cas/login';
export const SERVICE_JWXT = 'https://jwxt.zzu.edu.cn/uniapp/index.html';

/** CAS 登录地址（过期后回跳，ticket 里带着新的 idToken）。 */
export function casRenewUrl(): string {
  return `${CAS_LOGIN}?service=${encodeURIComponent(SERVICE_JWXT)}`;
}

/** 手上还有没有能用的票 */
export function hasUsableToken(statuses: TokenStatus[]): boolean {
  return statuses.some((s) => s.present && s.valid);
}

/** 该不该自动续：票全废 + 距上次尝试够久 */
export function shouldRenew(statuses: TokenStatus[], lastAttempt: number, now = Date.now()): boolean {
  if (hasUsableToken(statuses)) return false;
  return now - lastAttempt >= COOLDOWN_MS;
}

const LAST_KEY = 'renewAt';

async function readLast(): Promise<number> {
  try {
    const got = await chrome.storage.local.get(LAST_KEY);
    const v = got[LAST_KEY];
    return typeof v === 'number' ? v : 0;
  } catch {
    return 0;
  }
}

async function writeLast(now: number): Promise<void> {
  try {
    await chrome.storage.local.set({ [LAST_KEY]: now });
  } catch {
    /* 存不下就算了，最多多试一次 */
  }
}

function stamp(statuses: TokenStatus[]): string {
  return statuses.map((s) => `${s.source}:${s.valid ? 1 : 0}:${s.expText ?? ''}`).join('|');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 试着用 CAS 会话换一张新票。成功（存储里出现可用的票）返回 true。
 * 只在扩展里可用；网页版 PWA 没有 chrome.tabs，直接返回 false。
 */
export async function renewFromCas(now = Date.now()): Promise<boolean> {
  if (shouldRenew(await tokenStatuses(now), await readLast(), now) === false) return false;
  if (typeof chrome === 'undefined' || !chrome.tabs?.create) return false;

  await writeLast(now);
  const before = stamp(await tokenStatuses());
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: casRenewUrl(), active: false });
    tabId = tab.id;
  } catch {
    return false;
  }

  try {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const statuses = await tokenStatuses();
      if (hasUsableToken(statuses) && stamp(statuses) !== before) return true;
    }
    return false;
  } finally {
    if (tabId !== undefined) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* 用户可能自己关了 */
      }
    }
  }
}

/** 后台在「要回答问题」之前调一下：能续就续，续不上就算了。 */
export async function ensureRenewed(): Promise<boolean> {
  try {
    return await renewFromCas();
  } catch {
    return false;
  }
}
