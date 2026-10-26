package cn.zzu.campuslayer;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * 壳内登录页。
 *
 * 入口指向「CAS + 一个静态样式文件」：CAS 的白名单只按域名匹配，
 * 静态文件又不会启动门户那套单页应用 —— 单页应用一启动就会把 ?ticket= 从地址里抹掉。
 * 于是登录成功后 WebView 的地址里会留着 ?ticket=<JWT>，我们在这里就地抓住它，
 * 交给主页面（PWA）去解码：ticket 的 payload 里就装着 idToken。
 *
 * 抓不到 URL 时还有两层兜底：地址里的 idToken=、页面里的 localStorage。
 */
public class LoginActivity extends Activity {

    private WebView web;
    private boolean done;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        web = new WebView(this);
        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUserAgentString(AppConfig.USER_AGENT);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (harvestUrl(url)) {
                    return true;
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (harvestUrl(url)) {
                    return;
                }
                // 最后兜底：有些落点会把 token 存进 localStorage
                view.evaluateJavascript(SNAPSHOT, value -> {
                    String raw = clean(value);
                    if (raw.isEmpty()) {
                        return;
                    }
                    String[] parts = raw.split("\n");
                    if (parts.length > 0 && harvestUrl(parts[0])) {
                        return;
                    }
                    if (parts.length > 1 && isJwt(parts[1])) {
                        finishWithPayload(parts[1]);
                    }
                });
                startPoll();
            }
        });

        String start = getIntent().getStringExtra("url");
        web.loadUrl(start == null || start.isEmpty() ? AppConfig.LOGIN_URL : start);
        Toast.makeText(this, "用学校账号登录，成功后会自动回到应用", Toast.LENGTH_LONG).show();
    }

    private android.os.Handler poller;
    private int pollCount = 0;

    /** 落地页换完票才写 localStorage，所以每隔 1.5 秒读一次，最多 40 次（约 1 分钟）。 */
    private void startPoll() {
        if (poller != null) {
            return;
        }
        poller = new android.os.Handler(android.os.Looper.getMainLooper());
        poller.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (done) {
                    return;
                }
                web.evaluateJavascript(SNAPSHOT, value -> {
                    String raw = clean(value);
                    String[] parts = raw.split("\n");
                    if (parts.length > 1 && isJwt(parts[1])) {
                        finishWithPayload(parts[1]);
                    }
                });
                pollCount++;
                if (!done && pollCount < 40) {
                    poller.postDelayed(this, 1500);
                }
            }
        }, 1500);
    }

    private static final String SNAPSHOT =
            "(function(){try{return location.href+'\\n'+(localStorage.getItem('idToken')"
            + "||localStorage.getItem('X-Id-Token')||'')}catch(e){return ''}})()";

    /** 地址里带 ticket / idToken 就当场收工。返回 true 表示已处理。 */
    private boolean harvestUrl(String url) {
        if (url == null || done) {
            return false;
        }

        // 1) 我们最想要的：?ticket=<JWT>（指向静态样式文件时它会一直留着）
        if (url.contains("ticket=")) {
            // CAS 的普通服务票据（ST-xxxx）不是 JWT，解不出 idToken；
            // 这种情况必须让页面继续加载——uniapp 会拿它去换票并写进 localStorage。
            String tk = url.substring(url.indexOf("ticket=") + 7);
            int amp = tk.indexOf('&');
            if (amp >= 0) {
                tk = tk.substring(0, amp);
            }
            if (tk.indexOf('.') > 0) {
                finishWithPayload(url);
                return true;
            }
            return false;
        }

        // 2) 某些落点直接给 idToken / userToken / token
        try {
            Uri u = Uri.parse(url);
            for (String key : new String[]{"idToken", "userToken", "token"}) {
                String v = u.getQueryParameter(key);
                if (isJwt(v)) {
                    finishWithPayload(v);
                    return true;
                }
            }
            String frag = u.getFragment();
            if (frag != null && frag.contains("?")) {
                Uri f = Uri.parse("x://y?" + frag.substring(frag.indexOf('?') + 1));
                for (String key : new String[]{"idToken", "userToken", "token"}) {
                    String v = f.getQueryParameter(key);
                    if (isJwt(v)) {
                        finishWithPayload(v);
                        return true;
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    private static String clean(String raw) {
        if (raw == null) {
            return "";
        }
        String s = raw.trim();
        if (s.startsWith("\"") && s.endsWith("\"") && s.length() > 1) {
            s = s.substring(1, s.length() - 1);
        }
        return s.replace("\\n", "\n").replace("\\/", "/");
    }

    private static boolean isJwt(String v) {
        if (v == null) {
            return false;
        }
        String s = v.trim();
        return s.split("\\.").length == 3 && s.length() > 60;
    }

    private void finishWithPayload(String payload) {
        if (done) {
            return;
        }
        done = true;
        Intent out = new Intent();
        out.putExtra("payload", payload.trim());
        setResult(RESULT_OK, out);
        finish();
    }

    @Override
    public boolean onCreateOptionsMenu(android.view.Menu menu) {
        menu.add(0, 1, 0, "我已登录，读取当前页面");
        menu.add(0, 2, 1, "刷新");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(android.view.MenuItem item) {
        if (item.getItemId() == 1) {
            web.evaluateJavascript(SNAPSHOT, value -> {
                String raw = clean(value);
                String[] parts = raw.split("\n");
                boolean ok = parts.length > 0 && harvestUrl(parts[0]);
                if (!ok && parts.length > 1 && isJwt(parts[1])) {
                    finishWithPayload(parts[1]);
                    ok = true;
                }
                if (!ok) {
                    Toast.makeText(this, "这个页面里还没看到 ticket，先完成登录", Toast.LENGTH_LONG).show();
                }
            });
            return true;
        }
        if (item.getItemId() == 2) {
            web.reload();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    protected void onDestroy() {
        if (poller != null) {
            poller.removeCallbacksAndMessages(null);
        }
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
