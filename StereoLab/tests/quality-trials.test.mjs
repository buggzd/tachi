import test from 'node:test';
import assert from 'node:assert/strict';
import {depthIndex,shuffle,validScore} from '../quality-trials-core.mjs';
test('delayed half-rate depth never chooses a future observation after warmup',()=>{
    const p={stride:2,delay:2};
    for(let frame=2;frame<96;frame++)assert.ok(depthIndex(frame,p,48)*2<=frame-2);
    assert.equal(depthIndex(0,p,48),0);assert.equal(depthIndex(95,p,48),46);
});
test('aligned reference chooses current depth and clamps video overrun',()=>{
    assert.equal(depthIndex(45,{stride:1,delay:0},96),45);
    assert.equal(depthIndex(400,{stride:1,delay:0},96),95);
});
test('blind order is a permutation without mutating candidates',()=>{
    const source=['p0','p1','p2','p3'];const result=shuffle(source,()=>0);
    assert.notDeepEqual(result,source);assert.deepEqual([...result].sort(),source);
    assert.deepEqual(source,['p0','p1','p2','p3']);
});
test('ratings require deliberate integer scores',()=>{
    for(const score of [null,undefined,0,6,2.5,NaN,'3'])assert.equal(validScore(score),false);
    for(const score of [1,2,3,4,5])assert.equal(validScore(score),true);
});
