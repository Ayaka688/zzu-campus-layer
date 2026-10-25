import { describe, expect, it } from 'vitest';
import type { TokenStatus } from '../src/core/storage';

function status(source: 'portal' | 'jwxt', valid: boolean): TokenStatus {
  return { source, present: true, valid };
}

describe('自动续期的开关条件', () => {
  it('还有能用的票就不折腾', async () => {
    const { hasUsableToken, shouldRenew } = await import('../src/core/renew');
    expect(hasUsableToken([status('portal', false), status('jwxt', true)])).toBe(true);
    expect(shouldRenew([status('portal', false), status('jwxt', true)], 0)).toBe(false);
  });

  it('两张票都过期/没有，才试一次', async () => {
    const { shouldRenew } = await import('../src/core/renew');
    expect(shouldRenew([status('portal', false), status('jwxt', false)], 0)).toBe(true);
    expect(shouldRenew([{ source: 'portal', present: false, valid: false }], 0)).toBe(true);
  });

  it('刚试过就等 10 分钟再说', async () => {
    const { shouldRenew } = await import('../src/core/renew');
    const now = 1_000_000_000;
    expect(shouldRenew([status('portal', false)], now - 60_000, now)).toBe(false);
    expect(shouldRenew([status('portal', false)], now - 11 * 60_000, now)).toBe(true);
  });

  it('CAS 地址带的是教务首页（回跳时 ticket 里就是新 idToken）', async () => {
    const { casRenewUrl } = await import('../src/core/renew');
    const url = casRenewUrl();
    expect(url).toContain('https://cas.s.zzu.edu.cn/cas/login?service=');
    expect(decodeURIComponent(url.split('service=')[1]!)).toBe('https://jwxt.zzu.edu.cn/uniapp/index.html');
  });
});
