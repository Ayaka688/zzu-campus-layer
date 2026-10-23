/**
 * 通知卡片：把一条「通知」变成一张能看、能比、能跳转的卡片。
 *
 * 为什么不在 types.ts 的 Notice 上加字段：Notice 是**接口原样**（谁给的、什么形状就什么样），
 * 卡片是**加工结果**（分类、时间、去重后的身份）。混在一起以后接口一改就会连带崩。
 *
 * 这里全是纯函数，不碰 chrome.*，node 下可直接单测；错就错在规则表（noticeRules.ts），不在这里改词。
 */
import type { Notice } from './types';
import {
  CATEGORY_LABEL,
  NOTICE_CATEGORIES,
  classifyNotice,
  expandNoticeQuery,
  extractDeadline,
  extractEventStart,
  extractLocation,
  type NoticeCategory,
} from './noticeRules';
import { addDays, todayShanghai } from './util';
import { daysBetween } from './watch';

export interface NoticeCard {
  /** 去重后的稳定 id：`来源:原始 id`，已读状态用它 */
  id: string;
  title: string;
  category: NoticeCategory;
  categoryLabel: string;
  /** 教务类的子类（选课/考试/成绩/学籍/毕业/实习…），非教务没有 */
  topicLabel?: string;
  /** 发布时间，YYYY-MM-DD HH:mm */
  publishedAt?: string;
  /** 报名/提交截止日，YYYY-MM-DD（从正文抽，抽不到就没有） */
  deadline?: string;
  /** 截止的具体时刻，HH:mm */
  deadlineTime?: string;
  /** 活动开始日，YYYY-MM-DD */
  eventStart?: string;
  /** 活动开始时刻，HH:mm */
  eventTime?: string;
  location?: string;
  department?: string;
  summary: string;
  /** 门户原文地址；教务处通知没有公开链接，只能给正文（hasFullText） */
  url?: string;
  sources: Array<'portal-cms' | 'jwxt-notice'>;
  /** 有完整正文（教务处才有） */
  hasFullText: boolean;
  readCount?: number;
  read: boolean;
}

export interface CardOptions {
  /** 用来算年份、算「还有几天」。默认取北京时间的今天 */
  today?: string;
  /** 已读 id 集合（来自 noticeStore） */
  readIds?: Iterable<string>;
}

/**
 * 去掉 HTML 标签，留下能抽日期/地点的纯文本。
 * 注意保留段落边界：`</p>` 换成换行而不是空格，否则「讲座 19:00」和「报名截止 10 月 20 日」
 * 会被拼成同一句，截止日就会抽错（实测把讲座日期当成截止日）。
 * UI 展开教务全文时也用它——接口 HTML 不进 DOM。
 */
export function toPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function cardId(notice: Notice): string {
  return `${notice.source}:${notice.id}`;
}

/** 单条通知 → 卡片。抽不到时间/地点就真的不写字段（不要在 UI 上出现假的「待定」）。 */
export function toCard(notice: Notice, opts: CardOptions = {}): NoticeCard {
  const today = opts.today ?? todayShanghai();
  const year = Number(today.slice(0, 4));
  const full = notice.contentHtml ? toPlainText(notice.contentHtml) : '';
  const body = full || notice.summary;
  const text = `${notice.title} ${body}`;

  const classify = classifyNotice(notice.title, body);
  const deadline = extractDeadline(text, year, today);
  const event = extractEventStart(text, year, today);
  const location = extractLocation(text);
  const id = cardId(notice);
  const readSet = opts.readIds ? new Set(opts.readIds) : null;

  return {
    id,
    title: notice.title,
    category: classify.category,
    categoryLabel: CATEGORY_LABEL[classify.category],
    ...(classify.topicLabel ? { topicLabel: classify.topicLabel } : {}),
    ...(notice.publishedAt ? { publishedAt: notice.publishedAt.slice(0, 16) } : {}),
    ...(deadline ? { deadline: deadline.date, ...(deadline.time ? { deadlineTime: deadline.time } : {}) } : {}),
    ...(event ? { eventStart: event.date, ...(event.time ? { eventTime: event.time } : {}) } : {}),
    ...(location ? { location } : {}),
    ...(notice.department ? { department: notice.department } : {}),
    summary: body.slice(0, 160),
    ...(notice.url ? { url: notice.url } : {}),
    sources: [notice.source],
    hasFullText: Boolean(full),
    ...(typeof notice.readCount === 'number' ? { readCount: notice.readCount } : {}),
    read: readSet ? readSet.has(id) : false,
  };
}

