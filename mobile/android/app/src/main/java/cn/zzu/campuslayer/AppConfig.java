package cn.zzu.campuslayer;

/**
 * 一处改完就够：换域名 / 换部署地址只动这里。
 */
final class AppConfig {
    /** 主界面加载的 PWA（可以在自己仓库的 Pages 上换成任意地址）。 */
    static final String APP_URL = "https://rebeca-aa.github.io/zzu-campus-layer/pwa/index.html";

    /**
     * 取登录态用的入口。
     *
     * 必须是「统一身份认证 + service」这一条：
     *   https://cas.s.zzu.edu.cn/cas/login?service=<教务 uni-app 首页>
     * 因为 jwxt.zzu.edu.cn/uniapp/index.html 自己的 pwdLogin 页用的是树维账号体系，
     * 学号 + 统一身份认证密码在那边会报「用户名或密码异常」（真机踩过）。
     */
    static final String LOGIN_URL =
            "https://cas.s.zzu.edu.cn/cas/login?service="
            + "https%3A%2F%2Fjwxt.zzu.edu.cn%2Funiapp%2Findex.html";

    /** 备用入口：学校自带的树维登录页（万一 CAS 那边改了路由，还能从这里手动兜） */
    static final String LOGIN_URL_FALLBACK = "https://jwxt.zzu.edu.cn/uniapp/index.html";

    /** 取到 token 后注入给网页的函数名（PWA 里注册的 window.__campusImport）。 */
    static final String IMPORT_FN = "__campusImport";

    private AppConfig() {}
}
