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

const date = process.argv[2] ?? '2026-10-21';
const r = await fetch(`${B}/room/place/rooms`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    currentPage: 1, pageSize: 30, campusAssoc: 2, buildingIds: [23], roomTypeIds: [], floors: [],
    minSeat: '', maxSeat: '', date,
  }),
});
const j = await r.json();
const rows = j.data?.data ?? [];
console.log('rooms', rows.length, 'total', j.data?._page_?.totalRows, 'date', date);
for (const room of rows.slice(0, 8)) {
  const occ = room.roomOccupationInfoVms ?? [];
  console.log(`\n${room.nameZh} occ=${occ.length}`);
  for (const o of occ) {
    console.log(`   ${o.startTimeString}-${o.endTimeString} ${o.activityType} :: ${(o.activityName ?? '').slice(0, 60)}`);
  }
}