/**
 * 标题归一化：去空白、去括注、去标点、去「关于…的通知」外壳。
 * 目的是让「【通知】关于举办 AI 大赛的通知」和「关于举办AI大赛的通知」认成同一条。
 */
export function normalizeTitle(title: string): string {
  return title
    .replace(/[\s\u3000]/g, '')
    .replace(/[【】\[\]（）()《》〈〉「」『』“”"']/g, '')
    .replace(/[，,。.、；;：:！!？?—\-_~·…]/g, '')
    .replace(/^(?:通知|公告|通告|新闻)/, '')
    .replace(/^关于/, '')
    .replace(/的?(?:通知|公告|通告)$/, '')
    .toLowerCase();
}

function laterDate(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function mergeCards(a: NoticeCard, b: NoticeCard): NoticeCard {
  const merged: NoticeCard = {
    id: a.id,
    title: a.title,
    category: a.category,
    categoryLabel: a.categoryLabel,
    summary: a.summary.length >= b.summary.length ? a.summary : b.summary,
    sources: [...new Set([...a.sources, ...b.sources])],
    hasFullText: a.hasFullText || b.hasFullText,
    read: a.read || b.read,
  };
  const publishedAt = laterDate(a.publishedAt, b.publishedAt);
  if (publishedAt) merged.publishedAt = publishedAt;
  const deadline = a.deadline ?? b.deadline;
  if (deadline) merged.deadline = deadline;
  const deadlineTime = a.deadlineTime ?? b.deadlineTime;
  if (deadlineTime) merged.deadlineTime = deadlineTime;
  const eventStart = a.eventStart ?? b.eventStart;
  if (eventStart) merged.eventStart = eventStart;
  const eventTime = a.eventTime ?? b.eventTime;
  if (eventTime) merged.eventTime = eventTime;
  const location = a.location ?? b.location;
  if (location) merged.location = location;
  const department = a.department ?? b.department;
  if (department) merged.department = department;
  const topicLabel = a.topicLabel ?? b.topicLabel;
  if (topicLabel) merged.topicLabel = topicLabel;
  const url = a.url ?? b.url;
  if (url) merged.url = url;
  const readCount = Math.max(a.readCount ?? 0, b.readCount ?? 0);
  if (readCount > 0) merged.readCount = readCount;
  return merged;
}

/**
 * 跨来源去重：同一场讲座，教务处发一遍、门户转一遍，标题几乎一样。
 * 按归一化标题合并，保留信息更全的那份（原文链接、完整正文、截止日）。
 */
export function dedupeCards(cards: NoticeCard[]): NoticeCard[] {
  const byTitle = new Map<string, NoticeCard>();
  for (const card of cards) {
    const key = normalizeTitle(card.title) || card.id;
    const prev = byTitle.get(key);
    byTitle.set(key, prev ? mergeCards(prev, card) : { ...card, sources: [...card.sources] });
  }
  return [...byTitle.values()];
}

export type CardSort = 'published' | 'deadline';

/** 两种排序：按发布（默认）/ 按截止（临近在前，没有截止的排最后）。 */
export function sortCards(cards: NoticeCard[], sort: CardSort = 'published'): NoticeCard[] {
  const out = [...cards];
  if (sort === 'deadline') {
    out.sort((a, b) => {
      const da = a.deadline ?? '9999-12-31';
      const db = b.deadline ?? '9999-12-31';
      if (da !== db) return da.localeCompare(db);
      return (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || a.title.localeCompare(b.title);
    });
    return out;
  }
  out.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || a.title.localeCompare(b.title));
  return out;
}

/** 通知列表 → 卡片列表（分类 + 抽取 + 去重 + 按发布倒序）。 */
export function buildCards(notices: Notice[], opts: CardOptions = {}): NoticeCard[] {
  const today = opts.today ?? todayShanghai();
  return sortCards(dedupeCards(notices.map((n) => toCard(n, { ...opts, today }))), 'published');
}

export interface CardFilter {
  categories?: NoticeCategory[];
  keyword?: string;
  /**
   * 时间窗 N：
   * - N = 0：只看今天（今天发布的，或今天截止的）
   * - N > 0：最近 N 天发布的，或未来 N 天内截止的
   */
  withinDays?: number;
  today?: string;
}

/** 按分类 / 关键词 / 时间窗筛。关键词走同义词扩展并打分排序（热搜词命中标题的排前面）。 */
export function filterCards(cards: NoticeCard[], filter: CardFilter = {}): NoticeCard[] {
  const today = filter.today ?? todayShanghai();
  let out = cards;
  if (filter.categories?.length) {
    const wanted = new Set(filter.categories);
    out = out.filter((c) => wanted.has(c.category));
  }
  if (filter.withinDays !== undefined) {
    const n = Math.max(0, filter.withinDays);
    const from = addDays(today, -n);
    const to = addDays(today, n);
    out = out.filter((c) => {
      const published = (c.publishedAt ?? '').slice(0, 10);
      const fresh = Boolean(published) && published >= from && published <= today;
      const due = Boolean(c.deadline) && (c.deadline as string) >= today && (c.deadline as string) <= to;
      // 开讲时间也要算进来：不然「今天有什么讲座」会漏掉「今天开讲、三天前发布」的那条
      const event = Boolean(c.eventStart) && (c.eventStart as string) >= today && (c.eventStart as string) <= to;
      return fresh || due || event;
    });
  }
  if (filter.keyword?.trim()) out = rankCards(out, filter.keyword);
  return out;
}

/** 关键词命中分：标题 6、分类标签 3、摘要 2、部门/地点 1。同分按发布时间倒序。 */
export function cardScore(card: NoticeCard, query: string): number {
  const terms = expandNoticeQuery(query);
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (card.title.includes(term)) score += 6;
    if (card.categoryLabel.includes(term)) score += 3;
    if (card.summary.includes(term)) score += 2;
    if (card.department?.includes(term)) score += 1;
    if (card.location?.includes(term)) score += 1;
  }
  return score;
}

export function rankCards(cards: NoticeCard[], query: string): NoticeCard[] {
  return cards
    .map((card) => ({ card, score: cardScore(card, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (b.card.publishedAt ?? '').localeCompare(a.card.publishedAt ?? ''))
    .map((x) => x.card);
}

/** 距截止还有几天（0 = 今天，负数 = 已过）。没有截止日返回 undefined。 */
export function daysLeft(card: NoticeCard, today = todayShanghai()): number | undefined {
  if (!card.deadline) return undefined;
  return daysBetween(today, card.deadline);
}

/** 「今天截止 / 明天截止 / 还有 N 天 / 已截止」 —— UI 上临近截止的高亮文案。 */
export function dueLabel(days: number | undefined): string {
  if (days === undefined) return '';
  if (days < 0) return '已截止';
  if (days === 0) return '今天截止';
  if (days === 1) return '明天截止';
  return `还有 ${days} 天`;
}

/** 未来 withinDays 天内要截止的，按截止日升序（「0 次错过」靠它）。 */
export function dueCards(cards: NoticeCard[], today = todayShanghai(), withinDays = 3): NoticeCard[] {
  const limit = addDays(today, withinDays);
  return cards
    .filter((c) => c.deadline !== undefined && (c.deadline as string) >= today && (c.deadline as string) <= limit)
    .sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? ''));
}

/**
 * 按「是否已过截止」拆成两堆。
 * 列表里已截止的折到最底部（默认收起），否则「按截止」排序时它们会顶在最前面——
 * 越过期越靠前，正好是用户最不需要的。
 */
export function splitByDeadline(
  cards: NoticeCard[],
  today = todayShanghai(),
): { active: NoticeCard[]; expired: NoticeCard[] } {
  const active: NoticeCard[] = [];
  const expired: NoticeCard[] = [];
  for (const card of cards) {
    const left = daysLeft(card, today);
    if (left !== undefined && left < 0) expired.push(card);
    else active.push(card);
  }
  return { active, expired };
}

/**
 * 系统通知 id → 点开之后该干什么。
 *
 * 两种通知：
 * - `notice-<卡片 id>`：某条通知要截止了，点开定位到那张卡；
 * - `notice-more-<日期>` / `watch-grades-<日期>`：聚合提醒，没有具体卡片，打开时间线就行。
 */
export interface NotificationTarget {
  /** 要定位的卡片 id；没有就是只把时间线打开 */
  cardId?: string;
  openNotices: boolean;
}

export function parseNoticeNotification(id: string): NotificationTarget | null {
  if (id.startsWith('notice-more-')) return { openNotices: true };
  if (id.startsWith('notice-')) {
    const cardId = id.slice('notice-'.length);
    return cardId ? { cardId, openNotices: true } : null;
  }
  if (id.startsWith('watch-grades-')) return { openNotices: true };
  return null;
}

/** 每类多少条（tab 上的数字）。只返回有内容的类，按 NOTICE_CATEGORIES 顺序。 */
export function categoryCounts(cards: NoticeCard[]): Array<{ category: NoticeCategory; label: string; count: number }> {
  const counts = new Map<NoticeCategory, number>();
  for (const card of cards) counts.set(card.category, (counts.get(card.category) ?? 0) + 1);
  return NOTICE_CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABEL[category],
    count: counts.get(category) ?? 0,
  })).filter((row) => row.count > 0);
}

