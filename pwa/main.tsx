import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ask } from '../src/core/agent';
import { decodeBundle } from '../src/core/kv';
import { probeLlm } from '../src/core/llm';
import {
  clearTokens,
  exportTokenBundle,
  getLlmSettings,
  importTokenBundle,
  loadSession,
  setLlmSettings,
  tokenStatuses,
  type LlmSettingsStored,
  type TokenStatus,
} from '../src/core/storage';
import { LlmFields } from '../src/ui/llm-fields';
import { CampusMap, RichText, download } from '../src/ui/rich';
import './style.css';

interface Message {
  role: 'user' | 'assistant';
  text: string;
  tool?: string;
  data?: Record<string, unknown>;
  error?: boolean;
  via?: 'agent' | 'rule' | 'llm' | 'llm-chat' | 'none';
  /** agent 模式这一轮调过的工具，按顺序 */
  steps?: string[];
  /** 模型没帮上忙的原因 */
  llmError?: string;
}

const QUICK: Array<{ label: string; text: string }> = [
  { label: '明天有课吗', text: '明天有课吗' },
  { label: '本周课表', text: '这周课表' },
  { label: '今天的空教室', text: '今天上午的空教室' },
  { label: '最新通知', text: '最近的通知' },
  { label: '卡里余额', text: '我卡里还有多少钱' },
  { label: '导出日历', text: '把课表导出成日历' },
];

