import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { transformWithEsbuild } from 'vite'
const { code } = await transformWithEsbuild(await readFile(new URL('../src/nativePlayback.ts', import.meta.url), 'utf8'), 'nativePlayback.ts', { target:'es2022' })
const isolated = code.replace(/import \{ subscribeRuntime \} from ["']\.\/runtime["'];?/, 'const subscribeRuntime = listener => { globalThis.runtimeListener = listener; listener({catalogGeneration:3,session:{}}); return () => {}; };')
const { NativePlayback } = await import(`data:text/javascript;base64,${Buffer.from(isolated).toString('base64')}`)
function setup(t) {
  const old = globalThis.window
  const commands=[]
  globalThis.window=Object.assign(new EventTarget(),{RayNeoGlasses:{nativePlaybackCommand:json=>commands.push(JSON.parse(json))}})
  const player=new NativePlayback(()=>({clientWidth:1920,clientHeight:1080}))
  t.after(()=>{player.dispose();globalThis.window=old;delete globalThis.runtimeListener})
  const plan={url:'https://media.example.invalid/Videos/item/stream.mkv',startPositionTicks:300000000,durationTicks:6000000000,width:1920,height:1080,audioTracks:[{index:1},{index:5}],audioStreamIndex:5}
  player.open(plan,false)
  const send=state=>{const event=new Event('tachi-native-playback');event.detail={token:commands.findLast(x=>x.operation==='open').token,generation:3,position:30,duration:600,status:'paused',firstFrame:true,seekable:true,...state};window.dispatchEvent(event)}
  return {player,commands,plan,send}
}
test('opens native media with resume position, selected audio ordinal and paused intent',t=>{
  const {player,commands,send}=setup(t)
  assert.equal(commands[0].position,30);assert.equal(commands[0].audioOrdinal,1);assert.equal(commands[0].playing,false)
  let loaded=0;player.addEventListener('loadeddata',()=>loaded++)
  send({});assert.equal(loaded,1);assert.equal(player.paused,true);assert.equal(player.currentTime,30)
  assert.equal(player.clientWidth,1920)
})
test('old source and account events cannot move the clock or resume a disposed player',t=>{
  const {player,commands,plan,send}=setup(t)
  const token=commands[0].token
  player.open({...plan,startPositionTicks:900000000},true)
  send({token,position:200,status:'playing'});assert.equal(player.currentTime,90)
  send({generation:2,position:200,status:'playing'});assert.equal(player.currentTime,90)
  globalThis.runtimeListener({catalogGeneration:4,session:{}})
  assert.equal(commands.at(-1).operation,'stop')
  send({position:300,status:'playing'});assert.equal(player.currentTime,90)
})
test('seek acknowledgement rejects stale clock samples and pause emits only from native state',t=>{
  const {player,commands,send}=setup(t)
  send({status:'playing'})
  let pauses=0;player.addEventListener('pause',()=>pauses++)
  player.currentTime=120
  const seekId=commands.at(-1).seekId
  send({position:30,seekId:seekId-1,status:'playing'});assert.equal(player.currentTime,120);assert.equal(player.seeking,true)
  send({position:120,seekId,status:'paused'});assert.equal(player.seeking,false);assert.equal(pauses,1)
  send({status:'playing',position:120,seekId});player.pause();assert.equal(commands.at(-1).operation,'pause')
  send({status:'paused',position:121,seekId});assert.equal(pauses,2)
})
