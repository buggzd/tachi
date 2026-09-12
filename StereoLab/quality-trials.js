import {depthIndex, shuffle, validScore} from './quality-trials-core.mjs';
const $=id=>document.getElementById(id), video=$('source'), canvas=$('screen');
const STORAGE='tachi-sbs-quality-v1';
const gl=canvas.getContext('webgl2',{antialias:false,depth:false,preserveDrawingBuffer:true});
let manifest, session, clip=0, label=0, maps={}, ready=false, lastFrame=0, loadGeneration=0;
let selectedDepth='', selectedIndex=-1, mode='eye', presented=0, skipped=0, watched=new Set(), viewedModes=new Set(), zoom=1, focus=[50,50];
const message=text=>{$('message').textContent=text};
const save=()=>{try{localStorage.setItem(STORAGE,JSON.stringify(session))}catch{message('无法保存到浏览器，请及时导出评分。')}};
const key=()=>`${clip}:${label}`;
const profile=()=>manifest.profiles.find(p=>p.id===session.order[clip][label]);
function newSession(){return {schema:1,id:crypto.randomUUID(),dataset:manifest.dataset,
    order:manifest.clips.map(()=>shuffle(manifest.profiles.map(p=>p.id))),ratings:{},unblindedClips:[],created:new Date().toISOString()}}
