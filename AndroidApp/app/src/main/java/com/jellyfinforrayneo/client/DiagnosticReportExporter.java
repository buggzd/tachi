package com.jellyfinforrayneo.client;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.core.content.FileProvider;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Comparator;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Saves a bounded report in a dedicated private cache; sharing grants read access to one file. */
final class DiagnosticReportExporter implements AutoCloseable
{
    interface Callback { void ready(Uri uri); void failed(); }
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0,
            TimeUnit.SECONDS, new ArrayBlockingQueue<>(1));
    private boolean busy;
    private volatile boolean closed;

    DiagnosticReportExporter(Context context)
    {
        this.context = context.getApplicationContext();
    }

    void export(String report, Callback callback)
    {
        if (busy || closed) return;
        busy = true;
        worker.execute(() ->
        {
            Uri uri = null;
            try
            {
                File file = save(new File(context.getCacheDir(), "diagnostics"), report);
                uri = FileProvider.getUriForFile(context, context.getPackageName() + ".diagnostics", file);
            }
            catch (Exception ignored) { /* Never log report text or private paths. */ }
            Uri result = uri;
            main.post(() ->
            {
                busy = false;
                if (closed) return;
                if (result == null) callback.failed(); else callback.ready(result);
            });
        });
    }

    static File save(File directory, String report) throws Exception
    {
        byte[] bytes = report.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 512 * 1024) throw new IllegalArgumentException("report limit");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new java.io.IOException("cache");
        // Unique names keep a previous share stable; retain three completed reports at most.
        File file = File.createTempFile("tachi-diagnostics-", ".txt", directory);
        try
        {
            Files.write(file.toPath(), bytes);
        }
        catch (Exception error)
        {
            file.delete();
            throw error;
        }
        File[] older = directory.listFiles(value -> value.isFile() && value.getName().startsWith("tachi-diagnostics-")
                && value.getName().endsWith(".txt") && !value.equals(file));
        if (older != null)
        {
            Arrays.sort(older, Comparator.comparingLong(File::lastModified).reversed());
            for (int index = 2; index < older.length; index++) older[index].delete();
        }
        return file;
    }

    @Override
    public void close()
    {
        closed = true;
        worker.shutdown();
    }
}
