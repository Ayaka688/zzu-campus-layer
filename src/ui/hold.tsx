import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

/**
 * 需要「长按」才能触发的按钮。
 *
 * 为什么不用普通按钮：这里代表**不可逆动作**（占座被罚、爽约记分），
 * 误触的代价比多点一下高得多。按住 1.2 秒才算确认，松手立刻取消。
 */
export interface HoldButtonProps {
  label: string;
  /** 长按达到阈值后调用；返回的 Promise 结束时按钮恢复 */
  onConfirm: () => Promise<void> | void;
  hint?: string;
  ms?: number;
}

export function HoldButton({ label, onConfirm, hint, ms = 1200 }: HoldButtonProps) {
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const timer = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const startedAt = useRef(0);
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (raf.current !== null) window.cancelAnimationFrame(raf.current);
    timer.current = null;
    raf.current = null;
    setHolding(false);
    setProgress(0);
  }, []);

  useEffect(() => clear, [clear]);

  const start = useCallback(() => {
    if (busy || holding) return;
    fired.current = false;
    setHolding(true);
    setText('');
    startedAt.current = Date.now();

    const tick = (): void => {
      const p = Math.min(1, (Date.now() - startedAt.current) / ms);
      setProgress(p);
      if (p < 1) raf.current = window.requestAnimationFrame(tick);
    };
    raf.current = window.requestAnimationFrame(tick);

    timer.current = window.setTimeout(() => {
      fired.current = true;
      const finished = onConfirm();
      Promise.resolve(finished).finally(() => {
        setBusy(false);
        clear();
      });
      setBusy(true);
      clear();
    }, ms);
  }, [busy, clear, holding, ms, onConfirm]);

  const cancel = useCallback(() => {
    if (fired.current) return;
    clear();
    if (holding) setText('松手取消，没提交');
  }, [clear, holding]);

  return (
    <div class="hold">
      <button
        type="button"
        class={holding ? 'hold-btn active' : 'hold-btn'}
        disabled={busy}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          start();
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span class="fill" style={`width:${Math.round(progress * 100)}%`} />
        <span class="txt">{busy ? '提交中…' : holding ? `继续按住… ${Math.round(progress * 100)}%` : label}</span>
      </button>
      <small class="hold-hint">{text || hint || '长按约 1 秒确认，松手就取消'}</small>
    </div>
  );
}
