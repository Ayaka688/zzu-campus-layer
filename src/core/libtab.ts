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
import type { BookOutcome } from './libBook';

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
/** 直接在页面里读 sessionStorage.token——绕开 content script 版本漂移 */
async function pageToken(tabId: number): Promise<string> {
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.sessionStorage.getItem('token') ?? '',
    });
    const v = out?.[0]?.result;
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/** 后台直接打图书馆接口（host_permissions 已含该域，SW 的 fetch 不受页面 CORS 限制） */
/** 把服务端返回浓缩成一行诊断：code / message / list 条数 / 是否含 day。 */
function describePayload(raw: unknown): string {
  const o = (raw ?? {}) as Record<string, unknown>;
  const data = (o.data ?? {}) as Record<string, unknown>;
  const list = (data.list ?? data.seats ?? []) as unknown[];
  const code = o.code ?? o.status ?? "?";
  const msg = typeof o.message === "string" ? o.message : typeof o.msg === "string" ? o.msg : "";
  const keys = Object.keys(data).slice(0, 6).join(",");
  return `code=${String(code)} msg=${msg || "-"} list=${Array.isArray(list) ? list.length : "非数组"} keys=${keys || "-"}`;
}

async function fetchSeatsDirect(areaId: string, day: string, token: string): Promise<unknown> {
  const res = await fetch('http://order.lib.zzu.edu.cn/v4/Space/seat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      authorization: 'bearer' + token,
    },
    body: JSON.stringify({
      id: areaId,
      day,
      label_id: [],
      start_time: '07:30',
      end_time: '22:30',
      begdate: '',
      enddate: '',
    }),
  });
  return res.json();
}

interface LibBridge {
  libSeats?: (areaId: string, date: string, reqId: string) => void;
  loginLibrary?: () => void;
}

interface LibWindow {
  CampusNotify?: LibBridge;
  __libSeats?: (reqId: string, json: string) => void;
  __libSeatWaiters?: Record<string, (json: string) => void>;
}

/** 安卓壳原生桥：CampusNotify.libSeats(areaId, date, reqId) → window.__libSeats(reqId, json)。 */
function bridgeNativeSeats(areaId: string, date: string): Promise<string> | null {
  const w = (typeof window === 'undefined' ? undefined : window) as LibWindow | undefined;
  const bridge = w?.CampusNotify;
  if (!w || !bridge || typeof bridge.libSeats !== 'function') return null;
  const reqId = 'lib' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
  w.__libSeatWaiters = w.__libSeatWaiters ?? {};
  w.__libSeats = (id: string, json: string) => {
    const fn = w.__libSeatWaiters?.[id];
    if (fn) {
      delete w.__libSeatWaiters![id];
      fn(json);
    }
  };
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      delete w.__libSeatWaiters![reqId];
      reject(new Error('图书馆接口超时（20 秒没回）'));
    }, 20_000);
    w.__libSeatWaiters![reqId] = (json: string) => {
      clearTimeout(timer);
      resolve(json);
    };
    bridge.libSeats!(areaId, date, reqId);
  });
}

export async function readLibrarySeats(args: {
  areaId: string;
  date: string;
}): Promise<
  LibTabResult<{
    seats: { no: string; status: string; free: boolean }[];
    areaId: string;
    tried: string[];
    raw?: unknown;
  }>
> {
  // 安卓壳：走原生桥（原生 HTTP 不受 CORS / 混合内容限制）
  const bridged = bridgeNativeSeats(args.areaId, args.date);
  if (bridged) {
    const json = await bridged;
    let outer: { ok?: boolean; error?: string; raw?: unknown };
    try {
      outer = JSON.parse(json) as { ok?: boolean; error?: string; raw?: unknown };
    } catch {
      return { ok: false, error: '原生桥返回的不是 JSON' };
    }
    if (!outer.ok) return { ok: false, error: outer.error ?? '图书馆接口失败' };
    return {
      ok: true,
      data: {
        seats: parseSeatMap(outer.raw).seats,
        areaId: args.areaId,
        tried: [args.areaId],
        diag: describePayload(outer.raw),
      },
    };
  }
  const tab = await findLibraryTab();
  if (!tab?.id) {
    return {
      ok: false,
      error:
        '图书馆座位图要用那个站自己的登录态，我这边拿不到。三步就能解决：\n1. 点下面「打开座位预约」进那个网站并登录（学校账号）\n2. 登录后回到这里，再说一次「一楼座位图」\n3. 如果你是在手机上（没有装浏览器扩展），那个页面请用系统浏览器打开登录，回来我仍然读不到——手机上只能看馆级余量，座位号需要电脑上的扩展。',
    };
  }

  // 模型给的 areaId 经常是「一楼」的另一个编码（storeys 里 2、payload 里 3），
  // 所以拿到空座位表就换下一个候选 id 再试——座位表非空才说明 id 对。
  const token = await pageToken(tab.id);
  const candidates = [args.areaId, '3', '4', '5', '6'].filter((v, i, a) => v && a.indexOf(v) === i);
  const tried: string[] = [];
  let empty: {
    seats: { no: string; status: string; free: boolean }[];
    areaId: string;
    tried: string[];
    raw?: unknown;
  } = {
    seats: [],
    areaId: args.areaId,
    tried,
  };
  for (const id of candidates) {
    tried.push(id);
    let payload: unknown;
    try {
      payload = await fetchSeatsDirect(id, args.date, token);
    } catch {
      payload = undefined;
    }
    let parsed = parseSeatMap(payload);
    if (parsed.seats.length === 0) {
      // 后台直连读不到时退回 content script（万一 token 在页面里但 SW 被拦）
      const res = await send<{ ok?: boolean; seat?: unknown; error?: string }>(tab.id, 'lib:probe', {
        areaId: id,
        date: args.date,
      });
      if (res.ok) {
        payload = res.data?.seat;
        parsed = parseSeatMap(payload);
      }
    }
    const here = { seats: parsed.seats, areaId: id, tried, raw: payload };
    if (parsed.seats.length > 0) return { ok: true, data: here };
    empty = here;
  }
  return { ok: true, data: empty };
}

export async function bookLibrarySeat(args: {
  areaId: string;
  date: string;
  seatNo: string;
}): Promise<LibTabResult<BookOutcome>> {
  const tab = await findLibraryTab();
  if (!tab?.id) return { ok: false, error: '没有打开图书馆预约页面，没法代你下单。' };
  const res = await send<BookOutcome>(tab.id, 'lib:book', args);
  if (!res.ok) return { ok: false, error: res.error ?? '下单失败' };
  return { ok: true, data: res.data };
}
