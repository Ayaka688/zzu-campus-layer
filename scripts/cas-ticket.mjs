// CAS 静默换票：用 TGC（CAS 长效 SSO cookie）换 jwxt 能认的 X-Id-Token。
//
// 原理（2026-10 实测，见 docs/cas-long-term-token.md）：
//   GET https://cas.s.zzu.edu.cn/cas/s/login?service=https://uniapp.s.zzu.edu.cn/
//     → 302 Location 带 ticket=<JWT>，payload.idToken 就是 X-Id-Token
//   只带 TGC 会被打回 /cas/a/login；必须同时带 CAS_TRACE_ID（登录时一起下发的 trace cookie）。
//   换票本身不产生新 TGC 的 Set-Cookie（服务端不滑窗），TGC 从登录起算 14 天（Max-Age=1209600）。
//   idToken 有效期 8 小时 → 每 ~7 小时跑一次即可长期保持可用。
//
// 用法：
//   node scripts/cas-ticket.mjs            # 换票，落盘
//   node scripts/cas-ticket.mjs --verify   # 换票 + 打一发 eams-door 验证
//   node scripts/cas-ticket.mjs --json     # 只输出 JSON（给别的脚本吃）
//
// 状态目录（默认 .cas-state/，可用 ZZU_STATE_DIR 覆盖）：
//   cas-jar.json      Cookie 罐（TGC / CAS_TRACE_ID / SESSION）
//   cas-ticket.txt    最近一次拿到的 ticket（JWT）
//   cas-idtoken.txt   最近一次拿到的 idToken
//   cas-meta.json     时间戳 / ttl / 续期信息
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.ZZU_STATE_DIR || path.join(HERE, '..', '.cas-state');
const BASE = 'https://cas.s.zzu.edu.cn';
// 只有 uniapp.s / ehall.s 这类「前端站」的 service 会返回 JWT ticket；jwxt 自己只给普通 ST。
const SERVICE = process.env.ZZU_CAS_SERVICE || 'https://uniapp.s.zzu.edu.cn/';
const UA = process.env.ZZU_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const JAR_PATH = path.join(STATE_DIR, 'cas-jar.json');
const log = (...a) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${a.join(' ')}\n`);

function request(url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity', ...headers };
    const req = https.request({ host: u.host, path: u.pathname + u.search, method: 'GET', headers: h }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const decodeJwt = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));

export async function mintIdToken({ persist = true } = {}) {
  const jar = JSON.parse(fs.readFileSync(JAR_PATH, 'utf8'));
  if (!jar.TGC) throw new Error('cas-jar.json 缺少 TGC：需要先跑一次 scripts/cas-login.mjs（短信/扫码）');
  const names = ['TGC', 'CAS_TRACE_ID', 'SESSION'].filter((n) => jar[n]);

  const r = await request(`${BASE}/cas/s/login?service=${encodeURIComponent(SERVICE)}`, {
    headers: { Cookie: names.map((n) => `${n}=${jar[n]}`).join('; ') },
  });
  const location = r.headers.location || '';
  const ticket = location ? new URL(location, BASE).searchParams.get('ticket') : null;
  if (!ticket) {
    const err = new Error(`静默换票失败（TGC 可能已过期），跳转 → ${location || '(无 Location)'}；请重跑 scripts/cas-login.mjs`);
    err.needsLogin = true;
    throw err;
  }
  if (ticket.split('.').length !== 3) throw new Error(`拿到的是普通 ST 而不是 JWT ticket（service 选错？）：len=${ticket.length}`);

  const payload = decodeJwt(ticket);
  if (!payload.idToken) throw new Error('ticket 里没有 idToken');
  const idp = decodeJwt(payload.idToken);

  let tgcRenewed = null;
  for (const sc of r.headers['set-cookie'] || []) {
    const m = sc.match(/^([^=]+)=([^;]*)/);
    if (!m || !['TGC', 'CAS_TRACE_ID', 'SESSION'].includes(m[1])) continue;
    jar[m[1]] = m[2];
    if (m[1] === 'TGC') {
      tgcRenewed = { maxAge: +(sc.match(/Max-Age=(\d+)/i) || [])[1] || null, expires: (sc.match(/Expires=([^;]+)/i) || [])[1] || null };
    }
  }

  const prevMeta = (() => { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'cas-meta.json'), 'utf8')); } catch { return null; } })();
  const meta = {
    mintedAt: new Date().toISOString(),
    ticketLen: ticket.length,
    idTokenLen: payload.idToken.length,
    jwt: { iat: idp.iat, exp: idp.exp, ttlH: +((idp.exp - idp.iat) / 3600).toFixed(2), req: idp.req || null, deviceId: idp.deviceId || null },
    tgcRenewed,
    tgcExpiresAt: prevMeta?.tgcExpiresAt || null,
  };
  if (persist) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(JAR_PATH, JSON.stringify(jar, null, 1), 'utf8');
    fs.writeFileSync(path.join(STATE_DIR, 'cas-ticket.txt'), ticket, 'utf8');
    fs.writeFileSync(path.join(STATE_DIR, 'cas-idtoken.txt'), payload.idToken, 'utf8');
    fs.writeFileSync(path.join(STATE_DIR, 'cas-meta.json'), JSON.stringify(meta, null, 1), 'utf8');
  }
  return { idToken: payload.idToken, payload, idp, tgcRenewed, meta, jar };
}

export async function verifyIdToken(idToken, url = 'https://jwxt.zzu.edu.cn/eams-door/api/v1/portal/home/user-info') {
  const r = await request(url, { headers: { 'X-Id-Token': idToken, Accept: 'application/json, text/plain, */*', Referer: 'https://jwxt.zzu.edu.cn/' } });
  return { status: r.status, body: r.body };
}

/**
 * 按需换票（替代 cron）：读已有 meta，如果 idToken 还够新就直接复用，不发请求。
 * 客户端每次要用 token 前调一次即可——手机端休眠/断网/被系统杀进程都不影响，
 * 醒来第一次要用时再换，1 个 HTTPS 往返。
 */
export function readMeta() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'cas-meta.json'), 'utf8')); } catch { return null; }
}

export async function ensureIdToken({ maxAgeH = 6.5, force = false } = {}) {
  const meta = readMeta();
  const now = Date.now();
  if (!force && meta?.jwt?.exp && !process.env.ZZU_FORCE_MINT) {
    const ageH = (now - Date.parse(meta.mintedAt)) / 3600e3;
    const leftH = (meta.jwt.exp * 1000 - now) / 3600e3;
    if (ageH < maxAgeH && leftH > 1) {
      const idToken = fs.readFileSync(path.join(STATE_DIR, 'cas-idtoken.txt'), 'utf8').trim();
      return { idToken, reused: true, meta, leftH: +leftH.toFixed(2) };
    }
  }
  const r = await mintIdToken();
  return { ...r, reused: false, leftH: +((r.idp.exp - now / 1000) / 3600).toFixed(2) };
}

/** TGC 还能活多久（14 天窗口），用于提醒该重新登录了 */
export function tgcStatus() {
  const meta = readMeta();
  if (!meta?.tgcExpiresAt) return null;
  const leftH = (Date.parse(meta.tgcExpiresAt) - Date.now()) / 3600e3;
  return { expiresAt: meta.tgcExpiresAt, leftH: +leftH.toFixed(1), stale: leftH < 24 };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  (async () => {
    const ifStaleArg = process.argv.find((a) => a.startsWith('--if-stale'));
    const force = process.argv.includes('--force');
    let maxAgeH = 6.5;
    if (ifStaleArg && ifStaleArg.includes('=')) maxAgeH = Number(ifStaleArg.split('=')[1]);
    const out = await ensureIdToken({ maxAgeH, force });
    const { idToken } = out;
    const meta = out.meta || {};
    const exp = out.idp?.exp || meta.jwt?.exp;
    const leftH = out.leftH;
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify({ idToken, reused: out.reused, leftH, ...meta }, null, 1) + '\n');
    } else {
      log(out.reused ? `reuse（缓存票还新鲜，剩 ${leftH}h）` : 'mint ok', '· idToken len', idToken.length, '· exp', exp ? new Date(exp * 1000).toISOString() : '?', '· left h', leftH);
      if (!out.reused) log('TGC 续期', out.tgcRenewed ? JSON.stringify(out.tgcRenewed) : '无 Set-Cookie（服务端不滑窗，14 天硬过期）');
      const t = tgcStatus();
      if (t) log(t.stale ? `⚠ TGC 将在 ${t.leftH}h 后过期（${t.expiresAt}），该跑 cas:login 了` : `TGC 剩余 ${t.leftH}h（${t.expiresAt}）`);
    }
    if (process.argv.includes('--verify')) {
      const v = await verifyIdToken(idToken);
      log('eams-door', v.status, v.body.slice(0, 140).replace(/\s+/g, ' '));
      if (v.status !== 200) process.exitCode = 2;
    }
  })().catch((e) => { console.error('FAILED:', e.message); process.exit(e.needsLogin ? 3 : 1); });
}
