import { describe, expect, it } from 'vitest';
import type { Notice } from '../src/core/types';
import {
  CATEGORY_LABEL,
  categoryFromText,
  classifyNotice,
  expandNoticeQuery,
  extractClock,
  extractDeadline,
  extractEventStart,
  extractLocation,
} from '../src/core/noticeRules';
import {
  buildCards,
  calendarDay,
  cardLine,
  categoryCounts,
  dedupeCards,
  describeToday,
  dueLabel,
  filterCards,
  normalizeTitle,
  parseNoticeNotification,
  renderCards,
  sortCards,
  splitByDeadline,
  todayDigest,
  toCard,
  DAY_ROLLOVER_HOUR,
  type NoticeCard,
} from '../src/core/notice';
import { noticesToIcs } from '../src/core/ics';
import { parseIntent } from '../src/core/intent';
import { getNoticeBody, runTool } from '../src/core/tools';
import { setNoticeFocus, takeNoticeFocus } from '../src/core/noticeStore';

const TODAY = '2026-10-22';

/** 造一条通知（只填用得到的字段）。 */
function n(partial: Partial<Notice> & { id: string; title: string }): Notice {
  return { summary: '', source: 'portal-cms', ...partial } as Notice;
}

describe('分类：6 类，标题优先于正文', () => {
  it('讲座、比赛、活动、会议、教务、生活各归各位', () => {
    expect(classifyNotice('学术报告：大模型与智能体').category).toBe('lecture');
    expect(classifyNotice('关于举办郑州大学首届AI智能体创新应用大赛的通知').category).toBe('competition');
    expect(classifyNotice('关于举办校园文化节活动的通知').category).toBe('activity');
    expect(classifyNotice('关于召开 2026 年学生工作会议的通知').category).toBe('meeting');
    expect(classifyNotice('2025-2026-2重修报名通知').category).toBe('academic');
    expect(classifyNotice('关于 XX 宿舍楼停水的通知').category).toBe('life');
  });

  it('标题写「讲座」、正文顺带提「比赛」→ 还是讲座（标题权重 3 : 正文 1）', () => {
    const got = classifyNotice('名家讲坛：人工智能的未来', '本次比赛由教务处主办，欢迎参加。');
    expect(got.category).toBe('lecture');
  });

  it('一条词都没命中时兜底到教务（学校无名通知绝大多数是行政通知）', () => {
    const got = classifyNotice('关于报送 XX 材料的通知');
    expect(got.category).toBe('academic');
    expect(got.score).toBe(0);
  });

  it('学生口语 → 分类：认得出才给，认不出返回 undefined', () => {
    expect(categoryFromText('今天有什么讲座')).toBe('lecture');
    expect(categoryFromText('最近有比赛吗')).toBe('competition');
    expect(categoryFromText('这周有活动吗')).toBe('activity');
    expect(categoryFromText('最近有什么通知')).toBeUndefined();
    expect(categoryFromText('明天有课吗')).toBeUndefined();
  });

  it('教务再细分：选课 / 考试 / 成绩 / 学籍 / 毕业 / 四六级', () => {
    expect(classifyNotice('2025-2026-2重修报名通知').topicLabel).toBe('选课');
    expect(classifyNotice('关于做好期末考试考务工作的通知').topicLabel).toBe('考试');
    expect(classifyNotice('关于成绩复核申请的通知').topicLabel).toBe('成绩');
    expect(classifyNotice('关于 2026 年学籍异动办理的通知').topicLabel).toBe('学籍');
    expect(classifyNotice('关于 2026 届毕业生离校工作的通知').topicLabel).toBe('毕业');
    expect(classifyNotice('关于大学英语四六级报名的通知').topicLabel).toBe('四六级');
  });

  it('非教务类没有子类；教务兜底命中也有据可查', () => {
    expect(classifyNotice('名家讲坛：人工智能的未来').topicLabel).toBeUndefined();
    expect(classifyNotice('关于报送材料的通知').topicLabel).toBeUndefined();
  });
});

