package com.jellyfinforrayneo.nativelab;

import android.app.Activity;
import android.opengl.GLES30;
import android.opengl.GLSurfaceView;
import android.os.Bundle;
import android.util.Log;
import com.jellyfinforrayneo.video.GpuTemporalDepth;
import com.jellyfinforrayneo.video.NativeVideoView;
import com.jellyfinforrayneo.video.TemporalDepth;
import java.nio.ByteBuffer;
import java.util.Arrays;
import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/** Synthetic CPU/GPU numerical check. Pixel readback is diagnostic-only, never the player path. */
public final class GpuDepthBenchmarkActivity extends Activity implements GLSurfaceView.Renderer
{
    private GLSurfaceView view;

    @Override
    public void onCreate(Bundle state)
    {
        super.onCreate(state);
        view = new GLSurfaceView(this);
        view.setEGLContextClientVersion(3);
        view.setRenderer(this);
        view.setRenderMode(GLSurfaceView.RENDERMODE_WHEN_DIRTY);
        setContentView(view);
    }

    @Override
    public void onSurfaceCreated(GL10 unused, EGLConfig config)
    {
        try
        {
            preprocessCheck();
            benchmark();
        }
        catch (Exception error)
        {
            // Only generated shader/test errors: no media, network or account data exists here.
            Log.e("GpuDepthBenchmark", "FAIL " + error.getMessage());
        }
    }

