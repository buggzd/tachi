export const fullscreenVertex = `#version 300 es
    out vec2 uv;void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));uv=p;gl_Position=vec4(p*2.-1.,0,1);}`;
export const pixelFragment = `#version 300 es
    precision highp float;uniform sampler2D video;uniform sampler2D depthMap;
    uniform float eye;uniform int depthOnly;in vec2 uv;out vec4 color;
    float depthAt(vec2 p){return texture(depthMap,vec2(p.x,1.-p.y)).r;}
    void main(){if(depthOnly==1){color=vec4(vec3(depthAt(uv)),1);return;}
    vec2 source=uv;if(eye!=0.){float best=-1.;float bestError=1e6;bool found=false;
    for(int i=-16;i<=16;i++){vec2 q=uv+vec2(float(i)/1920.,0);
    if(q.x>=0.&&q.x<=1.){float d=depthAt(q);float error=abs(q.x+eye*(d-.5)*.016-uv.x);
    if(error<.75/1920.){if(!found||d>best){source=q;best=d;found=true;}}
    else if(!found&&error<bestError){source=q;bestError=error;}}}}
    color=texture(video,source);}`;
// Inverse depth rho = 0.5 + d, Z = 1/rho. Parallel camera translation
// plus convergence at rho=1 gives du = eye * 0.016 * (d - 0.5).
// Projective source coordinates avoid affine texture swimming on triangles.
export const meshVertex = `#version 300 es
precision highp float;
uniform sampler2D depthMap;
uniform ivec2 grid;
uniform float eye;
uniform float threshold;
out vec3 projected;
flat out float rejected;
float depthAt(vec2 p){return texture(depthMap,vec2(p.x,1.-p.y)).r;}
void main(){
 int cell=gl_VertexID/6; int corner=gl_VertexID%6;
 ivec2 base=ivec2(cell%(grid.x-1),cell/(grid.x-1));
 ivec2 offsets[6]=ivec2[6](ivec2(0,0),ivec2(1,0),ivec2(0,1),ivec2(1,0),ivec2(1,1),ivec2(0,1));
 int first=(corner/3)*3;
 float lo=1.; float hi=0.;
 for(int i=0;i<3;i++){
  float d=depthAt(vec2(base+offsets[first+i])/vec2(grid-1));
  lo=min(lo,d);hi=max(hi,d);
 }
 rejected=hi-lo>threshold?1.:0.;
 vec2 uv=vec2(base+offsets[corner])/vec2(grid-1);
 float d=depthAt(uv); float z=1./(.5+d);
 vec2 xy=(uv*2.-1.)*z;
 xy.x+=2.*eye*.016*(1.-z);
 // Near/far planes 0.5/3, positive camera-space Z.
 gl_Position=vec4(xy,1.4*z-1.2,z);
 projected=vec3(uv*z,z);
}`;
export const meshFragment = `#version 300 es
precision highp float;
uniform sampler2D video;
in vec3 projected;
flat in float rejected;
out vec4 color;
void main(){if(rejected>.5)discard;color=texture(video,projected.xy/projected.z);}`;
