package com.jellyfinforrayneo.client;

import android.app.Activity;
import android.app.Presentation;
import android.content.Context;
import android.hardware.display.DisplayManager;
import android.os.Bundle;
import android.util.Log;
import android.view.Display;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class GlassesPresentationController
{
    interface Callback extends GlassesWebViewController.BootstrapProvider
    {
        void onDisplayConnectionChanged(boolean connected);

        void onWebReadyChanged(boolean ready);

        void onStereoOutputChanged(DisplayOutputGeometry output);

        void onGlassesMessage(GlassesMessage message);

        void onNativePlaybackState(org.json.JSONObject state);
    }

    private final Activity activity;
    private final DisplayManager displayManager;
    private final Callback callback;
    private final DisplayManager.DisplayListener displayListener =
            new DisplayManager.DisplayListener()
            {
                @Override
                public void onDisplayAdded(int displayId)
                {
                    refreshDisplay();
                }

                @Override
                public void onDisplayRemoved(int displayId)
                {
                    refreshDisplay();
                }

                @Override
                public void onDisplayChanged(int displayId)
                {
                    refreshDisplay();
                }
            };

    private GlassesPresentation presentation;
    private GlassesWebViewController webController;
    private DisplayModeStateMachine.State displayState;
    private StereoScreenSettings stereoSettings = StereoScreenSettings.DEFAULT;
    private volatile DisplayOutputGeometry output = DisplayOutputGeometry.EMPTY;
    private volatile boolean stereoTestPattern;
    private int activeDisplayId = Display.INVALID_DISPLAY;
    private boolean started;
    private volatile boolean systemDisplayDisabled;

    GlassesPresentationController(
            Activity activity,
            DisplayModeStateMachine.State initialState,
            Callback callback)
    {
        this.activity = activity;
        displayManager = (DisplayManager) activity.getSystemService(Context.DISPLAY_SERVICE);
        displayState = initialState;
        this.callback = callback;
    }

    void start()
    {
        if (started)
        {
            return;
        }
        started = true;
        if (displayManager != null)
        {
            displayManager.registerDisplayListener(displayListener, null);
        }
        refreshDisplay();
    }

    void setForeground(boolean active)
    {
        if (webController != null) webController.setForeground(active);
    }

    void refresh()
    {
        refreshDisplay();
    }

    void stop()
    {
        if (!started)
        {
            return;
        }
        started = false;
        if (displayManager != null)
        {
            displayManager.unregisterDisplayListener(displayListener);
        }
        dismissPresentation();
        callback.onDisplayConnectionChanged(false);
    }

    void setDisplayState(DisplayModeStateMachine.State state)
    {
        boolean transitionEnded = displayState != null && displayState.displayModeTransitioning
                && !state.displayModeTransitioning;
        displayState = state;
        if (!state.displayModeApplied || state.displayModeTransitioning
                || !DisplayModeStateMachine.STEREO_SCREEN.equals(state.activeMode))
        {
            setStereoTestPattern(false);
        }
        if (presentation != null)
        {
            presentation.setDisplayState(state);
        }
        if (transitionEnded && started)
        {
            activity.getWindow().getDecorView().post(this::refreshDisplay);
        }
    }

    void setStereoScreenSettings(StereoScreenSettings settings)
    {
        stereoSettings = settings;
        if (webController != null)
        {
            webController.setStereoScreenSettings(settings);
        }
    }

    void setStereoTestPattern(boolean enabled)
    {
        stereoTestPattern = enabled && output.stereoReady && displayState.displayModeApplied
                && !displayState.displayModeTransitioning
                && DisplayModeStateMachine.STEREO_SCREEN.equals(displayState.activeMode);
        if (webController != null)
        {
            webController.setStereoTestPattern(stereoTestPattern);
        }
    }

    boolean isStereoTestPatternEnabled()
    {
        return stereoTestPattern;
    }

    DisplayOutputGeometry getOutputGeometry()
    {
        return output;
    }

    private void publishOutput(DisplayOutputGeometry next)
    {
        if (!output.sameAs(next))
        {
            output = next;
            callback.onStereoOutputChanged(next);
        }
    }

    boolean dispatchCommand(String command)
    {
        return presentation != null && presentation.dispatchCommand(command);
    }

    void refreshBootstrap()
    {
        if (presentation != null)
        {
            presentation.refreshBootstrap();
        }
    }

    boolean isConnected()
    {
        return activeDisplayId != Display.INVALID_DISPLAY;
    }

    boolean isSystemDisplayDisabled()
    {
        return systemDisplayDisabled;
    }

    private void refreshDisplay()
    {
        if (!started || activity.isFinishing())
        {
            return;
        }
        Display selected = findBestDisplay();
        int selectedId = selected == null ? Display.INVALID_DISPLAY : selected.getDisplayId();
        if (selected == null && displayState.displayModeTransitioning && webController != null)
        {
            // Full-SBS changes EDID. Android removes and recreates the logical display.
            // Retain the one WebView/video within the existing, bounded hardware transition.
            publishOutput(DisplayOutputGeometry.EMPTY);
            return;
        }
        if (selectedId == activeDisplayId && presentation != null && presentation.isShowing())
        {
            presentation.refreshOutput();
            return;
        }

        boolean retainWebView = displayState.displayModeTransitioning && webController != null;
        dismissPresentation(retainWebView);
        activeDisplayId = selectedId;
        if (selected == null)
        {
            callback.onDisplayConnectionChanged(false);
            return;
        }

        try
        {
            presentation = new GlassesPresentation(selected);
            presentation.show();
            callback.onDisplayConnectionChanged(true);
        }
        catch (RuntimeException exception)
        {
            Log.w("GlassesPresentation", "External window creation failed: "
                    + exception.getClass().getSimpleName());
            dismissPresentation();
            callback.onDisplayConnectionChanged(false);
        }
    }

    private Display findBestDisplay()
    {
        if (displayManager == null)
        {
            return null;
        }
        Set<Integer> presentationIds = new HashSet<>();
        for (Display display : displayManager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION))
        {
            if (display != null)
            {
                presentationIds.add(display.getDisplayId());
            }
        }

        Display[] displays = displayManager.getDisplays();
        Set<Integer> visibleIds = new HashSet<>();
        for (Display display : displays)
        {
            visibleIds.add(display.getDisplayId());
        }
        boolean previouslyDisabled = systemDisplayDisabled;
        systemDisplayDisabled = false;
        // Read-only Android connected-display category. Older releases return an empty array.
        for (Display display : displayManager.getDisplays("android.hardware.display.category.ALL_INCLUDING_DISABLED"))
        {
            if (display != null && display.getDisplayId() != Display.DEFAULT_DISPLAY
                    && !visibleIds.contains(display.getDisplayId())
                    && DisplaySelector.isGlassesName(display.getName()))
            {
                systemDisplayDisabled = true;
            }
        }
        if (previouslyDisabled != systemDisplayDisabled)
        {
            callback.onStereoOutputChanged(output);
        }
        if (BuildConfig.DEBUG)
        {
            Log.d("GlassesPresentation", "Visible display count: " + displays.length);
        }
        List<DisplaySelector.Candidate> candidates = new ArrayList<>();
        for (Display display : displays)
        {
            if (BuildConfig.DEBUG)
            {
                Log.d("GlassesPresentation", "Display " + display.getDisplayId()
                        + " valid=" + display.isValid() + " state=" + display.getState()
                        + " presentation=" + presentationIds.contains(display.getDisplayId()));
            }
            candidates.add(new DisplaySelector.Candidate(
                    display.getDisplayId(),
                    display.isValid(),
                    display.getState() == Display.STATE_ON,
                    presentationIds.contains(display.getDisplayId()),
                    display.getName()));
        }
        int index = DisplaySelector.selectBestIndex(candidates, Display.DEFAULT_DISPLAY);
        return index < 0 ? null : displays[index];
    }

    private void dismissPresentation()
    {
        dismissPresentation(false);
    }

    private void dismissPresentation(boolean retainWebView)
    {
        GlassesPresentation current = presentation;
        presentation = null;
        activeDisplayId = Display.INVALID_DISPLAY;
        stereoTestPattern = false;
        if (current != null)
        {
            current.release();
        }
        if (!retainWebView && webController != null)
        {
            webController.destroy();
            webController = null;
        }
        publishOutput(DisplayOutputGeometry.EMPTY);
        if (!retainWebView)
        {
            callback.onWebReadyChanged(false);
        }
    }

    private final class GlassesPresentation extends Presentation
    {
        private FrameLayout root;

        GlassesPresentation(Display display)
        {
            super(activity, display);
            setCancelable(false);
        }

        @Override
        protected void onCreate(Bundle savedInstanceState)
        {
            super.onCreate(savedInstanceState);
            Window window = getWindow();
            if (window != null)
            {
                window.requestFeature(Window.FEATURE_NO_TITLE);
                window.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(android.graphics.Color.BLACK));
                window.addFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
                        | WindowManager.LayoutParams.FLAG_FULLSCREEN
                        | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                window.getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
            }
            root = new FrameLayout(getContext());
            root.setBackgroundColor(android.graphics.Color.BLACK);
            setContentView(root);
            if (window != null)
            {
                window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            }
            root.addOnLayoutChangeListener((view, left, top, right, bottom,
                    oldLeft, oldTop, oldRight, oldBottom) -> refreshOutput());
            if (webController != null)
            {
                webController.attachTo(root);
                webController.setDisplayState(displayState);
                return;
            }
            webController = new GlassesWebViewController(
                    activity,
                    root,
                    callback,
                    new GlassesWebViewController.Callback()
                    {
                        @Override
                        public void onReadyChanged(boolean ready)
                        {
                            if (!ready)
                            {
                                setStereoTestPattern(false);
                            }
                            callback.onWebReadyChanged(ready);
                        }

                        @Override
                        public void onNativePlaybackState(org.json.JSONObject state)
                        {
                            callback.onNativePlaybackState(state);
                        }

                        @Override
                        public void onMessage(GlassesMessage message)
                        {
                            callback.onGlassesMessage(message);
                        }
                    });
            webController.setStereoScreenSettings(stereoSettings);
            webController.start(displayState);
        }

        void refreshOutput()
        {
            if (presentation != this)
            {
                return;
            }
            if (root == null || !isShowing() || !getDisplay().isValid())
            {
                publishOutput(DisplayOutputGeometry.EMPTY);
                return;
            }
            try
            {
                Display.Mode mode = getDisplay().getMode();
                publishOutput(new DisplayOutputGeometry(mode.getPhysicalWidth(), mode.getPhysicalHeight(),
                        root.getWidth(), root.getHeight(), mode.getRefreshRate()));
            }
            catch (RuntimeException ignored)
            {
                publishOutput(DisplayOutputGeometry.EMPTY);
            }
        }

        void setDisplayState(DisplayModeStateMachine.State state)
        {
            if (webController != null)
            {
                webController.setDisplayState(state);
            }
        }

        boolean dispatchCommand(String command)
        {
            return webController != null && webController.dispatchCommand(command);
        }

        void refreshBootstrap()
        {
            if (webController != null)
            {
                webController.refreshBootstrap();
            }
        }

        void release()
        {
            root = null;
            try
            {
                if (isShowing())
                {
                    dismiss();
                }
            }
            catch (RuntimeException ignored)
            {
            }
        }
    }
}
