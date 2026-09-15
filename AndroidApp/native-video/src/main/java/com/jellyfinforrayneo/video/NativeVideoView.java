package com.jellyfinforrayneo.video;

import android.content.Context;
import android.graphics.SurfaceTexture;
import android.os.Handler;
import android.os.HandlerThread;
import android.opengl.GLES11Ext;
import android.opengl.GLES30;
import android.opengl.GLSurfaceView;
import android.view.Surface;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/** Owns the decoder texture. No WebView, bitmap, or CPU downscale is involved. */
public final class NativeVideoView extends GLSurfaceView implements GLSurfaceView.Renderer
{
    public static final int SAMPLE_WIDTH = BuildConfig.DEPTH_SAMPLE_WIDTH;
    public static final int SAMPLE_HEIGHT = BuildConfig.DEPTH_SAMPLE_HEIGHT;
    private static final int SAMPLE_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT * 4;

    interface Host
    {
        // Main thread. Consumer must detach the old decoder Surface before it is released.
        void surfaceReady(Surface surface);
        // GL thread. Top-row-first RGBA8 or normalized float CHW, selected by GPU_PREPROCESS; lease owns bytes.
        void sample(ByteBuffer bytes, long textureTimestampNs, long ptsUs, long capturedNs, long lease, long generation);
        void failure();
        void depthFailure(long generation);
    }

    // Timer only: all GLES work stays on the owning GLSurfaceView thread.
    private final HandlerThread pollThread;
    private final Handler pollHandler;
    private final ReadbackTimings pollTimings = new ReadbackTimings("pollWake", "pollGlQueue", "pollService");
    private final Host host;
    private final FrameSlot slot;
    private final FrameTimeline timeline = new FrameTimeline();
    private final DepthPtsMetrics ptsMetrics = new DepthPtsMetrics();
    private long videoPtsUs = FrameTimeline.UNKNOWN, depthPtsUs = FrameTimeline.UNKNOWN;
    private long lastVideoSequence, sequenceGeneration = -1;
    private volatile long uniqueVideoDraws, supersededVideoFrames;
    private final long[] pendingDrawVideoPts = new long[64];
    private int pendingDrawCount;

    void decoderFrame(long ptsUs, long releaseNs)
    {
        timeline.decoded(releaseNs, ptsUs, slot.generation());
    }

    private final AtomicBoolean framePending = new AtomicBoolean();
    private final FloatBuffer quad = ByteBuffer.allocateDirect(8 * 4).order(ByteOrder.nativeOrder())
            .asFloatBuffer().put(new float[]{-1, -1, 1, -1, -1, 1, 1, 1});
    private final ByteBuffer[] captureBytes = new ByteBuffer[BuildConfig.CAPTURE_SLOTS];
    private final int[] captureTextures = new int[BuildConfig.CAPTURE_SLOTS];
    private GpuPreprocessor preprocessor;
    private final float[] textureMatrix = new float[16];
    private volatile SurfaceTexture texture;
    private volatile Surface surface;
    private int program;
    private int oes;
    private int fbo;
    private int sampleTexture;
    private int pbo;
    private long fence;
    private long pendingLease;
    private long pendingGeneration;
    private long pendingTimestamp;
    private long pendingPtsUs;
    private long pendingCapturedNs;
    private boolean hasImage;
    private boolean failed;
    private volatile boolean closed;
    private int width;
    private int height;
    private volatile float videoAspect = 16f / 9f;
    private volatile boolean stereoPreview;
    private volatile float screenScale = 1f;
    private volatile float screenDisparity;
    private volatile boolean depthEnabled = true;
    private volatile boolean sampling;
    private volatile boolean samplingSuspended;
    private long deferredCaptureGeneration = -1;
    private long deferredCapturePts = FrameTimeline.UNKNOWN;
    private volatile long captureRetries;
    private volatile long captureRetrySubmissions;
    private volatile long captureCandidates;
    private volatile long captureCadenceSkips;
    private volatile long captureFenceSkips;
    private volatile long captureSlotSkips;
    private volatile long captureSubmissions;
    private final PairedSampleCadence pairedCadence = new PairedSampleCadence(BuildConfig.DEPTH_HZ);
    private final SampleCadence cadence = new SampleCadence(BuildConfig.DEPTH_HZ);
    private final ReadbackTimings timings = new ReadbackTimings();
    private long pendingSubmitNs;
    private long pendingSubmitCostNs;
    private int depthTexture;
    private final ByteBuffer depthUpload = ByteBuffer.allocateDirect(SAMPLE_WIDTH * SAMPLE_HEIGHT);
    private final AtomicReference<DepthPacket> pendingDepth = new AtomicReference<>();
    private final Object rawDepthLock = new Object();
    private final java.util.ArrayDeque<RawDepthPacket> pendingRawDepth = new java.util.ArrayDeque<>();
    private RawDepthPacket activeRawDepth;
    private volatile GpuTemporalDepth gpuStabilizer;
    private GpuLiquid liquid;
    private int liquidProgram;
    private final int[] pairedCaptures = new int[BuildConfig.CAPTURE_SLOTS];
    private int pairedVideo;
    private volatile long pairedGeneration = -1;
    private volatile long pairedPtsUs = FrameTimeline.UNKNOWN;
    private volatile long pairedVideoLagUs = -1;
    private volatile long pairedFrames;
    private long liquidComputedPair = -1;
    private long pairedReadyNs;
    private long lastMeasuredPair = -1;
    private final ReadbackTimings pairDrawTimings = new ReadbackTimings("pairReadyToDraw", "pairCaptureToDraw", "pairDrawSubmit");
    private int copyFbo;
    private long cachedPair = -1;
    private int cachedGeometry;
    private volatile long cachedPairDraws;
    private volatile long pairRenderUpdates;
    private long gpuHistoryGeneration = -1;
    private long gpuSubmitCost;
    private long gpuCompletedCost;
    private long gpuCompletedAge;
    private long gpuDrawSubmitCost;
    private boolean gpuPollScheduled;
    private long gpuObserverSerial;
    private long gpuSubmissionSerial;
    private volatile long depthGeneration = -1;
    private volatile long depthCapturedNs;
    private volatile long depthUploads;
    private volatile boolean debugDepth;
    private volatile boolean render1080 = BuildConfig.ALIGNED_LIQUID;
    private int stereoFbo;
    private int stereoTexture;
    private final GpuTimer gpuTimer = new GpuTimer();
    private final ReadbackTimings presentationTimings = new ReadbackTimings("captureToUpload", "upload", "drawSubmit");

