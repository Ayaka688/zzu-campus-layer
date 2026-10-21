import { afterEach, describe, expect, it, vi } from 'vitest';
import { ask } from '../src/core/agent';

const LLM_ON = { enabled: true, provider: 'deepseek', apiKey: 'sk-test', model: 'deepseek-chat' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ask 的降级路径', () => {
  it('规则没命中 + 模型 401 → 仍然给帮助文案，但要带 llmError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })));
    const got = await ask('那个啥呀', { jwxtToken: 'x', today: '2026-10-21' }, { llm: LLM_ON });
    expect(got.via).toBe('none');
    expect(got.text).toContain('可以'); // helpText
    expect(got.llmError).toContain('API Key 无效');
  });

  it('模型没开时不该有 llmError（用户自己关的，不用报警）', async () => {
    const got = await ask('那个啥呀', { jwxtToken: 'x', today: '2026-10-21' });
    expect(got.via).toBe('none');
    expect(got.llmError).toBeUndefined();
  });

  it('规则命中时根本不问模型', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    // 只断言「没发模型请求」：真正取数的请求会打到学校接口，测试环境里会失败但不影响这个断言
    await ask('我卡里还有多少钱', { jwxtToken: 'x', today: '2026-10-21' }, { llm: LLM_ON }).catch(() => undefined);
    const calledWithLlm = spy.mock.calls.some((c) => String(c[0]).includes('api.deepseek.com'));
    expect(calledWithLlm).toBe(false);
  });

  it('模型判出工具但取数失败时，error 要有内容', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"tool":"get_todos"}' } }] }), { status: 200 })),
    );
    // 换一句 L0 一定认不出的说法，确保走到 L1
    const got = await ask('还有啥没弄完的', { jwxtToken: 'bad', today: '2026-10-21' }, { llm: LLM_ON });
    expect(got.via).toBe('llm');
    expect(got.error ?? got.text).toBeTruthy();
  });
});

describe('ask 的自由回答（模型不只是判意图）', () => {
  it('「hello」这种话直接由模型作答，不再甩功能清单', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '你好，我是校园助手，可以直接问我课表或空教室。' } }] }), {
          status: 200,
        }),
      ),
    );
    const got = await ask('hello', { jwxtToken: 'x', today: '2026-10-21' }, { llm: LLM_ON });
    expect(got.via).toBe('llm-chat');
    expect(got.text).toContain('你好');
    expect(got.text).not.toContain('我可以直接回答这几类问题');
  });

  it('模型回 {"reply":…} 也认', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":"我在，想查什么？"}' } }] }), { status: 200 }),
      ),
    );
    const got = await ask('在吗', { jwxtToken: 'x', today: '2026-10-21' }, { llm: LLM_ON });
    expect(got.via).toBe('llm-chat');
    expect(got.text).toBe('我在，想查什么？');
  });

  it('模型啥也没说清时仍回落帮助文案（并带原因）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{bad json' } }] }), { status: 200 })),
    );
    const got = await ask('那啥', { jwxtToken: 'x', today: '2026-10-21' }, { llm: LLM_ON });
    expect(got.via).toBe('none');
    expect(got.llmError ?? '').toContain('模型');
  });
});
