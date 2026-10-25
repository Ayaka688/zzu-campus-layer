import { render } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { LlmFields } from '../src/ui/llm-fields';
import { HoldButton } from '../src/ui/hold';
import { Toast, type ToastState } from '../src/ui/toast';
import { QuickAskBar, QuickAskEditor } from '../src/ui/quick-asks';
import { CampusMap, RichText, download } from '../src/ui/rich';
import {
  defaultQuickAsks,
  loadQuickAsks,
  resetQuickAsks,
  saveQuickAsks,
  type QuickAsk,
} from '../src/core/quickAsk';
import { NoticeBoard, NoticeTodayCard } from '../src/ui/notice';
import { noticesToIcs } from '../src/core/ics';
import { loadTranscript, saveTranscript, trimTranscript } from '../src/core/transcript';
import type { NoticeCard, TodayDigest } from '../src/core/notice';
import { NOTICE_CATEGORIES, type NoticeCategory } from '../src/core/noticeRules';
import {
  DEFAULT_NOTICE_PREFS,
  getNoticePrefs,
  markNoticeRead,
  setNoticePrefs,
  takeNoticeFocus,
  type NoticePrefs,
} from '../src/core/noticeStore';
import { todayShanghai } from '../src/core/util';
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

/* 常用语列表（可编辑）放在 src/core/quickAsk.ts，侧边栏与手机 PWA 共用同一份逻辑。 */

