import { z } from 'zod';

/** 星期：1=周一 … 7=周日 */
export const Weekday = z.number().int().min(1).max(7);
export type Weekday = z.infer<typeof Weekday>;

/** "HH:mm" 时间串 */
export const Clock = z.string().regex(/^\d{1,2}:\d{2}$/);

/**
 * 统一课程模型。
 * 门户用「日期实例化事件」，教务用「周次模板」，这里统一成带 weeks 的模板：
 * 门户事件额外保留 date，便于在需要精确日期时回退。
 */
export const Course = z.object({
  key: z.string(),
  name: z.string(),
  teachers: z.array(z.string()).default([]),
  location: z.string().optional(),
  campus: z.string().optional(),
  weekday: Weekday,
  startTime: Clock,
  endTime: Clock,
  sectionStart: z.number().int().optional(),
  sectionEnd: z.number().int().optional(),
  /** 教学周序号集合，如 [1,3,5] */
  weeks: z.array(z.number().int()).default([]),
  date: z.string().optional(),
  source: z.enum(['portal', 'jwxt']),
});
export type Course = z.infer<typeof Course>;

export const Notice = z.object({
  id: z.string(),
  title: z.string(),
  /** 列表页只给截断摘要（门户恰好 200 字），教务处接口给完整 HTML */
  summary: z.string().default(''),
  contentHtml: z.string().optional(),
  publishedAt: z.string().optional(),
  department: z.string().optional(),
  readCount: z.number().optional(),
  url: z.string().optional(),
  source: z.enum(['portal-cms', 'jwxt-notice']),
});
export type Notice = z.infer<typeof Notice>;

export const Term = z.object({
  id: z.string(),
  code: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  weeks: z.array(z.number().int()).default([]),
  currentWeek: z.number().int().optional(),
  season: z.string().optional(),
});
export type Term = z.infer<typeof Term>;

export const Occupancy = z.object({
  roomName: z.string(),
  date: z.string(),
  /** 服务端给的是 HHmm 整数，如 1010 */
  startAt: z.number().int(),
  endAt: z.number().int(),
  activity: z.string().optional(),
  type: z.string().optional(),
  teacher: z.string().optional(),
});
export type Occupancy = z.infer<typeof Occupancy>;

export const Room = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string().optional(),
  buildingId: z.string().optional(),
  buildingName: z.string().optional(),
  campus: z.string().optional(),
  floor: z.number().int().optional(),
  seats: z.number().int().optional(),
  /**
   * 该教室当天的占用（Lesson = 排课、RoomBorrow = 借用）。
   * 由 /room/place/rooms 带上 date 参数时随教室一起返回，
   * 真正的占用数据在这里，/room/place/room-occupancy 只给借用（实测一天仅 8 条）。
   */
  occupied: z.array(Occupancy).optional(),
});
export type Room = z.infer<typeof Room>;

export const FreeRoom = z.object({
  room: Room,
  freeSections: z.array(z.number().int()),
});
export type FreeRoom = z.infer<typeof FreeRoom>;

/** 成绩接口字段未知（本账号无数据），宽松解析后统一成展示用的形状。 */
export const Grade = z
  .object({
    courseName: z.string().optional(),
    courseCode: z.string().optional(),
    credit: z.union([z.number(), z.string()]).optional(),
    score: z.union([z.number(), z.string()]).optional(),
    gradePoint: z.union([z.number(), z.string()]).optional(),
    termCode: z.string().optional(),
  })
  .passthrough();
export type Grade = z.infer<typeof Grade>;

export const Exam = z
  .object({
    courseName: z.string().optional(),
    examTime: z.string().optional(),
    place: z.string().optional(),
    seatNo: z.string().optional(),
    examType: z.string().optional(),
  })
  .passthrough();
export type Exam = z.infer<typeof Exam>;

/** 节次 → 时间（教务 /room/system/course-units 权威给出） */
export const CourseUnit = z.object({
  indexNo: z.number().int(),
  startTime: z.number().int(),
  endTime: z.number().int(),
  dayPart: z.string().optional(),
});
export type CourseUnit = z.infer<typeof CourseUnit>;

/** 一卡通的一笔消费/充值（字段形状未见真实数据，宽松解析） */
export const CardTx = z
  .object({
    time: z.string().optional(),
    place: z.string().optional(),
    merchant: z.string().optional(),
    amount: z.union([z.number(), z.string()]).optional(),
    type: z.string().optional(),
  })
  .passthrough();
export type CardTx = z.infer<typeof CardTx>;

/**
 * 一卡通摘要。
 * 实测 /v2/personalData/getMyECard 返回的 balance 是**字符串**（本号为 "0"），
 * lastExpenditure / lastIncome 是数组（本号为空）。
 */
export const Card = z.object({
  /** 余额（元）。服务端给字符串，这里统一成数字，解析不出就 0。 */
  balance: z.number(),
  cardType: z.string().optional(),
  cardStatus: z.string().optional(),
  /** 最近消费 */
  expenses: z.array(CardTx).default([]),
  /** 最近充值 */
  incomes: z.array(CardTx).default([]),
  /** 官方充值/查询入口 */
  appUrl: z.string().optional(),
});
export type Card = z.infer<typeof Card>;

/** 待办/已办计数（/ttc/v1/count/ttcCount） */
export const TodoCounts = z.object({
  apply: z.number().int().default(0),
  circulated: z.number().int().default(0),
  todo: z.number().int().default(0),
  timeout: z.number().int().default(0),
  urgent: z.number().int().default(0),
});
export type TodoCounts = z.infer<typeof TodoCounts>;

/** 一条待办（字段形状未见真实数据，宽松解析） */
export const TodoItem = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    title: z.string().optional(),
    name: z.string().optional(),
    url: z.string().optional(),
    status: z.string().optional(),
    time: z.string().optional(),
    applyTime: z.string().optional(),
  })
  .passthrough();
export type TodoItem = z.infer<typeof TodoItem>;

export const TodoSummary = z.object({
  counts: TodoCounts,
  items: z.array(TodoItem).default([]),
});
export type TodoSummary = z.infer<typeof TodoSummary>;
