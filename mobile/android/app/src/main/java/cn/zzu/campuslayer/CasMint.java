package cn.zzu.campuslayer;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 纯 Java 静默换票：借 WebView 里现成的 CAS 会话，一条 GET 就换一张新票。
 *
 * <p>原理（2026-10 实测，详见 docs/cas-long-term-token.md）：
 *
 * <pre>
 * GET https://cas.s.zzu.edu.cn/cas/s/login?service=https://uniapp.s.zzu.edu.cn/
 *   CAS 会话（TGC，14 天）还在 → 302 到 https://uniapp.s.zzu.edu.cn/?…&amp;ticket=&lt;JWT&gt;
 *   会话没了 → 200 登录页，没有 ticket
 * </pre>
 *
 * <p>ticket 是 JWT，payload 里的 idToken 就是要的东西；这里不解析，直接把带 ticket 的地址
 * 交给网页里的 __campusImport（它已经会解 ticket，见 parseImportLink）。
 *
 * <p>为什么要这么干：网页里的 fetch 会被 CORS 拦住（PWA 跑在 github.io 域名下），
 * 而 Java 自己发请求不受 CORS 约束；cookie 从 CookieManager 里取，和登录页共用同一个会话。
 */
final class CasMint {

    /** 只有「前端站」形态的 service 会签出 JWT ticket；jwxt 域只给不透明 ST-xxxx。 */
    private static final String SERVICE = "https://uniapp.s.zzu.edu.cn/";
    private static final String MINT_URL = "https://cas.s.zzu.edu.cn/cas/s/login?service=" + SERVICE;

    private static final Pattern TICKET = Pattern.compile("[?&]ticket=([A-Za-z0-9._%+-]+)");

    private CasMint() {}

    /**
     * 静默换票。
     *
     * @param cookieHeader {@code CookieManager.getInstance().getCookie("https://cas.s.zzu.edu.cn")}
     *                     的结果，null/空表示这个站点还没有 cookie（必然换不到）
     * @return 可以直接喂给 __campusImport 的地址（…?ticket=…），失败返回 null
     */
    static String mint(String cookieHeader) {
        if (cookieHeader == null || cookieHeader.isEmpty()) return null;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(MINT_URL).openConnection();
            conn.setRequestMethod("GET");
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("Cookie", cookieHeader);
            conn.setRequestProperty("Accept", "text/html,application/xhtml+xml");
            /* 校方口径的 UA：跟 WebView 里一致，别让网关觉得是别的客户端 */
            conn.setRequestProperty("User-Agent", ua());
            conn.setUseCaches(false);

            int code = conn.getResponseCode();
            if (code < 300 || code >= 400) {
                /* 200 = 被打回登录页（会话没了），其它都是异常，都算换不到 */
                drain(conn);
                return null;
            }
            String location = conn.getHeaderField("Location");
            if (location == null) return null;
            Matcher m = TICKET.matcher(location);
            if (!m.find()) return null; // 302 到登录页或别的站点
            return "https://uniapp.s.zzu.edu.cn/?ticket=" + m.group(1);
        } catch (IOException | RuntimeException e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String ua() {
        return "Mozilla/5.0 (Linux; Android 14; WebView) AppleWebKit/537.36 (KHTML, like Gecko) "
                + "Chrome/124.0.0.0 Mobile Safari/537.36";
    }

    /** 关掉响应体，别让连接挂着（302 一般没有体，但有些网关会塞一段 HTML）。 */
    private static void drain(HttpURLConnection conn) {
        try (InputStream in = conn.getErrorStream() != null ? conn.getErrorStream() : conn.getInputStream()) {
            if (in == null) return;
            byte[] buf = new byte[2048];
            int guard = 0;
            while (in.read(buf) > 0 && guard++ < 16) {
                /* 只为了把连接读干净 */
            }
        } catch (IOException ignored) {
            /* 读不干净也无所谓，finally 里会 disconnect */
        }
    }
}
