package com.tachi.stereolab.npubenchmark;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/** Keeps the user-started local model benchmark active while Chrome renders. */
public final class BenchmarkKeepAliveService extends Service
{
    @Override
    public void onCreate()
    {
        super.onCreate();
        String channel = "tachi-npu-benchmark";
        getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(channel, "NPU benchmark", NotificationManager.IMPORTANCE_LOW));
        startForeground(1, new Notification.Builder(this, channel)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("tachi NPU benchmark")
                .setContentText("Processing local depth frames for performance validation")
                .setOngoing(true)
                .build());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId)
    {
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent)
    {
        return null;
    }
}
