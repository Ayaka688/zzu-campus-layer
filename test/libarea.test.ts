import { describe, expect, it } from 'vitest';
import { resolveLibraryArea } from '../src/core/library';

/* 图书馆只有 http，PWA 跑在 https 上 fetch 必被混合内容拦，
   所以楼层→区域 id 必须是本地常量，不能依赖网络。 */
describe('resolveLibraryArea 不依赖网络', () => {
  const cases: Array<[string, string]> = [
    ['2', '2'],
    ['3', '2'],
    ['4', '72'],
    ['5', '52'],
    ['6', '53'],
    ['一楼', '2'],
    ['二楼', '72'],
    ['三楼', '52'],
    ['四楼', '53'],
    ['72', '72'],
    ['52', '52'],
    ['53', '53'],
  ];

  for (const [input, want] of cases) {
    it(`${input} -> ${want}`, async () => {
      expect(await resolveLibraryArea(input)).toBe(want);
    });
  }

  it('野 id 回落一楼，不发出去', async () => {
    expect(await resolveLibraryArea('9999')).toBe('2');
  });
});
