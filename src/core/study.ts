import type { FreeRoom } from './types';
import type { LibrarySeats } from './library';
import { fmtDur, minToHhmm } from './render';
import { walkMinutes, buildingOf } from './walk';

/**
 * 自习决策器：把「空教室」和「图书馆余量」合成一个答案。
 * 纯函数——不碰网络，方便单测；网络取数在 tools.ts 里做。
 */

export interface StudyOption {
  kind: 'classroom' | 'library';
  name: string;
  /** 现在就能坐多少分钟（图书馆到楼层级没有座位级数据，只能给余量） */
  minutes: number;
  /** 从出发点步行多少分钟；undefined = 不知道从哪出发 */
  walkMin?: number;
  /** 空闲时间窗（教室才有） */
  window?: { start: number; end: number };
  detail?: string;
  /** 可点开的链接（图书馆才有） */
  url?: string;
}

export interface StudyPlan {
  needMinutes: number;
  options: StudyOption[];
  /** 图书馆整体情况，用来解释"为什么没把图书馆排第一" */
  libraryNote?: string;
}

/** 从「我想自习两小时」里抽需求时长（分钟） */
export function extractNeedMinutes(text: string): number | undefined {
  const numMap: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 半: 0.5 };
  const toNum = (raw: string): number | undefined => {
    const n = numMap[raw] ?? Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  // 「一个半小时」= 1.5 小时（要先判，否则会被下面的单字规则吃成 0.5 小时）
  const andHalf = /([一二两三四d])\s*个半\s*(?:小时|钟头)/.exec(text);
  if (andHalf) {
    const n = toNum(andHalf[1] as string);
    if (n !== undefined) return Math.round((n + 0.5) * 60);
  }
  if (/半小时/.test(text)) return 30;

  const m = /([一二两三四半\d]{1,3})\s*(?:个)?\s*(小时|钟头|分钟)/.exec(text);
  if (!m) {
    if (/半天/.test(text)) return 4 * 60;
    return undefined;
  }
  const n = toNum(m[1] as string);
  if (n === undefined) return undefined;
  return m[2] === '分钟' ? Math.round(n) : Math.round(n * 60);
}

/**
 * 生成计划：
 * 1. 教室按「能连坐够时长」筛，不够时长的降级为备选；
 * 2. 有起点（near）就按步行分钟排序，否则按连坐时长；
 * 3. 图书馆给一行汇总（到楼层），作为"换场地"的备选。
 */
export function planStudy(args: {
  needMinutes: number;
  near?: string;
  rooms: FreeRoom[];
  library?: LibrarySeats;
  maxWalkMin?: number;
}): StudyPlan {
  const { needMinutes, near, rooms } = args;
  const enough: StudyOption[] = [];
  const short: StudyOption[] = [];

  for (const fr of rooms) {
    const minutes = fr.freeNowMin ?? fr.longestMin ?? 0;
    if (minutes <= 0) continue;
    const walkMin = near ? walkMinutes(fr.room.name, near) : undefined;
    if (args.maxWalkMin !== undefined && walkMin !== undefined && walkMin > args.maxWalkMin) continue;
    const win = fr.windows?.[0];
    const opt: StudyOption = {
      kind: 'classroom',
      name: fr.room.name,
      minutes,
      ...(walkMin !== undefined ? { walkMin } : {}),
      ...(win ? { window: win } : {}),
      ...(fr.room.seats ? { detail: `${fr.room.seats} 座` } : {}),
    };
    (minutes >= needMinutes ? enough : short).push(opt);
  }

  const cmp = (a: StudyOption, b: StudyOption): number => {
    if (near) {
      const aw = a.walkMin ?? 99;
      const bw = b.walkMin ?? 99;
      if (aw !== bw) return aw - bw;
    }
    return b.minutes - a.minutes;
  };
  enough.sort(cmp);
  short.sort(cmp);

  const options = [...enough.slice(0, 3)];
  if (options.length === 0) options.push(...short.slice(0, 3));

  let libraryNote: string | undefined;
  const lib = args.library;
  if (lib) {
    const total = lib.premises.reduce((s, p) => s + p.total, 0);
    const free = lib.premises.reduce((s, p) => s + p.free, 0);
    const floors = lib.premises
      .flatMap((p) => p.floors ?? [])
      .map((f) => `${f.name} ${f.free}/${f.total}`)
      .slice(0, 4)
      .join('、');
    libraryNote = floors
      ? `图书馆整体 ${free}/${total} 空着（${floors}）`
      : `图书馆整体 ${free}/${total} 空着`;
    const best = [...lib.premises].sort((a, b) => b.free - a.free)[0];
    if (best && best.free > 0) {
      options.push({
        kind: 'library',
        name: best.name || '图书馆',
        minutes: 0,
        ...(near ? { walkMin: walkMinutes('图_1', near) } : {}),
        detail: `余 ${best.free}/${best.total}，座位图要点开看`,
        ...(best.free > 0 && lib.url ? { url: lib.url } : {}),
      });
    }
  }

  return { needMinutes, options, ...(libraryNote ? { libraryNote } : {}) };
}

/** 渲染计划 */
export function renderStudyPlan(plan: StudyPlan, opts: { date: string; near?: string }): string {
  const head = `**${opts.date} · 想连坐 ${fmtDur(plan.needMinutes)}${opts.near ? `（从${opts.near}出发）` : ''}**`;
  if (plan.options.length === 0) {
    return [
      head,
      '',
      '这个时长在教室和图书馆都凑不出来。可以缩短时间，或者换个条件（比如不限定楼栋）。',
    ].join('\n');
  }
  const rows = [head, ''];
  plan.options.forEach((o, i) => {
    const bits: string[] = [];
    if (o.walkMin !== undefined) bits.push(o.walkMin === 0 ? '就在这栋楼' : `走 ${o.walkMin} 分钟`);
    if (o.kind === 'classroom') {
      if (o.window) bits.push(`${minToHhmm(o.window.start)}–${minToHhmm(o.window.end)}`);
      bits.push(o.minutes >= plan.needMinutes ? `能坐 ${fmtDur(o.minutes)}` : `只有 ${fmtDur(o.minutes)}，不够`);
    } else {
      bits.push(o.detail ?? '图书馆');
    }
    rows.push(`${i + 1}. **${o.name}**（${o.kind === 'classroom' ? '教室' : '图书馆'}）— ${bits.filter(Boolean).join('，')}`);
  });
  if (plan.libraryNote) {
    rows.push('', `图书馆参考：${plan.libraryNote}。`);
  }
  if (plan.options[0]?.kind === 'classroom') {
    rows.push('', '要订图书馆座位就直接说「订 <座位号>，今天」，我会给你一个长按确认的按钮。');
  }
  return rows.join('\n');
}
