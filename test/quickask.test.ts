import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUICK_ASKS,
  MAX_QUICK_ASKS,
  MAX_QUICK_TEXT,
  QUICK_ASKS_KEY,
  addQuickAsk,
  defaultQuickAsks,
  loadQuickAsks,
  moveQuickAsk,
  normalizeQuickAsks,
  removeQuickAsk,
  reorderQuickAsk,
  resetQuickAsks,
  saveQuickAsks,
  updateQuickAsk,
  type QuickAsk,
} from '../src/core/quickAsk';
import type { KV } from '../src/core/kv';

/** 内存版 KV：不碰 localStorage / chrome.storage，node 环境也能跑。 */
function memKV(seed: Record<string, unknown> = {}): KV & { dump: () => Record<string, unknown> } {
  const store: Record<string, unknown> = { ...seed };
  return {
    async get<T>(key: string) {
      return store[key] as T | undefined;
    },
    async set(key: string, value: unknown) {
      store[key] = JSON.parse(JSON.stringify(value));
    },
    async remove(key: string) {
      delete store[key];
    },
    dump: () => store,
  };
}

const list = (...texts: string[]): QuickAsk[] =>
  texts.map((text, i) => ({ id: `id-${i}`, label: text, text }));

describe('常用语：出厂列表', () => {
  it('默认 7 条，第一条是「明天有课吗」，跟以前写死的顺序一致', () => {
    const items = defaultQuickAsks();
    expect(items.length).toBe(DEFAULT_QUICK_ASKS.length);
    expect(items.map((item) => item.label)).toEqual([
      '明天有课吗',
      '本周课表',
      '今天的空教室',
      '今天有什么讲座',
      '最新通知',
      '卡里余额',
      '导出日历',
    ]);
  });

  it('返回的是副本：改了不会污染出厂常量', () => {
    const items = defaultQuickAsks();
    items[0]!.label = '改过了';
    expect(defaultQuickAsks()[0]!.label).toBe('明天有课吗');
  });
});

