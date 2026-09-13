package com.jellyfinforrayneo.video;

import java.nio.ByteBuffer;

/** All methods run serially on the sample worker, including prepare and close. */
public interface NativeDepthProcessor extends AutoCloseable
{
    void prepare() throws Exception;
    // generation changes require clearing temporal history. Input may not be retained.
    DepthResult process(ByteBuffer rgba, long generation) throws Exception;
    default DepthResult processChw(ByteBuffer chw, long generation) throws Exception
    {
        throw new UnsupportedOperationException("GPU input unavailable");
    }
    @Override
    void close() throws Exception;
}
