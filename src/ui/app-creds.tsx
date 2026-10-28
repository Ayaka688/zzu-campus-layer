/**
 * 「用学号密码换 30 天票」的设置块（扩展侧边栏与手机 PWA 共用）。
 *
 * 自己管存储、自己管表单，父组件直接 `<AppCreds />` 摆上去就行。
 *
 * 说明里对用户讲清楚两件事：
 *  - 密码只存本机，不上传、不进同步码；
 *  - 只有扩展里能直接换票（cas.s.zzu.edu.cn 不给 CORS），手机上是壳用 Java 换的——
 *    所以手机端在这里绑完，壳读到同一份 localStorage 就会用上。
 */
import { useEffect, useState } from 'preact/hooks';
import { clearAppCreds, describeCreds, getAppCreds, saveAppCreds, type StoredAppCreds } from '../core/creds';

interface Props {
  /** 浏览器页面（非扩展）里换不了票，就地提示一句 */
  browserOnly?: boolean;
}

export function AppCreds({ browserOnly = false }: Props) {
  const [saved, setSaved] = useState<StoredAppCreds | null>(null);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    void (async () => {
      const got = await getAppCreds();
      setSaved(got);
      if (got) setAccount(got.account);
    })();
  }, []);

  async function doSave() {
    try {
      const next = await saveAppCreds({ account, password });
      setSaved(next);
      setPassword('');
      setNote('已保存：下次票快到期时会直接换一张 30 天的');
    } catch (err) {
      setNote(err instanceof Error ? err.message : '保存失败');
    }
  }

  async function doClear() {
    await clearAppCreds();
    setSaved(null);
    setAccount('');
    setPassword('');
    setNote('已清除');
  }

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
      <div class="row">
        <button class="mini" onClick={() => void doSave()} disabled={!account.trim() || !password}>
          绑定（换 30 天票）
        </button>
        {saved && (
          <button class="mini" onClick={() => void doClear()}>
            清除
          </button>
        )}
      </div>
      <p class="hint">
        当前：{describeCreds(saved)}
        {saved ? '（票到期前会自动换一张 30 天的）' : '（不绑也行：票只有 8 小时，靠浏览器里的登录态续）'}
        {note ? ` · ${note}` : ''}
      </p>
      {saved && (
        <p class="hint">
          这台设备第一次换票要先过一次短信验证（学校按设备认人）：在电脑上跑一次
          <code> npm run app:login </code>把 deviceId 登记成可信设备，之后就不用再验了。
        </p>
      )}
      {browserOnly && (
        <p class="hint warn">
          浏览器版换不了票（学校那边不给跨域）：绑完只在装了安卓壳的手机上生效，那里由壳直接发请求。
        </p>
      )}
    </div>
  );
}
