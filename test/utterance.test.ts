import { describe, expect, it } from 'vitest';
import { ask, guessIntentByPhrase } from '../src/core/agent';
import { parseIntent } from '../src/core/intent';
import { charSet, nGrams, normalizeQuery } from '../src/core/normalize';
import { UTTERANCES } from '../src/core/phrases';
import type { CampusSession } from '../src/core/services';
import { TOOLS, type ToolName } from '../src/core/tools';
import {
  EXECUTE_SCORE,
  SUGGEST_SCORE,
  matchUtterance,
  resolveUtterance,
  suggestUtterances,
} from '../src/core/utterance';

describe('normalizeQuery', () => {
  it('去标点、语气词、客套话', () => {
    expect(normalizeQuery('请问明天有课吗？')).toBe('明天有课');
    expect(normalizeQuery('帮我查一下最近的通知')).toBe('最近的通知');
  });

  it('全角转半角、统一大小写', () => {
    expect(normalizeQuery('ＡＩ４Ｓ　平台')).toBe('ai4s平台');
  });

  it('常见错字和别称归到同一个词', () => {
    expect(normalizeQuery('图书管还有位置吗')).toContain('图书馆');
    expect(normalizeQuery('饭卡余额')).toBe('卡余额');
    expect(normalizeQuery('基点多少')).toBe('绩点多少');
  });
});

describe('语料健康度', () => {
  it('语料不少于 300 条，十四个工具各有至少 10 条', () => {
    expect(UTTERANCES.length).toBeGreaterThanOrEqual(300);
    const count = new Map<ToolName, number>();
    for (const u of UTTERANCES) count.set(u.tool, (count.get(u.tool) ?? 0) + 1);
    for (const name of Object.keys(TOOLS) as ToolName[]) {
      expect(count.get(name) ?? 0, `${name} 的语料太少`).toBeGreaterThanOrEqual(10);
    }
  });

  it('同一句归一化后不会指向两个工具', () => {
    const seen = new Map<string, ToolName>();
    for (const u of UTTERANCES) {
      const key = normalizeQuery(u.text);
      const prev = seen.get(key);
      if (prev) expect(prev, `「${u.text}」同时指向 ${prev} 和 ${u.tool}`).toBe(u.tool);
      seen.set(key, u.tool);
    }
  });

  it('charSet / nGrams 都是去重集合', () => {
    expect(charSet('aab').size).toBe(2);
    expect(nGrams('abcd', 2)).toEqual(new Set(['ab', 'bc', 'cd']));
  });
});

describe('matchUtterance', () => {
  const CASES: Array<[string, ToolName]> = [
    ['明天有课吗', 'get_schedule'],
    ['明早几点的课', 'get_schedule'],
    ['明天上午有空的教室吗', 'find_free_room'],
    ['我想自习两小时', 'find_study_spot'],
    ['最近有什么讲座', 'find_notices'],
    ['我挂了没', 'get_grades'],
    ['考场在哪', 'get_exams'],
    ['我还差多少学分毕业', 'get_plan_progress'],
    ['卡里还有多少钱', 'get_card'],
    ['有哪些待办', 'get_todos'],
    ['一楼大厅还有座吗', 'library_seats'],
    ['帮我订个座位', 'book_library_seat'],
    ['打开座位预约', 'open_service'],
    ['把课表导出成日历', 'export_ics'],
  ];

  for (const [text, tool] of CASES) {
    it(`「${text}」→ ${tool}`, () => {
      const hit = matchUtterance(text);
      expect(hit, `没接住「${text}」`).not.toBeNull();
      expect(hit!.tool).toBe(tool);
      expect(hit!.score).toBeGreaterThanOrEqual(EXECUTE_SCORE);
    });
  }

  it('服务直达会把服务名带上（否则 open_service 跑不了）', () => {
    const hit = matchUtterance('打开座位预约');
    expect(hit?.args).toEqual({ keyword: '座位预约' });
  });

  it('太短的话不瞎猜', () => {
    expect(matchUtterance('在')).toBeNull();
    expect(matchUtterance('')).toBeNull();
  });

  it('不相关的话不执行（最多只当候选）', () => {
    for (const text of ['这周好累', '帮我写个请假条', '你叫什么名字', '今天天气怎么样']) {
      const hit = matchUtterance(text);
      if (hit) expect(hit.score, `「${text}」不该执行`).toBeLessThan(EXECUTE_SCORE);
    }
  });

  it('候选只给分数够的、每个工具一条', () => {
    const hints = suggestUtterances('图书馆');
    for (const h of hints) expect(h.score).toBeGreaterThanOrEqual(SUGGEST_SCORE);
    expect(new Set(hints.map((h) => h.tool)).size).toBe(hints.length);
    expect(suggestUtterances('', 3)).toEqual([]);
  });
});

describe('resolveUtterance（带参数校验）', () => {
  it('参数齐全的放行', () => {
    expect(resolveUtterance('打开座位预约')?.tool).toBe('open_service');
    expect(resolveUtterance('明天有课吗')?.tool).toBe('get_schedule');
  });

  it('缺必填参数的不放行（订座要座位号，座位图要区域+日期）', () => {
    expect(resolveUtterance('帮我订个座位')).toBeNull();
    expect(resolveUtterance('图书馆座位图')).toBeNull();
  });
});

