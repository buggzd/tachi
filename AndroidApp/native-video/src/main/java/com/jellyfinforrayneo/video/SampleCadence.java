package com.jellyfinforrayneo.video;

/** Absolute deadlines avoid losing an entire decoder frame to small scheduling jitter. */
final class SampleCadence
{
    private final long periodNs;

    SampleCadence()
    {
        this(12);
    }

    SampleCadence(int hz)
    {
        if (hz != 12 && hz != 24) throw new IllegalArgumentException("depth cadence");
        periodNs = 1_000_000_000L / hz;
    }
    private long next;

    boolean due(long now)
    {
        return now >= next;
    }

    void submitted(long now)
    {
        next = next == 0 ? now + periodNs : now + periodNs - (now - next) % periodNs;
    }
}
