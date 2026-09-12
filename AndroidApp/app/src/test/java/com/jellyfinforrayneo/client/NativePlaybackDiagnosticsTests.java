package com.jellyfinforrayneo.client;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class NativePlaybackDiagnosticsTests
{
    @Test
    public void exportKeepsTechnicalMeasurementsAndDropsIdentityUrlsAndArbitraryFields() throws Exception
    {
        NativePlaybackDiagnostics log = new NativePlaybackDiagnostics();
        JSONObject state = new JSONObject("{\"status\":\"playing\",\"position\":12,\"decoder\":\"c2.qti.hevc.decoder\","
                + "\"url\":\"https://private.example.invalid/a\",\"token\":\"private-secret\",\"title\":\"private-title\","
                + "\"depth\":{\"state\":\"ready\",\"worker\":{\"inferenceMs\":{\"mean\":18.4,\"p95\":20.1,\"secret\":\"private-secret\"}},"
                + "\"render\":{\"valid\":true,\"ageMs\":80,\"gpuRender\":{\"meanMs\":9.5,\"p95Ms\":11}}}}");
        log.record(state, 0);
        String report = log.export();
        assertTrue(report.contains("c2.qti.hevc.decoder"));
        assertTrue(report.contains("inferenceMsMean\":18.4"));
        assertTrue(report.contains("gpuMeanMs\":9.5"));
        assertFalse(report.contains("private"));
        assertFalse(report.contains("token"));
        assertFalse(report.contains("https"));
    }

    @Test
    public void samplesAreRateLimitedButErrorsAndSubtitleFailuresRemainVisible() throws Exception
    {
        NativePlaybackDiagnostics log = new NativePlaybackDiagnostics();
        JSONObject state = new JSONObject("{\"status\":\"playing\"}");
        log.record(state, 0);
        log.record(state, 100);
        log.record(state.put("subtitleError", true), 200);
        log.record(state.put("status", "error").put("httpStatus", 404), 250);
        assertEquals(3, log.export().lines().filter(line -> line.startsWith("nativePlayback=")).count());
        assertTrue(log.export().contains("httpStatus\":404"));
    }

    @Test
    public void longRunsAreBoundedAndNeverCoerceUnsafeDiagnosticStrings() throws Exception
    {
        NativePlaybackDiagnostics log = new NativePlaybackDiagnostics();
        for (int i = 0; i < 1000; i++)
            log.record(new JSONObject().put("status", "paused").put("position", i), i * 1000L);
        assertEquals(NativePlaybackDiagnostics.MAX_SAMPLES,
                log.export().lines().filter(line -> line.startsWith("nativePlayback=")).count());
        log.record(new JSONObject("{\"status\":\"error\",\"position\":\"https://private.invalid\",\"decoder\":\"secret\",\"videoCodec\":\"video/private-secret\"}"), 1_000_000);
        assertFalse(log.export().contains("private"));
        assertFalse(log.export().contains("secret"));
        assertTrue(log.export().length() < 200_000);
    }
}
