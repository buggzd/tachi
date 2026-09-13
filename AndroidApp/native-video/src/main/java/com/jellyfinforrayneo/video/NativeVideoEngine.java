package com.jellyfinforrayneo.video;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.Surface;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Main-thread player owner, one decoder Surface and one bounded diagnostic sample consumer. */
@androidx.media3.common.util.UnstableApi
public final class NativeVideoEngine implements AutoCloseable
{
    public interface Listener
    {
        void state(String status, long positionMs, long durationMs, long sampledFrames);
    }

    public interface SampleConsumer
    {
        /** Worker thread; buffer is read-only, top-row-first RGBA and cannot be retained. */
        void consume(ByteBuffer rgba, int width, int height, long textureTimestampNs);
    }

    private final ExoPlayer player;
    private final NativeVideoView view;
    private final FrameSlot slot = new FrameSlot(BuildConfig.CAPTURE_SLOTS);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ThreadPoolExecutor samples = new ThreadPoolExecutor(1, 1, 0,
            TimeUnit.SECONDS, new ArrayBlockingQueue<>(4)); // Up to two leased frames, explicit retry close/prepare, and ordered shutdown.
    private final Listener listener;
    private final SampleConsumer consumer;
    private NativeDepthProcessor depthProcessor;
    private boolean firstFrame;
    private int audioOrdinal = -1;
    private String videoDecoder = "";
    private int errorCode;
    private String errorStage = "none";
    private int httpStatus;
    private String errorKind = "none";
    private String errorComponent = "none";
    private long metricsAt;
    private org.json.JSONObject depthMetrics;
    private final ReadbackTimings schedulingTimings = new ReadbackTimings("queueWait", "captureToWorker", "workerService");
    private final ReadbackTimings depthTimings = new ReadbackTimings("preprocess", "inference", "stabilize");
    private volatile boolean depthReady;
    private volatile String depthState;
    private volatile long discardedDepth;
    private volatile int diagnosticDelayMs;
    private volatile boolean closed;
    private volatile long sampleCount;
    private boolean failed;
    private final Runnable tick = new Runnable()
    {
        @Override
        public void run()
        {
            if (closed) return;
            String status = failed ? "error" : player.getPlaybackState() == Player.STATE_BUFFERING
                    ? "buffering" : player.getPlaybackState() == Player.STATE_ENDED
                    ? "ended" : player.isPlaying() ? "playing" : "paused";
            listener.state(status, player.getCurrentPosition(), Math.max(0, player.getDuration()), sampleCount);
            main.postDelayed(this, 100);
        }
    };

    public NativeVideoEngine(Context context, Listener listener, SampleConsumer consumer)
    {
        this(context, listener, consumer, null);
    }

