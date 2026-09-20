package com.jellyfinforrayneo.client;

import android.view.InputDevice;
import android.view.KeyEvent;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class GamepadNavigationTests
{
    private static final class Fixture
    {
        final List<String> commands = new ArrayList<>();
        boolean deliver = true;
        final GamepadNavigation input = new GamepadNavigation(command ->
        {
            if (!deliver) return false;
            commands.add(command);
            return true;
        });

        Fixture()
        {
            input.setEnabled(true);
        }

        boolean key(int button, boolean down, int repeats, long now)
        {
            return input.key(1, button, down, repeats, false, now);
        }

        boolean axes(float x, float y, float hx, float hy, long now)
        {
            return input.motion(1, x, y, hx, hy, 0.05f, true, now);
        }
    }

    @Test
    public void controllerSourcesDoNotMistakeSharedKeyboardClassBitsForGamepads()
    {
        assertFalse(GamepadInputController.isControllerSource(InputDevice.SOURCE_KEYBOARD));
        assertFalse(GamepadInputController.isControllerSource(InputDevice.SOURCE_TOUCHSCREEN));
        assertFalse(GamepadInputController.isControllerSource(InputDevice.SOURCE_MOUSE));
        assertTrue(GamepadInputController.isControllerSource(InputDevice.SOURCE_GAMEPAD | InputDevice.SOURCE_KEYBOARD));
        assertTrue(GamepadInputController.isControllerSource(InputDevice.SOURCE_JOYSTICK));
        assertTrue(GamepadInputController.isControllerSource(InputDevice.SOURCE_DPAD));
        assertEquals(-1, GamepadInputController.buttonForKey(KeyEvent.KEYCODE_BUTTON_START));
        assertEquals(-1, GamepadInputController.buttonForKey(KeyEvent.KEYCODE_VOLUME_UP));
        assertEquals(-1, GamepadInputController.buttonForKey(KeyEvent.KEYCODE_HOME));
    }

    @Test
    public void confirmAndBackConsumeRepeatsAndMatchingReleaseWithoutClickingTwice()
    {
        Fixture f = new Fixture();
        for (int code : new int[] {KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_BUTTON_B,
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_BACK})
        {
            int button = GamepadInputController.buttonForKey(code);
            assertTrue(f.key(button, true, 0, 0));
            assertTrue(f.key(button, true, 0, 1));
            assertTrue(f.key(button, true, 1, 500));
            assertTrue(f.key(button, false, 0, 600));
        }
        assertEquals(List.of("enter", "back", "enter", "enter", "back"), f.commands);
        assertEquals(0, f.input.nextRepeatAt());
    }

    @Test
    public void directionUsesOneRepeatClockAndNeverCatchesUpInBursts()
    {
        Fixture f = new Fixture();
        f.key(3, true, 0, 100);
        f.key(3, true, 1, 200);
        f.input.repeat(449);
        assertEquals(List.of("right"), f.commands);
        f.input.repeat(450);
        f.input.repeat(10_000);
        assertEquals(List.of("right", "right", "right"), f.commands);
        assertEquals(10_120, f.input.nextRepeatAt());
        assertTrue(f.key(3, false, 0, 10_010));
        f.input.repeat(20_000);
        assertEquals(3, f.commands.size());
        assertEquals(0, f.input.nextRepeatAt());
    }

    @Test
    public void dpadKeyAndHatProduceOneMoveInEitherEventOrder()
    {
        for (boolean hatFirst : new boolean[] {true, false})
        {
            Fixture f = new Fixture();
            if (hatFirst) f.axes(0, 0, -1, 0, 0);
            f.key(2, true, 0, 1);
            f.axes(0, 0, -1, 0, 2);
            assertEquals(List.of("left"), f.commands);
            f.key(2, false, 0, 3);
            f.axes(0, 0, 0, 0, 4);
            f.input.repeat(1000);
            assertEquals(List.of("left"), f.commands);
        }
    }

    @Test
    public void joystickFiltersDriftKeepsDiagonalStableAndStopsAtNeutral()
    {
        Fixture f = new Fixture();
        f.axes(0.2f, -0.15f, 0, 0, 0);
        assertTrue(f.commands.isEmpty());
        f.axes(0.7f, 0.65f, 0, 0, 10);
        f.axes(0.62f, 0.7f, 0, 0, 20);
        f.axes(0.45f, 0, 0, 0, 30);
        assertEquals(List.of("right"), f.commands);
        f.axes(-0.8f, 0, 0, 0, 40);
        f.axes(0, 0, 0, 0, 50);
        f.input.repeat(1000);
        assertEquals(List.of("right", "left"), f.commands);
    }

    @Test
    public void hardwareFlatRegionOverridesMenuThreshold()
    {
        Fixture f = new Fixture();
        f.input.motion(1, 0.7f, 0, 0, 0, 0.8f, true, 0);
        assertTrue(f.commands.isEmpty());
        f.input.motion(1, 0.9f, 0, 0, 0, 0.8f, true, 10);
        assertEquals(List.of("right"), f.commands);
    }

    @Test
    public void hatTakesPriorityOverStickWithoutRepeatingTheSameDirection()
    {
        Fixture f = new Fixture();
        f.axes(0.9f, 0, 1, 0, 0);
        f.axes(0.9f, 0, 0, -1, 10);
        f.axes(0.9f, 0, 0, 0, 20);
        assertEquals(List.of("right", "up", "right"), f.commands);
    }

    @Test
    public void motionHistoryIsFoldedWithoutSendingEachIntermediateDirection()
    {
        Fixture f = new Fixture();
        f.input.motion(1, -0.9f, 0, 0, 0, 0, false, 0);
        f.input.motion(1, 0, -0.9f, 0, 0, 0, false, 1);
        f.axes(0.9f, 0, 0, 0, 2);
        assertEquals(List.of("right"), f.commands);
    }

    @Test
    public void pauseDropsRepeatsAndRequiresReleaseAndNeutralBeforeResuming()
    {
        Fixture f = new Fixture();
        f.key(0, true, 0, 0);
        f.axes(0, -1, 0, 0, 1);
        f.input.setEnabled(false);
        f.input.repeat(1000);
        f.input.setEnabled(true);
        f.key(0, true, 2, 1010);
        f.axes(0, -1, 0, 0, 1020);
        assertEquals(List.of("up"), f.commands);
        assertTrue(f.key(0, false, 0, 1030));
        f.axes(0, 0, 0, 0, 1040);
        f.axes(0, -1, 0, 0, 1050);
        assertEquals(List.of("up", "up"), f.commands);
    }

    @Test
    public void keyStartedWhileInactiveCannotBecomeAConfirmAfterResume()
    {
        Fixture f = new Fixture();
        f.input.setEnabled(false);
        assertFalse(f.key(4, true, 0, 0));
        f.input.setEnabled(true);
        assertTrue(f.key(4, true, 1, 10));
        assertTrue(f.commands.isEmpty());
        f.key(4, false, 0, 20);
        f.key(4, true, 0, 30);
        assertEquals(List.of("enter"), f.commands);
    }

    @Test
    public void releaseAfterLosingEligibilityIsStillConsumedWithoutDefaultBack()
    {
        Fixture f = new Fixture();
        f.key(5, true, 0, 0);
        f.input.setEnabled(false);
        assertTrue(f.key(5, false, 0, 10));
        assertEquals(List.of("back"), f.commands);
        assertEquals(0, f.input.nextRepeatAt());
    }

    @Test
    public void cancelledDirectionStopsRepeatWithoutActivatingAnotherControl()
    {
        Fixture f = new Fixture();
        f.key(0, true, 0, 0);
        assertTrue(f.input.key(1, 0, false, 0, true, 10));
        f.input.repeat(1000);
        assertEquals(List.of("up"), f.commands);
        assertEquals(0, f.input.nextRepeatAt());
    }

    @Test
    public void orphanRepeatIsConsumedWithoutStartingANewPress()
    {
        Fixture f = new Fixture();
        assertTrue(f.key(5, true, 4, 0));
        f.key(5, false, 0, 1);
        assertTrue(f.commands.isEmpty());
        f.key(5, true, 0, 2);
        assertEquals(List.of("back"), f.commands);
    }

    @Test
    public void confirmStopsHeldNavigationButAllowsAFreshStickMovement()
    {
        Fixture f = new Fixture();
        f.key(3, true, 0, 0);
        f.key(4, true, 0, 1);
        f.input.repeat(1000);
        assertEquals(List.of("right", "enter"), f.commands);
        f.key(3, false, 0, 1010);
        f.axes(0, 0, 0, 0, 1020);
        f.axes(0, 1, 0, 0, 1030);
        assertEquals(List.of("right", "enter", "down"), f.commands);

        Fixture fresh = new Fixture();
        fresh.key(4, true, 0, 0);
        fresh.key(4, false, 0, 1);
        fresh.axes(0, 1, 0, 0, 2);
        assertEquals(List.of("enter", "down"), fresh.commands);
    }

    @Test
    public void phoneInputInterruptsTheHoldUntilItIsReleased()
    {
        Fixture f = new Fixture();
        f.key(2, true, 0, 0);
        f.input.interrupt();
        f.key(2, true, 3, 1000);
        f.input.repeat(2000);
        assertEquals(List.of("left"), f.commands);
        assertTrue(f.key(2, false, 0, 2010));
        f.key(2, true, 0, 2020);
        assertEquals(List.of("left", "left"), f.commands);
    }

    @Test
    public void disconnectAndChangedDeviceCancelTheActiveHold()
    {
        Fixture f = new Fixture();
        f.axes(1, 0, 0, 0, 0);
        f.input.remove(1);
        f.input.repeat(1000);
        f.input.changed(2);
        f.input.motion(2, 1, 0, 0, 0, 0, true, 1010);
        assertEquals(List.of("right"), f.commands);
        f.input.motion(2, 0, 0, 0, 0, 0, true, 1020);
        f.input.motion(2, 1, 0, 0, 0, 0, true, 1030);
        assertEquals(List.of("right", "right"), f.commands);
    }

    @Test
    public void switchingControllersDoesNotLetTheOldHoldStealControl()
    {
        Fixture f = new Fixture();
        f.axes(-1, 0, 0, 0, 0);
        f.input.key(2, 1, true, 0, false, 10);
        f.axes(-1, 0, 0, 0, 20);
        f.input.repeat(360);
        assertEquals(List.of("left", "down", "down"), f.commands);
        f.input.remove(1);
        f.input.repeat(480);
        assertEquals("down", f.commands.get(3));
    }

    @Test
    public void failedDeliveryDoesNotRetryUntilAReleasedNewInput()
    {
        Fixture f = new Fixture();
        f.deliver = false;
        f.key(3, true, 0, 0);
        assertEquals(0, f.input.nextRepeatAt());
        f.deliver = true;
        f.key(3, true, 3, 1000);
        f.input.repeat(2000);
        assertTrue(f.commands.isEmpty());
        f.key(3, false, 0, 2010);
        f.key(3, true, 0, 2020);
        assertEquals(List.of("right"), f.commands);
    }

    @Test
    public void boundedDeviceEvictionCannotLeaveAnOrphanRepeat()
    {
        Fixture f = new Fixture();
        f.key(3, true, 0, 0);
        for (int id = 2; id <= GamepadNavigation.MAX_DEVICES + 1; id++) f.input.register(id);
        f.input.repeat(1000);
        assertEquals(List.of("right"), f.commands);
        assertEquals(0, f.input.nextRepeatAt());
    }

    @Test
    public void unrelatedNeutralMotionAndUnknownKeysAreNotConsumed()
    {
        Fixture f = new Fixture();
        assertFalse(f.axes(0, 0, 0, 0, 0));
        assertFalse(f.key(-1, true, 0, 0));
        assertFalse(f.key(9, true, 0, 0));
        f.axes(1, 0, 0, 0, 1);
        assertTrue(f.axes(0, 0, 0, 0, 2));
        assertFalse(f.axes(0, 0, 0, 0, 3));
    }
}
