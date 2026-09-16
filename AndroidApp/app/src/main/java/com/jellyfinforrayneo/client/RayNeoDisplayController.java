package com.jellyfinforrayneo.client;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

final class RayNeoDisplayController
{
    private static final long STATE_TICK_MS = 100L;

    interface Listener
    {
        void onDisplayModeStateChanged(DisplayModeStateMachine.State state);
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final DisplayModeStateMachine stateMachine;
    private final Listener listener;
    private final RayNeoUsbDisplayClient usbClient;
    private final StartupStereoPreparation startup = new StartupStereoPreparation();
    private final Runnable stateTick = new Runnable()
    {
        @Override
        public void run()
        {
            if (!destroyed)
            {
                execute(stateMachine.tick(SystemClock.uptimeMillis()));
                scheduleTick();
            }
        }
    };

    private DisplayModeStateMachine.State lastPublishedState;
    private boolean paused;
    private boolean destroyed;
    private boolean commandWritten;
    private boolean startupCommandPending;
    private boolean permissionDeclined;
    private boolean systemDisplayDisabled;
    private DisplayModeStateMachine.Action pendingGeometryAction = DisplayModeStateMachine.Action.NONE;
    private DisplayOutputGeometry output = DisplayOutputGeometry.EMPTY;

    RayNeoDisplayController(Activity activity, String initialMode, Listener listener)
    {
        stateMachine = new DisplayModeStateMachine(initialMode);
        this.listener = listener;
        usbClient = new RayNeoUsbDisplayClient(activity, new RayNeoUsbDisplayClient.Listener()
        {
            @Override
            public void onCommandWritten()
            {
                if (startup.isPending())
                {
                    startupCommandPending = false;
                    startup.complete(true);
                    if (stateMachine.snapshot().connected && !paused)
                    {
                        execute(stateMachine.setConnected(true, SystemClock.uptimeMillis()));
                    }
                    return;
                }
                commandWritten = true;
                confirmMeasuredMode();
            }

            @Override
            public void onPermissionRequired()
            {
                startupCommandPending = false;
                stateMachine.waitForUsbPermission();
                publish();
            }

            @Override
            public void onPermissionResult(boolean granted)
            {
                if (destroyed)
                {
                    return;
                }
                if (!granted)
                {
                    startup.complete(false);
                    permissionDeclined = true;
                    stateMachine.usbPermissionDenied();
                    publish();
                }
                else if (!paused)
                {
                    if (startup.isPending())
                    {
                        submitStartupCommand();
                    }
                    else
                    {
                        execute(stateMachine.requestMode(stateMachine.snapshot().requestedMode,
                                SystemClock.uptimeMillis()));
                    }
                }
            }

            @Override
            public void onUnavailable()
            {
                if (!destroyed && startup.isPending())
                {
                    startupCommandPending = false;
                    startup.complete(false);
                    stateMachine.onUsbFailure();
                    publish();
                    return;
                }
                if (!destroyed && stateMachine.snapshot().displayModeTransitioning)
                {
                    execute(stateMachine.onUsbFailure());
                }
            }
        });
    }

    void start()
    {
        publish();
        scheduleTick();
    }

    void setConnected(boolean connected)
    {
        if (!connected)
        {
            permissionDeclined = false;
            pendingGeometryAction = DisplayModeStateMachine.Action.NONE;
        }
        if (paused && connected)
        {
            stateMachine.setConnected(true, SystemClock.uptimeMillis());
            stateMachine.pause();
            publish();
            return;
        }
        execute(stateMachine.setConnected(connected, SystemClock.uptimeMillis()));
    }

    void requestMode(String mode)
    {
        usbClient.cancelPendingCommand();
        startup.clear();
        startupCommandPending = false;
        permissionDeclined = false;
        execute(stateMachine.requestMode(mode, SystemClock.uptimeMillis()));
    }

    void setSystemDisplayDisabled(boolean disabled, int width, int height)
    {
        systemDisplayDisabled = disabled;
        if (!destroyed && startup.begin(stateMachine.snapshot().requestedMode,
                disabled, width, height, stateMachine.snapshot().connected))
        {
            // Prepare once using observed hardware geometry, before Presentation exists.
            // Waiting for system mirroring is not a hardware transition or an applied mode.
            submitStartupCommand();
        }
    }

    private void submitStartupCommand()
    {
        if (!startupCommandPending && !usbClient.isPermissionPending())
        {
            startupCommandPending = true;
            usbClient.request(true, true);
        }
    }

    void setOutputGeometry(DisplayOutputGeometry next)
    {
        if (!destroyed)
        {
            output = next;
            execute(stateMachine.onStereoLayoutChanged(next.stereoReady, SystemClock.uptimeMillis()));
            if (pendingGeometryAction != DisplayModeStateMachine.Action.NONE
                    && next.viewWidth > 0 && next.viewHeight > 0
                    && stateMachine.snapshot().displayModeTransitioning)
            {
                execute(pendingGeometryAction);
            }
            confirmMeasuredMode();
        }
    }

