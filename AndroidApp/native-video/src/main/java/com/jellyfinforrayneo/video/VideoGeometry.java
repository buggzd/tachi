package com.jellyfinforrayneo.video;

final class VideoGeometry
{
    static int[] contain(int width, int height, float aspect)
    {
        if (width <= 0 || height <= 0 || !Float.isFinite(aspect) || aspect <= 0)
        {
            throw new IllegalArgumentException();
        }
        int w = Math.min(width, Math.max(1, Math.round(height * aspect)));
        int h = Math.min(height, Math.max(1, Math.round(w / aspect)));
        return new int[]{(width - w) / 2, (height - h) / 2, w, h};
    }
}
