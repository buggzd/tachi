package com.jellyfinforrayneo.client;

/** One startup attempt before HyperOS enables an observed 2D external display. */
final class StartupStereoPreparation
{
    private boolean consumed;
    private boolean pending;
    private boolean written;
    private boolean failed;

    boolean begin(String mode, boolean disabled, int width, int height, boolean connected)
    {
        if (consumed || connected || !disabled || width != 1920 || height != 1080
                || !DisplayModeStateMachine.STEREO_SCREEN.equals(mode))
        {
            return false;
        }
        consumed = true;
        pending = true;
        return true;
    }

    void complete(boolean success)
    {
        if (pending)
        {
            pending = false;
            written = success;
            failed = !success;
        }
    }

    void clear()
    {
        consumed = true;
        pending = false;
        written = false;
        failed = false;
    }

    boolean isPending()
    {
        return pending;
    }

    boolean wasWritten()
    {
        return written;
    }

    boolean hasFailed()
    {
        return failed;
    }
}
