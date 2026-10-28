// 一次性人工登录：走 CAS 密码 + 双因子（安全手机短信 / 客户端扫码），
// 成功后把 CAS 的 TGC 存进状态目录，之后用 scripts/cas-ticket.mjs 静默换票（不再需要人）。
//
// 为什么不能省掉这一步：jwxt 新教务 /student 页面自身的账号登录对本科生账号一律回 login_first
// （按账号状态预检，跟密码对错无关，实测错密码也回 login_first），必须走 CAS；
// 而 CAS 在本环境强制 MFA（mfaTypeSecurePhone=true, mfaTypeQrCode=true），密码正确也过不去。
//
// 用法：
//   ZZU_USER=... ZZU_PASS=... node scripts/cas-login.mjs                # 安全手机短信
//   ZZU_USER=... ZZU_PASS=... node scripts/cas-login.mjs --qrcode       # 客户端扫码
//   （也可把 {"username":"...","password":"..."} 放在 .cas-state/creds.json）
//
// 短信模式：脚本把短信发出去后会打印手机号，然后轮询 .cas-state/sms-code.txt，
//           你把 4~6 位验证码写进这个文件即可（几十秒内生效）。
// 扫码模式：打印二维码图片 URL（服务端直接出图，无需自己渲染），用「豫见郑大」App 扫并在手机上同意。
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.ZZU_STATE_DIR || path.join(HERE, '..', '.cas-state');
const BASE = 'https://cas.s.zzu.edu.cn';
const SERVICE = process.env.ZZU_CAS_SERVICE || 'https://uniapp.s.zzu.edu.cn/';
const UA = process.env.ZZU_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CODE_FILE = path.join(STATE_DIR, 'sms-code.txt');
const QR_FILE = path.join(STATE_DIR, 'cas-qr.png');
const JAR_PATH = path.join(STATE_DIR, 'cas-jar.json');
const MODE = process.argv.includes('--qrcode') ? 'qrcode' : 'sms';
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

function loadCreds() {
  const file = path.join(STATE_DIR, 'creds.json');
  let c = {};
  if (fs.existsSync(file)) { try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* ignore */ } }
  const username = process.env.ZZU_USER || c.username;
  const password = process.env.ZZU_PASS || c.password;
  if (!username || !password) throw new Error(`缺少凭据：设 ZZU_USER/ZZU_PASS，或写 ${file}`);
  return { username, password };
}

const jar = new Map();
let tgcExpiresAt = null; // TGC 的绝对过期时间（CAS 给 14 天 Max-Age，不滑窗）
function absorb(setCookie) {
  for (const raw of [].concat(setCookie || [])) {
    const first = raw.split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const val = first.slice(eq + 1).trim();
    if (/^(Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(raw) || val === 'deleteMe') { jar.delete(name); continue; }
    if (name === 'TGC') {
      const ma = /Max-Age=(\d+)/i.exec(raw);
      const ex = /Expires=([^;]+)/i.exec(raw);
      const at = ma ? new Date(Date.now() + Number(ma[1]) * 1000) : ex ? new Date(ex[1]) : null;
      if (at && !Number.isNaN(at.getTime())) { tgcExpiresAt = at.toISOString(); log('TGC 有效期到', tgcExpiresAt); }
    }
    jar.set(name, val);
  }
}

function request(method, url, { headers = {}, body = null, follow = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Encoding': 'identity',
      ...headers,
    };
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body != null) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ host: u.host, path: u.pathname + u.search, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', async () => {
        absorb(res.headers['set-cookie']);
        const buf = Buffer.concat(chunks);
        const out = { status: res.statusCode, headers: res.headers, body: buf.toString('utf8'), buf };
        const loc = res.headers.location;
        if (follow > 0 && loc) {
          try { return resolve(await request('GET', new URL(loc, url).href, { follow: follow - 1, headers })); } catch (e) { return reject(e); }
        }
        resolve(out);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (body != null) req.write(body);
    req.end();
  });
}

const form = (pathOrUrl, fields) => {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  return request('POST', url, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, Referer: BASE + '/cas/a/login' },
    body: new URLSearchParams(fields).toString(),
  });
};
const jsonPost = (url, obj) => request('POST', url, {
  headers: { 'Content-Type': 'application/json; charset=UTF-8', Accept: 'application/json, text/plain, */*', Origin: BASE, Referer: BASE + '/cas/a/login' },
  body: JSON.stringify(obj),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const field = (html, name) => {
  const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`)) || html.match(new RegExp(`value="([^"]*)"[^>]*name="${name}"`));
  return m ? m[1] : '';
};

