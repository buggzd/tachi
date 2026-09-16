package com.jellyfinforrayneo.client;

import android.app.ActivityManager;
import android.app.Application;
import android.app.ApplicationExitInfo;
import android.content.SharedPreferences;
import android.os.Build;
import java.util.concurrent.atomic.AtomicBoolean;

/** Local, opt-in sharing only. No network crash reporting or raw tombstone export. */
public final class TachiApplication extends Application
{
    private volatile String crashHistory = "crashHistoryState=loading\n";
    private final AtomicBoolean recording = new AtomicBoolean();

    @Override
    public void onCreate()
    {
        super.onCreate();
        SharedPreferences storage = getSharedPreferences("crash_history_v1", MODE_PRIVATE);
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, failure) ->
        {
            try
            {
                if (recording.compareAndSet(false, true))
                {
                    storage.edit().putString("last_java", CrashSummary.javaCrash(
                            failure, System.currentTimeMillis(), BuildConfig.VERSION_CODE)).commit();
                }
            }
            catch (Throwable ignored) { /* Never replace the original fatal exception. */ }
            finally
            {
                if (previous != null) previous.uncaughtException(thread, failure);
                else
                {
                    android.os.Process.killProcess(android.os.Process.myPid());
                    System.exit(10);
                }
            }
        });
        // One finite startup task; no polling, Activity retention or UI-thread disk reads.
        new Thread(() -> loadHistory(storage), "tachi-crash-history").start();
    }

    private void loadHistory(SharedPreferences storage)
    {
        StringBuilder report = new StringBuilder("crashSchema=1\n");
        try
        {
            String javaCrash = storage.getString("last_java", "");
            if (javaCrash != null && javaCrash.length() <= 32768) report.append(javaCrash);
            if (Build.VERSION.SDK_INT >= 30)
            {
                ActivityManager manager = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
                int count = 0;
                if (manager != null)
                {
                    for (ApplicationExitInfo exit : manager.getHistoricalProcessExitReasons(
                            getPackageName(), 0, 8))
                    {
                        if (!getPackageName().equals(exit.getProcessName())) continue;
                        report.append("processExit timeMs=").append(exit.getTimestamp())
                                .append(" reason=").append(exit.getReason())
                                .append(" status=").append(exit.getStatus())
                                .append(" importance=").append(exit.getImportance())
                                .append(" pssKb=").append(exit.getPss())
                                .append(" rssKb=").append(exit.getRss()).append('\n');
                        if (Build.VERSION.SDK_INT >= 31 && exit.getReason() == ApplicationExitInfo.REASON_CRASH_NATIVE)
                        {
                            try (java.io.InputStream trace = exit.getTraceInputStream())
                            {
                                report.append(CrashSummary.nativeTrace(trace));
                            }
                            catch (java.io.IOException | RuntimeException ignored)
                            {
                                report.append("nativeTrace=unavailable\n");
                            }
                        }
                        count++;
                    }
                }
                report.append("systemExitRecords=").append(count).append('\n');
                report.append("exitReasonLegend=4:java_crash,5:native_crash,6:anr,3:low_memory,10:user_requested\n");
            }
            else report.append("systemExitHistory=unavailable_before_android_11\n");
            report.append("crashHistoryState=ready\n");
        }
        catch (RuntimeException ignored)
        {
            report.append("crashHistoryState=unavailable\n");
        }
        report.append("crashPrivacy=exception messages, thread names, raw traces and process descriptions omitted; system history may be evicted; exit version unknown\n");
        crashHistory = report.toString();
    }

    String exportCrashHistory()
    {
        return crashHistory;
    }
}
