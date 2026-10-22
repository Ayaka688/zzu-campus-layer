import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildingOf, walkMinutes } from '../src/core/walk';
import { byDuration, freeWindows, hhmmToMin } from '../src/core/services';
import { fmtDur, minToHhmm } from '../src/core/render';

describe('楼间步行', () => {
  it('按教室名前缀认出楼，长前缀优先（北1 不会吃掉北10）', () => {
    expect(buildingOf('北3_403')?.prefix).toBe('北3');
    expect(buildingOf('南1_303')?.prefix).toBe('南1');
    expect(buildingOf('物_505')?.prefix).toBe('物');
    expect(buildingOf('北10_101')).toBeUndefined();
  });

  it('同楼 0 分钟，跨区有分钟数且对称', () => {
    expect(walkMinutes('北1_101', '北1_202')).toBe(0);
    const a = walkMinutes('南1_101', '北3_403')!;
    const b = walkMinutes('北3_403', '南1_101')!;
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(40);
  });

  it('认不出的楼返回 undefined', () => {
    expect(walkMinutes('量子实验室', '北1_101')).toBeUndefined();
  });
});

describe('连续空闲窗口', () => {
  it('HHmm → 分钟', () => {
    expect(hhmmToMin(1010)).toBe(610);
    expect(hhmmToMin(800)).toBe(480);
    expect(hhmmToMin(0)).toBe(0);
  });

  it('把占用合并后取补集：10:10–11:50 有课，则 08:00–10:10 与 11:50–22:00 空闲', () => {
    const w = freeWindows([{ s: 610, e: 710 }], 480, 1320);
    expect(w[0]).toEqual({ start: 480, end: 610 });
    expect(w[1]).toEqual({ start: 710, end: 1320 });
  });

  it('相邻占用会被合并，不会切出 1 分钟的假窗口', () => {
    const w = freeWindows(
      [
        { s: 480, e: 660 },
        { s: 660, e: 700 },
        { s: 700, e: 780 },
      ],
      480,
      1320,
    );
    expect(w).toEqual([{ start: 780, end: 1320 }]);
  });

  it('全天排满时没有窗口', () => {
    expect(freeWindows([{ s: 480, e: 1320 }], 480, 1320)).toEqual([]);
  });

  it('不足 20 分钟的碎片被丢掉（赶不过去，没意义）', () => {
    const w = freeWindows([{ s: 480, e: 490 }, { s: 500, e: 1320 }], 480, 1320);
    expect(w).toEqual([]);
  });
});

describe('排序：现在能坐的排前面', () => {
  it('freeNowMin 大的优先，其次 longestMin', () => {
    const list = [
      { room: { name: 'B' }, longestMin: 300, freeNowMin: 10 },
      { room: { name: 'A' }, longestMin: 60, freeNowMin: 90 },
      { room: { name: 'C' }, longestMin: 400 },
    ];
    expect(byDuration(list).map((x) => x.room.name)).toEqual(['A', 'B', 'C']);
  });
});

describe('时长/时间格式', () => {
  it('分钟转人话与 HH:mm', () => {
    expect(fmtDur(160)).toBe('2 小时 40 分');
    expect(fmtDur(120)).toBe('2 小时');
    expect(fmtDur(45)).toBe('45 分钟');
    expect(minToHhmm(610)).toBe('10:10');
  });
});
