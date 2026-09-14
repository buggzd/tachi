// Extend ONLY the far side of opening depth boundaries. No RGB history or blur.
// Output is bottom-to-top, matching the source video texture coordinates.
export function makeBackgroundLiquid(bytes, width, height, strength, feather=64, amount=1) {
    if(bytes.length!==width*height || !Number.isFinite(strength+feather+amount) || strength<0 || strength>2 || feather<1 || feather>256 || amount<0 || amount>1) throw Error('Invalid liquid inputs');
    const targets=new Float32Array(width*height*2);
    const radius=Math.ceil(feather*width/1920);
    const depth=Float32Array.from(bytes,v=>v/255);
    const smooth=(lo,hi,v)=>{const t=Math.max(0,Math.min(1,(v-lo)/(hi-lo)));return t*t*(3-2*t);};
    // Conductance is identical for both eyes and every solver iteration.
    const weights=new Float32Array(width*height*9),totals=new Float32Array(width*height);
    const offsets=[];for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)offsets.push(dy*width+dx);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const i=y*width+x;let slot=0,total=.35;
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++,slot++) {
            const nx=x+dx,ny=y+dy;if(nx<0||nx>=width||ny<0||ny>=height)continue;
            const w=(1-smooth(.015,.07,Math.abs(depth[i]-depth[ny*width+nx])))*(dx===0?2:1)*(dy===0?1:2);
            weights[i*9+slot]=w;total+=w;
        }
        totals[i]=total;
    }
    for(let e=0;e<2;e++) {
        const eye=e===0?1:-1;
        let field=new Float32Array(width*height),next=new Float32Array(field.length);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
            const i=y*width+x,d=depth[i];
            let correction=0;
            // Continuous confidence and strongest supported boundary: no first-hit switch.
            for(let k=1;k<=radius;k++) {
                const nx=x+eye*k;
                if(nx<0 || nx>=width)break;
                const gap=depth[y*width+nx]-d;
                const confidence=smooth(.025,.12,gap);
                const distance=Math.max(0,(k-1)*1920/width);
                const falloff=1-smooth(0,feather,distance);
                correction=Math.max(correction,Math.max(0,gap)*confidence*falloff);
            }
            field[i]=correction;
        }
        const seed=field.slice();
        // Screen-space 2D diffusion with depth conductance. It smooths displacement,
        // not RGB; a foreground/background discontinuity blocks propagation.
        for(let pass=0;pass<8;pass++) {
            for(let i=0;i<field.length;i++) {
                let sum=seed[i]*.35;
                for(let k=0;k<9;k++) {
                    const w=weights[i*9+k];if(w>0)sum+=field[i+offsets[k]]*w;
                }
                next[i]=Math.min(1-depth[i],sum/totals[i]);
            }
            [field,next]=[next,field];
        }
        for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
            const i=y*width+x;
            targets[((height-1-y)*width+x)*2+e]=eye*.016*strength*((bytes[i]/255-.5)+amount*field[i]);
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
  float d=depthAt(q),projected=q.x+shiftAt(q),error=abs(projected-uv.x);
  // Invert continuous projected source segments. Point-only acceptance leaves
  // gaps whenever a stretched source texel covers more than 1.5 target pixels.
  vec2 r=vec2(min(1.,q.x+1./1920.),q.y);
  float dr=depthAt(r),end=r.x+shiftAt(r),span=end-projected;
  if(span>1e-7 && abs(dr-d)<.06 && uv.x>=projected && uv.x<=end){
   float t=(uv.x-projected)/span;q=mix(q,r,t);d=mix(d,dr,t);error=0.;
  }
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
