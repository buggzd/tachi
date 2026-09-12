package com.jellyfinforrayneo.client;

import java.util.ArrayDeque;
import org.json.JSONObject;

/** App-lifetime, bounded technical samples; never retains an input snapshot or media identity. */
final class NativePlaybackDiagnostics
{
    static final int MAX_SAMPLES = 120;
    private final ArrayDeque<JSONObject> samples = new ArrayDeque<>();
    private long lastAt = -1;
    private String lastStatus = "";
    private String lastDepthState = "";
    private boolean lastSubtitleError;

    synchronized void record(JSONObject source, long elapsedMs)
    {
        if (source == null) return;
        String status = source.optString("status");
        if (!status.matches("playing|paused|buffering|ended|error|stopped")) return;
        JSONObject depth = source.optJSONObject("depth");
        String depthState = depth == null ? "disabled" : depth.optString("state");
        boolean subtitleError = source.optBoolean("subtitleError");
        if (lastAt >= 0 && elapsedMs - lastAt < 1000 && status.equals(lastStatus)
                && depthState.equals(lastDepthState) && subtitleError == lastSubtitleError) return;
        lastAt = elapsedMs;
        lastStatus = status;
        lastDepthState = depthState;
        lastSubtitleError = subtitleError;
        try
        {
            JSONObject row = new JSONObject();
            row.put("elapsedMs", Math.max(0, elapsedMs));
            row.put("status", status);
            copyNumbers(source, row, "position", "duration", "buffered", "width", "height", "frameRate",
                    "droppedFrames", "decodedFrames", "errorCode", "httpStatus", "audioChannels", "audioSampleRate");
            copyBooleans(source, row, "firstFrame", "seekable", "hls", "subtitleError");
            String decoder = source.optString("decoder");
            if (decoder.matches("(?:c2|OMX)\\.[a-zA-Z0-9._-]{1,80}")) row.put("decoder", decoder);
            for (String key : new String[]{"videoCodec", "audioCodec"})
            {
                String mime = source.optString(key);
                if (mime.matches("(?:video|audio)/(?:avc|hevc|av01|x-vnd.on2.vp[89]|mp4a-latm|mpeg|opus|vorbis|ac3|eac3|flac)"))
                    row.put(key, mime);
            }
            String subtitle = source.optString("subtitleKind");
            if (subtitle.matches("off|ass|vtt|burned")) row.put("subtitle", subtitle);
            if (depth != null)
            {
                if (depthState.matches("disabled|initializing|ready|error")) row.put("depthState", depthState);
                copyNumbers(depth, row, "discarded");
                JSONObject worker = depth.optJSONObject("worker");
                if (worker != null)
                {
                    number(worker, "count", row, "depthComputed");
                    timings(worker, row, "preprocessMs", "inferenceMs", "stabilizeMs");
                }
                JSONObject readback = depth.optJSONObject("readback");
                if (readback != null) timings(readback, row, "submitMs", "fenceObservedMs", "mapCopyMs");
                JSONObject render = depth.optJSONObject("render");
                if (render != null)
                {
                    copyBooleans(render, row, "valid", "stereo", "debug");
                    copyNumbers(render, row, "uploads", "ageMs", "eyeTargetWidth");
                    JSONObject timing = render.optJSONObject("timings");
                    if (timing != null) timings(timing, row, "captureToUploadMs", "uploadMs", "drawSubmitMs");
                    JSONObject gpu = render.optJSONObject("gpuRender");
                    if (gpu != null)
                    {
                        number(gpu, "meanMs", row, "gpuMeanMs");
                        number(gpu, "p95Ms", row, "gpuP95Ms");
                        number(gpu, "disjoint", row, "gpuDisjoint");
                    }
                }
            }
            while (samples.size() >= MAX_SAMPLES) samples.removeFirst();
            samples.addLast(row);
        }
        catch (Exception ignored) { /* Invalid diagnostics must never interrupt playback. */ }
    }

    synchronized String export()
    {
        StringBuilder out = new StringBuilder("nativePlaybackSchema=1\n")
                .append("nativePlaybackRetention=last 120 samples; at most 1 Hz plus state changes; current app process\n")
                .append("nativePlaybackTiming=milliseconds; rolling 512 samples; GPU timer excludes compositor; depth age is not end-to-end latency\n");
        for (JSONObject row : samples) out.append("nativePlayback=").append(row).append('\n');
        return out.toString();
    }

    private static void timings(JSONObject source, JSONObject out, String... keys) throws Exception
    {
        for (String key : keys)
        {
            JSONObject timing = source.optJSONObject(key);
            if (timing == null) continue;
            number(timing, "mean", out, key + "Mean");
            number(timing, "p95", out, key + "P95");
        }
    }

    private static void copyNumbers(JSONObject source, JSONObject out, String... keys) throws Exception
    {
        for (String key : keys) number(source, key, out, key);
    }

    private static void number(JSONObject source, String key, JSONObject out, String name) throws Exception
    {
        Object value = source.opt(key);
        if (!(value instanceof Number)) return;
        double number = ((Number) value).doubleValue();
        if (Double.isFinite(number) && number >= 0 && number <= 1_000_000_000)
            out.put(name, Math.round(number * 1000) / 1000.0);
    }

    private static void copyBooleans(JSONObject source, JSONObject out, String... keys) throws Exception
    {
        for (String key : keys)
            if (source.opt(key) instanceof Boolean) out.put(key, source.getBoolean(key));
    }
}
