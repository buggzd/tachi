package com.jellyfinforrayneo.client;

import java.util.Locale;

final class DisplayModeStateMachine
{
    static final String MIRROR_2D = "mirror_2d";
    static final String STEREO_SCREEN = "stereo_screen";
    static final int COMMAND_3D = 6;
    static final int COMMAND_2D = 7;
    static final long TRANSITION_TIMEOUT_MS = 8_000L;

    enum Action
    {
        NONE,
        SWITCH_TO_2D,
        SWITCH_TO_3D
    }

    static final class State
    {
        final String requestedMode;
        final String activeMode;
        final boolean displayModeApplied;
        final boolean displayModeTransitioning;
        final boolean connected;
        final String message;

        State(
                String requestedMode,
                String activeMode,
                boolean displayModeApplied,
                boolean displayModeTransitioning,
                boolean connected,
                String message)
        {
            this.requestedMode = requestedMode;
            this.activeMode = activeMode;
            this.displayModeApplied = displayModeApplied;
            this.displayModeTransitioning = displayModeTransitioning;
            this.connected = connected;
            this.message = message;
        }
    }

    private String requestedMode;
    private String activeMode = MIRROR_2D;
    private boolean applied;
    private boolean transitioning;
    private boolean connected;
    private boolean stereoLayoutReady;
    private boolean hardwareConfirmed;
    private long transitionDeadline;
    private String message;

    DisplayModeStateMachine(String initialMode)
    {
        requestedMode = normalizeMode(initialMode);
        message = disconnectedMessage();
    }

    synchronized Action requestMode(String mode, long nowMs)
    {
        requestedMode = normalizeMode(mode);
        if (!connected)
        {
            activeMode = MIRROR_2D;
            applied = false;
            transitioning = false;
            hardwareConfirmed = false;
            stereoLayoutReady = false;
            message = disconnectedMessage();
            return Action.NONE;
        }
        if (applied && requestedMode.equals(activeMode) && !transitioning)
        {
            message = successMessage();
            return Action.NONE;
        }
        return beginTransition(nowMs);
    }

    synchronized Action setConnected(boolean connected, long nowMs)
    {
        if (!connected)
        {
            this.connected = false;
            activeMode = MIRROR_2D;
            applied = false;
            transitioning = false;
            hardwareConfirmed = false;
            stereoLayoutReady = false;
            message = "眼镜已断开；重新连接后会应用所选模式。";
            return Action.NONE;
        }

        boolean wasConnected = this.connected;
        this.connected = true;
        if (wasConnected && transitioning)
        {
            return Action.NONE;
        }
        if (!wasConnected || !applied || !requestedMode.equals(activeMode))
        {
            return beginTransition(nowMs);
        }
        return Action.NONE;
    }

    synchronized Action onCommandResponse(int command, boolean stereoEnabled, long nowMs)
    {
        if (!transitioning || command != expectedCommand())
        {
            return Action.NONE;
        }
        // SDK 1.0.3 reports the resulting 3D flag, not command success. A 2D acknowledgement is false.
        if (stereoEnabled != STEREO_SCREEN.equals(requestedMode))
        {
            return fail("眼镜未进入所选显示模式，已安全回退到镜像 2D。");
        }
        if (nowMs >= transitionDeadline)
        {
            return tick(nowMs);
        }
        hardwareConfirmed = true;
        if (STEREO_SCREEN.equals(requestedMode) && !stereoLayoutReady)
        {
            message = "眼镜已响应，正在确认左右眼输出尺寸…";
            return Action.NONE;
        }
        return completeTransition();
    }

    synchronized Action onStereoLayoutChanged(boolean ready, long nowMs)
    {
        stereoLayoutReady = ready;
        if (transitioning && STEREO_SCREEN.equals(requestedMode))
        {
            if (nowMs >= transitionDeadline)
            {
                return tick(nowMs);
            }
            if (ready && hardwareConfirmed)
            {
                return completeTransition();
            }
        }
        else if (!transitioning && applied && STEREO_SCREEN.equals(activeMode) && !ready)
        {
            return fail("左右眼输出尺寸发生变化，已安全回退到镜像 2D。");
        }
        return Action.NONE;
    }

