package cn.zzu.campuslayer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 重启后把存档里的提醒重新设上（AlarmManager 的闹钟重启即失效）。 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            ReminderScheduler.restore(ctx);
        }
    }
}
