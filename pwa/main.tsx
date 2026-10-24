import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ask } from '../src/core/agent';
import { parseImportLink } from '../src/core/kv';
import { probeLlm } from '../src/core/llm';
import { buildReminderBlocks, pushReminders } from '../src/core/remind';
import { CampusService } from '../src/core/services';
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
import { noticesToIcs } from '../src/core/ics';
import type { NoticeCard, TodayDigest } from '../src/core/notice';
import { NOTICE_CATEGORIES, type NoticeCategory } from '../src/core/noticeRules';
import {
  DEFAULT_NOTICE_PREFS,
  getNoticePrefs,
  markNoticeRead,
  setNoticePrefs,
  type NoticePrefs,
} from '../src/core/noticeStore';
import { getNoticeBody, runTool } from '../src/core/tools';
import { todayShanghai } from '../src/core/util';
import { NoticeBoard, NoticeTodayCard } from '../src/ui/notice';
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

const CAS_LOGIN =
  'https://cas.s.zzu.edu.cn/cas/login?service=' +
  // 故意指到门户的一个静态样式文件：CAS 只按 host 白名单放行，
  // 而静态文件不会启动那个 uni-app SPA —— SPA 一启动就会把 ?ticket= 从地址栏抹掉。
  encodeURIComponent('https://uniapp.s.zzu.edu.cn/static/index.a5c69d49.css');

