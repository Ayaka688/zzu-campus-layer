package cn.zzu.campuslayer;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 课前提醒的定时器管理。
 *
 * 纯 AlarmManager + BroadcastReceiver，不引 AndroidX（和这个壳其它部分保持一致：
 * 依赖越少，CI 越不容易炸）。提醒块由网页侧的 buildReminderBlocks 算好，
 * 通过 JS 桥传进来：{at(毫秒), title, body}——一节课一条，互不合并。
 *
 * 每次 apply 都会先把上一批闹钟全部撤掉再重排，避免改了课表以后旧闹钟还在响。
 */
public final class ReminderScheduler {

    private static final String PREFS = "reminders";
    private static final String KEY_JSON = "json";

    private ReminderScheduler() {}

    /** 网页算好一批提醒后调这里：存起来 + 撤旧闹钟 + 逐条设新闹钟。 */
    public static void apply(Context ctx, String json) {
        String prev = prefs(ctx).getString(KEY_JSON, "");
        if (prev != null && !prev.isEmpty()) cancelAll(ctx, prev);
        prefs(ctx).edit().putString(KEY_JSON, json).apply();
        scheduleAll(ctx, json);
    }

    /** 开机/重装之后从存档里恢复（AlarmManager 的闹钟在重启后会丢）。 */
    public static void restore(Context ctx) {
        String json = prefs(ctx).getString(KEY_JSON, "");
        if (json != null && !json.isEmpty()) scheduleAll(ctx, json);
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * 一条提醒的 requestCode：按「分钟」粒度避开同一条提醒重复挂号，再混入序号，
     * 让同一时刻的两节课（撞课）也能各响各的。
     */
    private static int reqOf(long at, int index) {
        return (int) (((at / 60_000L) * 37L + index) % Integer.MAX_VALUE);
    }

    private static PendingIntent pendingFor(Context ctx, long at, int index, JSONObject o) {
        Intent i2 = new Intent(ctx, ReminderReceiver.class);
        if (o != null) {
            i2.putExtra("title", o.optString("title", "快到上课时间了"));
            i2.putExtra("body", o.optString("body", ""));
            i2.putExtra("at", at);
        }
        return PendingIntent.getBroadcast(
                ctx, reqOf(at, index), i2,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** 撤掉一批提醒对应的闹钟（改课表 / 关开关时用）。 */
    private static void cancelAll(Context ctx, String json) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        JSONArray arr;
        try {
            arr = new JSONArray(json);
        } catch (Exception e) {
            return;
        }
        for (int i = 0; i < arr.length(); i += 1) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            long at = o.optLong("at", 0);
            if (at <= 0) continue;
            try {
                am.cancel(pendingFor(ctx, at, i, null));
            } catch (Exception ignored) {
                /* 撤不掉也不影响新闹钟 */
            }
        }
    }

    private static void scheduleAll(Context ctx, String json) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        long now = System.currentTimeMillis();

        JSONArray arr;
        try {
            arr = new JSONArray(json);
        } catch (Exception e) {
            return;
        }

        boolean exact = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            exact = am.canScheduleExactAlarms();
        }

        for (int i = 0; i < arr.length(); i += 1) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            long at = o.optLong("at", 0);
            if (at <= now + 60_000L) continue; // 已经过点了，别补弹

            PendingIntent pi = pendingFor(ctx, at, i, o);
            try {
                if (exact) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                } else {
                    // 没拿到精确闹钟权限就退而求其次：可能晚几分钟，但不会完全不响
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                }
            } catch (SecurityException ignored) {
                try {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                } catch (Exception ignoredToo) {
                    /* 单个闹钟设不上不该拖垮整批 */
                }
            }
        }
    }
}
