import { ask } from '../core/agent';
import { CampusService } from '../core/services';
import {
  ensureValidToken,
  clearTokens,
  exportTokenBundle,
  getChatSession,
  getLlmSettings,
  loadSession,
  saveChatSession,
  setLlmSettings,
  tokenStatuses,
  type LlmSettingsStored,
  type TokenSource,
} from '../core/storage';
import { mintApiKey, probeLlm, resolveProvider } from '../core/llm';
import { TOOLS, runTool } from '../core/tools';

type Incoming =
  | { type: 'token'; source: TokenSource | 'chat'; token: string; reason?: string }
  | { type: 'ask'; text: string }
  | { type: 'status' }
  | { type: 'clear' }
  | { type: 'tool'; tool: keyof typeof TOOLS; args?: unknown }
  | { type: 'settings:get' }
  | { type: 'settings:set'; patch: Partial<LlmSettingsStored> }
  | { type: 'llm:test'; patch?: Partial<LlmSettingsStored> }
  | { type: 'chat:sync' }
  | { type: 'bundle:export' }
  | { type: 'ping' };

interface Reply<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

function installSidePanelBehaviour(): void {
  void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(installSidePanelBehaviour);
chrome.runtime.onStartup.addListener(installSidePanelBehaviour);

async function handle(message: Incoming): Promise<Reply> {
  switch (message.type) {
    case 'token':
      if (message.source === 'chat') {
        await saveChatSession(message.token);
        // 拿到 WebUI 会话后顺手换一个 sk- key（已有 key 就不动，避免覆盖用户手填的）
        const cfg = await getLlmSettings();
        if (cfg.apiKey) return { ok: true, data: { saved: true, keyFilled: false } };
        try {
          const key = await mintApiKey(message.token);
          await setLlmSettings({ apiKey: key });
          return { ok: true, data: { saved: true, keyFilled: true } };
        } catch (e) {
          return { ok: true, data: { saved: true, keyFilled: false, why: (e as Error).message } };
        }
      }
      return { ok: true, data: { saved: await ensureValidToken(message.source, message.token) } };
    case 'chat:sync': {
      const session = await getChatSession();
      if (!session) {
        return { ok: false, error: '没读到 DeepSeek 页面：先在同一个浏览器打开 http://chat.zzu.edu.cn 并登录。' };
      }
      try {
        const key = await mintApiKey(session.token);
        // 一键换来的必然是学校 WebUI 的 key，顺手把服务商拨回学校
        return { ok: true, data: await setLlmSettings({ provider: 'school', apiKey: key }) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    case 'status':
      return { ok: true, data: await tokenStatuses() };
    case 'clear':
      await clearTokens();
      return { ok: true };
    case 'ask': {
      const session = await loadSession();
      if (!session.jwxtToken && !session.portalToken) {
        return {
          ok: false,
          error: '还没有 token。请先在本机登录一次「豫见郑大」或「教学管理平台」，扩展会自动采集。',
        };
      }
      const llm = await getLlmSettings();
      let result = await ask(message.text, session, { llm });

      // 学校那边的 sk- key 会失效（会话过期/被重置）。手上有 WebUI 会话就自动换一次再重试，
      // 免得用户看到「API Key 无效」还得自己去设置里点同步。
      if (result.llmError && resolveProvider(llm.provider).id === 'school') {
        const chat = await getChatSession();
        if (chat?.token) {
          try {
            const key = await mintApiKey(chat.token);
            const next = await setLlmSettings({ apiKey: key, enabled: true });
            result = await ask(message.text, session, { llm: next });
            result = { ...result, ...(result.llmError ? {} : { llmRefreshed: true }) };
          } catch {
            /* 换不到就保留原来的错误 */
          }
        }
      }
      return { ok: true, data: result };
    }
    case 'settings:get':
      return { ok: true, data: await getLlmSettings() };
    case 'settings:set':
      return { ok: true, data: await setLlmSettings(message.patch ?? {}) };
    case 'llm:test': {
      // 先落盘（用户可能刚改完还没失焦），再用最新的配置试一次
      const cfg = message.patch ? await setLlmSettings(message.patch) : await getLlmSettings();
      return { ok: true, data: await probeLlm(cfg) };
    }
    case 'bundle:export':
      try {
        return { ok: true, data: await exportTokenBundle() };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    case 'tool': {
      const session = await loadSession();
      if (!session.jwxtToken && !session.portalToken) {
        return { ok: false, error: '还没有 token，请先登录一次校园系统。' };
      }
      const out = await runTool(message.tool, message.args ?? {}, new CampusService(session));
      return { ok: true, data: out };
    }
    case 'ping':
      return { ok: true, data: 'pong' };
    default:
      return { ok: false, error: '未知消息类型' };
  }
}

chrome.runtime.onMessage.addListener((message: Incoming, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return false;
  handle(message)
    .then(sendResponse)
    .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true;
});

chrome.alarms.create('heartbeat', { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') void tokenStatuses();
});
