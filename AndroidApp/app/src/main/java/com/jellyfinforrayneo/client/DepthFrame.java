package com.jellyfinforrayneo.client;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Arrays;

/** Fixed, credential-free video-frame protocol. No URLs, file paths or variable tensor shapes. */
final class DepthFrame
{
    static final int WIDTH = 266;
    static final int HEIGHT = 154;
    static final int PIXELS = WIDTH * HEIGHT;
    static final int MAX_JSON = 222000;
    final String token;
    final int sequence;
    final long capturedAt;
    final String rgba;
    final float[] rect;
    final float[][] masks;
    final boolean debug;

    private DepthFrame(JSONObject json) throws Exception
    {
        token = json.getString("token");
        if (!validToken(token) || json.length() != 7)
        {
            throw new IllegalArgumentException();
        }
        if (!(json.get("sequence") instanceof Number) || !(json.get("capturedAt") instanceof Number))
        {
            throw new IllegalArgumentException();
        }
        double id = json.getDouble("sequence");
        if (!Double.isFinite(id) || id < 1 || id > 2147483647 || id != Math.floor(id))
        {
            throw new IllegalArgumentException();
        }
        sequence = (int) id;
        double time = json.getDouble("capturedAt");
        if (!Double.isFinite(time) || time <= 0 || time != Math.floor(time) || time > 9007199254740991d)
        {
            throw new IllegalArgumentException();
        }
        capturedAt = (long) time;
        rgba = json.getString("rgba");
        if (rgba.length() != ((PIXELS * 4 + 2) / 3) * 4)
        {
            throw new IllegalArgumentException();
        }
        rect = rect(json.getJSONArray("rect"));
        JSONArray list = json.getJSONArray("masks");
        if (list.length() > 8)
        {
            throw new IllegalArgumentException();
        }
        masks = new float[list.length()][];
        for (int i = 0; i < list.length(); i++)
        {
            masks[i] = rect(list.getJSONArray(i));
        }
        if (!(json.get("debug") instanceof Boolean))
        {
            throw new IllegalArgumentException();
        }
        debug = json.getBoolean("debug");
    }

    static boolean validToken(String value)
    {
        return value != null && value.matches("[a-zA-Z0-9-]{1,48}");
    }

    static DepthFrame parse(String input)
    {
        if (input == null || input.length() > MAX_JSON)
        {
            return null;
        }
        try
        {
            return new DepthFrame(new JSONObject(input));
        }
        catch (Exception ignored)
        {
            return null;
        }
    }

    private static float[] rect(JSONArray array) throws Exception
    {
        if (array.length() != 4)
        {
            throw new IllegalArgumentException();
        }
        float[] r = new float[4];
        for (int i = 0; i < 4; i++)
        {
            Object raw = array.get(i);
            if (!(raw instanceof Number))
            {
                throw new IllegalArgumentException();
            }
            double value = ((Number) raw).doubleValue();
            if (!Double.isFinite(value) || value < 0 || value > 1)
            {
                throw new IllegalArgumentException();
            }
            r[i] = (float) value;
        }
        if (r[2] <= r[0] || r[3] <= r[1])
        {
            throw new IllegalArgumentException();
        }
        return r;
    }

    static float[] preprocess(byte[] rgba)
    {
        if (rgba.length != PIXELS * 4)
        {
            throw new IllegalArgumentException();
        }
        float[] input = new float[PIXELS * 3];
        float[] mean = {.485f, .456f, .406f}, std = {.229f, .224f, .225f};
        for (int c = 0; c < 3; c++)
        {
            for (int i = 0; i < PIXELS; i++)
            {
                input[c * PIXELS + i] = ((rgba[4 * i + c] & 255) / 255f - mean[c]) / std[c];
            }
        }
        return input;
    }

    static byte[] normalize(float[] values)
    {
        if (values.length != PIXELS)
        {
            throw new IllegalArgumentException();
        }
        for (float value : values)
        {
            if (!Float.isFinite(value))
            {
                throw new IllegalArgumentException();
            }
        }
        float[] sorted = values.clone();
        Arrays.sort(sorted);
        float lo = sorted[PIXELS / 20], hi = sorted[PIXELS * 19 / 20];
        if (hi - lo < .00001f)
        {
            // A fade/flat frame has no useful relative depth; keep the original image.
            return null;
        }
        byte[] result = new byte[PIXELS];
        for (int i = 0; i < PIXELS; i++)
        {
            result[i] = (byte) Math.round(Math.max(0f, Math.min(1f, (values[i] - lo) / (hi - lo))) * 255f);
        }
        return result;
    }
}
