package cn.zzu.campuslayer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** 闹钟到点就在这里弹一条通知。 */
public class ReminderReceiver extends BroadcastReceiver {

    static final String CHANNEL_ID = "class-reminder";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");
        if (title == null || title.isEmpty()) title = "快到上课时间了";
        if (body == null) body = "";

        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "上课提醒", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("课前 30 分钟的课程提醒");
            nm.createNotificationChannel(ch);
        }

        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(
                ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(ctx, CHANNEL_ID)
                : new Notification.Builder(ctx);
        b.setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setAutoCancel(true)
                .setContentIntent(tap);

        int id = (int) (intent.getLongExtra("at", System.currentTimeMillis()) % Integer.MAX_VALUE);
        nm.notify(id, b.build());
    }
}
