#version 300 es
precision highp float;
uniform sampler2D video,depthMap,liquidMap;
uniform float eye;const float strength=.85;uniform int depthOnly;uniform int debugLiquid;
in vec2 uv;out vec4 color;
float depthAt(vec2 p){return texture(depthMap,vec2(p.x,1.-p.y)).r;}
// Cache the two rows touched by horizontal inversion. Overflow uses exact fetches.
// Coordinates and bilinear arithmetic remain identical to the reference shader.
vec2 row0[12],row1[12];ivec2 cacheBase;int cacheCount;
void prepareShiftRows(){
 ivec2 size=textureSize(liquidMap,0),limit=size-1;
 cacheBase=ivec2(floor(vec2(uv.x-16./1920.,1.-uv.y)*vec2(size)-.5));
 int end=int(floor((uv.x+17./1920.)*float(size.x)-.5))+1;
 cacheCount=clamp(end-cacheBase.x+1,0,12);
 for(int i=0;i<12;i++){
  if(i>=cacheCount)break;
  row0[i]=texelFetch(liquidMap,clamp(cacheBase+ivec2(i,0),ivec2(0),limit),0).rg;
  row1[i]=texelFetch(liquidMap,clamp(cacheBase+ivec2(i,1),ivec2(0),limit),0).rg;
 }
}
vec2 shiftTexel(ivec2 p){
 ivec2 q=p-cacheBase;
 if(q.x>=0&&q.x<cacheCount){
  if(q.y==0)return row0[q.x];if(q.y==1)return row1[q.x];
 }
 return texelFetch(liquidMap,clamp(p,ivec2(0),textureSize(liquidMap,0)-1),0).rg;
}
float shiftAt(vec2 p){
 vec2 v=vec2(p.x,1.-p.y)*vec2(textureSize(liquidMap,0))-.5;
 ivec2 a=ivec2(floor(v)),limit=textureSize(liquidMap,0)-1;vec2 t=fract(v);
 vec2 s=mix(mix(shiftTexel(a),
 shiftTexel(a+ivec2(1,0)),t.x),
 mix(shiftTexel(a+ivec2(0,1)),
 shiftTexel(a+ivec2(1,1)),t.x),t.y);return eye>0.?s.r:s.g;}
void main(){
 if(depthOnly==1){color=vec4(vec3(depthAt(uv)),1.);return;}
 if(eye==0.){color=texture(video,uv);return;}
 prepareShiftRows();
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
}
