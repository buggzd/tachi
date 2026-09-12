package com.jellyfinforrayneo.video;

import org.junit.Test;
import static org.junit.Assert.*;

public class TemporalDepthTests
{
    private float[] ramp()
    {
        float[] values = new float[(NativeVideoView.SAMPLE_WIDTH * NativeVideoView.SAMPLE_HEIGHT)];
        for (int i = 0; i < values.length; i++) values[i] = (float) i / values.length;
        return values;
    }

    @Test
    public void suppressesSmallDepthNoiseOnUnchangedAppearance()
    {
        TemporalDepth filter = new TemporalDepth();
        byte[] rgba = new byte[(NativeVideoView.SAMPLE_WIDTH * NativeVideoView.SAMPLE_HEIGHT) * 4];
        float[] raw = ramp();
        int i = raw.length / 2;
        int before = filter.update(raw, rgba)[i] & 255;
        raw[i] += .06f;
        int after = filter.update(raw, rgba)[i] & 255;
        assertTrue(after > before);
        assertTrue(after - before < 8);
    }

    @Test
    public void movingPixelDoesNotBlendPreviousDepth()
    {
        TemporalDepth filter = new TemporalDepth();
        byte[] rgba = new byte[(NativeVideoView.SAMPLE_WIDTH * NativeVideoView.SAMPLE_HEIGHT) * 4];
        float[] raw = ramp();
        int i = raw.length / 2;
        int before = filter.update(raw, rgba)[i] & 255;
        raw[i] += .06f;
        rgba[i * 4] = (byte) 255;
        assertTrue((filter.update(raw, rgba)[i] & 255) - before > 12);
    }

    @Test
    public void appearanceCutResetsScaleAndFlatFrameDoesNotEraseHistory()
    {
        TemporalDepth filter = new TemporalDepth();
        byte[] rgba = new byte[(NativeVideoView.SAMPLE_WIDTH * NativeVideoView.SAMPLE_HEIGHT) * 4];
        byte[] first = filter.update(ramp(), rgba);
        assertNull(filter.update(new float[(NativeVideoView.SAMPLE_WIDTH * NativeVideoView.SAMPLE_HEIGHT)], rgba));
        assertArrayEquals(first, filter.update(ramp(), rgba));
        float[] shifted = ramp();
        for (int i = 0; i < shifted.length; i++) shifted[i] = shifted[i] * 2 + 5;
        java.util.Arrays.fill(rgba, (byte) 255);
        byte[] reset = filter.update(shifted, rgba);
        for (int i = 0; i < first.length; i++)
        {
            assertTrue(Math.abs((first[i] & 255) - (reset[i] & 255)) <= 1);
        }
    }
}