/**
 * 一天的「换日点」：凌晨 4 点。
 * 凌晨 0–4 点发布的公告、结束的讲座仍算前一天——学生这个点在看的是「昨晚那场」。
 * 只影响「今天」的判断，不影响卡片上显示的真实时间。
 */
export const DAY_ROLLOVER_HOUR = 4;

/** 一个时间点属于哪一个「校历日」（凌晨 4 点前算前一天）。 */
export function calendarDay(value?: string): string {
  if (!value) return '';
  const date = value.slice(0, 10);
  const time = value.slice(11, 16);
  if (!time) return date;
  const hour = Number(time.slice(0, 2));
  if (!Number.isFinite(hour)) return date;
  return hour < DAY_ROLLOVER_HOUR ? addDays(date, -1) : date;
}

export interface TodayDigest {
  today: string;
  /** 今天新发布的（凌晨 4 点前算前一天） */
  fresh: NoticeCard[];
  /** 今天举办/开讲的（靠正文里的日期抽出来，抽不到就没有） */
  happening: NoticeCard[];
  /** 今天截止的 */
  dueToday: NoticeCard[];
  /** 未来 3 天截止的（不含今天） */
  dueSoon: NoticeCard[];
  byCategory: Array<{ category: NoticeCategory; label: string; count: number }>;
  /** 一句话，给首页今天卡片用 */
  line: string;
}

