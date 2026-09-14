package com.jellyfinforrayneo.client;

import android.app.Activity;
import android.app.Presentation;
import android.content.Intent;
import android.hardware.display.DisplayManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.Display;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.jellyfinforrayneo.video.NativeVideoEngine;
import com.jellyfinforrayneo.video.QnnDepthProcessor;

/** Shell-only, liquid-build-only fixture entry. No sessions, URLs, or playback reporting. */
@androidx.media3.common.util.UnstableApi
public final class SbsFixtureActivity extends Activity
{
    private NativeVideoEngine engine;
    private LinearLayout root;
    private TextView status;
    private Uri selected;
    private Presentation external;
    private long lastLog;
    private boolean stereo = true;
    private boolean debug;

    @Override
    protected void onCreate(Bundle state)
    {
        super.onCreate(state);
        if (!"liquid".equals(BuildConfig.DAILY_SBS)) { finish(); return; }
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(24, 80, 24, 24);
        status = new TextView(this);
        status.setText("tachi liquid fixture · choose an anonymous local video");
        root.addView(status);
        add("Choose local video", () -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .setType("video/*").addCategory(Intent.CATEGORY_OPENABLE), 1));
        add("Play / pause", () -> { if (engine != null) engine.togglePlayback(); });
        add("Seek near frame 347 (30 fps)", () -> seek(11567));
        add("Seek near frame 579 (30 fps)", () -> seek(19300));
        add("Depth preview", () -> { debug = !debug; if (engine != null) engine.view().setDepthDebug(debug); });
        add("SBS / 2D", () -> { stereo = !stereo; if (engine != null) engine.view().setStereoPreview(stereo); });
        setContentView(root);
    }

    private void add(String text, Runnable action)
    {
        Button button = new Button(this);
        button.setText(text);
        button.setOnClickListener(view -> action.run());
        root.addView(button);
    }

    private void seek(long ms)
    {
        if (engine != null) engine.seekTo(ms);
    }

    @Override
    protected void onStart()
    {
        super.onStart();
        if (!"liquid".equals(BuildConfig.DAILY_SBS)) return;
        engine = new NativeVideoEngine(this, (state, position, duration, samples) ->
        {
            if (engine == null) return;
            status.setText(state + " · requested clock " + position + " ms\n" + engine.view().depthSummary());
            long now = android.os.SystemClock.elapsedRealtime();
            if (now - lastLog >= 1000)
            {
                lastLog = now;
                android.util.Log.i("TachiLiquidFixture", "{\"elapsedMs\":" + now
                        + ",\"state\":\"" + state + "\",\"positionMs\":" + position
                        + ",\"depth\":" + engine.depthTimingsJson() + "}");
            }
        }, (bytes, width, height, timestamp) -> {},
                QnnDepthProcessor.create(this, BuildConfig.REALTIME_MODEL_SHA256));
        engine.view().setStereoPreview(stereo);
        engine.view().setDepthDebug(debug);
        engine.view().setDepthEnabled(true);
        DisplayManager displays = (DisplayManager) getSystemService(DISPLAY_SERVICE);
        Display[] candidates = displays == null ? new Display[0]
                : displays.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION);
        if (candidates.length > 0)
        {
            try
            {
                external = new Presentation(this, candidates[0]);
                external.setContentView(engine.view());
                external.show();
            }
            catch (RuntimeException failure)
            {
                if (external != null) external.dismiss();
                external = null;
                ViewGroup parent = (ViewGroup) engine.view().getParent();
                if (parent != null) parent.removeView(engine.view());
            }
        }
        if (external == null) root.addView(engine.view(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        if (selected != null) engine.open(selected);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data)
    {
        super.onActivityResult(request, result, data);
        if (request == 1 && result == RESULT_OK && data != null && data.getData() != null
                && "content".equals(data.getData().getScheme()))
        {
            selected = data.getData();
            if (engine != null) engine.open(selected);
        }
    }

    @Override
    protected void onStop()
    {
        if (engine != null)
        {
            engine.close();
            engine.view().onPause();
            ViewGroup parent = (ViewGroup) engine.view().getParent();
            if (parent != null) parent.removeView(engine.view());
            engine = null;
        }
        if (external != null) external.dismiss();
        external = null;
        super.onStop();
    }
}
