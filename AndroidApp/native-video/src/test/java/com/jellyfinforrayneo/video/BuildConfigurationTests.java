package com.jellyfinforrayneo.video;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Prevents shipping the larger model with legacy processing defaults. */
public final class BuildConfigurationTests
{
    @Test
    public void productionFullUsesTheCompleteValidatedLiquidProfile()
    {
        if (!BuildConfig.FULL_PRODUCTION)
        {
            return;
        }
        assertEquals(392, BuildConfig.DEPTH_SAMPLE_WIDTH);
        assertEquals(224, BuildConfig.DEPTH_SAMPLE_HEIGHT);
        assertEquals(24, BuildConfig.DEPTH_HZ);
        assertEquals(2, BuildConfig.CAPTURE_SLOTS);
        assertTrue(BuildConfig.GPU_DEPTH_STABILIZATION);
        assertTrue(BuildConfig.GPU_PREPROCESS);
        assertTrue(BuildConfig.PINNED_DEPTH_OUTPUT);
        assertTrue(BuildConfig.ASYNC_CAPTURE_POLL);
        assertTrue(BuildConfig.ALIGNED_LIQUID);
        assertTrue(BuildConfig.CAPTURE_BEFORE_LIQUID);
        assertFalse(BuildConfig.GPU_POLL_OFF_MAIN);
        assertFalse(BuildConfig.LIQUID_FUSED_ROUNDS);
        assertFalse(BuildConfig.LIQUID_CACHE_SAMPLES);
    }
}
