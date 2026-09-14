import test from 'node:test';
import assert from 'node:assert/strict';
import {makeElasticGrid} from '../elastic-grid.mjs';
test('elastic grid fixes borders and cannot fold under alternating maximum depth',()=>{
    const w=32,h=18,depth=Uint8Array.from({length:w*h},(_,i)=>i%2?255:0);
    for(const strength of [0,1,2])for(const columns of [97,193,385]) {
        const {targets,rows}=makeElasticGrid(depth,w,h,strength,columns,17);
        for(let y=0;y<rows;y++)for(let eye=0;eye<2;eye++) {
            assert.equal(targets[(y*columns)*2+eye],0);assert.equal(targets[(y*columns+columns-1)*2+eye],1);
            for(let x=1;x<columns;x++)assert.ok(targets[(y*columns+x)*2+eye]>targets[(y*columns+x-1)*2+eye]);
        }
    }
});
test('zero strength is identity and depth gradient produces distinct eyes',()=>{
    const w=32,h=18,depth=Uint8Array.from({length:w*h},(_,i)=>i%w<16?0:255);
    const zero=makeElasticGrid(depth,w,h,0,97,17),stereo=makeElasticGrid(depth,w,h,1,97,17);
    for(let y=0;y<17;y++)for(let x=0;x<97;x++)for(let eye=0;eye<2;eye++)assert.ok(Math.abs(zero.targets[(y*97+x)*2+eye]-x/96)<1e-7);
    assert.ok(stereo.targets.some((v,i)=>i%2===0&&Math.abs(v-stereo.targets[i+1])>.001));
});
