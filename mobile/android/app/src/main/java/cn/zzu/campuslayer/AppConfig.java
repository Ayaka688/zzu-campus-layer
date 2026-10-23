package cn.zzu.campuslayer;

/**
 * 一处改完就够：换域名 / 换部署地址只动这里。
 */
final class AppConfig {
    /** 主界面加载的 PWA（可以在自己仓库的 Pages 上换成任意地址）。 */
    static final String APP_URL = "https://rebeca-aa.github.io/zzu-campus-layer/pwa/index.html";

    /** 取登录态用的学校页面：登录成功那一刻地址栏里带 idToken。 */
    static final String LOGIN_URL = "https://jwxt.zzu.edu.cn/uniapp/index.html";

    /** 取到 token 后注入给网页的函数名（PWA 里注册的 window.__campusImport）。 */
    static final String IMPORT_FN = "__campusImport";

    private AppConfig() {}
}
