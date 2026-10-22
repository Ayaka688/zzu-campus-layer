import { describe, expect, it } from 'vitest';
import {
  buildDigest,
  daysBetween,
  dueItems,
  extractDueDates,
  gradeFingerprint,
  newGradeNames,
} from '../src/core/watch';

describe('截止日抽取', () => {
  it('识别多种写法（含中文数字）', () => {
    const d = extractDueDates('请于 11 月 5 日前提交，逾期不再受理。', 2026);
    expect(d).toContain('2026-11-05');
    expect(extractDueDates('报名截止 2026-11-20', 2026)).toContain('2026-11-20');
    expect(extractDueDates('十一月十二日截止', 2026)).toContain('2026-11-12');
  });

  it('没有月日的文本不产生日期', () => {
    expect(extractDueDates('关于举办比赛的通知', 2026)).toEqual([]);
  });
});

describe('到期提醒', () => {
  const today = '2026-10-22';
  it('只留带截止语义、且 7 天内到期的，按剩余天数排', () => {
    const items = dueItems(
      [
        { id: 'a', title: '重修报名通知', summary: '请于 11 月 20 日前完成报名' },
        { id: 'b', title: '奖学金评审工作通知', summary: '材料提交截止 10 月 25 日' },
        { id: 'c', title: '讲座预告', summary: '10 月 23 日 19:00 开始' },
        { id: 'd', title: '旧事', summary: '报名截止 10 月 1 日' },
      ],
      today,
      7,
    );
    expect(items.map((i) => i.id)).toEqual(['b']);
    expect(items[0]?.daysLeft).toBe(3);
  });

  it('今天截止的 daysLeft 是 0', () => {
    const items = dueItems([{ id: 'x', title: '申请截止', summary: '10 月 22 日' }], today, 7);
    expect(items[0]?.daysLeft).toBe(0);
  });

  it('daysBetween 按日算，不受时区影响', () => {
    expect(daysBetween('2026-10-22', '2026-10-25')).toBe(3);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });
});

describe('出分监控', () => {
  const grades = [
    { courseNameZh: '微积分A (Ⅰ)', score: '88' },
    { courseNameZh: '线性代数', score: '91' },
  ];

  it('指纹稳定，与顺序无关', () => {
    expect(gradeFingerprint(grades)).toBe(gradeFingerprint([...grades].reverse()));
  });

  it('能挑出新出分的课程名', () => {
    const prev = gradeFingerprint([grades[0]]);
    expect(newGradeNames(grades, prev)).toEqual(['线性代数']);
  });

  it('首次运行（没有历史指纹）不报一堆新成绩', () => {
    expect(newGradeNames(grades, '')).toEqual([]);
  });
});

describe('通知文案', () => {
  it('没有内容就不推', () => {
    expect(buildDigest({ today: '2026-10-22', dues: [], newGrades: [] })).toBeNull();
  });

  it('出分与截止都能拼进去', () => {
    const d = buildDigest({
      today: '2026-10-22',
      dues: [{ id: 'b', title: '奖学金评审工作通知', due: '2026-10-25', daysLeft: 3 }],
      newGrades: ['线性代数'],
    });
    expect(d?.body).toContain('出分 1 门');
    expect(d?.body).toContain('还有 3 天');
  });
});
