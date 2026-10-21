import { z } from 'zod';
import { CampusService } from './services';
import { PORTAL_SERVICES, matchServices } from './catalog';
import { coursesToIcs } from './ics';
import { renderCard, renderCourseTable, renderFreeRooms, renderGrades, renderNotices, renderPlanProgress, renderTodos } from './render';
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

function resolveDay(day: 'today' | 'tomorrow' | number | undefined, today: string): { weekday: number; date: string } {
  if (day === undefined) return { weekday: 0, date: today };
  if (typeof day === 'number') return { weekday: day, date: today };
  const date = day === 'tomorrow' ? addDays(today, 1) : today;
  return { weekday: weekdayOf(date), date };
}

export const getSchedule: ToolDefinition<{ week?: number; day?: 'today' | 'tomorrow' | number }> = {
  name: 'get_schedule',
  description: '查询课表：默认当前教学周，可按周次或按天过滤。',
  schema: z.object({
    week: z.number().int().min(0).max(30).optional(),
    day: dayArg,
  }),
  async run(args, svc) {
    const term = await svc.term();
    const week = args.week === undefined ? term.currentWeek || undefined : args.week || undefined;
    let courses = await svc.courses();
    const today = todayShanghai();
    const { weekday, date } = resolveDay(args.day, today);
    if (weekday) courses = courses.filter((c) => c.weekday === weekday);
    const text = renderCourseTable(courses, { term, ...(week ? { week } : {}) });
    return {
      text: weekday ? `${date} · ${text}` : text,
      data: { count: courses.length, week: week ?? null, courses },
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
}> = {
  name: 'find_free_room',
  description: '查空教室：全部教室减去当天占用，可按校区、座位数、指定节次筛选。',
  schema: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    campus: z.string().optional(),
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
    const label = args.sections?.length ? `第 ${args.sections.join('/')} 节` : '';
    return {
      text: renderFreeRooms(rooms, { date, sectionLabel: label, maxRooms: args.limit ?? 12 }),
      data: { date, count: rooms.length, rooms },
    };
  },
};

export const searchNotice: ToolDefinition<{ keyword?: string; limit?: number }> = {
  name: 'search_notice',
  description: '查通知公告：按关键词在标题与摘要里搜（门户只有 200 字摘要，教务处通知有全文）。',
  schema: z.object({
    keyword: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async run(args, svc) {
    const notices = await svc.notices({
      ...(args.keyword ? { keyword: args.keyword } : {}),
      limit: args.limit ?? 10,
    });
    return { text: renderNotices(notices, args.keyword), data: { count: notices.length, notices } };
  },
};

export const getGrades: ToolDefinition<Record<string, never>> = {
  name: 'get_grades',
  description: '查成绩与绩点。',
  schema: z.object({}),
  async run(_args, svc) {
    const grades = await svc.grades();
    return { text: renderGrades(grades), data: { count: grades.length, grades } };
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

export const TOOLS = {
  get_schedule: getSchedule,
  find_free_room: findFreeRoom,
  search_notice: searchNotice,
  get_grades: getGrades,
  get_exams: getExams,
  get_plan_progress: getPlanProgress,
  get_card: getCard,
  get_todos: getTodos,
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
