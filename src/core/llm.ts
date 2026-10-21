/**
 * LLM 接入层：默认是学校自带的 Open WebUI（chat.zzu.edu.cn），
 * 也可以换成任意 OpenAI 兼容服务商（用户自己填 key）。
 *
 * 定位：**只做意图分类**，绝不生成课表/通知内容。
 * 原因见 docs/school-llm-evaluation.md：数据必须来自学校接口，幻觉不能进渲染层。
 *
 * 硬约束（都是实测，见 docs/deploy-pwa.md）：
 *  - 学校服务只在校园网内可达（内网 10.67.16.3），而且是 **http**；
 *    HTTPS 页面调用会被浏览器按混合内容拦掉 —— 只影响学校这一个预设；
 *  - 第三方服务商（DeepSeek 官方/硅基流动/百炼/Moonshot/OpenRouter）都是 https，
 *    已逐个验证 CORS 放行，纯前端可直连；
 *  - key 一律由用户自己提供，不内置、不上传。
 */
import { z } from 'zod';
import type { Intent } from './intent';
import { TOOLS } from './tools';
import { weekdayOf } from './util';

/** 学校 WebUI 的地址（用于预设与「一键换 key」）。 */
export const LLM_BASE = 'http://chat.zzu.edu.cn';
export const DEFAULT_MODEL = 'DeepSeek-R1';

export interface LlmProvider {
  id: string;
  label: string;
  /** OpenAI 兼容 base（不含 /chat/completions） */
  baseUrl: string;
  /** 预设模型名，用户可以改 */
  model: string;
  /** 只有校园网 / VPN 可达 */
  campusOnly?: boolean;
  /** 界面上的一句提示 */
  hint?: string;
}

