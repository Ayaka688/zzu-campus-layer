import { describe, expect, it } from 'vitest';
import { decodeBundle, encodeBundle, type TokenBundle } from '../src/core/kv';

// 一段结构合法的假 JWT（不参与网络请求，只用来测编解码）
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJpc3MiOiJjYXMuc3patW0ifQ', 'c2lnbmF0dXJl'].join('.');

const bundle = (over: Partial<TokenBundle> = {}): TokenBundle => ({ v: 1, jwxt: JWT, at: 1_700_000_200_000, ...over });

describe('同步码编解码', () => {
  it('encode → decode 原样往返', () => {
    const code = encodeBundle(bundle());
    expect(code).not.toContain('='); // 去掉了 padding 的 base64
    const back = decodeBundle(code);
    expect(back.v).toBe(1);
    expect(back.jwxt).toBe(JWT);
    expect(typeof back.at).toBe('number');
  });

  it('只有教务票也能用（门户可选）', () => {
    expect(decodeBundle(encodeBundle(bundle())).portal).toBeUndefined();
  });

  it('两张票都在时都保留', () => {
    const back = decodeBundle(encodeBundle(bundle({ portal: `${JWT}x` })));
    expect(back.jwxt).toBe(JWT);
    expect(back.portal).toBe(`${JWT}x`);
  });

  it('带空格/换行的粘贴也能认（手机输入法常带）', () => {
    const code = encodeBundle(bundle());
    expect(decodeBundle(` ${code.slice(0, 20)}\n${code.slice(20)} `).jwxt).toBe(JWT);
  });

  it('不是 base64 / 不是 JSON → 报格式错', () => {
    expect(() => decodeBundle('这不是一段码')).toThrow('这段验证码不是本项目的格式');
    expect(() => decodeBundle(Buffer.from('hello').toString('base64'))).toThrow('这段验证码不是本项目的格式');
  });

  it('版本不对 → 报格式错', () => {
    const wrong = Buffer.from(JSON.stringify({ v: 2, jwxt: JWT, at: 1 }), 'utf8').toString('base64');
    expect(() => decodeBundle(wrong)).toThrow('这段验证码不是本项目的格式');
  });

  it('里面没有任何可用 token → 报「没有登录态」', () => {
    const empty = Buffer.from(JSON.stringify({ v: 1, at: 1 }), 'utf8').toString('base64');
    expect(() => decodeBundle(empty)).toThrow('这段验证码里没有可用的登录态');
  });

  it('token 不是三段式 JWT → 报「没有登录态」', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, jwxt: 'abc', at: 1 }), 'utf8').toString('base64');
    expect(() => decodeBundle(bad)).toThrow('这段验证码里没有可用的登录态');
  });

  it('带上模型 key 也能往返（手机端就不用再填）', () => {
    const back = decodeBundle(encodeBundle(bundle({ llm: { apiKey: 'sk-abc123', model: 'DeepSeek-R1', enabled: true } })));
    expect(back.llm).toEqual({ apiKey: 'sk-abc123', model: 'DeepSeek-R1', enabled: true });
  });

  it('key 不是 sk- 开头就丢掉（不把可疑字符串带到手机上）', () => {
    const back = decodeBundle(encodeBundle(bundle({ llm: { apiKey: 'evil', model: 'x' } })));
    expect(back.llm).toBeUndefined();
  });

  it('只有 key 没 token 仍然报「没有登录态」', () => {
    const onlyKey = Buffer.from(JSON.stringify({ v: 1, llm: { apiKey: 'sk-1' }, at: 1 }), 'utf8').toString('base64');
    expect(() => decodeBundle(onlyKey)).toThrow('这段验证码里没有可用的登录态');
  });
});
