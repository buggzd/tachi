package com.jellyfinforrayneo.nativelab;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.jellyfinforrayneo.video.NativeVideoEngine;
import java.util.Locale;

/** Separate opt-in lab. No Jellyfin session import, no production playback ownership. */
@androidx.media3.common.util.UnstableApi
public final class NativePlayerLabActivity extends Activity
{
    private NativeVideoEngine engine;
    private LinearLayout layout;
    private TextView status;
    private boolean stereo;
    private volatile long checksum;
    private volatile String quadrants = "[]";
    private long lastReportMs;

    @Override
    protected void onCreate(Bundle state)
    {
        super.onCreate(state);
        layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(16, 64, 16, 16);
        layout.setOnApplyWindowInsetsListener((view, insets) ->
        {
            view.setPadding(16 + insets.getSystemWindowInsetLeft(), 16 + insets.getSystemWindowInsetTop(),
                    16 + insets.getSystemWindowInsetRight(), 16 + insets.getSystemWindowInsetBottom());
            return insets;
        });
        layout.setBackgroundColor(0xff101010);
        status = new TextView(this);
        status.setLines(4);
        status.setTextColor(0xffffffff);
        status.setText("Native video lab: GPU decode texture / bounded RGBA readback. No NPU or depth conversion yet.");
        layout.addView(status);
        EditText address = new EditText(this);
        address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("Direct video / HLS URL (not saved)");
        address.setTextColor(0xffffffff);
        address.setHintTextColor(0xffaaaaaa);
        address.setSaveEnabled(false);
        address.setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        layout.addView(address);
        Button open = button("Open URL", () ->
        {
            try
            {
                if (engine != null) engine.open(Uri.parse(address.getText().toString().trim()));
                address.setText("");
            }
            catch (RuntimeException error)
            {
                status.setText("Cannot open source. Use an HTTP(S) direct video/HLS URL or choose a local video.");
            }
        });
        layout.addView(open);
        layout.addView(button("Choose local video", () ->
        {
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("video/*")
                    .addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(pick, 1);
        }));
        LinearLayout controls = new LinearLayout(this);
        controls.addView(button("Play/pause", () -> { if (engine != null) engine.togglePlayback(); }));
        controls.addView(button("+10s", () -> { if (engine != null) engine.seekBy(10000); }));
        controls.addView(button("SBS preview", () ->
        {
            stereo = !stereo;
            if (engine != null) engine.view().setStereoPreview(stereo);
        }));
        layout.addView(controls);
        setContentView(layout);
    }

    @Override
    protected void onStart()
    {
        super.onStart();
        engine = new NativeVideoEngine(this, (state, position, duration, samples) ->
        {
                status.setText(String.format(Locale.ROOT,
                        "Native %s · %.1f / %.1f s · samples %d · checksum %d\nSBS preview duplicates the video; no depth or USB mode switch.",
                        state, position / 1000.0, duration / 1000.0, samples, checksum));
                long now = android.os.SystemClock.elapsedRealtime();
                if (engine != null && now - lastReportMs >= 1000)
                {
                    lastReportMs = now;
                    android.util.Log.i("NativeVideoLab", String.format(Locale.ROOT,
                            "{\"state\":\"%s\",\"elapsedMs\":%d,\"positionMs\":%d,\"samples\":%d,\"quadrantsRgb\":%s,\"readback\":%s}",
                            state, now, position, samples, quadrants, engine.view().readbackTimingsJson()));
                }
        },
                (rgba, width, height, timestamp) ->
                {
                    long sum = 0;
                    for (int i = 0; i < rgba.remaining(); i += 64) sum += rgba.get(i) & 255;
                    checksum = sum; // No frames or source addresses are retained.
                    // Four coarse color probes verify row order using a synthetic quadrant fixture.
                    int[] colors = new int[4];
                    for (int q = 0; q < 4; q++)
                    {
                        int offset = (((q / 2 == 0 ? height / 4 : height * 3 / 4) * width)
                                + (q % 2 == 0 ? width / 4 : width * 3 / 4)) * 4;
                        colors[q] = ((rgba.get(offset) & 255) << 16)
                                | ((rgba.get(offset + 1) & 255) << 8) | (rgba.get(offset + 2) & 255);
                    }
                    quadrants = java.util.Arrays.toString(colors);
                });
        engine.view().setSampling(true);
        engine.view().setStereoPreview(stereo);
        layout.addView(engine.view(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
    }

    @Override
    protected void onStop()
    {
        if (engine != null)
        {
            engine.close();
            engine.view().onPause();
            layout.removeView(engine.view());
            engine = null;
        }
        super.onStop();
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data)
    {
        super.onActivityResult(request, result, data);
        if (request == 1 && result == RESULT_OK && data != null && data.getData() != null)
        {
            // Results can precede onStart after returning from the document picker.
            Uri selected = data.getData();
            layout.post(() -> { if (engine != null) engine.open(selected); });
        }
    }

    private Button button(String text, Runnable action)
    {
        Button button = new Button(this);
        button.setText(text);
        button.setOnClickListener(view -> action.run());
        return button;
    }
}
