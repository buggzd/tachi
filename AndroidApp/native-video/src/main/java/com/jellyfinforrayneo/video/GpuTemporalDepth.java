package com.jellyfinforrayneo.video;

import android.content.Context;
import android.opengl.GLES30;
import android.opengl.GLES31;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;

/** GL-thread-only exact radix percentiles and temporal filtering. Requires GLES 3.1.
 * RGB texture rows must match the top-row-first raw depth. No image readback in submit/poll.
 */
public final class GpuTemporalDepth implements AutoCloseable
{
    private final int width;
    private final int height;
    private final int pixels;
    private final int[] buffers = new int[4];
    private final int[] programs = new int[4];
    private final FloatBuffer upload;
    private final GpuTimer timer = new GpuTimer();
    private final ReadbackTimings stages = new ReadbackTimings("submit", "completion", "statusRead");
    private long startedNs;
    private long submitNs;
    private int output;
    private int colorSnapshot;
    private int colorFramebuffer;
    private long fence;

    public static final class Result
    {
        public final boolean accepted;
        public final boolean invalid;
        public final float low;
        public final float high;

        Result(boolean accepted, boolean invalid, float low, float high)
        {
            this.accepted = accepted;
            this.invalid = invalid;
            this.low = low;
            this.high = high;
        }
    }

