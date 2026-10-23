import { z } from 'zod';
import { CampusService, byDuration } from './services';
import { PORTAL_SERVICES, matchServices } from './catalog';
import { coursesToIcs } from './ics';
import { resolvePlace, roomInPlace } from './place';
import { planStudy, renderStudyPlan } from './study';
import { seatMapDataUri } from './library';
import { renderCard, renderCourseTable, renderFreeRooms, renderGrades, renderLibrarySeats, renderNotices, renderPlanProgress, renderSeatMap, renderTodos } from './render';
import { readLibrarySeats } from './libtab';
import { addDays, todayShanghai, weekdayOf } from './util';

export interface ToolResult {
  /** 给用户看的正文 */
  text: string;
  /** 结构化产物（UI 可下载/复制） */
  data?: Record<string, unknown>;
}

export interface ToolDefinition<A> {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  run: (args: A, svc: CampusService) => Promise<ToolResult>;
}

const dayArg = z.union([z.literal('today'), z.literal('tomorrow'), z.number().int().min(1).max(7)]).optional();
const periodArg = z.union([z.literal('morning'), z.literal('afternoon'), z.literal('evening')]).optional();

function resolveDay(day: 'today' | 'tomorrow' | number | undefined, today: string): { weekday: number; date: string } {
  if (day === undefined) return { weekday: 0, date: today };
  if (typeof day === 'number') return { weekday: day, date: today };
  const date = day === 'tomorrow' ? addDays(today, 1) : today;
  return { weekday: weekdayOf(date), date };
}

/** 上午 1-4 节 / 下午 5-8 节 / 晚上 9-10 节，按开始时间判。 */
export function inPeriod(startTime: string, period: 'morning' | 'afternoon' | 'evening'): boolean {
  const hour = Number(startTime.slice(0, 2));
  if (!Number.isFinite(hour)) return true;
  if (period === 'morning') return hour < 12;
  if (period === 'afternoon') return hour >= 12 && hour < 18;
  return hour >= 18;
}

const PERIOD_LABEL: Record<'morning' | 'afternoon' | 'evening', string> = {
  morning: '上午',
  afternoon: '下午',
  evening: '晚上',
};

export const getSchedule: ToolDefinition<{
  week?: number;
  day?: 'today' | 'tomorrow' | number;
  period?: 'morning' | 'afternoon' | 'evening';
}> = {
  name: 'get_schedule',
  description: '查询课表：默认当前教学周，可按周次、按天、按时段（上午/下午/晚上）过滤。',
  schema: z.object({
    week: z.number().int().min(0).max(30).optional(),
    day: dayArg,
    period: periodArg,
  }),
  async run(args, svc) {
    const term = await svc.term();
    const week = args.week === undefined ? term.currentWeek || undefined : args.week || undefined;
    let courses = await svc.courses();
    const today = todayShanghai();
    const { weekday, date } = resolveDay(args.day, today);
    if (weekday) courses = courses.filter((c) => c.weekday === weekday);
    if (args.period) courses = courses.filter((c) => inPeriod(c.startTime, args.period!));
    const text = renderCourseTable(courses, { term, ...(week ? { week } : {}) });
    // 指定了「某天 / 某时段」却一条都没有时，别直接甩「课表为空」，
    // 要说清楚是那个时段没课——否则用户以为查错了。
    const label = args.period ? PERIOD_LABEL[args.period] : '';
    const head = weekday ? `${date}${label ? ` ${label}` : ''}` : label ? `本${label}` : '';
    const empty = courses.length === 0 && (weekday > 0 || Boolean(args.period));
    const body = empty ? `${head ? `${head} · ` : ''}没有课。` : head ? `${head} · ${text}` : text;
    return {
      text: body,
      data: {
        count: courses.length,
        week: week ?? null,
        ...(args.period ? { period: args.period } : {}),
        ...(weekday ? { date } : {}),
        courses,
      },
    };
  },
};

