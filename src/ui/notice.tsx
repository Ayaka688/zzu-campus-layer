/**
 * 通知卡片 UI（侧边栏与手机 PWA 共用）。
 *
 * 只做「展示 + 本地筛选」：数据由外面拉好传进来（扩展走 background 的 find_notices，
 * 手机直接 runTool），这样两边不会各写一套筛选/排序逻辑。
 * 样式类统一 `nb-` 前缀，两边的 style.css 里各有一段同样规则。
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  categoryCounts,
  daysLeft,
  dueLabel,
  filterCards,
  sortCards,
  splitByDeadline,
  type CardSort,
  type NoticeCard,
  type TodayDigest,
} from '../core/notice';
import { CATEGORY_LABEL, NOTICE_CATEGORIES, type NoticeCategory } from '../core/noticeRules';
import { subscribedCategories, type NoticePrefs } from '../core/noticeStore';
import { RichText } from './rich';

type Tab = 'all' | NoticeCategory;

/** 一屏先给多少条；点「加载更多」再加这么多。数据一次全拉回来了，翻页纯本地。 */
const PAGE_SIZE = 15;

/** 首页/侧边栏顶部那张「今日」卡：一行字，点进时间线。 */
export function NoticeTodayCard(props: { digest: TodayDigest | null; loading?: boolean; onOpen?: () => void }) {
  const line = props.digest ? props.digest.line : props.loading ? '正在拉通知…' : '还没有通知数据';
  return (
    <button class="nb-today" onClick={props.onOpen}>
      <span class="nb-today-k">今日</span>
      <span class="nb-today-line">{line}</span>
      <span class="nb-today-arrow">›</span>
    </button>
  );
}

export interface NoticeBoardProps {
  cards: NoticeCard[];
  digest: TodayDigest | null;
  prefs: NoticePrefs;
  today: string;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
  onRead?: (id: string) => void;
  onIcs?: (card: NoticeCard) => void;
  /** 勾选/取消一类订阅 */
  onToggleCategory?: (category: NoticeCategory) => void;
  /** 教务通知没有公开链接：拿到完整正文（纯文本）后在这里展开 */
  onDetail?: (card: NoticeCard) => Promise<string | null>;
  /** 从系统通知点进来时要定位到的卡片 id */
  focusId?: string;
}

