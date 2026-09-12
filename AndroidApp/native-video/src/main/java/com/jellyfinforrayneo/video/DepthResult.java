package com.jellyfinforrayneo.video;

/** Ownership of the top-row-first R8 map or raw float depth transfers to the renderer; never mutate it. */
public final class DepthResult
{
    public final byte[] map;
    public final float[] raw;
    public final long preprocessNs;
    public final long inferenceNs;
    public final long stabilizeNs;

    public DepthResult(byte[] map, long preprocessNs, long inferenceNs, long stabilizeNs)
    {
        this(map, null, preprocessNs, inferenceNs, stabilizeNs);
    }

    /** Owns the raw array until the renderer has submitted its GPU upload. */
    public static DepthResult raw(float[] raw, long preprocessNs, long inferenceNs, long transferNs)
    {
        if (raw == null) throw new IllegalArgumentException("raw depth");
        return new DepthResult(null, raw, preprocessNs, inferenceNs, transferNs);
    }

    private DepthResult(byte[] map, float[] raw, long preprocessNs, long inferenceNs, long stabilizeNs)
    {
        if (map != null && map.length != NativeVideoView.SAMPLE_WIDTH * NativeVideoView.SAMPLE_HEIGHT)
            throw new IllegalArgumentException("depth shape");
        this.map = map;
        if (raw != null && raw.length != NativeVideoView.SAMPLE_WIDTH * NativeVideoView.SAMPLE_HEIGHT)
            throw new IllegalArgumentException("raw depth shape");
        this.raw = raw;
        this.preprocessNs = preprocessNs;
        this.inferenceNs = inferenceNs;
        this.stabilizeNs = stabilizeNs;
    }
}