export const findFreeRoom: ToolDefinition<{
  date?: string;
  campus?: string;
  minSeats?: number;
  sections?: number[];
  roomTypeIds?: string[];
  limit?: number;
  /** 地点词：南核 / 北核 / 北1 / 物理馆…（按教室名前缀过滤） */
  building?: string;
}> = {
  name: 'find_free_room',
  description: '查空教室：全部教室减去当天占用，可按校区、楼/教学区、座位数、指定节次筛选。',
  schema: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    campus: z.string().optional(),
    // 地点词：南核（南1/南2/南3）、北核（北1–北5）、北1、物理馆…
    building: z.string().min(1).optional(),
    minSeats: z.number().int().min(0).optional(),
    sections: z.array(z.number().int().min(1).max(20)).optional(),
    // 默认只查普通教室 + 多媒体教室（学号能进的真实上课教室）；
    // 想找实验室可以传 ["5"]（房间类型见 /room/place/roomTypes）。
    roomTypeIds: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async run(args, svc) {
    const date = args.date ?? todayShanghai();
    let campusId: string | undefined;
    if (args.campus) {
      const campuses = await svc.campuses();
      const hit = campuses.find((c) => c.name.includes(args.campus!) || c.id === args.campus);
      if (!hit) throw new Error(`没找到校区「${args.campus}」，可用：${campuses.map((c) => c.name).join('、')}`);
      campusId = hit.id;
    }
    const rooms = await svc.freeRooms({
      date,
      ...(campusId ? { campusId } : {}),
      ...(args.minSeats ? { minSeats: args.minSeats } : {}),
      ...(args.sections?.length ? { sections: args.sections } : {}),
      ...(args.roomTypeIds?.length ? { roomTypeIds: args.roomTypeIds } : {}),
      // 不截断：让渲染层拿到真实总数（它会自己只列前 12 间并说明「共 N 间」）
      limit: args.limit,
    });
    // 地点词（南核/北1/物理馆）按教室名前缀过滤。
    // 不做服务端 buildingIds：那套 id 不透明、跨学期会变，名字前缀才是学生嘴里的那个东西。
    const place = args.building ? resolvePlace(args.building) : null;
    const scoped = place ? rooms.filter((r) => roomInPlace(r.room.name, place)) : rooms;
    const label = args.sections?.length ? `第 ${args.sections.join('/')} 节` : '';
    return {
      text: renderFreeRooms(byDuration(scoped), {
        date,
        sectionLabel: label,
        maxRooms: args.limit ?? 12,
        ...(place ? { place: place.label } : {}),
        ...(place ? { placeTotal: rooms.length } : {}),
      }),
      data: { date, count: scoped.length, rooms: scoped, ...(place ? { place: place.label } : {}) },
    };
  },
};

/**
 * 关键词 → 同义词组。学生说「有比赛吗」时，通知标题里写的是「创新创业大赛」「学科竞赛」，
 * 直接 includes 匹配必然 0 条（这是实测踩过的坑）。
 */
const SYNONYMS: Array<{ test: RegExp; expand: string[] }> = [
  { test: /比赛|竞赛|赛事|大赛/, expand: ['比赛', '竞赛', '大赛', '挑战杯', '创新创业', '选拔', '赛区', '选拔赛'] },
  { test: /奖助|奖学金|助学金|评奖|评优/, expand: ['奖学金', '助学金', '评奖', '评优', '资助', '困难'] },
  { test: /实习|就业|招聘|求职/, expand: ['实习', '就业', '招聘', '双选', '宣讲'] },
  { test: /重修|补考|挂科|清考/, expand: ['重修', '补考', '重考'] },
  { test: /选课|退课|选课/, expand: ['选课', '退课', '选课通知'] },
  { test: /四六级|英语四六级|CET/i, expand: ['四六级', 'CET', '英语'] },
  { test: /党课|党员|团|团员/, expand: ['党课', '党员', '团员', '团课'] },
  { test: /讲座|报告|论坛|学术/, expand: ['讲座', '报告', '论坛', '学术'] },
  { test: /考试|考场|监考/, expand: ['考试', '考场', '监考'] },
  { test: /放假|假期|开学|报到/, expand: ['放假', '假期', '开学', '报到'] },
];

export function expandQuery(query: string | undefined): string[] {
  const q = (query ?? '').trim();
  if (!q) return [];
  const terms = new Set<string>([q]);
  // 中文没有空格分词，整句只取 2-6 字的片段做补充词，避免把「学校最近有比赛吗」整个当关键词
  const cleaned = q.replace(/[有吗呢啊？?。，,、\s]|学校|最近|这个|那个|上的|里的/g, '');
  if (cleaned.length >= 2) terms.add(cleaned);
  for (const rule of SYNONYMS) {
    if (rule.test.test(q)) for (const w of rule.expand) terms.add(w);
  }
  return [...terms];
}

