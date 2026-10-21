import fs from 'node:fs';

const tok = fs.readFileSync('tmp/zzu/jwxt-token.txt', 'utf8').trim();
const H = {
  'X-Id-Token': tok,
  'X-Terminal-Info': 'h5',
  'X-Device-Info': 'PCWin32NT',
  Accept: 'application/json',
  'content-type': 'application/json',
  Origin: 'https://jwxt.zzu.edu.cn',
  Referer: 'https://jwxt.zzu.edu.cn/eams-room-occupy-app/index.html',
};
const B = 'https://jwxt.zzu.edu.cn/eams-micro-server/api/v1';

async function post(path, body) {
  const r = await fetch(B + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    return { status: r.status, len: t.length, raw: t.slice(0, 200) };
  }
  return { status: r.status, len: t.length, j };
}

const date = '2026-10-21';

const cases = [
  ['occupancy {date}', '/room/place/room-occupancy', { date }],
  ['occupancy +campus2', '/room/place/room-occupancy', { date, campusAssoc: 2 }],
  ['occupancy +campus2+buildings', '/room/place/room-occupancy', { date, campusAssoc: 2, buildingIds: [23] }],
  ['occupancy +bizType2', '/room/place/room-occupancy', { date, bizTypeId: 2 }],
  ['occupancy +unit', '/room/place/room-occupancy', { date, roomName: '物_505' }],
  ['rooms +occupationInfo', '/room/place/rooms', {
    currentPage: 1, pageSize: 5, campusAssoc: 2, buildingIds: [23], roomTypeIds: [], floors: [],
    minSeat: '', maxSeat: '', date,
  }],
];

for (const [label, path, body] of cases) {
  const r = await post(path, body);
  if (r.j === undefined) {
    console.log(`- ${label} :: [${r.status}] ${r.len}B ${r.raw}`);
    continue;
  }
  const d = r.j.data;
  const n = Array.isArray(d) ? d.length : d?.data?.length ?? d?._page_?.totalRows ?? 'n/a';
  console.log(`- ${label} :: [${r.status}] ${r.len}B n=${n} keys=${Array.isArray(d) ? 'array' : Object.keys(d ?? {}).join(',')}`);
  if (Array.isArray(d) && d.length) console.log('   sample:', JSON.stringify(d[0]).slice(0, 220));
  if (d?.data?.[0]) console.log('   room:', JSON.stringify(d.data[0]).slice(0, 320));
}
