/**
 * L0 规则意图解析：不依赖任何大模型，覆盖高频说法。
 * 解析不出来就返回 null，由上层给出示例（而不是瞎猜）。
 */
import type { ToolName } from './tools';
import { matchServices } from './catalog';
import { resolvePlace } from './place';
import { addDays, todayShanghai, weekdayOf } from './util';

export interface Intent {
  tool: ToolName;
  args: Record<string, unknown>;
  /** 命中的规则，便于调试 */
  reason: string;
}

type DayArg = 'today' | 'tomorrow' | number;

export type Period = 'morning' | 'afternoon' | 'evening';

/** 时段 → 默认节次（用户只说「下午」时用）。 */
const PERIOD_SECTIONS: Record<Period, number[]> = {
  morning: [1, 2, 3, 4],
  afternoon: [5, 6, 7, 8],
  evening: [9, 10],
};

/** 通知类问题里常见的话题词：用户常直接说话题，不说「通知」二字。 */
const NOTICE_TOPICS = ['比赛', '竞赛', '大赛', '挑战杯', '奖学金', '助学金', '评奖', '评优', '实习', '招聘', '重修',
  '选课',
  '四六级',
  '党课',
  '讲座',
  '论坛',
  '放假',
  '保研',
];

/**
 * 从「高数多少分」「线性代数考了几分」里捞课程名。
 * 只做保守抽取：命不中就返回 undefined，交给工具列全部课程。
 */
export function extractCourseName(text: string): string | undefined {
  const STOP = /^(这|那|我|我的|这门|哪门|哪一?门|所有|全部|总分|平均分?|成绩|绩点|分数|期末|期中|考试|挂科)/;
  const m = /([\u4e00-\u9fa5A-Za-z]{2,12}?)(?:这门课?|课)?(?:考了|得了|拿了)?(?:多少分|几分|多少|得几分|的分数|成绩|分数)/.exec(text);
  const cand = m?.[1]?.trim();
  if (!cand) return undefined;
  if (STOP.test(cand)) return undefined;
  if (/成绩|绩点|分数|多少|几分/.test(cand)) return undefined;
  return cand;
}

/** 「上午/下午/晚上」→ 时段。规则层用它把「今天下午有课吗」收窄。 */
export function extractPeriod(text: string): Period | undefined {
  if (/上午|早上|早晨|一早/.test(text)) return 'morning';
  if (/下午|半晌/.test(text)) return 'afternoon';
  if (/晚上|夜里|傍晚/.test(text)) return 'evening';
  return undefined;
}

/** 「今天/明天/后天/大后天」→ 偏移天数。规则层和 L1 兜底共用。 */
export function relativeDayOffset(text: string): number | undefined {
  if (/大后天/.test(text)) return 3;
  if (/后天/.test(text)) return 2;
  if (/明天|明日/.test(text)) return 1;
  if (/今天|今日|now/.test(text)) return 0;
  return undefined;
}

function extractDay(text: string, today?: string): DayArg | undefined {
  const off = relativeDayOffset(text);
  if (off !== undefined) {
    if (off === 0) return 'today';
    if (off === 1) return 'tomorrow';
    // 后天/大后天没有现成字面量，直接算成星期几
    return today ? weekdayOf(addDays(today, off)) : undefined;
  }
  const cn: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
  const m = /(?:周|星期|礼拜)([一二三四五六日天])/.exec(text);
  if (m?.[1]) return cn[m[1]];
  const n = /(?:周|星期|礼拜)([1-7])/.exec(text);
  if (n?.[1]) return Number(n[1]);
  return undefined;
}

function extractWeek(text: string): number | undefined {
  const m = /第\s*(\d{1,2})\s*周/.exec(text);
  if (m?.[1]) return Number(m[1]);
  return undefined;
}

