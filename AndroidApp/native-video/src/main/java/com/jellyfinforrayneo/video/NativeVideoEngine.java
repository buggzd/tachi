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
    private final FrameSlot slot = new FrameSlot();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ThreadPoolExecutor samples = new ThreadPoolExecutor(1, 1, 0,
            TimeUnit.SECONDS, new ArrayBlockingQueue<>(1));
    private final Listener listener;
    private final SampleConsumer consumer;
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
            main.postDelayed(this, 250);
        }
    };

    public NativeVideoEngine(Context context, Listener listener, SampleConsumer consumer)
    {
        requireMain();
        this.listener = listener;
        this.consumer = consumer;
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(context)
                .setEnableDecoderFallback(false)
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
        player = new ExoPlayer.Builder(context, renderers).build();
        player.setAudioAttributes(new androidx.media3.common.AudioAttributes.Builder()
                .setUsage(androidx.media3.common.C.USAGE_MEDIA)
                .setContentType(androidx.media3.common.C.AUDIO_CONTENT_TYPE_MOVIE).build(), true);
        player.setHandleAudioBecomingNoisy(true);
        view = new NativeVideoView(context, new NativeVideoView.Host()
        {
            @Override
            public void surfaceReady(Surface surface)
            {
                if (!closed) player.setVideoSurface(surface);
            }

            @Override
            public void sample(ByteBuffer bytes, long timestamp, long lease, long generation)
            {
                try
                {
                    samples.execute(() ->
                    {
                        try
                        {
                            if (!closed && slot.current(lease, generation))
                            {
                                consumer.consume(bytes, NativeVideoView.SAMPLE_WIDTH,
                                        NativeVideoView.SAMPLE_HEIGHT, timestamp);
                                sampleCount++;
                            }
                        }
                        catch (RuntimeException error)
                        {
                            main.post(() -> fail());
                        }
                        finally
                        {
                            slot.release(lease);
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
                fail();
            }
        }, slot);
        player.addListener(new Player.Listener()
        {
            @Override
            public void onVideoSizeChanged(VideoSize size)
            {
                if (size.height > 0) view.setVideoAspect(size.width * size.pixelWidthHeightRatio / size.height);
            }

            @Override
            public void onPlayerError(PlaybackException error)
            {
                fail(); // Never forward URL, headers, tokens or raw exception details to UI.
            }
        });
        main.post(tick);
    }

    public NativeVideoView view()
    {
        return view;
    }

    public void open(Uri uri)
    {
        requireMain();
        if (closed) return;
        String scheme = uri.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme) && !"content".equals(scheme))
        {
            throw new IllegalArgumentException("unsupported source");
        }
        view.invalidateFrames();
        view.suspendSampling(false);
        failed = false;
        sampleCount = 0;
        player.setMediaItem(MediaItem.fromUri(uri));
        player.prepare();
        player.play();
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

    private void fail()
    {
        if (closed) return;
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
        samples.shutdown();
    }

    private static void requireMain()
    {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("main thread required");
    }
}
