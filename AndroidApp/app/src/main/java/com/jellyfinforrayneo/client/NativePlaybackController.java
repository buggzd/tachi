package com.jellyfinforrayneo.client;

import android.content.Context;
import android.net.Uri;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import com.jellyfinforrayneo.video.NativeVideoEngine;
import com.jellyfinforrayneo.video.QnnDepthProcessor;
import org.json.JSONObject;

/** One native player below the transparent, stereo-mirrored browser controls. Main thread only. */
@androidx.media3.common.util.UnstableApi
final class NativePlaybackController implements AutoCloseable
{
    interface Host { void publish(JSONObject state); }
    private final Context context;
    private final Host host;
    private FrameLayout root;
    private NativeVideoEngine engine;
    private NativePlaybackRequest source;
    private boolean foreground = true;
    private long resumePosition;
    private String token;
    private int generation = -1;
    private int seekId;
    private boolean subtitleError;
    private boolean stereo;
    private boolean depth;
    private boolean debug;
    private boolean transitioning;
    private float scale = 1f;
    private float disparity;

    NativePlaybackController(Context context, FrameLayout root, Host host)
    {
        this.context = context;
        this.root = root;
        this.host = host;
    }

    void command(NativePlaybackRequest request)
    {
        if ("open".equals(request.operation))
        {
            close();
            token = request.token;
            generation = request.generation;
            source = request;
            resumePosition = request.positionMs;
            if (foreground) startEngine(request.positionMs, request.playing);
            return;
        }
        if (!request.token.equals(token) || generation != request.generation) return;
        if ("stop".equals(request.operation)) { close(); return; }
        if (engine == null) return;
        switch (request.operation)
        {
            case "stop": close(); break;
            case "subtitle": subtitleError = request.subtitleError; break;
            case "play": engine.setPlaying(true); break;
            case "pause": engine.setPlaying(false); publish("paused"); break;
            case "seek": seekId = request.seekId; engine.seekTo(request.positionMs); break;
            case "depth":
                if (request.depth && !depth && "error".equals(engine.depthState()) && RealtimeDepthBackend.available())
                    engine.enableDepth(QnnDepthProcessor.create(context, BuildConfig.REALTIME_MODEL_SHA256));
                depth = request.depth;
                debug = request.debug;
                applyGeometry();
                break;
            default: break;
        }
    }

    private void startEngine(long position, boolean playing)
    {
        try
        {
            engine = new NativeVideoEngine(context, (status, at, duration, frames) -> publish(status),
                    (bytes, width, height, timestamp) -> {});
            root.addView(engine.view(), 0, new FrameLayout.LayoutParams(-1, -1));
            applyGeometry();
            engine.open(Uri.parse(source.url), position, playing, source.audioOrdinal, source.hls);
        }
        catch (RuntimeException | LinkageError failure)
        {
            publish("error");
            close();
        }
    }

    void foreground(boolean active)
    {
        if (foreground == active) return;
        foreground = active;
        if (!active && engine != null)
        {
            resumePosition = Math.round(engine.snapshot().optDouble("position", 0) * 1000);
            engine.setPlaying(false);
            publish("paused");
            closeEngine();
        }
        else if (active && source != null) startEngine(resumePosition, false);
    }

    private void publish(String status)
    {
        try
        {
            JSONObject state = engine == null ? new JSONObject() : engine.snapshot();
            if (engine == null)
            {
                state.put("position", resumePosition / 1000.0);
                state.put("duration", 0);
            }
            state.put("token", token);
            state.put("generation", generation);
            state.put("status", status);
            state.put("seekId", seekId);
            state.put("hls", source != null && source.hls);
            state.put("subtitleKind", source == null ? "off" : source.subtitleKind);
            state.put("subtitleError", subtitleError);
            host.publish(state);
        }
        catch (org.json.JSONException ignored) { /* Fixed schema. */ }
    }

    void sessionChanged(int nextGeneration, boolean authenticated)
    {
        if (!authenticated || generation != nextGeneration) close();
    }

    void attachTo(FrameLayout next)
    {
        if (engine != null) root.removeView(engine.view());
        root = next;
        if (engine != null) root.addView(engine.view(), 0, new FrameLayout.LayoutParams(-1, -1));
    }

    void geometry(boolean stereo, boolean transitioning, float scale, float disparity)
    {
        this.stereo = stereo;
        this.transitioning = transitioning;
        this.scale = scale;
        this.disparity = disparity;
        applyGeometry();
    }

    private void applyGeometry()
    {
        if (engine == null) return;
        boolean activeDepth = depth && stereo && !transitioning && RealtimeDepthBackend.available();
        if (activeDepth && "disabled".equals(engine.depthState()))
            engine.enableDepth(QnnDepthProcessor.create(context, BuildConfig.REALTIME_MODEL_SHA256));
        engine.view().setStereoPreview(stereo);
        engine.view().setScreenGeometry(scale, disparity);
        engine.view().setDepthEnabled(activeDepth);
        engine.view().setDepthDebug(activeDepth && debug);
        engine.view().setVisibility(transitioning ? android.view.View.INVISIBLE : android.view.View.VISIBLE);
    }

    @Override
    public void close()
    {
        if (engine != null) publish("stopped");
        closeEngine();
        subtitleError = false;
        source = null;
        seekId = 0;
        token = null;
        generation = -1;
        depth = false;
        debug = false;
    }

    private void closeEngine()
    {
        if (engine != null)
        {
            engine.close();
            root.removeView(engine.view());
            engine = null;
        }
    }
}
