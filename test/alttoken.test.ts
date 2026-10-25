import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/** node 环境没有 localStorage，先塞一个内存版再 import storage（它内部会读 getKV()）。 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

(globalThis as unknown as { localStorage: Storage }).localStorage = memoryStorage();

const storage = await import('../src/core/storage');

const b64url = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
/** 只需要形如 JWT、payload 里有 exp，tokenMeta 就认 */
const jwt = (expMs: number): string => `${b64url({ alg: 'RS512' })}.${b64url({ exp: Math.floor(expMs / 1000) })}.c2ln`;

const HOUR = 3_600_000;

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T10:00:00+08:00'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T10:00:00+08:00'));
});

async function seed(portalExpMs?: number, jwxtExpMs?: number): Promise<{ portal?: string; jwxt?: string }> {
  await storage.clearTokens();
  const now = Date.now();
  const out: { portal?: string; jwxt?: string } = {};
  if (portalExpMs !== undefined) {
    out.portal = jwt(now + portalExpMs);
    await storage.saveToken('portal', out.portal);
  }
  if (jwxtExpMs !== undefined) {
    out.jwxt = jwt(now + jwxtExpMs);
    await storage.saveToken('jwxt', out.jwxt);
  }
  return out;
}

describe('两张票互顶', () => {
  it('门户票过期了，能拿到 30 天的教务票去试', async () => {
    const { portal, jwxt } = await seed(-HOUR, 30 * 24 * HOUR);
    expect(await storage.altToken('portal', portal!)).toBe(jwxt);
  });

  it('试过顶不上，6 小时内就不再来回试', async () => {
    const { portal } = await seed(-HOUR, 30 * 24 * HOUR);
    await storage.noteSwapVerdict('portal', false);
    expect(await storage.altToken('portal', portal!)).toBeUndefined();

    vi.setSystemTime(Date.now() + 7 * HOUR);
    expect(await storage.altToken('portal', portal!)).toBeDefined();
  });

  it('顶过一次之后，结论是「能顶」，下次照样试', async () => {
    const { portal, jwxt } = await seed(-HOUR, 30 * 24 * HOUR);
    await storage.noteSwapVerdict('portal', true);
    expect(await storage.altToken('portal', portal!)).toBe(jwxt);
  });

  it('两张票都过期 / 只剩一张，就不换', async () => {
    const both = await seed(-HOUR, -HOUR);
    expect(await storage.altToken('portal', both.portal!)).toBeUndefined();

    const only = await seed(-HOUR, undefined);
    expect(await storage.altToken('portal', only.portal!)).toBeUndefined();
  });

  it('同一个 token 不会自己跟自己换', async () => {
    const { jwxt } = await seed(undefined, 30 * 24 * HOUR);
    expect(await storage.altToken('portal', jwxt!)).toBeUndefined();
  });
});
