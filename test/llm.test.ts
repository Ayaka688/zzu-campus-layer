import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyIntent,
  llmChat,
  mintApiKey,
  parseIntentsJson,
  stripThink,
  type LlmSettings,
} from '../src/core/llm';

const cfg: LlmSettings = { enabled: true, provider: 'school', apiKey: 'sk-test', model: 'DeepSeek-R1' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stripThink', () => {
  it('去掉 DeepSeek-R1 的推理段', () => {
    const raw = '<think>\n用户问课表，用 get_schedule\n</think>\n{"tool":"get_schedule"}';
    expect(stripThink(raw)).toBe('{"tool":"get_schedule"}');
  });

  it('没有 think 段时原样返回', () => {
    expect(stripThink('  hello  ')).toBe('hello');
  });
});

describe('parseIntentsJson', () => {
  it('解析正常 JSON', () => {
    const got = parseIntentsJson('{"tool":"search_notice","args":{"keyword":"考试"}}');
    expect(got).toEqual({ tool: 'search_notice', args: { keyword: '考试' }, reason: 'LLM 判定' });
  });

  it('容忍包裹在解释文字和 think 段里', () => {
    const raw = '好的<think>x</think>结果如下：{"tool":"get_schedule","args":{"day":"tomorrow"}} 以上。';
    expect(parseIntentsJson(raw)?.args).toEqual({ day: 'tomorrow' });
  });

  it('args 缺省时补空对象', () => {
    expect(parseIntentsJson('{"tool":"get_grades"}')?.args).toEqual({});
  });

  it('模型把没用到的参数写成 null 时剥掉（R1 常见）', () => {
    const raw = '{"tool":"find_free_room","args":{"date":null,"sections":null,"minSeats":null,"campus":null,"limit":[]}}';
    expect(parseIntentsJson(raw)?.args).toEqual({});
    const kept = parseIntentsJson('{"tool":"find_free_room","args":{"campus":"主校区","minSeats":100,"sections":[]}}');
    expect(kept?.args).toEqual({ campus: '主校区', minSeats: 100 });
  });

  it('参数类型不对时收敛：sections:5 → [5]，campus:1 丢掉', () => {
    const got = parseIntentsJson('{"tool":"find_free_room","args":{"campus":1,"sections":5,"minSeats":"100"}}');
    expect(got?.args).toEqual({ sections: [5], minSeats: 100 });
  });

  it('day 允许数字与字符串两种写法', () => {
    expect(parseIntentsJson('{"tool":"get_schedule","args":{"day":"3"}}')?.args).toEqual({ day: 3 });
    expect(parseIntentsJson('{"tool":"get_schedule","args":{"day":"tomorrow"}}')?.args).toEqual({ day: 'tomorrow' });
    expect(parseIntentsJson('{"tool":"get_schedule","args":{"day":"随便"}}')?.args).toEqual({});
  });

  it('tool 为 null 视为没听懂', () => {
    expect(parseIntentsJson('{"tool":null}')).toBeNull();
  });

  it('工具名不在白名单里 → null（不让模型乱造工具）', () => {
    expect(parseIntentsJson('{"tool":"drop_database"}')).toBeNull();
  });

  it('非 JSON → null', () => {
    expect(parseIntentsJson('我不知道')).toBeNull();
    expect(parseIntentsJson('{broken')).toBeNull();
  });
});