    private static final class DepthPacket
    {
        final byte[] map;
        final long generation;
        final long capturedNs;
        final long ptsUs;

        DepthPacket(byte[] map, long generation, long capturedNs, long ptsUs)
        {
            this.map = map;
            this.generation = generation;
            this.capturedNs = capturedNs;
            this.ptsUs = ptsUs;
        }
    }

    private static final class RawDepthPacket
    {
        final float[] raw;
        final long generation;
        final long capturedNs;
        final long ptsUs;
        final long lease;

        RawDepthPacket(float[] raw, long generation, long capturedNs, long lease, long ptsUs)
        {
            this.raw = raw;
            this.generation = generation;
            this.capturedNs = capturedNs;
            this.ptsUs = ptsUs;
            this.lease = lease;
        }
    }

    /** Transfers the capture lease, preserving the exact RGB texture paired with this inference. */
    boolean offerRawDepth(float[] raw, long generation, long capturedNs, long lease, long ptsUs)
    {
        synchronized (rawDepthLock)
        {
            if (closed || !slot.current(lease, generation)) return false;
            if (pendingRawDepth.size() >= BuildConfig.CAPTURE_SLOTS) throw new IllegalStateException("raw depth queue");
            pendingRawDepth.addLast(new RawDepthPacket(raw, generation, capturedNs, lease, ptsUs));
        }
        requestRender();
        return true;
    }

    private void clearPendingRawDepth()
    {
        synchronized (rawDepthLock)
        {
            for (RawDepthPacket packet : pendingRawDepth) slot.release(packet.lease);
            pendingRawDepth.clear();
        }
    }

    void offerDepth(byte[] map, long generation, long capturedNs, long ptsUs)
    {
        if (!closed && generation == slot.generation())
        {
            pendingDepth.set(new DepthPacket(map, generation, capturedNs, ptsUs));
            requestRender();
        }
    }

    public void setDepthDebug(boolean enabled)
    {
        debugDepth = enabled;
        requestRender();
    }

    /** Must be set before attaching the view. Exercises full eye resolution even on the phone. */
    public void setRender1080PerEye(boolean enabled)
    {
        render1080 = enabled;
    }

    private boolean hasCurrentDepth()
    {
        return depthGeneration == slot.generation();
    }

    public String depthStatusJson()
    {
        boolean valid = hasCurrentDepth();
        GpuTemporalDepth stabilizer = gpuStabilizer;
        return "{\"valid\":" + valid + ",\"uploads\":" + depthUploads
                + ",\"ageMs\":" + (valid ? (System.nanoTime() - depthCapturedNs) / 1_000_000 : -1)
                + ",\"stereo\":" + stereoPreview + ",\"debug\":" + debugDepth
                + ",\"depthWidth\":" + SAMPLE_WIDTH + ",\"depthHeight\":" + SAMPLE_HEIGHT
                + ",\"eyeTargetWidth\":" + (render1080 ? 1920 : width / (stereoPreview ? 2 : 1))
                + ",\"videoDraws\":" + uniqueVideoDraws + ",\"supersededVideoFrames\":" + supersededVideoFrames
                + ",\"frameMapping\":" + timeline.json() + ",\"depthPts\":" + ptsMetrics.json()
                + ",\"gpuRender\":" + gpuTimer.json()
                + ",\"captureAdmission\":{\"candidates\":" + captureCandidates
                + ",\"cadenceSkips\":" + captureCadenceSkips
                + ",\"fenceSkips\":" + captureFenceSkips
                + ",\"slotSkips\":" + captureSlotSkips
                + ",\"submitted\":" + captureSubmissions
                + ",\"retryAttempts\":" + captureRetries
                + ",\"retrySubmitted\":" + captureRetrySubmissions + "}"
                + ",\"depthTargetHz\":" + BuildConfig.DEPTH_HZ
                + ",\"asyncCapturePoll\":" + BuildConfig.ASYNC_CAPTURE_POLL
                + ",\"gpuPreprocess\":" + BuildConfig.GPU_PREPROCESS
                + ",\"captureSlots\":" + BuildConfig.CAPTURE_SLOTS
                + ",\"pinnedDepthOutput\":" + BuildConfig.PINNED_DEPTH_OUTPUT
                + ",\"gpuStabilization\":" + BuildConfig.GPU_DEPTH_STABILIZATION
                + ",\"gpuStabilize\":" + (stabilizer == null ? "null" : stabilizer.timingsJson())
                + ",\"gpuStages\":" + (stabilizer == null ? "null" : stabilizer.stageTimingsJson())
                + ",\"alignedLiquid\":" + BuildConfig.ALIGNED_LIQUID
                + ",\"liquidStrength\":0.85,\"liquidFeatherPx\":96,\"liquidAmount\":0.65"
                + ",\"pairedFrames\":" + pairedFrames + ",\"pairedVideoLagUs\":" + pairedVideoLagUs
                + ",\"cachedPairDraws\":" + cachedPairDraws + ",\"pairRenderUpdates\":" + pairRenderUpdates
                + ",\"liquidFusedRounds\":" + BuildConfig.LIQUID_FUSED_ROUNDS
                + ",\"liquidCacheSamples\":" + BuildConfig.LIQUID_CACHE_SAMPLES
                + ",\"captureBeforeLiquid\":" + BuildConfig.CAPTURE_BEFORE_LIQUID
                + ",\"pairDrawTimings\":" + pairDrawTimings.json()
                + ",\"pairedPtsUs\":" + pairedPtsUs
                + ",\"gpuLiquidCompletion\":" + (liquid == null ? "null" : liquid.completionJson())
                + ",\"gpuLiquid\":" + (liquid == null ? "null" : liquid.timingsJson())
                + ",\"timings\":" + presentationTimings.json() + "}";
    }

