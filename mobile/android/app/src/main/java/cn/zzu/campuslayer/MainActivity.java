package cn.zzu.campuslayer;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * 主界面：就是一块 WebView，装的是我们自己的 PWA。
 * 登录态由 LoginActivity 取到后通过 __campusImport 注入，用户不用复制任何东西。
 */
public class MainActivity extends Activity {

    private static final int REQ_LOGIN = 1001;

    private WebView web;

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
        s.setUserAgentString(s.getUserAgentString() + " CampusLayerShell/0.1");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return false; // 一切都在壳里走，不甩给外部浏览器
            }
        });

        web.loadUrl(AppConfig.APP_URL);

        /* 第一次打开、还没登录过，就直接把登录页推上来，省一次点击。 */
        if (!getPreferences(MODE_PRIVATE).getBoolean("logged_once", false)) {
            openLogin();
        }
    }

    private void openLogin() {
        startActivityForResult(new Intent(this, LoginActivity.class), REQ_LOGIN);
    }

    /** 备用登录页：直接开学校那个树维登录（CAS 那边万一变了还能兜一手）。 */
    private void openLoginFallback() {
        Intent i = new Intent(this, LoginActivity.class);
        i.putExtra("url", AppConfig.LOGIN_URL_FALLBACK);
        startActivityForResult(i, REQ_LOGIN);
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req != REQ_LOGIN) return;

        if (result != RESULT_OK || data == null) {
            Toast.makeText(this, "没拿到登录态，可以稍后在菜单里再登一次", Toast.LENGTH_LONG).show();
            return;
        }

        String token = data.getStringExtra("token");
        if (token == null || token.isEmpty()) return;

        getPreferences(MODE_PRIVATE).edit().putBoolean("logged_once", true).apply();
        inject(token);
    }

    /** 把 token 交给网页里的 PWA：window.__campusImport("…") */
    private void inject(String token) {
        String js = "window." + AppConfig.IMPORT_FN + " && window." + AppConfig.IMPORT_FN
                + "(" + quote(token) + ")";
        web.evaluateJavascript(js, value ->
                Toast.makeText(this, "登录态已导入", Toast.LENGTH_SHORT).show());
    }

    /** 最小可用的 JS 字符串字面量转义（token 只含 base64url 与点，够用）。 */
    private static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                default: sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    @Override
    public boolean onCreateOptionsMenu(android.view.Menu menu) {
        menu.add(0, 1, 0, "重新登录（统一认证）");
        menu.add(0, 3, 1, "备用：学校自带登录页");
        menu.add(0, 2, 2, "刷新");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(android.view.MenuItem item) {
        switch (item.getItemId()) {
            case 1: openLogin(); return true;
            case 3: openLoginFallback(); return true;
            case 2: web.reload(); return true;
            default: return super.onOptionsItemSelected(item);
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
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
