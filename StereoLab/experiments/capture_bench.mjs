import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
const out=process.argv[2];if(!out)throw Error('output path required');
const browser=await chromium.launch({channel:'chrome',headless:true});
const results=[];
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:4188/tests/capture-ablation.html');
 for(let clip=0;clip<3;clip++)for(const mode of (clip%2?['pbo','webgl_sync','cpu2d']:['cpu2d','webgl_sync','pbo'])){
  results.push(await page.evaluate(async ({mode,clip})=>await window.runCapture(mode,clip,8),{mode,clip}));
  await writeFile(out,JSON.stringify({browser:browser.version(),results},null,2)+'\n');console.log(clip,mode);
 }
}finally{await browser.close()}
