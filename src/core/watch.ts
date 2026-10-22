/**
 * 后台盯梢：出分、通知截止日。
 * 这里全是纯函数（不碰 chrome.*），方便单测；调度与通知在 background/index.ts。
 */

/** 通知条目（教务/门户都归一到这里） */
export interface WatchedNotice {
  id: string;
  title: string;
  summary?: string;
  publishedAt?: string;
}

export interface DueItem {
  id: string;
  title: string;
  /** 截止日 YYYY-MM-DD */
  due: string;
  /** 距今天数（0 = 今天，负数 = 已过） */
  daysLeft: number;
}

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12,
};

function num(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) return Number(raw);
  return CN_NUM[raw];
}

/** 从一段文本里抽「报名/申请/提交截止」的日期（只认明确的月日） */
export function extractDueDates(text: string, year: number): string[] {
  const out = new Set<string>();
  // 2026 年 11 月 5 日 / 2026-11-05 / 11 月 5 日 / 11-05
  const full = /(\d{4})\s*[-年/]\s*(\d{1,2})\s*[-月/]\s*(\d{1,2})\s*日?/g;
  for (const m of text.matchAll(full)) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.add(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  const short = /(\d{1,2}|十[一二]?|[一二三四五六七八九])\s*月\s*(\d{1,2}|十[一二三四五六七八九]?|[一二三四五六七八九])\s*日/g;
  for (const m of text.matchAll(short)) {
    const mo = num(m[1] as string);
    const d = num(m[2] as string);
    if (mo && d && mo <= 12 && d <= 31) {
      out.add(`${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }
  return [...out];
}

/** 只保留带「截止语义」的通知，并按剩余天数升序 */
export function dueItems(notices: WatchedNotice[], today: string, withinDays = 7): DueItem[] {
  const DUE_WORD = /截止|截至|报名|申请|提交|上交|办理|填报|申报|登记/;
  const items: DueItem[] = [];
  const year = Number(today.slice(0, 4));
  for (const n of notices) {
    const blob = `${n.title} ${n.summary ?? ''}`;
    if (!DUE_WORD.test(blob)) continue;
    const dates = extractDueDates(blob, year);
    if (dates.length === 0) continue;
    const due = dates.sort()[dates.length - 1] as string;
    const daysLeft = daysBetween(today, due);
    if (daysLeft < 0 || daysLeft > withinDays) continue;
    items.push({ id: n.id, title: n.title, due, daysLeft });
  }
  return items.sort((a, b) => a.daysLeft - b.daysLeft || a.title.localeCompare(b.title));
}

/** 天数差（b - a），按 UTC 日算，避免时区抖动 */
export function daysBetween(a: string, b: string): number {
  const da = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
  const db = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
  return Math.round((db - da) / 86_400_000);
}

/** 成绩指纹：课程名 + 分数，用来判断"有没有新出分" */
export function gradeFingerprint(grades: unknown[]): string {
  const rows = grades
    .map((g) => {
      const o = g as Record<string, unknown>;
      const name = String(o.courseNameZh ?? o.courseName ?? o.nameZh ?? o.name ?? '');
      const score = String(o.score ?? o.scoreText ?? o.totalScore ?? '');
      return `${name}:${score}`;
    })
    .filter((x) => x !== ':')
    .sort();
  return rows.join('|');
}

/** 新出现（相比上次指纹）的成绩条目 */
export function newGradeNames(grades: unknown[], previous: string): string[] {
  // 首次运行（没有历史指纹）不报新成绩，否则会一次性弹出全部已有成绩
  if (!previous) return [];
  const prev = new Set(previous.split('|').filter(Boolean));
  return gradeFingerprint(grades)
    .split('|')
    .filter(Boolean)
    .filter((row) => !prev.has(row))
    .map((row) => row.split(':')[0] as string);
}

/** 组装通知文案（空数组 → 不用推） */
export function buildDigest(args: {
  today: string;
  dues: DueItem[];
  newGrades: string[];
}): { title: string; body: string } | null {
  const parts: string[] = [];
  if (args.newGrades.length) {
    parts.push(`出分 ${args.newGrades.length} 门：${args.newGrades.slice(0, 4).join('、')}`);
  }
  if (args.dues.length) {
    const d = args.dues[0];
    if (d) parts.push(`${d.title.slice(0, 18)}${d.daysLeft === 0 ? '今天截止' : `还有 ${d.daysLeft} 天`}`);
  }
  if (parts.length === 0) return null;
  return { title: '校园信息层 · 今日提醒', body: parts.join('；') };
}
