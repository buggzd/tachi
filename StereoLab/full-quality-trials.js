const $=id=>document.getElementById(id),video=$('source'),canvas=$('screen'),ctx=canvas.getContext('2d');
let manifest,clip=0,frame=0,ready=false,generation=0;
function draw(){
    if(!ready||video.readyState<2)return;
    const info=manifest.clips[clip],sbs=$('view').value==='sbs';
    if(canvas.width!==(sbs?3840:1920))canvas.width=sbs?3840:1920;
    ctx.drawImage(video,$('view').value==='right'?1920:0,0,sbs?3840:1920,1080,0,0,canvas.width,1080);
    const stats=info.stats[frame],eye=stats?.[$('view').value==='right'?'r':'l'];
    $('seek').value=frame;canvas.dataset.ready='true';canvas.dataset.frame=frame;
    $('status').textContent=`帧 ${frame+1}/${info.frames} · 固定 1× · ${eye?`当前单眼缺失 ${eye.missing} 像素，未来补 ${eye.future}，过去补 ${eye.past}`:''}`;
}
function fail(error){ready=false;video.pause();$('status').textContent=`离线数据未就绪或加载失败：${error.message}`;}
async function load(reset=false){
    const token=++generation,playing=!video.paused;
    ready=false;canvas.dataset.ready='false';video.pause();for(const id of ['play','prev','next'])$(id).disabled=true;
    if(reset)frame=0;
    const info=manifest.clips[clip];$('seek').max=info.frames-1;
    $('status').textContent='加载同帧对照…';
    await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(Error('视频不可用'));video.src=info.videos[$('variant').value];video.load();});
    if(token!==generation)return;
    if(frame>0)await new Promise(resolve=>{video.onseeked=resolve;video.currentTime=(frame+.1)/info.fps;});
    if(token!==generation)return;
    ready=true;draw();for(const id of ['play','prev','next'])$(id).disabled=false;
    if(playing)await video.play();
}
video.requestVideoFrameCallback(function tick(_now,meta){
    if(ready&&!video.paused&&!video.seeking){const info=manifest.clips[clip];frame=Math.min(info.frames-1,Math.max(0,Math.round(meta.mediaTime*info.fps)));draw();}
    video.requestVideoFrameCallback(tick);
});
video.addEventListener('seeked',()=>{if(ready){frame=Math.min(manifest.clips[clip].frames-1,Math.max(0,Math.round(video.currentTime*manifest.clips[clip].fps)));draw();}});
video.onended=()=>{video.currentTime=0;video.play().catch(fail);};
$('clip').onchange=()=>{clip=Number($('clip').value);load(true).catch(fail);};
$('variant').onchange=()=>load().catch(fail);
$('view').onchange=()=>{if($('view').value==='sbs'){$('zoom').value='1';canvas.style.transform='';}$('zoom').disabled=$('view').value==='sbs';draw();};
function seek(index){if(!ready)return;video.pause();frame=Math.max(0,Math.min(manifest.clips[clip].frames-1,index));video.currentTime=(frame+.1)/manifest.clips[clip].fps;}
$('seek').oninput=()=>seek(Number($('seek').value));$('prev').onclick=()=>seek(frame-1);$('next').onclick=()=>seek(frame+1);
$('play').onclick=()=>{if(video.paused)video.play().catch(fail);else video.pause();};
$('zoom').onchange=()=>canvas.style.transform=`scale(${$('zoom').value})`;
canvas.onclick=e=>{const r=canvas.parentElement.getBoundingClientRect();canvas.style.transformOrigin=`${100*(e.clientX-r.left)/r.width}% ${100*(e.clientY-r.top)/r.height}%`;};
$('fullscreen').onclick=()=>$('viewer').requestFullscreen().catch(fail);
try{const r=await fetch('/samples/full-quality/manifest.json');if(!r.ok)throw Error('缺少完整 Quality 数据');manifest=await r.json();
$('clip').replaceChildren(...manifest.clips.map((_,i)=>new Option(`片段 ${i+1}`,i)));await load(true);}catch(error){fail(error);}
