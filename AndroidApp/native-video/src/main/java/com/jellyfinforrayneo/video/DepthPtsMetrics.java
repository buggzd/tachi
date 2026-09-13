package com.jellyfinforrayneo.video;

import java.util.Arrays;
import java.util.Locale;

/** Signed media PTS differences, not wall-clock age or optical display latency. */
final class DepthPtsMetrics
{
    private final long[] deltasUs = new long[512];
    private int size, cursor;
    private long count, unknown, future;

    synchronized void record(long videoPtsUs, long depthPtsUs)
    {
        if (videoPtsUs == FrameTimeline.UNKNOWN || depthPtsUs == FrameTimeline.UNKNOWN)
        {
            unknown++;
            return;
        }
        long delta = videoPtsUs - depthPtsUs;
        if (delta < 0) future++;
        deltasUs[cursor] = delta;
        cursor = (cursor + 1) % deltasUs.length;
        size = Math.min(size + 1, deltasUs.length);
        count++;
    }

    synchronized String json()
    {
        long[] values = Arrays.copyOf(deltasUs, size);
        Arrays.sort(values);
        double sum = 0;
        for (long value : values) sum += value;
        return String.format(Locale.ROOT,
                "{\"count\":%d,\"unknown\":%d,\"future\":%d,\"meanMs\":%.4f,\"p95Ms\":%.4f,\"maxMs\":%.4f}",
                count, unknown, future, size == 0 ? 0 : sum / size / 1000,
                size == 0 ? 0 : values[(int) Math.ceil(.95 * size) - 1] / 1000.0,
                size == 0 ? 0 : values[size - 1] / 1000.0);
    }
}
