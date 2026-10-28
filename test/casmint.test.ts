import { describe, expect, it } from 'vitest';
import { idTokenFromTicket, idTokenFromUrl } from '../src/core/casMint';
import { needsRefresh, REFRESH_MARGIN_MS } from '../src/core/renew';
import type { TokenStatus } from '../src/core/storage';

/** 造一个「看起来像真 JWT」的三段串 */
const jwt = (payload: Record<string, unknown>) => {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS512' })}.${b64(payload)}.c2lnbmF0dXJl`;
};

const INNER = jwt({ iss: 'cas.s.zzu.edu.cn', ATTR_userNo: '202600000001' });
/** CAS 回跳时带的 ticket：payload 里装着 idToken */
const TICKET = jwt({ idToken: INNER });

describe('idTokenFromTicket', () => {
  it('从 ticket 的 payload 里取出 idToken', () => {
    expect(idTokenFromTicket(TICKET)?.idToken).toBe(INNER);
  });

  it('URL 编码过的 ticket 也能取', () => {
    expect(idTokenFromTicket(encodeURIComponent(TICKET))?.idToken).toBe(INNER);
  });

  it('普通 ST 票 / 空串 / 乱码串返回 null', () => {
    expect(idTokenFromTicket('ST-14901-hUmzPt9chnaSJXoCw4lKF58pPIC-0r15')).toBeNull();
    expect(idTokenFromTicket('')).toBeNull();
    expect(idTokenFromTicket('a.b.c')).toBeNull();
  });

  it('payload 里没有 idToken 时返回 null', () => {
    expect(idTokenFromTicket(jwt({ foo: 'bar' }))).toBeNull();
  });
});

describe('idTokenFromUrl', () => {
  it('从 302 Location 里直接读 ?ticket=', () => {
    const url = `https://uniapp.s.zzu.edu.cn/?redirect=true&ticket=${encodeURIComponent(TICKET)}`;
    expect(idTokenFromUrl(url)?.idToken).toBe(INNER);
  });

  it('ticket 出现在 hash 的 query 里也行', () => {
    expect(idTokenFromUrl(`https://uniapp.s.zzu.edu.cn/#/pages/tab?ticket=${TICKET}`)?.idToken).toBe(INNER);
  });

  it('没有 ticket 的地址返回 null（比如被打回登录页）', () => {
    expect(idTokenFromUrl('https://cas.s.zzu.edu.cn/cas/a/login?service=x')).toBeNull();
    expect(idTokenFromUrl('')).toBeNull();
  });
});

describe('needsRefresh', () => {
  const HOUR = 3_600_000;
  const status = (over: Partial<TokenStatus>): TokenStatus => ({
    source: 'jwxt',
    present: true,
    valid: true,
    ...over,
  });

  it('一张票都没有：不主动续（那是没登录，交给用户）', () => {
    expect(needsRefresh([status({ present: false, valid: false })])).toBe(false);
  });

  it('剩 5 小时：够用，不续', () => {
    expect(needsRefresh([status({ remainingMs: 5 * HOUR })])).toBe(false);
  });

  it('剩 1 小时：快到点了，该续', () => {
    expect(needsRefresh([status({ remainingMs: 1 * HOUR })])).toBe(true);
  });

  it('已经过期：该续', () => {
    expect(needsRefresh([status({ valid: false })])).toBe(true);
  });

  it('两张票只要有一张快到点就续（它们共用一张 idToken）', () => {
    const list = [
      status({ source: 'jwxt', remainingMs: 6 * HOUR }),
      status({ source: 'portal', remainingMs: 0.5 * HOUR }),
    ];
    expect(needsRefresh(list)).toBe(true);
  });

  it('边界：正好等于阈值不算快到点', () => {
    expect(needsRefresh([status({ remainingMs: REFRESH_MARGIN_MS })])).toBe(false);
  });
});
