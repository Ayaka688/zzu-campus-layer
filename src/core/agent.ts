import { CampusService, CampusSession } from './services';
import { helpText, parseIntent, relativeDayOffset } from './intent';
import { classifyIntent, type LlmSettings } from './llm';
import { ToolName, runTool } from './tools';
import { addDays, weekdayOf } from './util';

export interface AskResult {
  text: string;
  tool?: ToolName;
  data?: Record<string, unknown>;
  error?: string;
  /** 意图来自哪里：规则 / 学校模型 / 都没命中 */
  via?: 'rule' | 'llm' | 'none';
}

export interface AskOptions {
  /** 学校模型配置；不传或 enabled=false 时退化成纯规则 */
  llm?: LlmSettings;
}

/**
 * 一句话的完整处理链：
 *   L0 规则解析 → （没命中）L1 学校模型判意图 → 取数 → 模板渲染
 * 模型只决定「调哪个工具」，内容永远来自学校接口的模板渲染。
 */
export async function ask(text: string, session: CampusSession, opts: AskOptions = {}): Promise<AskResult> {
  const today = session.today ?? new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);

  let intent = parseIntent(text, today);
  let via: AskResult['via'] = intent ? 'rule' : 'none';

  if (!intent && opts.llm?.enabled && opts.llm.apiKey) {
    const fromLlm = await classifyIntent(text, today, opts.llm);
    if (fromLlm) {
      intent = fromLlm;
      via = 'llm';
    }
  }

  if (!intent) {
    return { text: helpText(today), via: 'none' };
  }

  // 模型算日期不可靠（实测把「后天」算成明天），
  // 所以「今天/明天/后天/大后天」这类相对日期一律由规则层覆盖。
  if (via === 'llm') {
    const off = relativeDayOffset(text);
    if (off !== undefined) {
      if (intent.tool === 'find_free_room') intent.args.date = addDays(today, off);
      else if (intent.tool === 'get_schedule') intent.args.day = off === 0 ? 'today' : weekdayOf(addDays(today, off));
    }
  }

  const svc = new CampusService(session);
  try {
    const result = await runTool(intent.tool, intent.args, svc);
    return {
      text: result.text,
      tool: intent.tool,
      via,
      ...(result.data ? { data: result.data } : {}),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { text: `出错了：${message}`, tool: intent.tool, via, error: message };
  }
}
