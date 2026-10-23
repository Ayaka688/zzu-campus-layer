package cn.zzu.campuslayer;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * 主界面 = 一块 WebView，装的是我们自己的 PWA。
 *
 * 登录刻意不在壳里做：学校的换票链（CAS → jwxt/uniapp → 树维前端）在 WebView 里
 * 会被那个前端判成"内嵌容器"而回落成树维账密页，实测无法稳定复刻。
 * 所以这里只做两件事：
 *   1）「用浏览器登录」——把登录页甩给系统浏览器（那条路已验证可用）；
 *   2）「导入剪贴板」——用户登录后复制的地址栏内容，直接交给 PWA 的 __campusImport 解析。
 */
public class MainActivity extends Activity {

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
        s.setUserAgentString(AppConfig.USER_AGENT);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return false;
            }
        });

        /* 课前提醒：网页侧算好时间点，通过这个桥交给壳去设闹钟。 */
        web.addJavascriptInterface(new NotifyBridge(), "CampusNotify");

        web.loadUrl(AppConfig.APP_URL);

        askNotificationPermission();
        ReminderScheduler.restore(this);

        /* 第一次打开时给个提示，而不是把登录页硬推上来。 */
        if (!getPreferences(MODE_PRIVATE).getBoolean("hinted", false)) {
            getPreferences(MODE_PRIVATE).edit().putBoolean("hinted", true).apply();
            Toast.makeText(this,
                    "先在系统浏览器里登录一次，再回来点菜单「导入剪贴板」",
                    Toast.LENGTH_LONG).show();
        }
    }

    /** 网页 → 壳：一批课前提醒（{at,title,body} 的数组）。JS 接口在各线程回调，切回主线程。 */
    private class NotifyBridge {
        @JavascriptInterface
        public void setReminders(String json) {
            runOnUiThread(() -> {
                ReminderScheduler.apply(MainActivity.this, json);
                Toast.makeText(MainActivity.this, "课前提醒已排好", Toast.LENGTH_SHORT).show();
            });
        }
    }

    /** Android 13+ 通知要用户授权，没有就当场问一次。 */
    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 2001);
    }

    /** 用系统浏览器打开登录页（CAS → 教学管理平台，登录成功后地址栏里就带着 idToken）。 */
    private void openInBrowser(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            Toast.makeText(this, "没有可用的浏览器：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    /** 读系统剪贴板，交给 PWA 自己解析（它认同步码、裸 token、学校页面网址三种）。 */
    private void importFromClipboard() {
        ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (cm == null || !cm.hasPrimaryClip()) {
            Toast.makeText(this, "剪贴板是空的：先在浏览器登录，再长按地址栏复制", Toast.LENGTH_LONG).show();
            return;
        }
        ClipData clip = cm.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) {
            Toast.makeText(this, "剪贴板里没有文本", Toast.LENGTH_LONG).show();
            return;
        }
        CharSequence text = clip.getItemAt(0).coerceToText(this);
        String raw = text == null ? "" : text.toString().trim();
        if (raw.isEmpty()) {
            Toast.makeText(this, "剪贴板里没有文本", Toast.LENGTH_LONG).show();
            return;
        }
        inject(raw);
    }

    /** 把内容交给网页里的 PWA：window.__campusImport("…")，由它负责解析与报错。 */
    private void inject(String raw) {
        String js = "window." + AppConfig.IMPORT_FN + " && window." + AppConfig.IMPORT_FN
                + "(" + quote(raw) + ")";
        web.evaluateJavascript(js, value ->
                Toast.makeText(this, "已交给页面处理", Toast.LENGTH_SHORT).show());
    }

    /** 最小可用的 JS 字符串字面量转义（token / URL 只含可打印字符，够用）。 */
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
        menu.add(0, 1, 0, "用浏览器登录");
        menu.add(0, 2, 1, "导入剪贴板");
        menu.add(0, 4, 2, "用浏览器登录（备用入口）");
        menu.add(0, 3, 3, "刷新");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(android.view.MenuItem item) {
        switch (item.getItemId()) {
            case 1: openInBrowser(AppConfig.LOGIN_URL); return true;
            case 4: openInBrowser(AppConfig.LOGIN_URL_FALLBACK); return true;
            case 2: importFromClipboard(); return true;
            case 3: web.reload(); return true;
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
