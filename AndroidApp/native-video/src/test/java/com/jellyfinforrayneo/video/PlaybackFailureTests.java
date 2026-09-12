package com.jellyfinforrayneo.video;

import org.junit.Test;
import static org.junit.Assert.*;

@androidx.media3.common.util.UnstableApi
public class PlaybackFailureTests
{
    @Test
    public void identifiesWrappedIoFailureWithoutItsMessage()
    {
        Throwable error = new java.io.IOException("private-url", new java.io.EOFException("private-token"));
        assertEquals("eof", PlaybackFailure.kind(error));
        assertEquals("timeout", PlaybackFailure.kind(new java.io.IOException(new java.net.SocketTimeoutException())));
        assertEquals("unknown", PlaybackFailure.kind(new RuntimeException("private-secret")));
    }

    @Test
    public void identifiesSubtitleParserComponentWithoutExposingTheStack()
    {
        Throwable cause = new IllegalStateException("private-subtitle");
        cause.setStackTrace(new StackTraceElement[]{
                new StackTraceElement("androidx.media3.extractor.text.ssa.SsaParser", "parse", "private-file", 1),
                new StackTraceElement("androidx.media3.extractor.mkv.MatroskaExtractor", "read", "private-file", 2)});
        Throwable failure = new java.io.IOException(cause);
        assertEquals("illegal_state", PlaybackFailure.kind(failure));
        assertEquals("ssa", PlaybackFailure.component(failure));
    }

    @Test
    public void cyclicCausesCannotHangPlaybackDiagnostics()
    {
        Throwable left = new java.io.IOException();
        Throwable right = new IllegalArgumentException();
        left.initCause(right);
        right.initCause(left);
        assertEquals("illegal_argument", PlaybackFailure.kind(left));
        assertEquals("unknown", PlaybackFailure.component(left));
    }
}