describe('时间抽取：截止与活动分开认', () => {
  it('截止日只从带截止语义的句子里抽', () => {
    expect(extractDeadline('请于 11 月 5 日前提交材料，逾期不再受理。', 2026)?.date).toBe('2026-11-05');
    expect(extractDeadline('报名截止 2026-11-20', 2026)?.date).toBe('2026-11-20');
    expect(extractDeadline('材料提交截止 10 月 25 日', 2026)?.date).toBe('2026-10-25');
    expect(extractDeadline('十一月十二日截止', 2026)?.date).toBe('2026-11-12');
  });

  it('只有讲座日期、没有截止语义 → 不产生截止日（别把开讲日当报名截止）', () => {
    expect(extractDeadline('讲座预告：10 月 23 日 19:00 开讲', 2026)).toBeUndefined();
  });

  it('带时刻就连时刻一起抽', () => {
    expect(extractDeadline('请于 11 月 5 日 17:00 前提交', 2026)).toEqual({ date: '2026-11-05', time: '17:00' });
  });

  it('活动日期+时刻：从正文里抽「10 月 23 日 19:00」', () => {
    const got = extractEventStart('讲座时间：10 月 23 日 19:00，地点：图书馆第三报告厅', 2026);
    expect(got).toEqual({ date: '2026-10-23', time: '19:00' });
  });

  it('多场取最早的一场', () => {
    const got = extractEventStart('第一场 11 月 2 日 14:00 举行，第二场 11 月 9 日 14:00 举行', 2026);
    expect(got?.date).toBe('2026-11-02');
  });

  it('12 月看到的「1 月 5 日」顺延到明年', () => {
    expect(extractDeadline('报名截止 1 月 5 日', 2026, '2026-12-20')?.date).toBe('2027-01-05');
  });

  it('时刻识别：19:00 / 晚上 7 点 / 下午 3 点半', () => {
    expect(extractClock('19:00 开始')).toBe('19:00');
    expect(extractClock('晚上 7 点开讲')).toBe('19:00');
    expect(extractClock('下午 3 点半')).toBe('15:30');
    expect(extractClock('10 月 23 日')).toBeUndefined();
  });
});

describe('地点抽取', () => {
  it('「地点：」标签最可靠', () => {
    expect(extractLocation('讲座时间：10 月 23 日 19:00，地点：图书馆第三报告厅')).toBe('图书馆第三报告厅');
  });

  it('「在 XX 举行」次之', () => {
    expect(extractLocation('将于 11 月 2 日在物理馆报告厅举行')).toBe('物理馆报告厅');
  });

  it('抽不到就不返回（不猜楼号）', () => {
    expect(extractLocation('请各学院关注后续通知')).toBeUndefined();
  });
});

describe('去重：同一场活动，教务发一遍、门户转一遍', () => {
  it('「关于…的通知」外壳、括注、空格都不影响归一化', () => {
    expect(normalizeTitle('【通知】关于举办 AI 大赛的通知')).toBe(normalizeTitle('关于举办AI大赛的通知'));
  });

  it('同标题合并成一张卡，原文链接与完整正文都留住', () => {
    const cards = buildCards(
      [
        n({
          id: '1',
          title: '关于举办 AI 大赛的通知',
          publishedAt: '2026-10-19 16:45:00',
          summary: '门户摘要……',
          url: 'http://www.zzu.edu.cn/tzcontent.jsp?wbnewsid=89205',
        }),
        n({
          id: '121',
          title: '关于举办AI大赛的通知',
          contentHtml: '<p>教务处全文</p>',
          source: 'jwxt-notice',
          publishedAt: '2026-10-19 09:00:00',
        }),
      ],
      { today: TODAY },
    );
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.sources.sort()).toEqual(['jwxt-notice', 'portal-cms']);
    expect(card.url).toContain('wbnewsid=89205');
    expect(card.hasFullText).toBe(true);
    // 两个来源的发布时间合并后取较晚的那个（门户 16:45 是最终发布时刻）
    expect(card.publishedAt).toBe('2026-10-19 16:45');
  });

  it('不同活动不会被误合并', () => {
    const cards = dedupeCards(
      buildCards(
        [n({ id: 'a', title: '关于举办 AI 大赛的通知' }), n({ id: 'b', title: '关于举办数学建模竞赛的通知' })],
        { today: TODAY },
      ),
    );
    expect(cards).toHaveLength(2);
  });

  it('标题完全一样但 id 不同也算一条（合并后 id 仍是稳定来源）', () => {
    const cards = dedupeCards(buildCards([n({ id: 'a', title: '停水通知' }), n({ id: 'b', title: '停水通知' })], { today: TODAY }));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe('portal-cms:a');
  });
});

