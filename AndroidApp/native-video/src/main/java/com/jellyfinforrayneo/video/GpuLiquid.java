package com.jellyfinforrayneo.video;

import android.content.Context;
import android.opengl.GLES31;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;

/** GL-only bounded 392 displacement solver. No CPU pixel loops or image readback. */
final class GpuLiquid implements AutoCloseable
{
    private final int[] textures = new int[3];
    private final int width;
    private final int height;
    private int program;
    private int output;
    private int phaseLocation;
    private final GpuTimer timer = new GpuTimer();
    private final ReadbackTimings completion = new ReadbackTimings("submit", "fenceObserved", "poll");
    private long fence;
    private long submittedAt;
    private long submitCost;

    GpuLiquid(Context context, int width, int height) throws Exception
    {
        this.width = width;
        this.height = height;
        try (InputStream input = context.getAssets().open(BuildConfig.LIQUID_FUSED_ROUNDS ? "gpu-liquid/field-fused.comp" : "gpu-liquid/field.comp"))
        {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int count;
            while ((count = input.read(chunk)) != -1) bytes.write(chunk, 0, count);
            int shader = GLES31.glCreateShader(GLES31.GL_COMPUTE_SHADER);
            GLES31.glShaderSource(shader, bytes.toString("UTF-8"));
            GLES31.glCompileShader(shader);
            int[] status = new int[1];
            GLES31.glGetShaderiv(shader, GLES31.GL_COMPILE_STATUS, status, 0);
            if (status[0] == 0) throw new IllegalStateException("liquid shader");
            program = GLES31.glCreateProgram();
            GLES31.glAttachShader(program, shader);
            GLES31.glLinkProgram(program);
            GLES31.glDeleteShader(shader);
            GLES31.glGetProgramiv(program, GLES31.GL_LINK_STATUS, status, 0);
            if (status[0] == 0) throw new IllegalStateException("liquid program");
            phaseLocation = GLES31.glGetUniformLocation(program, "phase");
        }
        GLES31.glGenTextures(3, textures, 0);
        for (int texture : textures)
        {
            GLES31.glBindTexture(GLES31.GL_TEXTURE_2D, texture);
            GLES31.glTexStorage2D(GLES31.GL_TEXTURE_2D, 1, GLES31.GL_RGBA32F, width, height);
            GLES31.glTexParameteri(GLES31.GL_TEXTURE_2D, GLES31.GL_TEXTURE_MIN_FILTER, GLES31.GL_NEAREST);
            GLES31.glTexParameteri(GLES31.GL_TEXTURE_2D, GLES31.GL_TEXTURE_MAG_FILTER, GLES31.GL_NEAREST);
            GLES31.glTexParameteri(GLES31.GL_TEXTURE_2D, GLES31.GL_TEXTURE_WRAP_S, GLES31.GL_CLAMP_TO_EDGE);
            GLES31.glTexParameteri(GLES31.GL_TEXTURE_2D, GLES31.GL_TEXTURE_WRAP_T, GLES31.GL_CLAMP_TO_EDGE);
        }
        timer.create();
    }

    void compute(int depthTexture)
    {
        poll();
        boolean measure = fence == 0;
        long start = System.nanoTime();
        timer.begin();
        GLES31.glUseProgram(program);
        GLES31.glActiveTexture(GLES31.GL_TEXTURE0);
        GLES31.glBindTexture(GLES31.GL_TEXTURE_2D, depthTexture);
        int step = BuildConfig.LIQUID_FUSED_ROUNDS ? 2 : 1;
        int previous = textures[0];
        for (int phase = 0; phase <= 8; phase += step)
        {
            int destination = phase == 0 ? textures[0] : textures[1 + (phase / step - 1) % 2];
            GLES31.glActiveTexture(GLES31.GL_TEXTURE1);
            GLES31.glBindTexture(GLES31.GL_TEXTURE_2D, phase == 0 ? depthTexture : textures[0]);
            GLES31.glActiveTexture(GLES31.GL_TEXTURE2);
            GLES31.glBindTexture(GLES31.GL_TEXTURE_2D, phase == 0 ? depthTexture : previous);
            GLES31.glBindImageTexture(0, destination, 0, false, 0, GLES31.GL_WRITE_ONLY, GLES31.GL_RGBA32F);
            GLES31.glUniform1i(phaseLocation, phase);
            GLES31.glDispatchCompute((width + 7) / 8, (height + 7) / 8, 1);
            GLES31.glMemoryBarrier(GLES31.GL_SHADER_IMAGE_ACCESS_BARRIER_BIT | GLES31.GL_TEXTURE_FETCH_BARRIER_BIT);
            output = destination;
            previous = destination;
        }
        timer.end();
        if (measure)
        {
            fence = GLES31.glFenceSync(GLES31.GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
            if (fence == 0) throw new IllegalStateException("liquid fence");
            GLES31.glFlush();
            submittedAt = System.nanoTime();
            submitCost = submittedAt - start;
        }
    }

    void poll()
    {
        if (fence == 0) return;
        long start = System.nanoTime();
        int result = GLES31.glClientWaitSync(fence, 0, 0);
        if (result == GLES31.GL_TIMEOUT_EXPIRED) return;
        if (result == GLES31.GL_WAIT_FAILED) throw new IllegalStateException("liquid fence wait");
        GLES31.glDeleteSync(fence);
        fence = 0;
        completion.record(submitCost, start - submittedAt, System.nanoTime() - start);
    }

    boolean pending()
    {
        return fence != 0;
    }

    String completionJson()
    {
        return completion.json();
    }

    int texture()
    {
        return output;
    }

    String timingsJson()
    {
        return timer.json();
    }

    @Override
    public void close()
    {
        if (fence != 0) GLES31.glDeleteSync(fence);
        fence = 0;
        timer.close();
        GLES31.glDeleteTextures(3, textures, 0);
        GLES31.glDeleteProgram(program);
    }
}
