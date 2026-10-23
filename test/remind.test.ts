import { describe, expect, it } from 'vitest';
import { buildReminderBlocks } from '../src/core/remind';
import type { Course } from '../src/core/types';

function course(p: Partial<Course> & { name: string; weekday: number; startTime: string; endTime: string }): Course {
  const { name, weekday, startTime, endTime, ...rest } = p;
  return {
    key: name + startTime,
    teachers: [],
    weeks: [],
    source: 'jwxt',
    name,
    weekday,
    startTime,
    endTime,
    ...rest,
  } as Course;
}

// 2026-10-21 是周三
const WED = 3;
const NOW = new Date('2026-10-21T07:00:00+08:00');

describe('课前提醒', () => {
  it('单节课提前 30 分钟，正文带时间与教室', () => {
    const blocks = buildReminderBlocks(
      [course({ name: '线性代数', weekday: WED, startTime: '10:10', endTime: '11:50', location: '材_606' })],
      { now: NOW },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.at).toBe(new Date('2026-10-21T09:40:00+08:00').getTime());
    expect(blocks[0]!.body).toContain('线性代数');
    expect(blocks[0]!.body).toContain('材_606');
    expect(blocks[0]!.title).toContain('一节');
  });

  it('上午连着上的两节课只弹一条，正文两节都写', () => {
    const blocks = buildReminderBlocks(
      [
        course({ name: '微积分A', weekday: WED, startTime: '08:00', endTime: '09:40', location: '物_505' }),
        course({ name: '大学英语', weekday: WED, startTime: '10:10', endTime: '11:50', location: '北3_403' }),
      ],
      { now: NOW },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.at).toBe(new Date('2026-10-21T07:30:00+08:00').getTime());
    expect(blocks[0]!.title).toContain('2 节');
    expect(blocks[0]!.body).toContain('微积分A');
    expect(blocks[0]!.body).toContain('大学英语');
  });

  it('上午最后一节和下午第一节不合并（间隔太大）', () => {
    const blocks = buildReminderBlocks(
      [
        course({ name: '上午课', weekday: WED, startTime: '10:10', endTime: '11:50' }),
        course({ name: '下午课', weekday: WED, startTime: '14:00', endTime: '15:40' }),
      ],
      { now: NOW },
    );
    expect(blocks).toHaveLength(2);
  });

  it('已经过点的课不再提醒（7:00 时 7:30 的课还在，6:00 的课没有）', () => {
    const blocks = buildReminderBlocks(
      [course({ name: '早课', weekday: WED, startTime: '06:20', endTime: '07:50' })],
      { now: new Date('2026-10-21T09:00:00+08:00') },
    );
    expect(blocks).toHaveLength(0);
  });

  it('按教学周过滤：只在本周的课才排提醒', () => {
    const courses = [
      course({ name: '单周课', weekday: WED, startTime: '14:00', endTime: '15:40', weeks: [7] }),
      course({ name: '双周课', weekday: WED, startTime: '16:00', endTime: '17:40', weeks: [8] }),
    ];
    const blocks = buildReminderBlocks(courses, { now: NOW, termStart: '2026-09-07', days: 1 });
    const body = blocks.map((b) => b.body).join('|');
    expect(body).toContain('单周课');
    expect(body).not.toContain('双周课');
  });
});
