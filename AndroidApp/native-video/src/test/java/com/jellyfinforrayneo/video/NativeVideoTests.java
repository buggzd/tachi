package com.jellyfinforrayneo.video;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeVideoTests
{
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
