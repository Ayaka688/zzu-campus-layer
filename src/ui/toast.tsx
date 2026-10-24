/**
 * 结果气泡（toast）。
 *
 * 用途：像「图书馆预约」这种**要等系统回执**的动作，结果不能只混在聊天流里——
 * 人得在两秒内看清「到底成没成」。所以用浮层气泡，并且三种状态在**颜色、符号、标题词**上
 * 三重区分，扫一眼就不会把「存疑」看成「成功」：
 *
 * | kind | 颜色 | 符号 | 标题 |
 * |------|------|------|------|
 * | ok   | 绿   | ✓    | 约上了 |
 * | warn | 琥珀 | ?    | 结果存疑 |
 * | bad  | 红   | ✕    | 没约上 |
 *
 * 成功的那种自动消失得慢一些（人想再看一眼座位号），失败的最慢（可能要照着提示重试）。
 */
import { useEffect } from 'preact/hooks';

export type ToastKind = 'ok' | 'warn' | 'bad';

export interface ToastState {
  kind: ToastKind;
  title: string;
  detail: string;
  /** 每次弹出都换一个 id，让同样的文案也能重新触发计时器 */
  id: number;
}

const GLYPH: Record<ToastKind, string> = { ok: '✓', warn: '?', bad: '✕' };
const LIFETIME: Record<ToastKind, number> = { ok: 5200, warn: 8000, bad: 9500 };

export interface ToastProps {
  toast: ToastState | null;
  onClose: () => void;
}

export function Toast({ toast, onClose }: ToastProps) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(onClose, LIFETIME[toast.kind]);
    return () => clearTimeout(timer);
  }, [toast, onClose]);

  if (!toast) return null;
  return (
    <div class={`toast ${toast.kind}`} role="status" aria-live="polite">
      <span class="toast-glyph" aria-hidden="true">
        {GLYPH[toast.kind]}
      </span>
      <div class="toast-body">
        <strong>{toast.title}</strong>
        <p>{toast.detail}</p>
      </div>
      <button class="toast-close" onClick={onClose} aria-label="关闭">
        ×
      </button>
    </div>
  );
}