export const LLM_PROVIDERS: LlmProvider[] = [
  {
    id: 'school',
    label: '学校 DeepSeek（校园网）',
    // 学校这层是 Open WebUI，接口挂在 /api 下（/api/chat/completions）
    baseUrl: `${LLM_BASE}/api`,
    model: DEFAULT_MODEL,
    campusOnly: true,
    hint: '免费，但只有校园网 / VPN 能连；HTTPS 页面会被混合内容拦掉。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    hint: '便宜又快，非推理模型更适合判意图。',
  },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { id: 'dashscope', label: '阿里百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'moonshot', label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
];

export const DEFAULT_PROVIDER = 'school';

/** 按 id 取预设；未知 id 回落到第一个（学校）。 */
export function resolveProvider(id: string | undefined): LlmProvider {
  return LLM_PROVIDERS.find((p) => p.id === id) ?? (LLM_PROVIDERS[0] as LlmProvider);
}

/** 拼出 /chat/completions 地址（容忍预设里带尾斜杠）。 */
export function chatEndpoint(provider: LlmProvider): string {
  return `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/** 当前页面是不是 HTTPS（SW 与页面里都能用；node 测试里当 false）。 */
function isHttpsPage(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

export interface LlmSettings {
  enabled: boolean;
  provider: string;
  apiKey: string;
  /** 留空则用预设默认模型 */
  model: string;
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  enabled: false,
  provider: DEFAULT_PROVIDER,
  apiKey: '',
  model: DEFAULT_MODEL,
};

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 去掉 DeepSeek-R1 的推理段（`<think>…</think>`），只留答案。 */
export function stripThink(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|?thinking\|?>[\s\S]*?<\|\/?thinking\|?>/gi, '')
    .trim();
}

export class LlmError extends Error {
  readonly status: number;
  readonly isAuth: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.isAuth = status === 401 || status === 403;
  }
}

export interface ChatOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 把服务商的 HTTP 错误翻成人话（401/402/403/404/429 各有不同含义）。 */
function friendlyHttpError(status: number, raw: string, provider: LlmProvider): string {
  const detail = raw.trim().slice(0, 200) || `HTTP ${status}`;
  switch (status) {
    case 401:
      return `${provider.label} 的 API Key 无效或已过期（${detail}）`;
    case 402:
      return `${provider.label} 余额不足（${detail}）`;
    case 403:
      return `${provider.label} 拒绝了这个请求，可能是地域或额度限制（${detail}）`;
    case 404:
      return `${provider.label} 没有这个接口，或模型名不对（${detail}）`;
    case 429:
      return `${provider.label} 触发限流，等一会儿再试（${detail}）`;
    default:
      return detail;
  }
}

/** 调一次对话补全，返回纯文本（已剥掉 think 段）。 */
export async function llmChat(
  cfg: Pick<LlmSettings, 'provider' | 'apiKey' | 'model'>,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  const provider = resolveProvider(cfg.provider);
  if (!cfg.apiKey) throw new LlmError(401, '还没有填 API Key');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(chatEndpoint(provider), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model.trim() || provider.model,
        messages,
        stream: false,
      }),
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = raw.slice(0, 200);
      try {
        const j = JSON.parse(raw) as { detail?: string; error?: { message?: string } };
        if (typeof j.detail === 'string') msg = j.detail;
        else if (typeof j.error?.message === 'string') msg = j.error.message;
      } catch {
        /* 保留原文 */
      }
      throw new LlmError(res.status, friendlyHttpError(res.status, msg, provider));
    }
    const json = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    return stripThink(content);
  } catch (e) {
    if (e instanceof LlmError) throw e;
    const name = (e as { name?: string }).name;
    if (name === 'AbortError') {
      throw new LlmError(408, `${provider.label} 超时（${Math.round((opts.timeoutMs ?? 20_000) / 1000)}s）`);
    }
    // 混合内容是浏览器硬拦，报错里看不出原因，这里直接说人话
    if (provider.baseUrl.startsWith('http:') && isHttpsPage()) {
      throw new LlmError(
        0,
        `${provider.label} 是 http 服务，HTTPS 页面调不了（混合内容限制）。换成 https 的服务商，或在校园网里用 http 打开。`,
      );
    }
    throw new LlmError(
      0,
      provider.campusOnly
        ? `连不上 ${provider.label}（只有校园网 / VPN 可达）：${(e as Error).message}`
        : `连不上 ${provider.label}：${(e as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 用页面里的登录会话（WebUI 的 JWT）换一个长期 API Key；不用手动粘贴。 */
export async function mintApiKey(sessionToken: string, opts: ChatOptions = {}): Promise<string> {
  if (!sessionToken) throw new LlmError(401, '还没有登录 chat.zzu.edu.cn 的会话');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`${LLM_BASE}/api/v1/auths/api_key`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sessionToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new LlmError(res.status, raw.slice(0, 200) || '换取 API Key 失败');
    const json = JSON.parse(raw) as { api_key?: string };
    const key = (json.api_key ?? '').trim();
    if (!key.startsWith('sk-')) throw new LlmError(0, '服务端没返回 sk- key');
    return key;
  } catch (e) {
    if (e instanceof LlmError) throw e;
    const name = (e as { name?: string }).name;
    if (name === 'AbortError') throw new LlmError(408, '超时（可能不在校园网）');
    throw new LlmError(0, `连不上 chat.zzu.edu.cn：${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

const TOOL_NAMES = Object.keys(TOOLS) as Array<keyof typeof TOOLS>;

const intentSchema = z.object({
  tool: z.union([z.enum(TOOL_NAMES as [string, ...string[]]), z.null()]),
  args: z.record(z.unknown()).optional(),
});

const INT_ARGS = new Set(['minSeats', 'week', 'fromWeek', 'limit']);
const ARR_ARGS = new Set(['sections']);
const STR_ARGS = new Set(['campus', 'keyword', 'date']);

/**
 * 模型给的 args 类型常常不对（`campus: 1`、`sections: 5`、`minSeats: "100"`）。
 * 这里按已知的工具参数类型做一次保守收敛，收不动的直接丢掉，
 * 最后再用工具自己的 zod schema 校验，失败就退回空参数。
 */
function coerceArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined || v === '') continue;
    if (ARR_ARGS.has(k)) {
      const arr = Array.isArray(v) ? v : [v];
      const nums = arr.map((x) => Number(x)).filter((n) => Number.isFinite(n));
      if (nums.length) out[k] = nums;
      continue;
    }
    if (k === 'day') {
      if (v === 'today' || v === 'tomorrow') out[k] = v;
      else {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 1 && n <= 7) out[k] = n;
      }
      continue;
    }
    if (INT_ARGS.has(k)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = Math.trunc(n);
      continue;
    }
    if (STR_ARGS.has(k)) {
      // campus: 1 这种「类型对不上语义」的值没有意义，丢掉比猜好
      if (typeof v !== 'string') continue;
      const s = v.trim();
      if (s) out[k] = s;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** 从模型输出里抠出第一个完整 JSON 对象并校验。解析失败 → null。 */
export function parseIntentsJson(raw: string): Intent | null {
  const text = stripThink(raw);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const check = intentSchema.safeParse(parsed);
  if (!check.success) return null;
  const { tool } = check.data;
  if (!tool) return null;
  // 模型爱把没用到的参数写成 null（DeepSeek-R1 尤其），先剥掉再收敛类型。
  const args = coerceArgs(check.data.args ?? {});
  const schema = (TOOLS[tool as keyof typeof TOOLS] as { schema: z.ZodType<unknown> }).schema;
  const first = schema.safeParse(args);
  if (first.success) return { tool: tool as Intent['tool'], args: args, reason: 'LLM 判定' };
  const fallback = schema.safeParse({});
  if (!fallback.success) return null;
  return { tool: tool as Intent['tool'], args: {}, reason: 'LLM 判定（参数已丢弃）' };
}

function buildSystemPrompt(today: string): string {
  return [
    '你是校园信息层的意图解析器。把用户的一句话转成严格 JSON，不要输出任何解释或 markdown。',
    '',
    '可用工具与参数：',
    '- get_schedule：课表。args: { week?: number(1-20), day?: "today"|"tomorrow"|1-7 }',
    '- find_free_room：空教室/自习室。args: { date?: "YYYY-MM-DD", sections?: number[], minSeats?: number, campus?: string }',
    '- search_notice：通知公告。args: { keyword?: string, limit?: number }',
    '- get_grades：成绩/绩点。args: {}',
    '- get_exams：考试安排。args: {}',
    '- export_ics：导出日历。args: { fromWeek?: number }',
    '- get_plan_progress：培养方案学分进度（还差多少学分、哪些课没修）。args: {}',
    '- get_card：校园一卡通余额与最近流水。args: {}',
    '- get_todos：待办事项。args: {}',
    '- open_service：打开学校某个在线服务（座位预约、网上办事大厅、图书馆…）。args: { keyword: string }',
    '',
    '输出格式：{"tool":"工具名","args":{...}}',
    '没用到的参数直接省略，不要写 null。',
    '判断不了就输出 {"tool":null}。宁可返回 null 也不要猜。',
    `今天是 ${today}（周${'一二三四五六日'[weekdayOf(today) - 1] ?? '?'}）。`,
  ].join('\n');
}

/** L1：规则没命中时，用模型判一次意图。任何异常都返回 null（回落反问）。 */
export async function classifyIntent(
  text: string,
  today: string,
  cfg: LlmSettings,
  opts: ChatOptions = {},
): Promise<Intent | null> {
  if (!cfg.enabled || !cfg.apiKey) return null;
  const provider = resolveProvider(cfg.provider);
  // https 页面调 http 服务必被浏览器拦，别白等 30 秒
  if (provider.baseUrl.startsWith('http:') && isHttpsPage()) return null;
  let answer: string;
  try {
    // R1 带推理段，实测一次 11–25s；这里给到 30s，超时就当判不出（回落反问）。
    answer = await llmChat(cfg, [
      { role: 'system', content: buildSystemPrompt(today) },
      { role: 'user', content: text },
    ], { timeoutMs: opts.timeoutMs ?? 30_000, ...opts });
  } catch {
    return null;
  }
  return parseIntentsJson(answer);
}
