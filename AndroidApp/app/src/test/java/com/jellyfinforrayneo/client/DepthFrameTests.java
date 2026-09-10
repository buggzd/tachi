package com.jellyfinforrayneo.client;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class DepthFrameTests
{
    private JSONObject frame() throws Exception
    {
        return new JSONObject().put("token", "visit-1").put("sequence", 1)
                .put("capturedAt", 1700000000000L).put("rgba", "A".repeat(218476))
                .put("rect", new JSONArray(new double[]{0, .1, 1, .9}))
                .put("masks", new JSONArray()).put("debug", false);
    }

    @Test
    public void acceptsFixedFrameAndRejectsCoercionAndExtraFields() throws Exception
    {
        assertNotNull(DepthFrame.parse(frame().toString()));
        assertNull(DepthFrame.parse(frame().put("sequence", "1").toString()));
        assertNull(DepthFrame.parse(frame().put("sequence", 1.2).toString()));
        assertNull(DepthFrame.parse(frame().put("capturedAt", "1700000000000").toString()));
        assertNull(DepthFrame.parse(frame().put("debug", "true").toString()));
        assertNull(DepthFrame.parse(frame().put("url", "not-allowed").toString()));
    }

    @Test
    public void rejectsOversizedFramesAndInvalidRegions() throws Exception
    {
        assertNull(DepthFrame.parse(" ".repeat(DepthFrame.MAX_JSON + 1)));
        assertNull(DepthFrame.parse(frame().put("rgba", "A").toString()));
        assertNull(DepthFrame.parse(frame().put("rect", new JSONArray(new double[]{.5, 0, .4, 1})).toString()));
        assertNull(DepthFrame.parse(frame().put("rect", new JSONArray(new double[]{0, 0, 2, 1})).toString()));
        JSONArray masks = new JSONArray();
        for (int i = 0; i < 9; i++)
        {
            masks.put(new JSONArray(new double[]{0, 0, 1, 1}));
        }
        assertNull(DepthFrame.parse(frame().put("masks", masks).toString()));
        assertNull(DepthFrame.parse(frame().put("token", "x');alert(1)//").toString()));
    }

    @Test
    public void convertsRgbaToImageNetNchwWithoutAlpha()
    {
        byte[] rgba = new byte[DepthFrame.PIXELS * 4];
        rgba[0] = (byte) 255;
        rgba[1] = (byte) 128;
        rgba[3] = (byte) 255;
        float[] result = DepthFrame.preprocess(rgba);
        assertEquals((1f - .485f) / .229f, result[0], .00001f);
        assertEquals((128f / 255f - .456f) / .224f, result[DepthFrame.PIXELS], .00001f);
        assertEquals(-.406f / .225f, result[DepthFrame.PIXELS * 2], .00001f);
        assertEquals(-.485f / .229f, result[1], .00001f);
    }

    @Test
    public void normalizesDepthMonotonicallyAndClipsOutliers()
    {
        float[] values = new float[DepthFrame.PIXELS];
        for (int i = 0; i < values.length; i++)
        {
            values[i] = i;
        }
        byte[] result = DepthFrame.normalize(values);
        assertEquals(0, result[0] & 255);
        assertEquals(255, result[result.length - 1] & 255);
        for (int i = 1; i < result.length; i++)
        {
            assertTrue((result[i] & 255) >= (result[i - 1] & 255));
        }
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsNonfiniteDepth()
    {
        float[] values = new float[DepthFrame.PIXELS];
        values[1] = Float.NaN;
        DepthFrame.normalize(values);
    }

    @Test
    public void flatFramesUseTheOriginalImageWithoutFailingTheSession()
    {
        assertNull(DepthFrame.normalize(new float[DepthFrame.PIXELS]));
    }
}
