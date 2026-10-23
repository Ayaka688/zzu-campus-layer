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

/* ------------------------------------------------------------------ */
/* 座位级（需要页面里的登录态，由 content/library.js 代取）            */
/* ------------------------------------------------------------------ */

export interface LibSeat {
  /** 座位号，页面上的可读编号，如 `001`、`A12` */
  no: string;
  /** 原始状态字符串，服务端给什么就是什么 */
  status: string;
  free: boolean;
  /** 页面平面图上的坐标（真实接口给 `point_x`/`point_y`），拿不到就不画图 */
  x?: number;
  y?: number;
}

export interface LibSeatMap {
  areaName?: string;
  total?: number;
  free?: number;
  seats: LibSeat[];
}

/**
 * 状态词：只认**明确的文字**。
 * 数字编码（`1`/`0`）不敢猜——站点用 1 表示"可用"还是"已占"没有文档，
 * 猜错会把已占的座位当成空的，所以一律当成"状态未知"。
 */
const FREE_RE = /^(free|empty|available|idle)$|空闲|可用|可选/i;
const USED_RE = /used|occupied|busy|booked|使用|占用|已约|不可选/i;
const NUMERIC_STATUS_RE = /^-?\d+$/;

/** 宽松取数：数字或数字字符串都收，其它（null/空串/NaN）返回 undefined */
const numOr = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const seatNo = (o: Record<string, unknown>): string => {
  for (const k of ['no', 'name', 'seat_no', 'seatNo', 'num', 'number', 'code', 'title']) {
    const v = o[k];
    if (typeof v === 'string' || typeof v === 'number') {
      const st = String(v).trim();
      if (st && st.length <= 12) return st;
    }
  }
  return '';
};

/**
 * 状态：真实接口同时给 `status`（数字）和 `status_name`（中文）。
 * 优先用中文名判空/占，数字只作为后备显示。
 */
const seatStatus = (o: Record<string, unknown>): string => {
  for (const k of ['status_name', 'statusName', 'status', 'state', 'seat_status', 'seatStatus', 'use_status', 'type']) {
    const v = o[k];
    if (typeof v === 'string' || typeof v === 'number') {
      const st = String(v);
      if (st !== '') return st;
    }
  }
  return '';
};

/** 数字状态码的语义（实测一楼 216 个座位时 status 与 status_name 成对出现，据此确认） */
const STATUS_NUM: Record<string, { label: string; free: boolean }> = {
  '1': { label: '可用', free: true },
  '2': { label: '使用中', free: false },
  '3': { label: '预约中', free: false },
  '4': { label: '临时离开', free: false },
};

/**
 * 宽容解析：不假设字段名。
 * 服务端的座位列表字段名改过（`seat_list`/`list`/`seats`/数组本身），
 * 所以这里递归找「看起来像座位」的对象数组，认不出来就返回空。
 */
export function parseSeatMap(raw: unknown): LibSeatMap {
  const out: LibSeatMap = { seats: [] };
  const seen = new Set<string>();

  const visit = (node: unknown, depth: number): void => {
    if (!node || depth > 4) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    if (typeof obj.area_name === 'string' && obj.area_name && !out.areaName) out.areaName = obj.area_name;
    if (typeof obj.name === 'string' && obj.name && !out.areaName) out.areaName = obj.name;
    const t = Number(obj.total_num ?? obj.total);
    if (Number.isFinite(t) && t > 0 && out.total === undefined) out.total = t;
    const f = Number(obj.free_num ?? obj.free);
    if (Number.isFinite(f) && f >= 0 && out.free === undefined) out.free = f;

    const no = seatNo(obj);
    const status = seatStatus(obj);
    // 座位对象的最低特征：有座位号，且有状态/坐标之一
    const looksLikeSeat =
      Boolean(no) &&
      (status !== '' || 'x' in obj || 'y' in obj || 'left' in obj || 'top' in obj);
    if (looksLikeSeat && !seen.has(no)) {
      seen.add(no);
      const byName = status !== '' && FREE_RE.test(status) && !USED_RE.test(status);
      const byNum = STATUS_NUM[status]?.free ?? false;
      const free = status !== '' ? byName || byNum : false;
      const x = numOr(obj.point_x ?? obj.x ?? obj.left);
      const y = numOr(obj.point_y ?? obj.y ?? obj.top);
      out.seats.push({ no, status, free, ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) });
      return;
    }

    for (const v of Object.values(obj)) if (v && typeof v === 'object') visit(v, depth + 1);
  };

  visit(raw, 0);
  out.seats.sort((a, b) => a.no.localeCompare(b.no, 'zh'));
  if (out.free === undefined && out.seats.length) out.free = out.seats.filter((s) => s.free).length;
  return out;
}

