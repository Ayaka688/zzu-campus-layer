package cn.zzu.campuslayer;

import android.content.Context;

import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * 兜底记一笔「上次为什么退出的」。
 *
 * <p>壳是长期不关的 WebView，用户手里没有 logcat，一出事就只剩一句「闪退了」。
 * 这里挂一个 UncaughtExceptionHandler：把栈写进 SharedPreferences 再交回系统原来的
 * handler（**不吞异常**，该退还是退），页面下次打开可以把它显示出来给人复制。
 */
final class CrashLog {

    private static final String PREFS = "campus_layer";
    private static final String KEY = "last_crash";
    private static final int MAX = 2000;

    private CrashLog() {
    }

    static void install(Context ctx) {
        final Context app = ctx.getApplicationContext();
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            try {
                save(app, e);
            } catch (Throwable ignored) {
                // 记日志本身再出错就算了，别把原来的崩溃信息弄丢
            }
            if (prev != null) {
                prev.uncaughtException(t, e);
            }
        });
    }

    private static void save(Context ctx, Throwable e) {
        StringWriter sw = new StringWriter();
        e.printStackTrace(new PrintWriter(sw));
        String text = e.getClass().getSimpleName()
                + (e.getMessage() == null ? "" : ": " + e.getMessage())
                + "\n" + sw;
        if (text.length() > MAX) {
            text = text.substring(0, MAX) + "…";
        }
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, text).apply();
    }

    /** 上次的崩溃文本（没有就空串）。 */
    static String last(Context ctx) {
        String text = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "");
        return text == null ? "" : text;
    }

    static void clear(Context ctx) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply();
    }
}
