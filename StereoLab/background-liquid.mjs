// Extend ONLY the far side of opening depth boundaries. No RGB history or blur.
// Output is bottom-to-top, matching the source video texture coordinates.
export function makeBackgroundLiquid(bytes, width, height, strength, feather=64, amount=1) {
    if(bytes.length!==width*height || !Number.isFinite(strength+feather+amount) || strength<0 || strength>2 || feather<1 || feather>256 || amount<0 || amount>1) throw Error('Invalid liquid inputs');
    const targets=new Float32Array(width*height*2);
    const radius=Math.ceil(feather*width/1920);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const d=bytes[y*width+x]/255;
        for(let e=0;e<2;e++) {
            const eye=e===0?1:-1;
            let correction=0;
            // For the left eye, an opening has background on the left;
            // the right eye reverses this. Do not deform the foreground.
            for(let k=1;k<=radius;k++) {
                const nx=x+eye*k;
                if(nx<0 || nx>=width)break;
                const near=bytes[y*width+nx]/255;
                if(near-d<.08)continue;
                const distance=Math.max(0,(k-1)*1920/width);
                const t=Math.min(1,distance/feather);
                const falloff=1-t*t*(3-2*t);
                correction=Math.max(correction,(near-d)*falloff);
                break;
            }
            targets[((height-1-y)*width+x)*2+e]=eye*.016*strength*((d-.5)+amount*correction);
        }
    }
    return targets;
}
export const liquidFragment=`#version 300 es
precision highp float;
uniform sampler2D video,depthMap,liquidMap;
uniform float eye,strength;uniform int debugLiquid;
in vec2 uv;out vec4 color;
float depthAt(vec2 p){return texture(depthMap,vec2(p.x,1.-p.y)).r;}
float shiftAt(vec2 p){vec2 s=texture(liquidMap,p).rg;return eye>0.?s.r:s.g;}
void main(){
 vec2 source=uv;float best=-1.,bestError=1e6;bool found=false;
 for(int i=-33;i<=33;i++){
  if(abs(float(i))>ceil(16.*strength)+1.)continue;
  vec2 q=uv+vec2(float(i)/1920.,0.);if(q.x<0.||q.x>1.)continue;
  float d=depthAt(q),error=abs(q.x+shiftAt(q)-uv.x);
  if(error<.75/1920.){if(!found||d>best){source=q;best=d;found=true;}}
  else if(!found&&error<bestError){source=q;bestError=error;}
 }
 // Unresolved coverage keeps the original gather fallback, not a blur.
 if(!found){bestError=1e6;for(int i=-32;i<=32;i++){
  if(abs(float(i))>ceil(16.*strength))continue;
  vec2 q=uv+vec2(float(i)/1920.,0.);if(q.x<0.||q.x>1.)continue;
  float error=abs(q.x+eye*(depthAt(q)-.5)*.016*strength-uv.x);
  if(error<bestError){source=q;bestError=error;}
 }}
 color=texture(video,source);
 if(debugLiquid==1){float extra=abs(shiftAt(source)-eye*(depthAt(source)-.5)*.016*strength)*1920.;
 color.rgb=mix(color.rgb,found?vec3(0.,1.,.5):vec3(1.,0.,1.),found?clamp(extra/8.,0.,.75):.7);}
}`;
