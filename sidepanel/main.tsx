import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { LlmFields } from '../src/ui/llm-fields';
import { HoldButton } from '../src/ui/hold';
import { CampusMap, RichText, download } from '../src/ui/rich';
import './style.css';

interface TokenStatus {
  source: 'jwxt' | 'portal';
  present: boolean;
  valid: boolean;
  expText?: string;
  remainingText?: string;
}

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

interface LlmSettings {
  enabled: boolean;
  provider: string;
  apiKey: string;
  model: string;
}

/** 校园地图：`public/map/campus.jpg` 原样拷进 dist/map/，用绝对路径引（扩展根 = /）。 */
type Reply<T = unknown> = { ok: boolean; data?: T; error?: string };

function send<T = unknown>(message: unknown): Promise<Reply<T>> {
  return chrome.runtime.sendMessage(message) as Promise<Reply<T>>;
}

const QUICK: Array<{ label: string; text: string }> = [
  { label: '本周课表', text: '这周课表' },
  { label: '明天有课吗', text: '明天有课吗' },
  { label: '今天空教室', text: '今天上午的空教室' },
  { label: '最新通知', text: '最近的通知' },
  { label: '导出日历', text: '把课表导出成日历' },
];

function App() {
  const [statuses, setStatuses] = useState<TokenStatus[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<LlmSettings>({
    enabled: false,
    provider: 'school',
    apiKey: '',
    model: 'DeepSeek-R1',
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveNote, setSaveNote] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState('');
  const [bundle, setBundle] = useState('');
  const [bundleBusy, setBundleBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);

  async function refreshStatus() {
    const res = await send<TokenStatus[]>({ type: 'status' });
    if (res.ok && res.data) setStatuses(res.data);
  }

  useEffect(() => {
    void refreshStatus();
    void send<LlmSettings>({ type: 'settings:get' }).then((res) => {
      if (res.ok && res.data) {
        setSettings(res.data);
        // 没填 key 就顺手试一次：如果用户已经登录过 chat.zzu.edu.cn，content script 会把会话传进来
        if (!res.data.apiKey) {
          void send<LlmSettings>({ type: 'chat:sync' }).then((r) => {
            if (r.ok && r.data) setSettings(r.data);
          });
        }
      }
    });
    const timer = setInterval(refreshStatus, 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  async function submit(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setMessages((m) => [...m, { role: 'user', text: question }]);
    setInput('');
    setBusy(true);
    try {
      const res = await send<{
        text: string;
        tool?: string;
        data?: Record<string, unknown>;
        error?: string;
        via?: 'agent' | 'rule' | 'llm' | 'llm-chat' | 'none';
        steps?: string[];
        llmError?: string;
        llmMs?: number;
      }>({
        type: 'ask',
        text: question,
        history: messages
          .slice(-6)
          .filter((m) => m.text.trim())
          .map((m) => ({ role: m.role, content: m.text })),
      });
      if (res.ok && res.data) {
        setMessages((m) => [
          ...m,
          {
            role: 'assistant',
            text: res.data!.text,
            ...(res.data!.tool ? { tool: res.data!.tool } : {}),
            ...(res.data!.data ? { data: res.data!.data } : {}),
            ...(res.data!.via ? { via: res.data!.via } : {}),
            ...(res.data!.steps ? { steps: res.data!.steps } : {}),
            ...(res.data!.llmError ? { llmError: res.data!.llmError } : {}),
          },
        ]);
      } else {
        setMessages((m) => [...m, { role: 'assistant', text: res.error ?? '没有拿到结果', error: true }]);
      }
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', text: String(e), error: true }]);
    } finally {
      setBusy(false);
    }
  }

  const jwxt = statuses.find((s) => s.source === 'jwxt');
  const portal = statuses.find((s) => s.source === 'portal');

  async function saveSettings(patch: Partial<LlmSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    const res = await send<LlmSettings>({ type: 'settings:set', patch });
    if (res.ok && res.data) setSettings(res.data);
    setSaveNote(res.ok ? '已保存' : res.error ?? '保存失败');
    setTimeout(() => setSaveNote(''), 2500);
  }

  /** 用 chat.zzu.edu.cn 页面里已登录的会话换一个 sk- key（不用手动粘贴）。 */
  async function syncKey(): Promise<void> {
    setSyncing(true);
    const res = await send<LlmSettings>({ type: 'chat:sync' });
    setSyncing(false);
    if (res.ok && res.data) {
      setSettings(res.data);
      setSaveNote('已从已登录页面取到 key');
    } else {
      setSaveNote(res.error ?? '没取到 key');
    }
    setTimeout(() => setSaveNote(''), 4000);
  }

  /** 直接打一次模型接口，把真实状态（通/不通、耗时、错在哪）显示出来。 */
  async function testLlm(): Promise<void> {
    setTesting(true);
    setTestNote('测试中…');
    const res = await send<{ ok: boolean; ms: number; model: string; text?: string; error?: string }>({
      type: 'llm:test',
      patch: { ...settings, enabled: true },
    });
    setTesting(false);
    if (res.ok && res.data) {
      const d = res.data;
      setTestNote(d.ok ? `连通 ✓ ${d.ms}ms（${d.model} 回：${d.text || ''}）` : `失败 ✗ ${d.error ?? '未知原因'}`);
    } else {
      setTestNote(res.error ?? '测试失败');
    }
  }

  async function makeBundle(): Promise<void> {
    setBundleBusy(true);
    const res = await send<string>({ type: 'bundle:export' });
    setBundleBusy(false);
    if (res.ok && typeof res.data === 'string') {
      setBundle(res.data);
      setCopied(false);
    } else {
      setSaveNote(res.error ?? '生成失败');
      setTimeout(() => setSaveNote(''), 4000);
    }
  }

  async function copyBundle(): Promise<void> {
    if (!bundle) return;
    try {
      await navigator.clipboard.writeText(bundle);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setSaveNote('浏览器不让写剪贴板，请手动全选复制');
      setTimeout(() => setSaveNote(''), 4000);
    }
  }

  return (
    <div class="app">
      <header>
        <h1>校园信息层</h1>
        <button
          class={`gear${settingsOpen ? ' on' : ''}`}
          title="设置"
          aria-label="设置"
          onClick={() => setSettingsOpen((v) => !v)}
        >
          ⚙
        </button>
        <div class="tokens">
          <span class={`pill ${jwxt?.valid ? 'ok' : 'off'}`}>
            教务{jwxt?.valid ? ` · ${jwxt.remainingText ?? ''}` : jwxt?.present ? ' · 已过期' : ' · 未采集'}
          </span>
          <span class={`pill ${portal?.valid ? 'ok' : 'off'}`}>
            门户{portal?.valid ? ` · ${portal.remainingText ?? ''}` : portal?.present ? ' · 已过期' : ' · 未采集'}
          </span>
        </div>
      </header>

      {settingsOpen && (
        <section class="settings">
          <LlmFields value={settings} onChange={(patch) => void saveSettings(patch)} />
          <div class="row">
            <button class="mini" onClick={() => void syncKey()} disabled={syncing}>
              {syncing ? '获取中…' : '从已登录的 DeepSeek 页面自动获取 key'}
            </button>
            <button class="mini" onClick={() => void testLlm()} disabled={testing}>
              {testing ? '测试中…' : '测试连接'}
            </button>
          </div>
          {testNote ? <p class={testNote.startsWith('连通') ? 'hint ok' : 'hint warn'}>{testNote}</p> : null}
          <p class="hint">
            模型只决定「调哪个工具」，课表通知内容仍由模板渲染。{saveNote ? ` ${saveNote}` : ''}
          </p>
          <div class="sync">
            <div class="row">
              <button class="mini" onClick={() => void makeBundle()} disabled={!!bundleBusy}>
                生成手机同步码
              </button>
              {bundle && (
                <button class="mini" onClick={() => void copyBundle()}>
                  {copied ? '已复制' : '复制'}
                </button>
              )}
            </div>
            {bundle && (
              <textarea class="bundle" readOnly rows={3} value={bundle} onFocus={(e) => (e.target as HTMLTextAreaElement).select()} />
            )}
            <p class="hint">
              手机浏览器打开 PWA →「用同步码导入」，把这段贴进去即可（一次性、含 token、别外传；关掉面板即从界面消失）。
            </p>
          </div>
        </section>
      )}

      <main>
        {messages.length === 0 && (
          <div class="empty">
            <p>在下面问点实际的，例如：</p>
            <ul>
              <li>明天有课吗 / 第 8 周课表</li>
              <li>明天下午的空教室</li>
              <li>最近的通知 / 我这学期绩点</li>
              <li>把课表导出成日历</li>
            </ul>
            {!jwxt?.present && !portal?.present && (
              <p class="hint">
                还没有 token：先本机打开一次
                <a href="https://jwxt.zzu.edu.cn/uniapp/index.html" target="_blank" rel="noreferrer">
                  教学管理平台
                </a>
                或
                <a href="https://uniapp.s.zzu.edu.cn/" target="_blank" rel="noreferrer">
                  豫见郑大
                </a>
                ，登录后回到这里。
              </p>
            )}
          </div>
        )}

        {messages.map((m, i) => (
          <div class={`msg ${m.role}`} key={`${i}-${m.role}`}>
            <div class={m.error ? 'bubble error' : 'bubble'}>
              {m.role === 'assistant' && !m.error ? <RichText text={m.text} /> : <pre>{m.text}</pre>}
              {m.role === 'assistant' && !m.error && m.tool === 'get_schedule' && <CampusMap />}
              {m.role === 'assistant' && !m.error && typeof m.data?.image === 'string' && (
                <figure class="seatmap">
                  <img src={String(m.data.image)} alt={String(m.data.imageAlt ?? '座位平面图')} />
                  <figcaption>绿点是空的 · 灰点已占（按页面坐标还原，不是官方图）</figcaption>
                </figure>
              )}
              {m.role === 'assistant' && !m.error && typeof m.data?.action === 'object' && m.data.action && (
                <HoldButton
                  label={String((m.data.action as { label?: string }).label ?? '长按确认')}
                  hint={`确认后会在你打开的图书馆页面上真的提交（座位 ${String(
                    (m.data.action as { seatNo?: string }).seatNo ?? '',
                  )}）`}
                  onConfirm={async () => {
                    const action = m.data!.action as { areaId: string; date: string; seatNo: string };
                    const res = await send<{ text: string; data?: Record<string, unknown> }>({
                      type: 'lib:book',
                      args: { areaId: action.areaId, date: action.date, seatNo: action.seatNo },
                    });
                    setMessages((prev) => [
                      ...prev,
                      res.ok && res.data
                        ? { role: 'assistant', text: res.data.text, ...(res.data.data ? { data: res.data.data } : {}) }
                        : { role: 'assistant', text: res.error ?? '下单失败', error: true },
                    ]);
                  }}
                />
              )}
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
              {m.role === 'assistant' && !m.error && m.llmError && (
                <p class="hint warn">
                  模型没帮上忙：{m.llmError}
                  {settings.enabled ? '（在 ⚙ 里点「测试连接」看看）' : ''}
                </p>
              )}
              {typeof m.data?.ics === 'string' && (
                <button
                  class="ghost"
                  onClick={() => download(String(m.data?.filename ?? 'zzu.ics'), String(m.data?.ics))}
                >
                  下载 {String(m.data?.filename ?? 'zzu.ics')}
                </button>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div class="msg assistant">
            <div class="bubble">{settings.enabled ? '查询中…（认不出的说法会先问模型，可能要十几秒）' : '查询中…'}</div>
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
          autoFocus
        />
        <button type="submit" disabled={busy || !input.trim()}>
          发送
        </button>
      </form>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
