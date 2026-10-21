import { describe, expect, it } from 'vitest';
import { ApiError, authHint, unwrap } from '../src/core/http';

describe('响应信封', () => {
  it('三种成功信封都能拆出 data', () => {
    expect(unwrap({ code: 0, data: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrap({ result: 0, data: 7 })).toBe(7);
    expect(unwrap({ code: 200, data: ['x'] })).toEqual(['x']);
  });

  it('非信封原样返回', () => {
    expect(unwrap([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('未登录的 code -1 翻成人话，并标记 isAuth', () => {
    let err: unknown;
    try {
      unwrap({ code: -1, message: '没有访问权限01', data: null }, 'portal');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isAuth).toBe(true);
    expect((err as ApiError).message).toBe(authHint('portal'));
    expect((err as ApiError).message).toContain('uniapp.s.zzu.edu.cn');
  });

  it('业务错误保留服务端原文，不当成鉴权失败', () => {
    let err: unknown;
    try {
      unwrap({ code: 500, message: '服务器内部错误，请稍后重试' }, 'jwxt');
    } catch (e) {
      err = e;
    }
    expect((err as ApiError).message).toBe('服务器内部错误，请稍后重试');
    expect((err as ApiError).isAuth).toBe(false);
    expect((err as ApiError).code).toBe(500);
  });
});
