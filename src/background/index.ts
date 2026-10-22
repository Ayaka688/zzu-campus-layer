import { todayShanghai } from '../core/util';
import { ask } from '../core/agent';
import { buildDigest, dueItems, gradeFingerprint, newGradeNames } from '../core/watch';
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
  getWatchState,
  setWatchState,
} from '../core/storage';
import { mintApiKey, probeLlm, resolveProvider } from '../core/llm';
import { bookLibrarySeat, findLibraryTab } from '../core/libtab';
import { TOOLS, runTool } from '../core/tools';

type Incoming =
  | { type: 'token'; source: TokenSource | 'chat'; token: string; reason?: string }
  | { type: 'ask'; text: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> }
  | { type: 'status' }
  | { type: 'clear' }
  | { type: 'tool'; tool: keyof typeof TOOLS; args?: unknown }
  | { type: 'settings:get' }
  | { type: 'settings:set'; patch: Partial<LlmSettingsStored> }
  | { type: 'llm:test'; patch?: Partial<LlmSettingsStored> }
  | { type: 'chat:sync' }
  | { type: 'bundle:export' }
  | { type: 'lib:book'; args: { areaId: string; date: string; seatNo: string } }
  | { type: 'lib:status' }
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
      const extra = { llm, ...(message.history?.length ? { history: message.history } : {}) };
      let result = await ask(message.text, session, extra);

      // 学校那边的 sk- key 会失效（会话过期/被重置）。手上有 WebUI 会话就自动换一次再重试，
      // 免得用户看到「API Key 无效」还得自己去设置里点同步。
      if (result.llmError && resolveProvider(llm.provider).id === 'school') {
        const chat = await getChatSession();
        if (chat?.token) {
          try {
            const key = await mintApiKey(chat.token);
            const next = await setLlmSettings({ apiKey: key, enabled: true });
            result = await ask(message.text, session, { ...extra, llm: next });
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
    case 'lib:book': {
      const out = await bookLibrarySeat(message.args);
      if (!out.ok) return { ok: false, error: out.error ?? '下单失败' };
      const d = out.data ?? {};
      return {
        ok: true,
        data: {
          text: d.verified
            ? `座位 **${message.args.seatNo}** 预约成功（页面出现了成功提示）。`
            : `已经点过确认，但没看到成功提示，请去标签页核对一下座位 ${message.args.seatNo}。`,
          data: { ...d, seatNo: message.args.seatNo, date: message.args.date },
        },
      };
    }
    case 'lib:status': {
      const tab = await findLibraryTab();
      return { ok: true, data: { open: Boolean(tab), url: tab?.url ?? null } };
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


/** 每天一次：看有没有新出分、有没有快到期的通知，有就推系统通知 */
async function dailyWatch(): Promise<void> {
  const session = await loadSession();
  if (!session.jwxtToken && !session.portalToken) return;

  const today = todayShanghai();
  const state = await getWatchState();
  if (state.notifiedOn === today) return; // 一天一次

  const svc = new CampusService(session);
  const grades: unknown[] = [];
  const notices: { id: string; title: string; summary?: string }[] = [];

  try {
    const g = await svc.grades();
    grades.push(...(g as unknown[]));
  } catch {
    /* 没成绩权限就算了，不影响截止提醒 */
  }
  try {
    const n = await svc.notices({ limit: 20 });
    for (const item of n as unknown[]) {
      const o = item as Record<string, unknown>;
      const id = String(o.id ?? o.title ?? '');
      const title = String(o.title ?? '');
      if (!id || !title) continue;
      notices.push({
        id,
        title,
        ...(typeof o.summary === 'string' ? { summary: o.summary } : {}),
      });
    }
  } catch {
    /* 通知拿不到也算了 */
  }

  const fp = gradeFingerprint(grades);
  const fresh = state.gradeFp !== undefined && fp ? newGradeNames(grades, state.gradeFp) : [];
  const dues = dueItems(notices, today, 7);
  const digest = buildDigest({ today, dues, newGrades: fresh });

  if (digest && typeof chrome !== 'undefined' && chrome.notifications) {
    chrome.notifications.create(`watch-${today}`, {
      type: 'basic',
      iconUrl: 'icons/icon-192.png',
      title: digest.title,
      message: digest.body,
    });
  }

  await setWatchState({
    ...(fp ? { gradeFp: fp } : {}),
    ...(digest ? { notifiedOn: today } : {}),
  });
}

chrome.alarms.create('heartbeat', { periodInMinutes: 30 });
// 早 9 点后随便什么时候跑一次；periodInMinutes 保证扩展重装后也会再次拉起
chrome.alarms.create('daily-watch', { periodInMinutes: 6 * 60 });
void dailyWatch();
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') void tokenStatuses();
  if (alarm.name === 'daily-watch') void dailyWatch();
});