function App() {
  const [statuses, setStatuses] = useState<TokenStatus[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<'none' | 'login'>('none');
  const [paste, setPaste] = useState('');
  const [note, setNote] = useState('');
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState('');
  const [llm, setLlm] = useState<LlmSettingsStored>({
    enabled: false,
    provider: 'school',
    apiKey: '',
    model: 'DeepSeek-R1',
  });
  const bottom = useRef<HTMLDivElement | null>(null);
  const isHttps = typeof location !== 'undefined' && location.protocol === 'https:';

  async function refresh() {
    setStatuses(await tokenStatuses());
    setLlm(await getLlmSettings());
  }

  async function patchLlm(patch: Partial<LlmSettingsStored>) {
    const next = await setLlmSettings(patch);
    setLlm(next);
  }

  useEffect(() => {
    void refresh();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./pwa-sw.js').catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  const jwxt = statuses.find((s) => s.source === 'jwxt');
  const portal = statuses.find((s) => s.source === 'portal');
  const ready = Boolean(jwxt?.valid || portal?.valid);

  async function submit(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setMessages((m) => [...m, { role: 'user', text: question }]);
    setInput('');
    setBusy(true);
    try {
      const session = await loadSession();
      if (!session.jwxtToken && !session.portalToken) {
        setMessages((m) => [
          ...m,
          { role: 'assistant', text: '还没有登录态：点右上角「登录态」，从电脑上的扩展面板复制一段码粘进来。', error: true },
        ]);
        setSheet('login');
        return;
      }
      const res = await ask(question, session, {
        llm,
        // 把最近几轮带上，模型才接得住「那明天呢」这种追问
        history: messages
          .slice(-6)
          .filter((m) => m.text.trim())
          .map((m) => ({ role: m.role, content: m.text })),
      });
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          text: res.text,
          ...(res.tool ? { tool: res.tool } : {}),
          ...(res.data ? { data: res.data } : {}),
          ...(res.via ? { via: res.via } : {}),
          ...(res.steps ? { steps: res.steps } : {}),
          ...(res.llmError ? { llmError: res.llmError } : {}),
          ...(res.error ? { error: true } : {}),
        },
      ]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', text: String(e), error: true }]);
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    try {
      const bundle = decodeBundle(paste);
      const next = await importTokenBundle(bundle);
      setStatuses(next);
      setLlm(await getLlmSettings());
      setPaste('');
      setSheet('none');
      setNote(bundle.llm?.apiKey ? '导入成功（含模型 key）' : '导入成功');
      setTimeout(() => setNote(''), 2500);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  /** 手机端直接打一次模型接口，把真实原因显示出来。 */
  async function testLlm(): Promise<void> {
    setTesting(true);
    setTestNote('测试中…');
    const cfg = { ...(await getLlmSettings()), enabled: true };
    const r = await probeLlm(cfg);
    setTesting(false);
    setTestNote(r.ok ? `连通 ✓ ${r.ms}ms（${r.model} 回：${r.text || ''}）` : `失败 ✗ ${r.error ?? '未知原因'}`);
  }

  /** 手机端没有 content script，导出码主要是方便测试时把手机上的搬到别处。 */
  async function doExport() {
    try {
      const code = await exportTokenBundle();
      await navigator.clipboard.writeText(code);
      setNote('已复制（长度 ' + code.length + '）');
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setNote(''), 3000);
  }

  return (
    <div class="app">
      <header>
        <h1>校园信息层</h1>
        <button class="chip" onClick={() => setSheet(sheet === 'login' ? 'none' : 'login')}>
          {ready ? `教务 ${jwxt?.remainingText ?? '—'}` : '登录态'}
        </button>
      </header>

      {sheet === 'login' && (
        <section class="sheet">
          <p class="hint">
            在电脑上打开扩展侧边栏 → 点右上角 ⚙ →「生成手机同步码」→ 把那段码发到这里（微信/QQ 发给自己都行），粘贴后保存。
            一张教务票能用 30 天。
          </p>
          <textarea
            rows={4}
            placeholder="粘贴那段码…"
            value={paste}
            onInput={(e) => setPaste((e.target as HTMLTextAreaElement).value)}
          />
          <div class="row">
            <button class="primary" onClick={() => void doImport()} disabled={!paste.trim()}>
              保存
            </button>
            <button class="ghost" onClick={() => void doExport()}>
              导出当前码
            </button>
            <button
              class="ghost"
              onClick={async () => {
                await clearTokens();
                setStatuses(await tokenStatuses());
                setNote('已清除');
              }}
            >
              清除
            </button>
          </div>
          {note && <p class="note">{note}</p>}
          <p class="hint">
            当前状态：教务 {jwxt?.present ? (jwxt.valid ? jwxt.remainingText : '已过期') : '未导入'} · 门户{' '}
            {portal?.present ? (portal.valid ? portal.remainingText : '已过期') : '未导入'}
            {jwxt?.expText ? `（教务到期 ${jwxt.expText}）` : ''}
          </p>

          <LlmFields
            value={llm}
            httpsPage={isHttps}
            onChange={(patch) => {
              setLlm({ ...llm, ...patch });
              void patchLlm(patch);
            }}
          />
          <div class="row">
            <button class="mini" onClick={() => void testLlm()} disabled={testing}>
              {testing ? '测试中…' : '测试连接'}
            </button>
          </div>
          {testNote ? <p class={testNote.startsWith('连通') ? 'hint ok' : 'hint warn'}>{testNote}</p> : null}
        </section>
      )}

      <main>
        {messages.length === 0 && (
          <div class="empty">
            <p>{ready ? '问点实际的：' : '先在右上角导入一次登录态，然后：'}</p>
            <ul>
              <li>明天有课吗（会附校园地图）</li>
              <li>明天下午哪间教室空着</li>
              <li>我还差多少学分</li>
              <li>最近的通知 / 卡里还有多少钱</li>
            </ul>
          </div>
        )}

        {messages.map((m, i) => (
          <div class={`msg ${m.role}`} key={`${i}-${m.role}`}>
            <div class={m.error ? 'bubble error' : 'bubble'}>
              {m.role === 'assistant' && !m.error ? <RichText text={m.text} /> : <pre>{m.text}</pre>}
              {m.role === 'assistant' && !m.error && m.tool === 'get_schedule' && <CampusMap />}
              {m.role === 'assistant' && !m.error && typeof m.data?.url === 'string' && (
                <a class="go" href={m.data.url} target="_blank" rel="noreferrer">
                  打开 {typeof m.data.name === 'string' ? m.data.name : '链接'} ↗
                </a>
              )}
              {m.role === 'assistant' && !m.error && m.via === 'agent' && (
                <em class="via">
                  模型编排{m.steps?.length ? ` · ${m.steps.join(' → ')}` : ''}
                </em>
              )}
              {m.role === 'assistant' && !m.error && m.via === 'llm' && <em class="via">由模型判定</em>}
              {m.role === 'assistant' && !m.error && m.via === 'llm-chat' && <em class="via">由模型回答</em>}
              {m.role === 'assistant' && !m.error && m.llmError && <p class="hint warn">模型没帮上忙：{m.llmError}</p>}
              {typeof m.data?.ics === 'string' && (
                <button class="ghost" onClick={() => download(String(m.data?.filename ?? 'zzu.ics'), String(m.data?.ics))}>
                  下载 {String(m.data?.filename ?? 'zzu.ics')}
                </button>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div class="msg assistant">
            <div class="bubble">{llm.enabled ? '查询中…（认不出的说法会先问模型）' : '查询中…'}</div>
          </div>
        )}
        <div ref={bottom} />
      </main>

      <div class="quick">
        {QUICK.map((q) => (
          <button key={q.label} onClick={() => void submit(q.text)} disabled={busy}>
            {q.label}
          </button>
        ))}
      </div>

      <form
        class="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(input);
        }}
      >
        <input
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          placeholder="问点什么，比如「明天下午有空的教室吗」"
          enterkeyhint="send"
        />
        <button type="submit" disabled={busy || !input.trim()}>
          发送
        </button>
      </form>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
