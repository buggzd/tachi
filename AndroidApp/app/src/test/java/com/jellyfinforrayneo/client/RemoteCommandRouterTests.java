package com.jellyfinforrayneo.client;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class RemoteCommandRouterTests
{
    @Test
    public void submit_AllowsOnlyBoundedWhitelist()
    {
        RemoteCommandRouter router = new RemoteCommandRouter();

        assertTrue(router.submit("up"));
        assertTrue(router.submit("submit"));
        assertTrue(router.submit("search-submit"));
        assertFalse(router.submit("javascript:alert(1)"));
        assertFalse(router.submit("volume:999"));
        assertEquals(3, router.pendingCount());
    }

    @Test
    public void pendingQueue_DropsOldestAtCapacity()
    {
        RemoteCommandRouter router = new RemoteCommandRouter();
        List<String> delivered = new ArrayList<>();
        router.setSink(command ->
        {
            delivered.add(command);
            return true;
        });

        for (int index = 0; index < RemoteCommandRouter.MAX_PENDING_COMMANDS + 5; index++)
        {
            router.submit(index % 2 == 0 ? "left" : "right");
        }
        assertEquals(RemoteCommandRouter.MAX_PENDING_COMMANDS, router.pendingCount());

        router.setReady(true);

        assertEquals(RemoteCommandRouter.MAX_PENDING_COMMANDS, delivered.size());
        assertEquals(0, router.pendingCount());
        assertEquals("right", delivered.get(0));
    }

    @Test
    public void submit_MapsPhoneSubmitToDomEnter()
    {
        RemoteCommandRouter router = new RemoteCommandRouter();
        List<String> delivered = new ArrayList<>();
        router.setSink(command ->
        {
            delivered.add(command);
            return true;
        });
        router.setReady(true);

        router.submit("submit");

        assertEquals(List.of("enter"), delivered);
    }

    @Test
    public void submitSearchText_PreservesBoundedAsciiQuery()
    {
        RemoteCommandRouter router = new RemoteCommandRouter();
        List<String> delivered = new ArrayList<>();
        router.setSink(command ->
        {
            delivered.add(command);
            return true;
        });
        router.setReady(true);

        assertTrue(router.submitSearchText("QYN 12 "));
        assertTrue(router.submitSearchText(""));
        assertFalse(router.submitSearchText("庆余年"));
        assertFalse(router.submitSearchText(repeat('a', RemoteCommandRouter.MAX_SEARCH_QUERY_LENGTH + 1)));

        assertEquals(List.of("search-text:qyn 12 ", "search-text:"), delivered);
    }

    @Test
    public void circularSeek_IsBoundedAndNeverQueuedForLaterFocus()
    {
        RemoteCommandRouter router = new RemoteCommandRouter();
        List<String> delivered = new ArrayList<>();
        router.setSink(command -> delivered.add(command));
        assertFalse(router.submit("seek:15"));
        assertEquals(0, router.pendingCount());
        router.setReady(true);
        assertTrue(router.submit("seek:1"));
        assertTrue(router.submit("seek:-60"));
        for (String invalid : List.of("seek:0", "seek:61", "seek:-61", "seek:1.5", "seek:+1", "seek:01", "seek:1;up"))
        {
            assertFalse(router.submit(invalid));
        }
        router.setSink(command -> false);
        assertFalse(router.submit("seek:10"));
        assertEquals(0, router.pendingCount());
        assertEquals(List.of("seek:1", "seek:-60"), delivered);
    }

    private static String repeat(char value, int count)
    {
        StringBuilder result = new StringBuilder(count);
        for (int index = 0; index < count; index++)
        {
            result.append(value);
        }
        return result.toString();
    }
    @Test
    public void previewTransactionsAreBoundedAndNeverReplayedAfterReconnect()
    {
        RemoteCommandRouter router = new RemoteCommandRouter();
        java.util.ArrayList<String> delivered = new java.util.ArrayList<>();
        router.setSink(command -> { delivered.add(command); return true; });
        assertFalse(router.submit("scrub:start:abcd1234"));
        assertEquals(0, router.pendingCount());
        router.setReady(true);
        for (String command : List.of("scrub:start:abcd1234", "scrub:preview:abcd1234:0",
                "scrub:commit:abcd1234:999999", "scrub:cancel:abcd1234"))
        {
            assertTrue(router.submit(command));
        }
        for (String command : List.of("scrub:start:abcd1234:1", "scrub:commit:abcd1234",
                "scrub:preview:abcd1234:-1", "scrub:preview:abcd1234:01",
                "scrub:commit:abcd1234:1000000", "scrub:commit:abcd1234:1.5",
                "scrub:commit:abcd1234:1;up", "scrub:start:123"))
        {
            assertFalse(router.submit(command));
        }
        router.setReady(false);
        assertFalse(router.submit("scrub:commit:abcd1234:120"));
        router.setReady(true);
        assertEquals(4, delivered.size());
        assertEquals(0, router.pendingCount());
    }

}
