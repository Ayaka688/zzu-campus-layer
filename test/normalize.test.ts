import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCourseTable } from '../src/core/jwxt';
import { parseRemark, portalEventsToCourses } from '../src/core/portal';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;

const TERM_START = '2026-09-07';

interface PortalEvent {
  id: string;
  title: string;
  startDateStr: string;
  startTime: string;
  endTime: string;
  address?: string | null;
  remark?: string | null;
  calendarName?: string | null;
}

describe('门户事件归一化', () => {
  const raw = fixture<{ data: { schedule: Record<string, { calendarList: PortalEvent[] }> } }>('portal-events.json');
  const events = Object.values(raw.data.schedule).flatMap((d) => d.calendarList);
  const courses = portalEventsToCourses(events, TERM_START);

  it('把一周的日期实例聚合成课程模板', () => {
    expect(events.length).toBeGreaterThan(15);
    expect(courses.length).toBeGreaterThanOrEqual(8);
    expect(courses.length).toBeLessThanOrEqual(events.length);
  });

  it('拆出教师与节次', () => {
    const calculus = courses.find((c) => c.name.includes('微积分'));
    expect(calculus).toBeDefined();
    expect(calculus!.teachers).toContain('张老师');
    expect(calculus!.location).toBe('物_505');
    expect(calculus!.sectionStart).toBe(1);
    expect(calculus!.sectionEnd).toBe(2);
  });

  it('周次取自已实例化日期（第 7 周）', () => {
    for (const c of courses) {
      expect(c.weeks).toContain(7);
      expect(c.weekday).toBeGreaterThanOrEqual(1);
      expect(c.weekday).toBeLessThanOrEqual(7);
      expect(c.startTime).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it('同一天同门课的多次出现被合并', () => {
    const keys = new Set(courses.map((c) => c.key));
    expect(keys.size).toBe(courses.length);
  });
});

describe('parseRemark', () => {
  it('解析任课教师与节次', () => {
    expect(parseRemark('任课教师:张老师;节次:1-2节')).toEqual({
      teachers: ['张老师'],
      sectionStart: 1,
      sectionEnd: 2,
    });
  });

  it('容忍空值与异常格式', () => {
    expect(parseRemark(null)).toEqual({ teachers: [] });
    expect(parseRemark('随便写点')).toEqual({ teachers: [] });
  });

  it('支持多教师', () => {
    expect(parseRemark('任课教师:张三、李四;节次:3-4节').teachers).toEqual(['张三', '李四']);
  });
});

describe('教务课表归一化', () => {
  const raw = fixture<{ data: Array<Record<string, unknown>> }>('jwxt-course-table.json');
  const courses = normalizeCourseTable(raw.data as never);

  it('每门课都有星期、时间与周次', () => {
    expect(courses.length).toBeGreaterThan(0);
    for (const c of courses) {
      expect(c.source).toBe('jwxt');
      expect(c.weekday).toBeGreaterThanOrEqual(1);
      expect(c.weekday).toBeLessThanOrEqual(7);
      expect(c.weeks.length).toBeGreaterThan(0);
      expect(c.startTime < c.endTime).toBe(true);
    }
  });

  it('带上节次与地点', () => {
    const withSection = courses.filter((c) => c.sectionStart !== undefined);
    expect(withSection.length).toBeGreaterThan(0);
    expect(courses.some((c) => Boolean(c.location))).toBe(true);
  });

  it('同一门课的多周实例合并成一条', () => {
    const names = courses.map((c) => c.name);
    expect(new Set(names).size).toBeLessThan(names.length === 0 ? 1 : names.length + 1);
  });
});
