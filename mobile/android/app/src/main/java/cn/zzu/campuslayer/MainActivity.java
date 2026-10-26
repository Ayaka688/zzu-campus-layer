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
 * 登录现在直接在壳里做（菜单第一项「登录（推荐）」）：
 *   LoginActivity 打开「CAS + 静态样式文件」的入口，登录成功那一刻地址里带着
 *   ?ticket=<JWT>（ticket 的 payload 里就是 idToken），壳把这个地址原样交给
 *   页面的 window.__campusImport 去解析、解码、落库。
 *
 * 另外还留着两条备选：「从剪贴板导入」（用户在外面复制了带 token 的地址）、
 * 「用系统浏览器登录」（壳内 CAS 出问题时的兜底）。
 */
public class MainActivity extends Activity {

    private static final int REQ_LIB_LOGIN = 3002;
    private static final int REQ_LIB_BOOK = 3003;
    private boolean renewAsked = false;
    private String PENDING_BOOK_REQ = null;
    private static final int REQ_LOGIN = 3001;

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
                    "点页面里的「用学校账号登录」，登录一次就行——登录完会自动回来",
                    Toast.LENGTH_LONG).show();
        }
    }

    /** 网页 → 壳：一批课前提醒（{at,title,body} 的数组）。JS 接口在各线程回调，切回主线程。 */
    private class NotifyBridge {
        /** 页面 → 壳：立刻弹一条系统通知（有新通知时用）。 */
        /** 图书馆馆级余量（免登录）。 */
        @android.webkit.JavascriptInterface
        public void libTopFor(final String areaId, final String date, final String reqId) {
            web.post(new Runnable() {
                @Override public void run() {
            LibSeatClient.fetchTopAsync(web, MainActivity.this, areaId, date, reqId);
        
                }
            });
        }

        /** 是否已抓过图书馆票据。 */
        @android.webkit.JavascriptInterface
        public boolean libLoggedIn() {
            return LibSeatClient.hasToken(MainActivity.this);
        }

        /** 直接打开图书馆登录页。 */
        @android.webkit.JavascriptInterface
        public void loginLibrary() {
            runOnUiThread(new Runnable() {
                @Override public void run() { openLibraryLogin(); }
            });
        }

        /** 长按确认后真正下单：交给 LibBookActivity，由页面自己发 confirm（含 AES）。 */
        @JavascriptInterface
        public void bookSeat(final String areaId, final String date, final String seatNo, final String reqId) {
            web.post(new Runnable() {
                @Override public void run() {
                    if (!LibSeatClient.hasToken(MainActivity.this)) {
                        LibSeatClient.reply(web, reqId, false, "还没登录图书馆：先点菜单里的「登录图书馆」登录一次");
                        openLibraryLogin();
                        return;
                    }
                    PENDING_BOOK_REQ = reqId;
                    Intent it = new Intent(MainActivity.this, LibBookActivity.class);
                    it.putExtra("areaId", areaId);
                    it.putExtra("date", date);
                    it.putExtra("seatNo", seatNo);
                    startActivityForResult(it, REQ_LIB_BOOK);
                }
            });
        }
        /** 图书馆座位（只读）：有票据就原生直连取，没有就引导去登录。 */
        @android.webkit.JavascriptInterface
        public void libSeats(final String areaId, final String date, final String reqId) {
            web.post(new Runnable() {
                @Override public void run() {
            if (!LibSeatClient.loggedIn(MainActivity.this)) {
                String js = "window.__libSeats&&window.__libSeats("
                        + org.json.JSONObject.quote(reqId) + ","
                        + org.json.JSONObject.quote("{\"ok\":false,\"error\":\"还没登录图书馆：点右上角菜单里的「登录图书馆」，在打开的页面里用学号登录一次，回来再问\"}")
                        + ")";
                web.evaluateJavascript(js, null);
                openLibraryLogin();
                return;
            }
            LibSeatClient.fetchAsync(web, MainActivity.this, areaId, date, reqId);
        
                }
            });
        }

        @JavascriptInterface
        public void notify(String title, String body) {
            runOnUiThread(() -> ReminderReceiver.showNow(MainActivity.this, title, body));
        }

        /** 页面 → 壳：请求通知权限（用户打开开关时才问）。 */
        @JavascriptInterface
        public void askNotify() {
            runOnUiThread(MainActivity.this::askNotificationPermission);
        }

        /** 网页里的「用学校账号登录」按钮 → 壳：走壳内登录页，登录完自动回灌。 */
        @JavascriptInterface
        public void login() {
            runOnUiThread(MainActivity.this::openLogin);
        }

        @JavascriptInterface
        public void setReminders(String json) {
            runOnUiThread(() -> {
                ReminderScheduler.apply(MainActivity.this, json);
                Toast.makeText(MainActivity.this, "课前提醒已排好", Toast.LENGTH_SHORT).show();
            });
        }
    }

    /**
     * 登录态快到期（<2 小时）时，在后台静默续一次：
     * CAS 的 TGT cookie 还在的话，登录页会直接 302 带 ticket 回来，不用你重登。
     */
    private void maybeSilentRenew() {
        if (renewAsked || web == null) {
            return;
        }
        renewAsked = true;
        web.evaluateJavascript("(function(){try{var raw=localStorage.getItem('campus-layer:tokens');if(!raw)return '{\"need\":false}';var o=JSON.parse(raw);var j=(o.jwxt&&o.jwxt.token)||'';if(!j)return '{\"need\":false}';var b=j.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');var p=JSON.parse(decodeURIComponent(escape(atob(b))));var left=Math.round((p.exp*1000-Date.now())/60000);return JSON.stringify({need:left<120,leftMin:left});}catch(e){return '{\"need\":false}'}})()", value -> {
            String s = value == null ? "" : value;
            if (s.contains("\"need\":true")) {
                startActivityForResult(new Intent(MainActivity.this, LoginActivity.class).putExtra("silent", true), REQ_LOGIN);
            }
        });
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
        menu.add(0, 1, 0, "登录（推荐）");
        menu.add(0, 2, 1, "从剪贴板导入");
        menu.add(0, 4, 2, "用系统浏览器登录");
        menu.add(0, 5, 2, "登录图书馆");
        menu.add(0, 3, 3, "刷新");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(android.view.MenuItem item) {
        switch (item.getItemId()) {
            case 1: openLogin(); return true;
            case 4: openInBrowser(AppConfig.LOGIN_URL); return true;
            case 2: importFromClipboard(); return true;
            case 3: web.reload(); return true;
            case 5: openLibraryLogin(); return true;
            default: return super.onOptionsItemSelected(item);
        }
    }

    /** 壳内登录：登录页在 WebView 里跑，拿到票就自动回来（不用复制地址）。 */
    private void openLogin() {
        startActivityForResult(new Intent(this, LoginActivity.class), REQ_LOGIN);
    }

    private void openLibraryLogin() {
        startActivityForResult(new Intent(this, LibLoginActivity.class), REQ_LIB_LOGIN);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_LIB_BOOK) {
            String req = PENDING_BOOK_REQ;
            PENDING_BOOK_REQ = null;
            String payload = (data == null) ? null : data.getStringExtra("result");
            if (resultCode == RESULT_OK && payload != null) {
                LibSeatClient.deliverPublic(web, req, payload);
                Toast.makeText(this, "已提交，请核对图书馆页面上的结果", Toast.LENGTH_LONG).show();
            } else {
                LibSeatClient.reply(web, req, false, "已取消，没有提交预约");
            }
            return;
        }

        if (requestCode == REQ_LIB_LOGIN) {
            if (resultCode == RESULT_OK) {
                Toast.makeText(this, "图书馆登录成功，之后可以直接问座位号", Toast.LENGTH_LONG).show();
            }
            return;
        }
        if (requestCode != REQ_LOGIN || resultCode != RESULT_OK || data == null) {
            return;
        }
        String payload = data.getStringExtra("payload");
        if (payload == null || payload.trim().isEmpty()) {
            Toast.makeText(this, "没拿到登录信息，再试一次", Toast.LENGTH_LONG).show();
            return;
        }
        inject(payload.trim());
    }

    @Override
    protected void onResume() {
        super.onResume();
        maybeSilentRenew();
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
