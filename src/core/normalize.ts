/**
 * 归一化：把「口语」压成「可比较的形状」。
 *
 * 只做三件事，尽量不破坏信息：
 * 1. 全角 → 半角、大小写统一；
 * 2. 去掉标点、语气词、客套话（「帮我」「请问」这类对意图无贡献的词）；
 * 3. 替换常见错字 / 别称（图书管→图书馆、基点→绩点、饭卡→卡）。
 *
 * 归一化对**语料和用户输入用同一个函数**，所以两边永远在同一形状上比较。
 */

const FULL_TO_HALF = /[\uFF01-\uFF5E]/g;
const ALIASES: Array<[RegExp, string]> = [
  [/图书管|图使馆|图书馆儿/g, '图书馆'],
  [/自习市|自习事/g, '自习室'],
  [/空叫室|空教室儿/g, '空教室'],
  [/基点/g, '绩点'],
  [/学分儿/g, '学分'],
  [/饭卡|一卡通|校园卡|卡里|卡上/g, '卡'],
  [/学生卡/g, '卡'],
  [/成绩单/g, '成绩'],
  [/几点钟|几个点/g, '几点'],
  [/下周儿/g, '下周'],
];

/** 对意图没贡献的客套/语气词，去掉不影响匹配（「请问明天有课吗」≈「明天有课吗」）。 */
const NOISE = /(请问|麻烦|帮我|帮忙|我想|想|一下|能不能|可不可以|可以|吗|呢|啊|呀|吧|嘛|哦|啦|哈|嗯|呃|那个|就是|的话|看看|查查|查询|查|看看儿)/g;
const PUNCT = /[\s，。！？、；：""''（）【】《》,.!?;:"'()[\]<>~·—…\-_/\\|+*=@#$%^&{}]/g;

export function normalizeQuery(input: string): string {
  if (!input) return '';
  let text = input.normalize('NFKC').replace(FULL_TO_HALF, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).toLowerCase();
  for (const [re, to] of ALIASES) text = text.replace(re, to);
  text = text.replace(PUNCT, '').replace(NOISE, '');
  return text.trim();
}

/** 归一化后的字集合：用于「说法里的字被用户说了多少」。 */
export function charSet(text: string): Set<string> {
  return new Set(text.split(''));
}

export function nGrams(text: string, n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= text.length; i++) out.add(text.slice(i, i + n));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
