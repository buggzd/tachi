package com.jellyfinforrayneo.video;

import android.opengl.GLES31;
import java.nio.ByteBuffer;

/** RGBA8 texels to planar normalized floats. GL-thread only; caller owns the completion fence. */
public final class GpuPreprocessor implements AutoCloseable
{
    private final int pixels;
    private int program;
    private int buffer;
    private int lookup;

    public GpuPreprocessor(int width, int height)
    {
        pixels = Math.multiplyExact(width, height);
        if (width <= 0 || height <= 0 || pixels > 1_000_000) throw new IllegalArgumentException("preprocess dimensions");
        String source = "#version 310 es\nprecision highp float; precision highp int;\n"
                + "layout(local_size_x=256) in; layout(binding=2) uniform highp sampler2D rgb;\n"
                + "layout(std430,binding=4) writeonly buffer Output {float chw[];};\n"
                + "layout(std430,binding=5) readonly buffer Normalization {float norm[];};\n"
                + "void main(){uint i=gl_GlobalInvocationID.x;if(i>=" + pixels + "u)return;"
                + "ivec2 p=ivec2(int(i)%" + width + ",int(i)/" + width + ");"
                + "uvec3 bytes=uvec3(floor(texelFetch(rgb,p,0).rgb*255.0+0.5));"
                + "chw[i]=norm[bytes.r];chw[i+" + pixels + "u]=norm[256u+bytes.g];"
                + "chw[i+" + (pixels * 2) + "u]=norm[512u+bytes.b];}";
        int shader = GLES31.glCreateShader(GLES31.GL_COMPUTE_SHADER);
        GLES31.glShaderSource(shader, source);
        GLES31.glCompileShader(shader);
        int[] status = new int[1];
        GLES31.glGetShaderiv(shader, GLES31.GL_COMPILE_STATUS, status, 0);
        if (status[0] == 0)
        {
            GLES31.glDeleteShader(shader);
            throw new IllegalStateException("preprocess shader");
        }
        program = GLES31.glCreateProgram();
        GLES31.glAttachShader(program, shader);
        GLES31.glLinkProgram(program);
        GLES31.glDeleteShader(shader);
        GLES31.glGetProgramiv(program, GLES31.GL_LINK_STATUS, status, 0);
        if (status[0] == 0)
        {
            close();
            throw new IllegalStateException("preprocess link");
        }
        GLES31.glGenBuffers(1, status, 0);
        buffer = status[0];
        GLES31.glBindBuffer(GLES31.GL_SHADER_STORAGE_BUFFER, buffer);
        GLES31.glBufferData(GLES31.GL_SHADER_STORAGE_BUFFER, pixels * 12, null, GLES31.GL_DYNAMIC_READ);
        // Build 768 constants once. A lookup preserves the CPU reference's float rounding exactly;
        // GPU reciprocal/fused arithmetic can move quantized model inputs across bin boundaries.
        java.nio.FloatBuffer constants = ByteBuffer.allocateDirect(768 * 4)
                .order(java.nio.ByteOrder.nativeOrder()).asFloatBuffer();
        float[] mean = {.485f, .456f, .406f}, std = {.229f, .224f, .225f};
        for (int c = 0; c < 3; c++)
            for (int value = 0; value < 256; value++) constants.put((value / 255f - mean[c]) / std[c]);
        constants.flip();
        GLES31.glGenBuffers(1, status, 0);
        lookup = status[0];
        GLES31.glBindBuffer(GLES31.GL_SHADER_STORAGE_BUFFER, lookup);
        GLES31.glBufferData(GLES31.GL_SHADER_STORAGE_BUFFER, 768 * 4, constants, GLES31.GL_STATIC_DRAW);
    }

    public void submit(int rgbaTexture)
    {
        GLES31.glUseProgram(program);
        GLES31.glActiveTexture(GLES31.GL_TEXTURE2);
        GLES31.glBindTexture(GLES31.GL_TEXTURE_2D, rgbaTexture);
        GLES31.glBindBufferBase(GLES31.GL_SHADER_STORAGE_BUFFER, 4, buffer);
        GLES31.glBindBufferBase(GLES31.GL_SHADER_STORAGE_BUFFER, 5, lookup);
        GLES31.glDispatchCompute((pixels + 255) / 256, 1, 1);
        GLES31.glMemoryBarrier(GLES31.GL_BUFFER_UPDATE_BARRIER_BIT);
    }

    /** Call only after the caller's fence has signaled. This is explicitly a host readback. */
    public void copyTo(ByteBuffer destination)
    {
        GLES31.glBindBuffer(GLES31.GL_SHADER_STORAGE_BUFFER, buffer);
        ByteBuffer mapped = (ByteBuffer) GLES31.glMapBufferRange(GLES31.GL_SHADER_STORAGE_BUFFER,
                0, pixels * 12, GLES31.GL_MAP_READ_BIT);
        if (mapped == null) throw new IllegalStateException("preprocess map");
        destination.clear();
        destination.put(mapped).flip();
        if (!GLES31.glUnmapBuffer(GLES31.GL_SHADER_STORAGE_BUFFER))
            throw new IllegalStateException("preprocess readback lost");
    }

    @Override
    public void close()
    {
        GLES31.glDeleteBuffers(2, new int[]{buffer, lookup}, 0);
        GLES31.glDeleteProgram(program);
        buffer = 0;
        lookup = 0;
        program = 0;
    }
}
