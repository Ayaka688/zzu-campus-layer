/**
 * appMint / creds 的单元测试。
 *
 * RSA 这一层用真钥匙对验证：Node 生成一对 2048 位密钥 → 用我们的 PKCS#1 v1.5 加密
 * → 用 Node 的 privateDecrypt 解回来。能对上，说明填充和模幂都对。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import {
  APP_DETECT_URL,
  APP_KEY_URL,
  APP_LOGIN_URL,
  base64Decode,
  base64Encode,
  mintViaApp,
  parsePublicKey,
  rsaEncrypt,
  type AppCreds,
} from '../src/core/appMint';
import { clearAppCreds, getAppCreds, newDeviceId, saveAppCreds } from '../src/core/creds';

const keyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function decrypt(cipher: string): string {
  const body = cipher.replace(/^__RSA__/, '');
  const buf = Buffer.from(body, 'base64');
  const out = privateDecrypt(
    { key: keyPair.privateKey, padding: constants.RSA_PKCS1_PADDING },
    buf,
  );
  return out.toString('utf8');
}

describe('base64', () => {
  it('编解码往返（含 0、255 与不足三字节的尾巴）', () => {
    const bytes = Uint8Array.from([0, 1, 2, 255, 128, 7, 9]);
    expect(Array.from(base64Decode(base64Encode(bytes)))).toEqual(Array.from(bytes));
  });

  it('空数组', () => {
    expect(base64Encode(new Uint8Array(0))).toBe('');
    expect(base64Decode('').length).toBe(0);
  });

  it('忽略换行与 PEM 头', () => {
    expect(base64Encode(base64Decode('AAEC\nAwQF'))).toBe('AAECAwQF');
  });
});

describe('RSA PKCS#1 v1.5', () => {
  it('能剥出 n / e，且模长 256 字节', () => {
    const key = parsePublicKey(keyPair.publicKey);
    expect(key.size).toBe(256);
    expect(key.e).toBe(65537n);
    expect(key.n > 2n ** 2047n).toBe(true);
  });

  it('裸 base64（学校返回的形态，没有 PEM 头）也能解', () => {
    const body = keyPair.publicKey.replace(/-----[^-]*-----/g, '').replace(/\s+/g, '');
    const key = parsePublicKey(body);
    expect(key.size).toBe(256);
  });

  it('加密结果能以 __RSA__ 开头，且 Node 解得回原文', () => {
    const key = parsePublicKey(keyPair.publicKey);
    const cipher = rsaEncrypt(key, 'Qaqqaq88=');
    expect(cipher.startsWith('__RSA__')).toBe(true);
    expect(base64Decode(cipher.slice('__RSA__'.length)).length).toBe(256);
    expect(decrypt(cipher)).toBe('Qaqqaq88=');
  });

  it('中文与 emoji 也能往返（按 UTF-8 编码）', () => {
    const key = parsePublicKey(keyPair.publicKey);
    const text = '王子轩 202615020223 🐳';
    expect(decrypt(rsaEncrypt(key, text))).toBe(text);
  });

  it('两次加密结果不同（填充是随机的）', () => {
    const key = parsePublicKey(keyPair.publicKey);
    expect(rsaEncrypt(key, 'same')).not.toBe(rsaEncrypt(key, 'same'));
  });

  it('明文太长就报错，而不是悄悄截断', () => {
    const key = parsePublicKey(keyPair.publicKey);
    expect(() => rsaEncrypt(key, 'x'.repeat(250))).toThrow(/明文太长/);
  });
});

/** 造一张假 idToken（只要 payload 里有 exp 就够 decodeJwt 用） */
function fakeIdToken(exp: number): string {
  const b64 = (o: unknown): string =>
    Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  return `${b64({ alg: 'RS512' })}.${b64({ exp, iss: 'cas.s.zzu.edu.cn' })}.sig`;
}

const creds: AppCreds = { account: '202615020223', password: 'pw', deviceId: 'zzu-layer-test' };

interface Call {
  url: string;
  method: string;
}