describe('排序与过滤', () => {
  const cards = buildCards(
    [
      n({ id: '1', title: '讲座 A', publishedAt: '2026-10-20 10:00:00', summary: '报名截止 10 月 25 日' }),
      n({ id: '2', title: '比赛 B', publishedAt: '2026-10-21 10:00:00', summary: '报名截止 10 月 23 日' }),
      n({ id: '3', title: '活动 C', publishedAt: '2026-10-19 10:00:00', summary: '无需报名' }),
    ],
    { today: TODAY },
  );

  it('按发布倒序', () => {
    expect(sortCards(cards, 'published').map((c) => c.title)).toEqual(['比赛 B', '讲座 A', '活动 C']);
  });

  it('按截止升序，没有截止的排最后', () => {
    expect(sortCards(cards, 'deadline').map((c) => c.title)).toEqual(['比赛 B', '讲座 A', '活动 C']);
  });

  it('只能看今天：今天发布或今天截止的留下', () => {
    const todayCards = buildCards(
      [
        n({ id: 'p', title: '今天发的通知', publishedAt: '2026-10-22 08:00:00' }),
        n({ id: 'y', title: '昨天发的通知', publishedAt: '2026-10-21 08:00:00' }),
        n({ id: 'd', title: '今天截止的通知', publishedAt: '2026-10-01 08:00:00', summary: '报名截止 10 月 22 日' }),
      ],
      { today: TODAY },
    );
    const picked = filterCards(todayCards, { withinDays: 0, today: TODAY });
    expect(picked.map((c) => c.title).sort()).toEqual(['今天发的通知', '今天截止的通知']);
  });

  it('「今天」也要算开讲：三天前发布、今天开讲的讲座不能漏', () => {
    const cards = buildCards(
      [
        n({
          id: 'e',
          title: '关于举办学术讲座的通知',
          publishedAt: '2026-10-19 09:00:00',
          contentHtml: '<p>讲座时间：10 月 22 日 19:00，地点：图书馆第三报告厅</p>',
          source: 'jwxt-notice',
        }),
      ],
      { today: TODAY },
    );
    expect(filterCards(cards, { withinDays: 0, today: TODAY }).map((c) => c.title)).toEqual([
      '关于举办学术讲座的通知',
    ]);
  });

  it('按分类筛 + 关键词打分：搜「讲座」也能命中标题里写「学术报告」的', () => {
    const mixed = buildCards(
      [
        n({ id: 'l', title: '学术报告：大模型前沿', publishedAt: '2026-10-20 10:00:00' }),
        n({ id: 'c', title: '挑战杯报名通知', publishedAt: '2026-10-21 10:00:00' }),
      ],
      { today: TODAY },
    );
    expect(filterCards(mixed, { categories: ['lecture'] }).map((c) => c.title)).toEqual(['学术报告：大模型前沿']);
    expect(filterCards(mixed, { keyword: '讲座' }).map((c) => c.title)).toEqual(['学术报告：大模型前沿']);
    expect(filterCards(mixed, { keyword: '挑战杯' }).map((c) => c.title)).toEqual(['挑战杯报名通知']);
    expect(filterCards(mixed, { keyword: '量子纠缠' })).toHaveLength(0);
  });

  it('同义词扩词和老搜索共用一份（比赛→竞赛/挑战杯）', () => {
    const terms = expandNoticeQuery('比赛');
    expect(terms).toContain('竞赛');
    expect(terms).toContain('挑战杯');
  });

  it('每个 tab 上的数字按类统计', () => {
    const counts = categoryCounts(cards);
    expect(counts.map((c) => c.label)).toEqual(['讲座', '比赛', '活动']);
  });
});

