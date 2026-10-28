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

    private boolean silent = false;

    /** 静默续期的硬上限：CAS 若弹了登录表单（TGT 过期），再等也不会自己好。 */
    private static final long SILENT_DEADLINE_MS = 12_000;
    /** 门户首页：只有它会把 81.8 小时那张 idToken 写进 localStorage。 */
    private static final String PORTAL_HOME = "https://uniapp.s.zzu.edu.cn/pages/tab/index/index";
    /** CAS 回跳 URL 上的票（通常 8 小时），先存着，最后和 localStorage 的票比长短。 */
    private String urlTicket = "";
    private boolean wentPortal = false;
    private Runnable silentDeadline;

    private WebView web;
    private boolean done;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        silent = getIntent().getBooleanExtra("silent", false);

        web = new WebView(this);
        if (silent) {
            // 静默续期：不占屏幕、不给用户任何感知
            // 注意：只 setAlpha(0) 时窗口本身还是黑的，用户会看到「黑屏」
            try {
                getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(0x00000000));
                getWindow().setDimAmount(0f);
            } catch (Throwable ignored) {
                // 老系统不支持就算了
            }
            web.setAlpha(0f);
            setContentView(web, new ViewGroup.LayoutParams(1, 1));
            // 12 秒没拿到票就当「需要人工」：直接结束，让外面自动打开可见登录页
            silentDeadline = new Runnable() {
                @Override
                public void run() {
                    if (done) {
                        return;
                    }
                    done = true;
                    setResult(RESULT_CANCELED);
                    finish();
                }
            };
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(silentDeadline, SILENT_DEADLINE_MS);
        } else {
            setContentView(web, new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }

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
                    startPoll();
                    return;
                }
                // 先看 localStorage 里有没有「更长的票」：门户/教务自己种的 idToken 可能是 30 天，
                // 而 CAS 回跳 URL 上那张只有 8 小时。两者都在时取剩余时间更长的那个。
                view.evaluateJavascript(SNAPSHOT, value -> {
                    String raw = clean(value);
                    String[] parts = raw.isEmpty() ? new String[0] : raw.split("\n");
                    String local = parts.length > 1 && isJwt(parts[1]) ? parts[1] : "";
                    String fromUrl = parts.length > 0 ? ticketPayload(parts[0]) : "";
                    String best = waitForLocal(local, fromUrl);
                    if (best != null) {
                        finishWithPayload(best);
                        return;
                    }
                });
                startPoll();
            }
        });

        String start = getIntent().getStringExtra("url");
        web.loadUrl(start == null || start.isEmpty() ? AppConfig.LOGIN_URL : start);
        if (!silent) {
            Toast.makeText(this, "用学校账号登录，成功后会自动回到应用", Toast.LENGTH_LONG).show();
        }
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
                    String[] parts = raw.isEmpty() ? new String[0] : raw.split("\n");
                    String local = parts.length > 1 && isJwt(parts[1]) ? parts[1] : "";
                    String fromUrl = !urlTicket.isEmpty() ? ticketPayload(urlTicket)
                            : (parts.length > 0 ? ticketPayload(parts[0]) : "");
                    String best = waitForLocal(local, fromUrl);
                    if (best != null) {
                        finishWithPayload(best);
                    } else if (!urlTicket.isEmpty()) {
                        // 门户首页迟迟不写 localStorage：退回 URL 上那张短票，别让用户干等
                        pollCount++;
                        if (pollCount >= 6) {
                            finishWithPayload(urlTicket);
                        }
                    }
                });
                if (silent) {
                    // 已经落到登录表单上了，再等一秒也没意义
                    web.evaluateJavascript(
                            "(function(){var a=document.querySelector('input[name=\"username\"],#username,#un,#userName');"
                                    + "var p=document.querySelector('input[type=password]');return (a&&p)?'1':'0';})()",
                            v -> {
                                if (!done && v != null && v.contains("1")) {
                                    done = true;
                                    setResult(RESULT_CANCELED);
                                    finish();
                                }
                            });
                }
                pollCount++;
                if (!done && pollCount < 40) {
                    poller.postDelayed(this, 1500);
                }
            }
        }, 1500);
    }

    /** 从 JWT 里读 exp/iat，返回有效期小时数；读不到返回 -1。 */
    private static double ttlHours(String token) {
        try {
            String[] p = token.split("\\.");
            if (p.length < 2) return -1;
            String body = p[1].replace('-', '+').replace('_', '/');
            while (body.length() % 4 != 0) body += "=";
            String json = new String(android.util.Base64.decode(body, android.util.Base64.DEFAULT), "UTF-8");
            java.util.regex.Matcher me = java.util.regex.Pattern.compile("\"exp\"\\s*:\\s*(\\d+)").matcher(json);
            java.util.regex.Matcher mi = java.util.regex.Pattern.compile("\"iat\"\\s*:\\s*(\\d+)").matcher(json);
            if (!me.find()) return -1;
            long exp = Long.parseLong(me.group(1));
            long iat = mi.find() ? Long.parseLong(mi.group(1)) : 0;
            if (iat <= 0) return -1;
            return (exp - iat) / 3600.0;
        } catch (Throwable e) {
            return -1;
        }
    }

    /** 现在的票还剩多少小时（用 exp - now）。 */
    private static double leftHours(String token) {
        try {
            String[] p = token.split("\\.");
            if (p.length < 2) return -1;
            String body = p[1].replace('-', '+').replace('_', '/');
            while (body.length() % 4 != 0) body += "=";
            String json = new String(android.util.Base64.decode(body, android.util.Base64.DEFAULT), "UTF-8");
            java.util.regex.Matcher me = java.util.regex.Pattern.compile("\"exp\"\\s*:\\s*(\\d+)").matcher(json);
            if (!me.find()) return -1;
            long exp = Long.parseLong(me.group(1)) * 1000L;
            return (exp - System.currentTimeMillis()) / 3600000.0;
        } catch (Throwable e) {
            return -1;
        }
    }

    private static final String SNAPSHOT =
            "(function(){try{return location.href+'\\n'+(localStorage.getItem('idToken')"
            + "||localStorage.getItem('X-Id-Token')||'')}catch(e){return ''}})()";

    /** URL 里的 ticket 是不是 JWT？是就返回"整条 URL"（下游会再解析）。 */
    private static String ticketPayload(String url) {
        if (url == null || !url.contains("ticket=")) return "";
        String tk = url.substring(url.indexOf("ticket=") + 7);
        int amp = tk.indexOf('&');
        if (amp >= 0) tk = tk.substring(0, amp);
        return tk.indexOf('.') > 0 ? url : "";
    }

    /** 门户首页还没写 localStorage 时先别急着用短票：只有本地票确实更长才收工。 */
    private String waitForLocal(String local, String fromUrl) {
        double l = isJwt(local) ? leftHours(local) : -1;
        double u = fromUrl != null && !fromUrl.isEmpty() ? leftHours(fromUrl) : -1;
        if (l > 0 && l >= u) return local;
        if (u <= 0) return null;
        // 只有「本来就没有 URL 短票」时才直接用它；否则等门户写长票
        return urlTicket.isEmpty() ? fromUrl : null;
    }

    /** 两个候选里选剩余时间更长的；都不行返回 null。 */
    private static String pickLonger(String local, String fromUrl) {
        double l = isJwt(local) ? leftHours(local) : -1;
        double u = fromUrl != null && !fromUrl.isEmpty() ? leftHours(fromUrl) : -1;
        if (l <= 0 && u <= 0) return null;
        return l >= u ? local : fromUrl;
    }

    /** 拿到票之后再去一趟门户首页：只有门户应用会把长票写进 localStorage。 */
    private void goPortal() {
        if (wentPortal || done) {
            return;
        }
        wentPortal = true;
        web.post(() -> web.loadUrl(PORTAL_HOME));
    }

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
                urlTicket = url;
                goPortal();
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

    /** 诊断：收工前把「落在哪个页面 / localStorage 有哪些键 / idToken 长度」弹出来。 */
    private void toastDiag() {
        try {
            web.evaluateJavascript(DIAG_JS, v -> {
                try {
                    android.widget.Toast.makeText(this, "诊断 " + clean(v), android.widget.Toast.LENGTH_LONG).show();
                } catch (Throwable ignored) {
                }
            });
        } catch (Throwable ignored) {
        }
    }

    private static final String DIAG_JS =
            "(function(){var k=Object.keys(localStorage);"
                    + "return JSON.stringify({u:location.pathname.slice(0,28),n:k.length,"
                    + "i:(localStorage.getItem(\"idToken\")||\"\").length,"
                    + "x:(localStorage.getItem(\"X-Id-Token\")||\"\").length,"
                    + "k:k.slice(0,5).join(\",\")});})()";

    private void finishWithPayload(String payload) {
        toastDiag();
        try { android.widget.Toast.makeText(this, "登录态剩余 " + Math.round(leftHours(payload)) + " 小时", android.widget.Toast.LENGTH_LONG).show(); } catch (Throwable ignored) { }
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
        if (silentDeadline != null) {
            new android.os.Handler(android.os.Looper.getMainLooper()).removeCallbacks(silentDeadline);
            silentDeadline = null;
        }
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
