package com.jellyfinforrayneo.client;

import java.util.ArrayDeque;
import java.util.Locale;

final class DiagnosticLog
{
    static final int MAX_EVENTS = 160;

    enum Event
    {
        APP_CREATED,
        APP_RESUMED,
        APP_PAUSED,
        APP_DESTROYED,
        SESSION_RESTORED,
        SESSION_EMPTY,
        AUTH_PASSWORD_STARTED,
        AUTH_QUICK_STARTED,
        AUTH_QUICK_CODE_RECEIVED,
        AUTH_SUCCEEDED_PERSISTED,
        AUTH_SUCCEEDED_EPHEMERAL,
        AUTH_FAILED,
        SESSION_CLEARED,
        SESSION_UNAUTHORIZED,
        DISCOVERY_STARTED,
        DISCOVERY_FOUND,
        DISCOVERY_EMPTY,
        DISCOVERY_FAILED,
        GLASSES_CONNECTED,
        GLASSES_DISCONNECTED,
        GLASSES_WEB_READY,
        GLASSES_WEB_NOT_READY,
        DISPLAY_SWITCH_2D,
        DISPLAY_SWITCH_3D,
        DISPLAY_MIRROR_APPLIED,
        DISPLAY_STEREO_APPLIED,
        DISPLAY_SAFE_FALLBACK,
        RUNTIME_BOOTING,
        RUNTIME_LOADING,
        RUNTIME_READY,
        RUNTIME_NO_SESSION,
        RUNTIME_ERROR_NETWORK,
        RUNTIME_ERROR_HTTP,
        RUNTIME_ERROR_RESPONSE,
        RUNTIME_ERROR_UNKNOWN,
        CATALOG_RETRY,
        DIAGNOSTICS_SHARED
    }

    private static final class Entry
    {
        final long elapsedMilliseconds;
        final Event event;

        Entry(long elapsedMilliseconds, Event event)
        {
            this.elapsedMilliseconds = elapsedMilliseconds;
            this.event = event;
        }
    }

    private final ArrayDeque<Entry> entries = new ArrayDeque<>();
    private final long startedAtNanos = System.nanoTime();

    synchronized void record(Event event)
    {
        if (event == null)
        {
            return;
        }
        while (entries.size() >= MAX_EVENTS)
        {
            entries.removeFirst();
        }
        long elapsed = elapsedMilliseconds();
        entries.addLast(new Entry(elapsed, event));
    }

    long elapsedMilliseconds()
    {
        return Math.max(0L, (System.nanoTime() - startedAtNanos) / 1_000_000L);
    }

    synchronized String exportEvents()
    {
        StringBuilder result = new StringBuilder();
        for (Entry entry : entries)
        {
            result.append(String.format(
                    Locale.US,
                    "+%08dms %s\n",
                    entry.elapsedMilliseconds,
                    entry.event.name()));
        }
        return result.toString();
    }
}
