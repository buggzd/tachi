package com.jellyfinforrayneo.client;

import android.content.Context;
import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import org.json.JSONObject;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

final class RealtimeSbsController
{
    interface Host
    {
        void clearDepth();
        void applyDepth(Bitmap map, DepthFrame frame, long validUntil);
        void publish(JSONObject state);
    }

    private final Context context;
    private final Host host;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(1));
    private final AtomicBoolean pending = new AtomicBoolean();
    private volatile String token;
    private volatile boolean closed;
    private DepthBackend backend;
    private int lastSequence;

    RealtimeSbsController(Context context, Host host)
    {
        this.context = context.getApplicationContext();
        this.host = host;
    }

    void start(String next)
    {
        if (closed || !DepthFrame.validToken(next))
        {
            return;
        }
        token = next;
        lastSequence = 0;
        host.clearDepth();
        publish(next, "loading", 0, 0, null);
        try
        {
            worker.execute(() ->
            {
                try
                {
                    if (backend == null)
                    {
                        backend = RealtimeDepthBackend.open(context);
                    }
                    ui.post(() -> publish(next, "ready", 0, 0, null));
                }
                catch (Exception | LinkageError failure)
                {
                    ui.post(() -> fail(next));
                }
            });
        }
        catch (RuntimeException failure)
        {
            fail(next);
        }
    }

    void stop(String expected)
    {
        if (expected != null && !expected.equals(token))
        {
            return;
        }
        token = null;
        host.clearDepth();
    }

    // Called by the WebView bridge thread: take the slot BEFORE parsing or posting to UI.
    boolean offer(String payload)
    {
        if (closed || token == null || payload == null || payload.length() > DepthFrame.MAX_JSON
                || !pending.compareAndSet(false, true)) return false;
        DepthFrame frame = DepthFrame.parse(payload);
        if (frame == null || !frame.token.equals(token))
        {
            pending.set(false);
            return false;
        }
        ui.post(() ->
        {
            if (!frame.token.equals(token) || closed || frame.sequence <= lastSequence)
            {
                pending.set(false);
                return;
            }
            lastSequence = frame.sequence;
            try
            {
                worker.execute(() -> infer(frame));
            }
            catch (RuntimeException rejected)
            {
                pending.set(false);
                fail(frame.token);
            }
        });
        return true;
    }

    private void infer(DepthFrame frame)
    {
        long started = SystemClock.elapsedRealtime();
        byte[] depth = null;
        boolean failed = false;
        boolean flat = false;
        try
        {
            if (!closed && frame.token.equals(token)
                    && Math.abs(System.currentTimeMillis() - frame.capturedAt) <= 150)
            {
                byte[] rgba = Base64.decode(frame.rgba, Base64.NO_WRAP);
                depth = DepthFrame.normalize(backend.infer(DepthFrame.preprocess(rgba)));
                flat = depth == null;
            }
        }
        catch (Exception | LinkageError failure)
        {
            failed = true;
        }
        byte[] result = depth;
        boolean error = failed;
        boolean noContrast = flat;
        long elapsed = SystemClock.elapsedRealtime() - started;
        ui.post(() ->
        {
            pending.set(false);
            if (closed || !frame.token.equals(token))
            {
                return;
            }
            if (error)
            {
                fail(frame.token);
                return;
            }
            long age = System.currentTimeMillis() - frame.capturedAt;
            if (result != null && age >= 0 && age <= 150)
            {
                int[] pixels = new int[DepthFrame.PIXELS];
                for (int i = 0; i < pixels.length; i++)
                {
                    int value = result[i] & 255;
                    pixels[i] = 0xff000000 | (value << 16) | (value << 8) | value;
                }
                Bitmap map = Bitmap.createBitmap(pixels, DepthFrame.WIDTH, DepthFrame.HEIGHT, Bitmap.Config.ARGB_8888);
                try
                {
                    host.applyDepth(map, frame, SystemClock.elapsedRealtime() + 150 - age);
                }
                catch (RuntimeException failure)
                {
                    fail(frame.token);
                    return;
                }
                publish(frame.token, "frame", frame.sequence, elapsed, frame.debug ? result : null);
            }
            else
            {
                host.clearDepth();
                publish(frame.token, noContrast ? "flat" : "stale", frame.sequence, elapsed, null);
            }
        });
    }

    void rendererFailed(String expected)
    {
        if (expected != null)
        {
            fail(expected);
        }
    }

    private void fail(String expected)
    {
        if (!expected.equals(token) || closed)
        {
            return;
        }
        host.clearDepth();
        publish(expected, "error", 0, 0, null);
        token = null;
    }

    private void publish(String expected, String status, int sequence, long elapsed, byte[] depth)
    {
        if (!expected.equals(token) || closed)
        {
            return;
        }
        try
        {
            JSONObject state = new JSONObject();
            state.put("token", expected);
            state.put("status", status);
            state.put("sequence", sequence);
            state.put("nativeMs", elapsed);
            if (depth != null)
            {
                state.put("depth", Base64.encodeToString(depth, Base64.NO_WRAP));
            }
            host.publish(state);
        }
        catch (Exception ignored)
        {
            host.clearDepth();
        }
    }

    void close()
    {
        if (closed)
        {
            return;
        }
        closed = true;
        token = null;
        host.clearDepth();
        // At most one inference and one queued initialization; close only on the same worker.
        worker.getQueue().clear();
        worker.execute(() ->
        {
            try
            {
                if (backend != null)
                {
                    backend.close();
                }
            }
            catch (Exception ignored)
            {
                /* Never expose backend error text. */
            }
            backend = null;
        });
        worker.shutdown();
    }
}
