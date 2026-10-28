import type { Course } from './types';
import { addDays, todayShanghai, weekdayOf } from './util';

/** 一条课前提醒（at 是绝对毫秒时间戳，由壳侧按这个时间点弹通知）。 */
export interface ReminderBlock {
  at: number;
  title: string;
  body: string;
}

/** 提前多少分钟提醒：每节课开课前 30 分钟各弹一条。 */
export const LEAD_MIN = 30;

function hhmmToMin(v: string): number {
  const [h, m] = v.split(':');
  return Number(h) * 60 + Number(m);
}

function minToHhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 上海时区某天某时刻的绝对时间戳。 */
function at(date: string, hhmm: string): number {
  return new Date(`${date}T${hhmm}:00+08:00`).getTime();
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00+08:00`).getTime() - new Date(`${a}T00:00:00+08:00`).getTime()) / 86400000);
}

/** 同一节课在不在这一周（courses 里的 weeks 是教学周集合，空表示每周都有）。 */
function inWeek(course: Course, weekIndex: number): boolean {
  const weeks = course.weeks ?? [];
  return weeks.length === 0 || weeks.includes(weekIndex);
}

/** 通知标题：一节课一条，标题直接说是哪门课。 */
function titleOf(course: Course): string {
  return `半小时后：${course.name}`;
}

/** 通知正文：时间段 + 第几节 + 地点 + 老师。 */
function bodyOf(course: Course): string {
  const span = `${course.startTime}-${course.endTime}`;
  const sections =
    course.sectionStart && course.sectionEnd ? `第${course.sectionStart}-${course.sectionEnd}节 ` : '';
  const where = course.location ? ` @${course.location}` : '';
  const teachers = course.teachers?.length ? ` · ${course.teachers.join('、')}` : '';
  return `${span} ${sections}${where}${teachers}`.replace(/\s+/g, ' ').trim();
}

/**
 * 把未来若干天的课排成提醒块。
 *
 * 规则（用户要求，2026-10 改）：**一节课一条，开课前 30 分钟弹，不做任何合并**。
 * 之前是把「同一半天、空档 ≤40 分钟的连堂课」并成一条 —— 上午满课时整上午只在
 * 第一节前弹一次，第二节课就没有提醒了；现在每节课各自独立。
 *
 * 过点的课不补弹（`at` 已经过去的直接丢），避免一开 App 就糊一脸旧通知。
 */
export function buildReminderBlocks(
  courses: Course[],
  opts: { now?: Date; days?: number; termStart?: string } = {},
): ReminderBlock[] {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 7;
  const termStart = opts.termStart;
  const nowMs = now.getTime();
  const today = todayShanghai(nowMs);
  const out: ReminderBlock[] = [];
  /* 门户给「事件」、教务给「模板」，同一节课可能两边都有；按 日期+时间+课名 去重 */
  const seen = new Set<string>();

  for (let i = 0; i < days; i += 1) {
    const date = addDays(today, i);
    const weekday = weekdayOf(date);
    const weekIndex = termStart ? Math.floor(daysBetween(termStart, date) / 7) + 1 : 0;

    const list = courses
      .filter((c) => c.weekday === weekday)
      .filter((c) => (weekIndex > 0 ? inWeek(c, weekIndex) : true))
      .sort((a, b) => hhmmToMin(a.startTime) - hhmmToMin(b.startTime));

    for (const course of list) {
      const startMin = hhmmToMin(course.startTime);
      const atMs = at(date, minToHhmm(Math.max(startMin - LEAD_MIN, 0)));
      if (atMs <= nowMs) continue; // 已经过点，不补弹

      const key = `${date}|${course.startTime}|${course.name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ at: atMs, title: titleOf(course), body: bodyOf(course) });
    }
  }

  return out.sort((a, b) => a.at - b.at);
}

declare global {
  interface Window {
    CampusNotify?: { setReminders(json: string): void };
  }
}

/** 有壳就交给壳去定时，没有就当没发生（网页版没有通知能力）。 */
export function pushReminders(blocks: ReminderBlock[]): boolean {
  const bridge = typeof window === 'undefined' ? undefined : window.CampusNotify;
  if (!bridge || typeof bridge.setReminders !== 'function') return false;
  bridge.setReminders(JSON.stringify(blocks));
  return true;
}
