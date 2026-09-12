package com.jellyfinforrayneo.video;

import android.content.Context;
import android.graphics.SurfaceTexture;
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
    public static final int SAMPLE_WIDTH = 266;
    public static final int SAMPLE_HEIGHT = 154;
    private static final int SAMPLE_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT * 4;

    interface Host
    {
        // Main thread. Consumer must detach the old decoder Surface before it is released.
        void surfaceReady(Surface surface);
        // GL thread. Bytes are tightly packed, top-row-first RGBA; valid until releaseSample.
        void sample(ByteBuffer bytes, long textureTimestampNs, long capturedNs, long lease, long generation);
        void failure();
    }

    private final Host host;
    private final FrameSlot slot;
    private final AtomicBoolean framePending = new AtomicBoolean();
    private final FloatBuffer quad = ByteBuffer.allocateDirect(8 * 4).order(ByteOrder.nativeOrder())
            .asFloatBuffer().put(new float[]{-1, -1, 1, -1, -1, 1, 1, 1});
    private final ByteBuffer sampleBytes = ByteBuffer.allocateDirect(SAMPLE_BYTES);
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
    private long pendingCapturedNs;
    private boolean hasImage;
    private boolean failed;
    private volatile boolean closed;
    private int width;
    private int height;
    private volatile float videoAspect = 16f / 9f;
    private volatile boolean stereoPreview;
    private volatile boolean sampling;
    private volatile boolean samplingSuspended;
    private final SampleCadence cadence = new SampleCadence();
    private final ReadbackTimings timings = new ReadbackTimings();
    private long pendingSubmitNs;
    private long pendingSubmitCostNs;
    private int depthTexture;
    private final ByteBuffer depthUpload = ByteBuffer.allocateDirect(SAMPLE_WIDTH * SAMPLE_HEIGHT);
    private final AtomicReference<DepthPacket> pendingDepth = new AtomicReference<>();
    private volatile long depthGeneration = -1;
    private volatile long depthCapturedNs;
    private volatile long depthUploads;
    private volatile boolean debugDepth;
    private volatile boolean render1080;
    private int stereoFbo;
    private int stereoTexture;
    private final GpuTimer gpuTimer = new GpuTimer();
    private final ReadbackTimings presentationTimings = new ReadbackTimings("captureToUpload", "upload", "drawSubmit");

    private static final class DepthPacket
    {
        final byte[] map;
        final long generation;
        final long capturedNs;

        DepthPacket(byte[] map, long generation, long capturedNs)
        {
            this.map = map;
            this.generation = generation;
            this.capturedNs = capturedNs;
        }
    }

    void offerDepth(byte[] map, long generation, long capturedNs)
    {
        if (!closed && generation == slot.generation())
        {
            pendingDepth.set(new DepthPacket(map, generation, capturedNs));
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
        return "{\"valid\":" + valid + ",\"uploads\":" + depthUploads
                + ",\"ageMs\":" + (valid ? (System.nanoTime() - depthCapturedNs) / 1_000_000 : -1)
                + ",\"stereo\":" + stereoPreview + ",\"debug\":" + debugDepth
                + ",\"eyeTargetWidth\":" + (render1080 ? 1920 : width / (stereoPreview ? 2 : 1))
                + ",\"gpuRender\":" + gpuTimer.json()
                + ",\"timings\":" + presentationTimings.json() + "}";
    }

    public String depthSummary()
    {
        return hasCurrentDepth() ? "Depth " + depthUploads + " · age "
                + (System.nanoTime() - depthCapturedNs) / 1_000_000 + " ms" : "Waiting for valid depth";
    }

    /** Numerical diagnostics only; no source addresses or image content. */
    public String readbackTimingsJson()
    {
        return timings.json();
    }

    NativeVideoView(Context context, Host host, FrameSlot slot)
    {
        super(context);
        this.host = host;
        this.slot = slot;
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

    public void setSampling(boolean enabled)
    {
        sampling = enabled;
        if (!enabled) slot.invalidate();
    }

    void suspendSampling(boolean suspended)
    {
        samplingSuspended = suspended;
        if (suspended) slot.invalidate();
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
        requestRender();
    }

    // The owning player must already have detached its video surface on the main thread.
    void close()
    {
        closed = true;
        sampling = false;
        slot.invalidate();
        pendingDepth.set(null);
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
            depthGeneration = -1;
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
            GLES30.glGenTextures(1, name, 0);
            sampleTexture = name[0];
            GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, sampleTexture);
            parameters(GLES30.GL_TEXTURE_2D);
            GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, SAMPLE_WIDTH,
                    SAMPLE_HEIGHT, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null);
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
            GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_R8, SAMPLE_WIDTH,
                    SAMPLE_HEIGHT, 0, GLES30.GL_RED, GLES30.GL_UNSIGNED_BYTE, null);
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
            gpuTimer.create();
        }
        catch (RuntimeException error)
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
            boolean fresh = framePending.getAndSet(false);
            if (fresh)
            {
                texture.updateTexImage();
                texture.getTransformMatrix(textureMatrix);
                hasImage = true;
            }
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
            GLES30.glViewport(0, 0, width, height);
            GLES30.glClearColor(0, 0, 0, 1);
            GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT);
            if (!hasImage || width <= 0 || height <= 0) return;
            DepthPacket packet = pendingDepth.getAndSet(null);
            long uploadCost = 0;
            long captureAge = 0;
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
                depthGeneration = packet.generation;
                depthUploads++;
                uploadCost = System.nanoTime() - start;
                captureAge = System.nanoTime() - packet.capturedNs;
            }
            long drawStart = System.nanoTime();
            gpuTimer.begin();
            if (render1080)
            {
                GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, stereoFbo);
                GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT);
            }
            int eyes = stereoPreview ? 2 : 1;
            for (int eye = 0; eye < eyes; eye++)
            {
                int eyeWidth = render1080 ? 1920 : width / eyes;
                int[] rect = VideoGeometry.contain(eyeWidth, render1080 ? 1080 : height, videoAspect);
                GLES30.glViewport(eye * eyeWidth + rect[0], rect[1], rect[2], rect[3]);
                draw(false, eyes == 2 && hasCurrentDepth() ? (eye == 0 ? 1 : -1) : 0, false);
                if (debugDepth && hasCurrentDepth())
                {
                    GLES30.glViewport(eye * eyeWidth + rect[0], rect[1], Math.max(1, rect[2] / 3),
                            Math.max(1, rect[3] / 3));
                    draw(false, 0, true);
                }
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
            if (uploadCost > 0) presentationTimings.record(captureAge, uploadCost, System.nanoTime() - drawStart);
            long now = System.nanoTime();
            if (fresh && sampling && !samplingSuspended && fence == 0 && cadence.due(now))
            {
                long lease = slot.acquire();
                if (lease != 0)
                {
                    pendingLease = lease;
                    pendingGeneration = slot.generationOf(lease);
                    pendingTimestamp = texture.getTimestamp();
                    pendingCapturedNs = now;
                    cadence.submitted(now);
                    long submitStart = System.nanoTime();
                    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo);
                    GLES30.glViewport(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
                    draw(true, 0, false); // Always sample the original image, never the warped output.
                    GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, pbo);
                    GLES30.glReadPixels(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT,
                            GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, 0);
                    GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, 0);
                    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
                    fence = GLES30.glFenceSync(GLES30.GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
                    if (fence == 0) throw new IllegalStateException();
                    GLES30.glFlush();
                    pendingSubmitNs = System.nanoTime();
                    pendingSubmitCostNs = pendingSubmitNs - submitStart;
                }
            }
            if (GLES30.glGetError() != GLES30.GL_NO_ERROR) throw new IllegalStateException();
            if (fence != 0) postOnAnimation(this::requestRender);
        }
        catch (RuntimeException error)
        {
            fail();
        }
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
        timings.record(pendingSubmitCostNs, observedNs, System.nanoTime() - copyStart);
        host.sample(sampleBytes.asReadOnlyBuffer(), pendingTimestamp, pendingCapturedNs, lease, pendingGeneration);
    }

    private void draw(boolean topRowFirst, float eye, boolean depthOnly)
    {
        GLES30.glUseProgram(program);
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0);
        GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oes);
        GLES30.glUniform1i(GLES30.glGetUniformLocation(program, "video"), 0);
        GLES30.glActiveTexture(GLES30.GL_TEXTURE1);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, depthTexture);
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
        post(host::failure);
    }

    private void releaseGl()
    {
        if (fence != 0) GLES30.glDeleteSync(fence);
        if (pendingLease != 0) slot.release(pendingLease);
        fence = 0;
        pendingLease = 0;
        if (texture != null) texture.release();
        if (surface != null) surface.release();
        gpuTimer.close();
        GLES30.glDeleteBuffers(1, new int[]{pbo}, 0);
        GLES30.glDeleteFramebuffers(2, new int[]{fbo, stereoFbo}, 0);
        GLES30.glDeleteTextures(4, new int[]{oes, sampleTexture, depthTexture, stereoTexture}, 0);
        GLES30.glDeleteProgram(program);
    }
}