    synchronized Action onPhysicalModeObserved(boolean stereo, long nowMs)
    {
        // Modern XR Space has no AirApi acknowledgement. The physical display mode is
        // independent hardware evidence; a successful socket write alone never confirms it.
        if (!transitioning || stereo != STEREO_SCREEN.equals(requestedMode))
        {
            return Action.NONE;
        }
        if (nowMs >= transitionDeadline)
        {
            return tick(nowMs);
        }
        hardwareConfirmed = true;
        if (!stereo || stereoLayoutReady)
        {
            return completeTransition();
        }
        return Action.NONE;
    }

    private Action completeTransition()
    {
        transitioning = false;
        activeMode = requestedMode;
        applied = true;
        message = successMessage();
        return Action.NONE;
    }

    synchronized Action onSdkFailure(long nowMs)
    {
        return fail("眼镜显示模式切换失败，已安全回退到镜像 2D。");
    }

    synchronized Action onUsbFailure()
    {
        return fail("无法控制眼镜显示模式，请确认 USB 已授权且控制接口未被其他应用占用。");
    }

    synchronized void waitForUsbPermission()
    {
        transitioning = false;
        hardwareConfirmed = false;
        applied = false;
        activeMode = MIRROR_2D;
        message = "请在系统弹窗中允许本应用访问眼镜 USB，以切换显示模式。";
    }

    synchronized void usbPermissionDenied()
    {
        waitForUsbPermission();
        message = "未获得眼镜 USB 权限，显示模式未切换；可重新选择模式后授权。";
    }

    synchronized Action tick(long nowMs)
    {
        if (transitioning && nowMs >= transitionDeadline)
        {
            return fail(hardwareConfirmed && STEREO_SCREEN.equals(requestedMode)
                    ? "当前输出尺寸不支持左右眼虚拟银幕，已安全回退到镜像 2D。"
                    : "眼镜没有确认显示模式，已安全回退到镜像 2D。");
        }
        return Action.NONE;
    }

    synchronized Action pause()
    {
        // Losing phone focus is not a request to rewrite the glasses EDID. A system
        // dialog can pause us before its disabled-display event reaches the app.
        if (connected && applied && !transitioning) return Action.NONE;
        transitioning = false;
        hardwareConfirmed = false;
        activeMode = MIRROR_2D;
        applied = false;
        message = "应用已暂停，正在请求眼镜恢复 2D 模式。";
        return Action.SWITCH_TO_2D;
    }

    synchronized State snapshot()
    {
        return new State(
                requestedMode,
                activeMode,
                applied,
                transitioning,
                connected,
                message);
    }

    private Action beginTransition(long nowMs)
    {
        transitioning = true;
        hardwareConfirmed = false;
        applied = false;
        transitionDeadline = nowMs + TRANSITION_TIMEOUT_MS;
        message = STEREO_SCREEN.equals(requestedMode)
                ? "正在切换到左右眼虚拟银幕…"
                : "正在切换到双眼镜像画面…";
        return STEREO_SCREEN.equals(requestedMode)
                ? Action.SWITCH_TO_3D
                : Action.SWITCH_TO_2D;
    }

    private Action fail(String reason)
    {
        transitioning = false;
        hardwareConfirmed = false;
        activeMode = MIRROR_2D;
        applied = false;
        message = reason;
        return Action.SWITCH_TO_2D;
    }

    private int expectedCommand()
    {
        return STEREO_SCREEN.equals(requestedMode) ? COMMAND_3D : COMMAND_2D;
    }

    private String disconnectedMessage()
    {
        return STEREO_SCREEN.equals(requestedMode)
                ? "虚拟银幕已保存，连接眼镜后自动启用。"
                : "镜像 2D 已保存，连接眼镜后自动启用。";
    }

    private String successMessage()
    {
        return STEREO_SCREEN.equals(activeMode)
                ? "虚拟银幕已启用，可在设置中调整靠近程度与画面大小。"
                : "镜像 2D 已启用：双眼显示同一幅完整画面。";
    }

    static String normalizeMode(String value)
    {
        String normalized = value == null ? "" : value.trim().toLowerCase(Locale.US);
        if (STEREO_SCREEN.equals(normalized)
                || "stereo".equals(normalized)
                || "3d".equals(normalized))
        {
            return STEREO_SCREEN;
        }
        return MIRROR_2D;
    }
}
