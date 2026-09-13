package com.tachi.stereolab.npubenchmark;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxJavaType;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtLoggingLevel;
import ai.onnxruntime.OrtSession;
import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;
import android.content.Intent;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.IOException;
import java.io.InputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.FloatBuffer;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String TAG = "TachiNpuBenchmark";
    private static final String MODEL_ASSET = "models/depth-anything-v2-small-qnn-266-u16a-i8w.onnx";
    private static final String SMOKE_MODEL_ASSET = "models/qnn-smoke-qdq-conv-relu.onnx";
    private static final String IO_SMOKE_MODEL_ASSET = "models/qnn-smoke-qdq-conv-relu-io.onnx";
    private static final String RELU_SMOKE_MODEL_ASSET = "models/qnn-smoke-relu.onnx";
    private static final int WIDTH = 266;
    private static final int HEIGHT = 154;
    private static final int SMOKE_WIDTH = 8;
    private static final int SMOKE_HEIGHT = 8;
    private static final int WARMUP_RUNS = 5;
    private static final String QNN_VENDOR_DIRECTORY = "/vendor/lib64";
    private static final String[] QNN_VENDOR_LIBRARIES = {
            "libQnnSystem.so",
            "libcdsprpc.so",
            "libQnnHtpV81Stub.so",
            "libQnnHtpV81CalculatorStub.so",
            "libQnnHtpPrepare.so",
            "libQnnHtpNetRunExtensions.so",
            "libQnnHtp.so"
    };

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private TextView output;
    private String socModelOverride;
    private String benchmarkStage = "direct";
    private int measuredRuns = 30;

    static {
        System.loadLibrary("tachi_qnn_probe");
    }

    private static native String nativeProbeQnn(String backendDirectory, int socModel, boolean sharedMemory);

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent launchIntent = getIntent();
        if (launchIntent != null)
        {
            measuredRuns = Math.max(30, Math.min(12000, launchIntent.getIntExtra("measured_runs", 30)));
        }
        socModelOverride = launchIntent == null ? null : launchIntent.getStringExtra("soc_model");
        String stage = launchIntent == null ? null : launchIntent.getStringExtra("benchmark_stage");
        if ("smoke".equals(stage) || "depth".equals(stage) || "shared".equals(stage))
        {
            benchmarkStage = stage;
        }
        output = new TextView(this);
        output.setTextSize(12);
        output.setPadding(24, 24, 24, 24);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(output);
        setContentView(scroll);
        append("Starting QNN HTP benchmark; CPU fallback is disabled.\n");
        Intent keepAlive = new Intent(this, BenchmarkKeepAliveService.class);
        startForegroundService(keepAlive);
        executor.execute(() ->
        {
            try
            {
                runBenchmark();
            }
            finally
            {
                stopService(keepAlive);
            }
        });
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    private void append(String text) {
        Log.i(TAG, text.replace('\n', ' '));
        runOnUiThread(() -> output.append(text));
    }

    private void runBenchmark() {
        try {
            append("benchmarkStage=" + benchmarkStage + "\n");
            append(deviceSummary());
            configureAdspLibraryPath();
            File qnnBackend = prepareQnnBackend();
            append("qnnBackend=" + qnnBackend.getAbsolutePath() + "\n");
            try {
                String socModel = socModelOverride == null || socModelOverride.isEmpty()
                        ? "660" : socModelOverride;
                String directResult = nativeProbeQnn(qnnBackend.getParent(), Integer.parseInt(socModel), "shared".equals(benchmarkStage));
                append(directResult);
                if (!directResult.contains("directProbeMarker=PASS") || "direct".equals(benchmarkStage) || "shared".equals(benchmarkStage))
                {
                    append("DIRECT_PROBE_COMPLETE=true\n");
                    return;
                }
                OrtEnvironment environment = OrtEnvironment.getEnvironment();
                if ("smoke".equals(benchmarkStage))
                {
                    runSession(environment, assetBytes(IO_SMOKE_MODEL_ASSET),
                            Collections.singletonList(smokeInput()), true, "QNN_SMOKE", qnnBackend,
                            SMOKE_WIDTH, SMOKE_HEIGHT, OnnxJavaType.UINT8);
                }
                else
                {
                    byte[] model = assetBytes(MODEL_ASSET);
                    byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(model);
                    StringBuilder hex = new StringBuilder();
                    for (byte value : digest)
                    {
                        hex.append(String.format(Locale.US, "%02x", value & 0xff));
                    }
                    append("depthModelSha256=" + hex + "\n");
                    runSession(environment, model, loadCalibrationInputs(), true, "QNN_DEPTH", qnnBackend);
                }
                append("benchmarkMarker=PASS stage=" + benchmarkStage + "\n");
            } catch (Throwable error) {
                append("benchmarkMarker=FAIL stage=" + benchmarkStage + "\n");
                append("DIRECT_QNN_PROBE_FAILED=" + error + "\n");
                Log.e(TAG, "Direct QNN probe failed", error);
            }
            append("DIRECT_PROBE_COMPLETE=true\n");
        } catch (Throwable error) {
            append("directProbeMarker=FAIL stage=setup\n");
            append("BENCHMARK_FAILED=" + error + "\n");
            Log.e(TAG, "QNN benchmark failed", error);
        }
    }

    private void runSession(
            OrtEnvironment environment,
            byte[] model,
            List<float[]> inputs,
            boolean strict,
            String label,
            File qnnBackend) throws Exception {
        runSession(environment, model, inputs, strict, label, qnnBackend, WIDTH, HEIGHT);
    }

    private void runSession(
            OrtEnvironment environment,
            byte[] model,
            List<float[]> inputs,
            boolean strict,
            String label,
            File qnnBackend,
            int width,
            int height) throws Exception {
        runSession(environment, model, inputs, strict, label, qnnBackend, width, height,
                OnnxJavaType.FLOAT);
    }

    private void runSession(
            OrtEnvironment environment,
            byte[] model,
            List<float[]> inputs,
            boolean strict,
            String label,
            File qnnBackend,
            int width,
            int height,
            OnnxJavaType inputType) throws Exception {
        try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
            options.addConfigEntry("session.disable_cpu_ep_fallback", strict ? "1" : "0");
            options.setSessionLogLevel(OrtLoggingLevel.ORT_LOGGING_LEVEL_VERBOSE);
            options.setSessionLogVerbosityLevel(5);
            Map<String, String> qnnOptions = new HashMap<>();
            qnnOptions.put("backend_path", qnnBackend.getAbsolutePath());
            // A value of 1 offloads graph I/O quantization to the CPU EP.
            // Keep it on QNN when validating a graph with CPU fallback disabled.
            qnnOptions.put("offload_graph_io_quantization", "0");
            String socModel = socModelOverride == null || socModelOverride.isEmpty()
                    ? "660" : socModelOverride;
            qnnOptions.put("soc_model", socModel);
            append("qnnSocModel=" + socModel + "\n");
            options.addQnn(qnnOptions);
            String profilePath = getFilesDir().getAbsolutePath() + "/qnn-profile-" + label;
            options.enableProfiling(profilePath);

            long sessionStart = SystemClock.elapsedRealtimeNanos();
            try (OrtSession session = environment.createSession(model, options)) {
                double initMs = elapsedMs(sessionStart);
                append(String.format(Locale.US, "%sSessionInitMs=%.3f\n", label, initMs));
                append(label + "Inputs=" + session.getInputInfo() + "\n"
                        + label + "Outputs=" + session.getOutputInfo() + "\n");

                String inputName = session.getInputNames().iterator().next();
                List<Double> timings = new ArrayList<>();
                List<Double> transferAndRunTimings = new ArrayList<>();
                double checksum = 0.0;
                for (int index = 0; index < WARMUP_RUNS + measuredRuns; index++) {
                    float[] input = inputs.get(index % inputs.size());
                    long transferStart = SystemClock.elapsedRealtimeNanos();
                    try (OnnxTensor tensor = createInputTensor(
                            environment, input, new long[]{1, 3, height, width}, inputType)) {
                        long start = SystemClock.elapsedRealtimeNanos();
                        try (OrtSession.Result result = session.run(
                                Collections.singletonMap(inputName, tensor))) {
                            Object value = result.get(0).getValue();
                            double sample = sampleChecksum(value);
                            if (!Double.isFinite(sample))
                            {
                                throw new IllegalStateException("Nonfinite model output");
                            }
                            checksum += sample;
                            double elapsed = elapsedMs(start);
                            if (index >= WARMUP_RUNS) {
                                timings.add(elapsed);
                                transferAndRunTimings.add(elapsedMs(transferStart));
                            }
                            if (index == WARMUP_RUNS + measuredRuns - 1 && "QNN_DEPTH".equals(label))
                            {
                                try (java.io.DataOutputStream inputOutput = new java.io.DataOutputStream(
                                        new FileOutputStream(new File(getFilesDir(), "depth-input-f32be.bin"))))
                                {
                                    for (float pixel : input)
                                    {
                                        inputOutput.writeFloat(pixel);
                                    }
                                }
                                float[][] depth = ((float[][][]) value)[0];
                                float lo = Float.POSITIVE_INFINITY, hi = Float.NEGATIVE_INFINITY;
                                try (java.io.DataOutputStream output = new java.io.DataOutputStream(
                                        new FileOutputStream(new File(getFilesDir(), "depth-output-f32be.bin"))))
                                {
                                    for (float[] row : depth)
                                    {
                                        for (float pixel : row)
                                        {
                                            if (!Float.isFinite(pixel))
                                            {
                                                throw new IllegalStateException("Nonfinite depth");
                                            }
                                            lo = Math.min(lo, pixel);
                                            hi = Math.max(hi, pixel);
                                            output.writeFloat(pixel);
                                        }
                                    }
                                }
                                if (hi - lo <= 0.00001f)
                                {
                                    throw new IllegalStateException("Constant depth output");
                                }
                                append("depthOutputInputIndex=" + (index % inputs.size())
                                        + " height=" + depth.length + " width=" + depth[0].length
                                        + " range=" + (hi - lo) + "\n");
                            }
                        }
                    }
                }
                String endedProfile = session.endProfiling();
                printTiming(label, timings, checksum, endedProfile, strict);
                printTiming(label + "_TENSOR_AND_RUN", transferAndRunTimings, checksum, endedProfile, strict);
            }
        }
    }

    /**
     * Android's class linker namespace does not allow an application to dlopen
     * a QNN backend directly from /vendor/lib64.  The phone exposes the QNN
     * runtime libraries as world-readable files, so copy the small set needed
     * by the HTP backend into the app-private directory before ORT loads it.
     * This is deliberately limited to the standalone benchmark; the regular
     * Jellyfin APK never copies or loads vendor libraries.
     */
    private File prepareQnnBackend() throws IOException {
        File packaged = new File(getApplicationInfo().nativeLibraryDir, "libQnnHtp.so");
        if (packaged.isFile())
        {
            append("qnnRuntimeSource=packaged-qairt\n");
            return packaged;
        }
        append("qnnRuntimeSource=legacy-vendor-probe\n");
        File directory = new File(getFilesDir(), "qnn-libs");
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("cannot create " + directory);
        }
        for (String name : QNN_VENDOR_LIBRARIES) {
            File source = new File(QNN_VENDOR_DIRECTORY, name);
            File target = new File(directory, name);
            try {
                copyIfNeeded(source, target);
                append("qnnLibrary=" + name + " copied bytes=" + target.length() + "\n");
            } catch (IOException | SecurityException error) {
                append("qnnLibrary=" + name + " unavailable=" + error.getMessage() + "\n");
                if (name.equals("libQnnHtp.so")) {
                    throw new IOException("QNN HTP backend is unavailable", error);
                }
            }
        }
        return new File(directory, "libQnnHtp.so");
    }

    private void configureAdspLibraryPath() {
        String path = getApplicationInfo().nativeLibraryDir + ";/vendor/lib/rfsa/adsp;/vendor/dsp/cdsp;/vendor/dsp/adsp"
                + ";/system/lib/rfsa/adsp;/dsp";
        try {
            Os.setenv("ADSP_LIBRARY_PATH", path, true);
            append("adspLibraryPath=" + path + "\n");
        } catch (ErrnoException error) {
            append("adspLibraryPathUnavailable=" + error.getMessage() + "\n");
        }
    }

    private static void copyIfNeeded(File source, File target) throws IOException {
        if (target.isFile() && target.length() == source.length()) {
            return;
        }
        File temporary = new File(target.getPath() + ".part");
        try (InputStream input = new FileInputStream(source);
                FileOutputStream output = new FileOutputStream(temporary)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                if (count > 0) {
                    output.write(buffer, 0, count);
                }
            }
            output.getFD().sync();
        }
        if (!temporary.renameTo(target)) {
            throw new IOException("cannot install " + target);
        }
    }

    private String deviceSummary() {
        return "device=" + Build.MANUFACTURER + " " + Build.MODEL
                + " soc=" + Build.HARDWARE + " board=" + Build.BOARD
                + " android=" + Build.VERSION.RELEASE + " api=" + Build.VERSION.SDK_INT + "\n";
    }

    private List<float[]> loadCalibrationInputs() throws IOException {
        List<float[]> result = new ArrayList<>();
        String[] files = getAssets().list("calibration");
        if (files == null || files.length == 0) {
            throw new IOException("no calibration assets");
        }
        Arrays.sort(files);
        for (String file : files) {
            try (InputStream stream = getAssets().open("calibration/" + file)) {
                Bitmap bitmap = BitmapFactory.decodeStream(stream);
                if (bitmap == null) {
                    throw new IOException("cannot decode " + file);
                }
                Bitmap scaled = Bitmap.createScaledBitmap(bitmap, WIDTH, HEIGHT, true);
                result.add(toNchw(scaled));
                if (scaled != bitmap) {
                    scaled.recycle();
                }
                bitmap.recycle();
            }
        }
        return result;
    }

    private static float[] toNchw(Bitmap bitmap) {
        int pixels = WIDTH * HEIGHT;
        float[] result = new float[pixels * 3];
        int[] argb = new int[pixels];
        bitmap.getPixels(argb, 0, WIDTH, 0, 0, WIDTH, HEIGHT);
        float[] mean = {0.485f, 0.456f, 0.406f};
        float[] std = {0.229f, 0.224f, 0.225f};
        for (int index = 0; index < pixels; index++) {
            int color = argb[index];
            result[index] = (((color >> 16) & 0xff) / 255.0f - mean[0]) / std[0];
            result[pixels + index] = (((color >> 8) & 0xff) / 255.0f - mean[1]) / std[1];
            result[2 * pixels + index] = ((color & 0xff) / 255.0f - mean[2]) / std[2];
        }
        return result;
    }

    private static float[] smokeInput() {
        float[] result = new float[3 * SMOKE_WIDTH * SMOKE_HEIGHT];
        for (int index = 0; index < result.length; index++) {
            result[index] = (index - result.length / 2) / (float) result.length;
        }
        return result;
    }

    private static OnnxTensor createInputTensor(
            OrtEnvironment environment,
            float[] input,
            long[] shape,
            OnnxJavaType inputType) throws Exception {
        if (inputType == OnnxJavaType.UINT8) {
            byte[] quantized = new byte[input.length];
            for (int index = 0; index < input.length; index++) {
                int value = Math.round(input[index] / 0.05f + 128.0f);
                quantized[index] = (byte) Math.max(0, Math.min(255, value));
            }
            return OnnxTensor.createTensor(
                    environment, ByteBuffer.wrap(quantized), shape, OnnxJavaType.UINT8);
        }
        return OnnxTensor.createTensor(environment, FloatBuffer.wrap(input), shape);
    }

    private byte[] assetBytes(String name) throws IOException {
        try (InputStream stream = getAssets().open(name)) {
            byte[] buffer = new byte[64 * 1024];
            java.io.ByteArrayOutputStream outputStream = new java.io.ByteArrayOutputStream();
            int read;
            while ((read = stream.read(buffer)) >= 0) {
                outputStream.write(buffer, 0, read);
            }
            return outputStream.toByteArray();
        }
    }

    private static double sampleChecksum(Object value) {
        if (value instanceof byte[][][][]) {
            byte[][][][] output = (byte[][][][]) value;
            double sum = 0.0;
            for (byte[][][] batch : output) {
                for (byte[][] channel : batch) {
                    for (int y = 0; y < channel.length; y += 16) {
                        for (int x = 0; x < channel[y].length; x += 16) {
                            sum += channel[y][x] & 0xff;
                        }
                    }
                }
            }
            return sum;
        }
        if (value instanceof float[][][][]) {
            float[][][][] output = (float[][][][]) value;
            double sum = 0.0;
            for (float[][][] batch : output) {
                for (float[][] channel : batch) {
                    for (int y = 0; y < channel.length; y += 16) {
                        for (int x = 0; x < channel[y].length; x += 16) {
                            sum += channel[y][x];
                        }
                    }
                }
            }
            return sum;
        }
        if (value instanceof float[][][]) {
            float[][][] output = (float[][][]) value;
            double sum = 0.0;
            for (int y = 0; y < output[0].length; y += 16) {
                for (int x = 0; x < output[0][y].length; x += 16) {
                    sum += output[0][y][x];
                }
            }
            return sum;
        }
        throw new IllegalStateException("unexpected output type " + value.getClass());
    }

    private void printTiming(
            String label,
            List<Double> values,
            double checksum,
            String profile,
            boolean strict) {
        Collections.sort(values);
        double mean = values.stream().mapToDouble(value -> value).average().orElse(Double.NaN);
        double p50 = percentile(values, 0.50);
        double p95 = percentile(values, 0.95);
        append(String.format(Locale.US,
                "%sWarmupRuns=%d %sMeasuredRuns=%d %sRunMsMean=%.3f %sRunMsP50=%.3f "
                        + "%sRunMsP95=%.3f %sChecksum=%.6f\n",
                label, WARMUP_RUNS, label, values.size(), label, mean, label, p50, label, p95,
                label, checksum));
        append(label + "Profile=" + profile + "\n");
        if (!strict) {
            append("QNN_CPU_FALLBACK_DIAGNOSTIC_ONLY\n");
        }
    }

    private static double percentile(List<Double> values, double fraction) {
        if (values.isEmpty()) {
            return Double.NaN;
        }
        int index = Math.min(values.size() - 1, Math.max(0, (int) Math.ceil(fraction * values.size()) - 1));
        return values.get(index);
    }

    private static double elapsedMs(long startNanos) {
        return (SystemClock.elapsedRealtimeNanos() - startNanos) / 1_000_000.0;
    }
}
