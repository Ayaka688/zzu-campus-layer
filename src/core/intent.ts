import { extractNeedMinutes } from './study';
/**
 * L0 规则意图解析：不依赖任何大模型，覆盖高频说法。
 * 解析不出来就返回 null，由上层给出示例（而不是瞎猜）。
 */
import type { ToolName } from './tools';
import { matchServices } from './catalog';
import { resolvePlace } from './place';
import { CATEGORY_LABEL, categoryFromText } from './noticeRules';
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
  if (/明早|明儿早|明晚|明儿晚/.test(text)) return 1;
  if (/今早|今儿早|今晚|今儿晚/.test(text)) return 0;
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

/**
 * 「下周 / 上周」这种相对周次：返回相对当前周 +1 / -1，交给工具去算具体周号。
 * 让模型或正则自己数周号是错的根源——日期跨周时（周日晚问「明天」）必然算错。
 */
export function relativeWeekOffset(text: string): number | undefined {
  if (/下下(个)?(周|星期|礼拜)/.test(text)) return 2;
  if (/下(个)?(周|星期|礼拜)/.test(text)) return 1;
  if (/上(个)?(周|星期|礼拜)/.test(text)) return -1;
  if (/(这|本|当前)(个)?(周|星期|礼拜)/.test(text)) return 0;
  return undefined;
}

/**
 * 图书馆区域 id：站点里 `1`=主校区、`10`=东、`60`=南、`70`=北，
 * 楼层是独立的 id（一楼 `2`/`71`/`61`，二楼 `72`/`4`/`24`…）。
 * 这里只做最常见的「主校区 + 一楼/二楼」映射；其它说法交给模型或让用户补一句。
 */
const LIB_AREAS: Array<{ re: RegExp; id: string; name: string }> = [
  // payload 实测：页面发的是 id="3"（一楼大厅），不是 storeys 里的 2
  { re: /(一楼|1楼|一层|大厅)/, id: '3', name: '一楼大厅' },
  { re: /(二楼|2楼|二层)/, id: '4', name: '二楼' },
  { re: /(三楼|3楼|三层)/, id: '5', name: '三楼' },
  { re: /(四楼|4楼|四层)/, id: '6', name: '四楼' },
];

function extractLibraryArea(text: string): { id: string; name: string } | undefined {
  for (const a of LIB_AREAS) if (a.re.test(text)) return { id: a.id, name: a.name };
  return undefined;
}

