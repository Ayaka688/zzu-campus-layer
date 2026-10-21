/**
 * 门户（豫见郑大 / uniapp.s.zzu.edu.cn）数据源。
 * 所有接口实测见 docs/campus-site-probe.md。
 */
import { PORTAL_API, TTC_API, get } from './http';
import { Card, Course, Notice, TodoItem, TodoSummary } from './types';
import { hhmmss, uniq, weekOfDate, weekdayOf, parseDate } from './util';

export const PORTAL_COLUMN = {
  news: 'remote-239852',
  notice: 'remote-245732A245871',
} as const;

interface RawEvent {
  id: string;
  title: string;
  startDateStr?: string | null;
  startTime: string;
  endTime: string;
  address?: string | null;
  remark?: string | null;
  calendarName?: string | null;
}

interface RawSection {
  startTime: string;
  endTime: string;
  section: string;
}

interface RawContent {
  id: string;
  title: string;
  content?: string | null;
  releaseStartTime?: string | null;
  releaseDeptName?: string | null;
  readCount?: number | null;
  url?: string | null;
  columnName?: string | null;
}

export interface PortalOptions {
  token: string;
  signal?: AbortSignal;
}

/** 课表/日程事件：一次调用拿整段区间（实测 84 天 207 条 668ms）。 */
export async function portalEvents(
  opts: PortalOptions,
  from: string,
  to: string,
): Promise<RawEvent[]> {
  const data = await get<{ schedule: Record<string, { calendarList: RawEvent[] }> }>(
    PORTAL_API,
    `/v1/calendar/share/schedule/getEvents?startDate=${from}&endDate=${to}&reqType=DateView`,
    { token: opts.token, source: 'portal', ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  const out: RawEvent[] = [];
  for (const day of Object.values(data.schedule ?? {})) {
    if (!day?.calendarList) continue;
    out.push(...day.calendarList);
  }
  return out;
}

/** 节次 → 时间（权威表，10 节） */
export async function portalSections(opts: PortalOptions): Promise<RawSection[]> {
  const data = await get<{ sectionList: RawSection[] }>(
    PORTAL_API,
    '/v1/calendar/share/schedule/getSection',
    { token: opts.token, source: 'portal' },
  );
  return data.sectionList ?? [];
}

/** 当前教学周。注意 semester 字段实测为空串，只能用 date[0]。 */
export async function portalTeachingWeek(opts: PortalOptions, today: string): Promise<number> {
  const data = await get<{ data?: { date?: string[] } }>(
    PORTAL_API,
    `/v1/calendar/share/schedule/getWeekOfTeaching?today=${today}`,
    { token: opts.token, source: 'portal' },
  );
  const raw = data?.data?.date?.[0];
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function portalNotices(
  opts: PortalOptions,
  columnId: string = PORTAL_COLUMN.notice,
  pageNo = 1,
  pageSize = 20,
): Promise<{ notices: Notice[]; total: number }> {
  const data = await get<{ allContents: RawContent[]; count: number }>(
    PORTAL_API,
    `/v3/cms/content/getColumncontents?columnId=${columnId}&pageNo=${pageNo}&pageSize=${pageSize}&loadContent=true&loadPicContents=false`,
    { token: opts.token, source: 'portal' },
  );
  const notices = (data.allContents ?? []).map((c) =>
    Notice.parse({
      id: c.id,
      title: c.title,
      summary: c.content ?? '',
      publishedAt: c.releaseStartTime ?? undefined,
      department: c.releaseDeptName ?? undefined,
      readCount: typeof c.readCount === 'number' ? c.readCount : undefined,
      url: c.url ?? undefined,
      source: 'portal-cms',
    }),
  );
  return { notices, total: data.count ?? notices.length };
}

/** 拆 remark：「任课教师:张老师;节次:1-2节」 */
export function parseRemark(remark: string | null | undefined): {
  teachers: string[];
  sectionStart?: number;
  sectionEnd?: number;
} {
  const out: { teachers: string[]; sectionStart?: number; sectionEnd?: number } = { teachers: [] };
  if (!remark) return out;
  const t = /任课教师[:：]([^;；]+)/.exec(remark);
  if (t?.[1]) {
    out.teachers = t[1]
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const s = /节次[:：](\d+)\s*[-~]\s*(\d+)/.exec(remark);
  if (s?.[1] && s[2]) {
    out.sectionStart = Number(s[1]);
    out.sectionEnd = Number(s[2]);
  }
  return out;
}

/**
 * 门户事件 → 统一课程。
 * 门户按「日期实例」返回，同一门课一学期会有几十条，需要按
 * (课程名 + 星期 + 起止时间 + 地点 + 教师) 聚合成一条并收集周次。
 */
export function portalEventsToCourses(events: RawEvent[], termStart: string): Course[] {
  const groups = new Map<string, Course>();

  for (const ev of events) {
    const dateStr = ev.startDateStr?.slice(0, 10) ?? '';
    if (!dateStr) continue;
    const parsed = parseRemark(ev.remark);
    const isCourse = ev.calendarName === '课程表' || parsed.sectionStart !== undefined;
    if (!isCourse) continue;

    const weekday = weekdayOf(dateStr);
    const startTime = hhmmss(ev.startTime);
    const endTime = hhmmss(ev.endTime);
    const week = weekOfDate(termStart, dateStr);
    if (!week) continue;

    const key = [ev.title, weekday, startTime, endTime, ev.address ?? '', parsed.teachers.join('/')].join('|');
    const existing = groups.get(key);
    if (existing) {
      existing.weeks = uniq([...existing.weeks, week]);
      continue;
    }
    groups.set(
      key,
      Course.parse({
        key,
        name: ev.title,
        teachers: parsed.teachers,
        ...(ev.address ? { location: ev.address } : {}),
        weekday,
        startTime,
        endTime,
        ...(parsed.sectionStart !== undefined ? { sectionStart: parsed.sectionStart } : {}),
        ...(parsed.sectionEnd !== undefined ? { sectionEnd: parsed.sectionEnd } : {}),
        weeks: [week],
        date: dateStr,
        source: 'portal',
      }),
    );
  }

  return [...groups.values()].sort(
    (a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime),
  );
}

/** 判断字符串是不是合法的日期区间 */
export function isValidRange(from: string, to: string): boolean {
  const a = parseDate(from);
  const b = parseDate(to);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a;
}

interface RawCard {
  balance?: string | number | null;
  eCardType?: string | null;
  cardStatus?: string | null;
  lastExpenditure?: unknown[] | null;
  lastIncome?: unknown[] | null;
  appUrl?: string | null;
}

/** 把 "0" / 12.5 / "" 统一成数字（解析不出当 0）。 */
function toYuan(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 一卡通余额与最近流水。
 * 实测：balance 是字符串（本号 "0"），lastExpenditure/lastIncome 是空数组。
 */
export async function portalCard(opts: PortalOptions): Promise<Card> {
  const data = await get<RawCard>(PORTAL_API, '/v2/personalData/getMyECard', {
    token: opts.token,
    source: 'portal',
  });
  return parseCard(data);
}

/** 拆一卡通响应（纯函数，便于用真实 fixture 测）。 */
export function parseCard(data: RawCard | null | undefined): Card {
  const expenses = Array.isArray(data?.lastExpenditure) ? data.lastExpenditure.filter(isObject) : [];
  const incomes = Array.isArray(data?.lastIncome) ? data.lastIncome.filter(isObject) : [];
  return Card.parse({
    balance: toYuan(data?.balance),
    ...(data?.eCardType ? { cardType: data.eCardType } : {}),
    ...(data?.cardStatus ? { cardStatus: data.cardStatus } : {}),
    expenses,
    incomes,
    ...(data?.appUrl ? { appUrl: data.appUrl } : {}),
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object';
}

interface RawTodoCounts {
  apply_count?: number;
  circulated_count?: number;
  todo_count?: number;
  todo_timeout?: number;
  todo_urgent?: number;
}

/**
 * 待办：计数与列表来自两个接口（都在事务中心）。
 * 实测计数全 0、列表为空（本号确实没事要办）。
 */
export async function portalTodos(opts: PortalOptions, pageSize = 10): Promise<TodoSummary> {
  const counts = await get<RawTodoCounts>(TTC_API, '/v1/count/ttcCount?readed=0', {
    token: opts.token,
    source: 'portal',
  });
  let items: unknown[] = [];
  try {
    const list = await get<{ items?: unknown[] }>(
      TTC_API,
      `/api/ttc/center-list/getToDoList?pageIndex=1&pageSize=${pageSize}`,
      { token: opts.token, source: 'portal' },
    );
    items = list?.items ?? [];
  } catch {
    /* 列表失败不影响计数 */
  }
  return parseTodos(counts, items);
}

/** 组装待办摘要（纯函数，便于用真实 fixture 测）。 */
export function parseTodos(counts: RawTodoCounts | null | undefined, items: unknown[]): TodoSummary {
  return TodoSummary.parse({
    counts: {
      apply: counts?.apply_count ?? 0,
      circulated: counts?.circulated_count ?? 0,
      todo: counts?.todo_count ?? 0,
      timeout: counts?.todo_timeout ?? 0,
      urgent: counts?.todo_urgent ?? 0,
    },
    items: items.filter(isObject).map((raw) => TodoItem.parse(raw)),
  });
}
