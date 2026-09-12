package com.jellyfinforrayneo.video;

import android.opengl.GLES30;
import java.util.Arrays;
import java.util.Locale;

/** Optional disjoint timer queries; never waits for the GPU. GL-thread operations only. */
final class GpuTimer
{
    private static final int TIME_ELAPSED = 0x88BF;
    private static final int GPU_DISJOINT = 0x8FBB;
    private int query;
    private boolean pending;
    private boolean active;
    private final long[] values = new long[512];
    private int count;
    private int cursor;
    private long total;
    private long disjoint;

    void create()
    {
        query = 0;
        pending = false;
        active = false;
        String extensions = GLES30.glGetString(GLES30.GL_EXTENSIONS);
        if (extensions != null && extensions.contains("GL_EXT_disjoint_timer_query"))
        {
            int[] name = new int[1];
            GLES30.glGenQueries(1, name, 0);
            query = name[0];
        }
    }

    void begin()
    {
        if (query == 0) return;
        if (pending)
        {
            int[] result = new int[1];
            GLES30.glGetQueryObjectuiv(query, GLES30.GL_QUERY_RESULT_AVAILABLE, result, 0);
            if (result[0] == 0) return;
            GLES30.glGetIntegerv(GPU_DISJOINT, result, 0);
            if (result[0] == 0)
            {
                GLES30.glGetQueryObjectuiv(query, GLES30.GL_QUERY_RESULT, result, 0);
                record(result[0] & 0xffffffffL);
            }
            else synchronized (this) { disjoint++; }
            pending = false;
        }
        GLES30.glBeginQuery(TIME_ELAPSED, query);
        active = true;
    }

    void end()
    {
        if (!active) return;
        GLES30.glEndQuery(TIME_ELAPSED);
        active = false;
        pending = true;
    }

    private synchronized void record(long ns)
    {
        values[cursor] = ns;
        cursor = (cursor + 1) % values.length;
        count = Math.min(count + 1, values.length);
        total++;
    }

    synchronized String json()
    {
        long[] sorted = Arrays.copyOf(values, count);
        Arrays.sort(sorted);
        double mean = 0;
        for (long value : sorted) mean += value;
        mean = count == 0 ? 0 : mean / count / 1e6;
        double p95 = count == 0 ? 0 : sorted[(int) Math.ceil(count * .95) - 1] / 1e6;
        return String.format(Locale.ROOT,
                "{\"count\":%d,\"window\":%d,\"disjoint\":%d,\"meanMs\":%.4f,\"p95Ms\":%.4f}",
                total, count, disjoint, mean, p95);
    }

    void close()
    {
        if (query != 0) GLES30.glDeleteQueries(1, new int[]{query}, 0);
        query = 0;
    }
}
