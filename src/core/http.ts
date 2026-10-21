/**
 * 三个后端、三套响应信封，统一成一个调用入口。
 *
 * 实测要点（见 docs/campus-site-probe.md）：
 * - 鉴权走 `X-Id-Token` 头，不依赖 cookie，响应带 `access-control-allow-origin: *`。
 * - 业务失败**不体现在 HTTP 状态码**上：未登录是 200 + `{code:-1,...}`，
 *   缺参是 200 + `{code:500,...}`，所以必须解业务码。
 */

export const PORTAL_API = 'https://info.s.zzu.edu.cn/portal-api';
export const EAMS_DOOR = 'https://jwxt.zzu.edu.cn/eams-door/api/v1';
export const EAMS_MICRO = 'https://jwxt.zzu.edu.cn/eams-micro-server/api/v1';
/** 办事/待办（事务中心） */
export const TTC_API = 'https://transaction.s.zzu.edu.cn/ttc';
/** 消息中心（未读数） */
export const MESSAGE_API = 'https://message-service.s.zzu.edu.cn/center';

export class ApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  constructor(message: string, status = 0, code?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
  /** 未登录 / token 失效（服务端用 code -1 表达） */
  get isAuth(): boolean {
    return this.code === -1 || /没有访问权限|登录/.test(this.message);
  }
}

export type Source = 'portal' | 'jwxt';

/** 给用户看的一句话，而不是 let 出 HTTP 401 这种。 */
export function authHint(source: Source): string {
  return source === 'jwxt'
    ? '教务登录态已失效，请重新打开 https://jwxt.zzu.edu.cn 登录一次'
    : '门户登录态已失效，请重新打开 https://uniapp.s.zzu.edu.cn 登录一次';
}

interface SendOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  token: string;
  source: Source;
  /** 部分接口要求表单编码；默认 JSON */
  form?: boolean;
  signal?: AbortSignal;
}

function baseHeaders(source: Source, token: string, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Id-Token': token,
    'X-Terminal-Info': 'h5',
    'X-Device-Info': 'PCWin32NT',
    Accept: 'application/json, text/plain, */*',
  };
  if (json) headers['content-type'] = 'application/json';
  else headers['content-type'] = 'application/x-www-form-urlencoded';
  if (source === 'portal') headers.Origin = 'https://uniapp.s.zzu.edu.cn';
  else headers.Origin = 'https://jwxt.zzu.edu.cn';
  return headers;
}

interface EnvelopeShape {
  code?: number;
  result?: number;
  success?: boolean;
  data?: unknown;
  message?: string;
  msg?: string;
}

function isEnvelope(v: unknown): v is EnvelopeShape {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return 'code' in o || 'result' in o;
}

/** 解信封。code/result 为 0 或 code 为 200 视为成功。 */
export function unwrap<T>(json: unknown, source: Source = 'jwxt'): T {
  if (isEnvelope(json)) {
    const code = json.code ?? json.result;
    const ok = code === 0 || code === 200 || json.success === true;
    if (!ok) {
      const message = json.message ?? json.msg ?? `接口返回 code=${String(code)}`;
      const isAuth = code === -1 || /没有访问权限|登录/.test(String(message));
      throw new ApiError(isAuth ? authHint(source) : String(message), 200, typeof code === 'number' ? code : undefined);
    }
    if ('data' in json) return json.data as T;
  }
  return json as T;
}

export async function send<T>(url: string, opts: SendOptions): Promise<T> {
  const method = opts.method ?? 'GET';
  const json = method === 'POST' && opts.body !== undefined && !opts.form;
  const init: RequestInit = {
    method,
    headers: baseHeaders(opts.source, opts.token, json),
    credentials: 'omit',
    cache: 'no-store',
  };
  if (method === 'POST' && opts.body !== undefined) {
    init.body = json ? JSON.stringify(opts.body) : new URLSearchParams(opts.body as Record<string, string>).toString();
  }
  if (opts.signal) init.signal = opts.signal;

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new ApiError(`网络错误：${(e as Error).message}`, 0);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(`响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`, res.status);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(authHint(opts.source), res.status);
  }
  return unwrap<T>(parsed, opts.source);
}

export function get<T>(base: string, path: string, opts: Omit<SendOptions, 'method' | 'body'>): Promise<T> {
  return send<T>(base + path, { ...opts, method: 'GET' });
}

export function post<T>(
  base: string,
  path: string,
  body: unknown,
  opts: Omit<SendOptions, 'method' | 'body'>,
): Promise<T> {
  return send<T>(base + path, { ...opts, method: 'POST', body });
}