let calls: Call[] = [];
const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    return handler(url);
  }) as typeof fetch;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('mintViaApp', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('可信设备：detect need=false → 一次登录就拿到 30 天票', async () => {
    const exp = Math.floor(Date.now() / 1000) + 720 * 3600;
    stubFetch((url) => {
      if (url.startsWith(APP_KEY_URL)) return new Response(keyPair.publicKey, { status: 200 });
      if (url.startsWith(APP_DETECT_URL)) return json({ code: 0, data: { need: false, state: 'abc123' } });
      if (url.startsWith(APP_LOGIN_URL)) {
        return json({ code: 0, data: { idToken: fakeIdToken(exp), refreshToken: 'r.t.s' } });
      }
      return new Response('nope', { status: 404 });
    });

    const out = await mintViaApp(creds);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.refreshToken).toBe('r.t.s');
    expect(out.expMs).toBe(exp * 1000);

    // 三条请求都按 GET 公钥 / POST 两下的顺序发出去
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
    // 两次 POST 都把密码加密了，且带上 deviceId / mfaState
    const login = calls[2]?.url ?? '';
    expect(login).toContain('deviceId=zzu-layer-test');
    expect(login).toContain('mfaState=abc123');
    expect(login).toContain('appId=com.supwisdom.zzu');
    const username = new URL(login).searchParams.get('username') ?? '';
    expect(decrypt(username)).toBe('202615020223');
  });

  it('need=true（新设备没过 MFA）→ 报 mfa，不去登录', async () => {
    stubFetch((url) => {
      if (url.startsWith(APP_KEY_URL)) return new Response(keyPair.publicKey, { status: 200 });
      return json({ code: 0, data: { need: true, state: 's1' } });
    });
    const out = await mintViaApp(creds);
    expect(out).toEqual({ ok: false, reason: 'mfa' });
    expect(calls.length).toBe(2);
  });

  it('登录被拒（密码错）→ 报 rejected 并带服务端 message', async () => {
    stubFetch((url) => {
      if (url.startsWith(APP_KEY_URL)) return new Response(keyPair.publicKey, { status: 200 });
      if (url.startsWith(APP_DETECT_URL)) return json({ code: 0, data: { need: false, state: 's2' } });
      return json({ code: 400, message: 'exception.mfa.verify.error' });
    });
    const out = await mintViaApp(creds);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('rejected');
    expect(out.detail).toContain('mfa.verify.error');
  });

  it('网络/跨域失败 → 报 network，不抛异常炸掉续票流程', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const out = await mintViaApp(creds);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('network');
    expect(out.detail).toContain('Failed to fetch');
  });
});

describe('creds 存储', () => {
  /** 用内存版 localStorage 顶掉 Node 里没有的那个 */
  const mem = new Map<string, string>();
  beforeEach(() => {
    mem.clear();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
  });

  it('没绑定时返回 null', async () => {
    expect(await getAppCreds()).toBeNull();
  });

  it('保存后可读回，deviceId 会自动生成且稳定', async () => {
    const first = await saveAppCreds({ account: ' 202615020223 ', password: 'pw' });
    expect(first.account).toBe('202615020223');
    expect(first.deviceId).toMatch(/^zzu-layer-[0-9a-f]{16}$/);
    const again = await saveAppCreds({ account: '202615020223' });
    expect(again.deviceId).toBe(first.deviceId);
    const got = await getAppCreds();
    expect(got?.password).toBe('pw');
  });

  it('只更新密码时不全清', async () => {
    const first = await saveAppCreds({ account: 'a', password: 'p1' });
    const next = await saveAppCreds({ password: 'p2' });
    expect(next.account).toBe('a');
    expect(next.deviceId).toBe(first.deviceId);
    expect(next.password).toBe('p2');
  });

  it('账号或密码为空就报错，不落库', async () => {
    await expect(saveAppCreds({ account: '', password: 'p' })).rejects.toThrow(/学号和密码/);
    expect(await getAppCreds()).toBeNull();
  });

  it('清除后读不到', async () => {
    await saveAppCreds({ account: 'a', password: 'p' });
    await clearAppCreds();
    expect(await getAppCreds()).toBeNull();
  });

  it('newDeviceId 每次不同', () => {
    expect(newDeviceId()).not.toBe(newDeviceId());
  });
});
