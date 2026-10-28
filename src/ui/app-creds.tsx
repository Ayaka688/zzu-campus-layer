/**
 * 「用学号密码换 30 天票」的设置块（扩展侧边栏与手机 PWA 共用），带绑定向导。
 *
 * 自己管存储、自己管表单，父组件直接 `<AppCreds />` 摆上去就行。
 *
 * 三件事对用户讲清楚：
 *  - 密码只存本机，不上传、不进同步码；
 *  - 学校按设备认人：新设备第一次换票要过一次短信验证，过了之后就不用再验（设备登记）；
 *  - 换票这件事浏览器里做不了（cas.s 不给跨域），扩展靠 host_permissions、手机靠安卓壳代发。
 */
import { useEffect, useState } from 'preact/hooks';
import { canMintInBrowser } from '../core/casMint';
import { mintViaApp } from '../core/appMint';
import {
  canBindInShell,
  clearShellCrash,
  shellLastCrash,
  startBind,
  startBindInShell,
  submitCode,
  submitCodeInShell,
  type BindContext,
} from '../core/appBind';
import {
  clearAppCreds,
  describeCreds,
  getAppCreds,
  markCredsTrusted,
  saveAppCreds,
  type StoredAppCreds,
} from '../core/creds';
import { saveToken } from '../core/storage';

interface Props {
  /** 浏览器页面（非扩展、非壳）里换不了票，就地提示一句 */
  browserOnly?: boolean;
}

type BindMode = 'shell' | 'fetch' | 'none';

function bindMode(): BindMode {
  if (canBindInShell()) return 'shell';
  if (canMintInBrowser()) return 'fetch';
  return 'none';
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; what: string }
  | { kind: 'code'; ctx: BindContext; phone: string }
  | { kind: 'done' };

