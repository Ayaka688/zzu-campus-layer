/**
 * 通知的分类与「时间/地点/截止」抽取规则。
 *
 * 为什么单独一个文件：这些是**词表和正则**，改得最频繁（换个学期、新赛事、新叫法），
 * 而 notice.ts 里的流程（去重/排序/聚合）不该跟着动。
 *
 * 先记住实测数据长什么样（test/fixtures/portal-notices.json、jwxt-notices.json）：
 * - 门户 CMS 的 `content` 被服务端截断在 200 字，日期/地点经常落在截断之外；
 * - 教务处 `content` 是完整 HTML（`contentHtml`），是唯一能抽到准确时间的来源；
 * - 两边都**没有**「活动开始时间」「报名截止」这样的结构化字段，只能从标题+正文里抽。
 * 所以抽取结果一律当「线索」用：抽不到就不显示，绝不猜一个时间出来。
 */
import { daysBetween, extractDueDates } from './watch';

export type NoticeCategory = 'lecture' | 'competition' | 'activity' | 'meeting' | 'academic' | 'life';

/** 展示顺序 = tab 顺序。6 类，跟方案里的「6 类通知」对齐。 */
export const NOTICE_CATEGORIES: NoticeCategory[] = [
  'lecture',
  'competition',
  'activity',
  'meeting',
  'academic',
  'life',
];

export const CATEGORY_LABEL: Record<NoticeCategory, string> = {
  lecture: '讲座',
  competition: '比赛',
  activity: '活动',
  meeting: '会议',
  academic: '教务',
  life: '生活',
};

export interface CategoryRule {
  id: NoticeCategory;
  words: string[];
}

/**
 * 分类词表：**数组顺序即优先级**，命中分相同时取靠前的。
 *
 * 打分：标题命中 +3，正文命中 +1。原因是标题是编辑给这条通知定的「身份」，
 * 正文里可能顺带提一句别的（讲座通知里写「本次比赛由教务处主办」不该归到比赛）。
 */
export const CATEGORY_RULES: CategoryRule[] = [
  {
    id: 'lecture',
    words: ['讲座', '学术报告', '报告会', '学术沙龙', '名家讲坛', '讲坛', '论坛', '宣讲会', '学术报告会'],
  },
  {
    id: 'competition',
    words: [
      '比赛',
      '竞赛',
      '大赛',
      '挑战杯',
      '创新创业',
      '选拔赛',
      '赛区',
      '赛事',
      '数学建模',
      '互联网+',
      '评选',
      '评奖',
      '评优',
    ],
  },
  {
    id: 'meeting',
    words: ['会议', '座谈会', '研讨会', '工作会', '部署会', '例会', '表彰大会', '代表大会', '大会'],
  },
  {
    id: 'academic',
    words: [
      '选课',
      '退课',
      '重修',
      '补考',
      '缓考',
      '考试',
      '考场',
      '成绩',
      '学分',
      '培养方案',
      '毕业',
      '学籍',
      '注册',
      '报到',
      '放假',
      '开学',
      '调课',
      '停课',
      '实习',
      '论文',
      '答辩',
      '四六级',
      'CET',
      '课程',
      '教学',
      '毕业设计',
    ],
  },
  {
    id: 'life',
    words: [
      '食堂',
      '宿舍',
      '公寓',
      '停水',
      '停电',
      '维修',
      '报修',
      '校车',
      '快递',
      '医疗',
      '医保',
      '体检',
      '一卡通',
      '图书馆',
      '场馆',
      '洗浴',
      '热水',
      '校园网',
      '网络安全',
      '安保',
      '消防',
      '餐饮',
    ],
  },
  {
    // 最泛的一类，放最后：只有前面都没命中、且确实像「活动」时才归到这里
    id: 'activity',
    words: [
      '活动',
      '晚会',
      '演出',
      '文艺',
      '运动会',
      '社团',
      '志愿服务',
      '志愿',
      '迎新',
      '文化节',
      '艺术节',
      '游园',
      '嘉年华',
      '社会实践',
      '心理',
      '读书',
      '观影',
      '展览',
    ],
  },
];

