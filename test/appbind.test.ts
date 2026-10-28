/**
 * 绑定向导（appBind）的单元测试。
 *
 * 这里不碰真网络：fetch 全被换掉，只看「顺序对不对、参数对不对、状态码怎么翻译成结果」。
 * 壳里的那条路单独测：给 globalThis.window 装一个假的 CampusNotify + __campusBind。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_ATTEST,
  canBindInShell,
  clearShellCrash,
  initSecurePhone,
  shellLastCrash,
  startBind,
  startBindInShell,
  submitCode,
  submitCodeInShell,
} from '../src/core/appBind';
import type { AppCreds } from '../src/core/appMint';
import { generateKeyPairSync } from 'node:crypto';

const pem = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).publicKey;

const creds: AppCreds = { account: '202615020223', password: 'pw', deviceId: 'zzu-layer-test' };

interface Call {
  url: string;
  method: string;
  body: string;
}

let calls: Call[] = [];
const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string) => unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '' });
    const body = handler(url);
    // 公钥端点是裸 PEM（text() 读），其他都是 JSON
    if (typeof body === 'string') return new Response(body, { status: 200 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/** 学校那几个端点的默认应答：公钥 / detect 要验证 / init 给 gid / send 成功 / valid 通过。 */
function school(overrides: Record<string, unknown> = {}) {
  return (url: string): unknown => {
    if (url.includes('/token/jwt/publicKey')) return pem;
    for (const [key, body] of Object.entries(overrides)) {
      if (url.includes(key)) return body;
    }
    if (url.includes('/token/mfa/detect')) return { code: 0, data: { need: true, state: 'ETFwJM' } };
    if (url.includes('/token/mfa/initByType/securephone')) {
      return { code: 0, data: { gid: 'gid-1', securePhone: '195****7500', attestServerUrl: APP_ATTEST } };
    }
    if (url.includes('/securephone/send')) return { code: 0, data: { result: 'ok', status: 1 } };
    if (url.includes('/securephone/valid')) return { code: 0, data: { result: 'ok', status: 2 } };
    return {};
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as { window?: unknown }).window;
});

describe('initSecurePhone', () => {
  it('GET 带 state，取回 gid / 手机号 / attest 域名', async () => {
    stubFetch(school());
    const ctx = await initSecurePhone('ETFwJM');
    expect(ctx.gid).toBe('gid-1');
    expect(ctx.phone).toBe('195****7500');
    expect(ctx.attest).toBe(APP_ATTEST);
    expect(calls[0]?.url).toContain('state=ETFwJM');
    expect(calls[0]?.method).toBe('GET');
  });

  it('没有 gid 就抛错（带上学校的 message）', async () => {
    stubFetch(() => ({ code: -1, message: '验证码发送过于频繁，请稍后再试' }));
    await expect(initSecurePhone('x')).rejects.toThrow(/频繁/);
  });
});

describe('startBind', () => {
  it('设备已可信：只问一次 detect，不再发短信', async () => {
    stubFetch(
      school({ '/token/mfa/detect': { code: 0, data: { need: false, state: '' } } }),
    );
    const out = await startBind(creds);
    expect(out).toEqual({ ok: true, trusted: true });
    expect(calls.some((c) => c.url.includes('/securephone/send'))).toBe(false);
  });

  it('设备不可信：detect → init → send 三步，body 里带同一个 gid', async () => {
    stubFetch(school());
    const out = await startBind(creds);
    expect(out.ok).toBe(true);
    if (!out.ok || out.trusted) throw new Error('应该是要验证');
    expect(out.phone).toBe('195****7500');
    expect(out.ctx.gid).toBe('gid-1');
    expect(out.ctx.state).toBe('ETFwJM');
    const send = calls.find((c) => c.url.includes('/securephone/send'));
    expect(send?.method).toBe('POST');
    expect(JSON.parse(send?.body ?? '{}')).toEqual({ gid: 'gid-1' });
    // 密码是 RSA 加密过的，不能是明文
    const detect = calls.find((c) => c.url.includes('/token/mfa/detect'));
    expect(detect?.url).toContain('__RSA__');
    expect(detect?.url ?? '').not.toContain('pw&');
  });

  it('短信发不出去（限流）就报 rejected，并把学校的话带出来', async () => {
    stubFetch(
      school({ '/securephone/send': { code: -1, message: '验证码发送过于频繁，请稍后再试' } }),
    );
    const out = await startBind(creds);
    expect(out).toEqual({ ok: false, reason: 'rejected', detail: '验证码发送过于频繁，请稍后再试' });
  });

  it('网络挂了报 network，不抛异常', async () => {
    globalThis.fetch = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;
    const out = await startBind(creds);
    expect(out).toEqual({ ok: false, reason: 'network', detail: 'fetch failed' });
  });
});

