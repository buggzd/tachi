package com.jellyfinforrayneo.client;

import android.content.Context;
import android.system.Os;
import java.io.File;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

final class RealtimeDepthBackend implements DepthBackend
{
    private final OrtEnvironment environment;
    private final OrtSession session;
    private final String inputName;

    static boolean available()
    {
        return android.os.Build.VERSION.SDK_INT >= 33;
    }

    static DepthBackend open(Context context) throws Exception
    {
        return new RealtimeDepthBackend(context);
    }

    private RealtimeDepthBackend(Context context) throws Exception
    {
        File directory = new File(context.getApplicationInfo().nativeLibraryDir);
        Os.setenv("ADSP_LIBRARY_PATH", directory + ";/vendor/lib/rfsa/adsp;/vendor/dsp/cdsp;/dsp", true);
        environment = OrtEnvironment.getEnvironment();
        byte[] model;
        try (InputStream input = context.getAssets().open("realtime-sbs/depth.onnx"))
        {
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[65536];
            int read;
            while ((read = input.read(buffer)) != -1)
            {
                if (output.size() + read > 40 * 1024 * 1024)
                {
                    throw new IllegalStateException("model");
                }
                output.write(buffer, 0, read);
            }
            model = output.toByteArray();
        }
        StringBuilder hash = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(model))
        {
            hash.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        }
        if (!BuildConfig.REALTIME_MODEL_SHA256.equals(hash.toString()))
        {
            throw new IllegalStateException("model");
        }
        try (OrtSession.SessionOptions options = new OrtSession.SessionOptions())
        {
            options.addConfigEntry("session.disable_cpu_ep_fallback", "1");
            Map<String, String> qnn = new HashMap<>();
            qnn.put("backend_path", new File(directory, "libQnnHtp.so").getAbsolutePath());
            qnn.put("offload_graph_io_quantization", "0");
            qnn.put("soc_model", "660");
            options.addQnn(qnn);
            session = environment.createSession(model, options);
        }
        inputName = session.getInputNames().iterator().next();
    }

    @Override
    public float[] infer(float[] input) throws Exception
    {
        try (OnnxTensor tensor = OnnxTensor.createTensor(environment, FloatBuffer.wrap(input),
                new long[]{1, 3, DepthFrame.HEIGHT, DepthFrame.WIDTH});
             OrtSession.Result result = session.run(Collections.singletonMap(inputName, tensor)))
        {
            float[][] map = ((float[][][]) result.get(0).getValue())[0];
            if (map.length != DepthFrame.HEIGHT)
            {
                throw new IllegalStateException("shape");
            }
            float[] values = new float[DepthFrame.PIXELS];
            for (int row = 0; row < map.length; row++)
            {
                if (map[row].length != DepthFrame.WIDTH)
                {
                    throw new IllegalStateException("shape");
                }
                System.arraycopy(map[row], 0, values, row * DepthFrame.WIDTH, DepthFrame.WIDTH);
            }
            return values;
        }
    }

    @Override
    public void close() throws Exception
    {
        session.close();
    }
}