function extractDate(text: string, today: string): string | undefined {
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso?.[1] && iso[2] && iso[3]) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  }
  const md = /(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)/.exec(text);
  if (md?.[1] && md[2]) {
    const year = today.slice(0, 4);
    return `${year}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
  }
  const off = relativeDayOffset(text);
  if (off !== undefined) return addDays(today, off);
  return undefined;
}

function extractSections(text: string): number[] | undefined {
  if (/上午/.test(text)) return [1, 2, 3, 4];
  if (/下午/.test(text)) return [5, 6, 7, 8];
  if (/晚上/.test(text)) return [9, 10];
  const range = /第?\s*(\d{1,2})\s*[-~到至]\s*(\d{1,2})\s*节/.exec(text);
  if (range?.[1] && range[2]) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
  }
  const single = /第?\s*(\d{1,2})\s*节/.exec(text);
  if (single?.[1]) return [Number(single[1])];
  return undefined;
}

function extractSeats(text: string): number | undefined {
  const m = /(\d{2,4})\s*(?:人|座|个座)/.exec(text);
  if (m?.[1]) return Number(m[1]);
  return undefined;
}

function extractKeyword(text: string): string | undefined {
  const quoted = /[「“"']([^」”"']{2,30})[」”"']/.exec(text);
  if (quoted?.[1]) return quoted[1];
  const about = /关于\s*([^\s，。？?]{2,20})/.exec(text);
  if (about?.[1]) return about[1];
  const search = /(?:搜|查|找)\s*([^\s，。？?得]{2,20})/.exec(text);
  if (search?.[1]) return search[1];
  return undefined;
}

/** 解析用户输入。返回 null 表示「不在规则覆盖范围内」。 */
export function parseIntent(text: string, today = todayShanghai()): Intent | null {
  const t = text.trim();
  if (!t) return null;

  if (/导出|日历文件|ics|ical|订阅日历/i.test(t)) {
    const week = extractWeek(t);
    return {
      tool: 'export_ics',
      args: week ? { fromWeek: week } : {},
      reason: '关键词：导出/ics',
    };
  }

  // 图书馆座位：问「还有位置吗」「空几个座」走实时余量；只说「预约座位」仍然走服务直达。
  // 放在空教室规则前面，否则「图书馆自习」会被当成「找空教室」。
  if (/图书馆|阅览室/.test(t) && /座位|位置|空位|空座|还有位|有空|满|几楼|自习/.test(t)) {
    const date = extractDate(t, today);
    return {
      tool: 'library_seats',
      args: date ? { date } : {},
      reason: '关键词：图书馆座位余量',
    };
  }

  if (/空教室|自习室|空闲教室|没课的教室|自习|哪里有?座/.test(t)) {
    const date = extractDate(t, today);
    const period = extractPeriod(t);
    const sections = extractSections(t) ?? (period ? PERIOD_SECTIONS[period] : undefined);
    const minSeats = extractSeats(t);
    const campus = /(主校区|南校区|北校区|东校区|西校区|新校区)/.exec(t)?.[1];
    // 地点词（南核 / 北核 / 北1 / 物理馆）单独传给工具按教室名前缀过滤，
    // 否则「明天南核空教室」会被当成「不限楼」，列一堆北1/北2 的教室。
    const place = resolvePlace(t);
    const args: Record<string, unknown> = {};
    if (date) args.date = date;
    if (sections) args.sections = sections;
    if (minSeats) args.minSeats = minSeats;
    if (campus) args.campus = campus;
    if (place) args.building = place.raw;
    return {
      tool: 'find_free_room',
      args,
      reason: place ? `关键词：空教室 + 地点「${place.raw}」` : '关键词：空教室',
    };
  }

  if (/成绩|绩点|分数|多少分|几分|挂科|gpa/i.test(t)) {
    // 「高数多少分」「线性代数考了多少」→ 把课名捞出来传给工具按课程过滤。
    const course = extractCourseName(t);
    return {
      tool: 'get_grades',
      args: course ? { course } : {},
      reason: course ? `关键词：成绩 + 课程「${course}」` : '关键词：成绩',
    };
  }

  if (/培养方案|学分|毕业.{0,4}学分|还差.{0,4}学分|修满/.test(t)) {
    return { tool: 'get_plan_progress', args: {}, reason: '关键词：培养方案/学分' };
  }

  if (/考试安排|考试|考场/.test(t)) {
    return { tool: 'get_exams', args: {}, reason: '关键词：考试' };
  }

  // 服务直达：优先于「成绩/课表」这些数据类规则，因为用户说的是"打开某某"
  if (/打开|进入|直达|怎么进|入口|在哪(?:里|儿)?(?:办|弄|申请)?|去哪(?:里|儿)/.test(t)) {
    const keyword = extractServiceKeyword(t);
    if (keyword) return { tool: 'open_service', args: { keyword }, reason: '关键词：服务直达' };
  }

  if (/一卡通|饭卡|校园卡|卡里|余额|充值|消费记录|花了多少/.test(t)) {
    return { tool: 'get_card', args: {}, reason: '关键词：一卡通/余额' };
  }

  if (/待办|要办|待处理|待审批|审批进度|没办完|有没有.{0,4}事要办/.test(t)) {
    return { tool: 'get_todos', args: {}, reason: '关键词：待办' };
  }

  if (/通知|公告|新闻|消息|比赛|竞赛|大赛|挑战杯|评奖|评优|重修|选课|讲座|论坛|招聘|实习/.test(t)) {
    // 用户不一定说「查 XX 的通知」。像「学校最近有比赛吗」，关键词就是那个话题词；
    // 拿到话题词后由 tools.expandQuery 再扩成同义词组，避免「比赛」搜不到「竞赛」。
    const keyword = extractKeyword(t) ?? NOTICE_TOPICS.find((w) => t.includes(w));
    const limit = /最新|最近/.test(t) ? 5 : undefined;
    const args: Record<string, unknown> = {};
    if (keyword) args.query = keyword;
    if (limit) args.limit = limit;
    return { tool: 'search_notice', args, reason: '关键词：通知/公告' };
  }

  if (/课表|有课|上课|课程|几节课|[周星期礼拜][一二三四五六日天1-7].*课|明天.*课|今天.*课/.test(t)) {
    const week = extractWeek(t);
    const day = extractDay(t, today);
    const period = extractPeriod(t);
    const args: Record<string, unknown> = {};
    if (week !== undefined) args.week = week;
    if (day !== undefined) args.day = day;
    if (period) args.period = period;
    return { tool: 'get_schedule', args, reason: '关键词：课表' };
  }

  const svcHit = matchServices(t, 1)[0];
  if (svcHit && svcHit.score >= 60) {
    return { tool: 'open_service', args: { keyword: svcHit.service.name }, reason: '兜底：命中服务目录' };
  }

  return null;
}

/** 从整句里认出用户想打开哪个服务（命中目录里的名字或别名）。 */
function extractServiceKeyword(text: string): string | undefined {
  const hit = matchServices(text, 1)[0];
  return hit?.service.name;
}

/** 解析不出来时的帮助文本（同时充当「无 LLM 兜底」）。 */
export function helpText(today = todayShanghai()): string {
  const dow = weekdayOf(today);
  return [
    '我可以直接回答这几类问题（全部走你已登录的校园账号，不需要模型）：',
    '',
    '- 课表：`这周课表` / `明天有课吗` / `第 8 周课表`',
    '- 空教室：`明天下午的空教室` / `主校区 100 人以上的空教室` / `明天南核空教室` / `周三第 3-4 节哪里自习`',
    '- 通知：`最近的通知` / `查一下 AI 智能体大赛的通知`',
    '- 成绩 / 考试：`我这学期绩点` / `考试安排`',
    '- 学分：`我还差多少学分毕业` / `培养方案完成情况`',
    '- 一卡通：`我卡里还有多少钱` / `最近消费`',
    '- 待办：`有什么要办的事` / `待办事项`',
    '- 服务直达：`打开座位预约` / `报修在哪` / `食堂怎么订餐`',
    '- 导出：`把课表导出成日历`',
    '',
    `今天 ${today}（周${'一二三四五六日'[dow - 1] ?? '?'}）。`,
  ].join('\n');
}
