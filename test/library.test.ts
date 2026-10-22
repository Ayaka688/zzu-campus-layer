import { describe, expect, it } from 'vitest';
import { librarySeatUrl } from '../src/core/library';
import { renderGrades, renderLibrarySeats } from '../src/core/render';
import { extractCourseName, parseIntent } from '../src/core/intent';

const TODAY = '2026-10-22';

describe('图书馆座位', () => {
  it('直达链接带上馆 id 和日期', () => {
    const url = librarySeatUrl('1', TODAY);
    expect(url).toBe(`http://order.lib.zzu.edu.cn/h5/index.html#/seat/space?id=1&date=${TODAY}`);
  });

  it('把各馆按空闲数从多到少排，并算百分比与合计', () => {
    const text = renderLibrarySeats({
      date: TODAY,
      dates: [TODAY, '2026-10-23'],
      url: librarySeatUrl('1', TODAY),
      premises: [
        { id: '1', name: '主校区图书馆', total: 2527, free: 930 },
        { id: '70', name: '北校区图书馆', total: 400, free: 40 },
        { id: '60', name: '南校区图书馆', total: 0, free: 0 },
      ],
    });
    expect(text).toContain(`图书馆座位 · ${TODAY}`);
    expect(text.indexOf('主校区图书馆')).toBeLessThan(text.indexOf('北校区图书馆'));
    expect(text).toContain('空闲 **930** / 2527（37%）');
    expect(text).toContain('合计空闲 **970** / 2927');
    // 总数 0 的馆不能算出 NaN%
    expect(text).not.toContain('NaN');
    // 必须说清「不能代约」
    expect(text).toContain('学号 + 统一身份认证密码');
  });

  it('有楼层数据时逐层列出（「一楼还有位置吗」靠这个）', () => {
    const text = renderLibrarySeats({
      date: TODAY,
      dates: [TODAY],
      url: librarySeatUrl('1', TODAY),
      premises: [
        {
          id: '1',
          name: '主校区图书馆',
          total: 2527,
          free: 937,
          floors: [
            { id: '2', name: '一楼', total: 216, free: 14 },
            { id: '4', name: '二楼', total: 386, free: 155 },
          ],
        },
      ],
    });
    expect(text).toContain('楼层：一楼 14/216，二楼 155/386');
    expect(text).toContain('空闲 **937** / 2527');
    // 没有楼层字段时不能凭空造一行「楼层：」
    const plain = renderLibrarySeats({
      date: TODAY,
      dates: [TODAY],
      url: '',
      premises: [{ id: '1', name: '主校区图书馆', total: 100, free: 10 }],
    });
    expect(plain).not.toContain('楼层：');
  });

  it('没有数据时给可读的一句话', () => {
    const text = renderLibrarySeats({ date: TODAY, dates: [], url: '', premises: [] });
    expect(text).toContain('没拿到座位数据');
  });
});

describe('成绩按课程查', () => {
  const grades = [
    { courseName: '微积分A (Ⅰ)', credit: 5, score: 88, gradePoint: 3.7, usualScore: 92, examScore: 85 },
    { courseName: '线性代数', credit: 3, score: 76, gradePoint: 2.7 },
    { courseName: '大学英语（I）', credit: 3, score: 90, gradePoint: 4.0 },
  ];

  it('按课程名过滤，并带出构成分', () => {
    const text = renderGrades(grades, { course: '微积分' });
    expect(text).toContain('微积分A (Ⅰ)');
    expect(text).not.toContain('线性代数');
    expect(text).toContain('构成');
    expect(text).toContain('usualScore 92');
    expect(text).toContain('examScore 85');
  });

  it('课程不存在时列出已出分的课，而不是空回答', () => {
    const text = renderGrades(grades, { course: '量子力学' });
    expect(text).toContain('没找到「量子力学」');
    expect(text).toContain('微积分A (Ⅰ)');
  });

  it('不指定课程时给平均绩点', () => {
    const text = renderGrades(grades);
    expect(text).toContain('平均绩点');
    expect(text).toContain('3.47');
  });
});

describe('课程名抽取', () => {
  it('从「高数多少分」里捞课名', () => {
    expect(extractCourseName('高数多少分')).toBe('高数');
    expect(extractCourseName('线性代数考了多少分')).toBe('线性代数');
  });

  it('问整体成绩时不把「成绩」当课名', () => {
    expect(extractCourseName('我这学期成绩怎么样')).toBeUndefined();
    expect(extractCourseName('绩点多少')).toBeUndefined();
  });

  it('规则层把课名塞进 get_grades', () => {
    const intent = parseIntent('高数多少分', TODAY);
    expect(intent?.tool).toBe('get_grades');
    expect(intent?.args).toEqual({ course: '高数' });
  });
});

describe('图书馆座位意图', () => {
  it('「图书馆还有位置吗」走 library_seats', () => {
    const intent = parseIntent('图书馆还有位置吗', TODAY);
    expect(intent?.tool).toBe('library_seats');
  });

  it('「明天图书馆有座吗」带上日期', () => {
    const intent = parseIntent('明天图书馆还有空位吗', TODAY);
    expect(intent?.tool).toBe('library_seats');
    expect(intent?.args).toEqual({ date: '2026-10-23' });
  });

  it('纯「南核空教室」仍然走空教室，不被图书馆抢走', () => {
    const intent = parseIntent('明天南核空教室', TODAY);
    expect(intent?.tool).toBe('find_free_room');
  });
});
