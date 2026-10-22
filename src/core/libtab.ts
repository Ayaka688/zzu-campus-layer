/**
 * 与「图书馆空间预约」页面里的 content script 通信。
 *
 * 分工：
 * - 读座位/下单这些事必须带着**页面自己的登录态**（`sessionStorage.token`），
 *   而 `space/confirm` 还要用页面自己的 AES 加密，所以一律交给 content script；
 * - Service Worker 只负责找到那个标签页、发消息、把结果转成工具能用的形状。
 *
 * 找不到标签页不是错误，而是「这条路现在不能用」——调用方要能优雅降级。
 */

import { parseSeatMap, type LibSeatMap } from './library';

const LIB_URL_PATTERN = 'http://order.lib.zzu.edu.cn/*';

export interface LibTabResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function hasTabs(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.tabs?.query);
}

export async function findLibraryTab(): Promise<chrome.tabs.Tab | null> {
  if (!hasTabs()) return null;
  try {
    const tabs = await chrome.tabs.query({ url: LIB_URL_PATTERN });
    return tabs[0] ?? null;
  } catch {
    return null;
  }
}

async function send<T>(tabId: number, type: string, args: unknown): Promise<LibTabResult<T>> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type, args })) as LibTabResult<T> | undefined;
    if (!res) return { ok: false, error: '页面没有回应（可能刚刷新）。' };
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
      return { ok: false, error: '图书馆页面还没准备好，刷新一下那个标签页再试。' };
    }
    return { ok: false, error: msg };
  }
}

/** 读某个区域某天的座位图（需要那个标签页已经登录） */
export async function readLibrarySeats(args: {
  areaId: string;
  date: string;
}): Promise<LibTabResult<LibSeatMap & { raw?: unknown }>> {
  const tab = await findLibraryTab();
  if (!tab?.id) {
    return {
      ok: false,
      error:
        '要先在浏览器里打开并登录图书馆空间预约（order.lib.zzu.edu.cn），我才能读到座位图——那个站的登录态不在我校内 token 里。',
    };
  }
  const res = await send<{ map?: unknown; seat?: unknown; areaId?: string; date?: string }>(
    tab.id,
    'lib:probe',
    args,
  );
  if (!res.ok) return { ok: false, error: res.error ?? '读取失败' };
  const payload = res.data;
  const seatMap = parseSeatMap(payload?.seat ?? payload?.map ?? payload);
  return { ok: true, data: { ...seatMap, raw: payload } };
}

/** 执行预约（只能由用户长按确认后调用） */
export async function bookLibrarySeat(args: {
  areaId: string;
  date: string;
  seatNo: string;
}): Promise<LibTabResult<{ verified?: boolean; note?: string }>> {
  const tab = await findLibraryTab();
  if (!tab?.id) return { ok: false, error: '没有打开图书馆预约页面，没法代你下单。' };
  const res = await send<{ verified?: boolean; note?: string }>(tab.id, 'lib:book', args);
  if (!res.ok) return { ok: false, error: res.error ?? '下单失败' };
  return { ok: true, data: res.data };
}
