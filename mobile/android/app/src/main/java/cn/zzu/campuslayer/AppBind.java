package cn.zzu.campuslayer;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 壳里的「绑定向导」：一次短信验证，把这台手机的 deviceId 登记成可信设备。
 *
 * <p>学校按 deviceId 认设备：新 deviceId 第一次换票一定被要求 MFA，过一次之后
 * {@code /token/mfa/detect} 就回 {@code need:false}，之后纯账密换 30 天票（见 {@link AppMint}）。
 *
 * <p>两条 HTTP 会话（短信走 attest 域）：
 * <pre>
 *   GET  /token/mfa/initByType/securephone?state=  → { gid, securePhone, attestServerUrl }
 *   POST {attest}/api/guard/securephone/send       { gid }
 *   POST {attest}/api/guard/securephone/valid      { gid, code } → status 2 才算过
 * </pre>
 *
 * <p>{@link MainActivity} 把 {@link #start}/{@link #submit} 放到后台线程跑，结果用
 * {@code window.__campusBind(json)} 回给页面；{@code step} 取 {@code code|done|error}。
 */
final class AppBind {

    private static final String BASE = "https://cas.s.zzu.edu.cn";
    private static final String DEFAULT_ATTEST = BASE + "/attest/api/guard";
    private static final int TIMEOUT_MS = 15_000;
    private static final int VALID = 2;

    /** start 之后记住这三样，submit 时要用（一次只绑一台设备，静态够了）。 */
    private static volatile String pendingGid = "";
    private static volatile String pendingAttest = DEFAULT_ATTEST;
    private static volatile String pendingCreds = "";

    private AppBind() {
    }

    /** 第一步：要不要验证？要就发短信。返回 {@code {"step":"code|done|error",...}}。 */
    static String start(String credsJson) {
        try {
            JSONObject creds = new JSONObject(credsJson == null ? "{}" : credsJson);
            String account = AppMint.opt(creds, "account");
            String password = AppMint.opt(creds, "password");
            String deviceId = AppMint.opt(creds, "deviceId");
            if (account.isEmpty() || password.isEmpty() || deviceId.isEmpty()) {
                return error("还缺学号/密码/设备号");
            }

            String pem = AppMint.get(BASE + "/token/jwt/publicKey", "okhttp/3.12.1");
            AppMint.RsaPublicKey key = AppMint.parseKey(pem);
            if (key == null) {
                return error("拿不到公钥");
            }
            String detectUrl = BASE + "/token/mfa/detect?username=" + AppMint.enc(AppMint.rsaEncrypt(key, account))
                    + "&password=" + AppMint.enc(AppMint.rsaEncrypt(key, password))
                    + "&deviceId=" + AppMint.enc(deviceId);
            AppMint.Resp dr = AppMint.postResp(detectUrl);
            JSONObject detect = new JSONObject(dr.body);
            if (detect.optInt("code", -1) != 0) {
                String msg = detect.optString("message", detect.optString("error", ""));
                return error("学校不认这个账号（HTTP " + dr.status + (msg.isEmpty() ? "" : "：" + shorten(msg)) + "）");
            }
            JSONObject ddata = detect.optJSONObject("data");
            if (ddata == null) {
                return error("学校返回看不懂");
            }
            if (!ddata.optBoolean("need", true)) {
                // 这台设备已经登记过了：不用验，直接换票。
                // 另一种可能是密码不对——学校的 detect 对错密码也回 need:false（很阴），
                // 所以这里换票失败时要把两种可能是都摆出来。
                String token = AppMint.mint(credsJson);
                return token != null && !token.isEmpty()
                        ? done(token)
                        : error("学校说这台设备已登记，但换票没成——多半是密码不对，也可能是网络");
            }

            String state = ddata.optString("state", "");
            if (state.isEmpty()) {
                return error("学校没给 MFA state");
            }
            String initUrl = BASE + "/token/mfa/initByType/securephone?state=" + AppMint.enc(state);
            JSONObject init = new JSONObject(AppMint.get(initUrl, "okhttp/3.12.1"));
            JSONObject idata = init.optJSONObject("data");
            String gid = idata == null ? "" : idata.optString("gid", "");
            if (gid.isEmpty()) {
                return error(init.optString("message", "初始化 MFA 失败"));
            }
            String attest = idata.optString("attestServerUrl", "");
            if (attest.isEmpty()) {
                attest = DEFAULT_ATTEST;
            }
            String phone = idata.optString("securePhone", "");

            JSONObject body = new JSONObject();
            body.put("gid", gid);
            AppMint.Resp sr = postJsonResp(attest + "/api/guard/securephone/send", body.toString());
            JSONObject send = new JSONObject(sr.body);
            if (send.optInt("code", -1) != 0) {
                String msg = send.optString("message", "");
                return error("短信没发出去（HTTP " + sr.status + (msg.isEmpty() ? "" : "：" + shorten(msg)) + "）");
            }

            pendingGid = gid;
            pendingAttest = attest;
            pendingCreds = credsJson;
            JSONObject out = new JSONObject();
            out.put("step", "code");
            out.put("phone", phone);
            out.put("state", state);
            out.put("gid", gid);
            return out.toString();
        } catch (Throwable e) {
            return error(e.getClass().getSimpleName() + (e.getMessage() == null ? "" : "：" + e.getMessage()));
        }
    }

    /** 第二步：校验码；过了就顺手换一张 30 天票一起返回。 */
    static String submit(String code) {
        String gid = pendingGid;
        if (gid.isEmpty()) {
            return error("没有进行中的绑定，先点「绑定」");
        }
        String digits = code == null ? "" : code.replaceAll("\\s+", "");
        if (!digits.matches("\\d{4,8}")) {
            return error("验证码是 4~6 位数字");
        }
        try {
            JSONObject body = new JSONObject();
            body.put("gid", gid);
            body.put("code", digits);
            JSONObject valid = new JSONObject(postJson(pendingAttest + "/api/guard/securephone/valid", body.toString()));
            JSONObject vdata = valid.optJSONObject("data");
            int status = vdata == null ? -1 : vdata.optInt("status", -1);
            if (valid.optInt("code", -1) != 0 || status != VALID) {
                String msg = valid.optString("message", "");
                return error(msg.isEmpty() ? "验证码不对或已过期" : msg);
            }

            String token = AppMint.mint(pendingCreds);
            pendingGid = "";
            if (token == null || token.isEmpty()) {
                return error("设备登记成功，但换票没成（网络？）");
            }
            return done(token);
        } catch (Throwable e) {
            return error(e.getClass().getSimpleName() + (e.getMessage() == null ? "" : "：" + e.getMessage()));
        }
    }

    // ---- 结果拼装 ----

    /** 服务端的 message 可能是一大段（500 时是解密堆栈），截一下别把设置页撑爆。 */
    private static String shorten(String s) {
        String t = s == null ? "" : s.replaceAll("\\s+", " ").trim();
        return t.length() > 120 ? t.substring(0, 120) + "…" : t;
    }

    private static String done(String idToken) {
        try {
            JSONObject out = new JSONObject();
            out.put("step", "done");
            out.put("idToken", idToken);
            return out.toString();
        } catch (Exception e) {
            return "{\"step\":\"error\",\"message\":\"结果拼不出来\"}";
        }
    }

    private static String error(String message) {
        try {
            JSONObject out = new JSONObject();
            out.put("step", "error");
            out.put("message", message);
            return out.toString();
        } catch (Exception e) {
            return "{\"step\":\"error\",\"message\":\"结果拼不出来\"}";
        }
    }

    // ---- HTTP（POST + JSON body） ----

    private static String postJson(String url, String body) throws Exception {
        return postJsonResp(url, body).body;
    }

    private static AppMint.Resp postJsonResp(String url, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(TIMEOUT_MS);
        c.setReadTimeout(TIMEOUT_MS);
        c.setInstanceFollowRedirects(false);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("User-Agent", "SWSuperApp/1.1.1()");
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        c.setRequestProperty("Accept", "application/json, text/plain, */*");
        try {
            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(payload.length);
            c.getOutputStream().write(payload);
            int code = c.getResponseCode();
            return new AppMint.Resp(code, AppMint.read(c, code));
        } finally {
            c.disconnect();
        }
    }
}