/**
 * 把座位坐标画成 SVG 平面图（真实接口给 point_x/point_y）。
 * 拿不到坐标就不画——宁可说「看不到图」，也不画一张假图。
 */
export function seatMapSvg(m: LibSeatMap, opts: { width?: number } = {}): string | undefined {
  const pts = m.seats.filter((s) => typeof s.x === 'number' && typeof s.y === 'number');
  if (pts.length < 4) return undefined;

  const W = opts.width ?? 720;
  const PAD = 16;
  const xs = pts.map((s) => s.x as number);
  const ys = pts.map((s) => s.y as number);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = (W - PAD * 2) / spanX;
  const H = Math.min(Math.round(spanY * scale + PAD * 2), 560);
  const r = Math.max(3, Math.min(7, Math.round(scale * 6)));
  const freeCount = pts.filter((s) => s.free).length;

  const dots = pts
    .map((s) => {
      const cx = PAD + ((s.x as number) - minX) * scale;
      const cy = PAD + ((s.y as number) - minY) * scale;
      const fill = s.free ? '#3fb950' : '#3a3f47';
      return '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + r + '" fill="' + fill + '"/>';
    })
    .join('');

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">',
    '<rect width="100%" height="100%" fill="#12141a"/>',
    dots,
    '<text x="' + PAD + '" y="' + (H - 6) + '" fill="#8b949e" font-size="12" font-family="system-ui,sans-serif">' +
      '空 ' + freeCount + ' / 共 ' + pts.length +
      '</text>',
    '</svg>',
  ].join('');
}

/** 给 <img src> 用的 data URI（不依赖 btoa 的 latin1 限制） */
export function seatMapDataUri(m: LibSeatMap, opts: { width?: number } = {}): string | undefined {
  const svg = seatMapSvg(m, opts);
  if (!svg) return undefined;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

export function renderSeatMap(m: LibSeatMap, opts: { limit?: number } = {}): string {
  const limit = opts.limit ?? 40;
  const rows: string[] = [];
  const area = m.areaName ? ` · ${m.areaName}` : '';
  const freeSeats = m.seats.filter((s) => s.free);
  rows.push(`**图书馆座位图${area}**`, '');
  if (!m.seats.length) {
    rows.push('没解析出座位（可能接口字段变了，或者座位图还没加载完）。');
    return rows.join('\n');
  }
  rows.push(`共 ${m.seats.length} 个座位，当前空闲 **${freeSeats.length}** 个。`);
  if (freeSeats.length) {
    const show = freeSeats.slice(0, limit).map((s) => s.no);
    rows.push(`空闲座位：${show.join('、')}${freeSeats.length > limit ? ` …还有 ${freeSeats.length - limit} 个` : ''}`);
  } else if (m.seats.every((s) => s.status === '' || NUMERIC_STATUS_RE.test(s.status))) {
    // 服务端只给数字编码时，别硬猜空闲/占用
    rows.push(
      '这个接口的状态是数字编码，我不敢猜哪个是"空"，所以没有替你标空闲。' +
        '请在页面上看绿色座位（点开「图书馆座位预约」那个链接就是了）。',
    );
  }
  rows.push('', '要订就说座位号（例如「订 001，今天」），确认时会让你长按按钮。');
  return rows.join('\n');
}
