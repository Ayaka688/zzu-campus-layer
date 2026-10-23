import type { Course } from './types';
import { addDays, todayShanghai, weekdayOf } from './util';

/** 一条课前提醒（at 是绝对毫秒时间戳，由壳侧按这个时间点弹通知）。 */
export interface ReminderBlock {
  at: number;
  title: string;
  body: string;
}

const GAP_MIN = 40; // 两节之间空档 ≤ 40 分钟就算"连着上"（本校 1-2 节与 3-4 节之间是 30 分钟；午休 130 分钟不会被并进来）
const LEAD_MIN = 30; // 提前 30 分钟提醒

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

/**
 * 把未来若干天的课排成提醒块。
 *
 * 合并规则（用户要求）：上午/下午里连着的两节课只弹一条，正文把两节都交代清楚；
 * 跨午/跨夜的课不合并——那样一条通知会离第一节太早。
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

  for (let i = 0; i < days; i += 1) {
    const date = addDays(today, i);
    const weekday = weekdayOf(date);
    const weekIndex = termStart ? Math.floor(daysBetween(termStart, date) / 7) + 1 : 0;

    const list = courses
      .filter((c) => c.weekday === weekday)
      .filter((c) => (weekIndex > 0 ? inWeek(c, weekIndex) : true))
      .sort((a, b) => hhmmToMin(a.startTime) - hhmmToMin(b.startTime));
    if (list.length === 0) continue;

    // 按"同半天 + 间隔 ≤ 15 分钟"切块
    let group: Course[] = [];
    const flush = () => {
      if (group.length === 0) return;
      const first = group[0]!;
      const last = group[group.length - 1]!;
      const startMin = hhmmToMin(first.startTime);
      const atMs = at(date, minToHhmm(Math.max(startMin - LEAD_MIN, 0)));
      if (atMs > nowMs) {
        const span = `${first.startTime}-${last.endTime}`;
        const body = group
          .map((c) => `${c.startTime}-${c.endTime} ${c.name}${c.location ? ` @${c.location}` : ''}`)
          .join('；');
        out.push({
          at: atMs,
          title: group.length > 1 ? `半小时后有 ${group.length} 节课` : '半小时后有一节课',
          body: `${span}｜${body}`,
        });
      }
      group = [];
    };

    for (const c of list) {
      if (group.length === 0) {
        group = [c];
        continue;
      }
      const prev = group[group.length - 1]!;
      const sameHalf = hhmmToMin(prev.startTime) < 12 * 60 === (hhmmToMin(c.startTime) < 12 * 60);
      const gap = hhmmToMin(c.startTime) - hhmmToMin(prev.endTime);
      if (sameHalf && gap <= GAP_MIN) group.push(c);
      else {
        flush();
        group = [c];
      }
    }
    flush();
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
