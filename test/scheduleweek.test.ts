import { describe, expect, it } from 'vitest';
import { applyTextHints } from '../src/core/agent';
import { parseIntent, relativeWeekOffset } from '../src/core/intent';
import { getSchedule, resolveScheduleWindow } from '../src/core/tools';
import type { CampusService } from '../src/core/services';
import type { Course, Term } from '../src/core/types';
import { dateOfWeek, weekOfDate } from '../src/core/util';

/** 2026-2027-1：2026-09-07（周一）开学，共 19 周；10-25 是周日（第 7 周），10-26 是周一（第 8 周）。 */
const TERM = {
  startDate: '2026-09-07',
  currentWeek: 7,
  weeks: Array.from({ length: 19 }, (_, i) => i + 1),
};
const SUNDAY = '2026-10-25';

describe('resolveScheduleWindow', () => {
  it('周日问「明天」时用明天的周次，而不是当前周', () => {
    const got = resolveScheduleWindow({ day: 'tomorrow' }, TERM, SUNDAY);
    expect(got.week).toBe(8);
    expect(got.weekday).toBe(1);
    expect(got.date).toBe('2026-10-26');
    expect(got.outOfTerm).toBe(false);
  });

  it('今天在周日，问「今天」仍是第 7 周', () => {
    const got = resolveScheduleWindow({ day: 'today' }, TERM, SUNDAY);
    expect(got.week).toBe(7);
    expect(got.date).toBe(SUNDAY);
  });

  it('只问星期几时按当前周算，并补上那一周的日期', () => {
    const got = resolveScheduleWindow({ day: 1 }, TERM, SUNDAY);
    expect(got.week).toBe(7);
    expect(got.date).toBe(dateOfWeek(TERM.startDate, 7, 1));
    expect(got.date).toBe('2026-10-19');
  });

  it('「下周」= 当前周 + 1；带星期几时日期也跟着到那周', () => {
    expect(resolveScheduleWindow({ weekOffset: 1 }, TERM, SUNDAY).week).toBe(8);
    const got = resolveScheduleWindow({ weekOffset: 1, day: 1 }, TERM, SUNDAY);
    expect(got.week).toBe(8);
    expect(got.date).toBe('2026-10-26');
  });

  it('显式第 N 周的优先级最高', () => {
    const got = resolveScheduleWindow({ week: 3, weekOffset: 1, day: 2 }, TERM, SUNDAY);
    expect(got.week).toBe(3);
    expect(got.date).toBe(dateOfWeek(TERM.startDate, 3, 2));
  });

  it('什么都不指定时就是当前周，且不带日期', () => {
    const got = resolveScheduleWindow({}, TERM, SUNDAY);
    expect(got.week).toBe(7);
    expect(got.date).toBeUndefined();
    expect(got.outOfTerm).toBe(false);
  });

  it('越过教学周要标出来，免得显示假日期', () => {
    const got = resolveScheduleWindow({ weekOffset: 20 }, TERM, SUNDAY);
    expect(got.week).toBe(27);
    expect(got.outOfTerm).toBe(true);
    expect(got.date).toBeUndefined();
  });

  it('服务端没给当前周时用开学日期自己推', () => {
    const got = resolveScheduleWindow({}, { ...TERM, currentWeek: undefined }, SUNDAY);
    expect(got.week).toBe(weekOfDate(TERM.startDate, SUNDAY));
    expect(got.week).toBe(7);
  });
});

describe('relativeWeekOffset', () => {
  it('认「下周/下下周/上周/本周」', () => {
    expect(relativeWeekOffset('下周课表')).toBe(1);
    expect(relativeWeekOffset('下个星期有什么课')).toBe(1);
    expect(relativeWeekOffset('下下周课表')).toBe(2);
    expect(relativeWeekOffset('上周的课表')).toBe(-1);
    expect(relativeWeekOffset('本周还有几节课')).toBe(0);
  });

  it('日常说法不算相对周次', () => {
    expect(relativeWeekOffset('明天有课吗')).toBeUndefined();
    expect(relativeWeekOffset('周三下午有课吗')).toBeUndefined();
    expect(relativeWeekOffset('今天空教室')).toBeUndefined();
  });
});

