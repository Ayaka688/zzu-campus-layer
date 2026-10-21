/**
 * 面向工具层的数据门面：把两个 token、两套数据源、必要的缓存合在一起。
 * 扩展 SW 与 Node 测试共用这一层（不直接依赖 chrome API）。
 */
import { Card as CardInfo, Course, Exam, FreeRoom, Grade, Notice, Term, TodoSummary } from './types';
import {
  CLASSROOM_TYPE_IDS,
  jwxtAllRooms,
  jwxtCampuses,
  jwxtCourseTable,
  jwxtCourseUnits,
  jwxtCurrentTerm,
  jwxtExams,
  jwxtGrades,
  jwxtNotices,
  jwxtOccupancy,
  jwxtPlanCompletion,
  jwxtSemesters,
  type PlanProgress,
} from './jwxt';
import {
  portalCard,
  portalEvents,
  portalEventsToCourses,
  portalNotices,
  portalTeachingWeek,
  portalTodos,
} from './portal';
import { addDays, todayShanghai } from './util';

export interface CampusSession {
  /** 教务 idToken（CAS 签发，实测 30 天） */
  jwxtToken?: string | undefined;
  /** 门户 userToken（实测 8 小时） */
  portalToken?: string | undefined;
  /** 覆盖「今天」，便于测试 */
  today?: string | undefined;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

const CACHE_TTL = 5 * 60_000;

export class CampusService {
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly session: CampusSession) {}

  get hasJwxt(): boolean {
    return Boolean(this.session.jwxtToken);
  }

  get hasPortal(): boolean {
    return Boolean(this.session.portalToken);
  }

  private async memo<T>(key: string, fn: () => Promise<T>, ttl = CACHE_TTL): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;
    const value = await fn();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  private jwxt(token = this.session.jwxtToken): string {
    if (!token) throw new Error('缺少教务 token：请先打开一次「教学管理平台」（jwxt.zzu.edu.cn），扩展会自动采集。');
    return token;
  }

  /**
   * 门户接口用的 token。
   * 实测：**教务 idToken 在 portal-api 上同样有效**（同一 CAS 签发，受众相同），
   * 而且教务票有 30 天、门户票只有 8 小时，所以优先用教务票。
   */
  private portal(token = this.session.jwxtToken ?? this.session.portalToken): string {
    if (!token) throw new Error('缺少登录态：请先打开一次「豫见郑大」或「教学管理平台」，扩展会自动采集。');
    return token;
  }

  async term(): Promise<Term> {
    return this.memo('term', () => jwxtCurrentTerm({ token: this.jwxt() }));
  }

  async semesters(): Promise<Term[]> {
    return this.memo('semesters', () => jwxtSemesters({ token: this.jwxt() }), 30 * 60_000);
  }

  async campuses(): Promise<Array<{ id: string; name: string }>> {
    return this.memo('campuses', () => jwxtCampuses({ token: this.jwxt() }), 30 * 60_000);
  }

  /** 课表：教务优先（字段更全），仅有门户 token 时退化为门户事件聚合。 */
  async courses(termId?: string): Promise<Course[]> {
    if (this.hasJwxt) {
      const term = termId ?? (await this.term()).id;
      return this.memo(`courses:${term}`, () => jwxtCourseTable({ token: this.jwxt() }, term));
    }
    if (this.hasPortal) {
      const term = await this.portalTerm();
      const events = await portalEvents({ token: this.portal() }, term.startDate, addDays(term.startDate, 140));
      return portalEventsToCourses(events, term.startDate);
    }
    throw new Error('没有可用的 token。');
  }

  /**
   * 门户没有学期表，用「当前教学周 + 今天」反推首周周一：
   * 首周周一 = 今天 - (教学周-1)*7 - (星期-1)
   */
  private async portalTerm(): Promise<Term> {
    return this.memo('portalTerm', async () => {
      const today = this.session.today ?? todayShanghai();
      const week = await portalTeachingWeek({ token: this.portal() }, today);
      const dow = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
      const start = addDays(today, -((week - 1) * 7 + (dow - 1)));
      return Term.parse({
        id: `${start}-${today}`,
        code: `第${week}周`,
        startDate: start,
        endDate: addDays(start, 140),
        weeks: [],
        ...(week > 0 ? { currentWeek: week } : {}),
      });
    }, 30 * 60_000);
  }

  async currentWeek(): Promise<number> {
    const term = await this.term();
    return term.currentWeek ?? 0;
  }

