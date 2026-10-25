package cn.zzu.campuslayer;

/**
 * 一处改完就够：换域名 / 换部署地址只动这里。
 */
final class AppConfig {
    /** 主界面加载的 PWA（换成自己的 Pages 地址也行）。 */
    static final String APP_URL = "https://rebeca-aa.github.io/zzu-campus-layer/pwa/index.html";

    /**
     * 登录入口。
     *
     * 指向「CAS + 一个静态样式文件」：CAS 的白名单只按域名匹配（uniapp.s.zzu.edu.cn
     * 下任何路径都放行），而静态文件不会启动门户那套单页应用；SPA 一启动就会解出
     * idToken、写 cookie，然后跳到去掉 query 的地址，把 ?ticket= 抹掉。
     *
     * 落在这个静态文件上，登录成功后地址就是 ...css?ticket=<JWT>，壳能直接读出来。
     * 文件名里带构建 hash，学校重建后可能 404 —— 无所谓，我们要的是地址里的 ticket。
     */
    static final String LIB_LOGIN_URL = "http://order.lib.zzu.edu.cn/h5/index.html#/seat/index";

    static final String LOGIN_URL =
            "https://cas.s.zzu.edu.cn/cas/login?service="
            + "https%3A%2F%2Funiapp.s.zzu.edu.cn%2Fpages%2Ftab%2Findex%2Findex";

    /** 备用入口：学校自带的树维登录页（万一 CAS 那边改了路由，还能从这里手动兜） */
    static final String LOGIN_URL_FALLBACK = "https://jwxt.zzu.edu.cn/uniapp/index.html";

    /**
     * 伪装成手机 Chrome 的 UA。
     * 为什么必须改：WebView 默认 UA 末尾带 "; wv)"，学校那套 uni-app 会据此认为
     * 自己跑在不支持的容器里，从而不走 CAS 换票、直接回落到树维 pwdLogin（学号密码不认）。
     */
    static final String USER_AGENT =
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
            + "Chrome/128.0.0.0 Mobile Safari/537.36";

    /** 取到 token 后注入给网页的函数名（PWA 里注册的 window.__campusImport）。 */
    static final String IMPORT_FN = "__campusImport";

    private AppConfig() {}
}
