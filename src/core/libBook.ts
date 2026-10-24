/**
 * 「这次到底约上没有」的判定与文案。
 *
 * 为什么要单独一层：预约这件事有三态，不是真假两态——
 * 1. `confirmed`：服务端回了成功回执（`/v4/space/confirm` 的 `code: 0`），
 *    而且座位图上那个位置也不空闲了，两条独立证据都对得上；
 * 2. `pending`：接口说成功、但座位图没变化，或者压根没抓到回执（只看到页面文字）。
 *    这种情况**不能**说「约上了」，也不能直接说「失败」，要人去「我的预约」核对；
 * 3. `failed`：接口明确报错，或页面在点确认之前就卡住了。
 *
 * 三态的语气、颜色、措辞都不一样，就是为了让人一眼分清，不会把「可能成功」当成「成功」。
 */

/** 内容脚本（`public/content/library.js`）回传的判定码 */
export type BookCause =
  | 'confirmed' // 接口 code 0 + 座位图不再空闲
  | 'api_ok' // 接口 code 0，但座位图还显示空闲
  | 'pending' // 抓到回执但看不懂 / 只有页面文字
  | 'no_response' // 点了确认，但没抓到任何回执
  | 'api_error' // 接口明确报错
  | 'seat_missing' // 页面上找不到这个座位
  | 'btn_disabled' // 「立即预约」是灰的
  | 'no_button' // 点了座位没出现「立即预约」
  | 'no_dialog' // 没出现确认弹窗
  | 'no_token' // 页面没登录
  | 'no_tab' // 没打开图书馆预约页面
  | 'page_dead' // 页面没回应
  | 'bad_args'; // 参数不全

export interface BookOutcome {
  cause: BookCause;
  seatNo?: string;
  date?: string;
  /** 服务端返回的 code（抓到回执时才有） */
  code?: number;
  /** 服务端返回的 message，或页面上的提示文字 */
  message?: string;
  /** 座位图上这个座位现在的状态名（如「空闲」「预约中」） */
  seatState?: string;
}

export type BookKind = 'ok' | 'bad' | 'warn';

export interface BookCopy {
  kind: BookKind;
  /** 气泡标题，只有几个字 */
  title: string;
  /** 气泡正文：一句人话，带上座位和时间 */
  detail: string;
  /** 聊天记录里那条消息（带符号前缀，方便回看） */
  text: string;
}

function seatLabel(o: BookOutcome): string {
  const seat = (o.seatNo ?? '').trim();
  const date = (o.date ?? '').trim();
  if (seat && date) return `座位 ${seat} · ${date}`;
  if (seat) return `座位 ${seat}`;
  return '这次预约';
}

function reason(o: BookOutcome): string {
  const msg = (o.message ?? '').trim();
  if (msg) return msg;
  switch (o.cause) {
    case 'no_tab':
      return '浏览器里没打开图书馆预约页面（要先在那个页面登录）';
    case 'page_dead':
      return '图书馆页面没回应，可能刚刷新';
    case 'no_token':
      return '那个页面还没登录';
    case 'seat_missing':
      return '页面上找不到这个座位，可能已被占或座位号变了';
    case 'btn_disabled':
      return '「立即预约」是灰的，这个座位当前不可约';
    case 'no_button':
      return '点了座位但没出现「立即预约」按钮';
    case 'no_dialog':
      return '点了「立即预约」但没等到确认弹窗';
    case 'no_response':
      return '点了确认，但没拿到系统的任何回执';
    case 'api_error':
      return '系统拒绝了这次预约';
    case 'api_ok':
      return '系统回了成功，但座位图还显示空闲';
    case 'pending':
      return '拿到了回执，但看不出成功还是失败';
    default:
      return '原因不明';
  }
}

/**
 * 把判定码翻成给人看的话。三种 kind 的措辞刻意拉开：
 * - 成功一定带「✓」和「已约上」，并说明是系统回执确认的；
 * - 失败一定带「✕」和「没约上」，并给出系统原话；
 * - 存疑带「?」，明确写「先别当成约上了」，引导去核对。
 */
export function describeBook(o: BookOutcome): BookCopy {
  const target = seatLabel(o);
  switch (o.cause) {
    case 'confirmed': {
      const state = o.seatState ? `座位图上也显示「${o.seatState}」` : '座位图上也不再空闲';
      return {
        kind: 'ok',
        title: '约上了',
        detail: `${target} 已经约上，系统回了成功回执，${state}。`,
        text: `✓ **预约成功**：${target} 已约上。\n（系统回了成功回执${o.code !== undefined ? ` code ${o.code}` : ''}，${state}。）`,
      };
    }
    case 'api_ok':
      return {
        kind: 'warn',
        title: '结果存疑',
        detail: `${target}：系统回了成功，但座位图还显示「${o.seatState ?? '空闲'}」。先别当成约上了，去「我的预约」看一眼。`,
        text: `? **结果没确认**：${target}。系统回了成功，但座位图仍显示「${o.seatState ?? '空闲'}」，请去图书馆的「我的预约」核对。`,
      };
    case 'pending':
      return {
        kind: 'warn',
        title: '结果存疑',
        detail: `${target}：${reason(o)}。先别当成约上了，去「我的预约」看一眼。`,
        text: `? **结果没确认**：${target}。${reason(o)}，请去图书馆的「我的预约」核对。`,
      };
    case 'no_response':
      return {
        kind: 'bad',
        title: '没约上',
        detail: `${target}：${reason(o)}。这次不算数，可以再试一次。`,
        text: `✕ **预约失败**：${target}。${reason(o)}，这次不算数。`,
      };
    default:
      return {
        kind: 'bad',
        title: '没约上',
        detail: `${target}：${reason(o)}。`,
        text: `✕ **预约失败**：${target}。${reason(o)}。`,
      };
  }
}
