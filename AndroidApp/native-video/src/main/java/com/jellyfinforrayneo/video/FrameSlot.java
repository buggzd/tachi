package com.jellyfinforrayneo.video;

/** Bounded capture leases. Invalidating never reuses a worker's memory early. */
final class FrameSlot
{
    private long generation;
    private long serial;
    private final long[] active;
    private final long[] visits;

    FrameSlot()
    {
        this(1);
    }

    FrameSlot(int capacity)
    {
        if (capacity < 1 || capacity > 2) throw new IllegalArgumentException("capture capacity");
        active = new long[capacity];
        visits = new long[capacity];
    }

    synchronized int indexOf(long lease)
    {
        if (lease != 0)
            for (int i = 0; i < active.length; i++)
                if (active[i] == lease) return i;
        return -1;
    }

    synchronized long acquire()
    {
        for (int i = 0; i < active.length; i++)
        {
            if (active[i] != 0) continue;
            active[i] = ++serial;
            visits[i] = generation;
            return active[i];
        }
        return 0;
    }

    synchronized long generationOf(long lease)
    {
        int i = indexOf(lease);
        return i < 0 ? -1 : visits[i];
    }

    synchronized long generation()
    {
        return generation;
    }

    synchronized boolean current(long lease, long expectedGeneration)
    {
        int i = indexOf(lease);
        return i >= 0 && visits[i] == expectedGeneration && generation == expectedGeneration;
    }

    synchronized void release(long lease)
    {
        int i = indexOf(lease);
        if (i >= 0) active[i] = 0;
    }

    synchronized void invalidate()
    {
        generation++;
    }
}
