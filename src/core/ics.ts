import { Course, Term } from './types';
import type { NoticeCard } from './notice';
import { addDays, dateOfWeek } from './util';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "2026-10-19" + "08:00" -> "20261019T080000" */
function stamp(date: string, time: string): string {
  const [h = '00', m = '00'] = time.split(':');
  return `${date.replace(/-/g, '')}T${pad(Number(h))}${pad(Number(m))}00`;
}

function esc(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** RFC 5545 要求每行不超过 75 字节，超出折行 */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 73) return line;
  const out: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of line) {
    const len = new TextEncoder().encode(ch).length;
    if (currentBytes + len > 73) {
      out.push(current);
      current = ' ' + ch;
      currentBytes = 1 + len;
    } else {
      current += ch;
      currentBytes += len;
    }
  }
  if (current) out.push(current);
  return out.join('\r\n');
}

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Shanghai',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:+0800',
  'TZOFFSETTO:+0800',
  'TZNAME:CST',
  'END:STANDARD',
  'END:VTIMEZONE',
];

export interface IcsOptions {
  term: Term;
  fromWeek?: number;
  toWeek?: number;
  /** 由课程生成的 UID 前缀，避免与其他日历冲突 */
  uidPrefix?: string;
  now?: Date;
}

/**
 * 课程表 → iCalendar。
 * 采用 TZID=Asia/Shanghai 的本地时间写法，不写 UTC，避免跨时区客户端错位。
 */
export function coursesToIcs(courses: Course[], opts: IcsOptions): string {
  const now = opts.now ?? new Date();
  const dtstamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//zzu-campus-layer//course table//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:郑大课表 ' + opts.term.code,
    'X-WR-TIMEZONE:Asia/Shanghai',
    ...VTIMEZONE,
  ];

  let seq = 0;
  for (const course of courses) {
    const weeks = course.weeks.filter(
      (w) => (opts.fromWeek === undefined || w >= opts.fromWeek) && (opts.toWeek === undefined || w <= opts.toWeek),
    );
    for (const week of weeks) {
      const date = dateOfWeek(opts.term.startDate, week, course.weekday);
      seq += 1;
      const descParts = [
        course.teachers.length ? `教师：${course.teachers.join('、')}` : '',
        course.location ? `地点：${course.location}` : '',
        `第 ${week} 周`,
      ].filter(Boolean);
      lines.push(
        'BEGIN:VEVENT',
        `UID:${opts.uidPrefix ?? 'zzucampus'}-${seq}-${date}@zzu`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;TZID=Asia/Shanghai:${stamp(date, course.startTime)}`,
        `DTEND;TZID=Asia/Shanghai:${stamp(date, course.endTime)}`,
        fold(`SUMMARY:${esc(course.name)}`),
        ...(course.location ? [fold(`LOCATION:${esc(course.location)}`)] : []),
        fold(`DESCRIPTION:${esc(descParts.join(' / '))}`),
        'END:VEVENT',
      );
    }
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export interface NoticeIcsOptions {
  now?: Date;
  uidPrefix?: string;
  /** 加闹钟（默认加）。截止事件提前 1 天、活动提前 2 小时——「0 次错过」靠它。 */
  alarm?: boolean;
}

/**
 * 加分钟并**跨天进位**。
 * 23:30 + 2 小时 = 次日 01:30，日期要跟着 +1；否则 DTEND 会早于 DTSTART，
 * 有的日历客户端会直接丢掉这个事件（实测 Google Calendar 会显示成 0 分钟）。
 */
function plusMinutesMoment(date: string, time: string, minutes: number): { date: string; time: string } {
  const [h = '00', m = '00'] = time.split(':');
  const total = Number(h) * 60 + Number(m) + minutes;
  const dayShift = Math.floor(total / 1440);
  const rest = ((total % 1440) + 1440) % 1440;
  return {
    date: addDays(date, dayShift),
    time: `${pad(Math.floor(rest / 60))}:${pad(rest % 60)}`,
  };
}

/**
 * 通知卡片 → iCalendar。
 *
 * 映射规则：
 * - 有活动时间（正文里抽到「10 月 23 日 19:00 开讲」）→ 定时事件，默认 2 小时；
 * - 只有活动日期没有时刻 → 全天事件；
 * - 有截止日 → 单独一个「截止：…」事件（全天，或按抽到的时刻），提前 1 天响。
 *
 * 一条通知可能同时产出两个事件（既开讲又要报名），因为它们要提醒的时机不同。
 */
export function noticesToIcs(cards: NoticeCard[], opts: NoticeIcsOptions = {}): string {
  const now = opts.now ?? new Date();
  const dtstamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const alarm = opts.alarm ?? true;

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//zzu-campus-layer//notices//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:郑大通知',
    'X-WR-TIMEZONE:Asia/Shanghai',
    ...VTIMEZONE,
  ];

  let seq = 0;
  for (const card of cards) {
    const description = [card.department, card.url, card.summary].filter(Boolean).join(' / ');
    const summary = `[${card.categoryLabel}] ${card.title}`;

    if (card.eventStart) {
      seq += 1;
      const uid = `${opts.uidPrefix ?? 'zzunotice'}-e${seq}-${card.eventStart.replace(/-/g, '')}@zzu`;
      lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${dtstamp}`);
      if (card.eventTime) {
        const end = plusMinutesMoment(card.eventStart, card.eventTime, 120);
        lines.push(`DTSTART;TZID=Asia/Shanghai:${stamp(card.eventStart, card.eventTime)}`);
        lines.push(`DTEND;TZID=Asia/Shanghai:${stamp(end.date, end.time)}`);
      } else {
        lines.push(`DTSTART;VALUE=DATE:${card.eventStart.replace(/-/g, '')}`);
        lines.push(`DTEND;VALUE=DATE:${addDays(card.eventStart, 1).replace(/-/g, '')}`);
      }
      lines.push(fold(`SUMMARY:${esc(summary)}`));
      if (card.location) lines.push(fold(`LOCATION:${esc(card.location)}`));
      lines.push(fold(`DESCRIPTION:${esc(description)}`));
      if (alarm) {
        lines.push('BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', 'DESCRIPTION:讲座/活动提醒', 'END:VALARM');
      }
      lines.push('END:VEVENT');
    }

    if (card.deadline) {
      seq += 1;
      const uid = `${opts.uidPrefix ?? 'zzunotice'}-d${seq}-${card.deadline.replace(/-/g, '')}@zzu`;
      lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${dtstamp}`);
      if (card.deadlineTime) {
        const end = plusMinutesMoment(card.deadline, card.deadlineTime, 30);
        lines.push(`DTSTART;TZID=Asia/Shanghai:${stamp(card.deadline, card.deadlineTime)}`);
        lines.push(`DTEND;TZID=Asia/Shanghai:${stamp(end.date, end.time)}`);
      } else {
        lines.push(`DTSTART;VALUE=DATE:${card.deadline.replace(/-/g, '')}`);
        lines.push(`DTEND;VALUE=DATE:${addDays(card.deadline, 1).replace(/-/g, '')}`);
      }
      lines.push(fold(`SUMMARY:${esc(`截止 ${summary}`)}`));
      if (card.url) lines.push(fold(`URL:${card.url}`));
      lines.push(fold(`DESCRIPTION:${esc(description)}`));
      if (alarm) {
        lines.push('BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', 'DESCRIPTION:明天截止，记得报名/交材料', 'END:VALARM');
      }
      lines.push('END:VEVENT');
    }
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