    private void preprocessCheck() throws Exception
    {
        int w = NativeVideoView.SAMPLE_WIDTH, h = NativeVideoView.SAMPLE_HEIGHT, n = w * h;
        int[] texture = new int[1];
        GLES30.glGenTextures(1, texture, 0);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texture[0]);
        GLES30.glTexStorage2D(GLES30.GL_TEXTURE_2D, 1, GLES30.GL_RGBA8, w, h);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_NEAREST);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_NEAREST);
        ByteBuffer rgba = ByteBuffer.allocateDirect(n * 4);
        for (int i = 0; i < n; i++)
            rgba.put((byte) i).put((byte) (i / w)).put((byte) (i * 37)).put((byte) 255);
        rgba.flip();
        GLES30.glTexSubImage2D(GLES30.GL_TEXTURE_2D, 0, 0, 0, w, h, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, rgba);
        ByteBuffer out = ByteBuffer.allocateDirect(n * 12).order(java.nio.ByteOrder.nativeOrder());
        try (com.jellyfinforrayneo.video.GpuPreprocessor gpu = new com.jellyfinforrayneo.video.GpuPreprocessor(w, h))
        {
            gpu.submit(texture[0]);
            GLES30.glFinish(); // Numerical test only.
            gpu.copyTo(out);
            float max = 0;
            float[] means = {.485f, .456f, .406f}, stds = {.229f, .224f, .225f};
            for (int c = 0; c < 3; c++)
                for (int i = 0; i < n; i++)
                {
                    float expected = ((rgba.get(i * 4 + c) & 255) / 255f - means[c]) / stds[c];
                    float actual = out.getFloat((c * n + i) * 4);
                    if (!Float.isFinite(actual)) throw new IllegalStateException("preprocess nonfinite");
                    max = Math.max(max, Math.abs(expected - actual));
                }
            if (max != 0f) throw new IllegalStateException("preprocess values/layout " + max);
            Log.i("GpuInputBenchmark", "{\"passed\":true,\"width\":" + w + ",\"height\":" + h
                    + ",\"values\":" + (n * 3) + ",\"maxAbsError\":" + max + "}");
        }
        if (BuildConfig.NATIVE_QNN)
        {
            try (com.jellyfinforrayneo.video.NativeDepthProcessor processor = LabDepthProcessor.create(this))
            {
                processor.prepare();
                float[] cpu = processor.process(rgba.duplicate(), 1).raw;
                float[] repeated = processor.process(rgba.duplicate(), 1).raw;
                float[] gpu = processor.processChw(out.duplicate(), 1).raw;
                if (cpu == null || gpu == null) throw new IllegalStateException("raw reference unavailable");
                float max = 0, repeatMax = 0;
                double squared = 0;
                for (int i = 0; i < n; i++)
                {
                    if (!Float.isFinite(cpu[i]) || !Float.isFinite(gpu[i])) throw new IllegalStateException("inference nonfinite");
                    repeatMax = Math.max(repeatMax, Math.abs(cpu[i] - repeated[i]));
                    float delta = Math.abs(repeated[i] - gpu[i]);
                    max = Math.max(max, delta);
                    squared += delta * delta;
                }
                Log.i("GpuInputBenchmark", "{\"npuInputComparison\":true,\"maxDepthError\":" + max
                        + ",\"cpuRepeatMaxError\":" + repeatMax + ",\"depthRmse\":" + Math.sqrt(squared / n) + "}");
            }
        }
        GLES30.glDeleteTextures(1, texture, 0);
        String extensions = GLES30.glGetString(GLES30.GL_EXTENSIONS);
        Log.i("GpuInputBenchmark", "{\"externalBuffer\":" + extensions.contains("GL_EXT_external_buffer")
                + ",\"memoryObjectFd\":" + extensions.contains("GL_EXT_memory_object_fd") + "}");
    }

    private void benchmark() throws Exception
    {
        int w = NativeVideoView.SAMPLE_WIDTH, h = NativeVideoView.SAMPLE_HEIGHT, n = w * h;
        int[] name = new int[1];
        GLES30.glGenTextures(1, name, 0);
        int rgbaTexture = name[0];
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, rgbaTexture);
        GLES30.glTexStorage2D(GLES30.GL_TEXTURE_2D, 1, GLES30.GL_RGBA8, w, h);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_NEAREST);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_NEAREST);
        GLES30.glGenFramebuffers(1, name, 0);
        int fbo = name[0];
        float[] raw = new float[n];
        byte[] rgba = new byte[n * 4];
        ByteBuffer rgbUpload = ByteBuffer.allocateDirect(n * 4), output = ByteBuffer.allocateDirect(n * 4);
        ByteBuffer overwritten = ByteBuffer.allocateDirect(n * 4);
        TemporalDepth cpu = new TemporalDepth();
        byte[] last = null;
        long[] cpuTimes = new long[70], wallTimes = new long[70];
        int measured = 0, maxError = 0, rejected = 0;
        long errors = 0, compared = 0;
        try (GpuTemporalDepth gpu = new GpuTemporalDepth(this, w, h))
        {
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo);
            GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0,
                    GLES30.GL_TEXTURE_2D, gpu.texture(), 0);
            if (GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER) != GLES30.GL_FRAMEBUFFER_COMPLETE)
                throw new IllegalStateException("benchmark framebuffer");
            for (int frame = 0; frame < 80; frame++)
            {
                boolean reset = frame == 0 || frame == 45;
                if (reset) cpu = new TemporalDepth();
                for (int i = 0; i < n; i++)
                {
                    int x = i % w, y = i / w;
                    raw[i] = -1.2f + .00013f * x + .0017f * y + (x < w / 2 + frame % 7 ? .3f : .8f)
                            + .008f * (float) Math.sin((i + frame) * .1);
                    for (int c = 0; c < 3; c++)
                        rgba[i * 4 + c] = (byte) ((x / 8 + y / 8 + c * 37 + frame % 5 + (frame >= 30 ? 130 : 0)) & 255);
                    rgba[i * 4 + 3] = (byte) 255;
                }
                if (frame == 0 || frame == 15) raw[n / 2] = Float.NaN;
                if (frame == 16) raw[0] = Float.POSITIVE_INFINITY;
                if (frame == 1 || frame == 17 || frame == 45) Arrays.fill(raw, .7f);
                if (frame >= 55) for (int i = 0; i < n; i++) raw[i] += 3.5f;
                if (frame == 60)
                    for (int i = 0; i < n; i++)
                        raw[i] = i < n / 20 ? -100f : i >= n * 19 / 20 ? 100f : (i % w) / (float) w;
                long cpuStart = System.nanoTime();
                byte[] reference;
                boolean invalid = false;
                try
                {
                    reference = cpu.update(raw, rgba);
                }
                catch (IllegalArgumentException expectedInvalid)
                {
                    reference = null;
                    invalid = true;
                }
                long cpuCost = System.nanoTime() - cpuStart;
                rgbUpload.clear(); rgbUpload.put(rgba).flip();
                GLES30.glActiveTexture(GLES30.GL_TEXTURE2);
                GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, rgbaTexture);
                GLES30.glTexSubImage2D(GLES30.GL_TEXTURE_2D, 0, 0, 0, w, h,
                        GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, rgbUpload);
                long gpuStart = System.nanoTime();
                gpu.submit(raw, rgbaTexture, reset);
                // Simulate the next capture reusing the source before GPU completion.
                // Correctness requires the private GPU snapshot, not the latest texture contents.
                if ((frame & 1) == 0)
                {
                    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, rgbaTexture);
                    overwritten.rewind();
                    GLES30.glTexSubImage2D(GLES30.GL_TEXTURE_2D, 0, 0, 0, w, h,
                            GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, overwritten);
                }
                GpuTemporalDepth.Result result;
                while ((result = gpu.poll()) == null)
                {
                    if (System.nanoTime() - gpuStart > 10_000_000_000L) throw new IllegalStateException("benchmark timeout");
                    Thread.sleep(1); // Benchmark only; the player uses nonblocking GL callbacks.
                }
                long gpuWall = System.nanoTime() - gpuStart;
                if (result.accepted != (reference != null)) throw new IllegalStateException("acceptance differs at " + frame);
                if (result.invalid != invalid) throw new IllegalStateException("invalid classification differs at " + frame);
                if (frame >= 10 && reference != null)
                {
                    cpuTimes[measured] = cpuCost; wallTimes[measured++] = gpuWall;
                }
                if (reference != null) last = reference;
                else rejected++;
                if (last != null)
                {
                    output.clear();
                    GLES30.glReadPixels(0, 0, w, h, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, output);
                    for (int i = 0; i < n; i++)
                    {
                        int difference = Math.abs((output.get(i * 4) & 255) - (last[i] & 255));
                        maxError = Math.max(maxError, difference); errors += difference; compared++;
                    }
                }
                if (GLES30.glGetError() != GLES30.GL_NO_ERROR) throw new IllegalStateException("benchmark GL error");
            }
            Arrays.sort(cpuTimes, 0, measured); Arrays.sort(wallTimes, 0, measured);
            Log.i("GpuDepthBenchmark", "{\"passed\":" + (maxError <= 1) + ",\"width\":" + w + ",\"height\":" + h
                    + ",\"frames\":80,\"rejected\":" + rejected + ",\"pixelsCompared\":" + compared
                    + ",\"sourceOverwriteCases\":40"
                    + ",\"maxR8Error\":" + maxError + ",\"meanR8Error\":" + (errors / (double) compared)
                    + ",\"cpuMedianMs\":" + cpuTimes[measured / 2] / 1e6
                    + ",\"gpuSubmitToObservedMedianMs\":" + wallTimes[measured / 2] / 1e6
                    + ",\"gpu\":" + gpu.timingsJson() + "}");
        }
        finally
        {
            GLES30.glDeleteTextures(1, new int[]{rgbaTexture}, 0);
            GLES30.glDeleteFramebuffers(1, new int[]{fbo}, 0);
        }
    }

    @Override
    public void onSurfaceChanged(GL10 unused, int width, int height)
    {
    }

    @Override
    public void onDrawFrame(GL10 unused)
    {
    }

    @Override
    protected void onPause()
    {
        view.onPause();
        super.onPause();
    }

    @Override
    protected void onResume()
    {
        super.onResume();
        view.onResume();
    }
}
