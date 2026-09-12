package com.jellyfinforrayneo.video;

import java.io.*;

/** Desktop harness: executes unmodified production and pinned baseline Java classes. */
public final class DepthFilterRunner
{
    public static void main(String[] args) throws Exception
    {
        Object filter = Class.forName("com.jellyfinforrayneo.video." + args[0])
                .getConstructor().newInstance();
        java.lang.reflect.Method update = filter.getClass().getMethod("update", float[].class, byte[].class);
        try (DataInputStream input = new DataInputStream(new BufferedInputStream(new FileInputStream(args[1])));
                DataOutputStream output = new DataOutputStream(new BufferedOutputStream(new FileOutputStream(args[2]))))
        {
            int frames = input.readInt(), pixels = NativeVideoView.SAMPLE_WIDTH * NativeVideoView.SAMPLE_HEIGHT;
            float[] raw = new float[pixels];
            byte[] rgba = new byte[pixels * 4], held = new byte[pixels];
            for (int frame = 0; frame < frames; frame++)
            {
                for (int i = 0; i < pixels; i++) raw[i] = input.readFloat();
                input.readFully(rgba);
                long start = System.nanoTime();
                byte[] result = (byte[]) update.invoke(filter, raw, rgba);
                output.writeDouble((System.nanoTime() - start) / 1000000.0);
                if (result != null) held = result;
                output.write(held);
            }
        }
    }
}
