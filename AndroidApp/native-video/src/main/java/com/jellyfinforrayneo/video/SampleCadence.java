package com.jellyfinforrayneo.video;

/** Absolute deadlines avoid losing an entire decoder frame to small scheduling jitter. */
final class SampleCadence
{
    private static final long PERIOD_NS = 83_333_333L;
    private long next;

    boolean due(long now)
    {
        return now >= next;
    }

    void submitted(long now)
    {
        next = next == 0 ? now + PERIOD_NS : now + PERIOD_NS - (now - next) % PERIOD_NS;
    }
}
