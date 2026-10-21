import fs from 'node:fs';

const dir = 'tmp/zzu/jwxt/micro';
const want = process.argv[2] ?? 'room-occupy';
for (const f of fs.readdirSync(dir).filter((x) => x.includes(want))) {
  const s = fs.readFileSync(`${dir}/${f}`, 'utf8');
  const paths = [...new Set([...s.matchAll(/["'`]((?:\/|https?:\/\/[^"'`]*?\/)[a-zA-Z][^"'`\s]{1,80})["'`]/g)].map((m) => m[1]))]
    .filter((p) => !/\.(js|css|png|svg|jpg|gif|json|woff2?)$/.test(p));
  console.log(`## ${f} ${s.length}B`);
  console.log(paths.filter((p) => /room|occupy|course-unit|campus|building|floor/i.test(p)).join('\n'));
  const toks = [...new Set([...s.matchAll(/[A-Za-z-]*(?:occupancy|occupy|Occup|freeRoom|roomOcc)[A-Za-z-]*/g)].map((m) => m[0]))];
  console.log('tokens:', toks.join(','));
  console.log('');
}