function loadSession(){
    try {const saved=JSON.parse(localStorage.getItem(STORAGE));
        if(saved?.schema===1 && saved.dataset===manifest.dataset && saved.order?.length===3
            && saved.order.every(order=>order.length===4 && [...order].sort().join()==='p0,p1,p2,p3')
            && Array.isArray(saved.unblindedClips) && saved.ratings && typeof saved.ratings==='object') return saved;
    } catch {}
    return newSession();
}
function compile(type,source){const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error('shader');return shader;}
let program, textures=[];
function setup(){
    if(!gl || !video.requestVideoFrameCallback)throw Error('browser');
    const vertex=`#version 300 es
    out vec2 uv;void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));uv=p;gl_Position=vec4(p*2.-1.,0,1);}`;
    // Native gather33's UV offsets, foreground priority and hole fallback; only the
    // external OES sampler becomes a browser texture, with an identity video transform.
    const fragment=`#version 300 es
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
    program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('link');gl.useProgram(program);
    for(let i=0;i<2;i++){textures[i]=gl.createTexture();gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,textures[i]);
        for(const k of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,k,gl.LINEAR);
        for(const k of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,k,gl.CLAMP_TO_EDGE);}
    gl.uniform1i(gl.getUniformLocation(program,'video'),0);gl.uniform1i(gl.getUniformLocation(program,'depthMap'),1);
    canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();ready=false;video.pause();message('图形上下文丢失，请刷新；评分已保留。')});
}
function draw(){
    if(!ready || video.readyState<2)return;
    const p=profile(), data=maps[p.id], index=depthIndex(lastFrame,p,data.count), bytes=p.width*p.height;
    const targetWidth=mode==='sbs'?3840:1920;
    if(canvas.width!==targetWidth){canvas.width=targetWidth;canvas.height=1080;}
    gl.useProgram(program);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,textures[1]);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    if(selectedDepth!==p.id){gl.texImage2D(gl.TEXTURE_2D,0,gl.R8,p.width,p.height,0,gl.RED,gl.UNSIGNED_BYTE,null);selectedDepth=p.id;selectedIndex=-1;}
    if(selectedIndex!==index){gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,p.width,p.height,gl.RED,gl.UNSIGNED_BYTE,data.bytes.subarray(index*bytes,(index+1)*bytes));selectedIndex=index;}
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,textures[0]);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,video);
    gl.uniform1i(gl.getUniformLocation(program,'depthOnly'),mode==='depth'?1:0);
    for(let eye=0;eye<(mode==='sbs'?2:1);eye++){gl.viewport(eye*1920,0,1920,1080);
        gl.uniform1f(gl.getUniformLocation(program,'eye'),mode==='source'?0:eye===0?1:-1);gl.drawArrays(gl.TRIANGLES,0,3);}
    $('time').textContent=`${(lastFrame/manifest.clips[clip].fps).toFixed(2)} / ${manifest.clips[clip].duration.toFixed(2)} s`;
    // Safe, non-identifying inspection state used by the browser regression test.
    canvas.dataset.frame=String(lastFrame);canvas.dataset.depthIndex=String(index);canvas.dataset.ready='true';
}
function frame(_now, metadata){
    if(ready){const c=manifest.clips[clip];
        if(metadata.mediaTime>=c.duration-0.5/c.fps){video.currentTime=0;}
        else {lastFrame=Math.min(manifest.frames-1,Math.max(0,Math.round(metadata.mediaTime*c.fps)));
            if(presented)skipped+=Math.max(0,metadata.presentedFrames-presented-1);presented=metadata.presentedFrames;
            if(!video.paused && mode!=='source'){watched.add(lastFrame);viewedModes.add(mode);}
            draw();$('health').textContent=skipped>2?'浏览器有跳帧；稳定性评分请留意':'';}}
    video.requestVideoFrameCallback(frame);
}
function selection(){
    $('variants').replaceChildren(...session.order[clip].map((_,i)=>{const b=document.createElement('button');b.textContent='ABCD'[i];b.setAttribute('aria-pressed',String(i===label));
        b.onclick=()=>{label=i;watched=new Set();viewedModes=new Set();selectedDepth='';selection();draw()};return b}));
    $('trial').textContent=`片段 ${clip+1} · ${'ABCD'[label]}`;
    const saved=session.ratings[key()];$('rating-form').reset();
    if(saved)for(const name of ['ghost','stability','detail','note'])$('rating-form').elements[name].value=saved[name];
    $('progress').textContent=`已评 ${Object.keys(session.ratings).length} / 12 组`;
    $('details').hidden=true;
}
async function loadClip(){
    const generation=++loadGeneration;ready=false;video.pause();watched=new Set();viewedModes=new Set();selectedDepth='';presented=0;skipped=0;
    $('clip').disabled=true;$('loading').hidden=false;$('play').disabled=true;$('replay').disabled=true;
    const c=manifest.clips[clip];const entries=await Promise.all(manifest.profiles.map(async p=>{
        const d=c.data[p.id],r=await fetch(d.url);if(!r.ok)throw Error('data');const buffer=await r.arrayBuffer();
        const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(v=>v.toString(16).padStart(2,'0')).join('');
        if(buffer.byteLength!==p.width*p.height*d.count || hash!==d.sha256)throw Error('data');
        return [p.id,{count:d.count,bytes:new Uint8Array(buffer)}];}));
    if(generation!==loadGeneration)return;
    maps=Object.fromEntries(entries);
    await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=reject;video.src=c.source;video.load()});
    if(generation!==loadGeneration)return;
    lastFrame=0;ready=true;$('clip').disabled=false;$('loading').hidden=true;$('play').disabled=false;$('replay').disabled=false;selection();draw();
}
function fail(){video.pause();ready=false;$('loading').hidden=false;$('loading').textContent='测试数据或浏览器加载失败。请确认本地样本已生成，并使用支持 WebGL 2 的浏览器。';}
$('clip').onchange=()=>{clip=Number($('clip').value);label=0;loadClip().catch(fail)};
$('view').onchange=()=>{mode=$('view').value;if(mode==='sbs'){$('zoom').value='1';zoom=1;canvas.style.transform='none'}$('zoom').disabled=mode==='sbs';draw()};
$('zoom').onchange=()=>{zoom=Number($('zoom').value);canvas.style.transform=`scale(${zoom})`;canvas.style.transformOrigin=`${focus[0]}% ${focus[1]}%`};
canvas.onclick=e=>{if(zoom!==2)return;const rect=$('viewer').getBoundingClientRect();focus=[Math.max(0,Math.min(100,(e.clientX-rect.left)/rect.width*100)),Math.max(0,Math.min(100,(e.clientY-rect.top)/rect.height*100))];canvas.style.transformOrigin=`${focus[0]}% ${focus[1]}%`};
$('play').onclick=()=>{if(video.paused)video.play().catch(()=>message('播放未启动，请再点击播放。'));else video.pause()};
$('replay').onclick=()=>{video.currentTime=0;video.play().catch(()=>message('请点击播放。'))};
$('fullscreen').onclick=()=>{$('viewer').requestFullscreen().catch(()=>message('当前浏览器未允许全屏。'))};
$('rating-form').onsubmit=e=>{e.preventDefault();
    const form=new FormData(e.target), scores=Object.fromEntries(['ghost','stability','detail'].map(k=>[k,Number(form.get(k))]));
    if(!ready || mode==='source' || watched.size<12){message('请先播放并观察这组至少 12 帧，原片参照不能代替处理画面评分。');return;}
    if(!Object.values(scores).every(validScore))return;
    session.ratings[key()]={...scores,note:String(form.get('note')).slice(0,300),clip,label:'ABCD'[label],profile:profile().id,
        view:mode,viewedModes:[...viewedModes],zoom,focus:[...focus],watchedFrames:watched.size,browserSkippedFrames:skipped,unblinded:session.unblindedClips.includes(clip),at:new Date().toISOString()};
    save();selection();message(`已保存片段 ${clip+1} · ${'ABCD'[label]}。可切换下一组，或直接导出。`)};
$('export').onclick=()=>{if(!manifest)return;
    const out={...session,profiles:manifest.profiles,limits:manifest.limits,sourceHashes:manifest.clips.map(c=>c.sourceSha256),exported:new Date().toISOString()};
    const url=URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='tachi-sbs-ratings.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message('已导出评分，请把 JSON 发给我分析。')};
$('reveal').onclick=()=>{if(!manifest)return;if(!session.ratings[key()]){message('请先给当前组评分，再查看方案。');return;}
    if(!session.unblindedClips.includes(clip))session.unblindedClips.push(clip);save();$('details').textContent=manifest.profiles.map(p=>`${'ABCD'[session.order[clip].indexOf(p.id)]} · ${p.label}`).join('\n');$('details').hidden=false;};
$('reset').onclick=()=>{if(!manifest || !confirm('开始新一轮会清空本机评分。请先导出已有评分。'))return;session=newSession();save();watched=new Set();label=0;selection();draw();message('新一轮顺序已随机化。')};
try {const r=await fetch('/samples/quality-v1/manifest.json');if(!r.ok)throw Error('manifest');const raw=await r.text();manifest=JSON.parse(raw);manifest.dataset=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(v=>v.toString(16).padStart(2,'0')).join('');session=loadSession();save();setup();await loadClip();video.requestVideoFrameCallback(frame);}catch{fail()}
