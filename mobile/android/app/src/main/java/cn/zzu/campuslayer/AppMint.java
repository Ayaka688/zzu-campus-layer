package cn.zzu.campuslayer;

import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

/**
 * 壳里的「账密直换 30 天票」。
 *
 * <p>这是学校 App（豫见郑大）那套接口，和网页 CAS（{@link CasMint} 用的 TGT cookie）是两条路：
 * <pre>
 *   GET  /token/jwt/publicKey                                → RSA 公钥
 *   POST /token/mfa/detect?username&amp;password&amp;deviceId       → { need, state }
 *   POST /token/password/passwordLogin?username&amp;password&amp;appId&amp;osType&amp;geo&amp;deviceId&amp;clientId&amp;mfaState
 *        → { data: { idToken(30 天), refreshToken(60 天) } }
 * </pre>
 * 密码要 RSA PKCS#1 v1.5 加密再 base64、前面挂 {@code __RSA__}。
 *
 * <p>只要 deviceId 之前过一次短信 MFA 被登记成「可信设备」，{@code need} 就是 false，
 * 这里一条请求就能拿到 30 天的票——比 TGT 那条（8 小时、还有 14 天硬上限）省事得多。
 * 设备不认识时（第一次、或换机）返回 null，交给上层退到 CAS 那条慢路。
 */
final class AppMint {

    private static final String BASE = "https://cas.s.zzu.edu.cn";
    private static final String APP_ID = "com.supwisdom.zzu";
    private static final String UA = "SWSuperApp/1.1.1()";
    private static final int TIMEOUT_MS = 12_000;

    private AppMint() {
    }

    /**
     * @param credsJson 形如 {@code {"account":"...","password":"...","deviceId":"..."}}（来自 PWA 的 localStorage）
     * @return 30 天的 idToken；拿不到（设备不可信 / 网络错 / 账号密码不对）返回 null
     */
    static String mint(String credsJson) {
        if (credsJson == null || credsJson.isEmpty()) {
            return null;
        }
        try {
            JSONObject o = new JSONObject(credsJson);
            String account = opt(o, "account");
            String password = opt(o, "password");
            String deviceId = opt(o, "deviceId");
            if (account.isEmpty() || password.isEmpty() || deviceId.isEmpty()) {
                return null;
            }
            String pem = get(BASE + "/token/jwt/publicKey", "okhttp/3.12.1");
            RsaPublicKey key = parseKey(pem);
            if (key == null) {
                return null;
            }

            String detectUrl = BASE + "/token/mfa/detect?username=" + enc(rsaEncrypt(key, account))
                    + "&password=" + enc(rsaEncrypt(key, password))
                    + "&deviceId=" + enc(deviceId);
            JSONObject detect = new JSONObject(post(detectUrl));
            if (detect.optInt("code", -1) != 0) {
                return null;
            }
            JSONObject ddata = detect.optJSONObject("data");
            if (ddata == null || ddata.optBoolean("need", true)) {
                // 这台设备还没登记成可信设备：得先人工过一遍 MFA，别在这儿卡住用户。
                return null;
            }
            String state = ddata.optString("state", "");

            String loginUrl = BASE + "/token/password/passwordLogin?username=" + enc(rsaEncrypt(key, account))
                    + "&password=" + enc(rsaEncrypt(key, password))
                    + "&appId=" + enc(APP_ID)
                    + "&osType=android&geo="
                    + "&deviceId=" + enc(deviceId)
                    + "&clientId="
                    + "&mfaState=" + enc(state);
            JSONObject login = new JSONObject(post(loginUrl));
            if (login.optInt("code", -1) != 0) {
                return null;
            }
            JSONObject ldata = login.optJSONObject("data");
            String idToken = ldata == null ? "" : ldata.optString("idToken", "");
            return idToken.isEmpty() ? null : idToken;
        } catch (Exception e) {
            return null;
        }
    }

    // ---- HTTP ----

    static String get(String url, String ua) throws Exception {
        HttpURLConnection c = open(url, ua);
        try {
            int code = c.getResponseCode();
            String body = read(c, code);
            return code == 200 ? body : "";
        } finally {
            c.disconnect();
        }
    }

    static String post(String url) throws Exception {
        HttpURLConnection c = open(url, UA);
        c.setRequestMethod("POST");
        c.setDoOutput(false);
        try {
            int code = c.getResponseCode();
            return read(c, code);
        } finally {
            c.disconnect();
        }
    }

