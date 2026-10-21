import { Card, CardTx, Course, FreeRoom, Grade, Notice, Occupancy, Term, TodoSummary } from './types';
import type { PlanProgress } from './jwxt';
import { compressWeeks } from './util';

const WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function weekdayName(n: number): string {
  return WEEKDAY_CN[n] ?? `周${n}`;
}

export function renderCourseTable(courses: Course[], opts: { term: Term; week?: number }): string {
  const week = opts.week;
  const filtered =
    week === undefined ? courses : courses.filter((c) => c.weeks.length === 0 || c.weeks.includes(week));

  if (filtered.length === 0) {
    return week === undefined ? '课表为空。' : `第 ${week} 周没有课。`;
  }

  const title = `**${opts.term.code} 课表${week === undefined ? '' : `（第 ${week} 周）`}**`;
  const rows: string[] = [title, ''];

  let lastDay = 0;
  for (const c of filtered) {
    if (c.weekday !== lastDay) {
      rows.push('', `**${weekdayName(c.weekday)}**`);
      lastDay = c.weekday;
    }
    const parts = [
      `${c.startTime}-${c.endTime}`,
      c.name,
      c.location ? `@${c.location}` : '',
      c.teachers.length ? `(${c.teachers.join('、')})` : '',
      week === undefined && c.weeks.length ? `[${compressWeeks(c.weeks)}周]` : '',
    ].filter(Boolean);
    rows.push(`- ${parts.join(' ')}`);
  }
  return rows.join('\n').trim();
}

export function renderFreeRooms(
  list: FreeRoom[],
  opts: {
    date: string;
    term?: Term;
    sectionLabel?: string;
    maxRooms?: number;
    /** 限定了地点时回显，例如「南核心教学区（南1/南2/南3）」。 */
    place?: string;
    /** 限定地点前全校的空教室数，用来解释「为什么只剩这几间」。 */
    placeTotal?: number;
  },
): string {
  const where = opts.place ? ` · ${opts.place}` : '';
  if (list.length === 0) {
    if (opts.place) {
      return [
        `${opts.date} 在「${opts.place}」里没找到空教室。`,
        '',
        `可能是当天排满了，也可能是我把地点认窄了（那一片今天共有 ${opts.placeTotal ?? 0} 间空教室，但不属于这个范围）。`,
        '换个说法可以放宽：`明天主校区的空教室` / `明天北1的空教室`。',
      ].join('\n');
    }
    return `${opts.date} 没找到符合条件的空教室。`;
  }
  const limit = opts.maxRooms ?? 12;
  const rows = [
    `**${opts.date} 空教室${where}${opts.sectionLabel ? `（${opts.sectionLabel}）` : ''}**`,
    '',
  ];
  for (const item of list.slice(0, limit)) {
    const seats = item.room.seats ? `${item.room.seats}座` : '';
    const floor = item.room.floor ? `${item.room.floor}层` : '';
    const meta = [item.room.campus, floor, seats].filter(Boolean).join(' ');
    const span = compressWeeks(item.freeSections);
    const all = item.freeSections.length >= 10 ? '全天' : `空闲 ${span} 节`;
    rows.push(`- ${item.room.name}${meta ? `（${meta}）` : ''} ${all}`);
  }
  if (list.length > limit) {
    rows.push('', `…共 ${list.length} 间符合条件的，先列前 ${limit} 间。`);
    rows.push('换个说法能筛：加「南核」「北1」「物理馆」限定楼，或「只看自习室」。');
  }
  return rows.join('\n');
}

export function renderNotices(notices: Notice[], keyword?: string): string {
  if (notices.length === 0) return keyword ? `没有匹配「${keyword}」的通知。` : '没有通知。';
  const rows = [keyword ? `**匹配「${keyword}」的通知**` : '**最新通知**', ''];
  for (const n of notices) {
    const meta = [n.department, n.publishedAt?.slice(0, 16), n.readCount !== undefined ? `${n.readCount} 阅读` : '']
      .filter(Boolean)
      .join(' · ');
    rows.push(`- **${n.title}**${meta ? `\n  ${meta}` : ''}${n.summary ? `\n  ${n.summary.slice(0, 120)}` : ''}`);
  }
  return rows.join('\n');
}

export function renderGrades(grades: Grade[]): string {
  if (grades.length === 0) return '成绩列表为空（本学期可能还没出分，或该学期无成绩）。';
  const rows = ['**成绩**', ''];
  for (const g of grades) {
    const name = g.courseName ?? g.courseCode ?? '未知课程';
    const score = g.score ?? g.gradePoint ?? '—';
    rows.push(`- ${name}：${String(score)}${g.credit ? `（${String(g.credit)} 学分）` : ''}`);
  }
  return rows.join('\n');
}