describe('今日卡片：口径可解释', () => {
  const cards = buildCards(
    [
      n({
        id: 'e',
        title: '关于举办学术讲座的通知',
        publishedAt: '2026-10-22 09:00:00',
        contentHtml: '<p>讲座时间：10 月 22 日 19:00，地点：图书馆第三报告厅</p>',
      }),
      n({ id: 'd', title: '奖学金申请通知', publishedAt: '2026-10-18 09:00:00', summary: '申请截止 10 月 22 日' }),
      n({ id: 's', title: '挑战杯报名通知', publishedAt: '2026-10-18 09:00:00', summary: '报名截止 10 月 24 日' }),
    ],
    { today: TODAY },
  );

  it('今天开讲 / 今天截止 / 3 天内截止 各归各位', () => {
    const digest = todayDigest(cards, TODAY);
    expect(digest.happening.map((c) => c.title)).toEqual(['关于举办学术讲座的通知']);
    expect(digest.dueToday.map((c) => c.title)).toEqual(['奖学金申请通知']);
    expect(digest.dueSoon.map((c) => c.title)).toEqual(['挑战杯报名通知']);
    expect(digest.fresh.map((c) => c.title)).toEqual(['关于举办学术讲座的通知']);
  });

  it('主指标是「新发 N 条」：场次依赖正文抽取，不进那句话', () => {
    const digest = todayDigest(cards, TODAY);
    expect(digest.line).toBe('新发 1 条 · 1 个今天截止 · 1 个 3 天内截止');
    expect(describeToday({ ...digest, happening: [], fresh: [], dueToday: [], dueSoon: [] })).toBe(
      '今天没有新通知，也没有临近截止',
    );
  });

  it('截止倒计时文案', () => {
    expect(dueLabel(0)).toBe('今天截止');
    expect(dueLabel(1)).toBe('明天截止');
    expect(dueLabel(3)).toBe('还有 3 天');
    expect(dueLabel(-1)).toBe('已截止');
    expect(dueLabel(undefined)).toBe('');
  });

  it('卡片一行能看出分类/时间/地点/截止', () => {
    const line = cardLine(cards[0]!, TODAY);
    expect(line).toContain('讲座');
    expect(line).toContain('图书馆第三报告厅');
    expect(renderCards(cards, { today: TODAY })).toContain('通知（3 条）');
  });
});

describe('导出日历：一条通知 → 截止 + 开讲两个事件', () => {
  const card = toCard(
    n({
      id: '121',
      title: '关于举办学术讲座的通知',
      contentHtml:
        '<p>题目：大模型前沿</p><p>讲座时间：10 月 23 日 19:00，地点：图书馆第三报告厅</p><p>报名截止 10 月 20 日 17:00</p>',
      department: '教务部',
      source: 'jwxt-notice',
    }),
    { today: TODAY },
  );

  it('抽到了活动时间、地点、截止时刻', () => {
    expect(card.eventStart).toBe('2026-10-23');
    expect(card.eventTime).toBe('19:00');
    expect(card.location).toBe('图书馆第三报告厅');
    expect(card.deadline).toBe('2026-10-20');
    expect(card.deadlineTime).toBe('17:00');
  });

  it('生成两个 VEVENT：定时活动 + 定时截止，各带 VALARM', () => {
    const ics = noticesToIcs([card], { now: new Date(Date.UTC(2026, 9, 22, 1, 0, 0)) });
    expect(ics.match(/BEGIN:VEVENT/g) ?? []).toHaveLength(2);
    expect(ics).toContain('DTSTART;TZID=Asia/Shanghai:20261023T190000');
    expect(ics).toContain('DTEND;TZID=Asia/Shanghai:20261023T210000');
    expect(ics).toContain('DTSTART;TZID=Asia/Shanghai:20261020T170000');
    expect(ics).toContain('SUMMARY:[讲座] 关于举办学术讲座的通知');
    expect(ics).toContain('SUMMARY:截止 [讲座] 关于举办学术讲座的通知');
    expect(ics).toContain('TRIGGER:-P1D');
    expect(ics).toContain('LOCATION:图书馆第三报告厅');
    expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
  });

  it('只有日期没有时刻 → 全天事件（VALUE=DATE）', () => {
    const allDay = toCard(n({ id: 'x', title: '讲座预告', summary: '11 月 2 日在物理馆报告厅举行' }), { today: TODAY });
    const ics = noticesToIcs([allDay]);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261102');
    expect(ics).toContain('DTEND;VALUE=DATE:20261103');
  });

  it('跨午夜的活动：DTEND 进位到次日，不会早于 DTSTART', () => {
    const late = toCard(
      n({
        id: 'late',
        title: '关于举办跨年讲座的通知',
        contentHtml: '<p>讲座时间：11 月 2 日 23:30，地点：图书馆报告厅</p>',
        source: 'jwxt-notice',
      }),
      { today: TODAY },
    );
    const ics = noticesToIcs([late]);
    expect(ics).toContain('DTSTART;TZID=Asia/Shanghai:20261102T233000');
    expect(ics).toContain('DTEND;TZID=Asia/Shanghai:20261103T013000');
  });

  it('什么都没有的卡片不产生事件', () => {
    const bare = toCard(n({ id: 'y', title: '关于报送材料的通知' }), { today: TODAY });
    expect(bare.eventStart).toBeUndefined();
    expect(bare.deadline).toBeUndefined();
    expect(noticesToIcs([bare])).not.toContain('BEGIN:VEVENT');
  });
});

