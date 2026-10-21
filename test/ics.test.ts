import { describe, expect, it } from 'vitest';
import { coursesToIcs } from '../src/core/ics';
import { Course, Term } from '../src/core/types';

const term: Term = Term.parse({
  id: '194',
  code: '2026-2027-1',
  startDate: '2026-09-07',
  endDate: '2027-01-17',
  weeks: Array.from({ length: 19 }, (_, i) => i + 1),
  currentWeek: 7,
});

const course = (over: Partial<Course>): Course =>
  Course.parse({
    key: 'k',
    name: '微积分A (Ⅰ)',
    teachers: ['张老师'],
    location: '物_505',
    weekday: 1,
    startTime: '08:00',
    endTime: '09:40',
    weeks: [1, 3],
    source: 'jwxt',
    ...over,
  });

describe('iCalendar 导出', () => {
  it('每个「课 × 周」生成一个事件', () => {
    const ics = coursesToIcs([course({})], { term, now: new Date('2026-10-20T00:00:00Z') });
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.trim().endsWith('END:VCALENDAR')).toBe(true);
  });

  it('日期按学期首周推算，并以北京时间本地写法输出', () => {
    const ics = coursesToIcs([course({ weeks: [1] })], { term });
    expect(ics).toContain('DTSTART;TZID=Asia/Shanghai:20260907T080000');
    expect(ics).toContain('DTEND;TZID=Asia/Shanghai:20260907T094000');
  });

  it('周次可以裁剪', () => {
    const all = coursesToIcs([course({ weeks: [1, 2, 3, 4] })], { term });
    const cut = coursesToIcs([course({ weeks: [1, 2, 3, 4] })], { term, fromWeek: 2, toWeek: 3 });
    expect((all.match(/BEGIN:VEVENT/g) ?? []).length).toBe(4);
    expect((cut.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
  });

  it('转义逗号分号与折行', () => {
    const ics = coursesToIcs([course({ name: '高级语言程序设计;实验,一', weeks: [1] })], { term });
    expect(ics).toContain('SUMMARY:高级语言程序设计\\;实验\\,一');
    for (const line of ics.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  it('事件 UID 唯一', () => {
    const ics = coursesToIcs([course({ weeks: [1, 2, 3] })], { term });
    const uids = [...ics.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]);
    expect(new Set(uids).size).toBe(uids.length);
  });
});
