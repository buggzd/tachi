package com.jellyfinforrayneo.client;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public final class MainActivity extends Activity
{
    private static final int MAX_PASSWORD_LENGTH = 4_096;
    private static final int MAX_SCREEN_LENGTH = 32;

    private final ArrayList<JellyfinDiscoveryService.Server> discoveredServers =
            new ArrayList<>();
    private final DiagnosticLog diagnosticLog = new DiagnosticLog();
    private final NativePlaybackDiagnostics nativePlaybackDiagnostics = new NativePlaybackDiagnostics();
    private final PlaybackSnapshot playback = new PlaybackSnapshot();

    private SessionRepository sessions;
    private JellyfinAuthenticationService authentication;
    private JellyfinDiscoveryService discovery;
    private RemoteCommandRouter remoteCommands;
    private VolumeKeyController volumeKeys;
    private RayNeoDisplayController rayNeoDisplay;
    private GlassesPresentationController glassesPresentation;
    private CompanionWebViewController companionWebView;
    private CompanionBackground companionBackground;
    private DiagnosticReportExporter diagnosticExporter;
    private String lastCompanionBackgroundUrl = "";

    private String state = "login_required";
    private String message = "请选择 Jellyfin 服务器并登录。";
    private String selectedServerUrl = "";
    private String selectedServerName = "";
    private String selectedUserName = "";
    private String quickConnectCode = "";
    private String discoveryMessage = "";
    private String webScreen = "connect";
    private String glassesRuntimeState = "booting";
    private String glassesRuntimeErrorCode = "none";
    private String glassesSearchQuery = "";
    private int glassesCatalogGeneration;
    private boolean error;
    private boolean busy;
    private boolean discoveryScanning;
    private boolean glassesWebReady;
    private boolean glassesSearchActive;
    private boolean destroyed;

    @Override
    protected void onCreate(Bundle savedInstanceState)
    {
        super.onCreate(savedInstanceState);
        diagnosticExporter = new DiagnosticReportExporter(this);
        diagnosticLog.record(DiagnosticLog.Event.APP_CREATED);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);

        sessions = new SessionRepository(getSharedPreferences(
                SessionRepository.PREFERENCES_NAME,
                Context.MODE_PRIVATE));
        restoreSessionState();

        remoteCommands = new RemoteCommandRouter();
        AudioManager mediaAudio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (mediaAudio != null)
        {
            volumeKeys = new VolumeKeyController(
                    new VolumeKeyController.AudioOutput()
                    {
                        @Override
                        public void adjust(int direction)
                        {
                            mediaAudio.adjustStreamVolume(
                                    AudioManager.STREAM_MUSIC,
                                    direction,
                                    AudioManager.FLAG_SHOW_UI);
                        }

                        @Override
                        public int getCurrentVolume()
                        {
                            return mediaAudio.getStreamVolume(AudioManager.STREAM_MUSIC);
                        }

                        @Override
                        public int getMaximumVolume()
                        {
                            return mediaAudio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                        }
                    },
                    percentage -> remoteCommands.submitVolume(percentage));
        }
        rayNeoDisplay = new RayNeoDisplayController(
                this,
                sessions.getDisplayMode(),
                this::onDisplayModeStateChanged);
        rayNeoDisplay.start();

        glassesPresentation = new GlassesPresentationController(
                this,
                rayNeoDisplay.getState(),
                new GlassesPresentationController.Callback()
                {
                    @Override
                    public void onDisplayConnectionChanged(boolean connected)
                    {
                        diagnosticLog.record(connected
                                ? DiagnosticLog.Event.GLASSES_CONNECTED
                                : DiagnosticLog.Event.GLASSES_DISCONNECTED);
                        rayNeoDisplay.setConnected(connected);
                        pushCompanionState();
                    }

                    @Override
                    public void onStereoOutputChanged(DisplayOutputGeometry output)
                    {
                        rayNeoDisplay.setSystemDisplayDisabled(glassesPresentation != null
                                && glassesPresentation.isSystemDisplayDisabled());
                        rayNeoDisplay.setOutputGeometry(output);
                        pushCompanionState();
                    }

                    @Override
                    public void onWebReadyChanged(boolean ready)
                    {
                        diagnosticLog.record(ready
                                ? DiagnosticLog.Event.GLASSES_WEB_READY
                                : DiagnosticLog.Event.GLASSES_WEB_NOT_READY);
                        glassesWebReady = ready;
                        if (!ready)
                        {
                            glassesRuntimeState = "booting";
                            glassesRuntimeErrorCode = "none";
                            glassesSearchActive = false;
                            glassesSearchQuery = "";
                            if (companionWebView != null)
                            {
                                companionWebView.hideSearchKeyboard();
                            }
                            if (sessions != null && sessions.hasSession())
                            {
                                state = "session_ready";
                                message = "眼镜端正在启动，Jellyfin 会话仍保存在手机中。";
                                error = false;
                            }
                        }
                        remoteCommands.setReady(ready);
                        pushCompanionState();
                    }

                    @Override
                    public void onNativePlaybackState(JSONObject state)
                    {
                        nativePlaybackDiagnostics.record(state, diagnosticLog.elapsedMilliseconds());
                    }

                    @Override
                    public void onGlassesMessage(GlassesMessage message)
                    {
                        handleGlassesMessage(message);
                    }

                    @Override
                    public JSONObject buildBootstrap()
                    {
                        return buildGlassesBootstrap();
                    }
                });
        glassesPresentation.setStereoScreenSettings(sessions.getStereoScreenSettings());
        remoteCommands.setSink(glassesPresentation::dispatchCommand);

        authentication = new JellyfinAuthenticationService(
                sessions,
                Build.MODEL,
                new JellyfinAuthenticationService.Callback()
                {
                    @Override
                    public void onQuickConnectCode(int generation, String code)
                    {
                        runOnUiThread(() ->
                        {
                            if (destroyed || !authentication.isCurrent(generation))
                            {
                                return;
                            }
                            diagnosticLog.record(DiagnosticLog.Event.AUTH_QUICK_CODE_RECEIVED);
                            state = "quick_connect_waiting";
                            message = "请在 Jellyfin App 或网页中确认此登录码。";
                            quickConnectCode = code;
                            error = false;
                            pushCompanionState();
                        });
                    }

                    @Override
                    public void onAuthenticated(
                            int generation,
                            SessionPayload session,
                            boolean persist)
                    {
                        runOnUiThread(() ->
                        {
                            if (!destroyed && authentication.isCurrent(generation))
                            {
                                finishAuthentication(session, persist);
                            }
                        });
                    }

                    @Override
                    public void onError(int generation, String failureMessage)
                    {
                        runOnUiThread(() ->
                        {
                            if (destroyed || !authentication.isCurrent(generation))
                            {
                                return;
                            }
                            diagnosticLog.record(DiagnosticLog.Event.AUTH_FAILED);
                            busy = false;
                            state = "login_required";
                            message = failureMessage;
                            quickConnectCode = "";
                            error = true;
                            pushCompanionState();
                        });
                    }
                });
        discovery = new JellyfinDiscoveryService(
                this,
                (generation, servers, failed) -> runOnUiThread(
                        () ->
                        {
                            if (!destroyed && discovery.isCurrent(generation))
                            {
                                finishDiscovery(servers, failed);
                            }
                        }));

        companionBackground = new CompanionBackground(this, this::onCompanionBackgroundChanged, this::localizeMessage);
        lastCompanionBackgroundUrl = companionBackground.getUrl();
        companionWebView = new CompanionWebViewController(
                this,
                new CompanionBridge(),
                this::buildCompanionStateJson,
                companionBackground);
        setContentView(companionWebView.getView());
        updatePhoneSurface();
        companionWebView.start();
        glassesPresentation.start();

        if (!sessions.hasSession())
        {
            companionWebView.getView().postDelayed(this::startDiscovery, 500L);
        }
    }

    @Override
    protected void onResume()
    {
        super.onResume();
        diagnosticLog.record(DiagnosticLog.Event.APP_RESUMED);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (glassesPresentation != null)
        {
            glassesPresentation.refresh();
            glassesPresentation.setForeground(true);
        }
        if (rayNeoDisplay != null)
        {
            rayNeoDisplay.onResume();
        }
    }

    @Override
    protected void onStop()
    {
        if (glassesPresentation != null) glassesPresentation.setForeground(false);
        super.onStop();
    }

    @Override
    protected void onPause()
    {
        diagnosticLog.record(DiagnosticLog.Event.APP_PAUSED);
        if (rayNeoDisplay != null)
        {
            rayNeoDisplay.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data)
    {
        super.onActivityResult(requestCode, resultCode, data);
        if (companionBackground != null)
        {
            companionBackground.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    protected void onDestroy()
    {
        diagnosticLog.record(DiagnosticLog.Event.APP_DESTROYED);
        destroyed = true;
        if (diagnosticExporter != null) diagnosticExporter.close();
        if (companionBackground != null)
        {
            companionBackground.close();
        }
        if (authentication != null)
        {
            authentication.close();
        }
        if (discovery != null)
        {
            discovery.close();
        }
        if (companionWebView != null)
        {
            companionWebView.destroy();
        }
        if (glassesPresentation != null)
        {
            glassesPresentation.stop();
        }
        if (rayNeoDisplay != null)
        {
            rayNeoDisplay.destroy();
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed()
    {
        if ("touchpad".equals(webScreen))
        {
            remoteCommands.submit("back");
            companionWebView.haptic(true);
            companionWebView.handleBack();
            return;
        }
        if ("settings".equals(webScreen) || "auth".equals(webScreen)
                || "accounts".equals(webScreen)
                || ("connect".equals(webScreen) && sessions.hasSession()))
        {
            companionWebView.handleBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event)
    {
        if (event != null)
        {
            int volumeDirection = VolumeKeyController.directionForKey(event.getKeyCode());
            if (volumeKeys != null && volumeKeys.handle(volumeDirection, event.getAction()))
            {
                return true;
            }
            if (event.getAction() == KeyEvent.ACTION_DOWN)
            {
                String command = commandForKey(event.getKeyCode());
                if (command != null && remoteCommands.submit(command))
                {
                    return true;
                }
            }
        }
        return super.dispatchKeyEvent(event);
    }

    private void restoreSessionState()
    {
        SessionPayload session = sessions.getSession();
        if (session != null)
        {
            diagnosticLog.record(DiagnosticLog.Event.SESSION_RESTORED);
            selectedServerUrl = session.getServerUrl();
            selectedServerName = session.getServerName();
            selectedUserName = session.getUserName();
            state = "session_ready";
            message = "Jellyfin 会话已恢复，连接眼镜后会自动同步媒体库。";
        }
        else
        {
            diagnosticLog.record(DiagnosticLog.Event.SESSION_EMPTY);
            selectedServerUrl = normalizedServerInput(sessions.getServerHint());
            selectedUserName = bounded(
                    sessions.getUserNameHint(),
                    SessionPayload.MAX_USER_NAME_LENGTH).trim();
            sessions.setServerHint(selectedServerUrl);
            sessions.setUserNameHint(selectedUserName);
        }
    }

    private void finishAuthentication(SessionPayload session, boolean persist)
    {
        if (destroyed || session == null)
        {
            return;
        }
        if (!sessions.save(session, persist))
        {
            authentication.cancel();
            quickConnectCode = "";
            state = sessions.hasSession() ? "session_ready" : "login_required";
            busy = false;
            error = true;
            message = "最多保留 12 个账号，请先移除一个不再使用的账号。";
            companionWebView.openScreen("accounts");
            pushCompanionState();
            return;
        }
        diagnosticLog.record(persist
                ? DiagnosticLog.Event.AUTH_SUCCEEDED_PERSISTED
                : DiagnosticLog.Event.AUTH_SUCCEEDED_EPHEMERAL);
        showActiveSession(session, persist
                ? "Jellyfin 会话已保存，正在同步眼镜媒体库。"
                : "Jellyfin 已连接；会话仅在本次运行期间保留。");
    }

    private void showActiveSession(SessionPayload session, String statusMessage)
    {
        authentication.cancel();
        clearActiveRuntime();
        selectedServerUrl = session.getServerUrl();
        selectedServerName = session.getServerName();
        selectedUserName = session.getUserName();
        state = "session_ready";
        message = statusMessage;
        quickConnectCode = "";
        glassesRuntimeState = "loading";
        glassesRuntimeErrorCode = "none";
        advanceGlassesCatalogGeneration();
        busy = false;
        error = false;
        discovery.cancel();
        discoveryScanning = false;
        glassesPresentation.refreshBootstrap();
        companionWebView.openScreen("home");
        pushCompanionState();
    }

    private void clearActiveRuntime()
    {
        glassesPresentation.setStereoTestPattern(false);
        remoteCommands.clear();
        playback.clear();
        glassesSearchActive = false;
        glassesSearchQuery = "";
        companionWebView.hideSearchKeyboard();
    }

    private void clearSession(boolean unauthorized)
    {
        clearActiveRuntime();
        authentication.cancel();
        diagnosticLog.record(unauthorized
                ? DiagnosticLog.Event.SESSION_UNAUTHORIZED
                : DiagnosticLog.Event.SESSION_CLEARED);
        sessions.clear();
        advanceGlassesCatalogGeneration();
        quickConnectCode = "";
        glassesRuntimeState = "no-session";
        glassesRuntimeErrorCode = "none";
        state = "login_required";
        message = unauthorized
                ? "Jellyfin 会话已失效，请在手机端重新登录。"
                : "Jellyfin 会话已清除，请重新选择服务器并登录。";
        busy = false;
        error = unauthorized;
        glassesPresentation.refreshBootstrap();
        companionWebView.openScreen(sessions.accountSummaries().length() > 0 ? "accounts" : "connect");
        pushCompanionState();
    }

    private void startDiscovery()
    {
        if (destroyed || busy || discoveryScanning)
        {
            return;
        }
        discoveryScanning = true;
        diagnosticLog.record(DiagnosticLog.Event.DISCOVERY_STARTED);
        discoveryMessage = "正在搜索同一 Wi-Fi 中的 Jellyfin 服务器…";
        discoveredServers.clear();
        discovery.scan();
        pushCompanionState();
    }

    private void finishDiscovery(List<JellyfinDiscoveryService.Server> servers, boolean failed)
    {
        if (destroyed)
        {
            return;
        }
        discoveryScanning = false;
        discoveredServers.clear();
        discoveredServers.addAll(servers);
        diagnosticLog.record(failed
                ? DiagnosticLog.Event.DISCOVERY_FAILED
                : servers.isEmpty()
                        ? DiagnosticLog.Event.DISCOVERY_EMPTY
                        : DiagnosticLog.Event.DISCOVERY_FOUND);
        if (servers.isEmpty())
        {
            discoveryMessage = failed
                    ? "自动发现失败，请手动输入服务器地址。"
                    : "未发现服务器，请确认手机与 Jellyfin 在同一 Wi-Fi。";
        }
        else
        {
            discoveryMessage = "发现 " + servers.size() + " 台 Jellyfin 服务器。";
            if (servers.size() == 1 && selectedServerUrl.trim().isEmpty())
            {
                selectedServerUrl = servers.get(0).address;
                selectedServerName = servers.get(0).name;
            }
        }
        pushCompanionState();
    }

    private void onDisplayModeStateChanged(DisplayModeStateMachine.State displayState)
    {
        // Keep the remote usable while this Activity is visible; this flag does not survive leaving the app.
        if (displayState.connected)
        {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        else
        {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        recordDisplayDiagnostic(displayState);
        if (glassesPresentation != null)
        {
            glassesPresentation.setDisplayState(displayState);
        }
        pushCompanionState();
    }

    private void handleGlassesMessage(GlassesMessage incoming)
    {
        if (incoming == null)
        {
            return;
        }
        switch (incoming.type)
        {
            case SET_UI_THEME:
                applyUiThemePreference(incoming.preferenceValue);
                break;
            case SET_LANGUAGE:
                applyLanguagePreference(incoming.preferenceValue);
                break;
            case SET_SUBTITLE_SIZE:
                applySubtitleSizePreference(incoming.preferenceValue);
                break;
            case MANAGE_LOGIN:
                companionWebView.openScreen(sessions.hasSession() ? "settings" : "connect");
                break;
            case LOGOUT:
                clearSession(false);
                break;
            case UNAUTHORIZED:
                if (incoming.catalogGeneration == glassesCatalogGeneration)
                {
                    clearSession(true);
                }
                break;
            case PLAYBACK_STATE:
                playback.update(incoming);
                pushCompanionState();
                break;
            case RUNTIME_STATE:
                recordRuntimeDiagnostic(incoming);
                glassesRuntimeState = incoming.state;
                glassesRuntimeErrorCode = incoming.errorCode;
                if ("auth".equals(webScreen))
                {
                    pushCompanionState();
                    break;
                }
                if ("error".equals(incoming.state))
                {
                    state = "glasses_error";
                    message = glassesRuntimeErrorMessage(incoming.errorCode);
                    error = true;
                }
                else if ("ready".equals(incoming.state))
                {
                    state = "ready";
                    message = "Jellyfin 已连接，媒体库正在眼镜中显示。";
                    error = false;
                }
                else if ("loading".equals(incoming.state))
                {
                    state = sessions.hasSession() ? "session_ready" : "login_required";
                    message = sessions.hasSession()
                            ? "眼镜端正在连接 Jellyfin 并加载媒体库。"
                            : "请先在手机端登录 Jellyfin。";
                    error = false;
                }
                else if ("booting".equals(incoming.state))
                {
                    state = sessions.hasSession() ? "session_ready" : "login_required";
                    message = sessions.hasSession()
                            ? "眼镜端正在启动，Jellyfin 会话仍保存在手机中。"
                            : "请先在手机端登录 Jellyfin。";
                    error = false;
                }
                else if ("no-session".equals(incoming.state))
                {
                    state = sessions.hasSession() ? "session_ready" : "login_required";
                    message = sessions.hasSession()
                            ? "眼镜端正在等待 Jellyfin 会话同步。"
                            : "请先在手机端登录 Jellyfin。";
                    error = false;
                }
                pushCompanionState();
                break;
            case SEARCH_STATE:
            {
                boolean wasSearchActive = glassesSearchActive;
                glassesSearchActive = "active".equals(incoming.state);
                glassesSearchQuery = glassesSearchActive ? incoming.query : "";
                if (!glassesSearchActive)
                {
                    remoteCommands.clear();
                }
                pushCompanionState();
                if (glassesSearchActive && !wasSearchActive
                        && ("home".equals(webScreen) || "settings".equals(webScreen)
                                || "touchpad".equals(webScreen)))
                {
                    companionWebView.showSearchKeyboard();
                }
                else if (!glassesSearchActive && wasSearchActive)
                {
                    companionWebView.hideSearchKeyboard();
                }
                break;
            }
            default:
                break;
        }
    }

    private void applyUiThemePreference(String theme)
    {
        if (destroyed || !UiTheme.isValid(theme))
        {
            return;
        }
        sessions.setUiTheme(theme);
        updatePhoneSurface();
        glassesPresentation.refreshBootstrap();
        pushCompanionState();
    }

    private String localizeMessage(String message)
    {
        return UiStrings.text(this, sessions == null ? UiLanguage.DEFAULT : sessions.getLanguage(), message);
    }

    private String systemLanguage()
    {
        return getResources().getConfiguration().getLocales().get(0).toLanguageTag();
    }

    private void applyLanguagePreference(String language)
    {
        if (destroyed || !UiLanguage.isValid(language))
        {
            return;
        }
        sessions.setLanguage(language);
        glassesPresentation.refreshBootstrap();
        pushCompanionState();
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration configuration)
    {
        super.onConfigurationChanged(configuration);
        if (sessions != null && glassesPresentation != null)
        {
            glassesPresentation.refreshBootstrap();
            pushCompanionState();
        }
    }

    private void applySubtitleSizePreference(String size)
    {
        if (destroyed || !SubtitleSize.isValid(size))
        {
            return;
        }
        sessions.setSubtitleSize(size);
        glassesPresentation.refreshBootstrap();
        pushCompanionState();
    }

    private JSONObject buildGlassesBootstrap()
    {
        JSONObject result = new JSONObject();
        try
        {
            DisplayModeStateMachine.State displayState = rayNeoDisplay == null
                    ? new DisplayModeStateMachine(DisplayModeStateMachine.MIRROR_2D).snapshot()
                    : rayNeoDisplay.getState();
            result.put("source", "android");
            result.put("displayMode", displayState.requestedMode);
            result.put("displayModeApplied", displayState.displayModeApplied);
            result.put("displayModeTransitioning", displayState.displayModeTransitioning);
            result.put("glassesConnected", displayState.connected);
            result.put("catalogGeneration", glassesCatalogGeneration);
            result.put("uiTheme", sessions == null ? UiTheme.DEFAULT : sessions.getUiTheme());
            result.put("subtitleSize", sessions == null ? SubtitleSize.DEFAULT : sessions.getSubtitleSize());
            result.put("language", sessions == null ? UiLanguage.DEFAULT : sessions.getLanguage());
            result.put("systemLanguage", systemLanguage());
            SessionPayload session = sessions == null ? null : sessions.getSession();
            result.put("session", session == null ? JSONObject.NULL : session.toJsonObject());
        }
        catch (Exception ignored)
        {
            return new JSONObject();
        }
        return result;
    }

    private String buildCompanionStateJson()
    {
        JSONObject result = new JSONObject();
        try
        {
            SessionPayload session = sessions.getSession();
            DisplayModeStateMachine.State displayState = rayNeoDisplay.getState();
            boolean mediaReady = "ready".equals(glassesRuntimeState) && session != null;
            result.put("state", state);
            result.put("appVersionName", BuildConfig.VERSION_NAME);
            result.put("appVersionCode", BuildConfig.VERSION_CODE);
            result.put("companionBackground", companionBackground == null ? "" : companionBackground.getUrl());
            result.put("companionBackgroundBusy", companionBackground != null && companionBackground.isBusy());
            result.put("companionBackgroundLayout", sessions.getCompanionBackgroundLayout().toJson());
            result.put("companionGlassTransparency", sessions.getCompanionGlassTransparency());
            result.put("message", message);
            result.put("isError", error);
            result.put("serverUrl", session == null ? selectedServerUrl : session.getServerUrl());
            result.put("serverName", session == null ? selectedServerName : session.getServerName());
            result.put("serverVersion", session == null ? "" : session.getServerVersion());
            result.put("serverId", session == null ? "" : session.getServerId());
            result.put("username", session == null ? selectedUserName : session.getUserName());
            result.put("quickConnectCode", quickConnectCode);
            result.put("sessionAvailable", session != null);
            result.put("sessionSaved", sessions.isPersisted());
            result.put("activeSessionId", sessions.getActiveId());
            result.put("accounts", sessions.accountSummaries());
            result.put("accountLimit", SessionRepository.MAX_ACCOUNTS);
            result.put("loginServerUrl", selectedServerUrl);
            result.put("loginServerName", selectedServerName);
            result.put("busy", busy);
            result.put("webHardwareAccelerated",
                    companionWebView != null && companionWebView.isHardwareAccelerated());
            result.put("glassesConnected", displayState.connected);
            result.put("glassesPresentationReady", glassesWebReady);
            result.put("glassesRuntimeState", glassesRuntimeState);
            result.put("glassesRuntimeErrorCode", glassesRuntimeErrorCode);
            result.put("mediaReady", mediaReady);
            result.put("touchpadReady", glassesWebReady && mediaReady);
            result.put("searchInputActive", glassesSearchActive);
            result.put("searchQuery", glassesSearchQuery);
            result.put("displayMode", displayState.requestedMode);
            result.put("activeDisplayMode", displayState.activeMode);
            result.put("displayModeApplied", displayState.displayModeApplied);
            result.put("displayModeTransitioning", displayState.displayModeTransitioning);
            result.put("displayMessage", displayState.message);
            result.put("glassesDisplayDisabled", glassesPresentation != null
                    && glassesPresentation.isSystemDisplayDisabled());
            result.put("stereoScreen", sessions.getStereoScreenSettings().toJson());
            result.put("uiTheme", sessions.getUiTheme());
            result.put("touchpadBackground", sessions.getTouchpadBackground());
            result.put("subtitleSize", sessions.getSubtitleSize());
            result.put("language", sessions.getLanguage());
            result.put("systemLanguage", systemLanguage());
            result.put("stereoOutput", glassesPresentation == null
                    ? DisplayOutputGeometry.EMPTY.toJson() : glassesPresentation.getOutputGeometry().toJson());
            result.put("stereoTestPattern", glassesPresentation != null
                    && glassesPresentation.isStereoTestPatternEnabled());
            result.put("discoveryMessage", discoveryMessage);
            result.put("discoveryError", !discoveryScanning && discoveredServers.isEmpty());
            result.put("discoveryScanning", discoveryScanning);
            result.put("playback", playback.toJson());

            JSONArray servers = new JSONArray();
            for (JellyfinDiscoveryService.Server server : discoveredServers)
            {
                JSONObject item = new JSONObject();
                item.put("id", server.id.isEmpty() ? server.address : server.id);
                item.put("name", server.name);
                item.put("host", server.address);
                item.put("detail", "Jellyfin 服务器");
                item.put("latency", "局域网");
                item.put("strength", 3);
                servers.put(item);
            }
            result.put("servers", servers);
        }
        catch (Exception ignored)
        {
            return new JSONObject().toString();
        }
        return result.toString();
    }

    private void onCompanionBackgroundChanged()
    {
        String url = companionBackground.getUrl();
        if (!companionBackground.isBusy() && (url.isEmpty() || !url.equals(lastCompanionBackgroundUrl)))
        {
            // A new image starts centered; failed/cancelled imports leave the old crop intact.
            sessions.setCompanionBackgroundLayout(url.isEmpty() ? CompanionBackgroundLayout.DEFAULT
                    : sessions.getCompanionBackgroundLayout().centered());
            lastCompanionBackgroundUrl = url;
        }
        pushCompanionState();
    }

    private void pushCompanionState()
    {
        if (companionWebView != null && !destroyed)
        {
            companionWebView.pushState();
        }
    }

    private void updatePhoneSurface()
    {
        boolean oled = "touchpad".equals(webScreen);
        boolean simple = sessions != null && UiTheme.SIMPLE.equals(sessions.getUiTheme());
        int surfaceColor = oled ? Color.BLACK : simple ? Color.rgb(243, 240, 233) : Color.rgb(234, 247, 250);
        getWindow().setStatusBarColor(surfaceColor);
        getWindow().setNavigationBarColor(oled ? Color.BLACK : simple ? surfaceColor : Color.rgb(229, 245, 249));
        getWindow().setBackgroundDrawable(new ColorDrawable(surfaceColor));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
        {
            getWindow().setNavigationBarDividerColor(surfaceColor);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        {
            // Avoid an OS contrast scrim raising the remote's black system-bar pixels.
            getWindow().setStatusBarContrastEnforced(!oled);
            getWindow().setNavigationBarContrastEnforced(!oled);
        }
        if (companionWebView != null)
        {
            companionWebView.setSurfaceColor(surfaceColor);
        }
        int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
        if (!oled)
        {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                    | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }

    private void copyQuickConnectCode()
    {
        if (quickConnectCode.isEmpty())
        {
            return;
        }
        ClipboardManager clipboard =
                (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null)
        {
            clipboard.setPrimaryClip(
                    ClipData.newPlainText("Jellyfin Quick Connect", quickConnectCode));
            Toast.makeText(this, localizeMessage("快速登录码已复制"), Toast.LENGTH_SHORT).show();
        }
    }

    private void openQuickConnectAuthorization()
    {
        if (selectedServerUrl.isEmpty() || quickConnectCode.isEmpty())
        {
            return;
        }
        String target = selectedServerUrl.replaceAll("/+$", "")
                + "/web/#/quickconnect?code="
                + Uri.encode(quickConnectCode);
        try
        {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(target)));
        }
        catch (RuntimeException exception)
        {
            Toast.makeText(
                    this,
                    localizeMessage("无法打开授权页，请在 Jellyfin App 中手动授权。"),
                    Toast.LENGTH_LONG).show();
        }
    }

    private void shareDiagnosticLog()
    {
        diagnosticLog.record(DiagnosticLog.Event.DIAGNOSTICS_SHARED);
        if (diagnosticExporter == null) return;
        diagnosticExporter.export(buildDiagnosticReport(), new DiagnosticReportExporter.Callback()
        {
            @Override
            public void ready(Uri uri)
            {
                Intent share = new Intent(Intent.ACTION_SEND);
                share.setType("text/plain");
                share.putExtra(Intent.EXTRA_SUBJECT, "tachi" + localizeMessage(" 诊断日志"));
                share.putExtra(Intent.EXTRA_STREAM, uri);
                share.setClipData(ClipData.newRawUri("tachi diagnostics", uri));
                share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try
                {
                    startActivity(Intent.createChooser(share, localizeMessage("分享已脱敏诊断日志")));
                }
                catch (RuntimeException exception)
                {
                    Toast.makeText(MainActivity.this,
                            localizeMessage("没有可接收诊断日志的分享应用。"), Toast.LENGTH_LONG).show();
                }
            }

            @Override
            public void failed()
            {
                Toast.makeText(MainActivity.this,
                        localizeMessage("无法导出诊断日志，请重试。"), Toast.LENGTH_LONG).show();
            }
        });
    }

    private String buildDiagnosticReport()
    {
        StringBuilder result = new StringBuilder();
        result.append(getString(R.string.app_name)).append(" diagnostics\n");
        appendDiagnostic(result, "format", "4");
        appendDiagnostic(result, "appVersion", BuildConfig.VERSION_NAME);
        appendDiagnostic(result, "appVersionCode", String.valueOf(BuildConfig.VERSION_CODE));
        appendDiagnostic(result, "androidSdk", String.valueOf(Build.VERSION.SDK_INT));
        appendDiagnostic(result, "androidRelease", Build.VERSION.RELEASE);
        appendDiagnostic(result, "deviceManufacturer", Build.MANUFACTURER);
        appendDiagnostic(result, "deviceModel", Build.MODEL);
        appendWebViewDiagnostics(result);

        SessionPayload session = sessions == null ? null : sessions.getSession();
        appendDiagnostic(result, "sessionPresent", booleanText(session != null));
        appendDiagnostic(result, "sessionPersisted", booleanText(
                sessions != null && sessions.isPersisted()));
        appendServerDiagnostics(result, session);
        appendNetworkDiagnostics(result);

        DisplayModeStateMachine.State display = rayNeoDisplay == null
                ? null
                : rayNeoDisplay.getState();
        appendDiagnostic(result, "glassesConnected", booleanText(
                display != null && display.connected));
        appendDiagnostic(result, "glassesWebReady", booleanText(glassesWebReady));
        appendDiagnostic(result, "glassesRuntimeState", glassesRuntimeState);
        appendDiagnostic(result, "glassesRuntimeError", glassesRuntimeErrorCode);
        appendDiagnostic(result, "catalogGeneration", String.valueOf(glassesCatalogGeneration));
        if (display != null)
        {
            appendDiagnostic(result, "displayRequested", display.requestedMode);
            appendDiagnostic(result, "displayActive", display.activeMode);
            appendDiagnostic(result, "displayApplied", booleanText(display.displayModeApplied));
            appendDiagnostic(
                    result,
                    "displayTransitioning",
                    booleanText(display.displayModeTransitioning));
        }
        DisplayOutputGeometry output = glassesPresentation == null
                ? DisplayOutputGeometry.EMPTY : glassesPresentation.getOutputGeometry();
        // Fixed numeric/boolean geometry schema; do not truncate JSON as free-form text.
        result.append("stereoOutput=").append(output.toJson()).append('\n');
        appendDiagnostic(result, "realtimeSbsBundled", booleanText(RealtimeDepthBackend.available()));
        appendDiagnostic(result, "realtimeDepthResolution", BuildConfig.REALTIME_DEPTH_RESOLUTION);
        if (sessions != null)
        {
            appendDiagnostic(result, "stereoScreen", sessions.getStereoScreenSettings().toJson().toString());
        }
        appendDiagnostic(result, "stereoTestPattern", booleanText(glassesPresentation != null
                && glassesPresentation.isStereoTestPatternEnabled()));
        result.append("privacy=server address, account, media titles and credentials omitted\n");
        result.append(nativePlaybackDiagnostics.export());
        result.append("events:\n");
        result.append(diagnosticLog.exportEvents());
        return result.toString();
    }

    private void appendWebViewDiagnostics(StringBuilder result)
    {
        try
        {
            PackageInfo webView = WebView.getCurrentWebViewPackage();
            appendDiagnostic(
                    result,
                    "webViewPackage",
                    webView == null ? "unknown" : webView.packageName);
            appendDiagnostic(
                    result,
                    "webViewVersion",
                    webView == null ? "unknown" : webView.versionName);
        }
        catch (RuntimeException exception)
        {
            appendDiagnostic(result, "webViewPackage", "unknown");
            appendDiagnostic(result, "webViewVersion", "unknown");
        }
    }

    private static void appendServerDiagnostics(
            StringBuilder result,
            SessionPayload session)
    {
        String scheme = "none";
        String hostType = "none";
        boolean subpath = false;
        if (session != null)
        {
            try
            {
                URI uri = new URI(session.getServerUrl());
                scheme = "https".equalsIgnoreCase(uri.getScheme()) ? "https" : "http";
                String host = uri.getHost() == null ? "" : uri.getHost();
                if (host.contains(":"))
                {
                    hostType = "ipv6-literal";
                }
                else if (host.matches("[0-9.]+"))
                {
                    hostType = "ipv4-literal";
                }
                else
                {
                    hostType = "hostname";
                }
                String path = uri.getPath();
                subpath = path != null && !path.isEmpty() && !"/".equals(path);
            }
            catch (Exception ignored)
            {
                scheme = "invalid";
                hostType = "invalid";
            }
        }
        appendDiagnostic(result, "serverScheme", scheme);
        appendDiagnostic(result, "serverHostType", hostType);
        appendDiagnostic(result, "serverSubpath", booleanText(subpath));
    }

    private void appendNetworkDiagnostics(StringBuilder result)
    {
        ConnectivityManager manager =
                (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        Network active = manager == null ? null : manager.getActiveNetwork();
        NetworkCapabilities capabilities = active == null || manager == null
                ? null
                : manager.getNetworkCapabilities(active);
        LinkProperties links = active == null || manager == null
                ? null
                : manager.getLinkProperties(active);

        appendDiagnostic(result, "networkTransport", networkTransport(capabilities));
        appendDiagnostic(result, "networkInternet", booleanText(capabilities != null
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)));
        appendDiagnostic(result, "networkValidated", booleanText(capabilities != null
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)));

        boolean ipv4 = false;
        boolean ipv6 = false;
        boolean nonLinkLocalIpv6 = false;
        boolean ipv6Dns = false;
        if (links != null)
        {
            for (LinkAddress link : links.getLinkAddresses())
            {
                InetAddress address = link.getAddress();
                ipv4 |= address instanceof Inet4Address;
                ipv6 |= address instanceof Inet6Address;
                nonLinkLocalIpv6 |= address instanceof Inet6Address
                        && !address.isAnyLocalAddress()
                        && !address.isLinkLocalAddress()
                        && !address.isLoopbackAddress()
                        && !address.isMulticastAddress();
            }
            for (InetAddress dns : links.getDnsServers())
            {
                ipv6Dns |= dns instanceof Inet6Address;
            }
        }
        appendDiagnostic(result, "networkIpv4", booleanText(ipv4));
        appendDiagnostic(result, "networkIpv6", booleanText(ipv6));
        appendDiagnostic(result, "networkNonLinkLocalIpv6", booleanText(nonLinkLocalIpv6));
        appendDiagnostic(result, "networkIpv6Dns", booleanText(ipv6Dns));
    }

    private static String networkTransport(NetworkCapabilities capabilities)
    {
        if (capabilities == null)
        {
            return "none";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN))
        {
            return "vpn";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))
        {
            return "wifi";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR))
        {
            return "cellular";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
        {
            return "ethernet";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH))
        {
            return "bluetooth";
        }
        return "other";
    }

    private static void appendDiagnostic(StringBuilder result, String key, String value)
    {
        result.append(key)
                .append('=')
                .append(safeDiagnosticText(value))
                .append('\n');
    }

    private static String safeDiagnosticText(String value)
    {
        if (value == null)
        {
            return "unknown";
        }
        String normalized = value.replace('\n', ' ').replace('\r', ' ').trim();
        String lower = normalized.toLowerCase(Locale.US);
        if (lower.contains("://")
                || lower.contains("password")
                || lower.contains("token="))
        {
            return "[redacted]";
        }
        return bounded(normalized, 120);
    }

    private static String booleanText(boolean value)
    {
        return value ? "true" : "false";
    }

    private void recordDisplayDiagnostic(DisplayModeStateMachine.State display)
    {
        if (display == null || !display.connected)
        {
            return;
        }
        if (display.displayModeTransitioning)
        {
            diagnosticLog.record(DisplayModeStateMachine.STEREO_SCREEN.equals(
                    display.requestedMode)
                    ? DiagnosticLog.Event.DISPLAY_SWITCH_3D
                    : DiagnosticLog.Event.DISPLAY_SWITCH_2D);
        }
        else if (display.displayModeApplied)
        {
            diagnosticLog.record(DisplayModeStateMachine.STEREO_SCREEN.equals(
                    display.activeMode)
                    ? DiagnosticLog.Event.DISPLAY_STEREO_APPLIED
                    : DiagnosticLog.Event.DISPLAY_MIRROR_APPLIED);
        }
        else
        {
            diagnosticLog.record(DiagnosticLog.Event.DISPLAY_SAFE_FALLBACK);
        }
    }

    private void recordRuntimeDiagnostic(GlassesMessage incoming)
    {
        switch (incoming.state)
        {
            case "booting":
                diagnosticLog.record(DiagnosticLog.Event.RUNTIME_BOOTING);
                break;
            case "loading":
                diagnosticLog.record(DiagnosticLog.Event.RUNTIME_LOADING);
                break;
            case "ready":
                diagnosticLog.record(DiagnosticLog.Event.RUNTIME_READY);
                break;
            case "no-session":
                diagnosticLog.record(DiagnosticLog.Event.RUNTIME_NO_SESSION);
                break;
            case "error":
                recordRuntimeErrorDiagnostic(incoming.errorCode);
                break;
            default:
                break;
        }
    }

    private void recordRuntimeErrorDiagnostic(String errorCode)
    {
        switch (errorCode)
        {
            case "network":
                diagnosticLog.record(DiagnosticLog.Event.RUNTIME_ERROR_NETWORK);
                break;
            case "http":
                diagnosticLog.record(DiagnosticLog.Event.RUNTIME_ERROR_HTTP);
                break;
            case "response":
                diagnosticLog.record(DiagnosticLog.Event.RUNTIME_ERROR_RESPONSE);
                break;
            default:
                diagnosticLog.record(DiagnosticLog.Event.RUNTIME_ERROR_UNKNOWN);
                break;
        }
    }

    private static String commandForKey(int keyCode)
    {
        switch (keyCode)
        {
            case KeyEvent.KEYCODE_DPAD_UP:
                return "up";
            case KeyEvent.KEYCODE_DPAD_DOWN:
                return "down";
            case KeyEvent.KEYCODE_DPAD_LEFT:
                return "left";
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                return "right";
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
                return "enter";
            default:
                return null;
        }
    }

    private static String bounded(String value, int maximumLength)
    {
        if (value == null)
        {
            return "";
        }
        return value.length() <= maximumLength ? value : value.substring(0, maximumLength);
    }

    private static String normalizedServerInput(String value)
    {
        String candidate = bounded(value, SessionPayload.MAX_SERVER_URL_LENGTH).trim();
        try
        {
            return SessionPayload.normalizeServerUrl(candidate);
        }
        catch (Exception ignored)
        {
            return "";
        }
    }

    private static String glassesRuntimeErrorMessage(String errorCode)
    {
        switch (errorCode)
        {
            case "network":
                return "眼镜端无法访问 Jellyfin。请检查当前网络和服务器地址；IPv6 带端口时必须使用方括号。";
            case "http":
                return "眼镜端已访问 Jellyfin，但媒体库请求返回了 HTTP 错误。请检查服务状态或重新登录。";
            case "response":
                return "眼镜端已收到服务器响应，但无法解析为 Jellyfin 数据。请确认地址指向 Jellyfin 服务。";
            default:
                return "眼镜端加载媒体库失败。请检查服务器地址和当前网络后重试。";
        }
    }

    private void retryGlassesRuntime()
    {
        if (!sessions.hasSession())
        {
            return;
        }
        glassesRuntimeState = "loading";
        glassesRuntimeErrorCode = "none";
        diagnosticLog.record(DiagnosticLog.Event.CATALOG_RETRY);
        advanceGlassesCatalogGeneration();
        state = "session_ready";
        message = "正在让眼镜重新连接 Jellyfin 并加载媒体库。";
        error = false;
        glassesPresentation.refreshBootstrap();
        pushCompanionState();
    }

    private void advanceGlassesCatalogGeneration()
    {
        glassesCatalogGeneration = glassesCatalogGeneration == Integer.MAX_VALUE
                ? 1
                : glassesCatalogGeneration + 1;
    }

    private void showInvalidServerAddress()
    {
        busy = false;
        state = "login_required";
        message = "服务器地址无效。IPv6 带端口时请使用 http://[IPv6地址]:端口。";
        quickConnectCode = "";
        error = true;
        pushCompanionState();
    }

    private final class CompanionBridge implements CompanionWebViewController.JavascriptBridge
    {
        @JavascriptInterface
        public void chooseCompanionBackground()
        {
            runOnUiThread(() ->
            {
                if (!destroyed && "settings".equals(webScreen)
                        && UiTheme.DEFAULT.equals(sessions.getUiTheme()))
                {
                    companionBackground.choose();
                }
            });
        }

        @JavascriptInterface
        public void clearCompanionBackground()
        {
            runOnUiThread(() ->
            {
                if (!destroyed && "settings".equals(webScreen))
                {
                    companionBackground.clear();
                }
            });
        }

        @JavascriptInterface
        public void setCompanionBackgroundLayout(String revision, String payload)
        {
            CompanionBackgroundLayout layout = CompanionBackgroundLayout.parse(payload);
            if (layout == null || revision == null || revision.length() != 32 || !revision.matches("[a-f0-9]{32}"))
            {
                return;
            }
            runOnUiThread(() ->
            {
                if (!destroyed && "settings".equals(webScreen) && !companionBackground.isBusy()
                        && (CompanionSettingsPolicy.BACKGROUND_URL + revision).equals(companionBackground.getUrl()))
                {
                    sessions.setCompanionBackgroundLayout(layout);
                    pushCompanionState();
                }
            });
        }

        @JavascriptInterface
        public void setCompanionGlassTransparency(String value)
        {
            Integer transparency = CompanionSettingsPolicy.parseGlassTransparency(value);
            if (transparency == null)
            {
                return;
            }
            runOnUiThread(() ->
            {
                if (!destroyed && "settings".equals(webScreen))
                {
                    sessions.setCompanionGlassTransparency(transparency);
                    pushCompanionState();
                }
            });
        }

        @JavascriptInterface
        public void openProjectPage(String page)
        {
            String url = CompanionSettingsPolicy.projectPage(page);
            if (url == null)
            {
                return;
            }
            runOnUiThread(() ->
            {
                if (!destroyed && "settings".equals(webScreen))
                {
                    try
                    {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    }
                    catch (RuntimeException ignored)
                    {
                        Toast.makeText(MainActivity.this, localizeMessage("未找到可打开链接的浏览器"), Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public String getState()
        {
            return buildCompanionStateJson();
        }

        @JavascriptInterface
        public void ready()
        {
            runOnUiThread(() ->
            {
                companionWebView.onJavascriptReady();
                if (glassesSearchActive)
                {
                    companionWebView.showSearchKeyboard();
                }
            });
        }

        @JavascriptInterface
        public void scan()
        {
            runOnUiThread(MainActivity.this::startDiscovery);
        }

        @JavascriptInterface
        public void selectServer(String serverUrl, String serverName)
        {
            String url = normalizedServerInput(serverUrl);
            String name = bounded(serverName, SessionPayload.MAX_SERVER_NAME_LENGTH).trim();
            runOnUiThread(() ->
            {
                if (url.isEmpty())
                {
                    showInvalidServerAddress();
                    companionWebView.openScreen("connect");
                    return;
                }
                authentication.cancel();
                selectedServerUrl = url;
                selectedServerName = name;
                selectedUserName = "";
                quickConnectCode = "";
                busy = false;
                error = false;
                state = sessions.hasSession() ? "session_ready" : "login_required";
                message = "请登录所选服务器；当前连接会保留到登录成功。";
                pushCompanionState();
            });
        }

        @JavascriptInterface
        public void login(
                String serverUrl,
                String username,
                String password,
                boolean rememberSession)
        {
            if (password != null && password.length() > MAX_PASSWORD_LENGTH)
            {
                runOnUiThread(() ->
                {
                    error = true;
                    message = "密码长度超出允许范围。";
                    pushCompanionState();
                });
                return;
            }
            String url = normalizedServerInput(serverUrl);
            String user = bounded(username, SessionPayload.MAX_USER_NAME_LENGTH).trim();
            String ephemeralPassword = password == null ? "" : password;
            if (url.isEmpty())
            {
                runOnUiThread(MainActivity.this::showInvalidServerAddress);
                return;
            }
            runOnUiThread(() ->
            {
                authentication.cancel();
                selectedServerUrl = url;
                selectedUserName = user;
                sessions.setServerHint(url);
                sessions.setUserNameHint(user);
                diagnosticLog.record(DiagnosticLog.Event.AUTH_PASSWORD_STARTED);
                state = "native_connecting";
                message = "正在验证服务器与账户…";
                quickConnectCode = "";
                busy = true;
                error = false;
                pushCompanionState();
                authentication.login(url, user, ephemeralPassword, rememberSession);
            });
        }

        @JavascriptInterface
        public void startQuickConnect(String serverUrl)
        {
            String url = normalizedServerInput(serverUrl);
            if (url.isEmpty())
            {
                runOnUiThread(MainActivity.this::showInvalidServerAddress);
                return;
            }
            runOnUiThread(() ->
            {
                authentication.cancel();
                selectedServerUrl = url;
                sessions.setServerHint(url);
                diagnosticLog.record(DiagnosticLog.Event.AUTH_QUICK_STARTED);
                state = "native_connecting";
                message = "正在向 Jellyfin 申请快速登录码…";
                quickConnectCode = "";
                busy = true;
                error = false;
                pushCompanionState();
                authentication.quickConnect(url, true);
            });
        }

        @JavascriptInterface
        public void cancelQuickConnect()
        {
            runOnUiThread(() ->
            {
                authentication.cancel();
                busy = false;
                state = sessions.hasSession() ? "session_ready" : "login_required";
                message = "已取消登录。";
                quickConnectCode = "";
                error = false;
                pushCompanionState();
            });
        }

        @JavascriptInterface
        public void clearSession()
        {
            runOnUiThread(() -> MainActivity.this.clearSession(false));
        }

        @JavascriptInterface
        public void activateSession(String accountId)
        {
            if (!SessionRepository.validAccountId(accountId))
            {
                return;
            }
            runOnUiThread(() ->
            {
                if (destroyed)
                {
                    return;
                }
                if (accountId.equals(sessions.getActiveId()))
                {
                    companionWebView.openScreen("home");
                    return;
                }
                SessionPayload session = sessions.activate(accountId);
                if (session != null)
                {
                    showActiveSession(session, "已切换账号，正在同步眼镜媒体库。");
                }
            });
        }

        @JavascriptInterface
        public void removeSession(String accountId)
        {
            if (!SessionRepository.validAccountId(accountId))
            {
                return;
            }
            runOnUiThread(() ->
            {
                if (destroyed)
                {
                    return;
                }
                if (accountId.equals(sessions.getActiveId()))
                {
                    MainActivity.this.clearSession(false);
                }
                else if (sessions.remove(accountId))
                {
                    pushCompanionState();
                }
            });
        }

        @JavascriptInterface
        public void retryGlasses()
        {
            runOnUiThread(MainActivity.this::retryGlassesRuntime);
        }

        @JavascriptInterface
        public void shareDiagnostics()
        {
            runOnUiThread(MainActivity.this::shareDiagnosticLog);
        }

        @JavascriptInterface
        public void selectDisplayMode(String mode)
        {
            String normalized = DisplayModeStateMachine.normalizeMode(mode);
            runOnUiThread(() ->
            {
                sessions.setDisplayMode(normalized);
                rayNeoDisplay.requestMode(normalized);
            });
        }

        @JavascriptInterface
        public void selectUiTheme(String theme)
        {
            if (!UiTheme.isValid(theme))
            {
                return;
            }
            runOnUiThread(() -> applyUiThemePreference(theme));
        }

        @JavascriptInterface
        public void selectLanguage(String language)
        {
            if (!UiLanguage.isValid(language))
            {
                return;
            }
            runOnUiThread(() -> applyLanguagePreference(language));
        }

        @JavascriptInterface
        public void selectSubtitleSize(String size)
        {
            if (!SubtitleSize.isValid(size))
            {
                return;
            }
            runOnUiThread(() -> applySubtitleSizePreference(size));
        }

        @JavascriptInterface
        public void selectTouchpadBackground(String background)
        {
            if (!CompanionSettingsPolicy.isTouchpadBackground(background))
            {
                return;
            }
            runOnUiThread(() ->
            {
                if (!destroyed)
                {
                    sessions.setTouchpadBackground(background);
                    pushCompanionState();
                }
            });
        }

        @JavascriptInterface
        public void setStereoScreen(String payload)
        {
            StereoScreenSettings settings = StereoScreenSettings.parse(payload);
            if (settings == null)
            {
                return;
            }
            runOnUiThread(() ->
            {
                if (!destroyed)
                {
                    sessions.setStereoScreenSettings(settings);
                    glassesPresentation.setStereoScreenSettings(settings);
                    pushCompanionState();
                }
            });
        }

        @JavascriptInterface
        public void setStereoTestPattern(String value)
        {
            if (!"on".equals(value) && !"off".equals(value))
            {
                return;
            }
            runOnUiThread(() ->
            {
                if (!destroyed)
                {
                    glassesPresentation.setStereoTestPattern("on".equals(value)
                            && "settings".equals(webScreen) && glassesWebReady);
                    pushCompanionState();
                }
            });
        }

        @JavascriptInterface
        public void copyQuickConnectCode()
        {
            runOnUiThread(MainActivity.this::copyQuickConnectCode);
        }

        @JavascriptInterface
        public void openQuickConnectAuthorization()
        {
            runOnUiThread(MainActivity.this::openQuickConnectAuthorization);
        }

        @JavascriptInterface
        public void remoteCommand(String value, boolean haptic)
        {
            if (value == null || value.length() > 32)
            {
                return;
            }
            String command = bounded(value, 32).trim().toLowerCase(Locale.US);
            runOnUiThread(() ->
            {
                if ((command.startsWith("seek:") || command.startsWith("scrub:")) && !playback.isSeekEnabled())
                {
                    return;
                }
                if (remoteCommands.submit(command) && haptic)
                {
                    companionWebView.haptic("back".equals(command));
                }
            });
        }

        @JavascriptInterface
        public void searchText(String value)
        {
            if (value == null || value.length() > RemoteCommandRouter.MAX_SEARCH_QUERY_LENGTH)
            {
                return;
            }
            String query = value;
            runOnUiThread(() ->
            {
                if (glassesSearchActive)
                {
                    remoteCommands.submitSearchText(query);
                }
            });
        }

        @JavascriptInterface
        public void previewHaptic()
        {
            runOnUiThread(() -> companionWebView.haptic(false));
        }

        @JavascriptInterface
        public void screenChanged(String value)
        {
            String requested = bounded(value, MAX_SCREEN_LENGTH).trim().toLowerCase(Locale.US);
            if (!"connect".equals(requested)
                    && !"auth".equals(requested)
                    && !"home".equals(requested)
                    && !"settings".equals(requested)
                    && !"accounts".equals(requested)
                    && !"touchpad".equals(requested))
            {
                return;
            }
            runOnUiThread(() ->
            {
                if (destroyed)
                {
                    return;
                }
                webScreen = requested;
                if (!"settings".equals(requested))
                {
                    glassesPresentation.setStereoTestPattern(false);
                    pushCompanionState();
                }
                updatePhoneSurface();
            });
        }
    }
}
