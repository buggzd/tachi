package com.jellyfinforrayneo.video;

import java.util.Arrays;

/** Native port of the validated appearance-gated depth stabilizer, without WebView types. */
public final class TemporalDepth
{
    private float low;
    private float high;
    private float[] previous;
    private byte[] previousRgba;

    public byte[] update(float[] raw, byte[] rgba)
    {
        int pixels = NativeVideoView.SAMPLE_WIDTH * NativeVideoView.SAMPLE_HEIGHT;
        if (raw.length != pixels || rgba.length != pixels * 4) throw new IllegalArgumentException();
        for (float value : raw) if (!Float.isFinite(value)) throw new IllegalArgumentException();
        float[] sorted = raw.clone();
        Arrays.sort(sorted);
        float nextLow = sorted[pixels / 20], nextHigh = sorted[pixels * 19 / 20];
        if (nextHigh - nextLow < .00001f) return null; // Hold the previous useful depth on fades.
        long change = 0;
        if (previousRgba != null)
            for (int i = 0; i < pixels; i++) change += difference(rgba, i);
        boolean reset = previous == null || change > (long) pixels * 3 * 35;
        low = reset ? nextLow : low + .15f * (nextLow - low);
        high = reset ? nextHigh : high + .15f * (nextHigh - high);
        float[] current = new float[pixels];
        byte[] result = new byte[pixels];
        for (int i = 0; i < pixels; i++)
        {
            float value = Math.max(0f, Math.min(1f, (raw[i] - low) / (high - low)));
            if (!reset && difference(rgba, i) <= 18 && Math.abs(value - previous[i]) < .12f)
                value = previous[i] + .35f * (value - previous[i]);
            current[i] = value;
            result[i] = (byte) Math.round(value * 255f);
        }
        previous = current;
        if (previousRgba == null) previousRgba = new byte[pixels * 4];
        System.arraycopy(rgba, 0, previousRgba, 0, rgba.length);
        return result;
    }

    private int difference(byte[] rgba, int pixel)
    {
        int result = 0;
        for (int c = 0; c < 3; c++)
            result += Math.abs((rgba[pixel * 4 + c] & 255)
                    - (previousRgba[pixel * 4 + c] & 255));
        return result;
    }
}
