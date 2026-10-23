import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * 教务采集器是**原生 JS**（content script，不经构建），所以这里用 vm 跑源码本身，
 * 而不是把逻辑抄一份到测试里——抄一份就测不到真实脚本。
 */
const CODE = readFileSync(fileURLToPath(new URL('../public/content/jwxt.js', import.meta.url)), 'utf8');

/** 形状合法的 JWT（不参与任何网络请求，只看能不能被采集器认出来） */
const JWT = 'eyJhbGciOiJSUzUxMiJ9.eyJleHAiOjE4OTM0NTYwMDAsImlzcyI6ImNhcy5zLnp6dS5lZHUuY24ifQ.c2lnbmF0dXJl';

/** 形状合法但不是 CAS 签的票（payload 里 iss 是别的域）——开了 all_frames 之后必须被丢掉 */
const FOREIGN = 'eyJhbGciOiJSUzUxMiJ9.eyJleHAiOjE4OTM0NTYwMDAsImlzcyI6ImV2aWwuZXhhbXBsZS5jb20ifQ.c2lnbmF0dXJl';

interface Sent {
  type?: string;
  source?: string;
  token?: string;
  reason?: string;
}

function makeStore(data: Record<string, string>) {
  const keys = Object.keys(data);
  return {
    getItem: (key: string) => (key in data ? data[key] : null),
    key: (index: number) => keys[index] ?? null,
    length: keys.length,
  };
}

function run(env: {
  search?: string;
  hash?: string;
  local?: Record<string, string>;
  session?: Record<string, string>;
  cookie?: string;
}) {
  const sent: Sent[] = [];
  const ctx: Record<string, unknown> = {
    location: {
      search: env.search ?? '',
      hash: env.hash ?? '',
      href: 'https://jwxt.zzu.edu.cn/uniapp/index.html',
    },
    localStorage: makeStore(env.local ?? {}),
    sessionStorage: makeStore(env.session ?? {}),
    document: { cookie: env.cookie ?? '' },
    // 与浏览器对齐：采集器会解析 JWT payload（iss 校验），sandbox 里也要有 atob/escape
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    escape: (s: string) => encodeURIComponent(s).replace(/%(?![0-9A-F]{2})/g, '%25'),
    chrome: {
      runtime: {
        sendMessage: (message: Sent) => {
          sent.push(message);
        },
        onMessage: { addListener: () => undefined },
      },
    },
    // 采集器启动时会 setInterval 轮询，测试里不需要真的跑
    setInterval: () => 0,
    clearInterval: () => undefined,
  };
  ctx.window = ctx;
  vm.runInNewContext(CODE, ctx);
  const probe = ctx.__zzuTokenProbe as () => { found: boolean; from: string | null; keys: string[] };
  return { sent, probe };
}

describe('教务采集器：token 从哪来都能认出来', () => {
  it('URL 里的 ?idToken=（CAS 回调的原始形态）', () => {
    const { sent } = run({ search: `?idToken=${JWT}` });
    expect(sent[0]?.token).toBe(JWT);
    expect(sent[0]?.source).toBe('jwxt');
    expect(sent[0]?.reason).toBe('load:url');
  });

  it('uni-app 的 #/ 路由把 token 放在 hash 的 query 里', () => {
    const { sent } = run({ hash: `#/pages/index/index?idToken=${JWT}` });
    expect(sent[0]?.token).toBe(JWT);
  });

  it('uni-app H5 存储的 JSON 包装：{"type":"string","data":"…"}（之前漏掉的就是这种）', () => {
    const { sent } = run({ local: { token_key: JSON.stringify({ type: 'string', data: JWT }) } });
    expect(sent[0]?.token).toBe(JWT);
    expect(sent[0]?.reason).toBe('load:localStorage');
  });

  it('普通 localStorage 键', () => {
    expect(run({ local: { 'X-Id-Token': JWT } }).sent[0]?.token).toBe(JWT);
    expect(run({ local: { token_key: JWT } }).sent[0]?.token).toBe(JWT);
  });

  it('sessionStorage 也认', () => {
    const { sent } = run({ session: { idToken: JWT } });
    expect(sent[0]?.token).toBe(JWT);
    expect(sent[0]?.reason).toBe('load:sessionStorage');
  });

  it('cookie（URL 编码过也行）', () => {
    const { sent } = run({ cookie: `X-Id-Token=${encodeURIComponent(JWT)}` });
    expect(sent[0]?.token).toBe(JWT);
    expect(sent[0]?.reason).toBe('load:cookie');
  });

  it('键名又换了也能靠扫描兜住', () => {
    const { sent } = run({ local: { some_new_token_key: JWT } });
    expect(sent[0]?.token).toBe(JWT);
  });

  it('没有 token 就不上报（不能瞎编一个）', () => {
    const { sent, probe } = run({ local: { userInfo: JSON.stringify({ name: '张三' }) } });
    expect(sent).toHaveLength(0);
    expect(probe().found).toBe(false);
  });

  it('探针能说清楚从哪找到的（排查用）', () => {
    const { probe } = run({ local: { token_key: JSON.stringify({ type: 'string', data: JWT }) } });
    expect(probe()).toMatchObject({ found: true, from: 'localStorage' });
  });
});


describe('只认 CAS 签发的票（all_frames 防串号）', () => {
  it('iss 不是 cas.s.zzu.edu.cn 的 JWT 会被忽略', () => {
    const { sent } = run({
      local: {
        idToken: JSON.stringify({ type: 'string', data: FOREIGN }),
        token_key: FOREIGN,
      },
      cookie: 'X-Id-Token=' + FOREIGN,
    });
    expect(sent.filter((s) => s.type === 'token')).toHaveLength(0);
  });

  it('扫描到的第一张票是外来票时，宁可不发，也不把别人的会话当登录态', () => {
    const { sent } = run({
      local: {
        idToken: JSON.stringify({ type: 'string', data: FOREIGN }),
        'X-Id-Token': JWT,
      },
    });
    const tokens = sent.filter((s) => s.type === 'token');
    expect(tokens).toHaveLength(0);
  });
});
