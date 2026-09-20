package com.jellyfinforrayneo.client;

import android.content.Context;
import android.hardware.input.InputManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;

/** Shared by both windows. All callbacks and navigation run on the main looper. */
final class GamepadInputController implements InputManager.InputDeviceListener
{
    private final InputManager inputManager;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final GamepadNavigation navigation;
    private final Runnable refreshEligibility;
    private final Runnable repeat = this::repeatDirection;

    GamepadInputController(Context context, GamepadNavigation.Sink sink, Runnable refreshEligibility)
    {
        inputManager = (InputManager) context.getSystemService(Context.INPUT_SERVICE);
        navigation = new GamepadNavigation(sink);
        this.refreshEligibility = refreshEligibility;
        if (inputManager != null)
        {
            inputManager.registerInputDeviceListener(this, handler);
            for (int id : inputManager.getInputDeviceIds())
            {
                if (isController(inputManager.getInputDevice(id))) navigation.register(id);
            }
        }
    }

    static boolean isControllerSource(int sources)
    {
        return (sources & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD
                || (sources & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK
                || (sources & InputDevice.SOURCE_DPAD) == InputDevice.SOURCE_DPAD;
    }

    private static boolean isController(InputDevice device)
    {
        return device != null && isControllerSource(device.getSources());
    }

    static boolean isControllerKey(KeyEvent event)
    {
        return event != null && (isControllerSource(event.getSource()) || isController(event.getDevice()));
    }

    static int buttonForKey(int code)
    {
        switch (code)
        {
            case KeyEvent.KEYCODE_DPAD_UP: return 0;
            case KeyEvent.KEYCODE_DPAD_DOWN: return 1;
            case KeyEvent.KEYCODE_DPAD_LEFT: return 2;
            case KeyEvent.KEYCODE_DPAD_RIGHT: return 3;
            case KeyEvent.KEYCODE_BUTTON_A: return 4;
            case KeyEvent.KEYCODE_BUTTON_B: return 5;
            case KeyEvent.KEYCODE_DPAD_CENTER: return 6;
            case KeyEvent.KEYCODE_ENTER: return 7;
            case KeyEvent.KEYCODE_BACK: return 8;
            default: return -1;
        }
    }

    boolean key(KeyEvent event)
    {
        if (!isControllerKey(event)) return false;
        int button = buttonForKey(event.getKeyCode());
        if (button < 0 || (event.getAction() != KeyEvent.ACTION_DOWN
                && event.getAction() != KeyEvent.ACTION_UP)) return false;
        refreshEligibility.run();
        boolean handled = navigation.key(event.getDeviceId(), button,
                event.getAction() == KeyEvent.ACTION_DOWN, event.getRepeatCount(),
                event.isCanceled(), SystemClock.uptimeMillis());
        scheduleRepeat();
        return handled;
    }

    boolean motion(MotionEvent event)
    {
        if (event == null || (!event.isFromSource(InputDevice.SOURCE_JOYSTICK)
                && !event.isFromSource(InputDevice.SOURCE_DPAD))
                || event.getActionMasked() != MotionEvent.ACTION_MOVE) return false;
        InputDevice device = event.getDevice();
        if (device == null) return false;
        refreshEligibility.run();
        boolean handled = false;
        int history = event.getHistorySize();
        // Fold recent history into state, but dispatch at most one move for the entire batch.
        for (int index = Math.max(0, history - 32); index <= history; index++)
        {
            int sample = index == history ? -1 : index;
            handled |= navigation.motion(event.getDeviceId(),
                    axis(event, device, MotionEvent.AXIS_X, sample),
                    axis(event, device, MotionEvent.AXIS_Y, sample),
                    axis(event, device, MotionEvent.AXIS_HAT_X, sample),
                    axis(event, device, MotionEvent.AXIS_HAT_Y, sample),
                    Math.max(flat(device, event.getSource(), MotionEvent.AXIS_X),
                            flat(device, event.getSource(), MotionEvent.AXIS_Y)),
                    sample == -1, SystemClock.uptimeMillis());
        }
        scheduleRepeat();
        return handled;
    }

    private static float axis(MotionEvent event, InputDevice device, int axis, int sample)
    {
        InputDevice.MotionRange range = device.getMotionRange(axis, event.getSource());
        if (range == null) return 0;
        float value = sample < 0 ? event.getAxisValue(axis) : event.getHistoricalAxisValue(axis, sample);
        float limit = value < 0 ? Math.abs(range.getMin()) : Math.abs(range.getMax());
        if (!Float.isFinite(value) || limit <= 0 || !Float.isFinite(limit)) return 0;
        return Math.abs(value) <= range.getFlat() ? 0 : Math.max(-1, Math.min(1, value / limit));
    }

    private static float flat(InputDevice device, int source, int axis)
    {
        InputDevice.MotionRange range = device.getMotionRange(axis, source);
        if (range == null) return 0;
        float limit = Math.max(Math.abs(range.getMin()), Math.abs(range.getMax()));
        float value = range.getFlat();
        return Float.isFinite(value) && Float.isFinite(limit) && limit > 0
                ? Math.max(0, Math.min(1, value / limit)) : 0;
    }

    void setEnabled(boolean enabled)
    {
        navigation.setEnabled(enabled);
        scheduleRepeat();
    }

    void interrupt()
    {
        navigation.interrupt();
        scheduleRepeat();
    }

    private void repeatDirection()
    {
        refreshEligibility.run();
        navigation.repeat(SystemClock.uptimeMillis());
        scheduleRepeat();
    }

    private void scheduleRepeat()
    {
        handler.removeCallbacks(repeat);
        if (navigation.nextRepeatAt() != 0) handler.postAtTime(repeat, navigation.nextRepeatAt());
    }

    @Override
    public void onInputDeviceAdded(int id)
    {
        if (inputManager != null && isController(inputManager.getInputDevice(id))) navigation.changed(id);
        scheduleRepeat();
    }

    @Override
    public void onInputDeviceChanged(int id)
    {
        navigation.remove(id);
        onInputDeviceAdded(id);
    }

    @Override
    public void onInputDeviceRemoved(int id)
    {
        navigation.remove(id);
        scheduleRepeat();
    }

    void close()
    {
        if (inputManager != null) inputManager.unregisterInputDeviceListener(this);
        navigation.setEnabled(false);
        handler.removeCallbacksAndMessages(null);
    }
}
