/**
 * 输入框上面的「常用语」药丸。
 *
 * 原来这排是写死的 7 条（`pwa/main.tsx` 与 `sidepanel/main.tsx` 各抄一份），
 * 但每个人常问的话不一样——有人天天问课表，有人只想问「图书馆还有座吗」。
 * 这里把它变成一份可编辑、可排序的列表，存在 kv（扩展 → chrome.storage.local，
 * PWA → localStorage）里，键是 `quickAsks`。
 *
 * 只放纯逻辑，界面在 `src/ui/quick-asks.tsx`：这样列表的校验（长度、去重、
 * 上限）能被测试直接覆盖，也不用起浏览器。
 */
import { getKV, type KV } from './kv';

export interface QuickAsk {
  /** 稳定 id：排序和删除都靠它，改文案也不会认错 */
  id: string;
  /** 药丸上显示的字，太长会被 CSS 省略 */
  label: string;
  /** 点下去真正发出去的那句话（默认跟 label 一样） */
  text: string;
}

export const QUICK_ASKS_KEY = 'quickAsks';

/** 一排最多几条：再多就得横着划很久，不如自己删。 */
export const MAX_QUICK_ASKS = 12;
/** 单条最长多少字（发出去的句子，不是药丸宽度）。 */
export const MAX_QUICK_TEXT = 120;

let seq = 0;

/** 时间戳 + 序号 + 随机尾，够唯一；不依赖 crypto.randomUUID（老 WebView 没有）。 */
export function newQuickAskId(): string {
  seq = (seq + 1) % 1000;
  return `q${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** 出厂那几条，跟以前写死的一模一样，老用户升级后看到的东西不变。 */
export const DEFAULT_QUICK_ASKS: readonly QuickAsk[] = [
  { id: 'q-default-schedule', label: '明天有课吗', text: '明天有课吗' },
  { id: 'q-default-week', label: '本周课表', text: '这周课表' },
  { id: 'q-default-room', label: '今天的空教室', text: '今天上午的空教室' },
  { id: 'q-default-lecture', label: '今天有什么讲座', text: '今天有什么讲座' },
  { id: 'q-default-notice', label: '最新通知', text: '最近的通知' },
  { id: 'q-default-card', label: '卡里余额', text: '我卡里还有多少钱' },
  { id: 'q-default-ics', label: '导出日历', text: '把课表导出成日历' },
];

export function defaultQuickAsks(): QuickAsk[] {
  return DEFAULT_QUICK_ASKS.map((item) => ({ ...item }));
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * 把存储里读到的东西洗成合法列表。
 * 返回 `undefined` 表示「这份数据没法用」，调用方回落到出厂设置；
 * 返回空数组是合法的（用户把常用语删光了）。
 */
export function normalizeQuickAsks(raw: unknown): QuickAsk[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: QuickAsk[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let label = '';
    let text = '';
    let id = '';
    if (typeof entry === 'string') {
      label = entry;
      text = entry;
    } else if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>;
      if (typeof o.text === 'string') text = o.text;
      if (typeof o.label === 'string') label = o.label;
      else if (typeof o.name === 'string') label = o.name;
      if (typeof o.id === 'string') id = o.id;
      if (!text) text = label;
      if (!label) label = text;
    }
    text = oneLine(text).slice(0, MAX_QUICK_TEXT);
    label = oneLine(label).slice(0, MAX_QUICK_TEXT) || text;
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ id: id || newQuickAskId(), label, text });
    if (out.length >= MAX_QUICK_ASKS) break;
  }
  return out;
}

/** 读列表：没有存储 / 存坏了 → 出厂设置；存成空数组 → 就是空的。 */
export async function loadQuickAsks(kv: KV = getKV()): Promise<QuickAsk[]> {
  try {
    const stored = await kv.get<{ v?: number; items?: unknown }>(QUICK_ASKS_KEY);
    if (!stored) return defaultQuickAsks();
    const items = normalizeQuickAsks(stored.items);
    return items ?? defaultQuickAsks();
  } catch {
    return defaultQuickAsks();
  }
}

/** 写列表：先洗干净再落盘，返回值就是真正存下去的版本。 */
export async function saveQuickAsks(items: QuickAsk[], kv: KV = getKV()): Promise<QuickAsk[]> {
  const clean = normalizeQuickAsks(items) ?? [];
  await kv.set(QUICK_ASKS_KEY, { v: 1, items: clean });
  return clean;
}

/** 恢复出厂：直接把写死的默认值存一遍，之后的行为跟从没改过一致。 */
export async function resetQuickAsks(kv: KV = getKV()): Promise<QuickAsk[]> {
  return saveQuickAsks(defaultQuickAsks(), kv);
}

/**
 * 加一条。出错时抛中文原因，界面直接把 message 显示出来。
 * 允许「同一句话换个显示名」——区别在于 target.text。
 */
export function addQuickAsk(items: QuickAsk[], raw: string, label?: string): QuickAsk[] {
  const text = oneLine(raw).slice(0, MAX_QUICK_TEXT);
  if (!text) throw new Error('写点内容再添加');
  if (items.some((item) => item.text === text)) throw new Error('这句已经在里面了');
  if (items.length >= MAX_QUICK_ASKS) throw new Error(`最多 ${MAX_QUICK_ASKS} 条，先删一条再加`);
  const shown = oneLine(label ?? '').slice(0, MAX_QUICK_TEXT) || text;
  return [...items, { id: newQuickAskId(), label: shown, text }];
}

/** 删一条（按 id）。 */
export function removeQuickAsk(items: QuickAsk[], id: string): QuickAsk[] {
  return items.filter((item) => item.id !== id);
}

/**
 * 上下挪一格。`delta` 为 ±1；挪不动（已经在头/尾）时原样返回。
 * 用 id 而不是下标：界面里连点两下也不会因为列表重排而挪错人。
 */
export function moveQuickAsk(items: QuickAsk[], id: string, delta: number): QuickAsk[] {
  const from = items.findIndex((item) => item.id === id);
  if (from < 0) return items;
  const to = Math.min(items.length - 1, Math.max(0, from + delta));
  if (to === from) return items;
  const next = items.slice();
  const [picked] = next.splice(from, 1);
  if (!picked) return items;
  next.splice(to, 0, picked);
  return next;
}

/** 改成「第 index 位」——留给以后拖拽排序用，拖完一步就能落库。 */
export function reorderQuickAsk(items: QuickAsk[], id: string, index: number): QuickAsk[] {
  const from = items.findIndex((item) => item.id === id);
  if (from < 0) return items;
  const to = Math.min(items.length - 1, Math.max(0, Math.trunc(index)));
  if (to === from) return items;
  const next = items.slice();
  const [picked] = next.splice(from, 1);
  if (!picked) return items;
  next.splice(to, 0, picked);
  return next;
}

/** 改文案（编辑已有那条）。空内容或和别的重复就抛错。 */
export function updateQuickAsk(items: QuickAsk[], id: string, patch: { label?: string; text?: string }): QuickAsk[] {
  const at = items.findIndex((item) => item.id === id);
  if (at < 0) return items;
  const current = items[at]!;
  const text = oneLine(patch.text ?? current.text).slice(0, MAX_QUICK_TEXT);
  if (!text) throw new Error('内容不能是空的');
  if (items.some((item) => item.id !== id && item.text === text)) throw new Error('这句已经在里面了');
  const label = oneLine(patch.label ?? current.label).slice(0, MAX_QUICK_TEXT) || text;
  const next = items.slice();
  next[at] = { ...current, text, label };
  return next;
}