    public long pairedPositionUs()
    {
        return BuildConfig.ALIGNED_LIQUID && stereoPreview && depthEnabled
                && pairedGeneration == slot.generation() ? pairedPtsUs : FrameTimeline.UNKNOWN;
    }

    public String depthSummary()
    {
        return hasCurrentDepth() ? "Depth " + depthUploads + " · age "
                + (System.nanoTime() - depthCapturedNs) / 1_000_000 + " ms" : "Waiting for valid depth";
    }

    /** Numerical diagnostics only; no source addresses or image content. */
    public String pollTimingsJson()
    {
        return pollTimings.json();
    }

    public String readbackTimingsJson()
    {
        return timings.json();
    }

    NativeVideoView(Context context, Host host, FrameSlot slot)
    {
        super(context);
        this.host = host;
        if (BuildConfig.GPU_POLL_OFF_MAIN)
        {
            pollThread = new HandlerThread("tachi-gpu-poll");
            pollThread.start();
            pollHandler = new Handler(pollThread.getLooper());
        }
        else
        {
            pollThread = null;
            pollHandler = new Handler(android.os.Looper.getMainLooper());
        }
        this.slot = slot;
        for (int i = 0; i < captureBytes.length; i++)
            captureBytes[i] = ByteBuffer.allocateDirect(SAMPLE_BYTES * (BuildConfig.GPU_PREPROCESS ? 3 : 1));
        quad.position(0);
        setEGLContextClientVersion(3);
        setPreserveEGLContextOnPause(true);
        setRenderer(this);
        setRenderMode(RENDERMODE_WHEN_DIRTY);
    }

    public void setStereoPreview(boolean enabled)
    {
        stereoPreview = enabled;
        requestRender();
    }

    /** Same transform as the transparent controls/subtitle layer, in final eye coordinates. */
    public void setScreenGeometry(float scale, float normalizedDisparity)
    {
        screenScale = Math.max(.5f, Math.min(1f, scale));
        screenDisparity = Math.max(0f, Math.min(.02f, normalizedDisparity));
        requestRender();
    }

    public void setDepthEnabled(boolean enabled)
    {
        depthEnabled = enabled;
        setSampling(enabled);
        requestRender();
    }

    public void setSampling(boolean enabled)
    {
        if (sampling == enabled) return;
        sampling = enabled;
        if (!enabled) slot.invalidate();
    }

    void suspendSampling(boolean suspended)
    {
        // Suspending work never expires an already valid map. Source/seek/close invalidate explicitly.
        samplingSuspended = suspended;
    }

    void setVideoAspect(float aspect)
    {
        if (Float.isFinite(aspect) && aspect > 0) videoAspect = aspect;
        requestRender();
    }

    void invalidateFrames()
    {
        slot.invalidate();
        pendingDepth.set(null);
        clearPendingRawDepth();
        requestRender();
    }

    // The owning player must already have detached its video surface on the main thread.
    void close()
    {
        closed = true;
        pollHandler.removeCallbacksAndMessages(null);
        if (pollThread != null) pollThread.quitSafely();
        sampling = false;
        slot.invalidate();
        pendingDepth.set(null);
        clearPendingRawDepth();
        queueEvent(this::releaseGl);
        requestRender();
    }

