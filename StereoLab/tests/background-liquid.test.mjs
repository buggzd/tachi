import test from 'node:test';
import assert from 'node:assert/strict';
import {makeBackgroundLiquid} from '../background-liquid.mjs';
test('zero stereo strength is identity',()=>{
 const f=makeBackgroundLiquid(new Uint8Array([0,0,255,255]),4,1,0);
 assert.ok(f.every(x=>x===0));
});
test('opening stretches far background while foreground keeps disparity',()=>{
 const w=1920,b=new Uint8Array(w);b.fill(255,960);
 const f=makeBackgroundLiquid(b,w,1,1,64,1);
 assert.ok(f[959*2]>.0079);
 assert.equal(f[960*2],Math.fround(.008));
 assert.equal(f[800*2],Math.fround(-.008));
 assert.equal(f[959*2+1],Math.fround(.008));
 assert.ok(f[930*2]>f[910*2]);
});
test('opposite eye stretches opposite-facing background',()=>{
 const b=new Uint8Array(1920);b.fill(255,0,960);
 const f=makeBackgroundLiquid(b,1920,1,1,64,1);
 assert.ok(f[960*2+1]<-.0079);
 assert.equal(f[959*2+1],Math.fround(-.008));
});
test('zero amount preserves original displacement and finite bounds',()=>{
 const b=Uint8Array.from({length:100},(_,i)=>i*17%256);
 const f=makeBackgroundLiquid(b,100,1,2,256,0);
 b.forEach((d,i)=>assert.equal(f[i*2],Math.fround(.032*(d/255-.5))));
 assert.ok(f.every(x=>Number.isFinite(x)&&Math.abs(x)<=.016001));
});
test('a missing edge row receives background displacement without moving foreground',()=>{
 const w=128,h=17,b=new Uint8Array(w*h);
 for(let y=0;y<h;y++)if(y!==8)b.fill(255,y*w+64,(y+1)*w);
 const f=makeBackgroundLiquid(b,w,h,1,128,1);
 const at=(x,y)=>f[((h-1-y)*w+x)*2];
 assert.ok(at(63,8)>-.004,'fill isolated missing-row displacement from neighbors');
 assert.ok(Math.abs(at(63,8)-at(63,7))<.006,'neighbor rows remain connected');
 assert.equal(at(64,7),Math.fround(.008),'foreground must remain unmodified');
});
test('small depth changes near the old threshold do not toggle the displacement',()=>{
 const w=128;
 const make=v=>{const b=new Uint8Array(w);b.fill(v,64);return makeBackgroundLiquid(b,w,1,1,128,1)[63*2];};
 assert.ok(Math.abs(make(21)-make(20))*1920<.3);
});