export interface ClassifyResult {
  category: NoticeCategory;
  /** 命中的词（调试与「为什么算这一类」用） */
  hits: string[];
  score: number;
  /** 教务类还会细到一个子类（选课/考试/成绩/…），非教务没有 */
  topic?: AcademicTopic;
  topicLabel?: string;
}

/** 教务细分：六类里的「教务」太笼统，学生真正找的是「选课」「考试」「成绩」这些。 */
export type AcademicTopic =
  | 'course'
  | 'exam'
  | 'grade'
  | 'status'
  | 'graduate'
  | 'thesis'
  | 'practice'
  | 'plan'
  | 'cet'
  | 'teaching';

export interface TopicRule {
  id: AcademicTopic;
  label: string;
  words: string[];
}

/** 顺序即优先级（分数相同取靠前的）；标题命中 +2、正文命中 +1。 */
export const ACADEMIC_TOPICS: TopicRule[] = [
  { id: 'course', label: '选课', words: ['选课', '退课', '重修', '补选', '改选', '预选'] },
  { id: 'exam', label: '考试', words: ['考试', '考场', '监考', '补考', '缓考', '重考', '期中考', '期末考'] },
  { id: 'grade', label: '成绩', words: ['成绩', '绩点', '查分', '成绩单', '分数复核'] },
  { id: 'status', label: '学籍', words: ['学籍', '注册', '休学', '复学', '转专业', '退学', '异动'] },
  { id: 'graduate', label: '毕业', words: ['毕业', '学位', '结业', '离校'] },
  { id: 'thesis', label: '论文', words: ['论文', '开题', '查重', '送审', '盲审'] },
  { id: 'practice', label: '实习实践', words: ['实习', '实训', '实验课', '社会实践'] },
  { id: 'plan', label: '培养方案', words: ['培养方案', '学分', '教学计划', '课程设置'] },
  { id: 'cet', label: '四六级', words: ['四六级', 'CET', '英语等级考试'] },
  { id: 'teaching', label: '教学', words: ['调课', '停课', '补课', '教学', '评教', '教学质量'] },
];

