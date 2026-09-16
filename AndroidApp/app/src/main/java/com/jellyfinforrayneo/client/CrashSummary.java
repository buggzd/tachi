package com.jellyfinforrayneo.client;

/** Bounded symbols only: never exception messages, file paths or thread names. */
final class CrashSummary
{
    static String nativeTrace(java.io.InputStream input) throws java.io.IOException
    {
        if (input == null) return "nativeTrace=unavailable\n";
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int limit = 1024 * 1024;
        while (bytes.size() < limit)
        {
            int count = input.read(chunk, 0, Math.min(chunk.length, limit - bytes.size()));
            if (count < 0) break;
            if (count == 0) break;
            bytes.write(chunk, 0, count);
        }
        boolean truncated = bytes.size() == limit;
        // Android 12+ supplies a protobuf tombstone. Recognize fixed ASCII signatures
        // only; never export its arbitrary strings, memory, paths or abort message.
        String trace = new String(bytes.toByteArray(), java.nio.charset.StandardCharsets.ISO_8859_1);
        return "nativeTraceBytes=" + bytes.size() + " truncated=" + truncated
                + " ortJni=" + trace.contains("libonnxruntime4j_jni.so")
                + " noSuchMethod=" + trace.contains("NoSuchMethodError")
                + " nodeInfo=" + (trace.contains("ai/onnxruntime/NodeInfo") || trace.contains("ai.onnxruntime.NodeInfo"))
                + "\n";
    }

    static String javaCrash(Throwable failure, long timestamp, int version)
    {
        StringBuilder out = new StringBuilder("javaCrash timeMs=").append(timestamp)
                .append(" versionCode=").append(version).append('\n');
        for (int cause = 0; failure != null && cause < 4; cause++)
        {
            out.append("exception=").append(symbol(failure.getClass().getName())).append('\n');
            StackTraceElement[] frames = failure.getStackTrace();
            for (int i = 0; i < Math.min(16, frames.length); i++)
            {
                StackTraceElement frame = frames[i];
                out.append("frame=").append(symbol(frame.getClassName())).append('.')
                        .append(symbol(frame.getMethodName())).append(':')
                        .append(frame.getLineNumber()).append('\n');
            }
            Throwable next = failure.getCause();
            if (next == failure) break;
            failure = next;
        }
        return out.toString();
    }

    private static String symbol(String value)
    {
        return value != null && value.length() <= 180 && value.matches("[A-Za-z0-9_.$<>]+")
                ? value : "omitted";
    }
}
