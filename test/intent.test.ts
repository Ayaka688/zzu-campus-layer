import { describe, expect, it } from 'vitest';
import { helpText, parseIntent, relativeDayOffset } from '../src/core/intent';
import { addDays, weekdayOf } from '../src/core/util';

const TODAY = '2026-10-20'; // 周二

describe('相对日期', () => {
  it('今天/明天/后天/大后天 的偏移', () => {
    expect(relativeDayOffset('今天有课吗')).toBe(0);
    expect(relativeDayOffset('明天有课吗')).toBe(1);
    expect(relativeDayOffset('后天有课吗')).toBe(2);
    expect(relativeDayOffset('大后天呢')).toBe(3);
    expect(relativeDayOffset('周三的课')).toBeUndefined();
  });

  it('「后天」也能落到具体日期/星期（模型算不准，规则兜）', () => {
    const schedule = parseIntent('后天有课吗', TODAY);
    expect(schedule?.tool).toBe('get_schedule');
    // 2026-10-20 是周二，+2 = 周四
    expect(schedule?.args).toEqual({ day: 4 });

    const rooms = parseIntent('后天下午的空教室', TODAY);
    expect(rooms?.args).toMatchObject({ date: addDays(TODAY, 2), sections: [5, 6, 7, 8] });
    expect(weekdayOf(addDays(TODAY, 2))).toBe(4);
  });
});

describe('L0 规则意图解析', () => {
  it('课表类问法', () => {
    expect(parseIntent('明天有课吗', TODAY)?.tool).toBe('get_schedule');
    expect(parseIntent('明天有课吗', TODAY)?.args).toEqual({ day: 'tomorrow' });

    expect(parseIntent('第 8 周课表', TODAY)?.args).toEqual({ week: 8 });
    expect(parseIntent('周三的课', TODAY)?.args).toEqual({ day: 3 });
    expect(parseIntent('今天几节课', TODAY)?.args).toEqual({ day: 'today' });
  });

  it('空教室类问法', () => {
    const evening = parseIntent('明天下午的空教室', TODAY);
    expect(evening?.tool).toBe('find_free_room');
    expect(evening?.args).toEqual({ date: addDays(TODAY, 1), sections: [5, 6, 7, 8] });

    const big = parseIntent('主校区 200 人以上的空教室', TODAY);
    expect(big?.tool).toBe('find_free_room');
    expect(big?.args).toMatchObject({ campus: '主校区', minSeats: 200 });

    expect(parseIntent('第3-4节哪里能自习', TODAY)?.args).toMatchObject({ sections: [3, 4] });
  });

  it('通知类问法', () => {
    const kw = parseIntent('查一下「AI 智能体大赛」的通知', TODAY);
    expect(kw?.tool).toBe('search_notice');
    expect(kw?.args).toMatchObject({ query: 'AI 智能体大赛' });
  });

  it('成绩与考试', () => {
    expect(parseIntent('我这学期绩点多少', TODAY)?.tool).toBe('get_grades');
    expect(parseIntent('考试安排出来了吗', TODAY)?.tool).toBe('get_exams');
  });

  it('导出日历', () => {
    expect(parseIntent('把课表导出成日历', TODAY)?.tool).toBe('export_ics');
  });

  it('时段要收窄：「今天下午我有课吗」不是「今天有课吗」', () => {
    const got = parseIntent('今天下午我有课吗', TODAY);
    expect(got?.tool).toBe('get_schedule');
    expect(got?.args).toMatchObject({ day: 'today', period: 'afternoon' });
    expect(parseIntent('明天上午有课吗', TODAY)?.args).toMatchObject({ day: 'tomorrow', period: 'morning' });
  });

  it('空教室按时段补节次：「明天下午的空教室」→ 5-8 节', () => {
    const got = parseIntent('明天下午有空教室吗', TODAY);
    expect(got?.tool).toBe('find_free_room');
    expect(got?.args).toMatchObject({ sections: [5, 6, 7, 8] });
  });

  it('只给话题不给「通知」也能搜：「学校最近有比赛吗」', () => {
    const got = parseIntent('学校最近有比赛吗', TODAY);
    expect(got?.tool).toBe('search_notice');
    expect(got?.args).toMatchObject({ query: '比赛', limit: 5 });
  });

  it('覆盖不到的说法返回 null，而不是瞎猜', () => {
    expect(parseIntent('你好', TODAY)).toBeNull();
    expect(parseIntent('今天天气怎么样', TODAY)).toBeNull();
    expect(parseIntent('   ', TODAY)).toBeNull();
  });

  it('帮助文本给出可用示例', () => {
    const text = helpText(TODAY);
    expect(text).toContain('课表');
    expect(text).toContain('空教室');
    expect(text).toContain(TODAY);
  });
});