/** 教务子类：只在卡片被判成「教务」之后才用，避免把讲座通知分到「教学」。 */
export function academicTopic(
  title: string,
  body = '',
): { id: AcademicTopic; label: string; score: number } | undefined {
  let best: { id: AcademicTopic; label: string; score: number } | undefined;
  for (const rule of ACADEMIC_TOPICS) {
    let score = 0;
    for (const word of rule.words) {
      if (title.includes(word)) score += 2;
      else if (body.includes(word)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { id: rule.id, label: rule.label, score };
  }
  return best;
}

/**
 * 归到 6 类里的哪一类。
 * 一条都没命中时归 `academic`：学校发出来的无名通知绝大多数是教务处/职能部门的行政通知，
 * 这个兜底比硬造一个「其他」更符合学生找东西的直觉（要改就改这里，别改 notice.ts）。
 */
export function classifyNotice(title: string, body = ''): ClassifyResult {
  let best: ClassifyResult = { category: 'academic', hits: [], score: 0 };
  for (const rule of CATEGORY_RULES) {
    let score = 0;
    const hits: string[] = [];
    for (const word of rule.words) {
      if (title.includes(word)) {
        score += 3;
        hits.push(word);
      } else if (body.includes(word)) {
        score += 1;
        hits.push(word);
      }
    }
    if (score > best.score) best = { category: rule.id, hits, score };
  }
  if (best.category === 'academic') {
    const topic = academicTopic(title, body);
    if (topic) return { ...best, topic: topic.id, topicLabel: topic.label };
  }
  return best;
}

/**
 * 「讲座」是不是讲的话里在说哪一类通知。
 * 跟 classifyNotice 分开：那个看的是学校写的标题，这个看的是学生自己说的话。
 */
export function categoryFromText(text: string): NoticeCategory | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (/讲座|报告会|学术报告|讲坛|沙龙/.test(t)) return 'lecture';
  if (/比赛|竞赛|大赛|挑战杯|赛事/.test(t)) return 'competition';
  if (/会议|开会|座谈|研讨|工作会/.test(t)) return 'meeting';
  if (/活动|晚会|演出|社团|志愿|运动会/.test(t)) return 'activity';
  if (/教务|选课|重修|考试|学分|成绩|放假|开学|报到/.test(t)) return 'academic';
  if (/生活|食堂|宿舍|停水|停电|维修|校车|快递|体检/.test(t)) return 'life';
  return undefined;
}

export interface SynonymRule {
  test: RegExp;
  expand: string[];
}

/**
 * 关键词 → 同义词组。学生说「有比赛吗」时，通知标题里写的是「创新创业大赛」「学科竞赛」，
 * 直接 includes 匹配必然 0 条（这是实测踩过的坑）。
 *
 * 从 tools.ts 搬过来的，老搜索（search_notice）和新的卡片搜索（find_notices）共用一份，
 * 免得两边扩词不一致、同一个问题两个答案。
 */
export const NOTICE_SYNONYMS: SynonymRule[] = [
  { test: /比赛|竞赛|赛事|大赛/, expand: ['比赛', '竞赛', '大赛', '挑战杯', '创新创业', '选拔', '赛区', '选拔赛'] },
  { test: /奖助|奖学金|助学金|评奖|评优/, expand: ['奖学金', '助学金', '评奖', '评优', '资助', '困难'] },
  { test: /实习|就业|招聘|求职/, expand: ['实习', '就业', '招聘', '双选', '宣讲'] },
  { test: /重修|补考|挂科|清考/, expand: ['重修', '补考', '重考'] },
  { test: /选课|退课|选课/, expand: ['选课', '退课', '选课通知'] },
  { test: /四六级|英语四六级|CET/i, expand: ['四六级', 'CET', '英语'] },
  { test: /党课|党员|团|团员/, expand: ['党课', '党员', '团员', '团课'] },
  { test: /讲座|报告|论坛|学术/, expand: ['讲座', '学术报告', '报告会', '论坛', '讲坛', '沙龙'] },
  { test: /考试|考场|监考/, expand: ['考试', '考场', '监考'] },
  { test: /放假|假期|开学|报到/, expand: ['放假', '假期', '开学', '报到'] },
  { test: /活动|晚会|演出|社团/, expand: ['活动', '晚会', '演出', '社团', '文化节', '艺术节'] },
  { test: /会议|开会|座谈|研讨/, expand: ['会议', '座谈会', '研讨会', '工作会', '部署会'] },
];

/**
 * 口语 → 一组能拿去匹配标题的词。
 * 中文没有空格分词，整句只取 2–6 字的片段做补充词，避免把「学校最近有比赛吗」整个当关键词。
 */
export function expandNoticeQuery(query?: string): string[] {
  const q = (query ?? '').trim();
  if (!q) return [];
  const terms = new Set<string>([q]);
  const cleaned = q.replace(/[有吗呢啊？?。，,、\s]|学校|最近|这个|那个|上的|里的/g, '');
  if (cleaned.length >= 2) terms.add(cleaned);
  for (const rule of NOTICE_SYNONYMS) {
    if (rule.test.test(q)) for (const w of rule.expand) terms.add(w);
  }
  return [...terms];
}

/** 截止语义：这一句在说「什么时候之前要交/要报」。 */
const DUE_WORD = /截止|截至|报名|申请|提交|上交|报送|填报|申报|登记|受理|缴费|确认/;

/** 事件语义：这一句在说「什么时候开始」。 */
const EVENT_WORD = /讲座|报告|开讲|举办|举行|召开|开幕|开始|活动时间|比赛时间|会议时间|演出|展播|直播/;

/** 按句末标点切句。中文句号/分号/换行都算，逗号不算（「截止 11 月 5 日，逾期不候」要留在同一句）。 */
export function splitSentences(text: string): string[] {
  return text
    .split(/[。；;！!？?\n\r]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 一句里的第一个时刻：「19:00」「晚上 7 点」「下午 3 点半」。
 * 「10 月 23 日」这种日期不会被误认成时刻（没有 : 也没有 点/时）。
 */
export function extractClock(sentence: string): string | undefined {
  const colon = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(sentence);
  if (colon?.[1] && colon[2]) {
    const h = Number(colon[1]);
    const m = Number(colon[2]);
    if (h <= 23 && m <= 59) return `${pad2(h)}:${pad2(m)}`;
  }
  const cn = /(\d{1,2})\s*[点时](?:\s*(\d{1,2})\s*分|半)?/.exec(sentence);
  if (cn?.[1]) {
    let h = Number(cn[1]);
    const m = cn[2] ? Number(cn[2]) : /半/.test(cn[0]) ? 30 : 0;
    if (/下午|晚上|傍晚|夜间/.test(sentence) && h < 12) h += 12;
    if (h <= 23 && m <= 59) return `${pad2(h)}:${pad2(m)}`;
  }
  return undefined;
}

export interface Moment {
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm（原文里有才给） */
  time?: string;
}

const HALF_YEAR_DAYS = 184;

/** 12 月看到的「1 月 5 日」多半是明年的事：过去超过半年就顺延一年。 */
function rollForward(date: string, today?: string): string {
  if (!today) return date;
  if (daysBetween(today, date) < -HALF_YEAR_DAYS) {
    return `${Number(today.slice(0, 4)) + 1}${date.slice(4)}`;
  }
  return date;
}

/**
 * 截止日：只看带截止语义的句子，取其中**最晚**的那个日期
 * （同一份通知里「报名 10 月 25 日」「材料 11 月 20 日」，最晚的才是真正会错过的那条）。
 * 文本里没有明确月日就返回 undefined —— 宁可卡片上不显示截止，也不要写个错的。
 */
export function extractDeadline(text: string, year: number, today?: string): Moment | undefined {
  const found: Moment[] = [];
  for (const sentence of splitSentences(text)) {
    if (!DUE_WORD.test(sentence)) continue;
    const clock = extractClock(sentence);
    for (const date of extractDueDates(sentence, year)) {
      found.push({ date: rollForward(date, today), ...(clock ? { time: clock } : {}) });
    }
  }
  if (found.length === 0) return undefined;
  found.sort((a, b) => a.date.localeCompare(b.date));
  return found[found.length - 1];
}

/**
 * 活动开始：只看带事件语义的句子，取**最早**的一个日期。
 * 「今天 2 场讲座」这种统计全靠它；抽不到就是抽不到，不补默认值。
 */
export function extractEventStart(text: string, year: number, today?: string): Moment | undefined {
  const found: Moment[] = [];
  for (const sentence of splitSentences(text)) {
    if (!EVENT_WORD.test(sentence)) continue;
    // 「报名截止 11 月 20 日 17:00 举办方将…」是截止句，别当成活动时间
    if (DUE_WORD.test(sentence) && !/讲座|举行|举办|召开|开讲/.test(sentence)) continue;
    const clock = extractClock(sentence);
    for (const date of extractDueDates(sentence, year)) {
      found.push({ date: rollForward(date, today), ...(clock ? { time: clock } : {}) });
    }
  }
  if (found.length === 0) return undefined;
  found.sort((a, b) => a.date.localeCompare(b.date));
  return found[0];
}

/**
 * 地点：先认「地点：XXX」这种写了标签的，再认「在 XXX 举行」，最后退化到「××报告厅」。
 * 抽不出来就不显示——教室名猜错比没有更糟（学生真会跑错楼）。
 */
export function extractLocation(text: string): string | undefined {
  const labeled = /(?:地点|地址|会场|活动地点|会议地点|举办地点)\s*[:：]\s*([^\s，。；、！？]{2,24})/.exec(text);
  if (labeled?.[1]) return trimPlace(labeled[1]);
  const inPlace = /在\s*([\u4e00-\u9fa5A-Za-z0-9（）()\-]{2,18}?)\s*(?:举行|举办|召开|开讲|开展|进行)/.exec(text);
  if (inPlace?.[1]) return trimPlace(inPlace[1]);
  const venue = /([\u4e00-\u9fa5]{2,12}(?:报告厅|会议室|多功能厅|活动室|大礼堂|体育馆|运动场|操场|图书馆|教学楼|实验楼|广场))/.exec(
    text,
  );
  if (venue?.[1]) return venue[1];
  return undefined;
}

function trimPlace(raw: string): string {
  return raw.replace(/^[于在]/, '').replace(/[，。；、：:！？]+$/, '').trim();
}
