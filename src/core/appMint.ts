/**
 * App 端换票（`/token/` 域）：学号 + 密码 → **30 天**的 idToken。
 *
 * 和 `casMint.ts` 的区别：那条路靠浏览器里的 CAS 会话（TGC 14 天）换 8 小时的票；
 * 这条路是学校「豫见郑大」App 的接口，密码换的票直接给 30 天，还能同时拿一张 60 天的
 * refreshToken（目前没找到可用的刷新端点，到期重新换即可，反正不用人工）。
 *
 * 协议（2026-10 实测，见 docs/cas-long-term-token.md §11）：
 *   1. GET  /token/jwt/publicKey                 → RSA 公钥（和 /cas/ 那把是同一把）
 *   2. POST /token/mfa/detect?username&password&deviceId → { need, state }
 *      `need:false` 表示这台设备已被登记成可信设备，可以直接登录；
 *      `need:true` 说明这台设备还没过 MFA，得走一次短信（脚本 scripts/app-login.mjs），
 *      过完之后同一个 deviceId 就永久免 MFA 了。
 *   3. POST /token/password/passwordLogin?username&password&appId&osType&geo&deviceId&clientId&mfaState
 *      → { code:0, data:{ idToken, refreshToken } }
 * 密码要 RSA **PKCS#1 v1.5** 加密、base64 后加 `__RSA__` 前缀——WebCrypto 只支持 OAEP，
 * 所以这里自己实现了 v1.5 填充 + 模幂（只有 e=65537，17 次平方，够快）。
 *
 * 跨域：cas.s.zzu.edu.cn 不给 CORS 头，所以只有扩展（host_permissions 豁免）能直接 fetch；
 * 网页版 PWA 里 `mintViaApp()` 会拿到网络错误，调用方按「没换成」处理（安卓壳是在 Java 里换的）。
 */
import { decodeJwt } from './jwt';

export const APP_UA = 'SWSuperApp/1.1.1()';
export const APP_ID = 'com.supwisdom.zzu';
export const APP_OS = 'android';
export const APP_KEY_URL = 'https://cas.s.zzu.edu.cn/token/jwt/publicKey';
export const APP_DETECT_URL = 'https://cas.s.zzu.edu.cn/token/mfa/detect';
export const APP_LOGIN_URL = 'https://cas.s.zzu.edu.cn/token/password/passwordLogin';

/** 换票需要的三样东西。deviceId 一旦登记成可信设备就别改了，改了要重新过 MFA。 */
export interface AppCreds {
  account: string;
  password: string;
  deviceId: string;
}

export type AppMintOutcome =
  | { ok: true; idToken: string; refreshToken?: string; expMs?: number }
  /** mfa=这台设备没过验证；rejected=账号密码不对；network=请求没成功（多半是跨域/断网） */
  | { ok: false; reason: 'mfa' | 'rejected' | 'network'; detail?: string };

// ---- base64（不依赖 btoa/atob，Node 与浏览器一致） ----

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64_CHARS[(n >> 18) & 63] ?? '';
    out += B64_CHARS[(n >> 12) & 63] ?? '';
    out += i + 1 < bytes.length ? B64_CHARS[(n >> 6) & 63] ?? '' : '=';
    out += i + 2 < bytes.length ? B64_CHARS[n & 63] ?? '' : '=';
  }
  return out;
}

