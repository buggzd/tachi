package com.jellyfinforrayneo.client;

import android.graphics.Bitmap;
import android.graphics.BitmapShader;
import android.graphics.RenderEffect;
import android.graphics.RenderNode;
import android.graphics.RuntimeShader;
import android.graphics.Shader;
import androidx.annotation.RequiresApi;

/** Per-eye gather reprojection of the SAME completed WebView layer; never another decoder. */
@RequiresApi(33)
final class RealtimeEyeEffect
{
    private static final String PROGRAM =
            "uniform shader content; uniform shader depthMap;"
            + "uniform float4 videoRect; uniform float4 masks[8];"
            + "uniform float direction; uniform float amplitude;"
            + "bool inside(float2 p, float4 r) { return p.x>=r.x && p.y>=r.y && p.x<r.z && p.y<r.w; }"
            + "bool protectedPixel(float2 p) { for(int i=0;i<8;i++) {"
            + "float4 r=masks[i]; if(r.z>r.x && inside(p,r+float4(-17,-1,17,1))) return true; } return false; }"
            + "half4 main(float2 p) {"
            + "if(!inside(p,videoRect) || protectedPixel(p)) return content.eval(p);"
            + "float best=-1; float bestError=1e6; float source=p.x; bool found=false;"
            + "for(int i=-16;i<=16;i++) { float2 q=p+float2(float(i),0);"
            + "if(inside(q,videoRect) && !protectedPixel(q)) {"
            + "float2 uv=(q-videoRect.xy)/(videoRect.zw-videoRect.xy);"
            + "float d=float(depthMap.eval(uv*float2(266,154)).r);"
            + "float error=abs(q.x+direction*(d-0.5)*amplitude-p.x);"
            + "if(error<0.75) { if(!found || d>best) { source=q.x; best=d; found=true; } }"
            + "else if(!found && error<bestError) { source=q.x; bestError=error; } } }"
            + "return content.eval(float2(source,p.y)); }";

    final RenderNode left = new RenderNode("tachi-left-eye");
    final RenderNode right = new RenderNode("tachi-right-eye");
    private final RuntimeShader leftShader = new RuntimeShader(PROGRAM);
    private final RuntimeShader rightShader = new RuntimeShader(PROGRAM);

    void update(Bitmap map, DepthFrame frame, int width, int height)
    {
        BitmapShader depth = new BitmapShader(map, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
        depth.setFilterMode(BitmapShader.FILTER_MODE_LINEAR);
        updateEye(left, leftShader, depth, frame, width, height, 1);
        updateEye(right, rightShader, depth, frame, width, height, -1);
    }

    private void updateEye(RenderNode node, RuntimeShader shader, BitmapShader depth,
            DepthFrame frame, int width, int height, float sign)
    {
        shader.setInputBuffer("depthMap", depth);
        shader.setFloatUniform("videoRect", pixels(frame.rect, width, height));
        float[] masks = new float[32];
        for (int i = 0; i < frame.masks.length; i++)
        {
            System.arraycopy(pixels(frame.masks[i], width, height), 0, masks, i * 4, 4);
        }
        shader.setFloatUniform("masks", masks);
        shader.setFloatUniform("direction", sign);
        shader.setFloatUniform("amplitude", Math.min(30f, width * .016f));
        node.setPosition(0, 0, width, height);
        node.setRenderEffect(RenderEffect.createRuntimeShaderEffect(shader, "content"));
    }

    private static float[] pixels(float[] rect, int width, int height)
    {
        return new float[]{rect[0] * width, rect[1] * height, rect[2] * width, rect[3] * height};
    }

    void clear()
    {
        left.discardDisplayList();
        right.discardDisplayList();
        left.setRenderEffect(null);
        right.setRenderEffect(null);
    }
}