/**
 * 「今日卡片」的口径：**新发多少条** + 今天截止 + 3 天内截止。
 *
 * 为什么主指标是「新发」而不是「今天 N 场讲座」：场次只能从正文里抽，门户还被截断 200 字，
 * 抽不到的通知会被当成「没有」——那种「今天 0 场」比不显示更误导。新发条数是接口字段，算得准。
 */
export function todayDigest(cards: NoticeCard[], today = todayShanghai()): TodayDigest {
  const fresh = cards.filter((c) => calendarDay(c.publishedAt) === today);
  const happening = cards.filter((c) => calendarDay(c.eventStart) === today);
  const dueToday = cards.filter((c) => c.deadline === today);
  const dueSoon = dueCards(
    cards.filter((c) => c.deadline !== today),
    today,
    3,
  );
  const digest: Omit<TodayDigest, 'line'> = {
    today,
    fresh,
    happening,
    dueToday,
    dueSoon,
    byCategory: categoryCounts(fresh),
  };
  return { ...digest, line: describeToday(digest) };
}

export function describeToday(digest: Omit<TodayDigest, 'line'>): string {
  const parts: string[] = [];
  if (digest.fresh.length > 0) parts.push(`新发 ${digest.fresh.length} 条`);
  if (digest.dueToday.length > 0) parts.push(`${digest.dueToday.length} 个今天截止`);
  if (digest.dueSoon.length > 0) parts.push(`${digest.dueSoon.length} 个 3 天内截止`);
  return parts.length > 0 ? parts.join(' · ') : '今天没有新通知，也没有临近截止';
}

export interface RenderOptions {
  today?: string;
  keyword?: string;
  /** 最多列几条（默认全列） */
  max?: number;
}

/** 卡片 → 面板/聊天里的一行（P1 会换成真正的卡片组件，这里保证无 UI 时也能看）。 */
export function cardLine(card: NoticeCard, today = todayShanghai()): string {
  const when: string[] = [];
  if (card.eventStart) {
    when.push(`${card.eventStart.slice(5)}${card.eventTime ? ` ${card.eventTime}` : ''} 开讲`);
  }
  if (card.deadline) {
    const time = card.deadlineTime ? ` ${card.deadlineTime}` : '';
    when.push(`截止 ${card.deadline.slice(5)}${time}（${dueLabel(daysLeft(card, today))}）`);
  }
  const label = card.topicLabel ? `${card.categoryLabel}·${card.topicLabel}` : card.categoryLabel;
  const meta = [label, ...when, card.location, card.department].filter(Boolean).join(' · ');
  return `- **${card.title}**（${meta}）`;
}

export function renderCards(cards: NoticeCard[], opts: RenderOptions = {}): string {
  const today = opts.today ?? todayShanghai();
  if (cards.length === 0) return opts.keyword ? `没有匹配「${opts.keyword}」的通知。` : '没有通知。';
  const max = opts.max ?? cards.length;
  const rows = [opts.keyword ? `**「${opts.keyword}」的通知（${cards.length} 条）**` : `**通知（${cards.length} 条）**`, ''];
  for (const card of cards.slice(0, max)) rows.push(cardLine(card, today));
  if (cards.length > max) rows.push('', `…共 ${cards.length} 条，先列 ${max} 条。`);
  return rows.join('\n');
}