describe('按天查课表时不带错周次', () => {
  it('applyTextHints 会把模型塞的绝对周次丢掉', () => {
    const got = applyTextHints('get_schedule', { week: 7, day: 1 }, '明天有课吗', SUNDAY);
    expect(got.day).toBe('tomorrow');
    expect(got.week).toBeUndefined();
    expect(got.weekOffset).toBeUndefined();
  });

  it('用户说「下周」时换成 weekOffset，并丢掉旧周次', () => {
    const got = applyTextHints('get_schedule', { week: 7 }, '下周课表', SUNDAY);
    expect(got.week).toBeUndefined();
    expect(got.weekOffset).toBe(1);
  });

  it('用户说「第 8 周」时保留绝对周次', () => {
    const got = applyTextHints('get_schedule', { week: 8 }, '第8周课表', SUNDAY);
    expect(got.week).toBe(8);
    expect(got.weekOffset).toBeUndefined();
  });

  it('正则意图把「下周」翻成 weekOffset=1', () => {
    const got = parseIntent('下周课表', SUNDAY);
    expect(got?.tool).toBe('get_schedule');
    expect(got?.args).toEqual({ weekOffset: 1 });
  });

  it('「下周一有课吗」= next week + monday', () => {
    const got = parseIntent('下周一有课吗', SUNDAY);
    expect(got?.tool).toBe('get_schedule');
    expect(got?.args).toEqual({ weekOffset: 1, day: 1 });
  });

  it('「明天有课吗」只带 day，保证周次由日期推', () => {
    const got = parseIntent('明天有课吗', SUNDAY);
    expect(got?.args).toEqual({ day: 'tomorrow' });
  });
});

/** 只喂 term / courses，测工具真正吐出来的文案。 */
const TERM_RUNTIME: Term = {
  id: '194',
  code: '2026-2027-1',
  startDate: '2026-09-07',
  endDate: '2027-01-17',
  weeks: TERM.weeks,
  currentWeek: 7,
};

const MONDAY_7: Course = {
  key: 'a@7',
  name: '只在第7周上的课',
  teachers: ['甲'],
  weekday: 1,
  startTime: '08:00',
  endTime: '09:40',
  weeks: [7],
  source: 'jwxt',
};
const MONDAY_8: Course = {
  key: 'b@8',
  name: '微积分A(Ⅰ)',
  teachers: ['乙'],
  weekday: 1,
  startTime: '08:00',
  endTime: '09:40',
  weeks: [8],
  source: 'jwxt',
};

function service(courses: Course[]): CampusService {
  return { term: async () => TERM_RUNTIME, courses: async () => courses } as unknown as CampusService;
}

describe('get_schedule 真的按目标日期的周次筛', () => {
  it('周日问「明天有课吗」拿到的是第 8 周的课，标题也写第 8 周', async () => {
    const out = await getSchedule.run({ day: 'tomorrow' }, service([MONDAY_7, MONDAY_8]));
    expect(out.data?.week).toBe(8);
    expect(out.data?.date).toBe('2026-10-26');
    expect(out.data?.count).toBe(1);
    expect(out.text).toContain('微积分A(Ⅰ)');
    expect(out.text).not.toContain('只在第7周上的课');
    expect(out.text).toContain('第 8 周');
    expect(out.text).toContain('2026-10-26');
  });

  it('那一周确实没课时说「没有课」，不列别的周', async () => {
    const out = await getSchedule.run({ day: 'tomorrow' }, service([MONDAY_7]));
    expect(out.data?.count).toBe(0);
    expect(out.text).toContain('没有课');
    expect(out.text).not.toContain('只在第7周上的课');
  });

  it('「下周课表」比「本周课表」多一周', async () => {
    const svc = service([MONDAY_7, MONDAY_8]);
    const thisWeek = await getSchedule.run({ weekOffset: 0 }, svc);
    const nextWeek = await getSchedule.run({ weekOffset: 1 }, svc);
    expect(thisWeek.data?.week).toBe(7);
    expect(nextWeek.data?.week).toBe(8);
    expect(thisWeek.text).toContain('只在第7周上的课');
    expect(nextWeek.text).toContain('微积分A(Ⅰ)');
    expect(thisWeek.text).not.toBe(nextWeek.text);
  });
});
