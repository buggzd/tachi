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
                + "\"render\":{\"valid\":true,\"ageMs\":80,\"depthWidth\":392,\"depthHeight\":224,\"gpuRender\":{\"meanMs\":9.5,\"p95Ms\":11}}}}");
        log.record(state, 0);
        String report = log.export();
        assertTrue(report.contains("c2.qti.hevc.decoder"));
        assertTrue(report.contains("inferenceMsMean\":18.4"));
        assertTrue(report.contains("gpuMeanMs\":9.5"));
        assertTrue(report.contains("depthWidth\":392"));
        assertTrue(report.contains("depthHeight\":224"));
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

    @Test
    public void failedAttemptSurvivesLaterLongPlaybackWithoutIdentity() throws Exception
    {
        NativePlaybackDiagnostics log = new NativePlaybackDiagnostics();
        log.record(new JSONObject("{\"event\":\"prepare\"}"), 0);
        log.record(new JSONObject("{\"event\":\"open\",\"status\":\"buffering\"}"), 1);
        log.record(new JSONObject("{\"status\":\"error\",\"httpStatus\":404,\"errorCode\":2004,\"token\":\"private-secret\"}"), 2);
        log.record(new JSONObject("{\"event\":\"prepare\"}"), 3);
        log.record(new JSONObject("{\"event\":\"open\",\"status\":\"buffering\"}"), 4);
        for (int i = 0; i < 500; i++) log.record(new JSONObject("{\"status\":\"playing\"}"), 1000L * (i + 1));
        String report = log.export();
        String failure = report.lines().filter(line -> line.startsWith("playbackFailure=")).findFirst().get();
        assertTrue(failure.contains("\"httpStatus\":404"));
        assertTrue(failure.contains("\"attempt\":1"));
        assertTrue(failure.contains("\"source\":1"));
        assertFalse(report.contains("private"));
        assertFalse(report.lines().filter(line -> line.startsWith("nativePlayback=")).anyMatch(line -> line.contains("\"httpStatus\":404")));
    }

    @Test
    public void eventBridgeRejectsStaleGenerationAndRetainsOnlyTechnicalFields() throws Exception
    {
        JSONObject bootstrap = new JSONObject("{\"session\":{},\"catalogGeneration\":3}");
        assertNull(NativePlaybackDiagnostics.parseEvent("{\"generation\":2,\"event\":\"prepare\"}", bootstrap));
        assertNull(NativePlaybackDiagnostics.parseEvent("{\"generation\":3.5,\"event\":\"prepare\"}", bootstrap));
        assertNull(NativePlaybackDiagnostics.parseEvent("{\"generation\":3,\"event\":\"private-secret\"}", bootstrap));
        NativePlaybackDiagnostics log = new NativePlaybackDiagnostics();
        for (int i = 0; i < 200; i++)
            log.record(NativePlaybackDiagnostics.parseEvent("{\"generation\":3,\"event\":\"prepare_error\",\"failureCode\":\"http\",\"httpStatus\":503,\"url\":\"private-secret\"}", bootstrap), i);
        String report = log.export();
        assertEquals(NativePlaybackDiagnostics.MAX_EVENTS, report.lines().filter(line -> line.startsWith("playbackEvent=")).count());
        assertEquals(NativePlaybackDiagnostics.MAX_FAILURES, report.lines().filter(line -> line.startsWith("playbackFailure=")).count());
        assertTrue(report.contains("503"));
        assertFalse(report.contains("private"));
    }

    @Test
    public void reportsKnownFailureKindsWithoutExportingArbitraryClassNamesOrMessages() throws Exception
    {
        NativePlaybackDiagnostics log = new NativePlaybackDiagnostics();
        log.record(new JSONObject("{\"status\":\"error\",\"errorStage\":\"player\",\"errorKind\":\"illegal_state\",\"errorComponent\":\"ssa\",\"message\":\"private-secret\"}"), 0);
        assertTrue(log.export().contains("\"errorComponent\":\"ssa\""));
        log.record(new JSONObject("{\"status\":\"error\",\"errorKind\":\"private-secret\",\"errorComponent\":\"private-secret\"}"), 1000);
        assertFalse(log.export().contains("private"));
    }
}
