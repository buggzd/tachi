package com.jellyfinforrayneo.nativelab;

import android.content.Context;
import android.system.Os;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import com.jellyfinforrayneo.video.DepthResult;
import com.jellyfinforrayneo.video.NativeDepthProcessor;
import com.jellyfinforrayneo.video.NativeVideoView;
import com.jellyfinforrayneo.video.TemporalDepth;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Fixed SM8850/V81 backend; CPU execution-provider fallback is explicitly forbidden. */
final class LabDepthProcessor implements NativeDepthProcessor
{
    private static final int WIDTH = NativeVideoView.SAMPLE_WIDTH;
    private static final int HEIGHT = NativeVideoView.SAMPLE_HEIGHT;
    private static final int PIXELS = WIDTH * HEIGHT;
    private final Context context;
    private final FloatBuffer input = ByteBuffer.allocateDirect(PIXELS * 3 * 4)
            .order(ByteOrder.nativeOrder()).asFloatBuffer();
    private final float[] raw = new float[PIXELS];
    private final byte[] rgbaBytes = new byte[PIXELS * 4];
    private final float[] chw = new float[PIXELS * 3];
    private OrtEnvironment environment;
    private OrtSession session;
    private OnnxTensor tensor;
    private String inputName;
    private TemporalDepth stabilizer;
    private long generation = -1;

    static NativeDepthProcessor create(Context context)
    {
        return new LabDepthProcessor(context);
    }

    private LabDepthProcessor(Context context)
    {
        this.context = context.getApplicationContext();
    }

    @Override
    public void prepare() throws Exception
    {
        File directory = new File(context.getApplicationInfo().nativeLibraryDir);
        Os.setenv("ADSP_LIBRARY_PATH", directory + ";/vendor/lib/rfsa/adsp;/vendor/dsp/cdsp;/dsp", true);
        byte[] model;
        try (InputStream source = context.getAssets().open("realtime-sbs/depth.onnx"))
        {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] chunk = new byte[65536];
            int count;
            while ((count = source.read(chunk)) != -1)
            {
                if (bytes.size() + count > 40 * 1024 * 1024) throw new IllegalStateException("model size");
                bytes.write(chunk, 0, count);
            }
            model = bytes.toByteArray();
        }
        StringBuilder hash = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(model))
            hash.append(String.format(Locale.ROOT, "%02x", value & 255));
        if (!BuildConfig.MODEL_SHA256.equals(hash.toString())) throw new IllegalStateException("model hash");
        environment = OrtEnvironment.getEnvironment();
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
        tensor = OnnxTensor.createTensor(environment, input, new long[]{1, 3, HEIGHT, WIDTH});
    }

    @Override
    public DepthResult process(ByteBuffer rgba, long visit) throws Exception
    {
        if (rgba.remaining() != PIXELS * 4) throw new IllegalArgumentException("rgba shape");
        if (visit != generation)
        {
            generation = visit;
            stabilizer = new TemporalDepth();
        }
        long start = System.nanoTime();
        rgba.duplicate().get(rgbaBytes); // One bulk copy avoids hundreds of thousands of direct-buffer accesses.
        float[] mean = {.485f, .456f, .406f}, std = {.229f, .224f, .225f};
        input.clear();
        for (int c = 0; c < 3; c++)
            for (int i = 0; i < PIXELS; i++)
                chw[c * PIXELS + i] = ((rgbaBytes[i * 4 + c] & 255) / 255f - mean[c]) / std[c];
        input.put(chw);
        input.rewind();
        long preprocessed = System.nanoTime();
        try (OrtSession.Result result = session.run(Collections.singletonMap(inputName, tensor)))
        {
            FloatBuffer output = ((OnnxTensor) result.get(0)).getFloatBuffer();
            if (output.remaining() != PIXELS) throw new IllegalStateException("depth shape");
            output.get(raw);
        }
        long inferred = System.nanoTime();
        byte[] map = stabilizer.update(raw, rgbaBytes);
        return new DepthResult(map, preprocessed - start, inferred - preprocessed, System.nanoTime() - inferred);
    }

    @Override
    public void close() throws Exception
    {
        if (tensor != null) tensor.close();
        if (session != null) session.close();
        tensor = null;
        session = null;
    }
}
