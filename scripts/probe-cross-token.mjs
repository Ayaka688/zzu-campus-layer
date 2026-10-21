// 检验：教务 idToken 能否直接访问门户 portal-api（同一 CAS 签发，但受众可能不同）
import { readFileSync } from 'node:fs';

const jwxt = readFileSync(new URL('tmp/zzu/jwxt-token.txt', import.meta.url), 'utf8').trim();

const headers = (token, origin) => ({
  'X-Id-Token': token,
  'X-Terminal-Info': 'h5',
  'X-Device-Info': 'PCWin32NT',
  Accept: 'application/json',
  Origin: origin,
  Referer: `${origin}/`,
});

const cases = [
  ['https://info.s.zzu.edu.cn/portal-api/v1/cms/Column/getColumnList', 'GET', 'https://uniapp.s.zzu.edu.cn'],
  ['https://info.s.zzu.edu.cn/portal-api/v2/personalData/getMyECard', 'GET', 'https://uniapp.s.zzu.edu.cn'],
  ['https://info.s.zzu.edu.cn/portal-api/v1/personalData/getECardDataList', 'GET', 'https://uniapp.s.zzu.edu.cn'],
  ['https://authx-service.s.zzu.edu.cn/personal/api/v1/personal/me/user', 'GET', 'https://uniapp.s.zzu.edu.cn'],
];

for (const [url, method, origin] of cases) {
  try {
    const res = await fetch(url, { method, headers: headers(jwxt, origin), signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    console.log(`\n== ${url.replace('https://', '')} -> ${res.status} (${text.length}B)\n${text.slice(0, 400)}`);
  } catch (e) {
    console.log(`\n== ${url} -> ERR ${e.message}`);
  }
}
