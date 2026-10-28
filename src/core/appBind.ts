/**
 * 绑定向导：一次短信验证，把这台设备的 deviceId 登记成可信设备。
 *
 * 为什么需要这一步：学校按 deviceId 认设备（见 docs/cas-long-term-token.md §10.2）。
 * 新 deviceId 第一次换票一定被要求 MFA；过一次，之后纯账密就能换 30 天票。
 *
 * 两条实现：
 *  - 扩展里：本文件直接 fetch（host_permissions 豁免 CORS）；
 *  - 安卓壳里：`cas.s.zzu.edu.cn` 不给 ACAO、预检还 403，浏览器里换不了票，所以交给
 *    原生 `CampusNotify.appBindStart/appBindSubmit` 发请求，结果经 `window.__campusBind(json)`
 *    回来。协议两边形同，只是谁发请求不一样。
 */
import { APP_UA, appDetect, type AppCreds } from './appMint';

const BASE = 'https://cas.s.zzu.edu.cn';

/** 按类型初始化 MFA（App 形态只有短信/联邦/人脸，没有二维码） */
export const APP_MFA_INIT_URL = `${BASE}/token/mfa/initByType/securephone`;
/** 短信下发/校验都在 attest 域下 */
export const APP_ATTEST = `${BASE}/attest/api/guard`;

/** `securephone/valid` 回来的 status：2 = 通过，3 = 码不对/已过期 */
export const MFA_STATUS_VALID = 2;

/** 一次绑定需要的上下文，`submitCode` 要用 */
export interface BindContext {
  state: string;
  gid: string;
  attest: string;
}

export type BindStart =
  | { ok: true; trusted: true }
  | { ok: true; trusted: false; ctx: BindContext; phone: string }
  | { ok: false; reason: 'network' | 'rejected'; detail?: string };

export type BindSubmit =
  | { ok: true; idToken?: string }
  | { ok: false; reason: 'code' | 'network'; detail?: string };

interface InitPayload {
  code?: number;
  message?: string;
  data?: { gid?: string; securePhone?: string; attestServerUrl?: string };
}

interface GuardPayload {
  code?: number;
  message?: string;
  data?: { result?: string; status?: number };
}