    @Override
    public void onSurfaceCreated(GL10 ignored, EGLConfig config)
    {
        if (closed) return;
        try
        {
            // Old GL names belong to the lost context. Never delete them in the new context.
            if (pendingLease != 0) slot.release(pendingLease);
            pendingLease = 0;
            fence = 0;
            slot.invalidate();
            pendingDepth.set(null);
            clearPendingRawDepth();
            if (activeRawDepth != null) slot.release(activeRawDepth.lease);
            activeRawDepth = null;
            preprocessor = null;
            gpuStabilizer = null; // The old GL names belonged to the lost context.
            liquid = null;
            pairedGeneration = -1;
            cachedPair = -1;
            java.util.Arrays.fill(pairedCaptures, 0);
            pairedVideo = copyFbo = liquidProgram = 0;
            gpuHistoryGeneration = -1;
            gpuObserverSerial++;
            gpuPollScheduled = false;
            depthGeneration = -1;
            depthPtsUs = FrameTimeline.UNKNOWN;
            pendingDrawCount = 0;
            Surface previousSurface = surface;
            SurfaceTexture previousTexture = texture;
            hasImage = false;
            framePending.set(false);
            failed = false;
            program = program();
            int[] name = new int[1];
            GLES30.glGenTextures(1, name, 0);
            oes = name[0];
            GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oes);
            parameters(GLES11Ext.GL_TEXTURE_EXTERNAL_OES);
            texture = new SurfaceTexture(oes);
            texture.setOnFrameAvailableListener(value ->
            {
                if (!closed && value == texture)
                {
                    framePending.set(true);
                    requestRender();
                }
            });
            surface = new Surface(texture);
            Surface next = surface;
            post(() ->
            {
                if (!closed && surface == next) host.surfaceReady(next);
                // Player attachment is changed above on the same main thread.
                if (previousSurface != null) previousSurface.release();
                if (previousTexture != null) previousTexture.release();
            });
            GLES30.glGenTextures(captureTextures.length, captureTextures, 0);
            for (int captureTexture : captureTextures)
            {
                GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, captureTexture);
                parameters(GLES30.GL_TEXTURE_2D);
                GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, SAMPLE_WIDTH,
                        SAMPLE_HEIGHT, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null);
            }
            sampleTexture = captureTextures[0];
            GLES30.glGenFramebuffers(1, name, 0);
            fbo = name[0];
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo);
            GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0,
                    GLES30.GL_TEXTURE_2D, sampleTexture, 0);
            if (GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER) != GLES30.GL_FRAMEBUFFER_COMPLETE)
            {
                throw new IllegalStateException();
            }
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
            GLES30.glGenBuffers(1, name, 0);
            pbo = name[0];
            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, pbo);
            GLES30.glBufferData(GLES30.GL_PIXEL_PACK_BUFFER, SAMPLE_BYTES, null, GLES30.GL_STREAM_READ);
            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, 0);
            GLES30.glGenTextures(1, name, 0);
            depthTexture = name[0];
            GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, depthTexture);
            parameters(GLES30.GL_TEXTURE_2D);
            GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1);
            GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, BuildConfig.ALIGNED_LIQUID ? GLES30.GL_RGBA8 : GLES30.GL_R8, SAMPLE_WIDTH,
                    SAMPLE_HEIGHT, 0, BuildConfig.ALIGNED_LIQUID ? GLES30.GL_RGBA : GLES30.GL_RED, GLES30.GL_UNSIGNED_BYTE, null);
            stereoFbo = 0;
            stereoTexture = 0;
            if (render1080)
            {
                GLES30.glGenTextures(1, name, 0);
                stereoTexture = name[0];
                GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, stereoTexture);
                parameters(GLES30.GL_TEXTURE_2D);
                GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, 3840, 1080,
                        0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null);
                GLES30.glGenFramebuffers(1, name, 0);
                stereoFbo = name[0];
                GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, stereoFbo);
                GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0,
                        GLES30.GL_TEXTURE_2D, stereoTexture, 0);
                if (GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER) != GLES30.GL_FRAMEBUFFER_COMPLETE)
                    throw new IllegalStateException();
                GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
            }
            if (BuildConfig.GPU_PREPROCESS) preprocessor = new GpuPreprocessor(SAMPLE_WIDTH, SAMPLE_HEIGHT);
            gpuTimer.create();
            if (BuildConfig.GPU_DEPTH_STABILIZATION)
                gpuStabilizer = new GpuTemporalDepth(getContext(), SAMPLE_WIDTH, SAMPLE_HEIGHT);
            if (BuildConfig.ALIGNED_LIQUID)
            {
                liquid = new GpuLiquid(getContext(), SAMPLE_WIDTH, SAMPLE_HEIGHT);
                liquidProgram = liquidProgram();
                GLES30.glGenTextures(pairedCaptures.length, pairedCaptures, 0);
                for (int id : pairedCaptures) allocatePairTexture(id);
                GLES30.glGenTextures(1, name, 0);
                pairedVideo = name[0];
                allocatePairTexture(pairedVideo);
                GLES30.glGenFramebuffers(1, name, 0);
                copyFbo = name[0];
            }
        }
        catch (Exception error)
        {
            fail();
        }
    }

    @Override
    public void onSurfaceChanged(GL10 ignored, int width, int height)
    {
        this.width = width;
        this.height = height;
    }

    @Override
    public void onDrawFrame(GL10 ignored)
    {
        if (closed || failed) return;
        try
        {
            pollSample();
            processGpuDepth();
            boolean fresh = framePending.getAndSet(false);
            if (fresh)
            {
                texture.updateTexImage();
                texture.getTransformMatrix(textureMatrix);
                long visit = slot.generation();
                FrameTimeline.Match match = timeline.match(texture.getTimestamp(), visit);
                videoPtsUs = match == null ? FrameTimeline.UNKNOWN : match.ptsUs;
                if (match != null)
                {
                    if (sequenceGeneration == visit && lastVideoSequence > 0 && match.sequence > lastVideoSequence)
                        supersededVideoFrames += Math.max(0, match.sequence - lastVideoSequence - 1);
                    lastVideoSequence = match.sequence;
                    sequenceGeneration = visit;
                }
                hasImage = true;
            }
            if (BuildConfig.ALIGNED_LIQUID) captureCurrentFrame(fresh);
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
            GLES30.glViewport(0, 0, width, height);
            GLES30.glClearColor(0, 0, 0, 1);
            GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT);
            if (!hasImage || width <= 0 || height <= 0) return;
            DepthPacket packet = pendingDepth.getAndSet(null);
            long uploadCost = gpuCompletedCost;
            long captureAge = gpuCompletedAge;
            if (packet != null && packet.generation == slot.generation())
            {
                long start = System.nanoTime();
                depthUpload.clear();
                depthUpload.put(packet.map).flip();
                GLES30.glActiveTexture(GLES30.GL_TEXTURE1);
                GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, depthTexture);
                GLES30.glTexSubImage2D(GLES30.GL_TEXTURE_2D, 0, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT,
                        GLES30.GL_RED, GLES30.GL_UNSIGNED_BYTE, depthUpload);
                depthCapturedNs = packet.capturedNs;
                depthPtsUs = packet.ptsUs;
                depthGeneration = packet.generation;
                depthUploads++;
                uploadCost = System.nanoTime() - start;
                captureAge = System.nanoTime() - packet.capturedNs;
            }
            if (fresh) uniqueVideoDraws++;
            if (stereoPreview && depthEnabled && hasCurrentDepth())
            {
                if (BuildConfig.ALIGNED_LIQUID)
                {
                    if (pairedGeneration == slot.generation()) ptsMetrics.record(pairedPtsUs, depthPtsUs);
                    pairedVideoLagUs = videoPtsUs == FrameTimeline.UNKNOWN || pairedPtsUs == FrameTimeline.UNKNOWN
                            ? -1 : videoPtsUs - pairedPtsUs;
                }
                else if (activeRawDepth == null) ptsMetrics.record(videoPtsUs, depthPtsUs);
                else if (pendingDrawCount < pendingDrawVideoPts.length) pendingDrawVideoPts[pendingDrawCount++] = videoPtsUs;
                else ptsMetrics.record(videoPtsUs, FrameTimeline.UNKNOWN);
            }
            // Capture has already inserted its input fence. Queue the current pair's
            // liquid field afterwards, allowing input completion before this compute.
            submitPairLiquid();
            long drawStart = System.nanoTime();
            gpuTimer.begin();
            int geometry = java.util.Objects.hash(stereoPreview, depthEnabled, debugDepth,
                    screenScale, screenDisparity, videoAspect, width, height);
            boolean reusable = BuildConfig.ALIGNED_LIQUID && render1080 && stereoPreview && depthEnabled
                    && pairedGeneration == slot.generation() && cachedPair == pairedFrames && cachedGeometry == geometry;
            boolean firstPairDraw = BuildConfig.ALIGNED_LIQUID && pairedGeneration == slot.generation()
                    && stereoPreview && depthEnabled && lastMeasuredPair != pairedFrames;
            if (render1080)
            {
                GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, stereoFbo);
                if (!reusable) GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT);
            }
            int eyes = stereoPreview ? 2 : 1;
            for (int eye = 0; !reusable && eye < eyes; eye++)
            {
                int eyeWidth = render1080 ? 1920 : width / eyes;
                int eyeHeight = render1080 ? 1080 : height;
                int[] rect = VideoGeometry.contain(eyeWidth, eyeHeight, videoAspect);
                float scale = eyes == 2 ? screenScale : 1f;
                float offset = eyes == 2 ? (eye == 0 ? 1 : -1) * screenDisparity * eyeWidth * .5f : 0f;
                rect[0] = Math.round((1f - scale) * eyeWidth * .5f + offset + rect[0] * scale);
                rect[1] = Math.round((1f - scale) * eyeHeight * .5f + rect[1] * scale);
                rect[2] = Math.max(1, Math.round(rect[2] * scale));
                rect[3] = Math.max(1, Math.round(rect[3] * scale));
                GLES30.glViewport(eye * eyeWidth + rect[0], rect[1], rect[2], rect[3]);
                if (BuildConfig.ALIGNED_LIQUID && eyes == 2 && depthEnabled)
                {
                    if (pairedGeneration == slot.generation()) drawPair(eye == 0 ? 1 : -1, false);
                    // Before the first pair, keep black rather than exposing unmatched RGB/depth.
                }
                else draw(false, eyes == 2 && depthEnabled && hasCurrentDepth() ? (eye == 0 ? 1 : -1) : 0, false);
                if (debugDepth && hasCurrentDepth())
                {
                    GLES30.glViewport(eye * eyeWidth + rect[0], rect[1], Math.max(1, rect[2] / 3),
                            Math.max(1, rect[3] / 3));
                    if (BuildConfig.ALIGNED_LIQUID) drawPair(0, true);
                    else draw(false, 0, true);
                }
            }
            if (reusable) cachedPairDraws++;
            else
            {
                cachedPair = BuildConfig.ALIGNED_LIQUID && stereoPreview && depthEnabled
                        && pairedGeneration == slot.generation() ? pairedFrames : -1;
                cachedGeometry = geometry;
                if (cachedPair >= 0) pairRenderUpdates++;
            }
            if (render1080)
            {
                GLES30.glBindFramebuffer(GLES30.GL_READ_FRAMEBUFFER, stereoFbo);
                GLES30.glBindFramebuffer(GLES30.GL_DRAW_FRAMEBUFFER, 0);
                for (int eye = 0; eye < eyes; eye++)
                {
                    int eyeWidth = width / eyes;
                    int[] rect = VideoGeometry.contain(eyeWidth, height, 16f / 9f);
                    int x = eye * eyeWidth + rect[0];
                    GLES30.glBlitFramebuffer(eye * 1920, 0, (eye + 1) * 1920, 1080,
                            x, rect[1], x + rect[2], rect[1] + rect[3], GLES30.GL_COLOR_BUFFER_BIT, GLES30.GL_LINEAR);
                }
                GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
            }
            gpuTimer.end();
            if (firstPairDraw)
            {
                pairDrawTimings.record(drawStart - pairedReadyNs, drawStart - depthCapturedNs,
                        System.nanoTime() - drawStart);
                lastMeasuredPair = pairedFrames;
            }
            if (activeRawDepth != null && gpuDrawSubmitCost == 0)
                gpuDrawSubmitCost = System.nanoTime() - drawStart;
            if (uploadCost > 0) presentationTimings.record(captureAge, uploadCost, System.nanoTime() - drawStart);
            if (!BuildConfig.ALIGNED_LIQUID) captureCurrentFrame(fresh);
            if (GLES30.glGetError() != GLES30.GL_NO_ERROR) throw new IllegalStateException();
            if (fence != 0)
            {
                if (BuildConfig.ASYNC_CAPTURE_POLL) scheduleGpuPoll();
                else postOnAnimation(this::requestRender);
            }
        }
        catch (RuntimeException error)
        {
            fail();
        }
    }

    private void captureCurrentFrame(boolean fresh)
    {
        long now = System.nanoTime();
        if (!sampling || samplingSuspended) return;
        if (!fresh && (!BuildConfig.ALIGNED_LIQUID || framePending.get()
                || deferredCaptureGeneration != slot.generation()
                || deferredCapturePts != videoPtsUs || videoPtsUs == FrameTimeline.UNKNOWN)) return;
        deferredCaptureGeneration = -1;
        if (fresh) captureCandidates++;
        else captureRetries++;
        boolean mediaCadence = BuildConfig.ALIGNED_LIQUID && videoPtsUs != FrameTimeline.UNKNOWN;
        if (!(mediaCadence ? pairedCadence.due(videoPtsUs, slot.generation()) : cadence.due(now)))
        {
            captureCadenceSkips++;
            return;
        }
        if (fence != 0)
        {
            if (fresh) captureFenceSkips++;
            deferCurrentCapture();
            return;
        }
        long lease = slot.acquire();
        if (lease == 0)
        {
            if (fresh) captureSlotSkips++;
            deferCurrentCapture();
            return;
        }
        captureSubmissions++;
        if (!fresh) captureRetrySubmissions++;
        pendingLease = lease;
        pendingGeneration = slot.generationOf(lease);
        pendingTimestamp = texture.getTimestamp();
        pendingPtsUs = videoPtsUs;
        pendingCapturedNs = now;
        if (mediaCadence) pairedCadence.submitted(videoPtsUs);
        else cadence.submitted(now);
        long submitStart = System.nanoTime();
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo);
        sampleTexture = captureTextures[slot.indexOf(lease)];
        GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0,
                GLES30.GL_TEXTURE_2D, sampleTexture, 0);
        if (BuildConfig.ALIGNED_LIQUID)
        {
            GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0,
                    GLES30.GL_TEXTURE_2D, pairedCaptures[slot.indexOf(lease)], 0);
            GLES30.glViewport(0, 0, 1920, 1080);
            draw(false, 0, false);
            GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0,
                    GLES30.GL_TEXTURE_2D, sampleTexture, 0);
        }
        GLES30.glViewport(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
        draw(true, 0, false); // Always sample the original image, never the warped output.
        if (preprocessor != null) preprocessor.submit(sampleTexture);
        else
        {
            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, pbo);
            GLES30.glReadPixels(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT,
                    GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, 0);
            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, 0);
        }
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
        fence = GLES30.glFenceSync(GLES30.GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (fence == 0) throw new IllegalStateException();
        GLES30.glFlush();
        pendingSubmitNs = System.nanoTime();
        pendingSubmitCostNs = pendingSubmitNs - submitStart;
    }

    private void deferCurrentCapture()
    {
        if (!BuildConfig.ALIGNED_LIQUID || videoPtsUs == FrameTimeline.UNKNOWN) return;
        deferredCaptureGeneration = slot.generation();
        deferredCapturePts = videoPtsUs;
    }

    private void pollSample()
    {
        if (fence == 0) return;
        int state = GLES30.glClientWaitSync(fence, 0, 0);
        if (state == GLES30.GL_TIMEOUT_EXPIRED) return;
        if (state == GLES30.GL_WAIT_FAILED) throw new IllegalStateException();
        long observedNs = System.nanoTime() - pendingSubmitNs;
        GLES30.glDeleteSync(fence);
        fence = 0;
        long lease = pendingLease;
        pendingLease = 0;
        if (!slot.current(lease, pendingGeneration))
        {
            slot.release(lease);
            return;
        }
        long copyStart = System.nanoTime();
        ByteBuffer sampleBytes = captureBytes[slot.indexOf(lease)];
        if (preprocessor != null)
        {
            try
            {
                preprocessor.copyTo(sampleBytes);
            }
            catch (RuntimeException error)
            {
                slot.release(lease);
                throw error;
            }
        }
        else
        {
            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, pbo);
            ByteBuffer mapped = (ByteBuffer) GLES30.glMapBufferRange(GLES30.GL_PIXEL_PACK_BUFFER,
                    0, SAMPLE_BYTES, GLES30.GL_MAP_READ_BIT);
            if (mapped == null)
            {
                slot.release(lease);
                throw new IllegalStateException();
            }
            sampleBytes.clear();
            mapped.limit(SAMPLE_BYTES);
            sampleBytes.put(mapped);
            boolean intact = GLES30.glUnmapBuffer(GLES30.GL_PIXEL_PACK_BUFFER);
            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, 0);
            if (!intact)
            {
                slot.release(lease);
                throw new IllegalStateException();
            }
            sampleBytes.flip();
        }
        timings.record(pendingSubmitCostNs, observedNs, System.nanoTime() - copyStart);
        host.sample(sampleBytes.asReadOnlyBuffer(), pendingTimestamp, pendingPtsUs, pendingCapturedNs, lease, pendingGeneration);
    }

    private void processGpuDepth()
    {
        if (liquid != null) liquid.poll();
        gpuCompletedCost = 0;
        gpuCompletedAge = 0;
        if (gpuStabilizer == null) return;
        if (activeRawDepth != null)
        {
            GpuTemporalDepth.Result result = gpuStabilizer.poll();
            if (result != null)
            {
                RawDepthPacket packet = activeRawDepth;
                activeRawDepth = null;
                // Draws submitted after this compute see its new texture only if it accepted the map.
                // Resolve their PTS retrospectively so fence-observer delay cannot mislabel the depth.
                if (!BuildConfig.ALIGNED_LIQUID && packet.generation == slot.generation())
                    for (int i = 0; i < pendingDrawCount; i++)
                        ptsMetrics.record(pendingDrawVideoPts[i], result.accepted ? packet.ptsUs : depthPtsUs);
                pendingDrawCount = 0;
                if (result.accepted && packet.generation == slot.generation()
                        && (!BuildConfig.ALIGNED_LIQUID || slot.current(packet.lease, packet.generation)))
                {
                    if (BuildConfig.ALIGNED_LIQUID)
                    {
                        // Swap ownership instead of copying another 1080p image. GL queue ordering
                        // completes prior draws before the old display texture can be overwritten.
                        int index = slot.indexOf(packet.lease);
                        int previousDisplay = pairedVideo;
                        pairedVideo = pairedCaptures[index];
                        pairedCaptures[index] = previousDisplay;
                        copyTexture(gpuStabilizer.texture(), depthTexture, SAMPLE_WIDTH, SAMPLE_HEIGHT);
                        if (!BuildConfig.CAPTURE_BEFORE_LIQUID) liquid.compute(depthTexture);
                        pairedPtsUs = packet.ptsUs;
                        pairedGeneration = packet.generation;
                        pairedFrames++;
                        pairedReadyNs = System.nanoTime();
                        if (!BuildConfig.CAPTURE_BEFORE_LIQUID) liquidComputedPair = pairedFrames;
                        requestRender();
                    }
                    depthCapturedNs = packet.capturedNs;
                    depthPtsUs = packet.ptsUs;
                    depthGeneration = packet.generation;
                    depthUploads++;
                    gpuCompletedCost = gpuSubmitCost;
                    gpuCompletedAge = System.nanoTime() - packet.capturedNs;
                }
                if (result.invalid && packet.generation == slot.generation())
                    post(() -> host.depthFailure(packet.generation));
                slot.release(packet.lease);
            }
        }
        if (activeRawDepth != null) return;
        RawDepthPacket packet;
        synchronized (rawDepthLock)
        {
            packet = pendingRawDepth.pollFirst();
        }
        if (packet == null) return;
        if (!slot.current(packet.lease, packet.generation))
        {
            slot.release(packet.lease);
            return;
        }
        activeRawDepth = packet;
        pendingDrawCount = 0;
        long start = System.nanoTime();
        // This lease still owns its capture texture, even while the other capture slot is occupied.
        gpuStabilizer.submit(packet.raw, captureTextures[slot.indexOf(packet.lease)], packet.generation != gpuHistoryGeneration);
        // submit queued an independent GPU RGB snapshot, so capture/NPU may now overlap compute.
        if (!BuildConfig.ALIGNED_LIQUID) slot.release(packet.lease);
        gpuSubmissionSerial++;
        gpuHistoryGeneration = packet.generation;
        gpuSubmitCost = System.nanoTime() - start;
        gpuDrawSubmitCost = 0;
        scheduleGpuPoll();
    }

    private void submitPairLiquid()
    {
        if (!BuildConfig.ALIGNED_LIQUID || pairedGeneration != slot.generation()
                || liquidComputedPair == pairedFrames) return;
        liquid.compute(depthTexture);
        liquidComputedPair = pairedFrames;
        scheduleGpuPoll();
    }

    /** Poll a tiny control fence without repeating a full SBS draw or waiting for the next vsync. */
    private void scheduleGpuPoll()
    {
        if (gpuPollScheduled || closed || (activeRawDepth == null && (!BuildConfig.ASYNC_CAPTURE_POLL || fence == 0)
                && (liquid == null || !liquid.pending()))) return;
        gpuPollScheduled = true;
        long observer = gpuObserverSerial;
        long scheduledNs = System.nanoTime();
        pollHandler.postDelayed(() ->
        {
            if (closed) return;
            long wakeNs = System.nanoTime();
            queueEvent(() ->
            {
                if (observer != gpuObserverSerial) return;
                gpuPollScheduled = false;
                if (closed || failed) return;
                long enteredNs = System.nanoTime();
                try
                {
                    if (BuildConfig.ASYNC_CAPTURE_POLL) pollSample();
                    boolean wasValid = hasCurrentDepth();
                    long submission = gpuSubmissionSerial;
                    long completedDrawCost = gpuDrawSubmitCost;
                    processGpuDepth();
                    // Retry only after a depth job completed and released its lease. The OES
                    // image is still latched; skip if a newer decoder frame awaits consumption.
                    if (gpuCompletedCost > 0) captureCurrentFrame(false);
                    // Capture's fence, when a retry succeeds, now precedes the field.
                    // Do not add a separate wait for the next draw to submit current output.
                    submitPairLiquid();
                    if (gpuCompletedCost > 0)
                    {
                        presentationTimings.record(gpuCompletedAge, gpuCompletedCost, completedDrawCost);
                        gpuCompletedCost = 0;
                        gpuCompletedAge = 0;
                        // Subsequent updates were already drawn after submit on the same GL queue.
                        // The first accepted map needs a draw to turn on depth/debug rendering.
                        if (!wasValid) requestRender();
                    }
                    // Paired output requests a draw only on acceptance above. Submitting its
                    // normalization job has no new visible pair and needs no cached SBS blit.
                    if (!BuildConfig.ALIGNED_LIQUID && gpuSubmissionSerial != submission) requestRender();
                    scheduleGpuPoll();
                }
                catch (RuntimeException error)
                {
                    fail();
                }
                finally
                {
                    // Wake includes the requested 2 ms. Queue measures Java scheduling,
                    // not GPU execution or an exact hardware completion timestamp.
                    pollTimings.record(wakeNs - scheduledNs, enteredNs - wakeNs,
                            System.nanoTime() - enteredNs);
                }
            });
        }, 2);
    }

    private static void allocatePairTexture(int texture)
    {
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texture);
        parameters(GLES30.GL_TEXTURE_2D);
        GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, 1920, 1080,
                0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null);
    }

    private void copyTexture(int source, int destination, int copyWidth, int copyHeight)
    {
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, copyFbo);
        GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0,
                GLES30.GL_TEXTURE_2D, source, 0);
        GLES30.glActiveTexture(GLES30.GL_TEXTURE3);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, destination);
        GLES30.glCopyTexSubImage2D(GLES30.GL_TEXTURE_2D, 0, 0, 0, 0, 0, copyWidth, copyHeight);
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
    }

    private void drawPair(float eye, boolean depthOnly)
    {
        GLES30.glUseProgram(liquidProgram);
        int[] images = {pairedVideo, depthTexture, liquid.texture()};
        String[] names = {"video", "depthMap", "liquidMap"};
        for (int i = 0; i < images.length; i++)
        {
            GLES30.glActiveTexture(GLES30.GL_TEXTURE0 + i);
            GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, images[i]);
            GLES30.glUniform1i(GLES30.glGetUniformLocation(liquidProgram, names[i]), i);
        }
        GLES30.glUniform1f(GLES30.glGetUniformLocation(liquidProgram, "eye"), eye);
        GLES30.glUniform1i(GLES30.glGetUniformLocation(liquidProgram, "depthOnly"), depthOnly ? 1 : 0);
        GLES30.glUniform1f(GLES30.glGetUniformLocation(liquidProgram, "flipY"), 0);
        int position = GLES30.glGetAttribLocation(liquidProgram, "position");
        GLES30.glEnableVertexAttribArray(position);
        quad.position(0);
        GLES30.glVertexAttribPointer(position, 2, GLES30.GL_FLOAT, false, 0, quad);
        GLES30.glDrawArrays(GLES30.GL_TRIANGLE_STRIP, 0, 4);
        GLES30.glDisableVertexAttribArray(position);
    }

    private int liquidProgram() throws Exception
    {
        String fragment;
        try (java.io.InputStream input = getContext().getAssets().open(BuildConfig.LIQUID_CACHE_SAMPLES ? "gpu-liquid/render-cached.frag" : "gpu-liquid/render.frag"))
        {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int count;
            while ((count = input.read(chunk)) != -1) bytes.write(chunk, 0, count);
            fragment = bytes.toString("UTF-8");
        }
        int vs = shader(GLES30.GL_VERTEX_SHADER, "#version 300 es\nin vec2 position;out vec2 uv;void main(){uv=(position+1.)*.5;gl_Position=vec4(position,0,1);}");
        int fs = shader(GLES30.GL_FRAGMENT_SHADER, fragment);
        int result = GLES30.glCreateProgram();
        GLES30.glAttachShader(result, vs);
        GLES30.glAttachShader(result, fs);
        GLES30.glLinkProgram(result);
        GLES30.glDeleteShader(vs);
        GLES30.glDeleteShader(fs);
        int[] status = new int[1];
        GLES30.glGetProgramiv(result, GLES30.GL_LINK_STATUS, status, 0);
        if (status[0] == 0) throw new IllegalStateException("liquid render");
        return result;
    }

    private void draw(boolean topRowFirst, float eye, boolean depthOnly)
    {
        GLES30.glUseProgram(program);
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0);
        GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oes);
        GLES30.glUniform1i(GLES30.glGetUniformLocation(program, "video"), 0);
        GLES30.glActiveTexture(GLES30.GL_TEXTURE1);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, gpuStabilizer == null ? depthTexture : gpuStabilizer.texture());
        GLES30.glUniform1i(GLES30.glGetUniformLocation(program, "depthMap"), 1);
        GLES30.glUniform1f(GLES30.glGetUniformLocation(program, "eye"), eye);
        GLES30.glUniform1i(GLES30.glGetUniformLocation(program, "depthOnly"), depthOnly ? 1 : 0);
        GLES30.glUniform1f(GLES30.glGetUniformLocation(program, "flipY"), topRowFirst ? 1 : 0);
        GLES30.glUniformMatrix4fv(GLES30.glGetUniformLocation(program, "texMatrix"), 1, false, textureMatrix, 0);
        int position = GLES30.glGetAttribLocation(program, "position");
        GLES30.glEnableVertexAttribArray(position);
        quad.position(0);
        GLES30.glVertexAttribPointer(position, 2, GLES30.GL_FLOAT, false, 0, quad);
        GLES30.glDrawArrays(GLES30.GL_TRIANGLE_STRIP, 0, 4);
        GLES30.glDisableVertexAttribArray(position);
    }

    private static void parameters(int target)
    {
        GLES30.glTexParameteri(target, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR);
        GLES30.glTexParameteri(target, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR);
        GLES30.glTexParameteri(target, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE);
        GLES30.glTexParameteri(target, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE);
    }

    private static int program()
    {
        String vertex = "#version 300 es\nin vec2 position; out vec2 uv; uniform float flipY;"
                + "void main(){ vec2 p=(position+1.0)*0.5; if(flipY>0.5)p.y=1.0-p.y;"
                + "uv=p; gl_Position=vec4(position,0,1);}";
        String fragment = "#version 300 es\n#extension GL_OES_EGL_image_external_essl3 : require\n"
                + "precision highp float; uniform samplerExternalOES video; uniform sampler2D depthMap;"
                + "uniform mat4 texMatrix; uniform float eye; uniform int depthOnly; in vec2 uv; out vec4 color;"
                + "float depthAt(vec2 p){return texture(depthMap,vec2(p.x,1.0-p.y)).r;}"
                + "void main(){if(depthOnly==1){color=vec4(vec3(depthAt(uv)),1);return;}"
                + "vec2 source=uv; if(eye!=0.0){float best=-1.0;float bestError=1e6;bool found=false;"
                + "for(int i=-16;i<=16;i++){vec2 q=uv+vec2(float(i)/1920.0,0);"
                + "if(q.x>=0.0 && q.x<=1.0){float d=depthAt(q);float error=abs(q.x+eye*(d-0.5)*0.016-uv.x);"
                + "if(error<0.75/1920.0){if(!found || d>best){source=q;best=d;found=true;}}"
                + "else if(!found && error<bestError){source=q;bestError=error;}}}}"
                + "color=texture(video,(texMatrix*vec4(source,0,1)).xy);}";
        int vs = shader(GLES30.GL_VERTEX_SHADER, vertex);
        int fs = shader(GLES30.GL_FRAGMENT_SHADER, fragment);
        int result = GLES30.glCreateProgram();
        GLES30.glAttachShader(result, vs);
        GLES30.glAttachShader(result, fs);
        GLES30.glLinkProgram(result);
        GLES30.glDeleteShader(vs);
        GLES30.glDeleteShader(fs);
        int[] status = new int[1];
        GLES30.glGetProgramiv(result, GLES30.GL_LINK_STATUS, status, 0);
        if (status[0] == 0) throw new IllegalStateException();
        return result;
    }

    private static int shader(int type, String source)
    {
        int shader = GLES30.glCreateShader(type);
        GLES30.glShaderSource(shader, source);
        GLES30.glCompileShader(shader);
        int[] status = new int[1];
        GLES30.glGetShaderiv(shader, GLES30.GL_COMPILE_STATUS, status, 0);
        if (status[0] == 0) throw new IllegalStateException();
        return shader;
    }

    private void fail()
    {
        failed = true;
        if (pendingLease != 0) slot.release(pendingLease);
        pendingLease = 0;
        clearPendingRawDepth();
        if (activeRawDepth != null) slot.release(activeRawDepth.lease);
        activeRawDepth = null;
        post(host::failure);
    }

    private void releaseGl()
    {
        gpuObserverSerial++;
        gpuPollScheduled = false;
        if (fence != 0) GLES30.glDeleteSync(fence);
        if (pendingLease != 0) slot.release(pendingLease);
        fence = 0;
        pendingLease = 0;
        clearPendingRawDepth();
        if (activeRawDepth != null) slot.release(activeRawDepth.lease);
        activeRawDepth = null;
        if (preprocessor != null) preprocessor.close();
        preprocessor = null;
        if (liquid != null) liquid.close();
        liquid = null;
        GLES30.glDeleteTextures(pairedCaptures.length, pairedCaptures, 0);
        GLES30.glDeleteTextures(1, new int[]{pairedVideo}, 0);
        GLES30.glDeleteFramebuffers(1, new int[]{copyFbo}, 0);
        GLES30.glDeleteProgram(liquidProgram);
        if (gpuStabilizer != null) gpuStabilizer.close();
        gpuStabilizer = null;
        if (texture != null) texture.release();
        if (surface != null) surface.release();
        gpuTimer.close();
        GLES30.glDeleteBuffers(1, new int[]{pbo}, 0);
        GLES30.glDeleteFramebuffers(2, new int[]{fbo, stereoFbo}, 0);
        GLES30.glDeleteTextures(captureTextures.length, captureTextures, 0);
        GLES30.glDeleteTextures(3, new int[]{oes, depthTexture, stereoTexture}, 0);
        GLES30.glDeleteProgram(program);
    }
}
