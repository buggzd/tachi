package com.jellyfinforrayneo.video;

import org.junit.Test;
import static org.junit.Assert.*;

public class PairedSampleCadenceTests
{
    @Test public void acceptsEvery23976SourceFrameRegardlessOfArrivalJitter()
    {
        PairedSampleCadence cadence = new PairedSampleCadence(24);
        for (int i = 0; i < 240; i++)
        {
            long pts = Math.round(i * 1_001_000.0 / 24);
            assertTrue(cadence.due(pts, 1));
            cadence.submitted(pts);
            assertFalse(cadence.due(pts, 1));
        }
    }

    @Test public void boundsThirtyFpsSelectionWithoutConsumingBlockedOpportunities()
    {
        PairedSampleCadence cadence = new PairedSampleCadence(24);
        int selected = 0;
        for (int i = 0; i < 300; i++)
        {
            long pts = Math.round(i * 1_000_000.0 / 30);
            if (cadence.due(pts, 1))
            {
                assertTrue(cadence.due(pts, 1));
                cadence.submitted(pts);
                selected++;
            }
        }
        assertEquals(240, selected);
    }

    @Test public void resetsOnSeekOrNewSourceAndRejectsUnknownPts()
    {
        PairedSampleCadence cadence = new PairedSampleCadence(24);
        assertFalse(cadence.due(FrameTimeline.UNKNOWN, 1));
        assertTrue(cadence.due(90000000, 1));
        cadence.submitted(90000000);
        assertTrue(cadence.due(0, 1));
        cadence.submitted(0);
        assertTrue(cadence.due(0, 2));
    }
}