export function renderPlanProgress(p: PlanProgress, opts: { maxModules?: number } = {}): string {
  const remain = Math.max(0, p.requiredCredits - p.passedCredits - p.takingCredits);
  const rows = [
    '**培养方案学分进度**',
    '',
    `- 要求 **${p.requiredCredits}** 学分 · 已通过 **${p.passedCredits}** · 在修 **${p.takingCredits}** · 还差 **${remain}**`,
    `- 未修课程 **${p.missingCourses}** 门`,
    '',
  ];

  const bar = (passed: number, required: number): string => {
    if (required <= 0) return '';
    const filled = Math.round((passed / required) * 10);
    return `${'█'.repeat(Math.min(10, filled))}${'░'.repeat(Math.max(0, 10 - filled))} ${Math.round((passed / required) * 100)}%`;
  };

  const list = opts.maxModules ? p.modules.slice(0, opts.maxModules) : p.modules;
  for (const m of list) {
    const pct = bar(m.passed, m.required);
    rows.push(
      `- **${m.name}** ${m.passed}/${m.required} 学分${m.taking ? `（在修 ${m.taking}）` : ''}${pct ? ` ${pct}` : ''}`,
    );
    for (const c of m.children ?? []) {
      rows.push(`  - ${c.name} ${c.passed}/${c.required}${c.taking ? ` · 在修 ${c.taking}` : ''}`);
    }
  }
  return rows.join('\n').trim();
}

export function renderOccupancy(list: Occupancy[], date: string): string {  if (list.length === 0) return `${date} 没有任何教室占用记录。`;
  const rows = [`**${date} 教室占用 ${list.length} 条（前 20）**`, ''];
  for (const o of list.slice(0, 20)) {
    rows.push(`- ${o.roomName} ${String(o.startAt).padStart(4, '0')}-${String(o.endAt).padStart(4, '0')} ${o.activity ?? o.type ?? ''}`);
  }
  return rows.join('\n');
}

const money = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function renderCard(card: Card): string {
  const rows = ['**校园一卡通**', '', `- 余额 **¥${money(card.balance)}**`];
  if (card.cardStatus) rows.push(`- 状态：${card.cardStatus}`);
  if (card.cardType) rows.push(`- 卡类型：${card.cardType}`);

  const tx = (label: string, list: CardTx[]): void => {
    if (list.length === 0) return;
    rows.push('', `**最近${label}**`);
    for (const t of list.slice(0, 5)) {
      const amount = toYuanLoose(t.amount);
      const name = t.place ?? t.merchant ?? t.type ?? '';
      rows.push(`- ${[t.time, name, amount ? `¥${money(amount)}` : ''].filter(Boolean).join(' · ')}`);
    }
  };
  tx('消费', card.expenses);
  tx('充值', card.incomes);

  if (card.expenses.length === 0 && card.incomes.length === 0) {
    rows.push('', '没有最近流水（本周期未消费过，或服务端未返回流水）。');
  }
  if (card.appUrl) rows.push('', '充值/明细：用「打开服务」或在校园 App 里进入一卡通。');
  return rows.join('\n');
}

function toYuanLoose(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function renderTodos(t: TodoSummary): string {
  const { counts } = t;
  const total = counts.todo + counts.apply + counts.circulated;
  const rows = ['**待办事项**', ''];
  if (total === 0 && counts.timeout === 0 && counts.urgent === 0) {
    rows.push('目前没有需要你处理的待办。');
    return rows.join('\n');
  }
  rows.push(`- 待办 **${counts.todo}** 项 · 我发起的在办 **${counts.circulated}** · 待我申请 **${counts.apply}**`);
  if (counts.urgent) rows.push(`- ⚠️ 紧急 **${counts.urgent}** 项`);
  if (counts.timeout) rows.push(`- ⏰ 已超时 **${counts.timeout}** 项`);
  if (t.items.length > 0) {
    rows.push('', '**具体事项**');
    for (const item of t.items.slice(0, 10)) {
      const title = item.title ?? item.name ?? '(无标题)';
      rows.push(`- ${[title, item.time ?? item.applyTime ?? '', item.status ?? ''].filter(Boolean).join(' · ')}`);
    }
  }
  rows.push('', '办理入口：`打开网上办事大厅`。');
  return rows.join('\n');
}
