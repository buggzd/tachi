package com.jellyfinforrayneo.client;

import org.junit.Test;
import static org.junit.Assert.*;

public final class CrashSummaryTests
{
    @Test
    public void nativeTraceExportsOnlyFixedSignaturesAndBoundsInput() throws Exception
    {
        String raw = "private-token https://private/media libonnxruntime4j_jni.so NoSuchMethodError ai/onnxruntime/NodeInfo";
        String report = CrashSummary.nativeTrace(new java.io.ByteArrayInputStream(
                raw.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        assertTrue(report.contains("ortJni=true noSuchMethod=true nodeInfo=true"));
        assertFalse(report.contains("private"));
        byte[] huge = new byte[2 * 1024 * 1024];
        assertTrue(CrashSummary.nativeTrace(new java.io.ByteArrayInputStream(huge))
                .contains("nativeTraceBytes=1048576 truncated=true"));
        assertEquals("nativeTrace=unavailable\n", CrashSummary.nativeTrace(null));
    }

    @Test
    public void crashRetainsSymbolsButNeverMessagesPathsOrUnsafeFrames()
    {
        Throwable failure = new IllegalStateException("secret-token media-title server-address",
                new NoSuchMethodError("private-value"));
        failure.setStackTrace(new StackTraceElement[] {
                new StackTraceElement("ai.onnxruntime.OrtSession", "getOutputInfo", "/private/file", 42),
                new StackTraceElement("unsafe/secret", "bad\nsecret", "private", 1)});
        String report = CrashSummary.javaCrash(failure, 1234, 10);
        assertTrue(report.contains("versionCode=10"));
        assertTrue(report.contains("ai.onnxruntime.OrtSession.getOutputInfo:42"));
        assertTrue(report.contains("java.lang.NoSuchMethodError"));
        assertFalse(report.contains("secret"));
        assertFalse(report.contains("private"));
        assertFalse(report.contains("media-title"));
    }

    @Test
    public void cyclicCausesAndLargeStacksStayBounded()
    {
        Throwable first = new RuntimeException();
        Throwable second = new RuntimeException();
        first.initCause(second);
        second.initCause(first);
        StackTraceElement[] frames = new StackTraceElement[1000];
        java.util.Arrays.fill(frames, new StackTraceElement("test.Class", "method", "file", 1));
        first.setStackTrace(frames);
        second.setStackTrace(frames);
        String report = CrashSummary.javaCrash(first, 1, 10);
        assertTrue(report.length() < 32768);
        assertEquals(4, report.split("exception=", -1).length - 1);
        assertEquals(64, report.split("frame=", -1).length - 1);
    }
}
