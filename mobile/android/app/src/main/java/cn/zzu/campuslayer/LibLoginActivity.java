package cn.zzu.campuslayer;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * 让用户在壳内登录图书馆空间预约（order.lib.zzu.edu.cn）。
 * 登录成功后从 sessionStorage 里取 token，存进 App 私有存储，回传给 MainActivity。
 * 该站是纯 http，所以这里必须允许混合内容。
 */
public class LibLoginActivity extends Activity {
    private WebView web;
    private boolean done;
    private final android.os.Handler poll = new android.os.Handler(android.os.Looper.getMainLooper());
    private int tries;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(AppConfig.USER_AGENT);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                harvest();
            }
        });

        String start = AppConfig.LIB_LOGIN_URL;
        Intent it = getIntent();
        if (it != null) {
            String extra = it.getStringExtra("url");
            if (extra != null && !extra.trim().isEmpty()) start = extra;
        }
        web.loadUrl(start);
        startPolling();
        Toast.makeText(this, "登录完成后会自动回到应用", Toast.LENGTH_LONG).show();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, "我已登录，读取");
        menu.add(0, 2, 1, "刷新");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) {
            harvest();
            return true;
        }
        if (item.getItemId() == 2) {
            web.reload();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }


    /** 那个站点登录后不一定触发 onPageFinished，所以每 1.5 秒自己去问一次 token。 */
    private void startPolling() {
        poll.postDelayed(new Runnable() {
            @Override public void run() {
                if (done || isFinishing()) return;
                harvest();
                if (!done && tries++ < 60) poll.postDelayed(this, 1500);
            }
        }, 1500);
    }

    @Override
    protected void onDestroy() {
        poll.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
    private void harvest() {
        if (done) return;
        // 图书馆站点把登录票据放在 sessionStorage.token；顺带兼容 cookie 里的 userToken
        final String js = "(function(){try{var t=sessionStorage.getItem('token')||'';return t;}catch(e){return '';}})()";
        web.evaluateJavascript(js, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                String token = unquote(value);
                if (token.length() > 20) {
                    finishWith(token);
                    return;
                }
                web.evaluateJavascript("(function(){try{return document.cookie||'';}catch(e){return '';}})()",
                        new ValueCallback<String>() {
                            @Override public void onReceiveValue(String cookie) {
                                String t = pickToken(unquote(cookie));
                                if (t != null) finishWith(t);
                            }
                        });
            }
        });
    }

    private static String pickToken(String cookie) {
        if (cookie == null) return null;
        for (String part : cookie.split(";")) {
            String p = part.trim();
            int eq = p.indexOf('=');
            if (eq <= 0) continue;
            String k = p.substring(0, eq).trim();
            String v = p.substring(eq + 1).trim();
            if ((k.equalsIgnoreCase("userToken") || k.equalsIgnoreCase("token")) && v.length() > 20) return v;
        }
        return null;
    }

    private static String unquote(String v) {
        if (v == null) return "";
        String s = v.trim();
        if (s.startsWith("\"") && s.endsWith("\"") && s.length() > 1) s = s.substring(1, s.length() - 1);
        return s.replace("\\u003d", "=").replace("\\/", "/");
    }

    private void finishWith(String token) {
        done = true;
        LibSeatClient.saveToken(this, token);
        Intent out = new Intent();
        out.putExtra("token", token);
        setResult(RESULT_OK, out);
        finish();
    }
}