async function rsaPassword(password) {
  const pk = await request('GET', `${BASE}/cas/jwt/publicKey`);
  const body = pk.body.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const pem = `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
  const enc = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(password, 'utf8')).toString('base64');
  return '__RSA__' + enc;
}

async function waitSmsCode(attest) {
  let gid = null;
  for (let round = 1; round <= 4; round++) {
    const init = JSON.parse((await request('GET', `${BASE}/cas/mfa/initByType/securephone?state=${encodeURIComponent(state)}`,
      { headers: { Accept: 'application/json, text/plain, */*', Referer: BASE + '/cas/a/login' } })).body);
    gid = init?.data?.gid;
    const attestUrl = init?.data?.attestServerUrl || attest;
    if (!gid) throw new Error('initByType/securephone 没返回 gid');
    const sent = JSON.parse((await jsonPost(`${attestUrl}/api/guard/securephone/send`, { gid })).body);
    if (sent?.code !== 0) { log('发送失败，重试', JSON.stringify(sent).slice(0, 120)); await sleep(1500); continue; }
    log(`短信已发送到 ${init?.data?.securePhone || '(见手机)'}；把验证码写入 ${CODE_FILE}`);
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      await sleep(1500);
      if (!fs.existsSync(CODE_FILE)) continue;
      const code = fs.readFileSync(CODE_FILE, 'utf8').trim().replace(/\D/g, '');
      if (code.length < 4) continue;
      fs.unlinkSync(CODE_FILE);
      const v = JSON.parse((await jsonPost(`${attestUrl}/api/guard/securephone/valid`, { gid, code })).body);
      log('verify', code, '→', JSON.stringify(v).slice(0, 120));
      if (v?.code === 0 && v?.data?.status === 2) return;
      if (v?.data?.result === 'expired') break;
    }
  }
  throw new Error('短信验证未通过（超时/过期/码错）');
}

async function waitQrScan(attest) {
  for (let round = 1; round <= 6; round++) {
    const init = JSON.parse((await request('GET', `${BASE}/cas/mfa/initByType/qrcode?state=${encodeURIComponent(state)}`,
      { headers: { Accept: 'application/json, text/plain, */*', Referer: BASE + '/cas/a/login' } })).body);
    const gid = init?.data?.gid;
    const attestUrl = init?.data?.attestServerUrl || attest;
    if (!gid) throw new Error('initByType/qrcode 没返回 gid');
    const sent = JSON.parse((await jsonPost(`${attestUrl}/api/guard/qrcode/send`, { gid })).body);
    const url = sent?.data?.scanQrcode;
    if (!url) { log('二维码下发失败', JSON.stringify(sent).slice(0, 120)); await sleep(1500); continue; }
    const png = await request('GET', url);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(QR_FILE, png.buf);
    log(`第 ${round} 张二维码 → ${QR_FILE}（约 3~5 分钟过期，扫失败会换新图）`);
    const deadline = Date.now() + 168000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const st = JSON.parse((await jsonPost(`${attestUrl}/api/guard/qrcode/status`, { gid })).body);
      const s = st?.data?.status;
      if (s === 2) return;                       // 2 = 手机已确认
      if (s === 3 || s === 5 || s === 9) { log('本张失效', st?.data?.statusCode); break; }
    }
  }
  throw new Error('扫码未完成');
}

let state = null;
(async () => {
  const { username, password } = loadCreds();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (fs.existsSync(CODE_FILE)) fs.unlinkSync(CODE_FILE);

  const page = await request('GET', `${BASE}/cas/login?service=${encodeURIComponent(SERVICE)}`, { follow: 5 });
  const execution = field(page.body, 'execution');
  if (!execution) throw new Error('登录页没有 execution');
  log('登录页 ok，execution', execution.slice(0, 8) + '…');

  const encodedPassword = await rsaPassword(password);
  const detect = JSON.parse((await form(`${BASE}/cas/mfa/detect`, { username, password: encodedPassword, fpVisitorId: '' })).body);
  state = detect?.data?.state;
  if (!detect?.data?.need) throw new Error('mfa/detect 说不需要 MFA（密码可能不对，或风控策略变了）');
  log('MFA 类型', Object.entries(detect.data).filter(([k, v]) => k.startsWith('mfaType') && v).map(([k]) => k.slice(7)).join('/'), '· state', state);

  const attest = 'https://cas.s.zzu.edu.cn/attest';
  if (MODE === 'qrcode') await waitQrScan(attest); else await waitSmsCode(attest);

  const login = await form(`${BASE}/cas/a/login?service=${encodeURIComponent(SERVICE)}`, {
    username, password: encodedPassword, captcha: '', rememberMe: 'on', currentMenu: '1', failN: '-1',
    mfaState: state, execution, _eventId: 'submit', geolocation: '', fpVisitorId: '',
  });
  const location = login.headers.location || '';
  const ticket = location ? new URL(location, BASE).searchParams.get('ticket') : null;
  fs.writeFileSync(JAR_PATH, JSON.stringify(Object.fromEntries(jar), null, 1), 'utf8');
  if (!ticket) throw new Error('登录后没有 ticket，登录未生效: ' + login.body.slice(0, 200));

  const payload = JSON.parse(Buffer.from(ticket.split('.')[1] || '', 'base64url').toString('utf8') || '{}');
  if (payload.idToken) {
    fs.writeFileSync(path.join(STATE_DIR, 'cas-ticket.txt'), ticket, 'utf8');
    fs.writeFileSync(path.join(STATE_DIR, 'cas-idtoken.txt'), payload.idToken, 'utf8');
    const ip = JSON.parse(Buffer.from(payload.idToken.split('.')[1], 'base64url').toString('utf8'));
    fs.writeFileSync(path.join(STATE_DIR, 'cas-meta.json'), JSON.stringify({
      mintedAt: new Date().toISOString(),
      via: 'cas-login',
      idTokenLen: payload.idToken.length,
      jwt: { iat: ip.iat, exp: ip.exp, ttlH: +((ip.exp - ip.iat) / 3600).toFixed(2), req: ip.req || null, deviceId: ip.deviceId || null },
      tgcExpiresAt,
    }, null, 1), 'utf8');
    if (tgcExpiresAt) log('TGC 有效期到', tgcExpiresAt, '（14 天硬过期，不滑窗；到期需重跑本脚本）');
    log('登录成功 · idToken exp', new Date(ip.exp * 1000).toISOString(), '· TGC 已存入', JAR_PATH);
  } else {
    log('登录成功，但没有 idToken（ticket 不是 JWT，检查 ZZU_CAS_SERVICE）');
  }
  console.log('DONE');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
