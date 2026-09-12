package com.jellyfinforrayneo.video;

/** Ownership of the fixed top-row-first R8 map transfers to the renderer; never mutate it. */
public final class DepthResult
{
    public final byte[] map;
    public final long preprocessNs;
    public final long inferenceNs;
    public final long stabilizeNs;

    public DepthResult(byte[] map, long preprocessNs, long inferenceNs, long stabilizeNs)
    {
        if (map != null && map.length != NativeVideoView.SAMPLE_WIDTH * NativeVideoView.SAMPLE_HEIGHT)
            throw new IllegalArgumentException("depth shape");
        this.map = map;
        this.preprocessNs = preprocessNs;
        this.inferenceNs = inferenceNs;
        this.stabilizeNs = stabilizeNs;
    }
}