const QUICK: Array<{ label: string; text: string }> = [
  { label: '明天有课吗', text: '明天有课吗' },
  { label: '本周课表', text: '这周课表' },
  { label: '今天的空教室', text: '今天上午的空教室' },
  { label: '今天有什么讲座', text: '今天有什么讲座' },
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
  /** 'chat' = 问答，'notices' = 通知时间线。`#notices` 可直接深链到时间线。 */
  const [view, setView] = useState<'chat' | 'notices'>(
    typeof location !== 'undefined' && location.hash === '#notices' ? 'notices' : 'chat',
  );
  const [noticeCards, setNoticeCards] = useState<NoticeCard[]>([]);
  const [noticeDigest, setNoticeDigest] = useState<TodayDigest | null>(null);
  const [noticeBusy, setNoticeBusy] = useState(false);
  const [noticeError, setNoticeError] = useState('');
  const [noticePrefs, setNoticePrefsState] = useState<NoticePrefs>(DEFAULT_NOTICE_PREFS);
  const [today] = useState(todayShanghai());
  const bottom = useRef<HTMLDivElement | null>(null);
  const isHttps = typeof location !== 'undefined' && location.protocol === 'https:';

  async function refresh() {
    setStatuses(await tokenStatuses());
    setLlm(await getLlmSettings());
    setNoticePrefsState(await getNoticePrefs());
  }

  /** 手机端直接跑工具（没有 background），卡片管线与桌面完全同一条。 */
  async function loadNotices(): Promise<void> {
    if (noticeBusy) return;
    setNoticeBusy(true);
    setNoticeError('');
    try {
      const session = await loadSession();
      if (!session.jwxtToken && !session.portalToken) {
        setNoticeError('还没有登录态：点右上角「登录态」导入一次。');
        return;
      }
      const out = await runTool('find_notices', { limit: 50 }, new CampusService(session));
      const payload = out.data as { cards?: NoticeCard[]; digest?: TodayDigest } | undefined;
      setNoticeCards(payload?.cards ?? []);
      setNoticeDigest(payload?.digest ?? null);
    } catch (e) {
      setNoticeError(e instanceof Error ? e.message : String(e));
    } finally {
      setNoticeBusy(false);
    }
  }

  async function loadNoticeDetail(card: NoticeCard): Promise<string | null> {
    const session = await loadSession();
    const body = await getNoticeBody(new CampusService(session), card.id);
    return body?.text ?? null;
  }

  function saveNoticeIcs(card: NoticeCard): void {
    download(`通知-${card.deadline ?? card.eventStart ?? today}.ics`, noticesToIcs([card]));
  }

  async function readNotice(id: string): Promise<void> {
    setNoticePrefsState(await markNoticeRead(id));
  }

  async function toggleCategory(category: NoticeCategory): Promise<void> {
    const current = noticePrefs.categories.length > 0 ? noticePrefs.categories : [...NOTICE_CATEGORIES];
    const next = current.includes(category) ? current.filter((item) => item !== category) : [...current, category];
    if (next.length === 0) return;
    setNoticePrefsState(await setNoticePrefs({ categories: next.length === NOTICE_CATEGORIES.length ? [] : next }));
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
    // 装了安卓壳的话，每次打开都把未来 7 天的课前提醒重排一遍
    void syncReminders();
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  const jwxt = statuses.find((s) => s.source === 'jwxt');
  const portal = statuses.find((s) => s.source === 'portal');
  const ready = Boolean(jwxt?.valid || portal?.valid);
  useEffect(() => {
    if (ready) void loadNotices();
  }, [ready]);

  /** 算未来 7 天的课前提醒并交给壳（没有壳时 pushReminders 返回 false，什么也不做）。 */
  async function syncReminders() {
    try {
      const session = await loadSession();
      if (!session.jwxtToken && !session.portalToken) return;
      const svc = new CampusService(session);
      const [courses, term] = await Promise.all([svc.courses(), svc.term().catch(() => undefined)]);
      pushReminders(buildReminderBlocks(courses, { termStart: term?.startDate }));
    } catch {
      /* 提醒排不上不该影响聊天 */
    }
  }

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

  /** 从剪贴板取一次：能认出来就直接导入，省掉「再点保存」那一下。 */
  /**
   * 给原生壳（Android WebView）用一个入口：壳里登录成功后直接调
   *   window.__campusImport("<idToken 或完整网址>")
   * 就完成导入，用户不需要复制任何东西。
   */
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__campusImport = async (raw: string): Promise<string> => {
      try {
        const bundle = parseImportLink(String(raw ?? ''));
        const next = await importTokenBundle(bundle);
        setStatuses(next);
        setLlm(await getLlmSettings());
        setSheet('none');
        setNote('登录态已导入');
        setTimeout(() => setNote(''), 2500);
        return 'ok';
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setNote(msg);
        return msg;
      }
    };
    return () => {
      delete w.__campusImport;
    };
  }, []);

  async function readClip(): Promise<void> {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setNote('浏览器不让读剪贴板（需要 https + 一次授权），长按输入框手动粘贴一次');
      return;
    }
    if (!text.trim()) {
      setNote('剪贴板是空的，先去学校页面复制地址栏');
      return;
    }
    try {
      const bundle = parseImportLink(text.trim());
      const next = await importTokenBundle(bundle);
      setStatuses(next);
      setLlm(await getLlmSettings());
      setPaste('');
      setSheet('none');
      setNote(bundle.llm?.apiKey ? '导入成功（含模型 key）' : '导入成功');
      setTimeout(() => setNote(''), 2500);
    } catch (e) {
      setPaste(text.trim());
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function doImport() {
    try {
      /* 三种都能收：同步码 / 裸 token / 学校页面的地址 */
      const bundle = parseImportLink(paste);
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

  /* 从分享链接自动导入：链接形如 .../pwa/index.html#code=<同步码> 或 #token=<JWT>
     —— 一台有登录态的设备点「复制分享链接」，发给另一台设备点开即可，不用手打码。 */
  useEffect(() => {
    const src = (location.hash || '').replace(/^#/, '') || '';
    const m = /(?:code|token|idToken)=([^&]+)/i.exec(src);
    const hit = m && m[1] ? m[1] : '';
    if (!hit) return;
    (async () => {
      try {
        const raw = decodeURIComponent(hit);
        const bundle = parseImportLink(raw);
        const st = await importTokenBundle(bundle);
        setStatuses(st);
        const llmNow = await getLlmSettings();
        setLlm(llmNow);
        setNote('已从链接导入登录态');
        setTimeout(() => setNote(''), 2500);
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e));
      } finally {
        history.replaceState(null, '', location.pathname + location.search);
      }
    })();
  }, []);

  /** 手机端没有 content script；这里生成「分享链接」，发给另一台设备点开即用。 */
  async function shareLink() {
    try {
      const code = await exportTokenBundle();
      const url = location.origin + location.pathname + '#code=' + encodeURIComponent(code);
      await navigator.clipboard.writeText(url);
      setNote('分享链接已复制（长度 ' + url.length + '），发给另一台设备点开即可');
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setNote(''), 4000);
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
        <div class="chips">
          <button
            class={`chip${view === 'notices' ? ' on' : ''}`}
            onClick={() => {
              if (view === 'notices') {
                setView('chat');
                return;
              }
              setView('notices');
              if (noticeCards.length === 0 && !noticeBusy) void loadNotices();
            }}
          >
            {view === 'notices' ? '问答' : '通知'}
          </button>
          <button class="chip" onClick={() => setSheet(sheet === 'login' ? 'none' : 'login')}>
            {ready ? `教务 ${jwxt?.remainingText ?? '—'}` : '登录态'}
          </button>
        </div>
      </header>

      {sheet === 'login' && (
        <section class="sheet">
          <p class="hint">
            <strong>办法一：用「豫见郑大」App 的分享链接（实测最可靠，不依赖浏览器缓存）</strong>
          </p>
          <p class="hint">
            在 App 里打开任意页面 → 用「复制链接 / 分享 → 复制链接」，把链接粘到下面。<strong>鸿蒙版实测可用</strong>；
            安卓版 App 自带菜单里那个「复制链接」是坏的（剪贴板不变），试试<strong>系统级分享</strong>：长按页面或点右上角分享 → 选「复制链接」/ 发到微信再复制。
          </p>
          <p class="hint">
            <strong>办法二：点按钮去登录，登录完地址栏里就有 ticket（我们本地能解）</strong>
          </p>
          <p class="row">
            <a class="primary" href={CAS_LOGIN} target="_blank" rel="noreferrer">
              打开学校登录页
            </a>
          </p>
          <p class="hint">
            它去的是<strong>统一身份认证</strong>（不是树维那个登录页）。登录成功后你会看到<strong>一屏代码/样式文本</strong>——这是故意的：
            CAS 会把地址跳到一个<strong>静态样式文件</strong>上，这样页面不会启动门户那套单页应用，也就没人去把 <code>?ticket=</code> 从地址栏里抹掉。
            <br />· 这时<strong>长按地址栏 → 复制整条网址</strong>（形如 <code>…/static/index.a5c69d49.css?ticket=eyJ…</code>），粘到下面保存即可。
            <br />· <strong>ticket 本身就是 JWT，里面装着 idToken</strong>（学校 App 自己也是这么解的），我们本地解出来，不需要联网换票。
            <br />· 如果看到的是 404，<strong>也照样复制</strong>——地址栏里的 ticket 才是我们要的。
            <br />· 万一落回<strong>树维登录页</strong> → 回本页<strong>再点一次</strong>（此时 CAS 会话已在），或者改用办法一。
          </p>
          <p class="hint">
            ⚠️ 别直接打开 <code>cas.s.zzu.edu.cn</code> 根地址（没有 service 参数会 404），也别在教务站里输学校账号（那页是树维的，不认统一身份认证）。
          </p>
          <p class="hint">
            <strong>办法三：电脑同步（最稳）。</strong>电脑装扩展 → 侧边栏 ⚙ →「生成手机同步码」→ 把那段码发到手机粘进来（一张教务票 30 天）。
          </p>
          <textarea
            rows={4}
            placeholder="粘贴学校的网址（带 ticket 或 idToken 都行）／eyJ 开头的 token／同步码"
            value={paste}
            onInput={(e) => setPaste((e.target as HTMLTextAreaElement).value)}
          />
          {note && <p class="hint warn">{note}</p>}
          <div class="row">
            <button class="primary" onClick={() => void doImport()} disabled={!paste.trim()}>
              保存
            </button>
            <button class="ghost" onClick={() => void readClip()}>
              从剪贴板读取
            </button>
            <button class="ghost" onClick={() => void doExport()}>
              导出当前码
            </button>
            <button class="ghost" onClick={() => void shareLink()}>
              复制分享链接
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

      {view === 'notices' ? (
        <main class="notices-main">
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
          />
        </main>
      ) : (
        <main>
          {noticeDigest && (
            <NoticeTodayCard digest={noticeDigest} loading={noticeBusy} onOpen={() => setView('notices')} />
          )}
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
              {m.role === 'assistant' && !m.error && typeof m.data?.image === 'string' && (
                <figure class="seatmap">
                  <img src={String(m.data.image)} alt={String(m.data.imageAlt ?? '座位平面图')} />
                  <figcaption>绿点是空的 · 灰点已占</figcaption>
                </figure>
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
      )}

      {view === 'chat' && (
        <>
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
        </>
      )}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
