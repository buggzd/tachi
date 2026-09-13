package com.jellyfinforrayneo.video;

/** Bounded exact SurfaceTexture timestamp to decoder PTS association. Never guesses a nearest frame. */
final class FrameTimeline
{
    static final long UNKNOWN = Long.MIN_VALUE;
    private final long[] release = new long[128], pts = new long[128], visits = new long[128], sequence = new long[128];
    private long serial, matchedRelease, matchedPts, missing;
    private int cursor, size;

    synchronized void decoded(long releaseNs, long ptsUs, long generation)
    {
        release[cursor] = releaseNs;
        pts[cursor] = ptsUs;
        visits[cursor] = generation;
        sequence[cursor] = ++serial;
        cursor = (cursor + 1) % release.length;
        size = Math.min(size + 1, release.length);
    }

    static final class Match
    {
        final long ptsUs, sequence;
        Match(long ptsUs, long sequence) { this.ptsUs = ptsUs; this.sequence = sequence; }
    }

    synchronized Match match(long timestampNs, long generation)
    {
        for (int kind = 0; kind < 2; kind++)
        {
            Match found = null;
            boolean ambiguous = false;
            for (int j = 0; j < size; j++)
            {
                int i = (cursor - 1 - j + release.length) % release.length;
                if (visits[i] != generation) continue;
                long target = kind == 0 ? release[i] : pts[i] * 1000;
                // Some surface implementations truncate release time to microseconds.
                if (Math.abs(timestampNs - target) > (kind == 0 ? 999 : 0)) continue;
                if (found != null && found.ptsUs != pts[i]) ambiguous = true;
                if (found == null) found = new Match(pts[i], sequence[i]);
            }
            if (ambiguous) break;
            if (found != null)
            {
                if (kind == 0) matchedRelease++; else matchedPts++;
                return found;
            }
        }
        missing++;
        return null;
    }

    synchronized String json()
    {
        return "{\"releaseMatches\":" + matchedRelease + ",\"ptsMatches\":" + matchedPts + ",\"missing\":" + missing + "}";
    }
}
