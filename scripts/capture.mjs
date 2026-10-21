// 把真实响应抓成 fixture（脱敏后落 test/fixtures），供单测使用。
// 用法：node scripts/capture.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const TOKENS = new URL('../tmp/zzu/', import.meta.url);
const OUT = new URL('../test/fixtures/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const read = (f) => readFileSync(new URL(f, TOKENS), 'utf8').trim();
const jwxtToken = read('jwxt-token.txt');
const portalToken = read('token.txt');
const NAME = '张三';
const ACCOUNT = '202600000000';

const H = (t, origin) => ({
  'X-Id-Token': t,
  'X-Terminal-Info': 'h5',
  'X-Device-Info': 'PCWin32NT',
  Accept: 'application/json, text/plain, */*',
  Origin: origin,
  Referer: origin + '/',
});

const J = 'https://jwxt.zzu.edu.cn';
const P = 'https://uniapp.s.zzu.edu.cn';
const MICRO = `${J}/eams-micro-server/api/v1`;
const DOOR = `${J}/eams-door/api/v1`;
const PORTAL = 'https://info.s.zzu.edu.cn/portal-api';

async function getJson(url, token, origin, body) {
  const init = { method: body ? 'POST' : 'GET', headers: H(token, origin) };
  if (body) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const save = (name, value) => {
  writeFileSync(new URL(name, OUT), JSON.stringify(value, null, 1) + '\n', 'utf8');
  console.log('wrote', name, `${(JSON.stringify(value).length / 1024).toFixed(1)}KB`);
};

const FROM = '2026-10-19';
const TO = '2026-10-25';

// ---------- 门户 ----------
const events = await getJson(
  `${PORTAL}/v1/calendar/share/schedule/getEvents?startDate=${FROM}&endDate=${TO}&reqType=DateView`,
  portalToken,
  P,
);
save('portal-events.json', events);

save('portal-sections.json', await getJson(`${PORTAL}/v1/calendar/share/schedule/getSection`, portalToken, P));

const contents = await getJson(
  `${PORTAL}/v3/cms/content/getColumncontents?columnId=remote-245732A245871&pageNo=1&pageSize=2&loadContent=true`,
  portalToken,
  P,
);
save('portal-notices.json', contents);

// ---------- 教务 ----------
const term = await getJson(`${MICRO}/semester/current-semester`, jwxtToken, J);
save('jwxt-term.json', term);

const table = await getJson(`${MICRO}/lesson/student/course-table/${term.data.id}`, jwxtToken, J);
save('jwxt-course-table.json', { result: 0, data: table.data.slice(0, 3) });

save('jwxt-units.json', await getJson(`${MICRO}/room/system/course-units`, jwxtToken, J));

save(
  'jwxt-rooms.json',
  await getJson(`${MICRO}/room/place/rooms`, jwxtToken, J, {
    currentPage: 1,
    pageSize: 3,
    campusAssoc: null,
    buildingIds: [],
    roomTypeIds: [],
    floors: [],
    minSeat: '',
    maxSeat: '',
    date: '2026-10-21',
  }),
);

save(
  'jwxt-occupancy.json',
  await getJson(`${MICRO}/room/place/room-occupancy`, jwxtToken, J, { date: '2026-10-21' }),
);

const notices = await getJson(`${DOOR}/protal-notice/get-notices`, jwxtToken, J);
save('jwxt-notices.json', notices);

const user = await getJson(`${DOOR}/portal/home/user-info`, jwxtToken, J);
const sanitizedUser = JSON.parse(
  JSON.stringify(user)
    .split(ACCOUNT)
    .join(ACCOUNT)
    .replaceAll(user.data.user.nameZh, NAME),
);
save('jwxt-user.json', sanitizedUser);
