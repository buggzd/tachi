import {fullscreenVertex} from './mesh-shaders.mjs';
// Independent browser adaptation: RGB-guided one-sided depth, four horizontal
// coverage lanes, and bounded far-surface fill. No imported third-party code.
export const guidedDepth = `#version 300 es
precision highp float;
uniform sampler2D video, depthMap; uniform int alignEdges;
in vec2 uv; out vec4 color;
void main(){
 vec2 size=vec2(textureSize(depthMap,0));
 vec2 base=floor(vec2(uv.x,1.-uv.y)*size-.5);
 vec3 target=texture(video,uv).rgb; float best=1e9, selected=0.;
 for(int y=-2;y<=2;y++)for(int x=-2;x<=2;x++){
  vec2 q=(base+vec2(x,y)+.5)/size;
  vec3 rgb=texture(video,vec2(q.x,1.-q.y)).rgb;
  float cost=dot(rgb-target,rgb-target)*40.+dot(q-vec2(uv.x,1.-uv.y),q-vec2(uv.x,1.-uv.y))*100.;
  if(cost<best){best=cost;selected=texture(depthMap,q).r;}
 }
 float sum=0.,weight=0.;
 for(int y=-2;y<=2;y++)for(int x=-2;x<=2;x++){
  vec2 q=(base+vec2(x,y)+.5)/size; float d=texture(depthMap,q).r;
  vec3 diff=texture(video,vec2(q.x,1.-q.y)).rgb-target;
  vec2 delta=(q-vec2(uv.x,1.-uv.y))*size;
  float w=exp(-dot(diff,diff)*60.-dot(delta,delta)*.35)*step(abs(d-selected),.06);
  sum+=d*w;weight+=w;
 }
 float d=alignEdges==1?sum/max(weight,1e-8):texture(depthMap,vec2(uv.x,1.-uv.y)).r;
 color=vec4(d,0,0,1);
}`;
export const coverageSplat = `#version 300 es
precision highp float;
uniform sampler2D video, aligned; uniform float eye;uniform float strength; uniform int lanes;
in vec2 uv; layout(location=0) out vec4 color; layout(location=1) out vec4 geometry;
void main(){
 ivec2 size=textureSize(aligned,0); int center=int(gl_FragCoord.x);
 vec3 total=vec3(0); float count=0., farthest=1., nearest=0.;
 for(int lane=0;lane<4;lane++){
  if(lane>=lanes)break;
  float target=float(center)+(float(lane)+.5)/float(lanes); float best=-1.; vec3 rgb=vec3(0);
  for(int dx=-33;dx<=33;dx++){
   int sx=center+dx; if(sx<0||sx>=size.x)continue;
   ivec2 p=ivec2(sx,int(gl_FragCoord.y));float d=texelFetch(aligned,p,0).r;
   float projected=float(sx)+.5+eye*(d-.5)*.016*strength*float(size.x);
   if(target>=projected-.5&&target<projected+.5&&d>best){
    best=d;rgb=texture(video,(vec2(p)+.5)/vec2(size)).rgb;
   }
  }
  if(best>=0.){total+=rgb;count+=1.;farthest=min(farthest,best);nearest=max(nearest,best);}
 }
 color=vec4(total/float(lanes),count/float(lanes));geometry=vec4(farthest,nearest,0,count>0.?1.:0.);
}`;
export const backgroundFill = `#version 300 es
precision highp float;
uniform sampler2D rendered, geometryMap;uniform int fillHoles;
in vec2 uv;out vec4 color;
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy),size=textureSize(rendered,0);
 vec4 c=texelFetch(rendered,p,0); if(c.a>=.999){color=vec4(c.rgb,1);return;}
 if(fillHoles==0){color=vec4(c.rgb+(1.-c.a)*vec3(.6,0,.6),1);return;}
 float far=2.; int left=-1,right=-1;
 for(int i=1;i<=64;i++){
  if(left<0&&p.x-i>=0&&texelFetch(rendered,p-ivec2(i,0),0).a>.999)left=p.x-i;
  if(right<0&&p.x+i<size.x&&texelFetch(rendered,p+ivec2(i,0),0).a>.999)right=p.x+i;
 }
 if(left>=0)far=min(far,texelFetch(geometryMap,ivec2(left,p.y),0).g);
 if(right>=0)far=min(far,texelFetch(geometryMap,ivec2(right,p.y),0).g);
 vec3 sum=vec3(0);float weights=0.;
 for(int side=0;side<2;side++)for(int dx=2;dx<=6;dx++)for(int dy=-2;dy<=2;dy++){
  int anchor=side==0?left:right; if(anchor<0)continue;
  ivec2 q=ivec2(anchor+(side==0?-dx:dx),p.y+dy);
  if(any(lessThan(q,ivec2(0)))||any(greaterThanEqual(q,size)))continue;
  vec4 donor=texelFetch(rendered,q,0);vec4 depth=texelFetch(geometryMap,q,0);
  if(donor.a<.999||depth.g>far+.025)continue;
  float w=1./(1.+float(abs(q.x-p.x))+float(dy*dy)*2.);
  sum+=donor.rgb*w;weights+=w;
 }
 // No unrestricted original-frame fallback: unknown background remains visible.
 vec3 bg=weights>0.?sum/weights:vec3(.28,.02,.3);
 color=vec4(c.rgb+(1.-c.a)*bg,1);
}`;
export class EdgeSplat {
    constructor(gl, compile) {
        this.gl=gl;
        this.preview=compile(fullscreenVertex,`#version 300 es
precision highp float; uniform sampler2D aligned; in vec2 uv; out vec4 color;
void main(){color=vec4(vec3(texture(aligned,uv).r),1);}`);
        this.guide=compile(fullscreenVertex,guidedDepth);
        this.splat=compile(fullscreenVertex,coverageSplat);
        this.fill=compile(fullscreenVertex,backgroundFill);
        this.textures=[];
        for(let i=0;i<3;i++){
            gl.activeTexture(gl.TEXTURE2+i);
            const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
            gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,1920,1080,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
            gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
            this.textures.push(t);
        }
        this.depthFbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,this.depthFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.textures[0],0);
        this.check();
        this.splatFbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,this.splatFbo);
        for(let i=0;i<2;i++)gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0+i,gl.TEXTURE_2D,this.textures[i+1],0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0,gl.COLOR_ATTACHMENT1]);this.check();
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    }
    check(){const g=this.gl;if(g.checkFramebufferStatus(g.FRAMEBUFFER)!==g.FRAMEBUFFER_COMPLETE)throw Error('Edge splat framebuffer');}
    uniforms(p,values){const g=this.gl;g.useProgram(p);for(const [name,value] of Object.entries(values))g.uniform1i(g.getUniformLocation(p,name),value);}
    prepare(align){const g=this.gl;g.disable(g.DEPTH_TEST);g.bindFramebuffer(g.FRAMEBUFFER,this.depthFbo);g.viewport(0,0,1920,1080);
        this.uniforms(this.guide,{video:0,depthMap:1,alignEdges:align?1:0});g.drawArrays(g.TRIANGLES,0,3);g.bindFramebuffer(g.FRAMEBUFFER,null);}
    showDepth(){const g=this.gl;g.bindFramebuffer(g.FRAMEBUFFER,null);g.viewport(0,0,1920,1080);
        this.uniforms(this.preview,{aligned:2});g.drawArrays(g.TRIANGLES,0,3);}
    draw(eye,viewport,fill,lanes,strength=1){const g=this.gl;g.disable(g.DEPTH_TEST);g.bindFramebuffer(g.FRAMEBUFFER,this.splatFbo);g.viewport(0,0,1920,1080);
        this.uniforms(this.splat,{video:0,aligned:2,lanes});g.uniform1f(g.getUniformLocation(this.splat,'eye'),eye);g.uniform1f(g.getUniformLocation(this.splat,'strength'),strength);g.drawArrays(g.TRIANGLES,0,3);
        g.bindFramebuffer(g.FRAMEBUFFER,null);g.viewport(viewport,0,1920,1080);
        this.uniforms(this.fill,{rendered:3,geometryMap:4,fillHoles:fill?1:0});g.drawArrays(g.TRIANGLES,0,3);}
}
