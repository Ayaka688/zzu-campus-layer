import { Course, Term } from './types';
import { dateOfWeek } from './util';

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
