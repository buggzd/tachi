package com.jellyfinforrayneo.client;

import java.util.ArrayDeque;
import org.json.JSONObject;

/** App-lifetime, bounded technical samples; never retains an input snapshot or media identity. */
final class NativePlaybackDiagnostics
{
    static final int MAX_SAMPLES = 120;
    static final int MAX_EVENTS = 64;
    static final int MAX_FAILURES = 32;
    private final ArrayDeque<JSONObject> events = new ArrayDeque<>();
    private final ArrayDeque<JSONObject> failures = new ArrayDeque<>();
    private int attempt;
    private int sourceNumber;
    private int lastErrorCode;
    private int lastHttpStatus;
    static final int MAX_MINUTES = 60;
    private final ArrayDeque<JSONObject> minutes = new ArrayDeque<>();
    private long lastMinuteAt = -1;
    private final ArrayDeque<JSONObject> samples = new ArrayDeque<>();
    private long lastAt = -1;
    private String lastStatus = "";
    private String lastDepthState = "";
    private boolean lastSubtitleError;

    synchronized void record(JSONObject source, long elapsedMs)
    {
        if (source == null) return;
        String event = source.optString("event");
        if (event.matches("prepare|prepare_error|plan_ready|fallback|playback_error|command_rejected|open|seek"))
        {
            if ("prepare".equals(event)) attempt++;
            if ("open".equals(event)) { sourceNumber++; lastAt = -1; }
            JSONObject row = eventRow(source, event, elapsedMs);
            append(events, row, MAX_EVENTS);
            if (event.matches("prepare_error|playback_error|command_rejected")) append(failures, row, MAX_FAILURES);
        }
        String status = source.optString("status");
        if (!status.matches("playing|paused|buffering|ended|error|stopped")) return;
        JSONObject depth = source.optJSONObject("depth");
        String depthState = depth == null ? "disabled" : depth.optString("state");
        boolean subtitleError = source.optBoolean("subtitleError");
        int errorCode = source.optInt("errorCode");
        int httpStatus = source.optInt("httpStatus");
        boolean changed = !status.equals(lastStatus) || !depthState.equals(lastDepthState)
                || subtitleError != lastSubtitleError || errorCode != lastErrorCode || httpStatus != lastHttpStatus;
        boolean failure = ("error".equals(status) && (!"error".equals(lastStatus)
                || errorCode != lastErrorCode || httpStatus != lastHttpStatus || lastAt < 0))
                || ("error".equals(depthState) && (!"error".equals(lastDepthState) || lastAt < 0))
                || (subtitleError && (!lastSubtitleError || lastAt < 0));
        if (lastAt >= 0 && elapsedMs - lastAt < 1000 && status.equals(lastStatus)
                && !changed) return;
        lastAt = elapsedMs;
        lastStatus = status;
        lastDepthState = depthState;
        lastSubtitleError = subtitleError;
        lastErrorCode = errorCode;
        lastHttpStatus = httpStatus;
        try
        {
            JSONObject row = new JSONObject();
            row.put("elapsedMs", Math.max(0, elapsedMs));
            row.put("status", status);
            row.put("attempt", attempt);
            row.put("source", sourceNumber);
            String stage = source.optString("errorStage");
            if (stage.matches("none|player|surface|audio_track|initialization|request")) row.put("errorStage", stage);
            String kind = source.optString("errorKind");
            if (kind.matches("none|unknown|eof|timeout|dns|connect|socket|tls|io|parser|illegal_state|illegal_argument|bounds|invalid_request")) row.put("errorKind", kind);
            String component = source.optString("errorComponent");
            if (component.matches("none|unknown|ssa|subtitle|matroska|datasource|codec")) row.put("errorComponent", component);
            copyNumbers(source, row, "position", "pairedPosition", "duration", "buffered", "width", "height", "frameRate",
                    "droppedFrames", "decodedFrames", "skippedDecoderFrames", "maxConsecutiveDroppedFrames", "errorCode", "httpStatus", "audioChannels", "audioSampleRate");
            signedTime(source, "playerMinusPairedMs", row, 86_400_000);
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
                JSONObject scheduling = depth.optJSONObject("scheduling");
                if (scheduling != null) timings(scheduling, row, "queueWaitMs", "captureToWorkerMs", "workerServiceMs");
                copyBooleans(depth, row, "gpuPollOffMain");
                JSONObject poll = depth.optJSONObject("pollScheduling");
                if (poll != null) timings(poll, row, "pollWakeMs", "pollGlQueueMs", "pollServiceMs");
                JSONObject readback = depth.optJSONObject("readback");
                if (readback != null) timings(readback, row, "submitMs", "fenceObservedMs", "mapCopyMs");
                JSONObject render = depth.optJSONObject("render");
                if (render != null)
                {
                    copyBooleans(render, row, "valid", "stereo", "debug", "gpuStabilization", "gpuPreprocess", "pinnedDepthOutput", "asyncCapturePoll", "alignedLiquid");
                    copyNumbers(render, row, "uploads", "ageMs", "eyeTargetWidth", "depthWidth", "depthHeight", "captureSlots", "depthTargetHz", "videoDraws", "supersededVideoFrames", "pairedFrames", "cachedPairDraws", "pairRenderUpdates", "pairedVideoLagUs", "liquidStrength", "liquidFeatherPx", "liquidAmount");
                    Object ptsValue = render.opt("pairedPtsUs");
                    if (ptsValue instanceof Number && ((Number) ptsValue).longValue() >= 0
                            && ((Number) ptsValue).doubleValue() <= 86_400_000_000L
                            && Double.isFinite(((Number) ptsValue).doubleValue()))
                        row.put("pairedPtsUs", ((Number) ptsValue).longValue());
                    JSONObject admission = render.optJSONObject("captureAdmission");
                    if (admission != null)
                        for (String key : new String[]{"candidates", "cadenceSkips", "fenceSkips", "slotSkips",
                                "submitted", "retryAttempts", "retrySubmitted"})
                            number(admission, key, row, "capture" + Character.toUpperCase(key.charAt(0)) + key.substring(1));
                    JSONObject mapping = render.optJSONObject("frameMapping");
                    if (mapping != null)
                    {
                        number(mapping, "releaseMatches", row, "ptsReleaseMatches");
                        number(mapping, "ptsMatches", row, "ptsDirectMatches");
                        number(mapping, "missing", row, "ptsMissing");
                    }
                    JSONObject pts = render.optJSONObject("depthPts");
                    if (pts != null)
                    {
                        number(pts, "count", row, "depthPtsSamples");
                        number(pts, "unknown", row, "depthPtsUnknown");
                        number(pts, "future", row, "depthPtsFuture");
                        for (String metric : new String[]{"meanMs", "p95Ms", "maxMs"})
                        {
                            Object value = pts.opt(metric);
                            if (value instanceof Number && Double.isFinite(((Number) value).doubleValue())
                                    && Math.abs(((Number) value).doubleValue()) <= 86_400_000)
                                row.put("depthPtsLag" + Character.toUpperCase(metric.charAt(0)) + metric.substring(1), value);
                        }
                    }
                    copyBooleans(render, row, "captureBeforeLiquid", "liquidFusedRounds", "liquidCacheSamples");
                    JSONObject pairDraw = render.optJSONObject("pairDrawTimings");
                    if (pairDraw != null) timings(pairDraw, row, "pairReadyToDrawMs", "pairCaptureToDrawMs", "pairDrawSubmitMs");
                    JSONObject timing = render.optJSONObject("timings");
                    if (timing != null) timings(timing, row, "captureToUploadMs", "uploadMs", "drawSubmitMs");
                    JSONObject gpu = render.optJSONObject("gpuRender");
                    if (gpu != null)
                    {
                        number(gpu, "meanMs", row, "gpuMeanMs");
                        number(gpu, "p95Ms", row, "gpuP95Ms");
                        number(gpu, "disjoint", row, "gpuDisjoint");
                    }
                    JSONObject stabilize = render.optJSONObject("gpuStabilize");
                    if (stabilize != null)
                    {
                        number(stabilize, "meanMs", row, "gpuStabilizeMeanMs");
                        number(stabilize, "p95Ms", row, "gpuStabilizeP95Ms");
                        number(stabilize, "disjoint", row, "gpuStabilizeDisjoint");
                    }
                    JSONObject liquidCompletion = render.optJSONObject("gpuLiquidCompletion");
                    if (liquidCompletion != null)
                    {
                        for (String liquidStage : new String[]{"submitMs", "fenceObservedMs", "pollMs"})
                        {
                            JSONObject measured = liquidCompletion.optJSONObject(liquidStage);
                            if (measured != null)
                            {
                                number(measured, "mean", row, "liquid" + liquidStage + "Mean");
                                number(measured, "p95", row, "liquid" + liquidStage + "P95");
                            }
                        }
                    }
                    JSONObject liquid = render.optJSONObject("gpuLiquid");
                    if (liquid != null)
                    {
                        number(liquid, "meanMs", row, "gpuLiquidMeanMs");
                        number(liquid, "p95Ms", row, "gpuLiquidP95Ms");
                        number(liquid, "disjoint", row, "gpuLiquidDisjoint");
                    }
                    JSONObject stages = render.optJSONObject("gpuStages");
                    if (stages != null)
                    {
                        JSONObject complete = stages.optJSONObject("completionMs");
                        if (complete != null)
                        {
                            number(complete, "mean", row, "gpuStabilizeCompletionMeanMs");
                            number(complete, "p95", row, "gpuStabilizeCompletionP95Ms");
                        }
                    }
                }
            }
            append(samples, row, MAX_SAMPLES);
            if (lastMinuteAt < 0 || elapsedMs - lastMinuteAt >= 60_000)
            {
                append(minutes, row, MAX_MINUTES);
                lastMinuteAt = elapsedMs;
            }
            if (!"none".equals(BuildConfig.DAILY_SBS)) android.util.Log.i("TachiPlaybackTrial", row.toString());
            if (changed || "open".equals(event)) append(events, row, MAX_EVENTS);
            if (failure) append(failures, row, MAX_FAILURES);
        }
        catch (Exception ignored) { /* Invalid diagnostics must never interrupt playback. */ }
    }

    synchronized String export()
    {
        StringBuilder out = new StringBuilder("nativePlaybackSchema=2\n")
                .append("nativePlaybackRetention=last 120 samples; at most 1 Hz plus state changes; current app process; separate last 64 events and 32 failures\n")
                .append("nativePlaybackClock=milliseconds since app diagnostic clock started; same clock as events\n")
                .append("nativePlaybackTiming=milliseconds; rolling 512 samples; GPU timer excludes compositor; depth age is not end-to-end latency\n")
                .append("nativePlaybackGpuStabilization=when true, worker stabilizeMs measures raw-depth handoff; GPU completion includes submit and GL scheduling\n")
                .append("nativePlaybackGpuPreprocess=when true, worker preprocessMs measures host tensor wrapping; GPU preparation and readback are in capture timings; pinned output is host memory\n");
        out.append("nativePlaybackPts=signed video PTS minus applied depth source PTS at GL draw; exact metadata matches only; not optical presentation latency\n");
        out.append("nativePlaybackCapture=captureSubmitted includes retrySubmitted; skip counters count initial fresh-frame attempts; counters are cumulative, not fps\n");
        out.append("nativePlaybackMinutes=last 60 minute snapshots; cumulative counters and recent rolling windows; not full-minute averages\n");
        out.append("dailySbsProfile=").append(BuildConfig.DAILY_SBS).append('\n');
        for (JSONObject row : minutes) out.append("playbackMinute=").append(row).append('\n');
        for (JSONObject row : events) out.append("playbackEvent=").append(row).append('\n');
        for (JSONObject row : failures) out.append("playbackFailure=").append(row).append('\n');
        for (JSONObject row : samples) out.append("nativePlayback=").append(row).append('\n');
        return out.toString();
    }

    /** Frontend event envelope: reject stale sessions and copy only enum/numeric fields at record time. */
    static JSONObject parseEvent(String payload, JSONObject bootstrap)
    {
        if (payload == null || payload.length() > 1024 || bootstrap == null || bootstrap.optJSONObject("session") == null) return null;
        try
        {
            JSONObject value = new JSONObject(payload);
            Object generation = value.opt("generation");
            if (!(generation instanceof Number) || ((Number) generation).doubleValue() != bootstrap.optInt("catalogGeneration", -1)) return null;
            if (!value.optString("event").matches("prepare|prepare_error|plan_ready|fallback|playback_error")) return null;
            return value;
        }
        catch (Exception ignored) { return null; }
    }

    private JSONObject eventRow(JSONObject source, String event, long elapsedMs)
    {
        JSONObject row = new JSONObject();
        try
        {
            row.put("event", event);
            row.put("elapsedMs", Math.max(0, elapsedMs));
            row.put("attempt", attempt);
            row.put("source", sourceNumber);
            String code = source.optString("failureCode");
            if (code.matches("network|http|response|unknown")) row.put("failureCode", code);
            copyNumbers(source, row, "httpStatus", "position", "duration", "width", "height");
            copyBooleans(source, row, "hls", "fallbackAvailable");
        }
        catch (Exception ignored) { /* Fixed schema. */ }
        return row;
    }

    private static void append(ArrayDeque<JSONObject> target, JSONObject row, int limit)
    {
        while (target.size() >= limit) target.removeFirst();
        target.addLast(row);
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

    private static void signedTime(JSONObject source, String key, JSONObject out, long limit) throws Exception
    {
        Object value = source.opt(key);
        if (!(value instanceof Number)) return;
        double number = ((Number) value).doubleValue();
        if (Double.isFinite(number) && Math.abs(number) <= limit) out.put(key, number);
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
