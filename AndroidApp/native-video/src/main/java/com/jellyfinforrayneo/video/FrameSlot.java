package com.jellyfinforrayneo.video;

/** One generation-scoped lease, never a FIFO of stale video frames. */
final class FrameSlot
{
    private long generation;
    private long serial;
    private long active;
    private long activeGeneration;

    synchronized long acquire()
    {
        if (active != 0) return 0;
        active = ++serial;
        activeGeneration = generation;
        return active;
    }

    synchronized long generationOf(long lease)
    {
        return lease != 0 && lease == active ? activeGeneration : -1;
    }

    synchronized long generation()
    {
        return generation;
    }

    synchronized boolean current(long lease, long expectedGeneration)
    {
        return lease != 0 && lease == active && activeGeneration == expectedGeneration
                && generation == expectedGeneration;
    }

    synchronized void release(long lease)
    {
        if (active == lease) active = 0;
    }

    synchronized void invalidate()
    {
        // Keep an in-flight consumer's lease until it finishes; memory cannot be reused early.
        generation++;
    }
}
