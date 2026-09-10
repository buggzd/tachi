package com.jellyfinforrayneo.client;

import java.util.Arrays;

/** Worker-confined, visit-local stabilization; moving pixels do not blend old geometry. */
final class DepthStabilizer
{
    private float low;
    private float high;
    private float[] previous;
    private byte[] previousRgba;

    byte[] update(float[] raw, byte[] rgba)
    {
        if (raw.length != DepthFrame.PIXELS || rgba.length != DepthFrame.PIXELS * 4)
        {
            throw new IllegalArgumentException();
        }
        for (float value : raw)
        {
            if (!Float.isFinite(value)) throw new IllegalArgumentException();
        }
        float[] sorted = raw.clone();
        Arrays.sort(sorted);
        float nextLow = sorted[raw.length / 20];
        float nextHigh = sorted[raw.length * 19 / 20];
        if (nextHigh - nextLow < .00001f) return null;

        long colorChange = 0;
        if (previousRgba != null)
        {
            for (int i = 0; i < raw.length; i++) colorChange += difference(rgba, previousRgba, i);
        }
        // Conservative photometric cut heuristic, not optical flow or a scene-cut guarantee.
        boolean reset = previous == null || colorChange > (long) raw.length * 3 * 35;
        if (reset)
        {
            low = nextLow;
            high = nextHigh;
        }
        else
        {
            low += .15f * (nextLow - low);
            high += .15f * (nextHigh - high);
        }
        float[] current = new float[raw.length];
        byte[] output = new byte[raw.length];
        for (int i = 0; i < raw.length; i++)
        {
            float value = Math.max(0f, Math.min(1f, (raw[i] - low) / (high - low)));
            // Smooth small fluctuations only where appearance is stable. Never average
            // large depth edges or visibly moving pixels into trailing silhouettes.
            if (!reset && difference(rgba, previousRgba, i) <= 18
                    && Math.abs(value - previous[i]) < .12f)
            {
                value = previous[i] + .35f * (value - previous[i]);
            }
            current[i] = value;
            output[i] = (byte) Math.round(value * 255f);
        }
        previous = current;
        previousRgba = rgba.clone();
        return output;
    }

    private static int difference(byte[] a, byte[] b, int pixel)
    {
        int result = 0;
        for (int c = 0; c < 3; c++)
        {
            result += Math.abs((a[pixel * 4 + c] & 255) - (b[pixel * 4 + c] & 255));
        }
        return result;
    }
}