    public GpuTemporalDepth(Context context, int width, int height) throws Exception
    {
        this.width = width;
        this.height = height;
        pixels = Math.multiplyExact(width, height);
        if (width <= 0 || height <= 0 || pixels > 1_000_000) throw new IllegalArgumentException();
        int[] version = new int[1];
        GLES30.glGetIntegerv(GLES30.GL_MAJOR_VERSION, version, 0);
        int major = version[0];
        GLES30.glGetIntegerv(GLES30.GL_MINOR_VERSION, version, 0);
        if (major < 3 || (major == 3 && version[0] < 1)) throw new IllegalStateException("GLES 3.1 required");
        GLES31.glGetIntegerv(GLES31.GL_MAX_COMPUTE_WORK_GROUP_INVOCATIONS, version, 0);
        if (version[0] < 256) throw new IllegalStateException("256 compute invocations required");
        upload = ByteBuffer.allocateDirect(pixels * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        try
        {
            String common = "#version 310 es\n#define W " + width + "\n#define N " + pixels + "\n"
                    + asset(context, "common.glsl");
            String[] names = {"clear.comp", "histogram.comp", "select.comp", "filter.comp"};
            for (int i = 0; i < names.length; i++) programs[i] = compile(common + asset(context, names[i]));
            GLES31.glGenBuffers(4, buffers, 0);
            for (int i = 0; i < 4; i++)
            {
                GLES31.glBindBuffer(GLES31.GL_SHADER_STORAGE_BUFFER, buffers[i]);
                int size = i == 1 ? 528 * 4 : pixels * 4;
                GLES31.glBufferData(GLES31.GL_SHADER_STORAGE_BUFFER, size,
                        i == 1 ? ByteBuffer.allocateDirect(size) : null, GLES31.GL_DYNAMIC_DRAW);
            }
            int[] name = new int[1];
            GLES31.glGenTextures(1, name, 0);
            output = name[0];
            GLES31.glBindTexture(GLES31.GL_TEXTURE_2D, output);
            GLES31.glTexStorage2D(GLES31.GL_TEXTURE_2D, 1, GLES31.GL_RGBA8, width, height);
            GLES31.glTexParameteri(GLES31.GL_TEXTURE_2D, GLES31.GL_TEXTURE_MIN_FILTER, GLES31.GL_LINEAR);
            GLES31.glTexParameteri(GLES31.GL_TEXTURE_2D, GLES31.GL_TEXTURE_MAG_FILTER, GLES31.GL_LINEAR);
            GLES31.glTexParameteri(GLES31.GL_TEXTURE_2D, GLES31.GL_TEXTURE_WRAP_S, GLES31.GL_CLAMP_TO_EDGE);
            GLES31.glTexParameteri(GLES31.GL_TEXTURE_2D, GLES31.GL_TEXTURE_WRAP_T, GLES31.GL_CLAMP_TO_EDGE);
            GLES31.glGenTextures(1, name, 0);
            colorSnapshot = name[0];
            GLES31.glBindTexture(GLES31.GL_TEXTURE_2D, colorSnapshot);
            GLES31.glTexStorage2D(GLES31.GL_TEXTURE_2D, 1, GLES31.GL_RGBA8, width, height);
            GLES31.glTexParameteri(GLES31.GL_TEXTURE_2D, GLES31.GL_TEXTURE_MIN_FILTER, GLES31.GL_NEAREST);
            GLES31.glTexParameteri(GLES31.GL_TEXTURE_2D, GLES31.GL_TEXTURE_MAG_FILTER, GLES31.GL_NEAREST);
            GLES31.glGenFramebuffers(1, name, 0);
            colorFramebuffer = name[0];
            timer.create();
            check();
        }
        catch (Exception error)
        {
            close();
            throw error;
        }
    }

    public int texture()
    {
        return output;
    }

    public String timingsJson()
    {
        return timer.json();
    }

    public String stageTimingsJson()
    {
        return stages.json();
    }

    public void submit(float[] raw, int rgbaTexture, boolean reset)
    {
        if (raw.length != pixels || fence != 0) throw new IllegalStateException("GPU depth slot");
        startedNs = System.nanoTime();
        upload.clear();
        upload.put(raw).flip();
        GLES31.glBindBuffer(GLES31.GL_SHADER_STORAGE_BUFFER, buffers[0]);
        GLES31.glBufferSubData(GLES31.GL_SHADER_STORAGE_BUFFER, 0, pixels * 4, upload);
        for (int i = 0; i < 4; i++) GLES31.glBindBufferBase(GLES31.GL_SHADER_STORAGE_BUFFER, i, buffers[i]);
        // GPU-only snapshot. The caller may reuse its capture texture after this submission;
        // our single in-flight compute job keeps this private copy until its fence completes.
        int[] previousFramebuffer = new int[1];
        GLES31.glGetIntegerv(GLES31.GL_READ_FRAMEBUFFER_BINDING, previousFramebuffer, 0);
        GLES31.glBindFramebuffer(GLES31.GL_READ_FRAMEBUFFER, colorFramebuffer);
        GLES31.glFramebufferTexture2D(GLES31.GL_READ_FRAMEBUFFER, GLES31.GL_COLOR_ATTACHMENT0,
                GLES31.GL_TEXTURE_2D, rgbaTexture, 0);
        GLES31.glActiveTexture(GLES31.GL_TEXTURE2);
        GLES31.glBindTexture(GLES31.GL_TEXTURE_2D, colorSnapshot);
        GLES31.glCopyTexSubImage2D(GLES31.GL_TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
        GLES31.glBindFramebuffer(GLES31.GL_READ_FRAMEBUFFER, previousFramebuffer[0]);
        GLES31.glBindImageTexture(0, output, 0, false, 0, GLES31.GL_WRITE_ONLY, GLES31.GL_RGBA8);
        timer.begin();
        for (int shift = 24; shift >= 0; shift -= 8)
        {
            GLES31.glUseProgram(programs[0]);
            GLES31.glUniform1i(GLES31.glGetUniformLocation(programs[0], "shift"), shift);
            GLES31.glUniform1i(GLES31.glGetUniformLocation(programs[0], "resetHistory"), reset ? 1 : 0);
            dispatch(2);
            GLES31.glUseProgram(programs[1]);
            GLES31.glUniform1i(GLES31.glGetUniformLocation(programs[1], "shift"), shift);
            dispatch((pixels + 255) / 256);
            GLES31.glUseProgram(programs[2]);
            GLES31.glUniform1i(GLES31.glGetUniformLocation(programs[2], "shift"), shift);
            dispatch(1);
        }
        GLES31.glUseProgram(programs[3]);
        dispatch((pixels + 255) / 256);
        GLES31.glMemoryBarrier(GLES31.GL_TEXTURE_FETCH_BARRIER_BIT | GLES31.GL_SHADER_IMAGE_ACCESS_BARRIER_BIT
                | GLES31.GL_BUFFER_UPDATE_BARRIER_BIT | GLES31.GL_FRAMEBUFFER_BARRIER_BIT);
        timer.end();
        fence = GLES31.glFenceSync(GLES31.GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (fence == 0) throw new IllegalStateException("GPU depth fence");
        GLES31.glFlush();
        check();
        submitNs = System.nanoTime() - startedNs;
    }

    /** Nonblocking completion; reads only 44 bytes of control data, never depth pixels. */
    public Result poll()
    {
        if (fence == 0) return null;
        int status = GLES31.glClientWaitSync(fence, 0, 0);
        if (status == GLES31.GL_TIMEOUT_EXPIRED) return null;
        if (status == GLES31.GL_WAIT_FAILED) throw new IllegalStateException("GPU depth wait");
        long readStart = System.nanoTime();
        GLES31.glDeleteSync(fence);
        fence = 0;
        GLES31.glBindBuffer(GLES31.GL_SHADER_STORAGE_BUFFER, buffers[1]);
        ByteBuffer data = (ByteBuffer) GLES31.glMapBufferRange(GLES31.GL_SHADER_STORAGE_BUFFER,
                512 * 4, 11 * 4, GLES31.GL_MAP_READ_BIT);
        if (data == null) throw new IllegalStateException("GPU depth status");
        data.order(ByteOrder.nativeOrder());
        Result result = new Result(data.getInt(7 * 4) != 0, data.getInt(4 * 4) != 0,
                data.getFloat(9 * 4), data.getFloat(10 * 4));
        boolean intact = GLES31.glUnmapBuffer(GLES31.GL_SHADER_STORAGE_BUFFER);
        if (!intact) throw new IllegalStateException("GPU depth status lost");
        check();
        stages.record(submitNs, System.nanoTime() - startedNs, System.nanoTime() - readStart);
        return result;
    }

    private static void dispatch(int groups)
    {
        GLES31.glDispatchCompute(groups, 1, 1);
        GLES31.glMemoryBarrier(GLES31.GL_SHADER_STORAGE_BARRIER_BIT);
    }

    private static String asset(Context context, String name) throws Exception
    {
        try (InputStream input = context.getAssets().open("gpu-depth/" + name))
        {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int count;
            while ((count = input.read(chunk)) != -1) bytes.write(chunk, 0, count);
            return bytes.toString("UTF-8");
        }
    }

    private static int compile(String source)
    {
        int shader = GLES31.glCreateShader(GLES31.GL_COMPUTE_SHADER);
        GLES31.glShaderSource(shader, source);
        GLES31.glCompileShader(shader);
        int[] status = new int[1];
        GLES31.glGetShaderiv(shader, GLES31.GL_COMPILE_STATUS, status, 0);
        if (status[0] == 0)
        {
            String log = GLES31.glGetShaderInfoLog(shader);
            GLES31.glDeleteShader(shader);
            throw new IllegalStateException("GPU depth shader: " + log);
        }
        int program = GLES31.glCreateProgram();
        GLES31.glAttachShader(program, shader);
        GLES31.glLinkProgram(program);
        GLES31.glDeleteShader(shader);
        GLES31.glGetProgramiv(program, GLES31.GL_LINK_STATUS, status, 0);
        if (status[0] == 0)
        {
            GLES31.glDeleteProgram(program);
            throw new IllegalStateException("GPU depth link");
        }
        return program;
    }

    private static void check()
    {
        int error = GLES31.glGetError();
        if (error != GLES31.GL_NO_ERROR) throw new IllegalStateException("GPU depth GL " + error);
    }

    @Override
    public void close()
    {
        if (fence != 0) GLES31.glDeleteSync(fence);
        fence = 0;
        timer.close();
        GLES31.glDeleteBuffers(4, buffers, 0);
        java.util.Arrays.fill(buffers, 0);
        for (int i = 0; i < programs.length; i++)
        {
            if (programs[i] != 0) GLES31.glDeleteProgram(programs[i]);
            programs[i] = 0;
        }
        if (output != 0) GLES31.glDeleteTextures(1, new int[]{output}, 0);
        if (colorSnapshot != 0) GLES31.glDeleteTextures(1, new int[]{colorSnapshot}, 0);
        if (colorFramebuffer != 0) GLES31.glDeleteFramebuffers(1, new int[]{colorFramebuffer}, 0);
        output = 0;
        colorSnapshot = 0;
        colorFramebuffer = 0;
    }
}
