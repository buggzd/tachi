package com.jellyfinforrayneo.client;

interface DepthBackend extends AutoCloseable
{
    float[] infer(float[] input) throws Exception;
    @Override void close() throws Exception;
}
