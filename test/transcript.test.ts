import { describe, expect, it } from 'vitest';
import {
  TRANSCRIPT_KEY,
  TRANSCRIPT_LIMIT,
  clearTranscript,
  loadTranscript,
  sanitizeTranscript,
  saveTranscript,
  trimTranscript,
  type TranscriptItem,
} from '../src/core/transcript';
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

const convo = (n: number): TranscriptItem[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `第 ${i + 1} 条`,
  }));

describe('trimTranscript', () => {
  it('只留最近 10 条（我发的和他回的一起算）', () => {
    expect(TRANSCRIPT_LIMIT).toBe(10);
    const kept = trimTranscript(convo(18));
    expect(kept).toHaveLength(10);
    expect(kept[0]!.text).toBe('第 9 条');
    expect(kept[9]!.text).toBe('第 18 条');
  });

  it('不够 10 条时原样返回，顺序不变', () => {
    expect(trimTranscript(convo(3)).map((m) => m.text)).toEqual(['第 1 条', '第 2 条', '第 3 条']);
  });

  it('空白条目不算数', () => {
    const kept = trimTranscript([
      { role: 'user' as const, text: '有内容的' },
      { role: 'assistant' as const, text: '   ' },
      { role: 'user' as const, text: '' },
    ]);
    expect(kept).toHaveLength(1);
  });

  it('limit 可以调，且至少留 1 条', () => {
    expect(trimTranscript(convo(9), 2).map((m) => m.text)).toEqual(['第 8 条', '第 9 条']);
    expect(trimTranscript(convo(3), 0)).toHaveLength(1);
  });

  it('不修改入参', () => {
    const items = convo(7);
    trimTranscript(items);
    expect(items).toHaveLength(7);
  });
});

describe('sanitizeTranscript', () => {
  it('不是数组就当空', () => {
    expect(sanitizeTranscript(undefined)).toEqual([]);
    expect(sanitizeTranscript('[]')).toEqual([]);
    expect(sanitizeTranscript({ items: [] })).toEqual([]);
  });

  it('丢掉形状不对的条目', () => {
    const out = sanitizeTranscript([
      null,
      42,
      { role: 'system', text: '不该出现' },
      { role: 'user' },
      { role: 'user', text: '正常的' },
    ]);
    expect(out).toEqual([{ role: 'user', text: '正常的' }]);
  });

  it('洗掉座位图/ics 这类重字段', () => {
    const out = sanitizeTranscript([
      {
        role: 'assistant',
        text: '座位图来了',
        tool: 'find_seat',
        data: {
          image: 'data:image/png;base64,AAAA',
          seats: [1, 2, 3],
          ics: 'BEGIN:VCALENDAR',
          raw: { huge: true },
          svg: '<svg/>',
          count: 12,
        },
        via: 'agent',
        steps: ['find_seat', 7],
      },
    ]);
    expect(out[0]!.data).toEqual({ count: 12 });
    expect(out[0]!.steps).toEqual(['find_seat']);
  });

  it('data 太大就整块不要', () => {
    const out = sanitizeTranscript([
      { role: 'assistant', text: '大卡片', data: { blob: 'x'.repeat(5000) } },
    ]);
    expect(out[0]!.data).toBeUndefined();
  });

  it('只有重字段时 data 也丢掉', () => {
    const out = sanitizeTranscript([
      { role: 'assistant', text: '只剩图', data: { image: 'data:image/png;base64,AAAA' } },
    ]);
    expect(out[0]!.data).toBeUndefined();
  });

  it('洗完仍然只留最近 10 条', () => {
    expect(sanitizeTranscript(convo(15))).toHaveLength(10);
  });

  it('保留 error / llmError 这些排错信息', () => {
    const out = sanitizeTranscript([
      { role: 'assistant', text: '挂了', error: true, llmError: '401', via: 'none' },
    ]);
    expect(out[0]!).toEqual({
      role: 'assistant',
      text: '挂了',
      error: true,
      via: 'none',
      llmError: '401',
    });
  });
});

describe('存档读写', () => {
  it('存了能读回来，顺序不变', async () => {
    const kv = memKV();
    await saveTranscript(convo(4), kv);
    const back = await loadTranscript(kv);
    expect(back.map((m) => m.text)).toEqual(['第 1 条', '第 2 条', '第 3 条', '第 4 条']);
  });

  it('存进去的永远只有 10 条', async () => {
    const kv = memKV();
    await saveTranscript(convo(20), kv);
    const stored = kv.dump()[TRANSCRIPT_KEY] as { v: number; at: number; items: TranscriptItem[] };
    expect(stored.v).toBe(1);
    expect(typeof stored.at).toBe('number');
    expect(stored.items).toHaveLength(10);
    expect(stored.items[9]!.text).toBe('第 20 条');
  });

  it('没有存档时返回空数组', async () => {
    expect(await loadTranscript(memKV())).toEqual([]);
  });

  it('存档被改坏了也不炸', async () => {
    const kv = memKV({ [TRANSCRIPT_KEY]: { items: 'not-an-array' } });
    expect(await loadTranscript(kv)).toEqual([]);
    const kv2 = memKV({ [TRANSCRIPT_KEY]: 'garbage' });
    expect(await loadTranscript(kv2)).toEqual([]);
  });

  it('存储抛错时按没有处理', async () => {
    const broken: KV = {
      async get() {
        throw new Error('quota');
      },
      async set() {
        throw new Error('quota');
      },
      async remove() {
        throw new Error('quota');
      },
    };
    expect(await loadTranscript(broken)).toEqual([]);
  });

  it('重字段不会落盘', async () => {
    const kv = memKV();
    await saveTranscript(
      [{ role: 'assistant', text: '座位图', data: { image: 'data:image/png;base64,AAAA', count: 3 } }],
      kv,
    );
    const items = (kv.dump()[TRANSCRIPT_KEY] as { items: TranscriptItem[] }).items;
    expect(items[0]!.data).toEqual({ count: 3 });
    expect(JSON.stringify(items)).not.toContain('data:image');
  });

  it('清空之后读不到东西', async () => {
    const kv = memKV();
    await saveTranscript(convo(2), kv);
    await clearTranscript(kv);
    expect(await loadTranscript(kv)).toEqual([]);
  });
});
