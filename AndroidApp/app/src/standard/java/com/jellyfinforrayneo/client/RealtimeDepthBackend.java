package com.jellyfinforrayneo.client;

import android.content.Context;

final class RealtimeDepthBackend
{
    static boolean available()
    {
        return false;
    }
    static DepthBackend open(Context context) throws Exception
    {
        throw new IllegalStateException("unavailable");
    }
}