export function base64Decode(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64_CHARS.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

// ---- DER：从 SPKI 公钥里抠出 n / e ----

interface Tlv {
  tag: number;
  bodyStart: number;
  bodyEnd: number;
}

function readTlv(buf: Uint8Array, pos: number): Tlv {
  const tag = buf[pos] ?? 0;
  let p = pos + 1;
  let len = buf[p] ?? 0;
  p += 1;
  if (len & 0x80) {
    const count = len & 0x7f;
    len = 0;
    for (let i = 0; i < count; i += 1) len = (len << 8) | (buf[p + i] ?? 0);
    p += count;
  }
  return { tag, bodyStart: p, bodyEnd: p + len };
}

function children(buf: Uint8Array, of: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let p = of.bodyStart;
  while (p < of.bodyEnd) {
    const t = readTlv(buf, p);
    out.push(t);
    if (t.bodyEnd <= p) break; // 畸形 DER，别死循环
    p = t.bodyEnd;
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function bigIntToBytes(value: bigint, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let v = value;
  for (let i = size - 1; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export interface RsaPublicKey {
  n: bigint;
  e: bigint;
  /** 模长（字节），PKCS#1 填充要用 */
  size: number;
}

/** 解 PEM 或裸 base64 的 SPKI 公钥（学校返回的是裸 base64，444 字符）。 */
export function parsePublicKey(pemOrB64: string): RsaPublicKey {
  const body = pemOrB64.replace(/-----[^-]*-----/g, '').replace(/\s+/g, '');
  if (!body) throw new Error('公钥是空的');
  const der = base64Decode(body);
  const spki = readTlv(der, 0);
  const parts = children(der, spki);
  const bitString = parts[1];
  if (!bitString) throw new Error('公钥不是 SubjectPublicKeyInfo');
  // BIT STRING 前面有一个「未使用位数」字节
  const inner = readTlv(der, bitString.bodyStart + 1);
  const nums = children(der, inner);
  const nTlv = nums[0];
  const eTlv = nums[1];
  if (!nTlv || !eTlv) throw new Error('公钥里没有 n / e');
  const n = bytesToBigInt(der.slice(nTlv.bodyStart, nTlv.bodyEnd));
  const e = bytesToBigInt(der.slice(eTlv.bodyStart, eTlv.bodyEnd));
  const hex = n.toString(16);
  return { n, e, size: Math.ceil(hex.length / 2) };
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function randomNonZero(count: number): Uint8Array {
  const out = new Uint8Array(count);
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new Error('当前环境没有 crypto.getRandomValues');
  for (let i = 0; i < count; i += 1) {
    let v = 0;
    while (v === 0) v = c.getRandomValues(new Uint8Array(1))[0] ?? 0;
    out[i] = v;
  }
  return out;
}

/** PKCS#1 v1.5 加密 → base64 → 前缀 `__RSA__`（学校这套接口要的形态）。 */
export function rsaEncrypt(key: RsaPublicKey, plain: string): string {
  const msg = new TextEncoder().encode(plain);
  const padLen = key.size - msg.length - 3;
  if (padLen < 8) throw new Error('明文太长，塞不进这个模长');
  const block = new Uint8Array(key.size);
  block[0] = 0x00;
  block[1] = 0x02;
  block.set(randomNonZero(padLen), 2);
  block[2 + padLen] = 0x00;
  block.set(msg, 3 + padLen);
  const c = modPow(bytesToBigInt(block), key.e, key.n);
  return `__RSA__${base64Encode(bigIntToBytes(c, key.size))}`;
}

// ---- 网络 ----

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

async function loadKey(timeoutMs: number): Promise<RsaPublicKey> {
  const res = await fetchWithTimeout(APP_KEY_URL, { headers: { 'User-Agent': 'okhttp/3.12.1' } }, timeoutMs);
  if (!res.ok) throw new Error(`公钥请求失败：HTTP ${res.status}`);
  return parsePublicKey(await res.text());
}

interface DetectPayload {
  code?: number;
  data?: { need?: boolean; state?: string; mfaTypeSecurePhone?: boolean };
}

interface LoginPayload {
  code?: number;
  message?: string;
  data?: { idToken?: string; refreshToken?: string };
}

/** 这台设备要不要过 MFA。返回 need/state；请求失败抛异常（调用方接住当 network 处理）。 */
export async function appDetect(
  creds: AppCreds,
  timeoutMs = 12_000,
): Promise<{ need: boolean; state: string; key: RsaPublicKey }> {
  const key = await loadKey(timeoutMs);
  const q = new URLSearchParams({
    username: rsaEncrypt(key, creds.account),
    password: rsaEncrypt(key, creds.password),
    deviceId: creds.deviceId,
  });
  const res = await fetchWithTimeout(
    `${APP_DETECT_URL}?${q.toString()}`,
    { method: 'POST', headers: { 'User-Agent': APP_UA } },
    timeoutMs,
  );
  const payload = (await res.json().catch(() => ({}))) as DetectPayload;
  return {
    need: payload.data?.need !== false,
    state: typeof payload.data?.state === 'string' ? payload.data.state : '',
    key,
  };
}

/** 真正换票。`need:false`（可信设备）时一条请求就够。 */
export async function mintViaApp(creds: AppCreds, timeoutMs = 12_000): Promise<AppMintOutcome> {
  let key: RsaPublicKey;
  let state: string;
  try {
    const detect = await appDetect(creds, timeoutMs);
    key = detect.key;
    state = detect.state;
    if (detect.need) return { ok: false, reason: 'mfa' };
  } catch (err) {
    return { ok: false, reason: 'network', detail: err instanceof Error ? err.message : String(err) };
  }

  const login = new URLSearchParams({
    username: rsaEncrypt(key, creds.account),
    password: rsaEncrypt(key, creds.password),
    appId: APP_ID,
    osType: APP_OS,
    geo: '',
    deviceId: creds.deviceId,
    clientId: '',
    mfaState: state,
  });
  try {
    const res = await fetchWithTimeout(
      `${APP_LOGIN_URL}?${login.toString()}`,
      { method: 'POST', headers: { 'User-Agent': APP_UA } },
      timeoutMs,
    );
    const payload = (await res.json().catch(() => ({}))) as LoginPayload;
    const idToken = payload.data?.idToken ?? '';
    if (!idToken) {
      return { ok: false, reason: 'rejected', detail: payload.message ?? `HTTP ${res.status}` };
    }
    let expMs: number | undefined;
    try {
      const claims = decodeJwt(idToken);
      if (typeof claims?.exp === 'number') expMs = claims.exp * 1000;
    } catch {
      /* 解不开就只给票 */
    }
    const refreshToken = payload.data?.refreshToken;
    return {
      ok: true,
      idToken,
      ...(typeof refreshToken === 'string' && refreshToken ? { refreshToken } : {}),
      ...(expMs !== undefined ? { expMs } : {}),
    };
  } catch (err) {
    return { ok: false, reason: 'network', detail: err instanceof Error ? err.message : String(err) };
  }
}
