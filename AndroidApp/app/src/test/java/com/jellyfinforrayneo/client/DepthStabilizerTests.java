package com.jellyfinforrayneo.client;

import org.junit.Test;
import static org.junit.Assert.*;

public class DepthStabilizerTests
{
    private float[] ramp()
    {
        float[] values = new float[DepthFrame.PIXELS];
        for (int i = 0; i < values.length; i++) values[i] = (float) i / values.length;
        return values;
    }

    @Test
    public void suppressesSmallDepthNoiseOnUnchangedAppearance()
    {
        DepthStabilizer filter = new DepthStabilizer();
        byte[] rgba = new byte[DepthFrame.PIXELS * 4];
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
        DepthStabilizer filter = new DepthStabilizer();
        byte[] rgba = new byte[DepthFrame.PIXELS * 4];
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
        DepthStabilizer filter = new DepthStabilizer();
        byte[] rgba = new byte[DepthFrame.PIXELS * 4];
        byte[] first = filter.update(ramp(), rgba);
        assertNull(filter.update(new float[DepthFrame.PIXELS], rgba));
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
