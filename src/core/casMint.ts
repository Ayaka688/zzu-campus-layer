/**
 * 用浏览器里现成的 CAS 会话，**一条 fetch** 换一张新票——不开标签页、不走内容脚本。
 *
 * 原理（2026-10 实测，见 docs/cas-long-term-token.md）：
 *   GET https://cas.s.zzu.edu.cn/cas/s/login?service=https://uniapp.s.zzu.edu.cn/
 *   - CAS 会话（TGC，14 天）还在 → 302 到 https://uniapp.s.zzu.edu.cn/?…&ticket=<JWT>
 *     这个 ticket 的 payload 里就是 idToken；
 *   - 会话没了 → 停在 /cas/a/login，地址里没有 ticket，返回 null。
 *
 * 扩展里能这么干是因为 manifest 给了 cas.s.zzu.edu.cn / uniapp.s.zzu.edu.cn 的
 * host_permissions（带 Cookie 跨站请求、且能读到重定向后的 response.url）。
 * 网页版 PWA 没有这个豁免（CAS 不给我们 ACAO），所以 `canMintInBrowser()` 返回 false，
 * 由调用方退回老办法（后台标签页 / 壳内登录）。
 */
import { decodeJwt } from './jwt';

/** 只有「前端站」形态的 service 会签出 JWT ticket（jwxt 域只给不透明 ST-xxxx）。 */
export const CAS_SERVICE = 'https://uniapp.s.zzu.edu.cn/';
export const CAS_MINT_URL = `https://cas.s.zzu.edu.cn/cas/s/login?service=${encodeURIComponent(CAS_SERVICE)}`;

export interface Minted {
  idToken: string;
  ticket: string;
  expMs?: number;
}

/** URL 里抠出来的 ticket 常常是编码过的，先还原一次（多重编码不管，CAS 不会那么拧） */
function safeDecode(raw: string): string {
  if (!raw) return '';
  try {
    return raw.includes('%') ? decodeURIComponent(raw) : raw;
  } catch {
    return raw;
  }
}

/** ticket（JWT 形态）→ payload.idToken。不是这种票就返回 null。 */
export function idTokenFromTicket(raw: string): Minted | null {
  const ticket = safeDecode(raw);
  if (!ticket || ticket.split('.').length !== 3) return null;
  let payload: { idToken?: unknown } | null = null;
  try {
    payload = decodeJwt(ticket) as { idToken?: unknown } | null;
  } catch {
    return null; // 段数对但解不出来（乱码、篡改过）
  }
  const idToken = typeof payload?.idToken === 'string' ? payload.idToken : '';
  if (!idToken) return null;
  let expMs: number | undefined;
  try {
    const claims = decodeJwt(idToken);
    if (typeof claims?.exp === 'number') expMs = claims.exp * 1000;
  } catch {
    /* 内层解不开就只给票，不拦着用 */
  }
  return { idToken, ticket, ...(expMs !== undefined ? { expMs } : {}) };
}

/** 从 CAS 回跳地址里抠 ticket，例如 …/index.html?ticket=eyJhbGci…（hash 里的 query 也算） */
export function idTokenFromUrl(url: string): Minted | null {
  if (!url) return null;
  const candidates: string[] = [];
  try {
    const u = new URL(url);
    candidates.push(...u.searchParams.getAll('ticket'));
    const hashQ = u.hash.indexOf('?');
    if (hashQ >= 0) candidates.push(...new URLSearchParams(u.hash.slice(hashQ + 1)).getAll('ticket'));
  } catch {
    return null;
  }
  for (const t of candidates) {
    const hit = idTokenFromTicket(t);
    if (hit) return hit;
  }
  return null;
}

/** 扩展环境（有 host_permissions 豁免）；网页版 PWA / 普通页面为 false。 */
export function canMintInBrowser(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
}

/**
 * 静默换票。成功返回 idToken，CAS 会话不在了返回 null（不发异常，调用方自己决定怎么办）。
 * 超时 12 s：CAS 正常回 302 是毫秒级的，慢成这样基本是网络问题。
 */
export async function mintViaFetch(timeoutMs = 12_000): Promise<Minted | null> {
  if (!canMintInBrowser()) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(CAS_MINT_URL, {
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      signal: ac.signal,
    });
    // 跟随重定向后 response.url 就是最终地址；ticket 在里面。
    const fromUrl = idTokenFromUrl(res.url || '');
    if (fromUrl) return fromUrl;
    // 少数情况（被拦截成 200 + 登录页 HTML）再试一次正文里的 <script> 跳转串
    const text = await res.text().catch(() => '');
    const m = /[?&]ticket=([A-Za-z0-9._-]+)/.exec(text.slice(0, 4000));
    return m?.[1] ? idTokenFromTicket(m[1]) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