describe('llmChat', () => {
  it('带上 Bearer key 并剥掉 think', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '<think>嗯</think>收到' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const text = await llmChat(cfg, [{ role: 'user', content: 'hi' }]);
    expect(text).toBe('收到');
    expect(calls[0]?.url).toBe('http://chat.zzu.edu.cn/api/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ model: 'DeepSeek-R1', stream: false });
  });

  it('401 抛 LlmError 且标为鉴权失败，并把报错翻成人话', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: 'Your session has expired' }), { status: 401 })),
    );
    await expect(llmChat(cfg, [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      status: 401,
      isAuth: true,
    });
    await expect(llmChat(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /API Key 无效或已过期（Your session has expired）/,
    );
  });

  it('换服务商时打到对应地址，且模型名留空就用预设默认值', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
      }),
    );
    await llmChat({ provider: 'deepseek', apiKey: 'sk-x', model: '' }, [{ role: 'user', content: 'hi' }]);
    expect(calls[0]?.url).toBe('https://api.deepseek.com/chat/completions');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ model: 'deepseek-chat' });

    await llmChat({ provider: 'siliconflow', apiKey: 'sk-x', model: '' }, [{ role: 'user', content: 'hi' }]);
    expect(calls[1]?.url).toBe('https://api.siliconflow.cn/v1/chat/completions');
  });

  it('未知服务商回落到学校预设', async () => {
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push({ url });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
      }),
    );
    await llmChat({ provider: 'nope', apiKey: 'sk-x', model: 'm' }, [{ role: 'user', content: 'hi' }]);
    expect(calls[0]?.url).toBe('http://chat.zzu.edu.cn/api/chat/completions');
  });

  it('余额不足/限流各有各的说法', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Insufficient Balance"}}', { status: 402 })));
    await expect(llmChat(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/余额不足/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    await expect(llmChat(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/限流/);
  });

  it('没有 key 时不发请求', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(llmChat({ provider: 'school', apiKey: '', model: 'x' }, [])).rejects.toMatchObject({ status: 401 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('mintApiKey', () => {
  it('用页面会话换 sk- key（POST /api/v1/auths/api_key）', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ api_key: 'sk-abc123' }), { status: 200 });
      }),
    );
    await expect(mintApiKey('session.jwt.here')).resolves.toBe('sk-abc123');
    expect(calls[0]?.url).toBe('http://chat.zzu.edu.cn/api/v1/auths/api_key');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer session.jwt.here');
  });

  it('会话过期时抛鉴权错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"detail":"Your session has expired"}', { status: 401 })),
    );
    await expect(mintApiKey('expired.jwt.here')).rejects.toMatchObject({ status: 401, isAuth: true });
  });

  it('服务端没给 sk- 前缀时视为失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ api_key: 'oops' }), { status: 200 })));
    await expect(mintApiKey('session.jwt.here')).rejects.toThrow(/sk-/);
  });

  it('没有会话时不发请求', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(mintApiKey('')).rejects.toMatchObject({ status: 401 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('classifyIntent', () => {
  it('正常判定出意图', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"tool":"find_free_room","args":{"date":"2026-10-22"}}' } }] }), {
          status: 200,
        }),
      ),
    );
    const got = await classifyIntent('后天想找个安静地方看书', '2026-10-21', cfg);
    expect(got?.tool).toBe('find_free_room');
    expect(got?.args).toEqual({ date: '2026-10-22' });
  });

  it('没开开关或没 key 时直接返回 null（不发请求）', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await classifyIntent('随便问问', '2026-10-21', { ...cfg, enabled: false })).toBeNull();
    expect(await classifyIntent('随便问问', '2026-10-21', { ...cfg, apiKey: '' })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('网络挂了也返回 null，不把异常抛给上层', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await classifyIntent('明天有课吗', '2026-10-21', cfg)).toBeNull();
  });

  it('https 页面调 http 服务时直接放弃，不白等 30 秒', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    vi.stubGlobal('location', { protocol: 'https:' });
    expect(await classifyIntent('后天下午哪个屋子能看书', '2026-10-21', cfg)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    // 换成 https 服务商就该放行
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"tool":"get_grades"}' } }] }), { status: 200 })),
    );
    const got = await classifyIntent('我考得怎么样', '2026-10-21', { ...cfg, provider: 'deepseek' });
    expect(got?.tool).toBe('get_grades');
  });

  it('模型胡说八道时返回 null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '我觉得应该查成绩' } }] }), { status: 200 })),
    );
    expect(await classifyIntent('那个啥', '2026-10-21', cfg)).toBeNull();
  });
});
