import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, authHint, send, setTokenSwap } from '../src/core/http';

const realFetch = globalThis.fetch;
const seen: string[] = [];
const verdicts: Array<[string, boolean]> = [];

function stubFetch(reply: (token: string) => { status?: number; body: unknown }): void {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const token = headers['X-Id-Token'] ?? '';
    seen.push(token);
    const { status = 200, body } = reply(token);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const OK = { code: 0, data: { ok: 1 } };
const EXPIRED = { code: -1, message: '没有访问权限01', data: null };

beforeEach(() => {
  seen.length = 0;
  verdicts.length = 0;
  setTokenSwap({
    alt: async () => 'ALT',
    verdict: async (source, ok) => {
      verdicts.push([source, ok]);
    },
  });
});

afterEach(() => {
  setTokenSwap(null);
  globalThis.fetch = realFetch;
});

describe('票过期时拿另一张票再试一次', () => {
  it('门户票失效、教务票能顶就顶上，并记下「能顶」', async () => {
    stubFetch((token) => (token === 'ALT' ? { body: OK } : { body: EXPIRED }));
    const out = await send<{ ok: number }>('https://info.s.zzu.edu.cn/portal-api/x', { token: 'PORTAL', source: 'portal' });
    expect(out).toEqual({ ok: 1 });
    expect(seen).toEqual(['PORTAL', 'ALT']);
    expect(verdicts).toEqual([['portal', true]]);
  });

  it('顶不上就报原来那句人话，并记下「顶不上」', async () => {
    stubFetch(() => ({ body: EXPIRED }));
    const err = (await send('https://info.s.zzu.edu.cn/portal-api/x', { token: 'PORTAL', source: 'portal' }).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe(authHint('portal'));
    expect(verdicts).toEqual([['portal', false]]);
  });

  it('没有另一张票时不折腾，直接报错', async () => {
    setTokenSwap({
      alt: async () => undefined,
      verdict: async (source, ok) => {
        verdicts.push([source, ok]);
      },
    });
    stubFetch(() => ({ body: EXPIRED }));
    await expect(send('https://x/api', { token: 'PORTAL', source: 'portal' })).rejects.toThrow(authHint('portal'));
    expect(seen).toEqual(['PORTAL']);
    expect(verdicts).toEqual([]);
  });

  it('不是鉴权问题（比如 code 500）就不换票', async () => {
    stubFetch(() => ({ body: { code: 500, message: '服务器内部错误，请稍后重试' } }));
    await expect(send('https://x/api', { token: 'PORTAL', source: 'portal' })).rejects.toThrow('服务器内部错误');
    expect(seen).toEqual(['PORTAL']);
  });

  it('换票函数自己炸了也不影响原来的报错', async () => {
    setTokenSwap({
      alt: async () => {
        throw new Error('kv 坏了');
      },
      verdict: async () => undefined,
    });
    stubFetch(() => ({ body: EXPIRED }));
    await expect(send('https://x/api', { token: 'PORTAL', source: 'portal' })).rejects.toThrow(authHint('portal'));
  });
});
