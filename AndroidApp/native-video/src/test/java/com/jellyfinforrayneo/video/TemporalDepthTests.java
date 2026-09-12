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

    private float[] anchoredPlane()
    {
        float[] values = new float[NativeVideoView.SAMPLE_WIDTH * NativeVideoView.SAMPLE_HEIGHT];
        java.util.Arrays.fill(values, .3f);
        java.util.Arrays.fill(values, 0, values.length / 10, 0f);
        java.util.Arrays.fill(values, values.length * 9 / 10, values.length, 1f);
        return values;
    }

    private int response(float delta, int appearanceChange)
    {
        TemporalDepth filter = new TemporalDepth();
        float[] raw = anchoredPlane();
        byte[] rgba = new byte[raw.length * 4];
        filter.update(raw, rgba);
        int i = raw.length / 2;
        raw[i] += delta;
        rgba[i * 4] = (byte) appearanceChange;
        return filter.update(raw, rgba)[i] & 255;
    }

    @Test
    public void neighboringAppearanceChangesDoNotCauseDisparityJump()
    {
        assertTrue(Math.abs(response(.04f, 18) - response(.04f, 19)) <= 1);
    }

    @Test
    public void largeDepthChangeRejectsHistoryEvenWithoutAppearanceChange()
    {
        assertEquals(Math.round(.43f * 255), response(.13f, 0));
    }

    @Test
    public void genuineSmallDepthStepStillReachesNinetyPercentWithinSixUpdates()
    {
        TemporalDepth filter = new TemporalDepth();
        float[] raw = anchoredPlane();
        byte[] rgba = new byte[raw.length * 4];
        filter.update(raw, rgba);
        int i = raw.length / 2;
        raw[i] += .1f;
        byte[] result = null;
        for (int frame = 0; frame < 6; frame++) result = filter.update(raw, rgba);
        assertTrue((result[i] & 255) >= Math.round(.39f * 255));
    }

    @Test
    public void laterUpdatesDoNotModifyDepthAlreadyOfferedToRenderer()
    {
        TemporalDepth filter = new TemporalDepth();
        float[] raw = anchoredPlane();
        byte[] rgba = new byte[raw.length * 4];
        byte[] first = filter.update(raw, rgba);
        byte[] saved = first.clone();
        raw[raw.length / 2] += .1f;
        assertNotSame(first, filter.update(raw, rgba));
        assertArrayEquals(saved, first);
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
