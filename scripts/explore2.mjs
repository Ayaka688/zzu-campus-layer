// 深挖结构：只打印关键子对象，便于写归一化逻辑。
import { readFileSync } from 'node:fs';

const DIR = new URL('../tmp/zzu/', import.meta.url);
const read = (f) => readFileSync(new URL(f, DIR), 'utf8').trim();
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

const J = 'https://jwxt.zzu.edu.cn';
const P = 'https://uniapp.s.zzu.edu.cn';
const MICRO = 'https://jwxt.zzu.edu.cn/eams-micro-server/api/v1';
const PORTAL = 'https://info.s.zzu.edu.cn/portal-api';

async function getJson(url, token, origin, body) {
  const init = { method: body ? 'POST' : 'GET', headers: H(token, origin) };
  if (body) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  return res.json();
}

const cut = (v, n = 2200) => {
  const s = JSON.stringify(v, null, 1);
  return s.length > n ? s.slice(0, n) + `\n…(共 ${s.length} 字符)` : s;
};

const ct = await getJson(`${MICRO}/lesson/student/course-table/194`, jwxtToken, J);
const courses = ct.data;
console.log('===== course-table: 课程数', courses.length);
console.log('===== course[0] 除 schedules 外：');
const { schedules, students, ...rest } = courses[0];
console.log(cut(rest, 1800));
console.log('===== course[0].schedules 长度', schedules?.length);
console.log(cut(schedules?.slice(0, 3), 2000));
console.log('===== 所有课程 schedules 条数：', courses.map((c) => c.schedules?.length ?? 0).join(','));

const ev = await getJson(
  `${PORTAL}/v1/calendar/share/schedule/getEvents?startDate=2026-10-19&endDate=2026-10-20&reqType=DateView`,
  portalToken,
  P,
);
const day = Object.values(ev.data.schedule)[0];
console.log('\n===== portal getEvents 单日 calendarList[0]：');
console.log(cut(day?.calendarList?.[0], 2000));

const b = await getJson(`${MICRO}/room/place/building?campusAssoc=2`, jwxtToken, J);
console.log('\n===== buildings：', b.data?.length, '首条：');
console.log(cut(b.data?.[0], 600));

const ss = await getJson(`${MICRO}/semester/std-semesters`, jwxtToken, J);
console.log('\n===== std-semesters：', ss.data?.length, '首条/末条：');
console.log(cut(ss.data?.[0], 400));
console.log(cut(ss.data?.[ss.data.length - 1], 400));
