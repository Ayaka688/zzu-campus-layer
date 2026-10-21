// 探校历/学期相关接口（eams-micro-server）
import { readFileSync } from 'node:fs';

const token = readFileSync(new URL('tmp/zzu/jwxt-token.txt', import.meta.url), 'utf8').trim();
const BASE = 'https://jwxt.zzu.edu.cn/eams-door/api/v1';
const H = {
  'X-Id-Token': token,
  'X-Terminal-Info': 'h5',
  'X-Device-Info': 'PCWin32NT',
  Accept: 'application/json',
  Origin: 'https://jwxt.zzu.edu.cn',
  Referer: 'https://jwxt.zzu.edu.cn/',
};

const paths = [
  '/calendar/get-all-semesters',
  '/calendar/get-enable-semesters',
  '/calendar/get-current-teach-week',
  '/calendar/get-calendar-event?semesterId=194',
  '/calendar/get-campus-layout-table',
];

for (const p of paths) {
  const url = BASE + p;
  try {
    const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let brief = text;
    try {
      const json = JSON.parse(text);
      const data = json.data ?? json;
      if (Array.isArray(data)) brief = `array(${data.length}) ${JSON.stringify(data[0]).slice(0, 220)}`;
      else if (data && typeof data === 'object') brief = `object keys=${Object.keys(data).join(',')} ${JSON.stringify(data).slice(0, 220)}`;
      else brief = String(data);
    } catch {
      brief = text.slice(0, 160);
    }
    console.log(`\n== ${p} -> ${res.status} (${text.length}B)\n${brief}`);
  } catch (e) {
    console.log(`\n== ${p} -> ERR ${e.message}`);
  }
}