export function NoticeBoard(props: NoticeBoardProps) {
  const { cards, prefs, today } = props;
  const [tab, setTab] = useState<Tab>('all');
  const [sort, setSort] = useState<CardSort>('published');
  const [keyword, setKeyword] = useState('');
  const [subsOpen, setSubsOpen] = useState(false);
  const [detail, setDetail] = useState<{ id: string; text: string } | null>(null);
  const [detailBusy, setDetailBusy] = useState('');
  const [detailError, setDetailError] = useState('');
  const [subsHint, setSubsHint] = useState('');
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [expiredOpen, setExpiredOpen] = useState(false);

  // 空数组 = 全订阅；这段判断收在 noticeStore 里，别在 UI 里再写一份
  const subscribed = subscribedCategories(prefs);
  const subsKey = subscribed.join(',');
  const counts = categoryCounts(cards);
  const countOf = (category: NoticeCategory) => counts.find((row) => row.category === category)?.count ?? 0;
  const readIds = new Set(prefs.readIds);

  const visible = useMemo(() => {
    const allowed = new Set<Tab>(subscribed);
    const scoped = cards.filter((card) => allowed.has(card.category));
    const inTab = tab === 'all' ? scoped : scoped.filter((card) => card.category === tab);
    const query = keyword.trim();
    // 有关键词就保持相关度排序（filterCards 里已经按命中分排过）
    if (query) return filterCards(inTab, { keyword: query, today });
    return sortCards(inTab, sort);
  }, [cards, tab, keyword, sort, today, subsKey]);

  const unread = cards.filter((card) => !readIds.has(card.id)).length;
  const { active, expired: expiredCards } = splitByDeadline(visible, today);
  const paged = active.slice(0, pageSize);
  const rest = active.length - paged.length;

  async function openDetail(card: NoticeCard): Promise<void> {
    if (!props.onDetail) return;
    if (detail?.id === card.id) {
      setDetail(null);
      return;
    }
    setDetailBusy(card.id);
    setDetailError('');
    try {
      const text = await props.onDetail(card);
      if (text) setDetail({ id: card.id, text });
      else setDetailError('没拿到正文，去教务系统看吧');
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailBusy('');
    }
  }

  // 从系统通知点进来：先把目标卡所在的那一页 / 那一组展开，再滚过去
  useEffect(() => {
    if (!props.focusId) return;
    const index = visible.findIndex((card) => card.id === props.focusId);
    if (index < 0) return;
    const card = visible[index];
    if (!card) return;
    const left = daysLeft(card, today);
    if (left !== undefined && left < 0) {
      setExpiredOpen(true);
      return;
    }
    if (index >= pageSize) setPageSize(index + 1);
  }, [props.focusId, visible, pageSize, today]);

  useEffect(() => {
    if (!props.focusId) return;
    document.getElementById(`nb-${props.focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [props.focusId, paged.length, expiredOpen]);

  const renderCard = (card: NoticeCard) => {
    const left = daysLeft(card, today);
    const soon = left !== undefined && left >= 0 && left <= 3;
    const isExpired = left !== undefined && left < 0;
    const read = readIds.has(card.id);
    const focused = props.focusId === card.id;
    return (
      <article
        id={`nb-${card.id}`}
        class={`nb-card${soon ? ' nb-soon' : ''}${isExpired ? ' nb-expired' : ''}${read ? ' nb-read' : ''}${
          focused ? ' nb-focus' : ''
        }`}
      >
        <div class="nb-card-top">
          <span class={`nb-cat nb-cat-${card.category}`}>{card.categoryLabel}</span>
          {card.topicLabel && <span class="nb-topic">{card.topicLabel}</span>}
          <span class="nb-title">{card.title}</span>
        </div>
        <div class="nb-meta">
          {card.sources.length > 1 && <span class="nb-src">双来源</span>}
          {card.eventStart && (
            <span>
              {card.eventStart.slice(5)}
              {card.eventTime ? ` ${card.eventTime}` : ''} 开讲
            </span>
          )}
          {card.deadline && (
            <span class={`nb-due${isExpired ? ' off' : soon ? ' hot' : ''}`}>
              截止 {card.deadline.slice(5)}
              {card.deadlineTime ?? ''}（{dueLabel(left)}）
            </span>
          )}
          {card.location && <span>{card.location}</span>}
          {card.department && <span>{card.department}</span>}
          {card.publishedAt && <span>{card.publishedAt.slice(5)} 发布</span>}
        </div>
        <div class="nb-actions">
          {card.url ? (
            <a class="nb-btn" href={card.url} target="_blank" rel="noreferrer">
              原文 ↗
            </a>
          ) : props.onDetail ? (
            <button class="nb-btn" onClick={() => void openDetail(card)} disabled={detailBusy === card.id}>
              {detail?.id === card.id ? '收起' : detailBusy === card.id ? '读取中…' : '读全文'}
            </button>
          ) : null}
          {props.onIcs && (
            <button class="nb-btn" onClick={() => props.onIcs!(card)}>
              加入日历
            </button>
          )}
          {props.onRead && !read && (
            <button class="nb-btn" onClick={() => props.onRead!(card.id)}>
              标为已读
            </button>
          )}
          {read && <span class="nb-readtag">已读</span>}
        </div>
        {detail?.id === card.id && (
          <div class="nb-detail">
            <RichText text={detail.text} />
          </div>
        )}
      </article>
    );
  };

  return (
    <div class="nb">
      <div class="nb-head">
        <span class="nb-head-title">通知</span>
        {unread > 0 && <span class="nb-unread">{unread} 条未读</span>}
        {props.onRefresh && (
          <button class="nb-mini" onClick={props.onRefresh} disabled={props.loading}>
            {props.loading ? '刷新中…' : '刷新'}
          </button>
        )}
      </div>

      {props.digest && <p class="nb-sum">{props.digest.line}</p>}
      {props.error && <p class="nb-error">{props.error}</p>}

      <div class="nb-tabs">
        <button
          class={`nb-tab${tab === 'all' ? ' on' : ''}`}
          onClick={() => {
            setTab('all');
            setPageSize(PAGE_SIZE);
          }}
        >
          全部
        </button>
        {subscribed.map((category) => (
          <button
            key={category}
            class={`nb-tab${tab === category ? ' on' : ''}`}
            onClick={() => {
              setTab(category);
              setPageSize(PAGE_SIZE);
            }}
          >
            {CATEGORY_LABEL[category]}
            {countOf(category) > 0 ? ` ${countOf(category)}` : ''}
          </button>
        ))}
      </div>

      <div class="nb-tools">
        <button
          class={`nb-tab${sort === 'published' ? ' on' : ''}`}
          onClick={() => {
            setSort('published');
            setPageSize(PAGE_SIZE);
          }}
        >
          按发布
        </button>
        <button
          class={`nb-tab${sort === 'deadline' ? ' on' : ''}`}
          onClick={() => {
            setSort('deadline');
            setPageSize(PAGE_SIZE);
          }}
        >
          按截止
        </button>
        <input
          class="nb-search"
          placeholder="搜「讲座」「挑战杯」「选课」…"
          value={keyword}
          onInput={(e) => {
            setKeyword((e.target as HTMLInputElement).value);
            setPageSize(PAGE_SIZE);
          }}
        />
        {props.onToggleCategory && (
          <button class="nb-tab" onClick={() => setSubsOpen((v) => !v)}>
            订阅
          </button>
        )}
      </div>

      {subsOpen && props.onToggleCategory && (
        <div class="nb-subs">
          {NOTICE_CATEGORIES.map((category) => {
            const checked = subscribed.includes(category);
            const onlyOne = subscribed.length === 1 && checked;
            return (
              <label key={category} class="nb-sub">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    if (onlyOne) {
                      setSubsHint('至少留一类；想全看就点上面的「全部」。');
                      return;
                    }
                    setSubsHint('');
                    props.onToggleCategory!(category);
                  }}
                />
                {CATEGORY_LABEL[category]}
              </label>
            );
          })}
          {subsHint && <p class="nb-hint warn">{subsHint}</p>}
          <p class="nb-hint">勾选后只看这几类（至少留一类）；日历与提醒跟着订阅走。</p>
        </div>
      )}

      {visible.length === 0 && (
        <p class="nb-empty">
          {props.loading
            ? '正在拉通知…'
            : keyword.trim()
              ? `没有匹配「${keyword.trim()}」的通知。`
              : cards.length === 0
                ? '还没有通知：先登录一次教务或门户，再回来点刷新。'
                : '这个分类下暂时没有通知。'}
        </p>
      )}

      {detailError && <p class="nb-error">{detailError}</p>}

      <div class="nb-list">{paged.map(renderCard)}</div>

      {rest > 0 && (
        <button class="nb-tab nb-more" onClick={() => setPageSize((n) => n + PAGE_SIZE)}>
          加载更多（还有 {rest} 条）
        </button>
      )}

      {/* 已截止的折到底部：它们不会「错过」，但会把「按截止」排序的列表顶满 */}
      {expiredCards.length > 0 && (
        <div class="nb-expired-wrap">
          <button class="nb-tab nb-expired-toggle" onClick={() => setExpiredOpen((v) => !v)}>
            {expiredOpen ? '收起已截止' : `已截止（${expiredCards.length}）`}
          </button>
          {expiredOpen && <div class="nb-list">{expiredCards.map(renderCard)}</div>}
        </div>
      )}
    </div>
  );
}
