package com.jellyfinforrayneo.client;

import android.annotation.SuppressLint;
import android.animation.ValueAnimator;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.graphics.Canvas;
import android.graphics.Bitmap;
import android.graphics.RenderNode;
import android.os.SystemClock;
import android.graphics.Color;
import android.graphics.Paint;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.os.Build;
import android.text.TextUtils;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class GlassesWebViewController
{
    private static final String GLASSES_URL = WebNavigationPolicy.GLASSES_ROOT + "index.html";
    private static final long RECREATE_DELAY_MS = 400L;
    private static final int MAX_REMOTE_COMMAND_LENGTH = 64;

    interface BootstrapProvider
    {
        JSONObject buildBootstrap();
    }

    interface Callback
    {
        void onReadyChanged(boolean ready);

        void onMessage(GlassesMessage message);

        void onNativePlaybackState(JSONObject state);
    }

    private FrameLayout root;
    private final Context rendererContext;
    private final BootstrapProvider bootstrapProvider;
    private final Callback callback;
    private final Runnable recreate = new Runnable()
    {
        @Override
        public void run()
        {
            if (!destroyed && root.isAttachedToWindow())
            {
                createWebView();
            }
        }
    };

    private StereoMirrorLayout webContainer;
    private NativePlaybackController nativePlayback;
    private View blackTransition;
    private WebView webView;
    private DisplayModeStateMachine.State displayState;
    private StereoScreenSettings stereoSettings = StereoScreenSettings.DEFAULT;
    private String lastBootstrap;
    private volatile RealtimeSbsController realtime;
    private int depthCatalogGeneration = -1;
    private boolean ready;
    private boolean destroyed;

    GlassesWebViewController(
            Context rendererContext,
            FrameLayout root,
            BootstrapProvider bootstrapProvider,
            Callback callback)
    {
        this.rendererContext = rendererContext;
        this.root = root;
        this.bootstrapProvider = bootstrapProvider;
        this.callback = callback;
    }

    void start(DisplayModeStateMachine.State state)
    {
        displayState = state;
        destroyed = false;
        createWebView();
    }

    void attachTo(FrameLayout nextRoot)
    {
        root.removeCallbacks(recreate);
        if (webContainer != null)
        {
            root.removeView(webContainer);
        }
        if (blackTransition != null)
        {
            root.removeView(blackTransition);
        }
        root = nextRoot;
        if (nativePlayback != null) nativePlayback.attachTo(nextRoot);
        if (webView == null)
        {
            createWebView();
            return;
        }
        root.addView(webContainer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(blackTransition, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        applyDisplayState();
    }

    void setForeground(boolean active)
    {
        if (nativePlayback != null) nativePlayback.foreground(active);
    }

    void setDisplayState(DisplayModeStateMachine.State state)
    {
        displayState = state;
        applyDisplayState();
        refreshBootstrap();
    }

    void setStereoScreenSettings(StereoScreenSettings settings)
    {
        stereoSettings = settings;
        if (webContainer != null)
        {
            webContainer.setScreenSettings(settings);
        }
    }

    void setStereoTestPattern(boolean enabled)
    {
        if (webContainer != null)
        {
            webContainer.setTestPattern(enabled);
        }
    }

    boolean dispatchCommand(String command)
    {
        if (!ready || webView == null || command == null
                || command.length() > MAX_REMOTE_COMMAND_LENGTH)
        {
            return false;
        }
        String quoted = JSONObject.quote(command);
        evaluateJavascript(
                "(function(command){"
                        + "window.dispatchEvent(new CustomEvent('rayneo-remote-command',"
                        + "{detail:command}));"
                        + "var keys={up:'ArrowUp',down:'ArrowDown',left:'ArrowLeft',"
                        + "right:'ArrowRight',enter:'Enter',back:'Escape'};"
                        + "var key=keys[command];"
                        + "var target=document.activeElement instanceof Element"
                        + "?document.activeElement:document.body;"
                        + "if(key&&target instanceof Element){target.dispatchEvent("
                        + "new KeyboardEvent('keydown',{key:key,bubbles:true,cancelable:true}));}"
                        + "})(" + quoted + ");");
        return true;
    }

    void refreshBootstrap()
    {
        if (!ready)
        {
            return;
        }
        JSONObject bootstrap = bootstrapProvider.buildBootstrap();
        int generation = bootstrap.optInt("catalogGeneration", -1);
        if (nativePlayback != null) nativePlayback.sessionChanged(generation, !bootstrap.isNull("session"));
        if (realtime != null && (generation != depthCatalogGeneration || bootstrap.isNull("session")))
        {
            realtime.stop(null);
        }
        depthCatalogGeneration = generation;
        String state = bootstrap.toString();
        if (state.equals(lastBootstrap))
        {
            return;
        }
        lastBootstrap = state;
        evaluateJavascript(
                "window.LucentNative && window.LucentNative.receiveBootstrapState && "
                        + "window.LucentNative.receiveBootstrapState("
                        + JSONObject.quote(state)
                        + ");");
    }

    void destroy()
    {
        destroyed = true;
        root.removeCallbacks(recreate);
        destroyWebView();
        if (blackTransition != null)
        {
            root.removeView(blackTransition);
            blackTransition = null;
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView()
    {
        destroyWebView();
        Context context = rendererContext;
        webContainer = new StereoMirrorLayout(root.getContext());
        webContainer.setScreenSettings(stereoSettings);
        webContainer.depthFailure = token ->
        {
            if (realtime != null)
            {
                realtime.rendererFailed(token);
            }
        };
        nativePlayback = new NativePlaybackController(context, root, state ->
        {
            callback.onNativePlaybackState(state);
            evaluateJavascript("window.dispatchEvent(new CustomEvent('tachi-native-playback',{detail:"
                    + state.toString() + "}));");
        });
        webContainer.geometryChanged = this::updateNativeGeometry;
        webContainer.setBackgroundColor(Color.TRANSPARENT);
        webContainer.setClipChildren(false);

        // Chromium retains the display used at construction. An EDID reconnect can
        // invalidate a Presentation's display while its compositor keeps the old DPI.
        // Keep the renderer on the Activity's stable display; measured View pixels and
        // the eye Canvas transforms still determine the external output dimensions.
        webView = new WebView(context);
        webView.setBackgroundColor(Color.TRANSPARENT);
        webView.setLayerType(View.LAYER_TYPE_NONE, null);
        webView.setSaveEnabled(false);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setSupportMultipleWindows(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setTextZoom(100);
        settings.setDefaultTextEncodingName("utf-8");
        settings.setSaveFormData(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);

        if ((context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0)
        {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.addJavascriptInterface(new GlassesBridge(webView), "RayNeoGlasses");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient()
        {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request)
            {
                return request == null
                        || request.getUrl() == null
                        || !WebNavigationPolicy.isGlassesAsset(request.getUrl().toString());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url)
            {
                return !WebNavigationPolicy.isGlassesAsset(url);
            }

            @Override
            public void onReceivedError(
                    WebView view,
                    WebResourceRequest request,
                    WebResourceError error)
            {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame())
                {
                    scheduleRecreate();
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail)
            {
                scheduleRecreate();
                return true;
            }
        });

        webContainer.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(webContainer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        if (blackTransition == null)
        {
            blackTransition = new View(context);
            blackTransition.setBackgroundColor(Color.BLACK);
            root.addView(blackTransition, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));
        }
        applyDisplayState();
        webView.loadUrl(GLASSES_URL);
    }

    private void scheduleRecreate()
    {
        setReady(false);
        root.removeCallbacks(recreate);
        root.post(() ->
        {
            destroyWebView();
            if (!destroyed)
            {
                root.postDelayed(recreate, RECREATE_DELAY_MS);
            }
        });
    }

    private void applyDisplayState()
    {
        if (webContainer == null || blackTransition == null)
        {
            return;
        }
        boolean transitioning = displayState != null && displayState.displayModeTransitioning;
        boolean stereo = displayState != null
                && displayState.displayModeApplied
                && DisplayModeStateMachine.STEREO_SCREEN.equals(displayState.activeMode);
        boolean drawStereo = !transitioning && stereo;
        if (!drawStereo && realtime != null)
        {
            realtime.stop(null);
        }
        // Mirror uses WebView's normal hardware rendering. Stereo retains one
        // texture so both eye draws sample the same completed WebView frame.
        int layerType = drawStereo ? View.LAYER_TYPE_HARDWARE : View.LAYER_TYPE_NONE;
        if (webView != null && webView.getLayerType() != layerType)
        {
            webView.setLayerType(layerType, null);
        }
        webContainer.setStereo(drawStereo);
        updateNativeGeometry();
        webContainer.setVisibility(transitioning ? View.INVISIBLE : View.VISIBLE);
        blackTransition.setVisibility(transitioning ? View.VISIBLE : View.GONE);
        if (transitioning)
        {
            blackTransition.bringToFront();
        }
        else
        {
            webContainer.bringToFront();
        }
    }

    private void updateNativeGeometry()
    {
        if (nativePlayback == null || webContainer == null) return;
        boolean transitioning = displayState != null && displayState.displayModeTransitioning;
        StereoScreenGeometry geometry = webContainer.geometry;
        nativePlayback.geometry(webContainer.stereo && geometry != null, transitioning,
                geometry == null ? 1f : geometry.scale,
                geometry == null ? 0f : geometry.disparity / geometry.eyeWidth);
    }

    private void evaluateJavascript(String script)
    {
        WebView current = webView;
        if (current != null && !destroyed && !TextUtils.isEmpty(script))
        {
            current.post(() ->
            {
                if (current == webView && !destroyed)
                {
                    current.evaluateJavascript(script, null);
                }
            });
        }
    }

    private void setReady(boolean next)
    {
        if (ready == next)
        {
            return;
        }
        ready = next;
        callback.onReadyChanged(next);
    }

    private void destroyWebView()
    {
        if (nativePlayback != null)
        {
            nativePlayback.close();
            nativePlayback = null;
        }
        if (realtime != null)
        {
            realtime.close();
            realtime = null;
        }
        setReady(false);
        lastBootstrap = null;
        WebView current = webView;
        StereoMirrorLayout container = webContainer;
        webView = null;
        webContainer = null;
        if (current != null)
        {
            current.removeJavascriptInterface("RayNeoGlasses");
            current.stopLoading();
            if (container != null)
            {
                container.removeView(current);
            }
            current.destroy();
        }
        if (container != null)
        {
            root.removeView(container);
        }
    }

    private final class GlassesBridge
    {
        private final WebView source;

        GlassesBridge(WebView source)
        {
            this.source = source;
        }

        @JavascriptInterface
        public String getBootstrapState()
        {
            return bootstrapProvider.buildBootstrap().toString();
        }

        @JavascriptInterface
        public boolean nativePlaybackAvailable()
        {
            return true;
        }

        @JavascriptInterface
        public void nativePlaybackCommand(String payload)
        {
            if (payload == null || payload.length() > 16_384) return;
            root.post(() ->
            {
                if (destroyed || source != webView || nativePlayback == null) return;
                NativePlaybackRequest request = NativePlaybackRequest.parse(payload, bootstrapProvider.buildBootstrap());
                if (request != null) nativePlayback.command(request);
                else
                {
                    JSONObject event = new JSONObject();
                    try { event.put("event", "command_rejected"); }
                    catch (org.json.JSONException ignored) { return; }
                    callback.onNativePlaybackState(event);
                }
            });
        }

        @JavascriptInterface
        public void playbackDiagnostic(String payload)
        {
            if (payload == null || payload.length() > 1024) return;
            root.post(() ->
            {
                if (destroyed || source != webView) return;
                JSONObject event = NativePlaybackDiagnostics.parseEvent(payload, bootstrapProvider.buildBootstrap());
                if (event != null) callback.onNativePlaybackState(event);
            });
        }

        @JavascriptInterface
        public boolean realtimeSbsAvailable()
        {
            return RealtimeDepthBackend.available();
        }

        @JavascriptInterface
        public void startRealtimeSbs(String token)
        {
            if (!DepthFrame.validToken(token))
            {
                return;
            }
            root.post(() ->
            {
                if (source != webView || destroyed || realtime == null)
                {
                    return;
                }
                if (!RealtimeDepthBackend.available() || displayState == null
                        || !displayState.displayModeApplied || displayState.displayModeTransitioning
                        || !DisplayModeStateMachine.STEREO_SCREEN.equals(displayState.activeMode)
                        || bootstrapProvider.buildBootstrap().isNull("session"))
                {
                    evaluateJavascript("window.dispatchEvent(new CustomEvent('tachi-depth',{detail:{token:"
                            + JSONObject.quote(token) + ",status:'error',sequence:0}}));");
                    return;
                }
                realtime.start(token);
            });
        }

        @JavascriptInterface
        public void stopRealtimeSbs(String token)
        {
            if (!DepthFrame.validToken(token))
            {
                return;
            }
            root.post(() ->
            {
                if (source == webView && realtime != null)
                {
                    realtime.stop(token);
                }
            });
        }

        @JavascriptInterface
        public boolean submitRealtimeFrame(String payload)
        {
            RealtimeSbsController controller = realtime;
            return source == webView && controller != null && controller.offer(payload);
        }

        @JavascriptInterface
        public String getNativeAudioCodecs()
        {
            Set<String> codecs = new LinkedHashSet<>();
            try
            {
                for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.ALL_CODECS).getCodecInfos())
                {
                    if (info.isEncoder()) continue;
                    for (String type : info.getSupportedTypes())
                    {
                        switch (type)
                        {
                            case "audio/mp4a-latm": codecs.add("aac"); break;
                            case "audio/mpeg": codecs.add("mp3"); break;
                            case "audio/ac3": codecs.add("ac3"); break;
                            case "audio/eac3": codecs.add("eac3"); break;
                            case "audio/opus": codecs.add("opus"); break;
                            case "audio/vorbis": codecs.add("vorbis"); break;
                            case "audio/flac": codecs.add("flac"); break;
                            default: break;
                        }
                    }
                }
            }
            catch (RuntimeException ignored) { codecs.clear(); }
            return new JSONArray(codecs).toString();
        }

        @JavascriptInterface
        public String getHardwareVideoCodecs()
        {
            Set<String> codecs = new LinkedHashSet<>();
            try
            {
                MediaCodecInfo[] codecInfos = new MediaCodecList(
                        MediaCodecList.ALL_CODECS).getCodecInfos();
                for (MediaCodecInfo codecInfo : codecInfos)
                {
                    if (codecInfo == null
                            || codecInfo.isEncoder()
                            || !isHardwareAccelerated(codecInfo))
                    {
                        continue;
                    }
                    for (String mimeType : codecInfo.getSupportedTypes())
                    {
                        String codec = videoCodecForMimeType(mimeType);
                        if (!codec.isEmpty())
                        {
                            codecs.add(codec);
                        }
                    }
                }
            }
            catch (RuntimeException ignored)
            {
                codecs.clear();
            }

            JSONArray result = new JSONArray();
            for (String codec : codecs)
            {
                result.put(codec);
            }
            return result.toString();
        }

        @JavascriptInterface
        public void ready()
        {
            root.post(() ->
            {
                if (!destroyed && source == webView)
                {
                    setReady(true);
                    refreshBootstrap();
                }
            });
        }

        @JavascriptInterface
        public void postMessage(String payload)
        {
            GlassesMessage message = GlassesMessage.parse(payload);
            if (message != null)
            {
                root.post(() ->
                {
                    if (!destroyed && source == webView)
                    {
                        callback.onMessage(message);
                    }
                });
            }
        }
    }

    private static boolean isHardwareAccelerated(MediaCodecInfo codecInfo)
    {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        {
            return codecInfo.isHardwareAccelerated();
        }
        String name = codecInfo.getName().toLowerCase(Locale.ROOT);
        return !name.startsWith("omx.google.")
                && !name.startsWith("c2.android.")
                && !name.startsWith("c2.google.")
                && !name.contains(".sw.")
                && !name.endsWith(".sw");
    }

    private static String videoCodecForMimeType(String mimeType)
    {
        if (mimeType == null)
        {
            return "";
        }
        switch (mimeType.toLowerCase(Locale.ROOT))
        {
            case "video/avc":
                return "h264";
            case "video/hevc":
                return "hevc";
            case "video/x-vnd.on2.vp8":
                return "vp8";
            case "video/x-vnd.on2.vp9":
                return "vp9";
            case "video/av01":
                return "av1";
            default:
                return "";
        }
    }

    static final class StereoMirrorLayout extends FrameLayout
    {
        private boolean stereo;
        private RealtimeEyeEffect depthEffect;
        private java.util.function.Consumer<String> depthFailure;
        private String depthToken;

        void clearDepth()
        {
            depthToken = null;
            if (Build.VERSION.SDK_INT >= 33 && depthEffect != null)
            {
                depthEffect.clear();
                depthEffect = null;
            }
            invalidate();
        }

        void setDepth(Bitmap bitmap, DepthFrame frame)
        {
            if (Build.VERSION.SDK_INT < 33 || !stereo || getChildCount() == 0)
            {
                return;
            }
            if (depthEffect == null)
            {
                depthEffect = new RealtimeEyeEffect();
            }
            View child = getChildAt(0);
            depthEffect.update(bitmap, frame, child.getWidth(), child.getHeight());
            depthToken = frame.token;
            invalidate();
        }

        private boolean testPattern;
        private StereoScreenSettings settings = StereoScreenSettings.DEFAULT;
        private float normalizedDisparity = settings.normalizedDisparity();
        private float sizeFraction = settings.sizeFraction();
        private StereoScreenGeometry geometry;
        private Runnable geometryChanged;
        private ValueAnimator settingsAnimator;
        private final Paint patternPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

        StereoMirrorLayout(Context context)
        {
            super(context);
            setWillNotDraw(false);
        }

        void setStereo(boolean enabled)
        {
            if (stereo == enabled)
            {
                return;
            }
            stereo = enabled;
            if (!enabled)
            {
                clearDepth();
                testPattern = false;
                finishSettingsAnimation();
            }
            requestLayout();
            invalidate();
        }

        void setScreenSettings(StereoScreenSettings next)
        {
            if (settings.sameAs(next))
            {
                return;
            }
            if (settingsAnimator != null)
            {
                settingsAnimator.cancel();
            }
            settings = next;
            if (!canAnimateSettings() || !ValueAnimator.areAnimatorsEnabled())
            {
                finishSettingsAnimation();
                return;
            }
            float startDisparity = normalizedDisparity;
            float startSize = sizeFraction;
            settingsAnimator = ValueAnimator.ofFloat(0f, 1f);
            settingsAnimator.setDuration(180L);
            settingsAnimator.addUpdateListener(animation ->
            {
                float fraction = (float) animation.getAnimatedValue();
                normalizedDisparity = Math.max(0f, Math.min(StereoScreenGeometry.MAX_NORMALIZED_DISPARITY,
                        startDisparity + (next.normalizedDisparity() - startDisparity) * fraction));
                sizeFraction = Math.max(StereoScreenSettings.MIN_SIZE_PERCENT / 100f,
                        Math.min(StereoScreenSettings.MAX_SIZE_PERCENT / 100f,
                                startSize + (next.sizeFraction() - startSize) * fraction));
                updateGeometry();
            });
            settingsAnimator.start();
        }

        void setTestPattern(boolean enabled)
        {
            testPattern = enabled && stereo;
            invalidate();
        }

        private void finishSettingsAnimation()
        {
            if (settingsAnimator != null)
            {
                settingsAnimator.cancel();
                settingsAnimator = null;
            }
            normalizedDisparity = settings.normalizedDisparity();
            sizeFraction = settings.sizeFraction();
            updateGeometry();
        }

        private void updateGeometry()
        {
            geometry = StereoScreenGeometry.create(getWidth(), getHeight(), normalizedDisparity, sizeFraction);
            if (geometryChanged != null) geometryChanged.run();
            // Only the Canvas transform changes; the WebView viewport and video remain intact.
            invalidate();
        }

        private boolean canAnimateSettings()
        {
            return stereo && isAttachedToWindow() && isShown() && getWindowVisibility() == View.VISIBLE;
        }

        @Override
        public void onDescendantInvalidated(View child, View target)
        {
            super.onDescendantInvalidated(child, target);
            if (stereo)
            {
                // WebView invalidates for video, CSS motion, DOM and scroll changes.
                // Redraw both transformed copies together, and let unchanged frames
                // sleep instead of scheduling a second, unconditional vsync loop.
                invalidate();
            }
        }

        @Override
        protected void onDetachedFromWindow()
        {
            finishSettingsAnimation();
            super.onDetachedFromWindow();
        }

        @Override
        protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight)
        {
            clearDepth();
            super.onSizeChanged(width, height, oldWidth, oldHeight);
            updateGeometry();
        }

        private int sourceWidth(int width, int height)
        {
            return stereo && StereoScreenGeometry.hasFullSbsAspect(width, height) ? width / 2 : width;
        }

        @Override
        protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec)
        {
            super.onMeasure(widthMeasureSpec, heightMeasureSpec);
            int childWidth = sourceWidth(getMeasuredWidth(), getMeasuredHeight());
            int childWidthSpec = MeasureSpec.makeMeasureSpec(childWidth, MeasureSpec.EXACTLY);
            int childHeightSpec = MeasureSpec.makeMeasureSpec(getMeasuredHeight(), MeasureSpec.EXACTLY);
            for (int index = 0; index < getChildCount(); index++)
            {
                getChildAt(index).measure(childWidthSpec, childHeightSpec);
            }
        }

        @Override
        protected void onLayout(boolean changed, int left, int top, int right, int bottom)
        {
            int childWidth = sourceWidth(right - left, bottom - top);
            int childHeight = bottom - top;
            for (int index = 0; index < getChildCount(); index++)
            {
                getChildAt(index).layout(0, 0, childWidth, childHeight);
            }
        }

        @Override
        protected void dispatchDraw(Canvas canvas)
        {
            if (!stereo || geometry == null || getChildCount() == 0)
            {
                super.dispatchDraw(canvas);
                return;
            }

            View child = getChildAt(0);
            long drawingTime = getDrawingTime();
            // Both eyes use the same held map until replacement or explicit lifecycle cleanup.
            boolean useDepth = Build.VERSION.SDK_INT >= 33 && canvas.isHardwareAccelerated()
                    && depthEffect != null;
            if (useDepth && Build.VERSION.SDK_INT >= 33)
            {
                try
                {
                    recordEye(depthEffect.left, child, drawingTime);
                    recordEye(depthEffect.right, child, drawingTime);
                }
                catch (RuntimeException failure)
                {
                    String failedToken = depthToken;
                    clearDepth();
                    if (depthFailure != null)
                    {
                        post(() -> depthFailure.accept(failedToken));
                    }
                    useDepth = false;
                }
            }
            drawEye(canvas, child, drawingTime, true, useDepth);
            drawEye(canvas, child, drawingTime, false, useDepth);
        }

        @androidx.annotation.RequiresApi(33)
        private void recordEye(RenderNode node, View child, long drawingTime)
        {
            Canvas recording = node.beginRecording(child.getWidth(), child.getHeight());
            try
            {
                drawChild(recording, child, drawingTime);
            }
            finally
            {
                node.endRecording();
            }
        }

        private void drawEye(Canvas canvas, View child, long drawingTime, boolean left, boolean useDepth)
        {
            StereoScreenGeometry frame = geometry;
            int eyeSave = canvas.save();
            canvas.translate(left ? 0f : frame.eyeWidth, 0f);
            canvas.clipRect(0, 0, frame.eyeWidth, frame.height);
            int contentSave = canvas.save();
            // d = uL - uR. Translate in final eye pixels BEFORE scale, so size does not change d.
            canvas.translate(left ? frame.leftX : frame.rightX, frame.top);
            canvas.scale(frame.scale, frame.scale);
            if (Build.VERSION.SDK_INT >= 33 && useDepth)
            {
                canvas.drawRenderNode(left ? depthEffect.left : depthEffect.right);
            }
            else
            {
                drawChild(canvas, child, drawingTime);
            }
            if (testPattern)
            {
                drawTarget(canvas, frame);
            }
            canvas.restoreToCount(contentSave);
            if (testPattern)
            {
                drawReference(canvas, frame, left);
            }
            canvas.restoreToCount(eyeSave);
        }

        private void drawTarget(Canvas canvas, StereoScreenGeometry frame)
        {
            patternPaint.setColor(Color.rgb(80, 235, 225));
            patternPaint.setStrokeWidth(Math.max(1.5f, frame.eyeWidth / 640f));
            patternPaint.setStyle(Paint.Style.STROKE);
            canvas.drawRect(frame.eyeWidth * .2f, frame.height * .2f,
                    frame.eyeWidth * .8f, frame.height * .8f, patternPaint);
            canvas.drawLine(frame.eyeWidth * .46f, frame.height * .5f,
                    frame.eyeWidth * .54f, frame.height * .5f, patternPaint);
            canvas.drawLine(frame.eyeWidth * .5f, frame.height * .44f,
                    frame.eyeWidth * .5f, frame.height * .56f, patternPaint);
        }

        private void drawReference(Canvas canvas, StereoScreenGeometry frame, boolean left)
        {
            patternPaint.setColor(Color.WHITE);
            patternPaint.setStrokeWidth(Math.max(1.5f, frame.eyeWidth / 640f));
            patternPaint.setStyle(Paint.Style.STROKE);
            // The white reference has zero added disparity; the cyan target shares the video's transform.
            canvas.drawRect(frame.eyeWidth * .06f, frame.height * .06f,
                    frame.eyeWidth * .94f, frame.height * .94f, patternPaint);
            patternPaint.setStyle(Paint.Style.FILL);
            patternPaint.setTextSize(frame.height * .05f);
            canvas.drawText(left ? "L" : "R", frame.eyeWidth * .09f, frame.height * .14f, patternPaint);
        }
    }
}
