import fs from 'node:fs';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {makeBackgroundLiquid} from './background-liquid.mjs';
const native=fs.readFileSync('AndroidApp/native-video/src/main/assets/gpu-liquid/field.comp','utf8');
// Only execution plumbing changes: use fragment invocations instead of compute invocations.
const fragment=native.replace('#version 310 es','#version 300 es')
 .replace('layout(local_size_x=8,local_size_y=8) in;','out vec4 resultColor;')
 .replaceAll(/layout\(binding=\d\) /g,'')
 .replace('layout(rgba32f,binding=0) writeonly uniform highp image2D resultMap;','')
 .replace('ivec2(gl_GlobalInvocationID.xy)','ivec2(gl_FragCoord.xy)')
 // Fragment emulation loads a complete private tile; arithmetic and tile indices stay identical.
 // This checks halo addressing, not device workgroup synchronization or performance.
 .replaceAll('shared ', '')
 .replace('ivec2(gl_WorkGroupID.xy)', '(ivec2(gl_FragCoord.xy)/8)')
 .replace('int(gl_LocalInvocationIndex)', '0').replace('i+=64', 'i++')
 .replaceAll('gl_LocalInvocationID.y', '(int(gl_FragCoord.y)%8)')
 .replaceAll('gl_LocalInvocationID.x', '(int(gl_FragCoord.x)%8)')
 .replace('barrier();', '')
 .replace('imageStore(resultMap,p,vec4(value,0.,1.));','resultColor=vec4(value,0.,1.);');
const render=fs.readFileSync('AndroidApp/native-video/src/main/assets/gpu-liquid/render.frag','utf8');
const cases=[];
for(const type of ['constant','edge','missing-row','noise']){
 const w=131,h=67,b=new Uint8Array(w*h);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++)b[y*w+x]=type==='constant'?180:type==='noise'?(x*17+y*31)%256:(x>64&&!(type==='missing-row'&&y===32)?230:20);
 cases.push({name:type,w,h,bytes:[...b]});
}
const base='StereoLab/.local/samples/quality-motion/';
const raw=fs.readFileSync(base+'clip-0-p4.bin'),n=392*224;
cases.push({name:'motion579',w:392,h:224,bytes:[...raw.subarray(579*n,580*n)]});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto('about:blank');
 const results=[];
 for(const c of cases){
  const gpu=await page.evaluate(({c,fragment,render})=>{
   const canvas=document.createElement('canvas');canvas.width=c.w;canvas.height=c.h;
   const g=canvas.getContext('webgl2');if(!g.getExtension('EXT_color_buffer_float'))throw Error('float FBO unavailable');
   const vertex='#version 300 es\nout vec2 uv;void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));uv=p;gl_Position=vec4(p*2.-1.,0.,1.);}';
   const program=(frag)=>{const p=g.createProgram();for(const [t,s]of[[g.VERTEX_SHADER,vertex],[g.FRAGMENT_SHADER,frag]]){const sh=g.createShader(t);g.shaderSource(sh,s);g.compileShader(sh);if(!g.getShaderParameter(sh,g.COMPILE_STATUS))throw Error(g.getShaderInfoLog(sh));g.attachShader(p,sh);}g.linkProgram(p);if(!g.getProgramParameter(p,g.LINK_STATUS))throw Error(g.getProgramInfoLog(p));return p;};
   program(render);const p=program(fragment);g.useProgram(p);
   const texture=(format,data)=>{const t=g.createTexture();g.bindTexture(g.TEXTURE_2D,t);g.texImage2D(g.TEXTURE_2D,0,format,c.w,c.h,0,format===g.R8?g.RED:g.RGBA,format===g.R8?g.UNSIGNED_BYTE:g.FLOAT,data);for(const param of[g.TEXTURE_MIN_FILTER,g.TEXTURE_MAG_FILTER])g.texParameteri(g.TEXTURE_2D,param,g.NEAREST);return t;};
   g.pixelStorei(g.UNPACK_ALIGNMENT,1);
   const depth=texture(g.R8,new Uint8Array(c.bytes)),maps=[texture(g.RGBA32F,null),texture(g.RGBA32F,null),texture(g.RGBA32F,null)];
   const f=g.createFramebuffer();g.bindFramebuffer(g.FRAMEBUFFER,f);g.viewport(0,0,c.w,c.h);
   for(let phase=0;phase<=8;phase++){
    for(const [i,t]of[depth,phase===0?depth:maps[0],phase===0?depth:phase===1?maps[0]:maps[1+(phase-2)%2]].entries()){
     g.activeTexture(g.TEXTURE0+i);g.bindTexture(g.TEXTURE_2D,t);g.uniform1i(g.getUniformLocation(p,['depthMap','seedMap','previousMap'][i]),i);
    }
    g.framebufferTexture2D(g.FRAMEBUFFER,g.COLOR_ATTACHMENT0,g.TEXTURE_2D,phase===0?maps[0]:maps[1+(phase-1)%2],0);
    if(g.checkFramebufferStatus(g.FRAMEBUFFER)!==g.FRAMEBUFFER_COMPLETE)throw Error('FBO');
    g.uniform1i(g.getUniformLocation(p,'phase'),phase);g.drawArrays(g.TRIANGLES,0,3);
   }
   const out=new Float32Array(c.w*c.h*4);g.readPixels(0,0,c.w,c.h,g.RGBA,g.FLOAT,out);if(g.getError())throw Error('GL error');return [...out];
  },{c,fragment,render});
  const cpu=makeBackgroundLiquid(new Uint8Array(c.bytes),c.w,c.h,.85,96,.65);let max=0,sum=0;
  for(let y=0;y<c.h;y++)for(let x=0;x<c.w;x++)for(let e=0;e<2;e++){
   const error=Math.abs(cpu[((c.h-1-y)*c.w+x)*2+e]-gpu[(y*c.w+x)*4+e])*1920;max=Math.max(max,error);sum+=error;
  }
  assert.ok(max<.002,`${c.name}: ${max} px`);results.push({case:c.name,maxDisplacementErrorPx:max,meanDisplacementErrorPx:sum/(c.w*c.h*2)});
 }
 console.log(JSON.stringify({scope:'Desktop WebGL float passes of native shader arithmetic; not GLES compute driver or phone performance',results},null,2));
}finally{await browser.close();}