export function AppCreds({ browserOnly = false }: Props) {
  const [saved, setSaved] = useState<StoredAppCreds | null>(null);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [crash, setCrash] = useState('');

  const mode = bindMode();

  useEffect(() => {
    void (async () => {
      const got = await getAppCreds();
      setSaved(got);
      if (got) setAccount(got.account);
    })();
    // 壳里上一次闪退留下的栈：摆出来，用户能直接复制给开发者（手机上没有 logcat）
    setCrash(shellLastCrash().trim());
  }, []);

  /** 拿到票就写两个槽位（实测同一张 idToken 教务与门户都认）。 */
  async function storeToken(token: string): Promise<void> {
    await saveToken('jwxt', token);
    await saveToken('portal', token);
  }

  /** 已经可信：直接换一张 30 天的，不用验证码。 */
  async function mintNow(): Promise<void> {
    const out = await mintViaApp((await getAppCreds()) ?? { account, password, deviceId: saved?.deviceId ?? '' });
    if (out.ok) {
      await storeToken(out.idToken);
      setNote('这台设备已经登记过了，直接换到了一张 30 天的票');
    } else if (out.reason === 'mfa') {
      setNote('这台设备还需要过一次短信验证，点「绑定」开始');
    } else {
      setNote(`换票没成：${out.detail ?? out.reason}`);
    }
  }

  async function doBind() {
    setNote('');
    const useSaved = Boolean(saved) && !password && account.trim() === (saved?.account ?? '');
    let creds: StoredAppCreds;
    if (useSaved && saved) {
      // 密码已经存过了：不用再敲一遍（上一次失败后密码框是空的，不能让它把按钮卡死）
      creds = saved;
    } else {
      try {
        creds = await saveAppCreds({ account, password });
        setSaved(creds);
        setPassword('');
      } catch (err) {
        setNote(err instanceof Error ? err.message : '保存失败');
        return;
      }
    }

    if (mode === 'none') {
      setNote('这里换不了票：cas.s 不给跨域。手机装上安卓壳、或在本机跑 npm run app:login。');
      return;
    }

    setPhase({ kind: 'busy', what: mode === 'shell' ? '让壳发短信…' : '正在发短信…' });
    const started = mode === 'shell' ? await startBindInShell(creds) : await startBind(creds);
    if (!started.ok) {
      setPhase({ kind: 'idle' });
      setNote(`绑定失败：${started.detail ?? started.reason}`);
      return;
    }
    if (started.trusted) {
      setPhase({ kind: 'idle' });
      await mintNow();
      return;
    }
    setPhase({ kind: 'code', ctx: started.ctx, phone: started.phone });
    setNote(`验证码已发到 ${started.phone || '你的手机'}，填进来即可`);
  }

  async function doVerify() {
    if (phase.kind !== 'code') return;
    setPhase({ kind: 'busy', what: '校验中…' });
    const out = mode === 'shell' ? await submitCodeInShell(code) : await submitCode(phase.ctx, code);
    if (!out.ok) {
      setPhase({ kind: 'code', ctx: phase.ctx, phone: phase.phone });
      setNote(out.detail ?? '验证码不对');
      return;
    }
    await markCredsTrusted();
    setSaved(await getAppCreds());
    setCode('');

    if (out.idToken) {
      // 壳里校验完顺手换了票，直接用
      await storeToken(out.idToken);
      setPhase({ kind: 'done' });
      setNote('绑定完成，已换到一张 30 天的票');
      return;
    }
    const minted = await mintViaApp((await getAppCreds())!);
    if (minted.ok) {
      await storeToken(minted.idToken);
      setPhase({ kind: 'done' });
      setNote('绑定完成，已换到一张 30 天的票');
    } else {
      setPhase({ kind: 'done' });
      setNote(`设备已登记，但这次换票没成：${minted.detail ?? minted.reason}（下次自动重试）`);
    }
  }

  async function doResend() {
    if (phase.kind !== 'code') return;
    const creds = await getAppCreds();
    if (!creds) return;
    setPhase({ kind: 'busy', what: '重发中…' });
    const started = mode === 'shell' ? await startBindInShell(creds) : await startBind(creds);
    if (!started.ok) {
      setPhase({ kind: 'code', ctx: phase.ctx, phone: phase.phone });
      setNote(started.detail ?? '重发失败（短信有频率限制，等一分钟再试）');
      return;
    }
    if (started.trusted) {
      setPhase({ kind: 'idle' });
      await mintNow();
      return;
    }
    setPhase({ kind: 'code', ctx: started.ctx, phone: started.phone });
    setNote(`验证码已重发到 ${started.phone || '你的手机'}`);
  }

  async function doClear() {
    await clearAppCreds();
    setSaved(null);
    setAccount('');
    setPassword('');
    setCode('');
    setPhase({ kind: 'idle' });
    setNote('已清除');
  }

  const busy = phase.kind === 'busy';
  const inCode = phase.kind === 'code';
  // 密码框空着、但存过同一学号的密码 → 允许直接点（省得每次失败都要重敲）
  const canUseSaved = Boolean(saved) && !password && account.trim() === (saved?.account ?? '');
  const canBind = Boolean(password) || canUseSaved;

  return (
    <div class="llm-fields">
      <label class="row">
        <span>学号</span>
        <input
          class="key"
          placeholder="2026…（只存本机，不上传）"
          value={account}
          onInput={(e) => setAccount((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <label class="row">
        <span>密码</span>
        <input
          type="password"
          class="key"
          placeholder="统一身份认证密码"
          value={password}
          onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      {inCode && (
        <label class="row">
          <span>验证码</span>
          <input
            class="key"
            inputMode="numeric"
            maxLength={8}
            placeholder="短信里的 4~6 位数字"
            value={code}
            onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doVerify();
            }}
          />
        </label>
      )}
      <div class="row">
        {!inCode && (
          <button
            class="mini"
            onClick={() => void doBind()}
            disabled={busy || !account.trim() || !canBind}
          >
            {busy ? (phase.what ?? '处理中…') : '绑定（换 30 天票）'}
          </button>
        )}
        {inCode && (
          <>
            <button class="mini" onClick={() => void doVerify()} disabled={busy || code.trim().length < 4}>
              提交验证码
            </button>
            <button class="mini" onClick={() => void doResend()} disabled={busy}>
              重发
            </button>
          </>
        )}
        {saved && (
          <button class="mini" onClick={() => void doClear()} disabled={busy}>
            清除
          </button>
        )}
      </div>
      <p class="hint">
        当前：{describeCreds(saved)}
        {saved ? '（票到期前会自动换一张 30 天的）' : '（不绑也行：票只有 8 小时，靠浏览器里的登录态续）'}
        {note ? ` · ${note}` : ''}
      </p>
      {saved && !saved.trustedAt && mode === 'fetch' && (
        <p class="hint">
          这台设备还没过短信验证：点上面的「绑定」，填一次短信里的码，之后就不用再验了。
        </p>
      )}
      {saved && !saved.trustedAt && mode === 'shell' && (
        <p class="hint">
          点「绑定」会给你发一条短信（学校按设备认人）：填一次码，这台手机就登记成可信设备了。
          {canUseSaved ? '密码已经存过了，直接点就行。' : ''}
        </p>
      )}
      {saved && !saved.trustedAt && mode === 'none' && (
        <p class="hint">
          这台设备还没过短信验证，而这里发不了请求（cas.s 不给跨域）：手机装上安卓壳，或在本机跑一次
          <code> npm run app:login </code>。
        </p>
      )}
      {browserOnly && mode === 'none' && (
        <p class="hint warn">
          浏览器版换不了票（学校那边不给跨域）：绑完只在装了安卓壳的手机上生效，那里由壳直接发请求。
        </p>
      )}
      {phase.kind === 'done' && <p class="hint ok">绑定完成 ✅ 之后票快到期时，纯账密就能静默换新票。</p>}
      {crash !== '' && (
        <div class="hint warn">
          <p>上次闪退了，壳记下来的栈是：</p>
          <pre class="crash">{crash.length > 900 ? `${crash.slice(0, 900)}…` : crash}</pre>
          <button
            class="mini"
            onClick={() => {
              clearShellCrash();
              setCrash('');
            }}
          >
            已读，清掉
          </button>
        </div>
      )}
    </div>
  );
}
