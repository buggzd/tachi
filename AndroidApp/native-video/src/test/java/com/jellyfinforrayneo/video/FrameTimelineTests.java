package com.jellyfinforrayneo.video;

import org.junit.Test;
import static org.junit.Assert.*;

public class FrameTimelineTests
{
    @Test
    public void releaseTimestampMatchesPtsWithoutAssumingTheClocksAreTheSame()
    {
        FrameTimeline t = new FrameTimeline();
        t.decoded(30_000_000_123L, 7_000_000, 1);
        assertEquals(7_000_000, t.match(30_000_000_000L, 1).ptsUs);
        assertNull(t.match(30_001_000_000L, 1));
        assertNull(t.match(30_000_000_123L, 2));
    }

    @Test
    public void directPtsSurfacesAreRecognizedAndOldMappingsRemainBounded()
    {
        FrameTimeline t = new FrameTimeline();
        for (int i = 0; i < 200; i++) t.decoded(10_000_000_000L + i * 40_000_000L, i * 40_000L, 1);
        assertNull(t.match(0, 1));
        assertEquals(199 * 40_000L, t.match(199 * 40_000_000L, 1).ptsUs);
    }

    @Test
    public void ambiguousReleaseTimesAreNotGuessed()
    {
        FrameTimeline t = new FrameTimeline();
        t.decoded(10_000, 10, 1);
        t.decoded(10_001, 20, 1);
        assertNull(t.match(10_000, 1));
    }

    @Test
    public void signedLagAndUnknownFramesRemainVisible()
    {
        DepthPtsMetrics m = new DepthPtsMetrics();
        m.record(1_000, 2_000);
        m.record(FrameTimeline.UNKNOWN, 1_000);
        assertTrue(m.json().contains("\"meanMs\":-1.0000"));
        assertTrue(m.json().contains("\"unknown\":1"));
        assertTrue(m.json().contains("\"future\":1"));
    }

    @Test
    public void lagWindowEvictsOldValuesWithoutResettingCoverageCounts()
    {
        DepthPtsMetrics m = new DepthPtsMetrics();
        m.record(9_000_000, 0);
        for (int i = 0; i < 512; i++) m.record(125_000, 0);
        String snapshot = m.json();
        assertTrue(snapshot.contains("\"count\":513"));
        assertTrue(snapshot.contains("\"meanMs\":125.0000"));
        assertTrue(snapshot.contains("\"maxMs\":125.0000"));
    }

}
