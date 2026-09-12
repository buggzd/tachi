package com.jellyfinforrayneo.video;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeVideoTests
{
    @Test
    public void decoderJitterDoesNotReduceTwelveHzSamplingToEightHz()
    {
        SampleCadence cadence = new SampleCadence();
        int accepted = 0;
        for (int frame = 0; frame < 240; frame++)
        {
            long now = 1_000_000_000L + frame * 41_666_667L + (frame % 3) * 100_000L;
            if (cadence.due(now))
            {
                cadence.submitted(now);
                accepted++;
            }
        }
        assertEquals(120, accepted);
        long afterPause = 60_000_000_000L;
        assertTrue(cadence.due(afterPause));
        cadence.submitted(afterPause);
        assertFalse(cadence.due(afterPause));
    }

    @Test
    public void timingWindowRemainsBoundedAndReportsRecentPercentiles()
    {
        ReadbackTimings timings = new ReadbackTimings();
        timings.record(999_000_000L, 999_000_000L, 999_000_000L);
        for (int i = 0; i < 512; i++) timings.record(1_000_000L, 2_000_000L, 3_000_000L);
        String json = timings.json();
        assertTrue(json.contains("\"count\":513,\"window\":512"));
        assertTrue(json.contains("\"submitMs\":{\"mean\":1.0000,\"p95\":1.0000}"));
        assertFalse(json.contains("999"));
    }

    @Test
    public void slowConsumerCannotAccumulateFrames()
    {
        FrameSlot slot = new FrameSlot();
        long lease = slot.acquire();
        assertTrue(lease > 0);
        assertEquals(0, slot.acquire());
        slot.release(lease);
        assertTrue(slot.acquire() > lease);
    }

    @Test
    public void seekInvalidatesResultWithoutReusingItsMemoryEarly()
    {
        FrameSlot slot = new FrameSlot();
        long lease = slot.acquire();
        long generation = slot.generation();
        slot.invalidate();
        assertFalse(slot.current(lease, generation));
        assertEquals(generation, slot.generationOf(lease));
        assertEquals(0, slot.acquire());
        slot.release(lease);
        long next = slot.acquire();
        slot.release(lease);
        assertTrue(slot.current(next, slot.generation()));
    }

    @Test
    public void containPreservesVideoAspectWithinEachEye()
    {
        assertArrayEquals(new int[]{0, 0, 1920, 1080}, VideoGeometry.contain(1920, 1080, 16f / 9));
        assertArrayEquals(new int[]{240, 0, 1440, 1080}, VideoGeometry.contain(1920, 1080, 4f / 3));
        int[] portrait = VideoGeometry.contain(1920, 1080, 9f / 16);
        assertEquals(1080, portrait[3]);
        assertTrue(portrait[0] > 0);
    }
}
