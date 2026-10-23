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
 * 登录页：在学校自己的页面里完成 CAS 登录（短信/扫码都行），
 * 登录成功那一刻地址栏带 idToken；拿不到就退而读 localStorage。
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
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                maybeHarvest(url);
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                maybeHarvest(url);
                // 地址里没有就翻 localStorage（jwxt 的 uni-app 会把 token 存这里）
                view.evaluateJavascript(
                        "(function(){try{return localStorage.getItem('idToken')||localStorage.getItem('X-Id-Token')||''}catch(e){return ''}})()",
                        value -> {
                            String t = clean(value);
                            if (isJwt(t)) finishWith(t);
                        });
            }
        });

        String start = getIntent().getStringExtra("url");
        web.loadUrl(start == null || start.isEmpty() ? AppConfig.LOGIN_URL : start);
    }

    private void maybeHarvest(String url) {
        if (url == null) return;
        try {
            Uri u = Uri.parse(url);
            for (String key : new String[]{"idToken", "userToken", "token"}) {
                String v = u.getQueryParameter(key);
                if (isJwt(v)) {
                    finishWith(v);
                    return;
                }
            }
            String frag = u.getFragment();
            if (frag != null && frag.contains("?")) {
                Uri f = Uri.parse("x://y?" + frag.substring(frag.indexOf('?') + 1));
                for (String key : new String[]{"idToken", "userToken", "token"}) {
                    String v = f.getQueryParameter(key);
                    if (isJwt(v)) {
                        finishWith(v);
                        return;
                    }
                }
            }
        } catch (Exception ignored) {
        }
    }

    /** evaluateJavascript 回来的字符串带引号，去掉。 */
    private static String clean(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        if (s.startsWith("\"") && s.endsWith("\"") && s.length() > 1) s = s.substring(1, s.length() - 1);
        return s;
    }

    private static boolean isJwt(String v) {
        if (v == null) return false;
        String s = v.trim();
        if (s.split("\\.").length != 3) return false;
        return s.length() > 60;
    }

    private void finishWith(String token) {
        if (done) return;
        done = true;
        Intent out = new Intent();
        out.putExtra("token", token.trim());
        setResult(RESULT_OK, out);
        finish();
    }

    @Override
    public boolean onCreateOptionsMenu(android.view.Menu menu) {
        menu.add(0, 1, 0, "我已登录，读取");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(android.view.MenuItem item) {
        if (item.getItemId() == 1) {
            web.evaluateJavascript(
                    "(function(){try{return localStorage.getItem('idToken')||localStorage.getItem('X-Id-Token')||''}catch(e){return ''}})()",
                    value -> {
                        String t = clean(value);
                        if (isJwt(t)) {
                            finishWith(t);
                        } else {
                            Toast.makeText(this, "这个页面里还没看到 idToken，先完成登录", Toast.LENGTH_LONG).show();
                        }
                    });
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
