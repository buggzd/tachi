package com.jellyfinforrayneo.video;

import java.util.Arrays;
import java.util.Locale;

/** Bounded wall-clock measurements. Fence observation includes the render polling delay. */
final class ReadbackTimings
{
    private final long[][] values = new long[3][512];
    private int size;
    private int cursor;
    private long count;
    private final String[] names;

    ReadbackTimings()
    {
        this("submit", "fenceObserved", "mapCopy");
    }

    ReadbackTimings(String first, String second, String third)
    {
        names = new String[]{first, second, third};
    }

    synchronized void record(long submit, long observed, long copy)
    {
        values[0][cursor] = submit;
        values[1][cursor] = observed;
        values[2][cursor] = copy;
        cursor = (cursor + 1) % values[0].length;
        size = Math.min(size + 1, values[0].length);
        count++;
    }

    synchronized String json()
    {
        StringBuilder json = new StringBuilder("{\"count\":").append(count)
                .append(",\"window\":").append(size);
        for (int stage = 0; stage < names.length; stage++)
        {
            long[] sorted = Arrays.copyOf(values[stage], size);
            Arrays.sort(sorted);
            double mean = 0;
            for (long value : sorted) mean += value;
            mean = size == 0 ? 0 : mean / size / 1e6;
            double p95 = size == 0 ? 0 : sorted[(int) Math.ceil(size * .95) - 1] / 1e6;
            json.append(String.format(Locale.ROOT, ",\"%sMs\":{\"mean\":%.4f,\"p95\":%.4f}",
                    names[stage], mean, p95));
        }
        return json.append('}').toString();
    }
}
