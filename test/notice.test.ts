import { describe, expect, it } from 'vitest';
import { expandQuery, inPeriod } from '../src/core/tools';

describe('inPeriod：按时段过滤课表', () => {
  it('08:00 / 10:10 算上午，14:00 / 16:00 算下午，19:00 算晚上', () => {
    expect(inPeriod('08:00', 'morning')).toBe(true);
    expect(inPeriod('10:10', 'morning')).toBe(true);
    expect(inPeriod('14:00', 'afternoon')).toBe(true);
    expect(inPeriod('16:00', 'afternoon')).toBe(true);
    expect(inPeriod('19:00', 'evening')).toBe(true);
  });

  it('互不串味', () => {
    expect(inPeriod('14:00', 'morning')).toBe(false);
    expect(inPeriod('08:00', 'afternoon')).toBe(false);
    expect(inPeriod('17:40', 'evening')).toBe(false);
  });

  it('时间缺失/异常时保留这条课，别被时段过滤悄悄吞掉', () => {
    // 语义：认不出时间的课宁可留下（否则用户会以为「下午没课」）
    expect(inPeriod('', 'morning')).toBe(true);
    expect(inPeriod('abc', 'afternoon')).toBe(true);
  });
});

describe('expandQuery：口语说法要扩成同义词', () => {
  it('「比赛」扩出竞赛/大赛/挑战杯这些学校用词', () => {
    const words = expandQuery('比赛');
    expect(words).toContain('比赛');
    expect(words).toContain('竞赛');
    expect(words).toContain('大赛');
  });

  it('「奖学金」扩出助学金/评奖', () => {
    const words = expandQuery('奖学金');
    expect(words.some((w) => w.includes('助学金'))).toBe(true);
  });

  it('长句也能抽出片段：「学校最近有比赛吗」', () => {
    const words = expandQuery('学校最近有比赛吗');
    expect(words.some((w) => w.includes('比赛'))).toBe(true);
  });

  it('认不出来的词原样保留，至少能匹配标题', () => {
    expect(expandQuery('量子纠缠')).toContain('量子纠缠');
  });

  it('空串不炸', () => {
    expect(Array.isArray(expandQuery(''))).toBe(true);
  });
});