function App() {
  const [statuses, setStatuses] = useState<TokenStatus[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<LlmSettings>({
    enabled: true,
    provider: 'school',
    apiKey: '',
    model: 'DeepSeek-R1',
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  /* 面板切换方向：fwd = 新面板从右边滑进来，back = 退回时从左边滑回来 */
  const [navDir, setNavDir] = useState<'fwd' | 'back'>('fwd');
  /* 首屏不滑，免得一打开面板就动一下 */
  const [booted, setBooted] = useState(false);
  useEffect(() => setBooted(true), []);
  const [saveNote, setSaveNote] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState('');
  const [bundle, setBundle] = useState('');
  const [bundleBusy, setBundleBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  /** 'chat' = 问答，'notices' = 通知时间线。同一个面板里切换，不新开窗口。 */
  const [view, setView] = useState<'chat' | 'notices'>('chat');
  const [noticeCards, setNoticeCards] = useState<NoticeCard[]>([]);
  const [noticeDigest, setNoticeDigest] = useState<TodayDigest | null>(null);
  const [noticeBusy, setNoticeBusy] = useState(false);
  const [noticeError, setNoticeError] = useState('');
  const [noticePrefs, setNoticePrefsState] = useState<NoticePrefs>(DEFAULT_NOTICE_PREFS);
  /* 输入框上面那排常用语：可加、可删、可上下挪 */
  const [quickAsks, setQuickAsks] = useState<QuickAsk[]>(defaultQuickAsks);
  const [quickEditing, setQuickEditing] = useState(false);
  /** 从系统通知点进来的那张卡：切到时间线并高亮 */
  const [focusId, setFocusId] = useState('');
  /** 预约这类「等系统回执」的动作，结果用浮层气泡报，不混在聊天流里 */
  const [toast, setToast] = useState<ToastState | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  const [today] = useState(todayShanghai());
  const scroller = useRef<HTMLElement | null>(null);
  /* 存档读完之前别回写，否则会用空列表把上次的记录覆盖掉 */
  const hydrated = useRef(false);
  /* 刚从存档恢复出来的那一批：这一帧不滚到底，让人从最上面开始看 */
  const restored = useRef<Message[] | null>(null);
  /* 用户往回翻的时候别把他拽回底部 */
  const stickBottom = useRef(true);

  async function refreshStatus() {
    const res = await send<TokenStatus[]>({ type: 'status' });
    if (res.ok && res.data) setStatuses(res.data);
  }

  /** 常用语变了：界面先换，再异步落库（chrome.storage.local）。 */
  function patchQuickAsks(next: QuickAsk[]): void {
    setQuickAsks(next);
    void saveQuickAsks(next).catch(() => undefined);
  }

  async function resetQuickAskList(): Promise<void> {
    setQuickAsks(await resetQuickAsks());
  }

  /**
   * 拉通知：直接复用 find_notices（分类/抽取/去重都在 core 里做过）。
   * 一次拿 50 条，之后 tab/搜索全在本地筛，切 tab 不再打接口。
   */
  async function loadNotices(): Promise<void> {
    if (noticeBusy) return;
    setNoticeBusy(true);
    setNoticeError('');
    try {
      const res = await send<{ text: string; data?: { cards?: NoticeCard[]; digest?: TodayDigest } }>({
        type: 'tool',
        tool: 'find_notices',
        args: { limit: 50 },
      });
      const payload = res.ok ? res.data?.data : undefined;
      if (payload) {
        setNoticeCards(payload.cards ?? []);
        setNoticeDigest(payload.digest ?? null);
      } else {
        setNoticeError(res.error ?? '没拉到通知');
      }
    } catch (e) {
      setNoticeError(e instanceof Error ? e.message : String(e));
    } finally {
      setNoticeBusy(false);
    }
  }

  /** 教务通知没有公开链接，读全文走 background 回查（返回纯文本，HTML 不进 DOM）。 */
  async function loadNoticeDetail(card: NoticeCard): Promise<string | null> {
    const res = await send<{ id: string; title: string; text: string }>({ type: 'notice:detail', id: card.id });
    return res.ok && res.data ? res.data.text : null;
  }

  function saveNoticeIcs(card: NoticeCard): void {
    const ics = noticesToIcs([card]);
    download(`通知-${card.deadline ?? card.eventStart ?? today}.ics`, ics);
  }

  async function readNotice(id: string): Promise<void> {
    setNoticePrefsState(await markNoticeRead(id));
  }

  async function toggleCategory(category: NoticeCategory): Promise<void> {
    const current = noticePrefs.categories.length > 0 ? noticePrefs.categories : [...NOTICE_CATEGORIES];
    const next = current.includes(category) ? current.filter((item) => item !== category) : [...current, category];
    // 空数组的语义是「全订阅」，所以不允许把最后一个取消掉
    if (next.length === 0) return;
    setNoticePrefsState(await setNoticePrefs({ categories: next.length === NOTICE_CATEGORIES.length ? [] : next }));
  }

  useEffect(() => {
    void refreshStatus();
    void getNoticePrefs().then(setNoticePrefsState);
    void loadQuickAsks().then(setQuickAsks);
    // 上次聊的那几条带回来：关掉侧栏、点进别的页面再回来，不该从空白开始
    void loadTranscript<Message>().then((items) => {
      restored.current = items;
      setMessages(items);
      hydrated.current = true;
    });
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

  /* 恢复存档：在绘制之前直接跳到底部（最新一条），不带滑下去那一段动画 */
  useLayoutEffect(() => {
    if (restored.current !== messages) return;
    restored.current = null;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!stickBottom.current) return;
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  /* 每次聊完落一次盘：只留最近 10 条，重字段在 transcript.ts 里洗掉 */
  useEffect(() => {
    if (!hydrated.current) return;
    const timer = setTimeout(() => {
      void saveTranscript(messages).catch(() => undefined);
    }, 200);
    return () => clearTimeout(timer);
  }, [messages]);

  // 登录态一到位就顺手拉一次通知（今日卡片要显示），否则等用户点「通知」再拉
  const ready = statuses.some((s) => (s.source === 'jwxt' || s.source === 'portal') && s.valid);
  useEffect(() => {
    if (ready) void loadNotices();
  }, [ready]);

  // 从系统通知点进来：background 先把目标写进存储，这里取走并跳过去；
  // 面板已经开着时走 runtime 消息，直接切视图。
  useEffect(() => {
    void takeNoticeFocus().then((id) => {
      if (!id) return;
      setNavDir('fwd');
      setView('notices');
      setFocusId(id);
    });
    const onMessage = (message: unknown) => {
      const msg = message as { type?: string; id?: string };
      if (msg?.type !== 'notice:focus') return;
      setNavDir('fwd');
      setView('notices');
      if (msg.id) setFocusId(msg.id);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  async function submit(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setMessages((m) => trimTranscript([...m, { role: 'user', text: question }]));
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
        setMessages((m) =>
          trimTranscript([
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
          ]),
        );
      } else {
        setMessages((m) => trimTranscript([...m, { role: 'assistant', text: res.error ?? '没有拿到结果', error: true }]));
      }
    } catch (e) {
      setMessages((m) => trimTranscript([...m, { role: 'assistant', text: String(e), error: true }]));
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

  /** 面板进出动画用的类名：开新面板从右边滑入，退回从左边滑入 */
  const slide = booted ? (navDir === 'fwd' ? ' slide-in-right' : ' slide-in-left') : '';

  return (
    <div class="app">
      <header>
        <h1>校园信息层</h1>
        <button
          class={`gear${view === 'notices' ? ' on' : ''}`}
          style={{ right: '42px' }}
          title={view === 'notices' ? '回到问答' : '通知时间线'}
          aria-label={view === 'notices' ? '回到问答' : '通知时间线'}
          onClick={() => {
            if (view === 'notices') {
              setNavDir('back');
              setView('chat');
              return;
            }
            setNavDir('fwd');
            setView('notices');
            setFocusId('');
            if (noticeCards.length === 0 && !noticeBusy) void loadNotices();
          }}
        >
          {view === 'notices' ? '💬' : '🔔'}
        </button>
        <button
          class={`gear${settingsOpen ? ' on' : ''}`}
          title="设置"
          aria-label="设置"
          onClick={() => {
            const open = !settingsOpen;
            setNavDir(open ? 'fwd' : 'back');
            setSettingsOpen(open);
          }}
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
        <section class={`settings${slide}`} key="settings">
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

      {view === 'notices' ? (
        <main class={`notices-main${slide}`} key="notices">
          <NoticeBoard
            cards={noticeCards}
            digest={noticeDigest}
            prefs={noticePrefs}
            today={today}
            loading={noticeBusy}
            error={noticeError}
            onRefresh={() => void loadNotices()}
            onRead={(id) => void readNotice(id)}
            onIcs={saveNoticeIcs}
            onDetail={loadNoticeDetail}
            onToggleCategory={(category) => void toggleCategory(category)}
            focusId={focusId}
          />
        </main>
      ) : (
        <main
          ref={scroller}
          class={slide.trim()}
          key="chat"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
          }}
        >
          {noticeDigest && (
            <NoticeTodayCard
              digest={noticeDigest}
              loading={noticeBusy}
              onOpen={() => {
                setNavDir('fwd');
                setView('notices');
              }}
            />
          )}
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
                <br />
                登录页上<strong>勾一下「记住我」</strong>：票过期时我会自己开个后台标签页续一次，不用你天天重登。
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
                    const toast = (res.data?.data as { toast?: { kind?: string; title?: string; detail?: string } } | undefined)?.toast;
                    if (res.ok && toast?.title) {
                      setToast({
                        kind: toast.kind === 'ok' ? 'ok' : toast.kind === 'warn' ? 'warn' : 'bad',
                        title: toast.title,
                        detail: toast.detail ?? '',
                        id: Date.now(),
                      });
                    } else {
                      // 连回执都没拿到（页面没回应等）：也算没约上，别让人以为成功了
                      setToast({
                        kind: 'bad',
                        title: '没约上',
                        detail: res.error ?? '没拿到图书馆系统的任何回应，这次不算数。',
                        id: Date.now(),
                      });
                    }
                    setMessages((prev) =>
                      trimTranscript([
                        ...prev,
                        res.ok && res.data
                          ? { role: 'assistant', text: res.data.text, ...(res.data.data ? { data: res.data.data } : {}) }
                          : { role: 'assistant', text: res.error ?? '下单失败', error: true },
                      ]),
                    );
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
        <div />
      </main>
      )}

      {view === 'chat' && (
        <>
          {quickEditing && (
            <QuickAskEditor
              items={quickAsks}
              onChange={patchQuickAsks}
              onClose={() => setQuickEditing(false)}
              onReset={() => void resetQuickAskList()}
            />
          )}
          <QuickAskBar
            items={quickAsks}
            disabled={busy}
            editing={quickEditing}
            onEdit={() => setQuickEditing((v) => !v)}
            onPick={(text) => {
              setQuickEditing(false);
              void submit(text);
            }}
          />

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
        </>
      )}

      <Toast toast={toast} onClose={dismissToast} />
    </div>
  );
}

render(<App />, document.getElementById('app')!);