/** 座位号：`001`、`A12`、`A-12` 这类；避免把「明天」里的数字当座位号 */
function extractSeatNo(text: string): string | undefined {
  const m = /(?:座位?|号)?\s*([A-Za-z]{0,2}-?\d{2,4})(?!\d)/.exec(text);
  if (!m?.[1]) return undefined;
  const no = m[1].replace(/-/g, '');
  if (/^\d{4}$/.test(no) && Number(no) > 1900) return undefined; // 年份
  return no;
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
  // STUDY_FIRST：自习类先判，避免被「空教室」抢走（自习不关心哪节没课，关心里能坐多久）
  {
    const s0 = text.trim();
    const sectionish = /第\s*\d|\d+\s*-\s*\d+\s*节/.test(s0);
    if (
      !sectionish &&
      !/空教室|空着的教室/.test(s0) &&
      /自习|学习|看书|刷题|写作业|泡馆|安静.{0,4}(?:看|学)|找个地方.{0,4}(?:学|看)/.test(s0)
    ) {
    const needMinutes = extractNeedMinutes(s0) ?? 120;
    const near = resolvePlace(s0)?.raw;
    return {
      tool: 'find_study_spot',
      args: { needMinutes, ...(near ? { near } : {}) },
      reason: `自习需求 ${needMinutes} 分钟${near ? `，从${near}出发` : ''}`,
    };
    }
  }

  // LIB_FIRST：图书馆/座位的说法必须先判，否则会被「服务直达」规则抢走（只给入口）
  {
    const t0 = text.trim();
    const libish = /图书馆|阅览室/.test(t0) || (/座位|座/.test(t0) && extractLibraryArea(t0));
    if (libish) {
      const area = extractLibraryArea(t0);
      const d0 = extractDate(t0, today);
      const seatNo = extractSeatNo(t0);
      if (seatNo && /订|预约|约一个|抢|占/.test(t0)) {
        return {
          tool: 'book_library_seat',
          args: { areaId: (area ?? { id: '3' }).id, date: d0 ?? addDays(today, 1), seatNo },
          reason: `关键词：订座（${area?.name ?? '一楼大厅'} ${seatNo}）`,
        };
      }
      if (area && /地图|座位图|平面图|哪些|空着|座位|位置|空位|空座/.test(t0)) {
        return {
          tool: 'library_seat_map',
          args: { areaId: area.id, date: d0 ?? today },
          reason: `关键词：座位图（${area.name}）`,
        };
      }
      if (/座位|位置|空位|空座|几个?座|还剩?几|还有位|有空|满|几楼|自习|坐满|人多/.test(t0)) {
        return { tool: 'library_seats', args: d0 ? { date: d0 } : {}, reason: '关键词：图书馆座位余量' };
      }
    }
  }

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

  // LIB_BY_FLOOR_ONLY：只给楼层 + 「地图/座位图/空着」也走座位图
  if (/地图|座位图|平面图|哪些座位|空着/.test(t) && extractLibraryArea(t) && !/教室/.test(t)) {
    const date = extractDate(t, today);
    const area = extractLibraryArea(t)!;
    return {
      tool: 'library_seat_map',
      args: { areaId: area.id, date: date ?? today },
      reason: `关键词：座位图（${area.name}）`,
    };
  }

  // 「订 001，明天」这种不带"图书馆"的说法：有座位号 + 订/约 就算订座
  // 区域没说的话默认一楼大厅（`3`），这是学生最常用的那个厅。
  {
    const seatNo = extractSeatNo(t);
    if (seatNo && /订|预约|约一个|抢|占/.test(t) && !/教室|自习室/.test(t)) {
      const date = extractDate(t, today);
      const area = extractLibraryArea(t) ?? { id: '3', name: '一楼大厅' };
      return {
        tool: 'book_library_seat',
        args: { areaId: area.id, date: date ?? addDays(today, 1), seatNo },
        reason: `关键词：订座（${area.name} ${seatNo}）`,
      };
    }
  }

  // 图书馆座位：问「还有位置吗」「空几个座」走实时余量；只说「预约座位」仍然走服务直达。
  // 放在空教室规则前面，否则「图书馆自习」会被当成「找空教室」。
  if (/图书馆|阅览室/.test(t) && /座位|位置|空位|空座|几个?座|还剩?几|还有位|有空|满|几楼|自习|坐满|人多|地图|座位图|平面图|哪些|空着/.test(t)) {
    const date = extractDate(t, today);
    const area = extractLibraryArea(t);
    // 只要提到「订/约/抢」就说明想下单；带座位号直接进下单准备，否则先看座位图
    const wantsBook = /订|预约|约一个|抢/.test(t);
    const seatNo = extractSeatNo(t);
    if (wantsBook && area && seatNo) {
      return {
        tool: 'book_library_seat',
        args: { areaId: area.id, date: date ?? addDays(today, 1), seatNo },
        reason: `关键词：图书馆订座（${area.name} ${seatNo}）`,
      };
    }
    if (wantsBook && area) {
      return {
        tool: 'library_seat_map',
        args: { areaId: area.id, date: date ?? addDays(today, 1) },
        reason: `关键词：图书馆座位图（${area.name}）`,
      };
    }
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

  // ---- 通知卡片（分类时间线）----
  // 放在老的关键词搜索之前：这类问法要的是「按分类+时间窗筛出来的卡片」，
  // 而不是「标题里包含某个词」。但也不能抢得太多：「学校最近有比赛吗」仍走老路径
  // （它没说要「今天/本周」，老路径的同义词扩展已经够了）。
  {
    const category = categoryFromText(t);
    const wantsList = /有什么|有哪些|哪些|几场|几个|看看|推荐/.test(t);
    const onDay = /(今天|今日|明天|本周|这周|下周|本周末).{0,8}(?:讲座|比赛|竞赛|活动|会议)/.test(t);
    if (category && !/截止|ddl|什么时候|几号|何时/.test(t) && (wantsList || onDay)) {
      // 时间窗按问法给：今天只看今天，明天放宽到 1 天，本周/最近 7 天
      const withinDays = /今天|今日/.test(t) ? 0 : /明天|明日/.test(t) ? 1 : 7;
      return {
        tool: 'find_notices',
        args: { category, withinDays },
        reason: `关键词：通知分类（${CATEGORY_LABEL[category]}）`,
      };
    }
  }

  // 「奖学金什么时候截止」「挑战杯报名截止了吗」→ 按截止时间排，只看最近两周的窗口
  if (/截止|ddl|到期|还来得及|几号截止|报名到几号/.test(t)) {
    const keyword = extractKeyword(t) ?? NOTICE_TOPICS.find((w) => t.includes(w));
    return {
      tool: 'find_notices',
      args: { withinDays: 14, sort: 'deadline', ...(keyword ? { keyword } : {}) },
      reason: '关键词：截止时间',
    };
  }

  if (/通知|公告|新闻|消息|比赛|竞赛|大赛|挑战杯|评奖|评优|重修|选课|讲座|论坛|招聘|实习/.test(t)) {
    // 用户不一定说「查 XX 的通知」。像「学校最近有比赛吗」，关键词就是那个话题词；
    // 拿到话题词后由 tools 的 noticeRules 扩成同义词组，避免「比赛」搜不到「竞赛」。
    // 老路径 search_notice 已经并进 find_notices，这里只决定「关键词 + 时间窗」。
    const keyword = extractKeyword(t) ?? NOTICE_TOPICS.find((w) => t.includes(w));
    const withinDays = /今天|今日/.test(t)
      ? 0
      : /明天|明日/.test(t)
        ? 1
        : /本周|这周|下周|最近|最新/.test(t)
          ? 7
          : undefined;
    const args: Record<string, unknown> = {};
    if (keyword) args.keyword = keyword;
    if (withinDays !== undefined) args.withinDays = withinDays;
    return { tool: 'find_notices', args, reason: '关键词：通知/公告' };
  }

  if (/课表|有课|上课|课程|几节课|[周星期礼拜][一二三四五六日天1-7].*课|明天.*课|今天.*课|(?:下周|上周|这周|本周).{0,8}课/.test(t)) {
    const week = extractWeek(t);
    const weekOffset = relativeWeekOffset(t);
    const day = extractDay(t, today);
    const period = extractPeriod(t);
    const args: Record<string, unknown> = {};
    // 「第 8 周」是硬定死的周次；「下周」交给工具按当前周 +1 算，别在这里猜。
    if (week !== undefined) args.week = week;
    else if (weekOffset !== undefined) args.weekOffset = weekOffset;
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