    private boolean measuredModeMatches(boolean stereo)
    {
        return stereo ? output.stereoReady
                : output.modeWidth == 1920 && output.modeHeight == 1080
                        && output.viewWidth > 0 && output.viewHeight > 0;
    }

    private void confirmMeasuredMode()
    {
        if (!commandWritten || destroyed)
        {
            return;
        }
        boolean stereo = DisplayModeStateMachine.STEREO_SCREEN.equals(stateMachine.snapshot().requestedMode);
        if (measuredModeMatches(stereo))
        {
            execute(stateMachine.onPhysicalModeObserved(stereo, SystemClock.uptimeMillis()));
        }
    }

    void onResume()
    {
        if (destroyed)
        {
            return;
        }
        paused = false;
        if (startup.isPending())
        {
            if (!usbClient.isPermissionPending())
            {
                submitStartupCommand();
            }
            scheduleTick();
            return;
        }
        if (!permissionDeclined && !usbClient.isPermissionPending() && stateMachine.snapshot().connected)
        {
            execute(stateMachine.setConnected(true, SystemClock.uptimeMillis()));
        }
        scheduleTick();
    }

    void onPause()
    {
        if (!destroyed)
        {
            paused = true;
            handler.removeCallbacks(stateTick);
            // USB consent and HyperOS screen mirroring are system UI, not a failed mode command.
            if (!usbClient.isPermissionPending() && !systemDisplayDisabled
                    && !startup.isPending()
                    && !(startup.wasWritten() && !stateMachine.snapshot().connected))
            {
                pendingGeometryAction = DisplayModeStateMachine.Action.NONE;
                execute(stateMachine.pause());
            }
        }
    }

    void destroy()
    {
        if (destroyed)
        {
            return;
        }
        destroyed = true;
        handler.removeCallbacks(stateTick);
        usbClient.destroy(output.stereoReady && !systemDisplayDisabled);
    }

    DisplayModeStateMachine.State getState()
    {
        return stateMachine.snapshot();
    }

    private void execute(DisplayModeStateMachine.Action action)
    {
        if (action != DisplayModeStateMachine.Action.NONE)
        {
            DisplayModeStateMachine.State before = stateMachine.snapshot();
            boolean stereo = action == DisplayModeStateMachine.Action.SWITCH_TO_3D;
            if (!stereo && !startup.isPending())
            {
                startup.clear();
            }
            commandWritten = false;
            pendingGeometryAction = DisplayModeStateMachine.Action.NONE;
            if (startup.isPending())
            {
                stateMachine.waitForUsbPermission();
            }
            else if (measuredModeMatches(stereo))
            {
                // Reuse a correct physical mode instead of causing another EDID reconnect
                // after the user has just enabled HyperOS screen mirroring.
                stateMachine.onStereoLayoutChanged(output.stereoReady, SystemClock.uptimeMillis());
                stateMachine.onPhysicalModeObserved(stereo, SystemClock.uptimeMillis());
                startup.clear();
            }
            else if (before.displayModeTransitioning && permissionDeclined)
            {
                stateMachine.usbPermissionDenied();
            }
            else if (before.displayModeTransitioning && startup.hasFailed())
            {
                stateMachine.onUsbFailure();
            }
            else if (stereo && startup.wasWritten())
            {
                // Already sent: observe the new physical/View geometry without another EDID write.
                commandWritten = true;
            }
            else if (before.displayModeTransitioning && output.viewWidth == 0 && !systemDisplayDisabled)
            {
                // Presentation.show() returns before its first measured layout. Observe it
                // before sending anything so an already-correct mode does not reconnect again.
                pendingGeometryAction = action;
            }
            else if (!systemDisplayDisabled)
            {
                startup.clear();
                usbClient.request(stereo, before.displayModeTransitioning);
            }
        }
        publish();
    }

    private void publish()
    {
        DisplayModeStateMachine.State next = stateMachine.snapshot();
        if (next.displayModeApplied)
        {
            startup.clear();
        }
        if (sameState(lastPublishedState, next))
        {
            return;
        }
        lastPublishedState = next;
        if (listener != null)
        {
            listener.onDisplayModeStateChanged(next);
        }
    }

    private static boolean sameState(DisplayModeStateMachine.State first, DisplayModeStateMachine.State second)
    {
        return first != null && second != null
                && first.requestedMode.equals(second.requestedMode)
                && first.activeMode.equals(second.activeMode)
                && first.displayModeApplied == second.displayModeApplied
                && first.displayModeTransitioning == second.displayModeTransitioning
                && first.connected == second.connected
                && first.message.equals(second.message);
    }

    private void scheduleTick()
    {
        handler.removeCallbacks(stateTick);
        if (!destroyed && !paused)
        {
            handler.postDelayed(stateTick, STATE_TICK_MS);
        }
    }
}