  async notices(opts: { keyword?: string; limit?: number; columnId?: string } = {}): Promise<Notice[]> {
    const limit = opts.limit ?? 10;
    const collected: Notice[] = [];

    if (this.hasJwxt) {
      try {
        collected.push(...(await this.memo('notice:jwxt', () => jwxtNotices({ token: this.jwxt() }))));
      } catch {
        /* 教务通知失败不阻塞门户通知 */
      }
    }
    if (this.hasPortal) {
      try {
        const page = await this.memo(`notice:portal:${opts.columnId ?? 'default'}`, () =>
          portalNotices({ token: this.portal() }, opts.columnId, 1, 30),
        );
        collected.push(...page.notices);
      } catch {
        /* ignore */
      }
    }

    const keyword = opts.keyword?.trim();
    const filtered = keyword
      ? collected.filter((n) => n.title.includes(keyword) || n.summary.includes(keyword))
      : collected;

    return filtered.slice(0, limit);
  }

  async grades(): Promise<Grade[]> {
    return this.memo('grades', () => jwxtGrades({ token: this.jwxt() }));
  }

  /** 培养方案完成情况（学分进度）。 */
  async planProgress(code = '01'): Promise<PlanProgress> {
    return this.memo(`plan:${code}`, () => jwxtPlanCompletion({ token: this.jwxt() }, code), 30 * 60_000);
  }

  async exams(): Promise<Exam[]> {
    return this.memo('exams', () => jwxtExams({ token: this.jwxt() }));
  }

  /** 一卡通余额 + 最近流水（门户接口，60s 缓存）。 */
  async card(): Promise<CardInfo> {
    return this.memo('card', () => portalCard({ token: this.portal() }), 60_000);
  }

  /** 待办计数 + 列表（事务中心，60s 缓存）。 */
  async todos(): Promise<TodoSummary> {
    return this.memo('todos', () => portalTodos({ token: this.portal() }), 60_000);
  }

  /**
   * 空教室 = 全部教室 − 当天占用。
   * 教室总量约 1600 间，按页抓取后与占用表求差。
   */
  async freeRooms(opts: {
    date?: string;
    campusId?: string;
    buildingIds?: string[];
    roomTypeIds?: string[];
    minSeats?: number;
    sections?: number[];
    limit?: number;
  }): Promise<FreeRoom[]> {
    const token = this.jwxt();
    const date = opts.date ?? this.session.today ?? todayShanghai();

    const units = await this.memo('courseUnits', () => jwxtCourseUnits({ token }), 30 * 60_000);

    const allRooms = await this.memo(`rooms:${date}:${opts.campusId ?? ''}`, async () =>
      jwxtAllRooms({ token }, {
        date,
        ...(opts.campusId ? { campusId: opts.campusId } : {}),
        ...(opts.buildingIds?.length ? { buildingIds: opts.buildingIds } : {}),
        roomTypeIds: opts.roomTypeIds ?? CLASSROOM_TYPE_IDS,
        ...(opts.minSeats ? { minSeat: String(opts.minSeats) } : {}),
      }),
    60_000);

    const wanted = opts.sections?.length ? opts.sections : undefined;
    const result: FreeRoom[] = [];

    for (const room of allRooms) {
      if (opts.minSeats && room.seats !== undefined && room.seats > 0 && room.seats < opts.minSeats) continue;
      // 占用来自 /room/place/rooms 随教室返回的 roomOccupationInfoVms（含 Lesson 排课）。
      // 注意不要用 /room/place/room-occupancy：那个只含借用（RoomBorrow），一天只有个位数，
      // 用它算出来会"全天空闲"，是错的。
      const busy = room.occupied ?? [];
      const freeSections: number[] = [];
      for (const unit of units) {
        const clash = busy.some((b) => b.startAt < unit.endTime && b.endAt > unit.startTime);
        if (!clash) freeSections.push(unit.indexNo);
      }
      if (wanted && !wanted.every((s) => freeSections.includes(s))) continue;
      if (freeSections.length === 0) continue;
      result.push({ room, freeSections: wanted ?? freeSections });
    }

    // 有座位信息的正常教室排在前面（很多实验室/办公用房的 seatsForLesson 是 0），
    // 再按座位数从大到小，最后按名字，方便"找一间能坐下的教室"。
    result.sort((a, b) => {
      const sa = a.room.seats ?? 0;
      const sb = b.room.seats ?? 0;
      if ((sa > 0) !== (sb > 0)) return sa > 0 ? -1 : 1;
      if (sa !== sb) return sb - sa;
      return a.room.name.localeCompare(b.room.name, 'zh-Hans-CN');
    });
    return opts.limit ? result.slice(0, opts.limit) : result;
  }
}
