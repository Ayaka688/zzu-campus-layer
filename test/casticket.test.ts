import { describe, expect, it } from 'vitest';
import { decodeCasTicket, parseImportLink } from '../src/core/kv';

/** 造一个「看起来像真 JWT」的三段串 */
const jwt = (payload: Record<string, unknown>) => {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'RS512' })}.${b64(payload)}.c2lnbmF0dXJl`;
};

const INNER = jwt({ iss: 'cas.s.zzu.edu.cn', ATTR_userNo: '202600000001' });
/** CAS 回跳时带的 ticket：payload 里装着 idToken */
const TICKET = jwt({ idToken: INNER });

describe('decodeCasTicket', () => {
  it('从 ticket 的 payload 里取出 idToken', () => {
    expect(decodeCasTicket(TICKET)).toBe(INNER);
  });

  it('payload 里没有 idToken 时返回 undefined', () => {
    expect(decodeCasTicket(jwt({ foo: 'bar' }))).toBeUndefined();
  });

  it('不是 JWT（例如 ST- 开头的普通票据）返回 undefined', () => {
    expect(decodeCasTicket('ST-12345-abcdef-cas')).toBeUndefined();
    expect(decodeCasTicket('')).toBeUndefined();
  });
});

describe('parseImportLink 认 ticket', () => {
  it('网址里带 ?ticket= 也能导入（解出内层 idToken）', () => {
    const url = `https://uniapp.s.zzu.edu.cn/pages/tab/index/index?ticket=${encodeURIComponent(TICKET)}`;
    expect(parseImportLink(url).jwxt).toBe(INNER);
  });

  it('网址里 ticket 出现在 hash 的 query 里也能导入', () => {
    const url = `https://uniapp.s.zzu.edu.cn/#/pages/tab/index/index?ticket=${TICKET}`;
    expect(parseImportLink(url).jwxt).toBe(INNER);
  });

  it('直接粘 ticket 本体也能导入', () => {
    expect(parseImportLink(TICKET).jwxt).toBe(INNER);
  });

  it('ticket 里没有 idToken 时给出可读的报错', () => {
    const bad = `https://uniapp.s.zzu.edu.cn/pages/tab/index/index?ticket=${jwt({ foo: 1 })}`;
    expect(() => parseImportLink(bad)).toThrow(/没有 idToken/);
  });

  it('ST- 型普通票据不会被当成 token', () => {
    expect(() => parseImportLink('ST-998877-abcdef-cas')).toThrow();
  });
});