describe('常用语：增删排序', () => {
  it('加一条，去空格、生成 id', () => {
    const next = addQuickAsk(list('a'), '  图书馆 还有座吗 ');
    expect(next.length).toBe(2);
    expect(next[1]!.text).toBe('图书馆 还有座吗');
    expect(next[1]!.label).toBe('图书馆 还有座吗');
    expect(next[1]!.id).toBeTruthy();
    expect(next[1]!.id).not.toBe(next[0]!.id);
  });

  it('可以只换显示名（点的还是同一句话）', () => {
    const next = addQuickAsk([], '这周课表', '本周课表');
    expect(next[0]!.label).toBe('本周课表');
    expect(next[0]!.text).toBe('这周课表');
  });

  it('空内容、重复、超上限都要报错，且报的是中文原因', () => {
    expect(() => addQuickAsk([], '   ')).toThrow('写点内容再添加');
    expect(() => addQuickAsk(list('明天有课吗'), '明天有课吗')).toThrow('已经在里面了');
    const full = list(...Array.from({ length: MAX_QUICK_ASKS }, (_, i) => `第 ${i} 句`));
    expect(() => addQuickAsk(full, '再来一句')).toThrow(`最多 ${MAX_QUICK_ASKS} 条`);
  });

  it('超长内容会被截断而不是报错（粘贴一长串不至于加不进来）', () => {
    const next = addQuickAsk([], 'x'.repeat(MAX_QUICK_TEXT + 40));
    expect(next[0]!.text.length).toBe(MAX_QUICK_TEXT);
  });

  it('换行会被压成空格，药丸不会变成两行', () => {
    const next = addQuickAsk([], '明天\n有课吗');
    expect(next[0]!.text).toBe('明天 有课吗');
  });

  it('删掉指定那条，别人的顺序不动', () => {
    const next = removeQuickAsk(list('a', 'b', 'c'), 'id-1');
    expect(next.map((item) => item.text)).toEqual(['a', 'c']);
  });

  it('上移下移一格，到头就原样返回', () => {
    const items = list('a', 'b', 'c');
    expect(moveQuickAsk(items, 'id-2', -1).map((item) => item.text)).toEqual(['a', 'c', 'b']);
    expect(moveQuickAsk(items, 'id-0', 1).map((item) => item.text)).toEqual(['b', 'a', 'c']);
    expect(moveQuickAsk(items, 'id-0', -1)).toBe(items);
    expect(moveQuickAsk(items, 'id-2', 1)).toBe(items);
    expect(moveQuickAsk(items, '不存在', 1)).toBe(items);
  });

  it('拖到任意位置（reorder），越界会夹到两端', () => {
    const items = list('a', 'b', 'c', 'd');
    expect(reorderQuickAsk(items, 'id-3', 0).map((item) => item.text)).toEqual(['d', 'a', 'b', 'c']);
    expect(reorderQuickAsk(items, 'id-0', 99).map((item) => item.text)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('改文案：空的报错，撞到别的句子也报错', () => {
    const items = list('a', 'b');
    expect(updateQuickAsk(items, 'id-0', { label: 'A' })[0]!.label).toBe('A');
    expect(() => updateQuickAsk(items, 'id-0', { text: '  ' })).toThrow('内容不能是空的');
    expect(() => updateQuickAsk(items, 'id-0', { text: 'b' })).toThrow('已经在里面了');
  });

  it('自己改回同一句话不算重复', () => {
    const items = list('a', 'b');
    expect(updateQuickAsk(items, 'id-0', { text: 'a' })[0]!.text).toBe('a');
  });
});

describe('常用语：脏数据洗白', () => {
  it('字符串数组也认（兼容以后可能的简写）', () => {
    expect(normalizeQuickAsks(['明天有课吗', '这周课表'])?.map((item) => item.text)).toEqual([
      '明天有课吗',
      '这周课表',
    ]);
  });

  it('label 缺了用 text 补，text 缺了用 label 补，空条目丢掉', () => {
    const got = normalizeQuickAsks([{ text: '甲' }, { label: '乙' }, { text: '   ' }, 42, null]);
    expect(got?.map((item) => item.text)).toEqual(['甲', '乙']);
    expect(got?.[1]!.label).toBe('乙');
  });

  it('重复句子只留第一条，超上限截断', () => {
    const many = Array.from({ length: MAX_QUICK_ASKS + 5 }, (_, i) => `第 ${i} 句`);
    const got = normalizeQuickAsks(['a', 'a', ...many]);
    expect(got?.length).toBe(MAX_QUICK_ASKS);
    expect(got?.[0]!.text).toBe('a');
  });

  it('不是数组就返回 undefined（让调用方回落到出厂）', () => {
    expect(normalizeQuickAsks(undefined)).toBeUndefined();
    expect(normalizeQuickAsks('明天有课吗')).toBeUndefined();
    expect(normalizeQuickAsks({ items: [] })).toBeUndefined();
  });
});

describe('常用语：落库', () => {
  it('没存过 → 出厂列表', async () => {
    const kv = memKV();
    expect((await loadQuickAsks(kv)).length).toBe(DEFAULT_QUICK_ASKS.length);
  });

  it('存了就读自己的，顺序照存', async () => {
    const kv = memKV();
    await saveQuickAsks(list('丙', '甲', '乙'), kv);
    expect((await loadQuickAsks(kv)).map((item) => item.text)).toEqual(['丙', '甲', '乙']);
  });

  it('全删光后仍然是空的（不会被默认值顶回来）', async () => {
    const kv = memKV();
    await saveQuickAsks([], kv);
    expect(await loadQuickAsks(kv)).toEqual([]);
    expect((kv.dump()[QUICK_ASKS_KEY] as { items: unknown[] }).items).toEqual([]);
  });

  it('存坏了（不是数组）→ 回落出厂', async () => {
    const kv = memKV({ [QUICK_ASKS_KEY]: { v: 1, items: '今天天气' } });
    expect((await loadQuickAsks(kv)).length).toBe(DEFAULT_QUICK_ASKS.length);
  });

  it('kv 抛错也不该把界面带崩', async () => {
    const broken: KV = {
      async get() {
        throw new Error('storage 挂了');
      },
      async set() {
        throw new Error('storage 挂了');
      },
      async remove() {},
    };
    expect((await loadQuickAsks(broken)).length).toBe(DEFAULT_QUICK_ASKS.length);
  });

  it('保存时也会洗一遍：重复的进不去', async () => {
    const kv = memKV();
    const saved = await saveQuickAsks(list('a', 'a', 'b'), kv);
    expect(saved.map((item) => item.text)).toEqual(['a', 'b']);
    expect((await loadQuickAsks(kv)).map((item) => item.text)).toEqual(['a', 'b']);
  });

  it('恢复默认：把列表换回那 7 条', async () => {
    const kv = memKV();
    await saveQuickAsks(list('就一句'), kv);
    const back = await resetQuickAsks(kv);
    expect(back.map((item) => item.text)).toEqual(DEFAULT_QUICK_ASKS.map((item) => item.text));
    expect((await loadQuickAsks(kv)).length).toBe(DEFAULT_QUICK_ASKS.length);
  });
});
