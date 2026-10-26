import { getKV, type KV } from './kv';

/** 存档键：手机 PWA 与扩展侧栏各存各的（不同源，localStorage / chrome.storage 互不相通）。 */
export const TRANSCRIPT_KEY = 'transcript';

/**
 * 界面只留最近几条。
 *
 * 注意这**不是**在控制模型的上下文：真正发出去的历史由 agent 自己
 * `slice(-MAX_HISTORY)` 管（见 src/core/agent.ts）。这里管两件事：
 * 聊天记录别越滚越长、换页面/重开之后还能看见刚才聊的那几轮。
 *
 * 10 条 = 我问的和他答的加在一起 10 条，一屏能看完，又不至于翻不到上一轮。
 */
export const TRANSCRIPT_LIMIT = 10;

/** 这些字段是给界面画图、建文件的，存进去只占地方（座位图一张 data URI 就 20KB）。 */
const HEAVY_KEYS = ['image', 'seats', 'ics', 'raw', 'svg'];

/** 单条 data 留 4KB 就够了：放得下卡片和摘要，放不下大图。 */
const MAX_DATA_CHARS = 4096;

export interface TranscriptItem {
  role: 'user' | 'assistant';
  text: string;
  tool?: string;
  data?: Record<string, unknown>;
  error?: boolean;
  via?: string;
  steps?: string[];
  llmError?: string;
}

/** 取最近 limit 条，空白条目丢掉。界面渲染也走这里，两处规则就一致。 */
export function trimTranscript<T extends { role: 'user' | 'assistant'; text: string }>(
  items: readonly T[],
  limit: number = TRANSCRIPT_LIMIT,
): T[] {
  const keep = Math.max(1, Math.floor(limit));
  return items.filter((m) => typeof m.text === 'string' && m.text.trim() !== '').slice(-keep);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** 去掉重字段；剩下的还超预算就整块丢掉——宁可不画卡片，也别把存档撑大。 */
function slimData(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!HEAVY_KEYS.includes(key)) out[key] = value;
  }
  if (Object.keys(out).length === 0) return undefined;
  try {
    if (JSON.stringify(out).length > MAX_DATA_CHARS) return undefined;
  } catch {
    return undefined; // 循环引用之类，直接放弃
  }
  return out;
}

/** 从存档读出来的东西一律先洗一遍：形状不对就丢，不信任本地存储的内容。 */
export function sanitizeTranscript(raw: unknown): TranscriptItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const msg = item as Record<string, unknown>;
    const role = msg.role === 'user' || msg.role === 'assistant' ? msg.role : undefined;
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (!role || !text.trim()) continue;
    const tool = str(msg.tool);
    const via = str(msg.via);
    const llmError = str(msg.llmError);
    const data = slimData(msg.data);
    const steps = Array.isArray(msg.steps)
      ? msg.steps.filter((step): step is string => typeof step === 'string')
      : undefined;
    out.push({
      role,
      text,
      ...(tool ? { tool } : {}),
      ...(data ? { data } : {}),
      ...(msg.error === true ? { error: true } : {}),
      ...(via ? { via } : {}),
      ...(steps && steps.length ? { steps } : {}),
      ...(llmError ? { llmError } : {}),
    });
  }
  return trimTranscript(out);
}

/** 读存档：读不出来就当没有，聊天界面从空开始——别因为存储坏了整页打不开。 */
export async function loadTranscript<T extends TranscriptItem = TranscriptItem>(
  kv: KV = getKV(),
): Promise<T[]> {
  try {
    const stored = await kv.get<{ items?: unknown }>(TRANSCRIPT_KEY);
    const items = sanitizeTranscript(stored?.items);
    return items as T[];
  } catch {
    return [];
  }
}

/** 写存档：自动截到最近 TRANSCRIPT_LIMIT 条，顺带洗掉大字段。 */
export async function saveTranscript(
  items: readonly TranscriptItem[],
  kv: KV = getKV(),
): Promise<void> {
  const trimmed = sanitizeTranscript([...items]);
  await kv.set(TRANSCRIPT_KEY, { v: 1, at: Date.now(), items: trimmed });
}

/** 清空存档（换账号、想重新开始时用）。 */
export async function clearTranscript(kv: KV = getKV()): Promise<void> {
  await kv.remove(TRANSCRIPT_KEY);
}
