// 把一卡通 / 待办的真实响应存成 fixture（脱敏：学号无关，余额是 0）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const jwxt = readFileSync(new URL('tmp/zzu/jwxt-token.txt', import.meta.url), 'utf8').trim();
const H = {
  'X-Id-Token': jwxt,
  'X-Terminal-Info': 'h5',
  'X-Device-Info': 'PCWin32NT',
  Accept: 'application/json',
  Origin: 'https://uniapp.s.zzu.edu.cn',
  Referer: 'https://uniapp.s.zzu.edu.cn/',
};

const out = new URL('../test/fixtures/', import.meta.url);
mkdirSync(out, { recursive: true });

const targets = [
  ['card.json', 'https://info.s.zzu.edu.cn/portal-api/v2/personalData/getMyECard'],
  ['todo-count.json', 'https://transaction.s.zzu.edu.cn/ttc/v1/count/ttcCount?readed=0'],
  ['todo-list.json', 'https://transaction.s.zzu.edu.cn/ttc/api/ttc/center-list/getToDoList?pageIndex=1&pageSize=10'],
];

for (const [name, url] of targets) {
  const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  writeFileSync(new URL(name, out), JSON.stringify(JSON.parse(text), null, 2) + '\n', 'utf8');
  console.log(`${name} <- ${res.status} ${text.length}B`);
}
