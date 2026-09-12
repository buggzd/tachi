package com.jellyfinforrayneo.nativelab;

import android.content.Context;
import com.jellyfinforrayneo.video.NativeDepthProcessor;
import com.jellyfinforrayneo.video.QnnDepthProcessor;

final class LabDepthProcessor
{
    static NativeDepthProcessor create(Context context)
    {
        return QnnDepthProcessor.create(context, BuildConfig.MODEL_SHA256);
    }
}
