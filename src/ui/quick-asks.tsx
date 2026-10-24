/**
 * 常用语界面（扩展侧边栏与手机 PWA 共用）。
 *
 * 两件事：
 *  - `QuickAskBar`：输入框上面那排药丸，末尾多一个「+」；
 *  - `QuickAskEditor`：点「+」后展开的编辑面板——加、删、上下挪、恢复默认。
 *
 * 跟 `llm-fields.tsx` 一样，组件不碰存储：父组件拿到新列表后自己落库，
 * 扩展开关 `chrome.storage`、手机走 `localStorage` 都不用在这里分叉。
 */
import { useState } from 'preact/hooks';
import {
  MAX_QUICK_ASKS,
  MAX_QUICK_TEXT,
  addQuickAsk,
  moveQuickAsk,
  removeQuickAsk,
  type QuickAsk,
} from '../core/quickAsk';

interface BarProps {
  items: QuickAsk[];
  /** 点某条药丸：把 `text` 发出去 */
  onPick: (text: string) => void;
  /** 点末尾的「+」 */
  onEdit: () => void;
  disabled?: boolean;
  /** 面板已经展开时把「+」换成「收起」，避免点了没反应 */
  editing?: boolean;
}

export function QuickAskBar({ items, onPick, onEdit, disabled = false, editing = false }: BarProps) {
  return (
    <div class="quick">
      {/* 药丸单独一层横滑，末尾的「+」留在滑动区外面，屏幕窄也一直看得见 */}
      <div class="quick-scroll">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onPick(item.text)}
            disabled={disabled}
            title={item.text === item.label ? undefined : item.text}
          >
            {item.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        class={editing ? 'quick-add on' : 'quick-add'}
        onClick={onEdit}
        disabled={disabled}
        aria-label={editing ? '收起常用语编辑' : '添加或排序常用语'}
        title={editing ? '收起' : '添加 / 排序常用语'}
      >
        {editing ? '×' : '+'}
      </button>
    </div>
  );
}

interface EditorProps {
  items: QuickAsk[];
  onChange: (items: QuickAsk[]) => void;
  onClose: () => void;
  /** 恢复出厂那 7 条 */
  onReset: () => void;
}

export function QuickAskEditor({ items, onChange, onClose, onReset }: EditorProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  const add = () => {
    try {
      const next = addQuickAsk(items, draft);
      setDraft('');
      setError('');
      onChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section class="qa-editor">
      <div class="qa-head">
        <strong>常用语</strong>
        <span class="qa-count">
          {items.length}/{MAX_QUICK_ASKS}
        </span>
        <button type="button" class="qa-done" onClick={onClose}>
          完成
        </button>
      </div>

      {items.length === 0 ? (
        <p class="hint">还没有常用语。在下面加一句，以后一点就发。</p>
      ) : (
        <ol class="qa-list">
          {items.map((item, i) => (
            <li class="qa-row" key={item.id}>
              <span class="qa-text">
                <span class="qa-label">{item.label}</span>
                {item.text === item.label ? null : <small class="qa-send">发「{item.text}」</small>}
              </span>
              <span class="qa-ops">
                <button
                  type="button"
                  onClick={() => onChange(moveQuickAsk(items, item.id, -1))}
                  disabled={i === 0}
                  aria-label="上移"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => onChange(moveQuickAsk(items, item.id, 1))}
                  disabled={i === items.length - 1}
                  aria-label="下移"
                >
                  ↓
                </button>
                <button
                  type="button"
                  class="qa-del"
                  onClick={() => {
                    setError('');
                    onChange(removeQuickAsk(items, item.id));
                  }}
                  aria-label="删除"
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}

      <div class="qa-add">
        <input
          value={draft}
          maxLength={MAX_QUICK_TEXT}
          onInput={(e) => {
            setDraft((e.target as HTMLInputElement).value);
            if (error) setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="加一句常用的，比如「图书馆还有座吗」"
          enterkeyhint="done"
        />
        <button type="button" onClick={add} disabled={!draft.trim()}>
          添加
        </button>
      </div>

      {error ? <p class="hint warn">{error}</p> : null}

      <p class="qa-foot">
        <span>顺序就是这里的顺序，改完点「完成」。</span>
        {confirmReset ? (
          <span class="qa-confirm">
            <button
              type="button"
              class="qa-link"
              onClick={() => {
                setConfirmReset(false);
                setError('');
                onReset();
              }}
            >
              确认恢复
            </button>
            <button type="button" class="qa-link" onClick={() => setConfirmReset(false)}>
              算了
            </button>
          </span>
        ) : (
          <button type="button" class="qa-link" onClick={() => setConfirmReset(true)}>
            恢复默认
          </button>
        )}
      </p>
    </section>
  );
}
