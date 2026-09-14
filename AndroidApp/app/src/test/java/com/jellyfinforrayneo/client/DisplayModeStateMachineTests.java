package com.jellyfinforrayneo.client;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class DisplayModeStateMachineTests
{
    @Test
    public void pauseDuringUnconfirmedTransitionStillRequestsSafe2D()
    {
        DisplayModeStateMachine machine = new DisplayModeStateMachine(DisplayModeStateMachine.STEREO_SCREEN);
        machine.setConnected(true, 0L);
        assertEquals(DisplayModeStateMachine.Action.SWITCH_TO_2D, machine.pause());
        assertFalse(machine.snapshot().displayModeTransitioning);
    }

    @Test
    public void connectAndConfirmStereo_SeparatesTransitionFromAppliedState()
    {
        DisplayModeStateMachine machine = new DisplayModeStateMachine(
                DisplayModeStateMachine.STEREO_SCREEN);

        assertEquals(
                DisplayModeStateMachine.Action.SWITCH_TO_3D,
                machine.setConnected(true, 100L));
        DisplayModeStateMachine.State transitioning = machine.snapshot();
        assertTrue(transitioning.displayModeTransitioning);
        assertFalse(transitioning.displayModeApplied);

        machine.onCommandResponse(DisplayModeStateMachine.COMMAND_3D, true, 200L);

        assertTrue(machine.snapshot().displayModeTransitioning);
        assertFalse(machine.snapshot().displayModeApplied);
        machine.onStereoLayoutChanged(true, 250L);

        DisplayModeStateMachine.State applied = machine.snapshot();
        assertFalse(applied.displayModeTransitioning);
        assertTrue(applied.displayModeApplied);
        assertEquals(DisplayModeStateMachine.STEREO_SCREEN, applied.activeMode);
    }

    @Test
    public void timeout_RevealsSafeMirrorUntilExplicitRetry()
    {
        DisplayModeStateMachine machine = new DisplayModeStateMachine(
                DisplayModeStateMachine.STEREO_SCREEN);
        machine.setConnected(true, 0L);

        assertEquals(
                DisplayModeStateMachine.Action.SWITCH_TO_2D,
                machine.tick(DisplayModeStateMachine.TRANSITION_TIMEOUT_MS));
        DisplayModeStateMachine.State failed = machine.snapshot();
        assertFalse(failed.displayModeTransitioning);
        assertFalse(failed.displayModeApplied);
        assertEquals(DisplayModeStateMachine.MIRROR_2D, failed.activeMode);
        assertEquals(DisplayModeStateMachine.STEREO_SCREEN, failed.requestedMode);

        assertEquals(
                DisplayModeStateMachine.Action.NONE,
                machine.tick(DisplayModeStateMachine.TRANSITION_TIMEOUT_MS + 60_000L));
        assertEquals(
                DisplayModeStateMachine.Action.SWITCH_TO_3D,
                machine.requestMode(
                        DisplayModeStateMachine.STEREO_SCREEN,
                        DisplayModeStateMachine.TRANSITION_TIMEOUT_MS + 60_001L));
    }

    @Test
    public void disconnect_EndsTransitionAndReconnectsUsingSavedRequest()
    {
        DisplayModeStateMachine machine = new DisplayModeStateMachine(
                DisplayModeStateMachine.STEREO_SCREEN);
        machine.setConnected(true, 0L);

        machine.setConnected(false, 10L);

        DisplayModeStateMachine.State disconnected = machine.snapshot();
        assertFalse(disconnected.displayModeTransitioning);
        assertEquals(DisplayModeStateMachine.MIRROR_2D, disconnected.activeMode);
        assertEquals(
                DisplayModeStateMachine.Action.SWITCH_TO_3D,
                machine.setConnected(true, 20L));
    }

    @Test
    public void duplicateConnectionWhileTransitioning_DoesNotRepeatSdkCommand()
    {
        DisplayModeStateMachine machine = new DisplayModeStateMachine(
                DisplayModeStateMachine.STEREO_SCREEN);

        assertEquals(
                DisplayModeStateMachine.Action.SWITCH_TO_3D,
                machine.setConnected(true, 0L));
        assertEquals(
                DisplayModeStateMachine.Action.NONE,
                machine.setConnected(true, 100L));

        DisplayModeStateMachine.State state = machine.snapshot();
        assertTrue(state.displayModeTransitioning);
        assertFalse(state.displayModeApplied);
        assertEquals(DisplayModeStateMachine.STEREO_SCREEN, state.requestedMode);
    }

    @Test
    public void pause_KeepsConfirmedModeWithoutHardwareRoundTrip()
    {
        DisplayModeStateMachine machine = new DisplayModeStateMachine(
                DisplayModeStateMachine.STEREO_SCREEN);
        machine.setConnected(true, 0L);
        machine.onStereoLayoutChanged(true, 5L);
        machine.onCommandResponse(DisplayModeStateMachine.COMMAND_3D, true, 10L);

        assertEquals(DisplayModeStateMachine.Action.NONE, machine.pause());
        assertEquals(DisplayModeStateMachine.Action.NONE, machine.setConnected(true, 20L));
        DisplayModeStateMachine.State paused = machine.snapshot();
        assertEquals(DisplayModeStateMachine.STEREO_SCREEN, paused.requestedMode);
        assertEquals(DisplayModeStateMachine.STEREO_SCREEN, paused.activeMode);
        assertFalse(paused.displayModeTransitioning);
    }

    @Test
    public void layoutBeforeHardwareConfirmation_DoesNotRevealStereoEarly()
    {
        DisplayModeStateMachine machine = stereoMachine();
        machine.onStereoLayoutChanged(true, 10L);
        assertTrue(machine.snapshot().displayModeTransitioning);
        assertFalse(machine.snapshot().displayModeApplied);
        machine.onCommandResponse(DisplayModeStateMachine.COMMAND_2D, true, 15L);
        assertTrue(machine.snapshot().displayModeTransitioning);
        machine.onCommandResponse(DisplayModeStateMachine.COMMAND_3D, true, 20L);
        assertTrue(machine.snapshot().displayModeApplied);
        assertFalse(machine.snapshot().displayModeTransitioning);
    }

    @Test
    public void confirmedHardwareWithoutFullSbsViewport_TimesOutAndIgnoresLateLayout()
    {
        DisplayModeStateMachine machine = stereoMachine();
        machine.onCommandResponse(DisplayModeStateMachine.COMMAND_3D, true, 20L);
        assertEquals(DisplayModeStateMachine.Action.SWITCH_TO_2D,
                machine.tick(DisplayModeStateMachine.TRANSITION_TIMEOUT_MS));
        assertTrue(machine.snapshot().message.contains("输出尺寸"));
        assertEquals(DisplayModeStateMachine.Action.NONE, machine.onStereoLayoutChanged(true, 2000L));
        machine.onCommandResponse(DisplayModeStateMachine.COMMAND_3D, true, 2010L);
        assertFalse(machine.snapshot().displayModeApplied);
        assertEquals(DisplayModeStateMachine.MIRROR_2D, machine.snapshot().activeMode);
    }

    @Test
    public void layoutArrivesAtDeadline_FallsBackEvenIfHardwareWasConfirmed()
    {
        DisplayModeStateMachine machine = stereoMachine();
        machine.onCommandResponse(DisplayModeStateMachine.COMMAND_3D, true, 20L);
        assertEquals(DisplayModeStateMachine.Action.SWITCH_TO_2D,
                machine.onStereoLayoutChanged(true, DisplayModeStateMachine.TRANSITION_TIMEOUT_MS));
        assertFalse(machine.snapshot().displayModeApplied);
    }

    @Test
    public void losingAppliedStereoGeometry_FallsBackOnceWithoutRetrying()
    {
        DisplayModeStateMachine machine = stereoMachine();
        machine.onStereoLayoutChanged(true, 10L);
        machine.onCommandResponse(DisplayModeStateMachine.COMMAND_3D, true, 20L);
        assertEquals(DisplayModeStateMachine.Action.SWITCH_TO_2D, machine.onStereoLayoutChanged(false, 30L));
        assertFalse(machine.snapshot().displayModeTransitioning);
        assertEquals(DisplayModeStateMachine.MIRROR_2D, machine.snapshot().activeMode);
        assertEquals(DisplayModeStateMachine.Action.NONE, machine.onStereoLayoutChanged(false, 40L));
        assertEquals(DisplayModeStateMachine.Action.NONE, machine.onStereoLayoutChanged(true, 50L));
        assertFalse(machine.snapshot().displayModeApplied);
    }

    @Test
    public void reconnect_RequiresFreshLayoutAndHardwareConfirmation()
    {
        DisplayModeStateMachine machine = stereoMachine();
        machine.onStereoLayoutChanged(true, 10L);
        machine.onCommandResponse(DisplayModeStateMachine.COMMAND_3D, true, 20L);
        machine.setConnected(false, 30L);
        machine.setConnected(true, 40L);
        machine.onCommandResponse(DisplayModeStateMachine.COMMAND_3D, true, 50L);
        assertTrue(machine.snapshot().displayModeTransitioning);
        machine.onStereoLayoutChanged(true, 60L);
        assertTrue(machine.snapshot().displayModeApplied);
    }

    @Test
    public void hardwareRejection_DoesNotBecomeAppliedWhenLayoutLaterSucceeds()
    {
        DisplayModeStateMachine machine = stereoMachine();
        assertEquals(DisplayModeStateMachine.Action.SWITCH_TO_2D,
                machine.onCommandResponse(DisplayModeStateMachine.COMMAND_3D, false, 20L));
        machine.onStereoLayoutChanged(true, 30L);
        assertFalse(machine.snapshot().displayModeApplied);
        assertFalse(machine.snapshot().displayModeTransitioning);
    }

    @Test
    public void mirrorConfirmation_DoesNotRequireStereoGeometry()
    {
        DisplayModeStateMachine machine = new DisplayModeStateMachine(DisplayModeStateMachine.MIRROR_2D);
        machine.setConnected(true, 0L);
        machine.onCommandResponse(DisplayModeStateMachine.COMMAND_2D, false, 10L);
        machine.onStereoLayoutChanged(false, 20L);
        assertTrue(machine.snapshot().displayModeApplied);
        assertEquals(DisplayModeStateMachine.MIRROR_2D, machine.snapshot().activeMode);
    }

    @Test
    public void mirrorAcknowledgementWithStereoFlag_LeavesModeUnconfirmed()
    {
        DisplayModeStateMachine machine = new DisplayModeStateMachine(DisplayModeStateMachine.MIRROR_2D);
        machine.setConnected(true, 0L);
        assertEquals(DisplayModeStateMachine.Action.SWITCH_TO_2D,
                machine.onCommandResponse(DisplayModeStateMachine.COMMAND_2D, true, 10L));
        assertFalse(machine.snapshot().displayModeApplied);
        assertFalse(machine.snapshot().displayModeTransitioning);
    }

    private static DisplayModeStateMachine stereoMachine()
    {
        DisplayModeStateMachine machine = new DisplayModeStateMachine(DisplayModeStateMachine.STEREO_SCREEN);
        machine.setConnected(true, 0L);
        return machine;
    }

    @Test
    public void usbConsentWait_DoesNotHideContentOrRunHardwareTimeout()
    {
        DisplayModeStateMachine machine = stereoMachine();
        machine.waitForUsbPermission();
        assertFalse(machine.snapshot().displayModeTransitioning);
        assertFalse(machine.snapshot().displayModeApplied);
        assertEquals(DisplayModeStateMachine.STEREO_SCREEN, machine.snapshot().requestedMode);
        assertEquals(DisplayModeStateMachine.Action.NONE, machine.tick(60_000L));
        assertEquals(DisplayModeStateMachine.Action.SWITCH_TO_3D,
                machine.requestMode(DisplayModeStateMachine.STEREO_SCREEN, 60_001L));
        assertEquals(DisplayModeStateMachine.Action.NONE, machine.tick(60_100L));
    }

    @Test
    public void deniedUsbConsent_StaysVisibleAndUnconfirmedUntilAnotherRequest()
    {
        DisplayModeStateMachine machine = stereoMachine();
        machine.usbPermissionDenied();
        machine.onStereoLayoutChanged(true, 20L);
        machine.onPhysicalModeObserved(true, 30L);
        assertFalse(machine.snapshot().displayModeTransitioning);
        assertFalse(machine.snapshot().displayModeApplied);
        assertEquals(DisplayModeStateMachine.Action.NONE, machine.tick(60_000L));
        assertTrue(machine.snapshot().message.contains("USB"));
    }

    @Test
    public void modernPhysicalStereoObservation_RequiresFullSbsLayout()
    {
        DisplayModeStateMachine machine = stereoMachine();
        machine.onPhysicalModeObserved(true, 20L);
        assertFalse(machine.snapshot().displayModeApplied);
        machine.onStereoLayoutChanged(true, 30L);
        assertTrue(machine.snapshot().displayModeApplied);
    }

    @Test
    public void modernStereoRequest_DoesNotAcceptExisting2DOutput()
    {
        DisplayModeStateMachine machine = stereoMachine();
        machine.onPhysicalModeObserved(false, 20L);
        assertFalse(machine.snapshot().displayModeApplied);
        machine.onStereoLayoutChanged(true, 30L);
        assertFalse(machine.snapshot().displayModeApplied);
        machine.onPhysicalModeObserved(true, 40L);
        assertTrue(machine.snapshot().displayModeApplied);
    }

    @Test
    public void latePhysicalStereoObservation_DoesNotRetryOrRevealStereo()
    {
        DisplayModeStateMachine machine = stereoMachine();
        machine.onStereoLayoutChanged(true, 20L);
        assertEquals(DisplayModeStateMachine.Action.SWITCH_TO_2D,
                machine.onPhysicalModeObserved(true, DisplayModeStateMachine.TRANSITION_TIMEOUT_MS));
        machine.onPhysicalModeObserved(true, DisplayModeStateMachine.TRANSITION_TIMEOUT_MS + 1L);
        assertFalse(machine.snapshot().displayModeApplied);
        assertFalse(machine.snapshot().displayModeTransitioning);
    }

    @Test
    public void modernMirrorRequest_IsConfirmedByMeasured2DOutput()
    {
        DisplayModeStateMachine machine = new DisplayModeStateMachine(DisplayModeStateMachine.MIRROR_2D);
        machine.setConnected(true, 0L);
        machine.onPhysicalModeObserved(true, 20L);
        assertFalse(machine.snapshot().displayModeApplied);
        machine.onPhysicalModeObserved(false, 30L);
        assertTrue(machine.snapshot().displayModeApplied);
    }
}
