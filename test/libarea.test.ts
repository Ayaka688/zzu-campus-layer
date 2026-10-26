import { describe, expect, it } from 'vitest';
import { resolveLibraryArea } from '../src/core/library';

/* 图书馆只有 http，PWA 跑在 https 上 fetch 必被混合内容拦，
   所以楼层→区域 id 必须是本地常量，不能依赖网络。
   下面的 id 全部实测自页面地址栏：#/seat/appointment?id=<id>
     一楼大厅 3；二楼 8/9/11/12；三楼 13/14/15/16/17；四楼 18/19/20/76 */
describe('resolveLibraryArea 不依赖网络', () => {
  const cases: Array<[string, string]> = [
    ['一楼', '3'],
    ['1楼', '3'],
    ['大厅', '3'],
    ['二楼', '8'],
    ['2楼', '8'],
    ['三楼', '13'],
    ['四楼', '18'],
    // 实测 id 原样返回（已经是正确区域）
    ['3', '3'],
    ['8', '8'],
    ['13', '13'],
    ['18', '18'],
    ['76', '76'],
    // 旧的/野的 id 归到对应楼层
    ['4', '8'],
    ['5', '13'],
    ['6', '18'],
    ['9999', '3'],
  ];

  for (const [input, want] of cases) {
    it(`${input} -> ${want}`, async () => {
      await expect(resolveLibraryArea(input)).resolves.toBe(want);
    });
  }
});
