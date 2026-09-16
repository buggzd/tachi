package com.jellyfinforrayneo.releaseprobe;

import android.app.Instrumentation;
import android.os.Bundle;
import android.system.Os;
import ai.onnxruntime.*;
import java.io.*;
import java.nio.*;
import java.util.*;

/** Separate same-signature test APK: uses ORT classes from the installed Release,
 * not a second runtime. Does not access accounts or play user media. */
public final class JniProbe extends Instrumentation
{
    @Override public void onCreate(Bundle arguments)
    {
        super.onCreate(arguments);
        start();
    }

    @Override public void onStart()
    {
        Bundle result = new Bundle();
        try
        {
            android.content.Context context = getTargetContext();
            if ((context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
                throw new IllegalStateException("requires non-debuggable release");
            File libs = new File(context.getApplicationInfo().nativeLibraryDir);
            Os.setenv("ADSP_LIBRARY_PATH", libs + ";/vendor/lib/rfsa/adsp;/vendor/dsp/cdsp;/dsp", true);
            ByteArrayOutputStream model = new ByteArrayOutputStream();
            try (InputStream input = context.getAssets().open("realtime-sbs/depth.onnx"))
            {
                byte[] chunk = new byte[65536];
                int count;
                while ((count = input.read(chunk)) != -1)
                {
                    if (model.size() + count > 40 * 1024 * 1024) throw new IOException();
                    model.write(chunk, 0, count);
                }
            }
            OrtEnvironment environment = OrtEnvironment.getEnvironment();
            try (OrtSession.SessionOptions options = new OrtSession.SessionOptions())
            {
                options.addConfigEntry("session.disable_cpu_ep_fallback", "1");
                Map<String, String> qnn = new HashMap<>();
                qnn.put("backend_path", new File(libs, "libQnnHtp.so").getAbsolutePath());
                qnn.put("offload_graph_io_quantization", "0");
                qnn.put("soc_model", "660");
                options.addQnn(qnn);
                try (OrtSession session = environment.createSession(model.toByteArray(), options))
                {
                    String inputName = session.getInputNames().iterator().next();
                    String outputName = session.getOutputNames().iterator().next();
                    long[] shape = ((TensorInfo) session.getOutputInfo().get(outputName).getInfo()).getShape();
                    FloatBuffer input = ByteBuffer.allocateDirect(392 * 224 * 3 * 4)
                            .order(ByteOrder.nativeOrder()).asFloatBuffer();
                    FloatBuffer output = ByteBuffer.allocateDirect(392 * 224 * 4)
                            .order(ByteOrder.nativeOrder()).asFloatBuffer();
                    try (OnnxTensor source = OnnxTensor.createTensor(environment, input, new long[]{1, 3, 224, 392});
                         OnnxTensor target = OnnxTensor.createTensor(environment, output, shape))
                    {
                        for (int run = 0; run < 3; run++)
                        {
                            try (OrtSession.Result ignored = session.run(Collections.singletonMap(inputName, source),
                                    Collections.singletonMap(outputName, target)))
                            {
                                for (int i = 0; i < output.capacity(); i++)
                                    if (!Float.isFinite(output.get(i))) throw new IllegalStateException("nonfinite output");
                            }
                        }
                    }
                    result.putString("jniProbe", "PASS: release output metadata and three pinned QNN inference runs");
                }
            }
            finish(-1, result);
        }
        catch (Throwable failure)
        {
            result.putString("jniProbe", "FAIL: " + failure.getClass().getName());
            finish(1, result);
        }
    }
}