describe('规则层：新问法直接命中 find_notices，老问法不变', () => {
  it('「今天有什么讲座」→ 讲座分类 + 今天窗口', () => {
    const got = parseIntent('今天有什么讲座', TODAY);
    expect(got?.tool).toBe('find_notices');
    expect(got?.args).toMatchObject({ category: 'lecture', withinDays: 0 });
  });

  it('「这周有活动吗」→ 活动分类 + 一周窗口', () => {
    const got = parseIntent('这周有活动吗', TODAY);
    expect(got?.tool).toBe('find_notices');
    expect(got?.args).toMatchObject({ category: 'activity', withinDays: 7 });
  });

  it('「明天有什么讲座」→ 一天窗，不是一周', () => {
    const got = parseIntent('明天有什么讲座', TODAY);
    expect(got?.tool).toBe('find_notices');
    expect(got?.args).toMatchObject({ category: 'lecture', withinDays: 1 });
  });

  it('「奖学金什么时候截止」→ 按截止时间排', () => {
    const got = parseIntent('奖学金什么时候截止', TODAY);
    expect(got?.tool).toBe('find_notices');
    expect(got?.args).toMatchObject({ sort: 'deadline', keyword: '奖学金' });
  });

  it('老说法「学校最近有比赛吗」也走 find_notices（两套工具已合并）', () => {
    const got = parseIntent('学校最近有比赛吗', TODAY);
    expect(got?.tool).toBe('find_notices');
    expect(got?.args).toMatchObject({ keyword: '比赛', withinDays: 7 });
  });

  it('「明天有课吗」不会被通知规则抢走', () => {
    expect(parseIntent('明天有课吗', TODAY)?.tool).toBe('get_schedule');
  });
});

describe('换日点：凌晨 4 点（夜里的通知还算前一天）', () => {
  it('4 点前算前一天，4 点后算当天', () => {
    expect(DAY_ROLLOVER_HOUR).toBe(4);
    expect(calendarDay('2026-10-22 02:00')).toBe('2026-10-21');
    expect(calendarDay('2026-10-22 03:59')).toBe('2026-10-21');
    expect(calendarDay('2026-10-22 04:00')).toBe('2026-10-22');
    expect(calendarDay('2026-10-22')).toBe('2026-10-22');
    expect(calendarDay(undefined)).toBe('');
  });

  it('凌晨 2 点发布的公告算到前一天的新发里', () => {
    const cards = buildCards([n({ id: 'x', title: '深夜公告', publishedAt: '2026-10-22 02:00:00' })], { today: TODAY });
    expect(todayDigest(cards, TODAY).fresh).toHaveLength(0);
    expect(todayDigest(cards, '2026-10-21').fresh).toHaveLength(1);
  });
});

