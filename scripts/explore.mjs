// 探索脚本：打印接口返回的「结构」，不打印 token。
// 用法：node scripts/explore.mjs
import { readFileSync } from 'node:fs';

const TOKEN_DIR = new URL('../tmp/zzu/', import.meta.url);
const read = (f) => readFileSync(new URL(f, TOKEN_DIR), 'utf8').trim();

const jwxtToken = read('jwxt-token.txt');
const portalToken = read('token.txt');

const H = (t, origin) => ({
  'X-Id-Token': t,
  'X-Terminal-Info': 'h5',
  'X-Device-Info': 'PCWin32NT',
  Accept: 'application/json, text/plain, */*',
  Origin: origin,
  Referer: origin + '/',
});

function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[${v.length}] ` + shape(v[0], depth + 1);
  }
  if (typeof v === 'object') {
    if (depth > 3) return '{…}';
    const entries = Object.entries(v)
      .slice(0, 40)
      .map(([k, val]) => `${k}: ${shape(val, depth + 1)}`);
    return `{ ${entries.join(', ')} }`;
  }
  if (typeof v === 'string') return JSON.stringify(v.length > 60 ? v.slice(0, 60) + '…' : v);
  return String(v);
}

async function hit(label, url, token, origin, body) {
  const init = {
    method: body === undefined ? 'GET' : 'POST',
    headers: H(token, origin),
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.log(`\n### ${label}  HTTP ${res.status}  ${text.length}B 非 JSON`);
      return;
    }
    console.log(`\n### ${label}  HTTP ${res.status}  ${text.length}B`);
    console.log(shape(json));
    return json;
  } catch (e) {
    console.log(`\n### ${label}  ERR ${e.message}`);
  }
}

const MICRO = 'https://jwxt.zzu.edu.cn/eams-micro-server/api/v1';
const DOOR = 'https://jwxt.zzu.edu.cn/eams-door/api/v1';
const PORTAL = 'https://info.s.zzu.edu.cn/portal-api';
const J = 'https://jwxt.zzu.edu.cn';
const P = 'https://uniapp.s.zzu.edu.cn';

const sem = await hit('micro /semester/current-semester', `${MICRO}/semester/current-semester`, jwxtToken, J);
const termId = sem?.data?.id ?? sem?.id ?? 194;
await hit('micro /semester/current-week', `${MICRO}/semester/current-week/${termId}`, jwxtToken, J);
await hit('micro /lesson/student/course-table', `${MICRO}/lesson/student/course-table/${termId}`, jwxtToken, J);
await hit('micro /grade/student/grades', `${MICRO}/grade/student/grades`, jwxtToken, J);
await hit('micro /exam/student/exam', `${MICRO}/exam/student/exam`, jwxtToken, J);
await hit('micro /room/place/campus', `${MICRO}/room/place/campus`, jwxtToken, J);
await hit('micro /room/system/course-units', `${MICRO}/room/system/course-units`, jwxtToken, J);
await hit('micro /room/place/rooms', `${MICRO}/room/place/rooms`, jwxtToken, J, {
  currentPage: 1,
  pageSize: 3,
  campusAssoc: null,
  buildingIds: [],
  roomTypeIds: [],
  floors: [],
  minSeat: '',
  maxSeat: '',
  date: '2026-10-21',
});
await hit('micro /room/place/room-occupancy', `${MICRO}/room/place/room-occupancy`, jwxtToken, J, {
  date: '2026-10-21',
});
await hit('door /portal/home/user-info', `${DOOR}/portal/home/user-info`, jwxtToken, J);
await hit('door /protal-notice/get-notices', `${DOOR}/protal-notice/get-notices`, jwxtToken, J);
await hit('door /protal-schedule/getSchedules', `${DOOR}/protal-schedule/getSchedules`, jwxtToken, J);

await hit('portal /getEvents', `${PORTAL}/v1/calendar/share/schedule/getEvents?startDate=2026-10-19&endDate=2026-10-25&reqType=DateView`, portalToken, P);
await hit('portal /getSection', `${PORTAL}/v1/calendar/share/schedule/getSection?startDate=2026-10-19&endDate=2026-10-25`, portalToken, P);
await hit('portal /getColumncontents', `${PORTAL}/v3/cms/content/getColumncontents?columnId=remote-245732A245871&pageNo=1&pageSize=2&loadContent=true`, portalToken, P);