    public NativeVideoEngine(Context context, Listener listener, SampleConsumer consumer,
            NativeDepthProcessor initialDepthProcessor)
    {
        requireMain();
        this.listener = listener;
        this.consumer = consumer;
        this.depthProcessor = initialDepthProcessor;
        depthReady = depthProcessor == null;
        depthState = depthProcessor == null ? "disabled" : "initializing";
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(context)
                .setEnableDecoderFallback(true)
                .setMediaCodecSelector((mime, secure, tunnel) ->
                {
                    ArrayList<androidx.media3.exoplayer.mediacodec.MediaCodecInfo> result = new ArrayList<>();
                    for (androidx.media3.exoplayer.mediacodec.MediaCodecInfo codec
                            : MediaCodecUtil.getDecoderInfos(mime, secure, tunnel))
                    {
                        if (!mime.startsWith("video/") || codec.hardwareAccelerated) result.add(codec);
                    }
                    return result;
                });
        // libass/WebVTT in GlassesUI owns text. Disabling text tracks alone still lets Media3
        // eagerly parse embedded ASS while extracting the video, including unselected tracks.
        player = new ExoPlayer.Builder(context, renderers)
                .setMediaSourceFactory(new androidx.media3.exoplayer.source.DefaultMediaSourceFactory(context)
                        .setSubtitleParserFactory(androidx.media3.extractor.text.SubtitleParser.Factory.UNSUPPORTED))
                .build();
        player.setAudioAttributes(new androidx.media3.common.AudioAttributes.Builder()
                .setUsage(androidx.media3.common.C.USAGE_MEDIA)
                .setContentType(androidx.media3.common.C.AUDIO_CONTENT_TYPE_MOVIE).build(), true);
        player.setHandleAudioBecomingNoisy(true);
        player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                .setTrackTypeDisabled(androidx.media3.common.C.TRACK_TYPE_TEXT, true).build());
        player.addAnalyticsListener(new androidx.media3.exoplayer.analytics.AnalyticsListener()
        {
            @Override
            public void onVideoDecoderInitialized(EventTime event, String name, long at, long duration)
            {
                videoDecoder = name;
            }
        });
        view = new NativeVideoView(context, new NativeVideoView.Host()
        {
            @Override
            public void surfaceReady(Surface surface)
            {
                if (!closed) player.setVideoSurface(surface);
            }

            @Override
            public void sample(ByteBuffer bytes, long timestamp, long ptsUs, long capturedNs, long lease, long generation)
            {
                long queuedNs = System.nanoTime();
                try
                {
                    samples.execute(() ->
                    {
                        long workerStart = System.nanoTime();
                        boolean rendererOwnsLease = false;
                        try
                        {
                            if (!closed && slot.current(lease, generation))
                            {
                                if (!BuildConfig.GPU_PREPROCESS)
                                {
                                    consumer.consume(bytes.asReadOnlyBuffer(), NativeVideoView.SAMPLE_WIDTH,
                                            NativeVideoView.SAMPLE_HEIGHT, timestamp);
                                }
                                sampleCount++;
                                if (depthProcessor != null && depthReady)
                                {
                                    DepthResult result = BuildConfig.GPU_PREPROCESS
                                            ? depthProcessor.processChw(bytes, generation)
                                            : depthProcessor.process(bytes, generation);
                                    depthTimings.record(result.preprocessNs, result.inferenceNs, result.stabilizeNs);
                                    int delay = diagnosticDelayMs;
                                    if (delay > 0) Thread.sleep(delay);
                                    if (!closed && slot.current(lease, generation))
                                    {
                                        if (result.raw != null)
                                            rendererOwnsLease = view.offerRawDepth(result.raw, generation, capturedNs, lease, ptsUs);
                                        else if (result.map != null) view.offerDepth(result.map, generation, capturedNs, ptsUs);
                                    }
                                    else discardedDepth++;
                                }
                            }
                        }
                        catch (Exception | LinkageError error)
                        {
                            main.post(() ->
                            {
                                if (!closed && slot.generation() == generation) depthFailed();
                            });
                        }
                        finally
                        {
                            schedulingTimings.record(workerStart - queuedNs, workerStart - capturedNs, System.nanoTime() - workerStart);
                            if (!rendererOwnsLease) slot.release(lease);
                        }
                    });
                }
                catch (RuntimeException rejected)
                {
                    slot.release(lease);
                }
            }

            @Override
            public void failure()
            {
                fail("surface");
            }

            @Override
            public void depthFailure(long generation)
            {
                if (!closed && slot.generation() == generation) depthFailed();
            }
        }, slot);
        player.setVideoFrameMetadataListener((ptsUs, releaseNs, format, mediaFormat) -> view.decoderFrame(ptsUs, releaseNs));
        view.suspendSampling(!depthReady);
        player.addListener(new Player.Listener()
        {
            @Override
            public void onVideoSizeChanged(VideoSize size)
            {
                if (size.height > 0) view.setVideoAspect(size.width * size.pixelWidthHeightRatio / size.height);
            }

            @Override
            public void onRenderedFirstFrame()
            {
                firstFrame = true;
            }

            @Override
            public void onTracksChanged(androidx.media3.common.Tracks tracks)
            {
                selectAudio(tracks);
            }

            @Override
            public void onPlayerError(PlaybackException error)
            {
                errorCode = error.errorCode;
                errorKind = PlaybackFailure.kind(error);
                errorComponent = PlaybackFailure.component(error);
                Throwable cause = error;
                for (int i = 0; i < 16 && cause != null; i++, cause = cause.getCause())
                {
                    if (cause instanceof androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException)
                    {
                        httpStatus = ((androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException) cause).responseCode;
                        break;
                    }
                }
                fail("player"); // Never forward URL, headers, tokens or raw exception details to UI.
            }
        });
        if (depthProcessor != null) prepareDepth();
        main.post(tick);
    }

    private void prepareDepth()
    {
        depthState = "initializing";
        depthReady = false;
        view.suspendSampling(true);
        samples.execute(() ->
        {
            if (closed) return;
            try
            {
                depthProcessor.prepare();
                main.post(() ->
                {
                    if (closed) return;
                    depthReady = true;
                    depthState = "ready";
                    view.suspendSampling(failed);
                });
            }
            catch (Exception | LinkageError error)
            {
                main.post(this::depthFailed);
            }
        });
    }

    public void enableDepth(NativeDepthProcessor processor)
    {
        requireMain();
        if (closed || processor == null || (depthProcessor != null && !"error".equals(depthState))) return;
        NativeDepthProcessor previous = depthProcessor;
        if (previous != null)
        {
            samples.execute(() ->
            {
                try { previous.close(); }
                catch (Exception ignored) { /* Explicit retry; no raw diagnostics. */ }
            });
        }
        depthMetrics = null;
        depthProcessor = processor;
        prepareDepth();
    }

    public String depthState()
    {
        return depthState;
    }

    public String depthTimingsJson()
    {
        return "{\"state\":\"" + depthState + "\",\"discarded\":" + discardedDepth
                + ",\"diagnosticDelayMs\":" + diagnosticDelayMs + ",\"scheduling\":" + schedulingTimings.json()
                + ",\"worker\":" + depthTimings.json()
                + ",\"render\":" + view.depthStatusJson() + "}";
    }

    public void setDiagnosticDepthDelayMs(int delay)
    {
        requireMain();
        diagnosticDelayMs = Math.max(0, Math.min(500, delay));
    }

    private void depthFailed()
    {
        if (closed) return;
        depthReady = false;
        depthState = "error";
        view.suspendSampling(true); // Visible error, hold any valid map; never retry/fallback on a timer.
    }

    public NativeVideoView view()
    {
        return view;
    }

    public void open(Uri uri)
    {
        open(uri, 0, true, -1, false);
    }

    public void open(Uri uri, long positionMs, boolean play, int audioTrackOrdinal, boolean hls)
    {
        requireMain();
        if (closed) return;
        String scheme = uri.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme) && !"content".equals(scheme))
        {
            throw new IllegalArgumentException("unsupported source");
        }
        view.invalidateFrames();
        view.suspendSampling(!depthReady);
        failed = false;
        sampleCount = 0;
        firstFrame = false;
        errorCode = 0;
        errorStage = "none";
        httpStatus = 0;
        errorKind = "none";
        errorComponent = "none";
        videoDecoder = "";
        audioOrdinal = audioTrackOrdinal;
        player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                .clearOverridesOfType(androidx.media3.common.C.TRACK_TYPE_AUDIO).build());
        MediaItem.Builder item = new MediaItem.Builder().setUri(uri);
        if (hls) item.setMimeType(androidx.media3.common.MimeTypes.APPLICATION_M3U8);
        player.setMediaItem(item.build(), Math.max(0, positionMs));
        player.prepare();
        player.setPlayWhenReady(play);
    }

    private void selectAudio(androidx.media3.common.Tracks tracks)
    {
        if (audioOrdinal < 0) return;
        int ordinal = 0;
        for (androidx.media3.common.Tracks.Group group : tracks.getGroups())
        {
            if (group.getType() != androidx.media3.common.C.TRACK_TYPE_AUDIO) continue;
            for (int index = 0; index < group.length; index++, ordinal++)
            {
                if (ordinal != audioOrdinal) continue;
                if (!group.isTrackSupported(index)) { fail("audio_track"); return; }
                if (!group.isTrackSelected(index))
                    player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                            .setOverrideForType(new androidx.media3.common.TrackSelectionOverride(
                                    group.getMediaTrackGroup(), index)).build());
                return;
            }
        }
    }

    public org.json.JSONObject snapshot()
    {
        requireMain();
        org.json.JSONObject state = new org.json.JSONObject();
        try
        {
            state.put("position", player.getCurrentPosition() / 1000.0);
            state.put("duration", Math.max(0, player.getDuration()) / 1000.0);
            state.put("buffered", Math.max(0, player.getBufferedPosition()) / 1000.0);
            state.put("seekable", player.isCurrentMediaItemSeekable());
            state.put("firstFrame", firstFrame);
            state.put("errorCode", errorCode);
            state.put("errorStage", errorStage);
            state.put("httpStatus", httpStatus);
            state.put("errorKind", errorKind);
            state.put("errorComponent", errorComponent);
            state.put("decoder", videoDecoder);
            state.put("rate", player.getPlaybackParameters().speed);
            androidx.media3.common.Format video = player.getVideoFormat();
            androidx.media3.common.Format audio = player.getAudioFormat();
            if (video != null)
            {
                state.put("width", Math.max(0, video.width));
                state.put("height", Math.max(0, video.height));
                state.put("pixelRatio", video.pixelWidthHeightRatio);
                state.put("videoCodec", video.sampleMimeType);
                state.put("frameRate", video.frameRate);
            }
            if (audio != null)
            {
                state.put("audioCodec", audio.sampleMimeType);
                state.put("audioChannels", audio.channelCount);
                state.put("audioSampleRate", audio.sampleRate);
            }
            androidx.media3.exoplayer.DecoderCounters counters = player.getVideoDecoderCounters();
            if (counters != null)
            {
                counters.ensureUpdated();
                state.put("droppedFrames", counters.droppedBufferCount);
                state.put("decodedFrames", counters.renderedOutputBufferCount);
                state.put("skippedDecoderFrames", counters.skippedOutputBufferCount);
                state.put("maxConsecutiveDroppedFrames", counters.maxConsecutiveDroppedBufferCount);
            }
            long now = android.os.SystemClock.elapsedRealtime();
            if (depthMetrics == null || now - metricsAt >= 1000)
            {
                depthMetrics = new org.json.JSONObject(depthTimingsJson());
                depthMetrics.put("readback", new org.json.JSONObject(view.readbackTimingsJson()));
                metricsAt = now;
            }
            state.put("depth", depthMetrics);
        }
        catch (org.json.JSONException ignored) { /* Fixed schema, finite numeric values only. */ }
        return state;
    }

    public void setPlaying(boolean playing)
    {
        requireMain();
        if (!closed && !failed) player.setPlayWhenReady(playing);
    }

    public void seekTo(long targetMs)
    {
        requireMain();
        if (closed || failed || !player.isCurrentMediaItemSeekable()) return;
        view.invalidateFrames();
        long end = player.getDuration();
        player.seekTo(Math.max(0, end > 0 ? Math.min(targetMs, end) : targetMs));
    }

    public void togglePlayback()
    {
        requireMain();
        if (closed || failed) return;
        if (player.getPlayWhenReady()) player.pause(); else player.play();
    }

    public void seekBy(long deltaMs)
    {
        requireMain();
        if (closed || failed || !player.isCurrentMediaItemSeekable()) return;
        view.invalidateFrames();
        long end = player.getDuration();
        long target = Math.max(0, player.getCurrentPosition() + Math.max(-60000, Math.min(60000, deltaMs)));
        player.seekTo(end > 0 ? Math.min(target, end) : target);
    }

    private void fail(String stage)
    {
        if (closed) return;
        errorStage = stage;
        failed = true;
        view.suspendSampling(true);
        player.pause();
    }

    @Override
    public void close()
    {
        requireMain();
        if (closed) return;
        closed = true;
        main.removeCallbacks(tick);
        slot.invalidate();
        player.clearVideoSurface();
        player.release();
        view.close();
        if (depthProcessor != null)
        {
            samples.execute(() ->
            {
                try { depthProcessor.close(); }
                catch (Exception ignored) { /* Session already unavailable; no raw diagnostics. */ }
            });
        }
        samples.shutdown();
    }

    private static void requireMain()
    {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("main thread required");
    }
}
