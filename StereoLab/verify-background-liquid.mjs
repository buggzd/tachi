import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.argv[2]||'http://127.0.0.1:4190/mesh-trials.html');
 await page.waitForSelector('canvas[data-ready="true"]');
 const count=await page.locator('#clip option').count();assert.equal(count,4,'high motion dataset available');
 const set=async(id,v)=>page.locator(`#${id}`).evaluate((e,v)=>{e.value=v;e.dispatchEvent(new Event('input'));},String(v));
 for(let clip=0;clip<count;clip++){
  await page.selectOption('#clip',String(clip));await page.waitForSelector('canvas[data-ready="true"]');
  await page.selectOption('#strategy','liquid');
  await set('seek',clip===3?450:40);await page.waitForFunction(f=>Number(document.querySelector('canvas').dataset.frame)===f,clip===3?450:40);
  const image=()=>page.locator('canvas').evaluate(c=>c.toDataURL());
  await set('liquid-amount',0);const base=await image();await set('liquid-amount',1);console.log('clip',clip,'changed',(await image())!==base); if(clip===3)assert.ok((await image())!==base,'motion clip must respond to liquid strength');
  await set('liquid-feather',128);await page.check('#liquid-debug');await page.uncheck('#liquid-debug');
  await page.selectOption('#view','sbs');assert.equal(await page.locator('canvas').getAttribute('width'),'3840');
  await page.selectOption('#view','eye');
  assert.equal(await page.locator('canvas').evaluate(c=>c.getContext('webgl2').getError()),0);
 }
 await page.click('#play');await page.waitForFunction(()=>Number(document.querySelector('canvas').dataset.frame)>460);await page.click('#play');
 await page.locator('canvas').screenshot({path:'StereoLab/.local/background-liquid-preview.png'});
 await set('seek',898);await page.waitForFunction(()=>Number(document.querySelector('canvas').dataset.frame)===898);await page.click('#play');
 await page.waitForFunction(()=>Number(document.querySelector('canvas').dataset.frame)<30);await page.click('#play');
 await set('strength',0);await page.selectOption('#view','eye');const zero=await page.locator('canvas').evaluate(c=>c.toDataURL());
 await page.selectOption('#view','source');assert.ok(zero===await page.locator('canvas').evaluate(c=>c.toDataURL()),'zero strength reconstructs source');
 assert.deepEqual(errors,[]);console.log('4 clips: liquid controls, seeks, SBS, playback and GL checks passed');
}finally{await browser.close();}
