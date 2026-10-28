// 一次性绑定：把「学号 + 密码 + 这台设备」注册成可信设备，之后就不用再管验证码了。
//
// 背景：学校 App 端的登录接口（/token/password/passwordLogin）只在「设备可信」时直接给票。
// 新设备第一次登录要先过 MFA（这台账号上是安全手机短信），过完同一个 deviceId 就被登记成
// 可信设备，之后 scripts/app-ticket.mjs 只凭学号密码就能换 30 天票，零人工。
//
// 用法：
//   ZZU_USER=... ZZU_PASS=... node scripts/app-login.mjs          # 用已有 deviceId（没有就生成）
//   ZZU_USER=... ZZU_PASS=... node scripts/app-login.mjs --new    # 强制换一个新设备
//   （或者把 {"username":"...","password":"..."} 写进 .cas-state/creds.json）
//
// 短信验证：脚本把验证码发出去后会打印手机号，然后轮询 .cas-state/sms-code.txt，
//           你把收到的 4~6 位数字写进这个文件（几十秒内生效）。码一次性、且和 gid 绑定。
//
// 注意：短信有频率限制（"验证码发送过于频繁"），失败后等一两分钟再试。
import fs from 'node:fs';
import path from 'node:path';
import {
  APP_UA,
  STATE_DIR,
  detectMfa,
  loadCreds,
  mintAppToken,
  newDeviceId,
  saveAppState,
} from './app-ticket.mjs';

const BASE = 'https://cas.s.zzu.edu.cn';
const CODE_FILE = path.join(STATE_DIR, 'sms-code.txt');
const WAIT_MS = 6 * 60_000;
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

async function getJson(url, { method = 'GET', body = null } = {}) {
  const headers = { 'User-Agent': APP_UA, Accept: 'application/json, text/plain, */*' };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCode() {
  try { fs.rmSync(CODE_FILE); } catch { /* 没有就算了 */ }
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(1500);
    if (fs.existsSync(CODE_FILE)) {
      const code = fs.readFileSync(CODE_FILE, 'utf8').replace(/\D/g, '').slice(0, 6);
      if (code.length >= 4) return code;
    }
  }
  return '';
}

(async () => {
  const base = loadCreds();
  const deviceId = process.argv.includes('--new') ? newDeviceId() : base.deviceId;
  const creds = { ...base, deviceId };
  log('account', creds.account, '· deviceId', deviceId);

  const det = await detectMfa(creds);
  log('detect → need =', det.need, '· state =', det.state);

  if (!det.need) {
    log('这台设备已经是可信设备，不用验证码，直接换票');
    const out = await mintAppToken(creds);
    saveAppState({ trustedAt: new Date().toISOString() });
    log(`ok · idToken len ${out.idToken.length} · 有效期 ${out.meta.jwt.ttlH}h · 剩余 ${out.meta.leftH}h`);
    return;
  }

  const init = await getJson(`${BASE}/token/mfa/initByType/securephone?state=${encodeURIComponent(det.state)}`);
  const gid = init.json?.data?.gid;
  const phone = init.json?.data?.securePhone || '(未知号码)';
  const attest = init.json?.data?.attestServerUrl || 'https://cas.s.zzu.edu.cn/attest';
  if (!gid) throw new Error(`取短信通道失败：HTTP ${init.status} ${init.text.slice(0, 160)}`);

  const send = await getJson(`${attest}/api/guard/securephone/send`, { method: 'POST', body: { gid } });
  if (send.json?.code !== 0) throw new Error(`发短信失败：${send.json?.message || send.text.slice(0, 160)}`);
  log(`短信已发到 ${phone}（gid ${gid}）`);
  log(`把收到的验证码写进 ${CODE_FILE} 即可（等 6 分钟）`);

  const code = await waitForCode();
  if (!code) throw new Error('没等到验证码（超时）');

  const valid = await getJson(`${attest}/api/guard/securephone/valid`, { method: 'POST', body: { gid, code } });
  const status = valid.json?.data?.status;
  if (valid.json?.code !== 0 || status !== 2) {
    throw new Error(`验证码没通过：status=${status} ${valid.json?.message || ''}`.trim());
  }
  log('验证通过，正在换票…');

  const out = await mintAppToken(creds);
  saveAppState({ trustedAt: new Date().toISOString(), deviceId });
  log(`ok · idToken len ${out.idToken.length} · 有效期 ${out.meta.jwt.ttlH}h · 剩余 ${out.meta.leftH}h · deviceId ${deviceId}`);
  log('以后只要 node scripts/app-ticket.mjs --verify 就能换 30 天票（不用验证码）');
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(e.needsLogin ? 3 : 1);
});