    private static HttpURLConnection open(String url, String ua) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(TIMEOUT_MS);
        c.setReadTimeout(TIMEOUT_MS);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("User-Agent", ua);
        c.setRequestProperty("Accept", "application/json, text/plain, */*");
        return c;
    }

    static String read(HttpURLConnection c, int code) throws Exception {
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        if (in == null) {
            return "";
        }
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            in.close();
        }
    }

    static String enc(String s) throws Exception {
        return URLEncoder.encode(s, "UTF-8");
    }

    static String opt(JSONObject o, String k) {
        String v = o.optString(k, "");
        return v == null ? "" : v.trim();
    }

    // ---- RSA（PKCS#1 v1.5） ----
    // 不用 Cipher：Android 上 "RSA/ECB/PKCS1Padding" 各版本行为不一，而这里只需要
    // 「填充 + 一次模幂」，手写反而稳（和扩展里的 src/core/appMint.ts 是同一套算法）。

    static final class RsaPublicKey {
        final BigInteger n;
        final BigInteger e;
        final int size;

        RsaPublicKey(BigInteger n, BigInteger e) {
            this.n = n;
            this.e = e;
            this.size = (n.bitLength() + 7) / 8;
        }
    }

    static RsaPublicKey parseKey(String body) {
        if (body == null || body.isEmpty()) {
            return null;
        }
        try {
            byte[] der;
            if (body.contains("BEGIN")) {
                String b64 = body.replaceAll("-----[^-]+-----", "").replaceAll("\\s+", "");
                der = Base64.decode(b64, Base64.DEFAULT);
            } else {
                der = Base64.decode(body.trim(), Base64.DEFAULT);
            }
            // SubjectPublicKeyInfo: SEQUENCE { SEQUENCE { OID, NULL }, BIT STRING { SEQUENCE { INT n, INT e } } }
            int[] seq = readTlv(der, 0);
            int[] inner = readTlv(der, seq[2]);
            int[] bitStr = readTlv(der, inner[2]);
            // BIT STRING 内容首字节是「未使用位数」，跳过它
            int[] rsa = readTlv(der, bitStr[2] + 1);
            int[] nTlv = readTlv(der, rsa[2]);
            int[] eTlv = readTlv(der, nTlv[2]);
            BigInteger n = new BigInteger(sub(der, nTlv[2], nTlv[2] + nTlv[1]));
            BigInteger e = new BigInteger(sub(der, eTlv[2], eTlv[2] + eTlv[1]));
            return new RsaPublicKey(n, e);
        } catch (Exception ex) {
            return null;
        }
    }

    /** 读一个 DER TLV，返回 {tag, length, contentStart}。 */
    private static int[] readTlv(byte[] b, int off) {
        int tag = b[off] & 0xff;
        int p = off + 1;
        int len = b[p++] & 0xff;
        if ((len & 0x80) != 0) {
            int n = len & 0x7f;
            len = 0;
            for (int i = 0; i < n; i++) {
                len = (len << 8) | (b[p++] & 0xff);
            }
        }
        return new int[]{tag, len, p};
    }

    private static byte[] sub(byte[] b, int from, int to) {
        byte[] out = new byte[to - from];
        System.arraycopy(b, from, out, 0, out.length);
        return out;
    }

    static String rsaEncrypt(RsaPublicKey key, String plain) {
        byte[] msg = plain.getBytes(StandardCharsets.UTF_8);
        int k = key.size;
        if (msg.length > k - 11) {
            msg = sub(msg, 0, k - 11); // 理论上不会发生（密码很短），兜底别抛
        }
        byte[] ps = new byte[k - 3 - msg.length];
        new SecureRandom().nextBytes(ps);
        for (int i = 0; i < ps.length; i++) {
            if (ps[i] == 0) {
                ps[i] = 0x01; // 填充字节必须非零
            }
        }
        // EM = 0x00 || 0x01 || PS(0xFF…) || 0x00 || M ，总长固定 k 字节
        byte[] em = new byte[k];
        em[0] = 0x00;
        em[1] = 0x01;
        System.arraycopy(ps, 0, em, 2, ps.length);
        em[2 + ps.length] = 0x00;
        System.arraycopy(msg, 0, em, 3 + ps.length, msg.length);
        BigInteger m = new BigInteger(1, em);
        byte[] c = m.modPow(key.e, key.n).toByteArray();
        // 左侧补零到固定长度（去掉 BigInteger 的符号位）
        byte[] fixed = new byte[k];
        int copy = Math.min(c.length, k);
        System.arraycopy(c, c.length - copy, fixed, k - copy, copy);
        return "__RSA__" + Base64.encodeToString(fixed, Base64.NO_WRAP);
    }
}
