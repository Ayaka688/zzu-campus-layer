/**
 * 登录态「自己续一下」。
 *
 * 票本身很短：门户票 8 小时（教务那张 30 天是老 App 设备注册才签的，H5 拿不到）。
 * 但 CAS 那边的会话很长（TGC 14 天），所以只要拿它再走一次 CAS 就能换新票。
 *
 * 两条路，优先走快的：
 * 1. **fetch 快路**（`casMint.ts`）：一条 HTTPS 请求，CAS 会话还在就 302 带 ticket 回来。
 *    扩展里可用（host_permissions 豁免 CORS），不开标签页、不闪、200 ms 级。
 * 2. **标签页慢路**（本文件下半段）：PWA/网页版没有豁免时，后台开一个非激活标签页，
 *    让浏览器自己走 CAS，内容脚本把新票上报回来。
 *
 * 都不做定时任务：票快到期（<2 h）或有请求失败时才续，安卓上休眠多久都不影响。
 */
import { mintViaFetch } from './casMint';
import { saveToken, tokenStatuses, type TokenStatus } from './storage';

/** 冷却：同一段时间内只自动试一次（慢路用；快路另有秒级节流） */
const COOLDOWN_MS = 10 * 60_000;
/** 等 CAS 回跳 + 内容脚本上报的最长时间 */
const WAIT_MS = 20_000;
const POLL_MS = 400;
/** 票剩这么点时间就该换了（8 小时的票 → 用满 6 小时换新的） */
export const REFRESH_MARGIN_MS = 2 * 3_600_000;
/** 快路的秒级节流，免得并发请求各发一次 */
const MINT_THROTTLE_MS = 60_000;

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

/**
 * 该不该主动续：有票但快到期（< marginMs），或者票已经废了。
 * 一张票都没有时返回 false——那是「没登录」，该让用户去登，别空跑。
 */
export function needsRefresh(statuses: TokenStatus[], marginMs = REFRESH_MARGIN_MS): boolean {
  const present = statuses.filter((s) => s.present);
  if (present.length === 0) return false;
  return present.some((s) => !s.valid || (s.remainingMs ?? Number.POSITIVE_INFINITY) < marginMs);
}

/** 该不该自动续（慢路）：票全废 + 距上次尝试够久 */
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
    if (await mintIntoSession()) return true;
    return await renewFromCas();
  } catch {
    return false;
  }
}

/**
 * 票快过期 / 已过期时续一次（**按需**，不是定时任务）。
 *
 * - 没有票：什么都不做，返回 false（那是「没登录」，交给 UI 提示）。
 * - 有票且还剩 > marginMs：什么都不做，返回 true。
 * - 否则：fetch 快路（扩展）→ 标签页慢路（PWA）。
 */
export async function ensureFresh(marginMs = REFRESH_MARGIN_MS): Promise<boolean> {
  try {
    const statuses = await tokenStatuses();
    if (!needsRefresh(statuses, marginMs)) return hasUsableToken(statuses);
    return await ensureRenewed();
  } catch {
    return false;
  }
}

let mintingAt = 0;

/**
 * fetch 快路：CAS 会话还在就换一张新票，落库到 jwxt / portal 两个槽位
 * （实测同一张 idToken 两边都认，见 docs/cas-long-term-token.md §7）。
 * 换不到（会话过期、或不在扩展里）返回 false，调用方再走标签页慢路。
 */
export async function mintIntoSession(now = Date.now()): Promise<boolean> {
  if (now - mintingAt < MINT_THROTTLE_MS) return false;
  mintingAt = now;
  const minted = await mintViaFetch();
  if (!minted) return false;
  await saveToken('jwxt', minted.idToken);
  await saveToken('portal', minted.idToken);
  await writeLast(now);
  return true;
}
