package com.jellyfinforrayneo.video;

/** Select source frames by media time; capture/worker timing still uses monotonic wall time. */
final class PairedSampleCadence
{
    private final int hz;
    private SampleCadence cadence;
    private long generation = Long.MIN_VALUE;
    private long previousPtsUs = FrameTimeline.UNKNOWN;

    PairedSampleCadence(int hz)
    {
        this.hz = hz;
        cadence = new SampleCadence(hz);
    }

    boolean due(long ptsUs, long sourceGeneration)
    {
        if (ptsUs < 0 || ptsUs > Long.MAX_VALUE / 1000) return false;
        if (generation != sourceGeneration || (previousPtsUs != FrameTimeline.UNKNOWN && ptsUs < previousPtsUs))
        {
            cadence = new SampleCadence(hz);
            generation = sourceGeneration;
        }
        previousPtsUs = ptsUs;
        return cadence.due(ptsUs * 1000);
    }

    void submitted(long ptsUs)
    {
        cadence.submitted(ptsUs * 1000);
    }
}
