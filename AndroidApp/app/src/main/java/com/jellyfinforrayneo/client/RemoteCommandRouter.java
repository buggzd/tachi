package com.jellyfinforrayneo.client;

import java.util.ArrayDeque;
import java.util.Locale;

final class RemoteCommandRouter
{
    static final int MAX_PENDING_COMMANDS = 32;
    static final int MAX_SEARCH_QUERY_LENGTH = 48;

    interface CommandSink
    {
        boolean dispatch(String command);
    }

    private final ArrayDeque<String> pending = new ArrayDeque<>();
    private CommandSink sink;
    private boolean ready;

    synchronized void setSink(CommandSink sink)
    {
        this.sink = sink;
        flush();
    }

    synchronized void setReady(boolean ready)
    {
        this.ready = ready;
        if (ready)
        {
            flush();
        }
    }

    synchronized boolean submit(String value)
    {
        String normalized = normalize(value);
        if (normalized == null)
        {
            return false;
        }
        if (normalized.startsWith("seek:") || normalized.startsWith("scrub:"))
        {
            // A seek transaction belongs to the current focus, never replay after reconnect.
            return ready && sink != null && sink.dispatch(normalized);
        }
        return submitNormalized(normalized);
    }

    synchronized boolean submitSearchText(String value)
    {
        String normalized = normalizeSearchText(value);
        if (normalized == null)
        {
            return false;
        }
        return submitNormalized("search-text:" + normalized);
    }

    synchronized boolean submitVolume(int percentage)
    {
        int bounded = Math.max(0, Math.min(100, percentage));
        String command = "volume:" + bounded;
        if (ready && sink != null && sink.dispatch(command))
        {
            return true;
        }
        enqueue(command);
        return true;
    }

    synchronized int pendingCount()
    {
        return pending.size();
    }

    synchronized void clear()
    {
        pending.clear();
    }

    private void enqueue(String command)
    {
        while (pending.size() >= MAX_PENDING_COMMANDS)
        {
            pending.removeFirst();
        }
        pending.addLast(command);
    }

    private boolean submitNormalized(String command)
    {
        if (ready && sink != null && sink.dispatch(command))
        {
            return true;
        }
        enqueue(command);
        return true;
    }

    private void flush()
    {
        if (!ready || sink == null)
        {
            return;
        }
        while (!pending.isEmpty())
        {
            String command = pending.peekFirst();
            if (!sink.dispatch(command))
            {
                return;
            }
            pending.removeFirst();
        }
    }

    private static String normalize(String value)
    {
        if (value != null && value.length() > 32)
        {
            return null;
        }
        String command = value == null ? "" : value.trim().toLowerCase(Locale.US);
        if (command.matches("seek:-?(?:[1-9]|[1-5][0-9]|60)")
                || command.matches("scrub:(?:start|cancel):[a-f0-9]{8}")
                || command.matches("scrub:(?:preview|commit):[a-f0-9]{8}:(?:0|[1-9][0-9]{0,5})"))
        {
            return command;
        }
        switch (command)
        {
            case "up":
            case "down":
            case "left":
            case "right":
            case "back":
            case "search-submit":
            case "search-keyboard-visible":
            case "search-keyboard-hidden":
                return command;
            case "submit":
            case "enter":
                return "enter";
            default:
                return null;
        }
    }

    private static String normalizeSearchText(String value)
    {
        if (value == null || value.length() > MAX_SEARCH_QUERY_LENGTH)
        {
            return null;
        }
        String normalized = value.toLowerCase(Locale.US);
        for (int index = 0; index < normalized.length(); index++)
        {
            char character = normalized.charAt(index);
            boolean allowed = character >= 'a' && character <= 'z'
                    || character >= '0' && character <= '9'
                    || character == ' ';
            if (!allowed)
            {
                return null;
            }
        }
        return normalized;
    }
}
