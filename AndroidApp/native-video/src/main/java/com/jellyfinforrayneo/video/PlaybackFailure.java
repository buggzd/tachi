package com.jellyfinforrayneo.video;

/** Fixed technical categories only. Never exports exception messages, stack traces or URLs. */
@androidx.media3.common.util.UnstableApi
final class PlaybackFailure
{
    static String kind(Throwable failure)
    {
        String result = "unknown";
        for (int i = 0; i < 16 && failure != null; i++, failure = failure.getCause())
        {
            if (failure instanceof java.io.EOFException) result = "eof";
            else if (failure instanceof java.net.SocketTimeoutException) result = "timeout";
            else if (failure instanceof java.net.UnknownHostException) result = "dns";
            else if (failure instanceof java.net.ConnectException) result = "connect";
            else if (failure instanceof javax.net.ssl.SSLException) result = "tls";
            else if (failure instanceof java.net.SocketException) result = "socket";
            else if (failure instanceof androidx.media3.common.ParserException) result = "parser";
            else if (failure instanceof java.io.IOException) result = "io";
            else if (failure instanceof IndexOutOfBoundsException) result = "bounds";
            else if (failure instanceof IllegalArgumentException) result = "illegal_argument";
            else if (failure instanceof IllegalStateException) result = "illegal_state";
        }
        return result;
    }

    static String component(Throwable failure)
    {
        String result = "unknown";
        for (int i = 0; i < 16 && failure != null; i++, failure = failure.getCause())
        {
            StackTraceElement[] trace = failure.getStackTrace();
            for (int j = 0; j < Math.min(64, trace.length); j++)
            {
                String name = trace[j].getClassName();
                if (name.startsWith("androidx.media3.extractor.text.ssa.")) return "ssa";
                if (name.startsWith("androidx.media3.extractor.text.")) result = "subtitle";
                else if (!"subtitle".equals(result))
                {
                    if (name.startsWith("androidx.media3.extractor.mkv.")) result = "matroska";
                    else if (name.startsWith("androidx.media3.datasource.")) result = "datasource";
                    else if (name.startsWith("androidx.media3.exoplayer.mediacodec.")) result = "codec";
                }
            }
        }
        return result;
    }
}
