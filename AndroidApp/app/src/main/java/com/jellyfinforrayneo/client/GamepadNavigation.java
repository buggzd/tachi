package com.jellyfinforrayneo.client;

import java.util.LinkedHashMap;

/** UI-thread state machine; no Android event objects or device identifiers cross the bridge. */
final class GamepadNavigation
{
    static final int MAX_DEVICES = 8;
    static final long INITIAL_REPEAT_MS = 350L;
    static final long REPEAT_MS = 120L;
    // First four button slots are directions; remaining slots are A, B, center, Enter, Back.
    private static final String[] COMMANDS =
            {"up", "down", "left", "right", "enter", "back", "enter", "enter", "back"};

    interface Sink
    {
        boolean send(String command);
    }

    private static final class Device
    {
        int held;
        int blocked;
        int owned;
        int lastDirection;
        String hat = "";
        String stick = "";
        boolean awaitNeutral;
        boolean motionOwned;
        float x;
        float y;
        float hx;
        float hy;

        void interrupt()
        {
            blocked |= held;
            hat = "";
            stick = "";
            awaitNeutral |= x != 0 || y != 0 || hx != 0 || hy != 0 || (held & 15) != 0;
        }

        String direction()
        {
            int directions = held & ~blocked & 15;
            if ((directions & (1 << lastDirection)) != 0) return COMMANDS[lastDirection];
            for (int index = 0; index < 4; index++)
            {
                if ((directions & (1 << index)) != 0) return COMMANDS[index];
            }
            return hat.isEmpty() ? stick : hat;
        }
    }

    private final LinkedHashMap<Integer, Device> devices = new LinkedHashMap<>();
    private final Sink sink;
    private boolean enabled;
    private Integer activeDevice;
    private String direction = "";
    private long repeatAt;

    GamepadNavigation(Sink sink)
    {
        this.sink = sink;
    }

    void setEnabled(boolean value)
    {
        if (enabled == value) return;
        enabled = value;
        if (!value)
        {
            interrupt();
            devices.values().forEach(state -> state.awaitNeutral = true);
        }
    }

    void interrupt()
    {
        devices.values().forEach(Device::interrupt);
        direction = "";
        repeatAt = 0;
        activeDevice = null;
    }

    void register(int deviceId)
    {
        device(deviceId);
    }

    void remove(int deviceId)
    {
        if (activeDevice != null && activeDevice == deviceId)
        {
            direction = "";
            repeatAt = 0;
            activeDevice = null;
        }
        devices.remove(deviceId);
    }

    void changed(int deviceId)
    {
        remove(deviceId);
        device(deviceId).awaitNeutral = true;
    }

    private Device device(int id)
    {
        Device result = devices.get(id);
        if (result == null)
        {
            if (devices.size() == MAX_DEVICES) remove(devices.keySet().iterator().next());
            result = new Device();
            devices.put(id, result);
        }
        return result;
    }

    boolean key(int id, int button, boolean down, int repeats, boolean cancelled, long now)
    {
        if (button < 0 || button >= COMMANDS.length) return false;
        Device state = device(id);
        int bit = 1 << button;
        boolean owned = (state.owned & bit) != 0;
        boolean held = (state.held & bit) != 0;
        if (!down)
        {
            state.held &= ~bit;
            state.blocked &= ~bit;
            state.owned &= ~bit;
            if (activeDevice != null && activeDevice == id) updateDirection(state.direction(), now);
            return owned;
        }
        state.held |= bit;
        if (!enabled || cancelled || (!held && repeats > 0)) state.blocked |= bit;
        if (cancelled && activeDevice != null && activeDevice == id) interrupt();
        if (!enabled) return owned;
        state.owned |= bit;
        if (held || repeats > 0 || (state.blocked & bit) != 0) return true;
        activate(id);
        if (button < 4)
        {
            state.lastDirection = button;
            updateDirection(state.direction(), now);
        }
        else
        {
            // A confirm/back must not carry a held direction into the newly opened page.
            interrupt();
            sink.send(COMMANDS[button]);
        }
        return true;
    }

    boolean motion(int id, float x, float y, float hx, float hy,
            float flat, boolean dispatch, long now)
    {
        Device state = device(id);
        boolean moved = x != state.x || y != state.y || hx != state.hx || hy != state.hy;
        boolean nonzero = x != 0 || y != 0 || hx != 0 || hy != 0;
        boolean consume = state.motionOwned || (enabled && (moved || nonzero));
        state.x = x;
        state.y = y;
        state.hx = hx;
        state.hy = hy;
        if (!enabled) state.awaitNeutral = true;
        if (state.awaitNeutral && Math.abs(x) <= Math.max(0.35f, flat)
                && Math.abs(y) <= Math.max(0.35f, flat)
                && Math.abs(hx) < 0.5f && Math.abs(hy) < 0.5f)
        {
            state.awaitNeutral = false;
        }
        state.motionOwned = consume && nonzero;
        if (!enabled || state.awaitNeutral) return consume;
        state.hat = quantize(hx, hy, state.hat, 0.5f, 0.25f);
        state.stick = quantize(x, y, state.stick, Math.max(0.55f, flat), Math.max(0.35f, flat));
        if (dispatch)
        {
            String next = state.direction();
            if (!next.isEmpty()) activate(id);
            if (activeDevice != null && activeDevice == id) updateDirection(next, now);
        }
        return consume;
    }

    private void activate(int id)
    {
        if (activeDevice != null && activeDevice == id) return;
        if (activeDevice != null) devices.get(activeDevice).interrupt();
        activeDevice = id;
        direction = "";
        repeatAt = 0;
    }

    private void updateDirection(String next, long now)
    {
        if (!enabled || next.equals(direction)) return;
        direction = next;
        repeatAt = 0;
        if (!next.isEmpty())
        {
            if (sink.send(next)) repeatAt = now + INITIAL_REPEAT_MS;
            else interrupt();
        }
    }

    long nextRepeatAt()
    {
        return repeatAt;
    }

    void repeat(long now)
    {
        if (!enabled || repeatAt == 0 || now < repeatAt) return;
        if (sink.send(direction)) repeatAt = now + REPEAT_MS;
        else interrupt();
    }

    private static String quantize(float x, float y, String previous, float enter, float release)
    {
        float previousAxis = "left".equals(previous) ? -x : "right".equals(previous) ? x
                : "up".equals(previous) ? -y : "down".equals(previous) ? y : 0;
        float other = "left".equals(previous) || "right".equals(previous) ? Math.abs(y) : Math.abs(x);
        if (!previous.isEmpty() && previousAxis > release && other <= previousAxis + 0.15f)
        {
            return previous;
        }
        if (Math.max(Math.abs(x), Math.abs(y)) < enter) return "";
        if (Math.abs(x) >= Math.abs(y)) return x < 0 ? "left" : "right";
        return y < 0 ? "up" : "down";
    }
}
