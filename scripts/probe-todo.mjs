// 待办 / 未读消息 / 消费流水：确认用教务 token 也能通
import { readFileSync } from 'node:fs';

const jwxt = readFileSync(new URL('tmp/zzu/jwxt-token.txt', import.meta.url), 'utf8').trim();
const H = {
  'X-Id-Token': jwxt,
  'X-Terminal-Info': 'h5',
  'X-Device-Info': 'PCWin32NT',
  Accept: 'application/json',
  Origin: 'https://uniapp.s.zzu.edu.cn',
  Referer: 'https://uniapp.s.zzu.edu.cn/',
};

const urls = [
  'https://transaction.s.zzu.edu.cn/ttc/api/ttc/center-list/getToDoList?pageIndex=1&pageSize=10',
  'https://transaction.s.zzu.edu.cn/ttc/api/ttc/center-list/getInitiateList?pageIndex=1&pageSize=10&status=IN_PROGRESS',
  'https://transaction.s.zzu.edu.cn/ttc/v1/count/ttcCount?readed=0',
  'https://message-service.s.zzu.edu.cn/center/api/v1/instantMessage/getAppAllUnReadCount/new',
  'https://info.s.zzu.edu.cn/portal-api/v1/diversion/getUserDiversionList?terminal=6',
];

for (const url of urls) {
  try {
    const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    console.log(`\n== ${url.replace('https://', '')} -> ${res.status} (${text.length}B)\n${text.slice(0, 500)}`);
  } catch (e) {
    console.log(`\n== ${url} -> ERR ${e.message}`);
  }
}
