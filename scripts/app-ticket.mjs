// App 端换票：学号 + 密码 → **30 天**的 X-Id-Token。
//
// 这是学校「豫见郑大」App 用的接口族（`/token/...`），跟网页 CAS（`/cas/...`）是两套：
//   1. GET  /token/jwt/publicKey                → RSA 公钥
//   2. POST /token/mfa/detect?username&password&deviceId → { need, state }
//      need:false = 这台设备已被登记成可信设备，可以直接登录（不用验证码）
//   3. POST /token/password/passwordLogin?username&password&appId&osType&geo&deviceId&clientId&mfaState
//      → { data: { idToken（30 天）, refreshToken（60 天） } }
// 密码要 RSA PKCS#1 v1.5 加密后加 `__RSA__` 前缀，也就是 Encrypt 之后 URL 编码。
//
// 第一次要先跑一次 scripts/app-login.mjs（一次短信验证把设备登记成可信设备），
// 之后这里就不用任何人工了。实测一张票 30 天，到期前重跑一次即可（也可以 cron，但没必要）。
//
// 用法：
//   node scripts/app-ticket.mjs                 # 需要就换一张（剩不到 48h 才换），落盘
//   node scripts/app-ticket.mjs --force         # 不管剩多久都换
//   node scripts/app-ticket.mjs --verify        # 换完打一发 eams-door 验证
//   node scripts/app-ticket.mjs --json          # 只输出 JSON（给别的脚本吃）
//   node scripts/app-ticket.mjs --if-stale=24   # 剩不到 24h 才换
//
// 状态目录（默认 .cas-state/，可用 ZZU_STATE_DIR 覆盖）：
//   app.json              学号 / 密码 / deviceId / 可信设备登记时间（= 凭据文件，别外传）
//   app-idtoken.txt       最近一次拿到的 30 天票
//   app-refreshtoken.txt  最近一次拿到的刷新票（目前没有可用的刷新端点，留着备查）
//   app-meta.json         时间戳 / ttl / deviceId / 剩余小时
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = process.env.ZZU_STATE_DIR || path.join(HERE, '..', '.cas-state');
const BASE = 'https://cas.s.zzu.edu.cn';
export const APP_UA = 'SWSuperApp/1.1.1()';
const APP_ID = 'com.supwisdom.zzu';
const OS_TYPE = 'android';
const STATE_PATH = path.join(STATE_DIR, 'app.json');
const TOKEN_PATH = path.join(STATE_DIR, 'app-idtoken.txt');
const REFRESH_PATH = path.join(STATE_DIR, 'app-refreshtoken.txt');
const META_PATH = path.join(STATE_DIR, 'app-meta.json');
const log = (...a) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${a.join(' ')}\n`);

// ---- 状态文件 ----

export function loadAppState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return { account: s.account || '', password: s.password || '', deviceId: s.deviceId || '', trustedAt: s.trustedAt || null };
  } catch {
    return { account: '', password: '', deviceId: '', trustedAt: null };
  }
}

export function saveAppState(patch) {
  const next = { ...loadAppState(), ...patch };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 1), 'utf8');
  return next;
}

export function newDeviceId() {
  return `zzu-layer-${crypto.randomBytes(8).toString('hex')}`;
}

/** 凭据：环境变量 > app.json > .cas-state/creds.json（与 cas-login 共用同一份） */
export function loadCreds() {
  const state = loadAppState();
  let c = {};
  const shared = path.join(STATE_DIR, 'creds.json');
  if (fs.existsSync(shared)) {
    try { c = JSON.parse(fs.readFileSync(shared, 'utf8')); } catch { /* ignore */ }
  }
  const account = process.env.ZZU_USER || state.account || c.username || c.account || '';
  const password = process.env.ZZU_PASS || state.password || c.password || '';
  const deviceId = process.env.ZZU_DEVICE_ID || state.deviceId || '';
  if (!account || !password) {
    throw new Error(`缺少凭据：设 ZZU_USER/ZZU_PASS，或写 ${STATE_PATH}（先跑一次 scripts/app-login.mjs）`);
  }
  return { account, password, deviceId: deviceId || newDeviceId() };
}

// ---- 协议 ----

const b64 = (s) => Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8');
const decodeJwt = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));

export async function fetchPublicKey() {
  const r = await fetch(`${BASE}/token/jwt/publicKey`, { headers: { 'User-Agent': 'okhttp/3.12.1' } });
  const body = (await r.text()).trim();
  if (!r.ok || !body) throw new Error(`公钥请求失败：HTTP ${r.status}`);
  if (body.includes('BEGIN')) return body;
  return `-----BEGIN PUBLIC KEY-----\n${body.replace(/(.{1,64})/g, '$1\n').trim()}\n-----END PUBLIC KEY-----\n`;
}

/** RSA PKCS#1 v1.5 → base64 → `__RSA__` 前缀 */
export function rsaEncrypt(pem, plain) {
  const pad = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(plain, 'utf8'));
  return `__RSA__${pad.toString('base64')}`;
}

async function getJson(url, { method = 'POST' } = {}) {
  const r = await fetch(url, { method, headers: { 'User-Agent': APP_UA, Accept: 'application/json, text/plain, */*' } });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, body, text };
}

/** detect：这台设备要不要过 MFA。返回 { need, state }。 */
export async function detectMfa({ account, password, deviceId }) {
  const pem = await fetchPublicKey();
  const q = new URLSearchParams({
    username: rsaEncrypt(pem, account),
    password: rsaEncrypt(pem, password),
    deviceId,
  });
  const r = await getJson(`${BASE}/token/mfa/detect?${q.toString()}`);
  if (r.status !== 200 || !r.body) throw new Error(`detect 失败：HTTP ${r.status} ${r.text.slice(0, 120)}`);
  const data = r.body.data || {};
  return { need: data.need !== false, state: data.state || '', raw: r.body };
}

/** 真正的登录：返回 { idToken, refreshToken }。need 必须已经满足（可信设备或刚过完 MFA）。 */
export async function passwordLogin({ account, password, deviceId }, state) {
  const pem = await fetchPublicKey();
  const q = new URLSearchParams({
    username: rsaEncrypt(pem, account),
    password: rsaEncrypt(pem, password),
    appId: APP_ID,
    osType: OS_TYPE,
    geo: '',
    deviceId,
    clientId: '',
    mfaState: state || '',
  });
  const r = await getJson(`${BASE}/token/password/passwordLogin?${q.toString()}`);
  const data = r.body?.data || {};
  if (r.body?.code !== 0 || !data.idToken) {
    const err = new Error(`登录失败：HTTP ${r.status} ${r.body?.message || r.text.slice(0, 160)}`);
    err.mfa = String(r.body?.message || '').includes('mfa.verify.error');
    throw err;
  }
  return { idToken: data.idToken, refreshToken: data.refreshToken || '' };
}

/** 换一张票（不发短信、不看浏览器）。落盘并返回元信息。 */
export async function mintAppToken(creds, { persist = true } = {}) {
  const det = await detectMfa(creds);
  if (det.need) {
    const err = new Error(
      `这台设备（${creds.deviceId}）还没过 MFA：先跑一次 node scripts/app-login.mjs 完成短信验证`,
    );
    err.needsLogin = true;
    throw err;
  }
  const t0 = Date.now();
  const { idToken, refreshToken } = await passwordLogin(creds, det.state);
  const ms = Date.now() - t0;
  const idp = decodeJwt(idToken);
  const rp = refreshToken ? decodeJwt(refreshToken) : null;
  const meta = {
    mintedAt: new Date().toISOString(),
    ms,
    deviceId: creds.deviceId,
    account: creds.account,
    idTokenLen: idToken.length,
    jwt: {
      iat: idp.iat ?? null,
      exp: idp.exp ?? null,
      ttlH: idp.iat && idp.exp ? +((idp.exp - idp.iat) / 3600).toFixed(2) : null,
      req: idp.req ?? null,
      deviceId: idp.deviceId ?? null,
      jti: idp.jti ?? null,
    },
    refresh: rp ? { exp: rp.exp ?? null, ttlH: rp.iat && rp.exp ? +((rp.exp - rp.iat) / 3600).toFixed(2) : null } : null,
    leftH: idp.exp ? +((idp.exp * 1000 - Date.now()) / 3600e3).toFixed(2) : null,
  };
  if (persist) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    saveAppState({ account: creds.account, password: creds.password, deviceId: creds.deviceId });
    fs.writeFileSync(TOKEN_PATH, idToken, 'utf8');
    fs.writeFileSync(REFRESH_PATH, refreshToken, 'utf8');
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 1), 'utf8');
  }
  return { idToken, refreshToken, idp, meta };
}

export function readAppMeta() {
  try { return JSON.parse(fs.readFileSync(META_PATH, 'utf8')); } catch { return null; }
}

/**
 * 按需换票：票还够新就直接用文件里那张，不发请求。
 * 30 天的票 → 默认剩不到 48h 才换，一天跑几次都白嫖本地文件。
 */
export async function ensureAppToken({ minLeftH = 48, force = false } = {}) {
  const meta = readAppMeta();
  if (!force && !process.env.ZZU_FORCE_MINT && meta?.jwt?.exp) {
    const leftH = (meta.jwt.exp * 1000 - Date.now()) / 3600e3;
    if (leftH > minLeftH && fs.existsSync(TOKEN_PATH)) {
      const idToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
      if (idToken) return { idToken, reused: true, meta, leftH: +leftH.toFixed(2) };
    }
  }
  const out = await mintAppToken(loadCreds());
  return { ...out, reused: false, leftH: out.meta.leftH };
}

export async function verifyToken(idToken, url = 'https://jwxt.zzu.edu.cn/eams-door/api/v1/portal/home/user-info') {
  const r = await fetch(url, {
    headers: { 'X-Id-Token': idToken, Accept: 'application/json, text/plain, */*', Referer: 'https://jwxt.zzu.edu.cn/' },
  });
  return { status: r.status, body: await r.text() };
}

/** 可信设备还剩多少天（我们只记「什么时候登记的」，服务端有效期未知） */
export function deviceStatus() {
  const s = loadAppState();
  if (!s.deviceId) return null;
  const at = s.trustedAt ? Date.parse(s.trustedAt) : null;
  return {
    deviceId: s.deviceId,
    trustedAt: s.trustedAt,
    trustedDays: at ? +((Date.now() - at) / 864e5).toFixed(1) : null,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  (async () => {
    const force = process.argv.includes('--force');
    const staleArg = process.argv.find((a) => a.startsWith('--if-stale'));
    let minLeftH = 48;
    if (staleArg && staleArg.includes('=')) minLeftH = Number(staleArg.split('=')[1]);
    const out = await ensureAppToken({ minLeftH, force });
    const { idToken } = out;
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify({ idToken, reused: out.reused, leftH: out.leftH, ...out.meta }, null, 1) + '\n');
    } else {
      log(out.reused ? `reuse（缓存票还新鲜，剩 ${out.leftH}h）` : `mint ok（${out.meta.ms}ms）`,
        '· len', idToken.length,
        '· exp', out.meta.jwt?.exp ? new Date(out.meta.jwt.exp * 1000).toISOString() : '?',
        '· left h', out.leftH,
        '· deviceId', out.meta.deviceId);
      const d = deviceStatus();
      if (d?.trustedAt) log(`可信设备登记于 ${d.trustedAt}（${d.trustedDays} 天前）；设备 ID ${d.deviceId}`);
    }
    if (process.argv.includes('--verify')) {
      const v = await verifyToken(idToken);
      log('eams-door', v.status, v.body.slice(0, 140).replace(/\s+/g, ' '));
      if (v.status !== 200) process.exitCode = 2;
    }
  })().catch((e) => { console.error('FAILED:', e.message); process.exit(e.needsLogin ? 3 : 1); });
}
