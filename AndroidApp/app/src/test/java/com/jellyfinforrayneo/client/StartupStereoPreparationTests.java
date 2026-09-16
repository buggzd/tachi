package com.jellyfinforrayneo.client;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class StartupStereoPreparationTests
{
    @Test
    public void preparesSavedStereoOnlyForDisabledKnownMirrorOutput()
    {
        StartupStereoPreparation preparation = new StartupStereoPreparation();
        assertFalse(preparation.begin("mirror_2d", true, 1920, 1080, false));
        assertFalse(preparation.begin("stereo_screen", false, 1920, 1080, false));
        assertFalse(preparation.begin("stereo_screen", true, 0, 0, false));
        assertFalse(preparation.begin("stereo_screen", true, 3840, 1080, false));
        assertFalse(preparation.begin("stereo_screen", true, 1920, 1080, true));
        assertTrue(preparation.begin("stereo_screen", true, 1920, 1080, false));
        assertTrue(preparation.isPending());
        assertFalse(preparation.wasWritten());
    }

    @Test
    public void duplicateDisplayEventsDoNotRepeatPreparationWhileWaitingOrAfterWrite()
    {
        StartupStereoPreparation preparation = started();
        assertFalse(preparation.begin("stereo_screen", true, 1920, 1080, false));
        preparation.complete(true);
        assertFalse(preparation.isPending());
        assertTrue(preparation.wasWritten());
        assertFalse(preparation.begin("stereo_screen", true, 1920, 1080, false));
    }

    @Test
    public void deniedOrFailedPreparationDoesNotAutomaticallyRetry()
    {
        StartupStereoPreparation preparation = started();
        preparation.complete(false);
        assertTrue(preparation.hasFailed());
        assertFalse(preparation.wasWritten());
        assertFalse(preparation.begin("stereo_screen", true, 1920, 1080, false));
    }

    @Test
    public void explicitModeSelectionDiscardsStartupResultAndLateCompletion()
    {
        StartupStereoPreparation preparation = started();
        preparation.clear();
        preparation.complete(true);
        assertFalse(preparation.isPending());
        assertFalse(preparation.wasWritten());
        assertFalse(preparation.hasFailed());
        assertFalse(preparation.begin("stereo_screen", true, 1920, 1080, false));
    }

    private static StartupStereoPreparation started()
    {
        StartupStereoPreparation preparation = new StartupStereoPreparation();
        assertTrue(preparation.begin("stereo_screen", true, 1920, 1080, false));
        return preparation;
    }
}
