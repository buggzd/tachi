package com.jellyfinforrayneo.video;

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
public final class QnnDepthProcessor implements NativeDepthProcessor
{
    private static final int WIDTH = NativeVideoView.SAMPLE_WIDTH;
    private static final int HEIGHT = NativeVideoView.SAMPLE_HEIGHT;
    private static final int PIXELS = WIDTH * HEIGHT;
    private final Context context;
    private final String modelHash;
    private final FloatBuffer input = ByteBuffer.allocateDirect(PIXELS * 3 * 4)
            .order(ByteOrder.nativeOrder()).asFloatBuffer();
    private final float[] raw = new float[PIXELS];
    private final byte[] rgbaBytes = new byte[PIXELS * 4];
    private final float[] chw = new float[PIXELS * 3];
    private OrtEnvironment environment;
    private OrtSession session;
    private OnnxTensor tensor;
    private String inputName;
    private String outputName;
    private OnnxTensor pinnedOutput;
    private final FloatBuffer outputStorage = BuildConfig.PINNED_DEPTH_OUTPUT
            ? ByteBuffer.allocateDirect(PIXELS * 4).order(ByteOrder.nativeOrder()).asFloatBuffer() : null;
    private TemporalDepth stabilizer;
    private long generation = -1;

    public static NativeDepthProcessor create(Context context, String modelHash)
    {
        return new QnnDepthProcessor(context, modelHash);
    }

    private QnnDepthProcessor(Context context, String modelHash)
    {
        this.context = context.getApplicationContext();
        this.modelHash = modelHash;
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
        if (!modelHash.equals(hash.toString())) throw new IllegalStateException("model hash");
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
        outputName = session.getOutputNames().iterator().next();
        if (BuildConfig.PINNED_DEPTH_OUTPUT)
        {
            long[] shape = ((ai.onnxruntime.TensorInfo) session.getOutputInfo().get(outputName).getInfo()).getShape();
            pinnedOutput = OnnxTensor.createTensor(environment, outputStorage, shape);
        }
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
        infer();
        long inferred = System.nanoTime();
        if (BuildConfig.GPU_DEPTH_STABILIZATION)
        {
            // Immutable handoff; the capture lease also preserves the matching GPU RGB texture.
            float[] owned = raw.clone();
            return DepthResult.raw(owned, preprocessed - start, inferred - preprocessed, System.nanoTime() - inferred);
        }
        byte[] map = stabilizer.update(raw, rgbaBytes);
        return new DepthResult(map, preprocessed - start, inferred - preprocessed, System.nanoTime() - inferred);
    }

    @Override
    public DepthResult processChw(ByteBuffer chwBytes, long visit) throws Exception
    {
        if (!BuildConfig.GPU_DEPTH_STABILIZATION || chwBytes.remaining() != PIXELS * 12)
            throw new IllegalArgumentException("chw shape");
        long start = System.nanoTime();
        // ORT wraps the capture's direct buffer; the lease outlives synchronous run.
        try (OnnxTensor captured = OnnxTensor.createTensor(environment,
                chwBytes.duplicate().order(ByteOrder.nativeOrder()).asFloatBuffer(),
                new long[]{1, 3, HEIGHT, WIDTH}))
        {
            long prepared = System.nanoTime();
            infer(captured);
            long inferred = System.nanoTime();
            float[] owned = raw.clone();
            return DepthResult.raw(owned, prepared - start, inferred - prepared, System.nanoTime() - inferred);
        }
    }

    private void infer() throws Exception
    {
        infer(tensor);
    }

    private void infer(OnnxTensor source) throws Exception
    {
        try (OrtSession.Result result = pinnedOutput == null
                ? session.run(Collections.singletonMap(inputName, source))
                : session.run(Collections.singletonMap(inputName, source), Collections.singletonMap(outputName, pinnedOutput)))
        {
            // Pinned output avoids getFloatBuffer's per-run heap allocation and copy in ORT 1.22.
            FloatBuffer output = pinnedOutput == null
                    ? ((OnnxTensor) result.get(0)).getFloatBuffer() : outputStorage.duplicate();
            output.rewind();
            if (output.remaining() != PIXELS) throw new IllegalStateException("depth shape");
            output.get(raw);
        }
    }

    @Override
    public void close() throws Exception
    {
        if (pinnedOutput != null) pinnedOutput.close();
        pinnedOutput = null;
        if (tensor != null) tensor.close();
        if (session != null) session.close();
        tensor = null;
        session = null;
    }
}