describe('submitCode', () => {
  const ctx = { state: 'ETFwJM', gid: 'gid-1', attest: APP_ATTEST };

  it('status 2 才算过', async () => {
    stubFetch(school());
    await expect(submitCode(ctx, '8331')).resolves.toEqual({ ok: true });
    const valid = calls.find((c) => c.url.includes('/securephone/valid'));
    expect(JSON.parse(valid?.body ?? '{}')).toEqual({ gid: 'gid-1', code: '8331' });
  });

  it('status 3（码错/过期）报 code', async () => {
    stubFetch(school({ '/securephone/valid': { code: 0, data: { status: 3 } } }));
    const out = await submitCode(ctx, '0000');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('code');
    expect(out.detail).toMatch(/status=3/);
  });

  it('明显不是验证码的输入就地拦下，不发请求', async () => {
    stubFetch(school());
    const out = await submitCode(ctx, 'ab');
    expect(out.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('带空格的码会先清掉空格', async () => {
    stubFetch(school());
    await submitCode(ctx, ' 83 31 ');
    const valid = calls.find((c) => c.url.includes('/securephone/valid'));
    expect(JSON.parse(valid?.body ?? '{}').code).toBe('8331');
  });
});

describe('壳里的那条路', () => {
  type Step = (raw: string) => void;
  interface FakeShell {
    CampusNotify: { appBindStart: (json: string) => void; appBindSubmit: (code: string) => void };
    __campusBind?: Step;
  }

  function fakeShell(reply: Record<string, unknown>): FakeShell {
    const w: FakeShell = {
      CampusNotify: {
        appBindStart: (json: string) => {
          // 原生收到 creds 之后会异步回调页面；这里同步回，够测
          setTimeout(() => w.__campusBind?.(JSON.stringify(reply)), 0);
        },
        appBindSubmit: (_code: string) => {
          setTimeout(() => w.__campusBind?.(JSON.stringify(reply)), 0);
        },
      },
    };
    (globalThis as { window?: unknown }).window = w;
    return w;
  }

  it('没有壳的时候 canBindInShell() 是 false', () => {
    expect(canBindInShell()).toBe(false);
  });

  it('壳回 step=code：拿到手机号，state/gid 可以空着', async () => {
    fakeShell({ step: 'code', phone: '195****7500' });
    expect(canBindInShell()).toBe(true);
    const out = await startBindInShell(creds);
    if (!out.ok || out.trusted) throw new Error('应该是要验证');
    expect(out.phone).toBe('195****7500');
    expect(out.ctx.gid).toBe('');
  });

  it('壳回 step=done：说明设备本来就可信，票可以由原生换', async () => {
    fakeShell({ step: 'done' });
    await expect(startBindInShell(creds)).resolves.toEqual({ ok: true, trusted: true });
  });

  it('壳回 step=done 带 idToken：直接拿到 30 天票', async () => {
    fakeShell({ step: 'done', idToken: 'a.b.c' });
    await expect(submitCodeInShell('8331')).resolves.toEqual({ ok: true, idToken: 'a.b.c' });
  });

  it('壳回 step=error：翻译成失败，不抛', async () => {
    fakeShell({ step: 'error', message: '验证码不对或已过期' });
    const out = await submitCodeInShell('0000');
    expect(out).toEqual({ ok: false, reason: 'code', detail: '验证码不对或已过期' });
  });

  it('壳一直不回：超时后报错，不永久挂着', async () => {
    const w: FakeShell = { CampusNotify: { appBindStart: () => {}, appBindSubmit: () => {} } };
    (globalThis as { window?: unknown }).window = w;
    const out = await startBindInShell(creds, 20);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.detail).toMatch(/超时/);
    expect(w.__campusBind).toBeUndefined();
  });

  it('壳里有崩溃记录就读得到（手机上没 logcat，只能靠这条链）', () => {
    let cleared = false;
    const w = {
      CampusNotify: {
        appBindStart: () => {},
        appBindSubmit: () => {},
        lastCrash: () => 'OutOfMemoryError: Failed to allocate\n  at cn.zzu...',
        clearCrash: () => {
          cleared = true;
        },
      },
    };
    (globalThis as { window?: unknown }).window = w;
    expect(shellLastCrash()).toMatch(/OutOfMemoryError/);
    clearShellCrash();
    expect(cleared).toBe(true);
  });

  it('老壳没有这两个方法时返回空串、也不报错', () => {
    (globalThis as { window?: unknown }).window = { CampusNotify: { appBindStart: () => {} } };
    expect(shellLastCrash()).toBe('');
    expect(() => clearShellCrash()).not.toThrow();
  });

  it('壳的方法抛异常也只当没有', () => {
    (globalThis as { window?: unknown }).window = {
      CampusNotify: {
        appBindStart: () => {},
        lastCrash: () => {
          throw new Error('boom');
        },
        clearCrash: () => {
          throw new Error('boom');
        },
      },
    };
    expect(shellLastCrash()).toBe('');
    expect(() => clearShellCrash()).not.toThrow();
  });
});
