import { describe, expect, it } from 'vitest';
import { extractNeedMinutes, planStudy, renderStudyPlan } from '../src/core/study';
import { parseIntent } from '../src/core/intent';
import type { FreeRoom } from '../src/core/types';

const room = (name: string, minutes: number, seats = 60): FreeRoom => ({
  room: { id: name, name, ...(seats ? { seats } : {}) } as FreeRoom['room'],
  freeSections: [1, 2, 3],
  windows: [{ start: 480, end: 480 + minutes }],
  longestMin: minutes,
  freeNowMin: minutes,
});

describe('时长解析', () => {
  it('中文数字与分钟', () => {
    expect(extractNeedMinutes('我想自习两小时')).toBe(120);
    expect(extractNeedMinutes('学一个半小时')).toBe(90);
    expect(extractNeedMinutes('看 45 分钟书')).toBe(45);
    expect(extractNeedMinutes('自习 3 小时')).toBe(180);
    expect(extractNeedMinutes('找个地方看书')).toBeUndefined();
    expect(extractNeedMinutes('泡半天')).toBe(240);
  });
});

describe('自习计划', () => {
  const rooms = [room('北1_101', 200), room('南1_203', 90), room('北3_403', 30)];

  it('够时长的排前面，不够的降级为备选', () => {
    const plan = planStudy({ needMinutes: 120, rooms });
    expect(plan.options[0]?.name).toBe('北1_101');
    expect(plan.options.every((o) => o.kind === 'classroom')).toBe(true);
  });

  it('给了出发点就按步行时间排序', () => {
    // 北1 与 北1_101 同楼（0 分钟），南1_203 在另一区
    const plan = planStudy({ needMinutes: 60, rooms, near: '北1_102' });
    expect(plan.options[0]?.walkMin).toBe(0);
    expect(plan.options[0]?.name).toBe('北1_101');
  });

  it('都凑不够时长时，至少给最长的几个并标注不够', () => {
    const plan = planStudy({ needMinutes: 300, rooms });
    expect(plan.options.length).toBeGreaterThan(0);
    const text = renderStudyPlan(plan, { date: '2026-10-23' });
    expect(text).toContain('不够');
  });

  it('maxWalkMin 过滤掉太远的', () => {
    const plan = planStudy({ needMinutes: 60, rooms, near: '图_1', maxWalkMin: 1 });
    expect(plan.options.every((o) => (o.walkMin ?? 0) <= 1)).toBe(true);
  });

  it('图书馆作为换场地的备选出现在末尾，并给余量', () => {
    const plan = planStudy({
      needMinutes: 60,
      rooms,
      library: {
        date: '2026-10-23',
        dates: ['2026-10-23'],
        url: 'http://order.lib.zzu.edu.cn/h5/index.html#/seat/index',
        premises: [{ id: '3', name: '一楼大厅', total: 216, free: 123, floors: [{ id: '3', name: '一楼', total: 216, free: 123 }] }],
      },
    });
    const lib = plan.options.find((o) => o.kind === 'library');
    expect(lib?.detail).toContain('123/216');
    expect(plan.libraryNote).toContain('123/216');
  });

  it('没有任何位置时给出可操作的下一步', () => {
    const plan = planStudy({ needMinutes: 60, rooms: [] });
    expect(renderStudyPlan(plan, { date: '2026-10-23' })).toContain('凑不出来');
  });
});

describe('意图路由', () => {
  it('「我想自习两小时」直接进 find_study_spot，不被空教室抢走', () => {
    const i = parseIntent('我想自习两小时', '2026-10-22');
    expect(i?.tool).toBe('find_study_spot');
    expect(i?.args.needMinutes).toBe(120);
  });

  it('带地点的自习会把 near 传进去', () => {
    const i = parseIntent('在图书馆附近找个安静地方学两小时', '2026-10-22');
    expect(i?.tool).toBe('find_study_spot');
  });
});