export const searchNotice: ToolDefinition<{ query?: string; keyword?: string; days?: number; limit?: number }> = {
  name: 'search_notice',
  description:
    '查通知公告（教务处全文 + 门户摘要）。按关键词做同义词扩展匹配，可按最近 N 天过滤，结果按发布时间倒序。',
  schema: z.object({
    /** 新的口语参数：用户原话里的关键词 */
    query: z.string().min(1).optional(),
    /** 老参数，规则层还在用 */
    keyword: z.string().min(1).optional(),
    days: z.number().int().min(1).max(365).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async run(args, svc) {
    const raw = args.query ?? args.keyword ?? '';
    const terms = expandQuery(raw);
    const limit = args.limit ?? 10;
    // 关键词命中经常只有个位数，先多抓一些再过滤（服务端 limit 是抓取量，不是结果量）
    const pool = await svc.notices({ limit: terms.length ? 40 : limit });
    let list = pool;
    if (args.days) {
      const cutoff = Date.now() - args.days * 86_400_000;
      list = list.filter((n) => {
        const t = n.publishedAt ? Date.parse(n.publishedAt.replace(/-/g, '/')) : NaN;
        return Number.isFinite(t) ? t >= cutoff : true;
      });
    }
    if (terms.length) {
      const hit = list.filter((n) => {
        const hay = `${n.title} ${n.summary}`;
        return terms.some((t) => hay.includes(t));
      });
      if (hit.length) {
        return {
          text: renderNotices(hit.slice(0, limit), raw),
          data: { count: hit.length, terms, notices: hit.slice(0, limit) },
        };
      }
      // 没命中：给出「最近的通知」并说明没匹配上，别只回一句「没有」
      const recent = list.slice(0, Math.min(5, limit));
      const lines = [`没有匹配「${raw}」的通知（试过：${terms.slice(0, 6).join('、')}）。`, ''];
      if (recent.length) {
        lines.push('最近的通知是这些，看有没有你要的：');
        for (const n of recent) lines.push(`- ${n.publishedAt?.slice(0, 10) ?? ''} ${n.title}`);
      }
      return { text: lines.join('\n'), data: { count: 0, terms, notices: recent } };
    }
    return { text: renderNotices(list.slice(0, limit)), data: { count: list.length, notices: list.slice(0, limit) } };
  },
};

export const getGrades: ToolDefinition<{ course?: string }> = {
  name: 'get_grades',
  description:
    '查成绩与绩点，可按课程名过滤（如“高数”“线性代数”）。返回每门课的分数、学分、绩点，以及服务端给出的构成分（平时/期中/期末/卷面等，字段因课而异）。',
  schema: z.object({ course: z.string().min(1).optional() }),
  async run(args, svc) {
    const grades = await svc.grades();
    return {
      text: renderGrades(grades, { ...(args.course ? { course: args.course } : {}) }),
      data: { count: grades.length, grades, ...(args.course ? { course: args.course } : {}) },
    };
  },
};

export const getExams: ToolDefinition<Record<string, never>> = {
  name: 'get_exams',
  description: '查考试安排。',
  schema: z.object({}),
  async run(_args, svc) {
    const exams = await svc.exams();
    if (exams.length === 0) return { text: '当前学期没有考试安排（或还没发布）。', data: { count: 0 } };
    const rows = ['**考试安排**', ''];
    for (const e of exams) {
      rows.push(`- ${e.courseName ?? '未知课程'} ${e.examTime ?? ''} ${e.place ?? ''} ${e.seatNo ? `座位 ${e.seatNo}` : ''}`);
    }
    return { text: rows.join('\n'), data: { count: exams.length, exams } };
  },
};

export const exportIcs: ToolDefinition<{ fromWeek?: number; toWeek?: number }> = {
  name: 'export_ics',
  description: '把整个学期的课表导出成 iCalendar（.ics），可导入手机日历。',
  schema: z.object({
    fromWeek: z.number().int().min(1).max(30).optional(),
    toWeek: z.number().int().min(1).max(30).optional(),
  }),
  async run(args, svc) {
    const term = await svc.term();
    const courses = await svc.courses();
    const ics = coursesToIcs(courses, {
      term,
      ...(args.fromWeek ? { fromWeek: args.fromWeek } : {}),
      ...(args.toWeek ? { toWeek: args.toWeek } : {}),
    });
    const events = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
    return {
      text: `已生成 ${term.code} 课表日历：${events} 个日程（${courses.length} 门课）。`,
      data: { filename: `zzu-${term.code}.ics`, ics, events },
    };
  },
};

export const getPlanProgress: ToolDefinition<{ code?: string }> = {
  name: 'get_plan_progress',
  description: '查培养方案完成情况：要求学分、已通过、在修、还差多少，以及各模块进度。',
  schema: z.object({
    // 培养类型 code：主修=01（见 /plan/search/completion/cultivateTypes）
    code: z.string().min(1).optional(),
  }),
  async run(args, svc) {
    const plan = await svc.planProgress(args.code ?? '01');
    return {
      text: renderPlanProgress(plan),
      data: {
        requiredCredits: plan.requiredCredits,
        passedCredits: plan.passedCredits,
        takingCredits: plan.takingCredits,
        missingCourses: plan.missingCourses,
        modules: plan.modules,
      },
    };
  },
};

export const openService: ToolDefinition<{ keyword: string }> = {
  name: 'open_service',
  description: '把门户里的服务直接打开：给关键词（座位预约/报修/食堂/奖学金…），返回入口链接。',
  schema: z.object({ keyword: z.string().min(1) }),
  async run(args) {
    const hits = matchServices(args.keyword, 3);
    if (hits.length === 0) {
      const names = PORTAL_SERVICES.map((s) => s.name).join('、');
      return { text: `没找到「${args.keyword}」对应的服务。可用的有：${names}。`, data: { matched: 0 } };
    }
    const best = hits[0]!;
    const rows = [`**${best.service.name}**`, '', best.service.what];
    if (best.service.campusOnly) rows.push('', '_仅校内网 / VPN 可用_');
    // 链接交给面板渲染成按钮（data.url），正文不重复贴一遍裸 URL
    if (hits.length > 1) {
      rows.push('', '其他可能相关的：');
      for (const h of hits.slice(1)) rows.push(`- ${h.service.name}`);
    }
    return {
      text: rows.join('\n'),
      data: {
        matched: hits.length,
        name: best.service.name,
        url: best.service.url,
        what: best.service.what,
      },
    };
  },
};

export const getCard: ToolDefinition<Record<string, never>> = {
  name: 'get_card',
  description: '查校园一卡通：余额、最近消费与充值。',
  schema: z.object({}),
  async run(_args, svc) {
    const card = await svc.card();
    return {
      text: renderCard(card),
      data: {
        balance: card.balance,
        ...(card.appUrl ? { url: card.appUrl, name: '一卡通' } : {}),
      },
    };
  },
};

export const getTodos: ToolDefinition<Record<string, never>> = {
  name: 'get_todos',
  description: '查有没有要办的事：待办/在办/待申请计数与具体事项。',
  schema: z.object({}),
  async run(_args, svc) {
    const todos = await svc.todos();
    const itemUrl = todos.items.find((i) => typeof i.url === 'string' && i.url)?.url;
    return {
      text: renderTodos(todos),
      data: {
        counts: todos.counts,
        items: todos.items.length,
        ...(itemUrl ? { url: itemUrl } : {}),
      },
    };
  },
};

export const librarySeatTool: ToolDefinition<{ date?: string }> = {
  name: 'library_seats',
  description:
    '查图书馆还有多少空座（各馆实时空闲/总数），需要“今天/明天图书馆还有位置吗”“自习去哪坐”时用。只给余量和入口，选座/预约本人做。',
  schema: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
  async run(args, svc) {
    const seats = await svc.librarySeats(args.date);
    return {
      text: renderLibrarySeats(seats),
      data: {
        date: seats.date,
        premises: seats.premises,
        free: seats.premises.reduce((n, p) => n + p.free, 0),
        total: seats.premises.reduce((n, p) => n + p.total, 0),
        url: seats.url,
        name: '图书馆座位预约',
      },
    };
  },
};

export const librarySeatMapTool: ToolDefinition<{ areaId: string; date: string }> = {
  name: 'library_seat_map',
  description:
    '读图书馆某个区域某天的**座位级**数据（哪个座位号空着）。需要用户已经在浏览器里登录 order.lib.zzu.edu.cn。用户问“一楼大厅还有哪些座位”“靠窗还有位置吗”“订 001”时先调这个确认。',
  schema: z.object({
    areaId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  async run(args) {
    const res = await readLibrarySeats(args);
    if (!res.ok || !res.data) {
      return { text: res.error ?? '读不到座位图。', data: { error: true } };
    }
    if (!res.data.seats.length) {
      const raw = JSON.stringify(res.data.raw ?? res.data).slice(0, 900);
      return {
        text: `这次没解析出座位号（接口可能改了字段名）。原始返回片段：\n\`\`\`json\n${raw}\n\`\`\`\n把这段发我，我按真实字段改解析。`,
        data: { error: true, raw: res.data.raw },
      };
    }
    return {
      text: renderSeatMap(res.data),
      data: {
        areaId: args.areaId,
        date: args.date,
        free: res.data.seats.filter((s) => s.free).length,
        total: res.data.seats.length,
        seats: res.data.seats.slice(0, 200),
        ...(seatMapDataUri(res.data) ? { image: seatMapDataUri(res.data), imageAlt: '图书馆座位平面图' } : {}),
        name: '图书馆座位图',
      },
    };
  },
};

/**
 * 下单工具：**只产出「待确认」的动作用户看**，绝不自己下单。
 * 真正的执行由面板上的长按按钮触发（`lib:book` → content script 操作页面）。
 */
export const bookLibrarySeatTool: ToolDefinition<{ areaId: string; date: string; seatNo: string }> = {
  name: 'book_library_seat',
  description:
    '准备一条图书馆座位预约（**不会真的下单**）。用户说“帮我订 001”“订一楼大厅 A12，明天”时调用；返回后界面上会出现需要**长按**的确认按钮，用户长按才会真的提交。',
  schema: z.object({
    areaId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    seatNo: z.string().min(1),
  }),
  async run(args) {
    return {
      text: `要预约 **${args.date}** 的座位 **${args.seatNo}**（区域 ${args.areaId}）。\n下面那个按钮要**长按**才会提交，误触不会下单。`,
      data: {
        action: {
          kind: 'library-book',
          areaId: args.areaId,
          date: args.date,
          seatNo: args.seatNo,
          label: `长按预约 ${args.seatNo}`,
        },
      },
    };
  },
};

const studySpotTool: ToolDefinition<{ date?: string; needMinutes?: number; near?: string; maxWalkMin?: number }> = {
  name: 'find_study_spot',
  description:
    '找「现在就能连续坐一会儿」的地方：同时看空教室和图书馆余量，按能坐多久和步行距离排序。用户说「我想自习两小时」「哪能安静看会儿书」就用它。',
  schema: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    needMinutes: z.number().int().positive().max(720).optional(),
    near: z.string().min(1).optional(),
    maxWalkMin: z.number().int().positive().max(60).optional(),
  }),
  async run(args, svc) {
    const date = args.date ?? todayShanghai();
    const needMinutes = args.needMinutes ?? 120;
    const rooms = await svc.freeRooms({ date });
    let library: Awaited<ReturnType<typeof svc.librarySeats>> | undefined;
    try {
      library = await svc.librarySeats(date);
    } catch {
      library = undefined; // 校外/断网时图书馆不是必须项
    }
    const plan = planStudy({
      needMinutes,
      rooms,
      library,
      ...(args.near ? { near: args.near } : {}),
      ...(args.maxWalkMin ? { maxWalkMin: args.maxWalkMin } : {}),
    });
    return {
      text: renderStudyPlan(plan, { date, ...(args.near ? { near: args.near } : {}) }),
      data: { needMinutes, options: plan.options, libraryNote: plan.libraryNote ?? null },
    };
  },
};

export const TOOLS = {
  get_schedule: getSchedule,
  find_free_room: findFreeRoom,
  find_study_spot: studySpotTool,
  search_notice: searchNotice,
  get_grades: getGrades,
  get_exams: getExams,
  get_plan_progress: getPlanProgress,
  get_card: getCard,
  get_todos: getTodos,
  library_seats: librarySeatTool,
  library_seat_map: librarySeatMapTool,
  book_library_seat: bookLibrarySeatTool,
  open_service: openService,
  export_ics: exportIcs,
} as const;

export type ToolName = keyof typeof TOOLS;

export async function runTool(name: ToolName, args: unknown, svc: CampusService): Promise<ToolResult> {
  const def = TOOLS[name] as ToolDefinition<unknown>;
  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('；');
    throw new Error(`参数不合法（${name}）：${detail}`);
  }
  return def.run(parsed.data, svc);
}