async function callJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; payload: unknown }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': APP_UA, ...(init.headers ?? {}) },
      signal: ac.signal,
      cache: 'no-store',
    });
    const payload: unknown = await res.json().catch(() => ({}));
    return { status: res.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

/** 取 gid / 手机号 / attest 域名。state 来自 detect。 */
export async function initSecurePhone(state: string, timeoutMs = 12_000): Promise<BindContext & { phone: string }> {
  const q = new URLSearchParams({ state });
  const { status, payload } = await callJson(
    `${APP_MFA_INIT_URL}?${q.toString()}`,
    { method: 'GET' },
    timeoutMs,
  );
  const body = payload as InitPayload;
  const gid = body.data?.gid ?? '';
  if (!gid) throw new Error(body.message ?? `初始化 MFA 失败：HTTP ${status}`);
  return {
    state,
    gid,
    attest: body.data?.attestServerUrl || APP_ATTEST,
    phone: body.data?.securePhone ?? '',
  };
}

/** 让它发短信。限流时 message 会是「验证码发送过于频繁…」。 */
export async function sendSmsCode(ctx: BindContext, timeoutMs = 12_000): Promise<{ ok: boolean; detail?: string }> {
  try {
    const { status, payload } = await callJson(
      `${ctx.attest}/api/guard/securephone/send`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gid: ctx.gid }),
      },
      timeoutMs,
    );
    const body = payload as GuardPayload;
    const ok = body.code === 0 && (body.data?.result === 'ok' || body.data?.status === 1);
    return ok ? { ok } : { ok, detail: body.message ?? `HTTP ${status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** 校验短信码。status === 2 才算过。 */
export async function checkSmsCode(
  ctx: BindContext,
  code: string,
  timeoutMs = 12_000,
): Promise<{ ok: boolean; detail?: string }> {
  const trimmed = code.replace(/\s+/g, '');
  if (!/^\d{4,8}$/.test(trimmed)) return { ok: false, detail: '验证码是 4~6 位数字' };
  try {
    const { status, payload } = await callJson(
      `${ctx.attest}/api/guard/securephone/valid`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gid: ctx.gid, code: trimmed }),
      },
      timeoutMs,
    );
    const body = payload as GuardPayload;
    const passed = body.code === 0 && body.data?.status === MFA_STATUS_VALID;
    return passed ? { ok: passed } : { ok: passed, detail: body.message ?? `验证码不对（status=${body.data?.status ?? status}）` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** 第一步：这台设备要不要验证？要不要就顺手把短信发出去。 */
export async function startBind(creds: AppCreds, timeoutMs = 12_000): Promise<BindStart> {
  try {
    const detect = await appDetect(creds, timeoutMs);
    if (!detect.need) return { ok: true, trusted: true };
    if (!detect.state) return { ok: false, reason: 'rejected', detail: '学校没给 MFA state' };
    const ctx = await initSecurePhone(detect.state, timeoutMs);
    const sent = await sendSmsCode(ctx, timeoutMs);
    if (!sent.ok) return { ok: false, reason: 'rejected', detail: sent.detail ?? '短信没发出去' };
    return { ok: true, trusted: false, ctx, phone: ctx.phone };
  } catch (err) {
    return { ok: false, reason: 'network', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** 第二步：校验码。过了这台设备就是可信设备（下一次 detect 会回 need:false）。 */
export async function submitCode(ctx: BindContext, code: string, timeoutMs = 12_000): Promise<BindSubmit> {
  const checked = await checkSmsCode(ctx, code, timeoutMs);
  if (!checked.ok) return { ok: false, reason: 'code', detail: checked.detail };
  return { ok: true };
}

// ---- 安卓壳里的那条路 ----

interface ShellBindBridge {
  appBindStart?(credsJson: string): void;
  appBindSubmit?(code: string): void;
  appBindCancel?(): void;
  lastCrash?(): string;
  clearCrash?(): void;
}

interface Shell {
  CampusNotify?: ShellBindBridge;
  __campusBind?: (raw: string) => void;
}

function shell(): Shell | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as Shell);
}

/** 壳里能不能做绑定向导（安卓 App；普通浏览器 / 扩展里都是 false）。 */
export function canBindInShell(): boolean {
  return typeof shell()?.CampusNotify?.appBindStart === 'function';
}

type ShellStep =
  | { step: 'code'; phone?: string; state?: string; gid?: string }
  | { step: 'done'; idToken?: string }
  | { step: 'error'; message?: string };

/** 挂一个只等一次的 `window.__campusBind`，把原生回调转成 Promise。 */
function waitShellStep(timeoutMs: number): Promise<ShellStep> {
  const w = shell();
  if (!w) return Promise.resolve({ step: 'error', message: '不在壳里' });
  return new Promise<ShellStep>((resolve) => {
    const done = (step: ShellStep): void => {
      clearTimeout(timer);
      delete w.__campusBind;
      resolve(step);
    };
    const timer = setTimeout(() => done({ step: 'error', message: '壳没有回应（超时）' }), timeoutMs);
    w.__campusBind = (raw: string): void => {
      try {
        done(JSON.parse(raw) as ShellStep);
      } catch {
        done({ step: 'error', message: '壳回的数据看不懂' });
      }
    };
  });
}

/** 壳里第一步：原生 detect → init → send。 */
export async function startBindInShell(creds: AppCreds, timeoutMs = 20_000): Promise<BindStart> {
  const bridge = shell()?.CampusNotify;
  if (typeof bridge?.appBindStart !== 'function') return { ok: false, reason: 'network', detail: '不在壳里' };
  const wait = waitShellStep(timeoutMs);
  bridge.appBindStart(JSON.stringify(creds));
  const step = await wait;
  if (step.step === 'error') return { ok: false, reason: 'network', detail: step.message };
  if (step.step === 'done') return { ok: true, trusted: true };
  return {
    ok: true,
    trusted: false,
    ctx: { state: step.state ?? '', gid: step.gid ?? '', attest: APP_ATTEST },
    phone: step.phone ?? '',
  };
}

/** 壳里第二步：原生校验（过了原生会顺手换一张 30 天票，idToken 一起回来）。 */
export async function submitCodeInShell(code: string, timeoutMs = 25_000): Promise<BindSubmit> {
  const bridge = shell()?.CampusNotify;
  if (typeof bridge?.appBindSubmit !== 'function') return { ok: false, reason: 'network', detail: '不在壳里' };
  const wait = waitShellStep(timeoutMs);
  bridge.appBindSubmit(code);
  const step = await wait;
  if (step.step === 'error') return { ok: false, reason: 'code', detail: step.message };
  if (step.step === 'done') return { ok: true, ...(step.idToken ? { idToken: step.idToken } : {}) };
  return { ok: false, reason: 'code', detail: '码还没过' };
}

/**
 * 壳上次「闪退」的栈文本（壳里才有）。没有崩溃过、或不在壳里都返回空串。
 *
 * <p>手机上没有 logcat，用户能提供的只有一句「闪退了」；把栈摆到设置页里，
 * 至少能让下一次排障有据可查。
 */
export function shellLastCrash(): string {
  const bridge = shell()?.CampusNotify;
  if (typeof bridge?.lastCrash !== 'function') return '';
  try {
    const text = bridge.lastCrash();
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/** 用户点「已读」后清掉壳里记的崩溃文本。 */
export function clearShellCrash(): void {
  const bridge = shell()?.CampusNotify;
  if (typeof bridge?.clearCrash !== 'function') return;
  try {
    bridge.clearCrash();
  } catch {
    // 壳版本老、没这个方法：忽略
  }
}