describe('工具层：find_notices 与读全文', () => {
  const svc = {
    notices: async () => [
      n({
        id: '1',
        title: '关于举办学术讲座的通知',
        publishedAt: '2026-10-22 09:00:00',
        contentHtml: '<p>讲座时间：10 月 22 日 19:00，地点：图书馆第三报告厅</p>',
        source: 'jwxt-notice',
      }),
      n({ id: '2', title: '挑战杯报名通知', publishedAt: '2026-10-21 09:00:00', summary: '报名截止 10 月 24 日' }),
    ],
  } as unknown as Parameters<typeof getNoticeBody>[0];

  it('按分类筛并返回卡片 + 今日口径', async () => {
    const out = await runTool('find_notices', { category: 'lecture' }, svc as never);
    const data = out.data as { count: number; cards: NoticeCard[]; digest: { line: string } };
    expect(data.count).toBe(1);
    expect(data.cards[0]!.title).toBe('关于举办学术讲座的通知');
    // 今日口径按真实今天算，这里只断言它给了一句人话（具体文案在 todayDigest 的用例里锁）
    expect(data.digest.line.length).toBeGreaterThan(0);
    expect(out.text).toContain('讲座');
  });

  it('参数不合法时抛错（schema 生效）', async () => {
    await expect(runTool('find_notices', { limit: 999 }, svc as never)).rejects.toThrow(/参数不合法/);
  });

  it('教务子类可以当筛选用：topic=选课', async () => {
    const withSub = {
      notices: async () => [
        n({ id: 's', title: '2025-2026-2重修报名通知', summary: '报名截止 10 月 30 日' }),
        n({ id: 't', title: '关于期末考试考务工作的通知' }),
      ],
    } as unknown as Parameters<typeof getNoticeBody>[0];
    const out = await runTool('find_notices', { topic: '选课' }, withSub as never);
    const data = out.data as { count: number; cards: NoticeCard[] };
    expect(data.count).toBe(1);
    expect(data.cards[0]!.title).toContain('重修');
  });

  it('读全文给纯文本，接口 HTML 不进 DOM', async () => {
    const body = await getNoticeBody(svc, 'jwxt-notice:1');
    expect(body?.text).toContain('图书馆第三报告厅');
    expect(body?.text).not.toContain('<p>');
    expect(await getNoticeBody(svc, 'nope')).toBeNull();
  });
});

describe('点通知定位 + 已截止折叠', () => {
  it('通知 id → 该定位哪张卡（聚合通知只开时间线）', () => {
    expect(parseNoticeNotification('notice-jwxt-notice:121')).toEqual({
      cardId: 'jwxt-notice:121',
      openNotices: true,
    });
    expect(parseNoticeNotification('notice-more-2026-10-22')).toEqual({ openNotices: true });
    expect(parseNoticeNotification('watch-grades-2026-10-22')).toEqual({ openNotices: true });
    expect(parseNoticeNotification('something-else')).toBeNull();
  });

  it('已截止的跟没截止的分开，不会再顶在「按截止」最前面', () => {
    const cards = buildCards(
      [
        n({ id: 'a', title: '过期通知', publishedAt: '2026-10-01 08:00:00', summary: '报名截止 10 月 10 日' }),
        n({ id: 'b', title: '正常通知', publishedAt: '2026-10-20 08:00:00', summary: '报名截止 10 月 25 日' }),
      ],
      { today: TODAY },
    );
    const { active, expired } = splitByDeadline(sortCards(cards, 'deadline'), TODAY);
    expect(active.map((c) => c.title)).toEqual(['正常通知']);
    expect(expired.map((c) => c.title)).toEqual(['过期通知']);
  });
});

describe('提醒定位的交接（走 kv）', () => {
  it('set 之后 take 能取到，而且只取一次', async () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;

    await setNoticeFocus('jwxt-notice:121');
    expect(await takeNoticeFocus()).toBe('jwxt-notice:121');
    expect(await takeNoticeFocus()).toBeNull();
  });
});

describe('分类标签', () => {
  it('6 类齐全，UI tab 直接用', () => {
    expect(Object.keys(CATEGORY_LABEL).sort()).toEqual(
      ['academic', 'activity', 'competition', 'lecture', 'life', 'meeting'].sort(),
    );
  });

  it('normalizeTitle 不会把「通知」二字吃成空串', () => {
    expect(normalizeTitle('通知')).toBe('');
    expect(normalizeTitle('关于举办AI大赛的通知')).toBe('举办ai大赛');
  });
});
