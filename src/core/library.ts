/**
 * 图书馆空间预约（`order.lib.zzu.edu.cn`）的**免登录**部分。
 *
 * 实测（2026-10-22，校内网）：
 * - `POST /v4/space/index` 不需登录，返回 4 个馆 + 楼层 + 座位类型 + 可选日期；
 * - `POST /v4/space/pcTopFor` 不需登录，返回每个馆的 **实时总数/空闲数**（主校区 2527 / 930）；
 * - `POST /v4/Space/map`（座位图）、`/v4/space/confirm`（下单）**必须登录**，
 *   而登录用的就是统一身份认证的学号+密码（见 `/v4/index/bookingRules` 原文），
 *   所以扩展不碰账号密码，只给实时余位 + 直达链接。
 *
 * 只支持 http（443 拒绝连接），且仅校内网可达——校外用户会拿到明确的错误文案。
 */

export const LIB_BASE = 'http://order.lib.zzu.edu.cn';

export interface LibraryPremise {
  id: string;
  name: string;
  total: number;
  free: number;
  /** 楼层（`children`）——「一楼还有位置吗」用得上 */
  floors?: LibraryFloor[];
}

export interface LibraryFloor {
  id: string;
  name: string;
  total: number;
  free: number;
}

export interface LibrarySeats {
  date: string;
  dates: string[];
  premises: LibraryPremise[];
  /** 直达「某馆某天」的座位页（需要登录才能下单，但看得到平面图） */
  url: string;
}

interface RawPremise {
  id?: string | number;
  name?: string;
  total_num?: string | number;
  free_num?: string | number;
  children?: RawPremise[];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function librarySeatUrl(premiseId: string, date: string): string {
  return `${LIB_BASE}/h5/index.html#/seat/space?id=${encodeURIComponent(premiseId)}&date=${encodeURIComponent(date)}`;
}

export async function librarySeats(opts: { date?: string } = {}): Promise<LibrarySeats> {
  const date = opts.date ?? '';
  let res: Response;
  try {
    res = await fetch(`${LIB_BASE}/v4/space/pcTopFor`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: LIB_BASE,
        referer: `${LIB_BASE}/h5/`,
      },
      body: JSON.stringify({ id: '1', ...(date ? { date } : {}) }),
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`连不上图书馆预约系统（${msg}）。它只有校内网能访问，校外请先连 VPN。`);
  }

  if (!res.ok) throw new Error(`图书馆预约系统返回 HTTP ${res.status}。`);

  const json = (await res.json()) as {
    code?: number;
    message?: string;
    data?: { date?: string[]; list?: RawPremise[] };
  };
  if (json.code !== 0 || !json.data) {
    throw new Error(`图书馆预约系统报错：${json.message ?? `code=${String(json.code)}`}`);
  }

  const dates = Array.isArray(json.data.date) ? json.data.date.map(String) : [];
  const picked = date || dates[0] || '';
  const premises = (json.data.list ?? []).map((p) => {
    const floors = Array.isArray(p.children)
      ? p.children.map((c) => ({
          id: String(c.id ?? ''),
          name: String(c.name ?? ''),
          total: num(c.total_num),
          free: num(c.free_num),
        }))
      : [];
    return {
      id: String(p.id ?? ''),
      name: String(p.name ?? ''),
      total: num(p.total_num),
      free: num(p.free_num),
      ...(floors.length ? { floors } : {}),
    };
  });

  return {
    date: picked,
    dates,
    premises,
    url: librarySeatUrl(premises[0]?.id ?? '1', picked),
  };
}