describe('接入 ask()：说法库 → 意图（没配模型时）', () => {
  const TODAY = '2026-10-25';

  it('「明早几点的课」带上「明天」的信息', () => {
    const intent = guessIntentByPhrase('明早几点的课', TODAY);
    expect(intent?.tool).toBe('get_schedule');
    expect(intent?.args.day).toBe('tomorrow');
  });

  it('「我挂了没」直接查成绩', () => {
    const intent = guessIntentByPhrase('我挂了没', TODAY);
    expect(intent?.tool).toBe('get_grades');
  });

  it('参数不全、或者不相关，就不猜', () => {
    expect(guessIntentByPhrase('帮我订个座位', TODAY)).toBeNull();
    expect(guessIntentByPhrase('这周好累', TODAY)).toBeNull();
  });

  it('reason 里写清是哪句语料命中的（方便排查）', () => {
    expect(guessIntentByPhrase('一楼大厅还有座吗', TODAY)?.reason).toContain('说法库');
  });
});

describe('ask() 的兜底顺序（没配 key 的那条路）', () => {
  const session = {} as unknown as CampusSession;

  it('正则接不住的，说法库接住', async () => {
    const r = await ask('我挂了没', session, {});
    expect(r.tool).toBe('get_grades');
    expect(r.via).toBe('rule');
  });

  it('正则能接住的照旧走正则', async () => {
    const r = await ask('明天有课吗', session, {});
    expect(r.tool).toBe('get_schedule');
  });

  it('不相关的话不乱跑工具', async () => {
    const r = await ask('这周好累', session, {});
    expect(r.tool).toBeUndefined();
    expect(r.via).toBe('none');
  });
});

describe('正则 + 语料 的合并命中率', () => {
  const CASES: Array<[string, ToolName]> = [
    ['明天有课吗', 'get_schedule'], ['明早几点的课', 'get_schedule'], ['下周课表', 'get_schedule'],
    ['这周还有几节课', 'get_schedule'], ['周三下午有课吗', 'get_schedule'], ['下周三有课吗', 'get_schedule'],
    ['今天有课没', 'get_schedule'], ['下午有课吗', 'get_schedule'],
    ['今天哪间教室空着', 'find_free_room'], ['明天下午的空教室', 'find_free_room'],
    ['晚上有空的教室吗', 'find_free_room'], ['能坐50人的空教室', 'find_free_room'],
    ['找个空教室写作业', 'find_free_room'], ['明天的空教室', 'find_free_room'],
    ['主校区100人以上的空教室', 'find_free_room'], ['明天上午有空的教室吗', 'find_free_room'],
    ['明天哪间教室没人', 'find_free_room'],
    ['我想自习两小时', 'find_study_spot'], ['今晚想学习', 'find_study_spot'],
    ['去哪看书好', 'find_study_spot'], ['现在能去哪自习', 'find_study_spot'], ['在哪能自习', 'find_study_spot'],
    ['最近的通知', 'find_notices'], ['有什么讲座', 'find_notices'], ['挑战杯的通知', 'find_notices'],
    ['有没有比赛通知', 'find_notices'], ['最新的公告', 'find_notices'], ['最近有什么比赛', 'find_notices'],
    ['我这学期绩点', 'get_grades'], ['我挂了没', 'get_grades'], ['成绩单', 'get_grades'],
    ['我的平均分', 'get_grades'],
    ['考试安排', 'get_exams'], ['考场在哪', 'get_exams'], ['期末考试安排', 'get_exams'],
    ['什么时候考试', 'get_exams'],
    ['我还差多少学分毕业', 'get_plan_progress'], ['培养方案完成情况', 'get_plan_progress'],
    ['学分够了吗', 'get_plan_progress'], ['我还差多少学分', 'get_plan_progress'],
    ['我卡里还有多少钱', 'get_card'], ['饭卡余额', 'get_card'], ['最近消费记录', 'get_card'],
    ['一卡通余额', 'get_card'], ['卡里还有多少钱', 'get_card'],
    ['有什么待办', 'get_todos'], ['审批进度', 'get_todos'], ['待办事项', 'get_todos'],
    ['图书馆还有位置吗', 'library_seats'], ['一楼大厅还有座吗', 'library_seats'],
    ['南馆还有座吗', 'library_seats'], ['图书馆满了吗', 'library_seats'],
    ['图书馆还有几个座', 'library_seats'],
    ['帮我订个座位', 'book_library_seat'], ['我想订座位', 'open_service'],
    ['打开座位预约', 'open_service'], ['报修在哪', 'open_service'], ['校历', 'open_service'],
    ['云盘入口', 'open_service'], ['食堂怎么订餐', 'open_service'], ['校园地图', 'open_service'],
    ['把课表导出成日历', 'export_ics'], ['导出课表', 'export_ics'], ['课表导成ics', 'export_ics'],
  ];

  it('常用的 64 句口语全都对（正则优先，语料只补漏）', () => {
    const wrong: string[] = [];
    for (const [text, want] of CASES) {
      const tool = parseIntent(text)?.tool ?? matchUtterance(text)?.tool;
      if (tool !== want) wrong.push(`${text} → ${tool ?? '(无)'}，期望 ${want}`);
    }
    expect(wrong, wrong.join('\n')).toHaveLength(0);
  });
});
