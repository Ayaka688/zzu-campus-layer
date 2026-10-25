/**
 * 说法匹配：把「用户这句话」对到「语料里最像的那句」，从而知道该跑哪个工具。
 *
 * 不用模型、不联网，纯字符统计：
 *   score = 0.55 × 查询字数覆盖率      （这句话里的字，有多少在语料那句里出现过）
 *         + 0.30 × 最大 n-gram Jaccard（2 字 / 3 字片段的顺序信息，防止「有字但词序乱」）
 *         + 0.15 × 长度接近度          （长度差太多的那句不该赢）
 *
 * 两段阈值：
 *   ≥ EXECUTE_SCORE 直接执行；
 *   ≥ SUGGEST_SCORE 只当候选（界面上给「你是想问…吗」，绝不替你跑）。
 *
 * 正则（`parseIntent`）永远优先，这里只在它没命中时才被调用——所以加语料不会改变已有行为。
 */
import { charSet, jaccard, nGrams, normalizeQuery } from './normalize';
import { UTTERANCES, type Utterance } from './phrases';
import { TOOLS, type ToolName } from './tools';

/** 高过这条线才真的执行。 */
export const EXECUTE_SCORE = 0.62;
/** 高过这条线只是「可能想问」，不执行。 */
export const SUGGEST_SCORE = 0.42;

export interface UtteranceMatch {
  tool: ToolName;
  args?: Record<string, unknown>;
  score: number;
  /** 命中的那句语料原文，方便调试和「你是想问…吗」。 */
  matched: string;
}

export interface UtteranceHint {
  tool: ToolName;
  score: number;
  matched: string;
}

interface Prepared {
  item: Utterance;
  norm: string;
  chars: Set<string>;
  bi: Set<string>;
  tri: Set<string>;
}

let prepared: Prepared[] | undefined;

function corpus(): Prepared[] {
  if (!prepared) {
    prepared = UTTERANCES.map((item) => {
      const norm = normalizeQuery(item.text);
      return { item, norm, chars: charSet(norm), bi: nGrams(norm, 2), tri: nGrams(norm, 3) };
    }).filter((p) => p.norm.length > 0);
  }
  return prepared;
}

interface Query {
  norm: string;
  chars: Set<string>;
  bi: Set<string>;
  tri: Set<string>;
}

function shape(text: string): Query {
  const norm = normalizeQuery(text);
  return { norm, chars: charSet(norm), bi: nGrams(norm, 2), tri: nGrams(norm, 3) };
}

function coverage(q: Query, p: Prepared): number {
  if (!q.chars.size) return 0;
  let hit = 0;
  for (const ch of q.chars) if (p.chars.has(ch)) hit++;
  return hit / q.chars.size;
}

function lengthCloseness(q: Query, p: Prepared): number {
  const longer = Math.max(q.norm.length, p.norm.length);
  if (!longer) return 0;
  return 1 - Math.abs(q.norm.length - p.norm.length) / longer;
}

function score(q: Query, p: Prepared): number {
  const grams = Math.max(jaccard(q.bi, p.bi), jaccard(q.tri, p.tri));
  return 0.55 * coverage(q, p) + 0.3 * grams + 0.15 * lengthCloseness(q, p);
}

function ranked(text: string): Array<{ p: Prepared; s: number }> {
  const q = shape(text);
  if (q.norm.length < 2) return [];
  return corpus()
    .map((p) => ({ p, s: score(q, p) }))
    .sort((a, b) => b.s - a.s || a.p.norm.length - b.p.norm.length);
}

/**
 * 只在高置信时返回工具；调用方拿到后应当先用工具的 schema 校验 args，
 * 校验不过就当作没匹配（宁可不跑，也别跑错）。
 */
export function matchUtterance(text: string): UtteranceMatch | null {
  const top = ranked(text)[0];
  if (!top || top.s < SUGGEST_SCORE) return null;
  return { tool: top.p.item.tool, ...(top.p.item.args ? { args: { ...top.p.item.args } } : {}), score: top.s, matched: top.p.item.text };
}

/** 工具自己的 schema 也认可这组参数时，才算「可以真的跑」。 */
export function resolveUtterance(text: string): UtteranceMatch | null {
  const hit = matchUtterance(text);
  if (!hit || hit.score < EXECUTE_SCORE) return null;
  const def = TOOLS[hit.tool];
  const parsed = def.schema.safeParse(hit.args ?? {});
  if (!parsed.success) return null;
  return { ...hit, args: parsed.data as Record<string, unknown> };
}

/** 低置信时的候选（每个工具只留分最高的那句）。 */
export function suggestUtterances(text: string, limit = 3): UtteranceHint[] {
  const seen = new Set<ToolName>();
  const out: UtteranceHint[] = [];
  for (const { p, s } of ranked(text)) {
    if (s < SUGGEST_SCORE) break;
    if (seen.has(p.item.tool)) continue;
    seen.add(p.item.tool);
    out.push({ tool: p.item.tool, score: s, matched: p.item.text });
    if (out.length >= limit) break;
  }
  return out;
}
