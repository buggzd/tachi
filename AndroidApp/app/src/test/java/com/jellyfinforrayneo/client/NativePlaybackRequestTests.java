package com.jellyfinforrayneo.client;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class NativePlaybackRequestTests
{
    private JSONObject bootstrap() throws Exception
    {
        return new JSONObject("{\"catalogGeneration\":3,\"session\":{\"serverUrl\":\"https://media.example.invalid/jellyfin\"}}");
    }

    private JSONObject request() throws Exception
    {
        return new JSONObject("{\"operation\":\"open\",\"token\":\"playback-token-1234\",\"generation\":3,"
                + "\"url\":\"https://media.example.invalid/jellyfin/Videos/item/stream.mkv?static=true\"}");
    }

    @Test
    public void acceptsAuthenticatedSameServerVideoPlansAndBoundedControls() throws Exception
    {
        assertNotNull(NativePlaybackRequest.parse(request().toString(), bootstrap()));
        JSONObject seek = request().put("operation", "seek").put("position", 3600.25);
        assertEquals(3600250, NativePlaybackRequest.parse(seek.toString(), bootstrap()).positionMs);
    }

    @Test
    public void acceptsEquivalentIpv6SpellingsWithoutAllowingADifferentOrigin()
    {
        assertTrue(NativePlaybackRequest.validSource("http://[2001:db8::20]:8096/jellyfin/Videos/a/stream.mp4",
                "http://[2001:0db8:0000:0000:0000:0000:0000:0020]:8096/jellyfin"));
        assertFalse(NativePlaybackRequest.validSource("http://[2001:db8::21]:8096/jellyfin/Videos/a/stream.mp4",
                "http://[2001:db8::20]:8096/jellyfin"));
    }

    @Test
    public void rejectsLogoutOldAccountsAndOversizedMessages() throws Exception
    {
        assertNull(NativePlaybackRequest.parse(request().toString(), bootstrap().put("session", JSONObject.NULL)));
        assertNull(NativePlaybackRequest.parse(request().put("generation", 2).toString(), bootstrap()));
        assertNull(NativePlaybackRequest.parse("x".repeat(16385), bootstrap()));
    }

    @Test
    public void rejectsOtherOriginsLocalFilesAndPathsOutsideVideoApi() throws Exception
    {
        for (String url : new String[]{"file:///data/media/movie.mp4", "content://media/video/1",
                "https://other.example.invalid/jellyfin/Videos/a/stream.mp4",
                "http://media.example.invalid/jellyfin/Videos/a/stream.mp4",
                "https://media.example.invalid:444/jellyfin/Videos/a/stream.mp4",
                "https://user@media.example.invalid/jellyfin/Videos/a/stream.mp4",
                "https://media.example.invalid/jellyfin/System/Info",
                "https://media.example.invalid/jellyfin/Videos/%2e%2e/System/Info",
                "https://media.example.invalid/jellyfin/Videos/%252e%252e/System/Info"})
            assertNull(NativePlaybackRequest.parse(request().put("url", url).toString(), bootstrap()));
    }

    @Test
    public void rejectsUnboundedSeeksTracksTokensAndUnknownOperations() throws Exception
    {
        assertNull(NativePlaybackRequest.parse(request().put("position", -1).toString(), bootstrap()));
        assertNull(NativePlaybackRequest.parse(request().put("position", 604801).toString(), bootstrap()));
        assertNull(NativePlaybackRequest.parse(request().put("audioOrdinal", 128).toString(), bootstrap()));
        assertNull(NativePlaybackRequest.parse(request().put("token", "bad'").toString(), bootstrap()));
        assertNull(NativePlaybackRequest.parse(request().put("operation", "loadFile").toString(), bootstrap()));
    }
}
