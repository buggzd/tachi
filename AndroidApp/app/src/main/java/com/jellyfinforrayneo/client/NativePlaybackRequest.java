package com.jellyfinforrayneo.client;

import org.json.JSONObject;
import java.net.URI;

/** Pure validation boundary; plans are tied to the current native session generation. */
final class NativePlaybackRequest
{
    static final long MAX_POSITION_MS = 604_800_000L;
    final String token;
    final int generation;
    final String operation;
    final String url;
    final long positionMs;
    final boolean playing;
    final boolean hls;
    final int audioOrdinal;
    final boolean depth;
    final boolean debug;
    final int seekId;
    final String subtitleKind;
    final boolean subtitleError;

    private NativePlaybackRequest(JSONObject json) throws Exception
    {
        token = json.getString("token");
        generation = json.getInt("generation");
        if (!(json.get("generation") instanceof Number) || json.getDouble("generation") != generation)
            throw new IllegalArgumentException("generation");
        seekId = json.optInt("seekId", 0);
        if (seekId < 0) throw new IllegalArgumentException("seek");
        operation = json.getString("operation");
        url = json.optString("url", "");
        double position = json.optDouble("position", 0);
        if (!token.matches("[a-zA-Z0-9-]{16,80}") || generation < 0
                || !Double.isFinite(position) || position < 0 || position > MAX_POSITION_MS / 1000.0)
            throw new IllegalArgumentException("bounds");
        positionMs = Math.round(position * 1000);
        playing = json.optBoolean("playing", true);
        hls = json.optBoolean("hls", false);
        audioOrdinal = json.optInt("audioOrdinal", -1);
        if (audioOrdinal < -1 || audioOrdinal > 127) throw new IllegalArgumentException("track");
        subtitleKind = json.optString("subtitleKind", "off");
        if (!subtitleKind.matches("off|ass|vtt|burned")) throw new IllegalArgumentException("subtitle");
        subtitleError = json.optBoolean("subtitleError", false);
        depth = json.optBoolean("depth", false);
        debug = json.optBoolean("debug", false);
        if (!operation.matches("open|play|pause|seek|stop|depth|subtitle")) throw new IllegalArgumentException("operation");
    }

    static NativePlaybackRequest parse(String payload, JSONObject bootstrap)
    {
        if (payload == null || payload.length() > 16_384 || bootstrap == null) return null;
        try
        {
            NativePlaybackRequest request = new NativePlaybackRequest(new JSONObject(payload));
            JSONObject session = bootstrap.optJSONObject("session");
            if (session == null || request.generation != bootstrap.optInt("catalogGeneration", -1)) return null;
            if ("open".equals(request.operation) && !validSource(request.url, session.getString("serverUrl"))) return null;
            return request;
        }
        catch (Exception ignored) { return null; }
    }

    /** A rejected current-source open must fail visibly instead of leaving the UI buffering forever. */
    static JSONObject rejectedOpen(String payload, JSONObject bootstrap)
    {
        if (payload == null || payload.length() > 16_384 || bootstrap == null
                || bootstrap.optJSONObject("session") == null) return null;
        try
        {
            JSONObject json = new JSONObject(payload);
            String token = json.optString("token");
            Object generation = json.opt("generation");
            int current = bootstrap.optInt("catalogGeneration", -1);
            if (!"open".equals(json.optString("operation")) || !token.matches("[a-zA-Z0-9-]{16,80}")
                    || current < 0 || !(generation instanceof Number) || ((Number) generation).doubleValue() != current) return null;
            return new JSONObject().put("token", token).put("generation", current)
                    .put("status", "error").put("position", 0).put("duration", 0)
                    .put("errorStage", "request").put("errorKind", "invalid_request");
        }
        catch (Exception ignored) { return null; }
    }

    static boolean validSource(String source, String server)
    {
        try
        {
            if (source.length() > 12_288) return false;
            URI url = new URI(source), base = new URI(server);
            if (!("http".equals(url.getScheme()) || "https".equals(url.getScheme()))
                    || url.getHost() == null || !sameHost(url.getHost(), base.getHost())
                    || !url.getScheme().equals(base.getScheme()) || port(url) != port(base)
                    || url.getRawUserInfo() != null || url.getRawFragment() != null) return false;
            String path = url.getPath(), prefix = base.getPath().replaceAll("/+$", "") + "/";
            // Jellyfin emits lowercase /videos/ HLS routes. Preserve the reverse-proxy base path's case.
            return path.startsWith(prefix) && path.regionMatches(true, prefix.length(), "Videos/", 0, 7)
                    && !path.contains("/../") && !path.contains("/./")
                    && !path.contains("\\") && !path.contains("%") && path.length() <= 4096;
        }
        catch (Exception ignored) { return false; }
    }

    private static boolean sameHost(String left, String right) throws Exception
    {
        if (right == null) return false;
        if (left.equalsIgnoreCase(right)) return true;
        // Java retains expanded IPv6; URL in JS compresses it. Parse numeric literals only: never DNS on UI.
        if (!left.contains(":") || !right.contains(":")
                || !left.matches("[0-9a-fA-F:.\\[\\]]+") || !right.matches("[0-9a-fA-F:.\\[\\]]+")) return false;
        return java.net.InetAddress.getByName(left).equals(java.net.InetAddress.getByName(right));
    }

    private static int port(URI uri)
    {
        return uri.getPort() >= 0 ? uri.getPort() : "https".equals(uri.getScheme()) ? 443 : 80;
    }
}
