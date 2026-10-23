import { describe, expect, it } from 'vitest';
import { decodeBundle, encodeBundle, parseImportLink, type TokenBundle } from '../src/core/kv';

// 一段结构合法的假 JWT（不参与网络请求，只用来测编解码）
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJpc3MiOiJjYXMuc3patW0ifQ', 'c2lnbmF0dXJl'].join('.');

const bundle = (over: Partial<TokenBundle> = {}): TokenBundle => ({ v: 1, jwxt: JWT, at: 1_700_000_200_000, ...over });

describe('同步码编解码', () => {
  it('encode → decode 原样往返', () => {
    const code = encodeBundle(bundle());
    expect(code).not.toContain('=');
    const back = decodeBundle(code);
    expect(back.v).toBe(1);
    expect(back.jwxt).toBe(JWT);
    expect(typeof back.at).toBe('number');
  });

  it('只有教务票也能往返', () => {
    const back = decodeBundle(encodeBundle(bundle({ portal: undefined })));
    expect(back.jwxt).toBe(JWT);
    expect(back.portal).toBeUndefined();
  });

  it('两张票都在时都保留', () => {
    const back = decodeBundle(encodeBundle(bundle({ portal: JWT })));
    expect(back.jwxt).toBe(JWT);
    expect(back.portal).toBe(JWT);
  });

  it('粘贴时带空格/换行也不影响', () => {
    const code = encodeBundle(bundle());
    expect(decodeBundle(`  ${code}\n\n`).jwxt).toBe(JWT);
  });

  it('不是 base64 / 不是 JSON → 报格式错', () => {
    expect(() => decodeBundle('这不是一段码')).toThrow('这段验证码不是本项目的格式');
    expect(() => decodeBundle('YWJjZGVmZ2hpamtsbW5vcA')).toThrow('这段验证码不是本项目的格式');
  });

  it('版本不对 → 报格式错', () => {
    const bad = Buffer.from(JSON.stringify({ v: 2, jwxt: JWT })).toString('base64').replace(/=+$/, '');
    expect(() => decodeBundle(bad)).toThrow('这段验证码不是本项目的格式');
  });

  it('里面没有任何可用 token → 报「没有登录态」', () => {
    const empty = encodeBundle({ v: 1, at: 1 } as TokenBundle);
    expect(() => decodeBundle(empty)).toThrow('这段验证码里没有可用的登录态');
  });

  it('token 不是三段式 JWT → 报「没有登录态」', () => {
    const bad = encodeBundle({ v: 1, jwxt: 'not-a-jwt', at: 1 } as TokenBundle);
    expect(() => decodeBundle(bad)).toThrow('这段验证码里没有可用的登录态');
  });

  it('同步码里的模型 key 会往返', () => {
    const back = decodeBundle(encodeBundle(bundle({ llm: { apiKey: 'sk-abcdef', model: 'deepseek-chat', enabled: true } })));
    expect(back.llm?.apiKey).toBe('sk-abcdef');
    expect(back.llm?.model).toBe('deepseek-chat');
  });

  it('非 sk- 的 key 会被丢掉', () => {
    const back = decodeBundle(encodeBundle(bundle({ llm: { apiKey: 'oops' } })));
    expect(back.llm).toBeUndefined();
  });

  it('只有 key 没有 token 仍然报「没有登录态」', () => {
    const bad = encodeBundle({ v: 1, at: 1, llm: { apiKey: 'sk-x' } } as TokenBundle);
    expect(() => decodeBundle(bad)).toThrow('这段验证码里没有可用的登录态');
  });
});

describe('从手机粘贴的内容里认登录态', () => {
  it('学校页面的完整地址（?idToken=）', () => {
    const b = parseImportLink(`https://jwxt.zzu.edu.cn/uniapp/index.html?idToken=${JWT}#/pages/tab/main/main`);
    expect(b.jwxt).toBe(JWT);
  });

  it('裸 token 直接可用', () => {
    expect(parseImportLink(JWT).jwxt).toBe(JWT);
  });

  it('带前后空格的同步码也认', () => {
    const code = encodeBundle(bundle());
    expect(parseImportLink(`  ${code}\n`).jwxt).toBe(JWT);
  });

  it('hash 路由里的 idToken 也认（uni-app 常见形态）', () => {
    const got = parseImportLink('https://uniapp.s.zzu.edu.cn/#/pages/tab/main/main?idToken=' + JWT);
    expect(got.jwxt).toBe(JWT);
  });

  it('query 与 hash 同时有东西时，仍能从 hash 里捞出 token', () => {
    const got = parseImportLink('https://jwxt.zzu.edu.cn/uniapp/index.html?from=app#/pages/tab/main/main?idToken=' + JWT);
    expect(got.jwxt).toBe(JWT);
  });

  it('App 自定义 scheme 复制的链接也能认', () => {
    const got = parseImportLink('zzuitOffline://open?target=course&idToken=' + JWT);
    expect(got.jwxt).toBe(JWT);
  });

  it('URL 编码过的 token 会先解码再判断', () => {
    const encoded = encodeURIComponent(JWT);
    const got = parseImportLink('https://jwxt.zzu.edu.cn/uniapp/index.html?idToken=' + encoded);
    expect(got.jwxt).toBe(JWT);
  });

  it('参数名大小写不敏感（IdToken / userToken）', () => {
    expect(parseImportLink('https://x/index.html?IdToken=' + JWT).jwxt).toBe(JWT);
    expect(parseImportLink('https://uniapp.s.zzu.edu.cn/a?userToken=' + JWT).jwxt).toBe(JWT);
  });

  it('ticket= 明确拒绝并提示复制登录后的地址', () => {
    expect(() => parseImportLink('https://cas.s.zzu.edu.cn/cas/login?ticket=ST-123')).toThrow(/ticket|idToken/);
  });

  it('认不出的东西给出可操作提示', () => {
    expect(() => parseImportLink('随便一段话')).toThrow('没认出');
  });

  it('空输入直接报错', () => {
    expect(() => parseImportLink('   ')).toThrow('空的');
  });
});
