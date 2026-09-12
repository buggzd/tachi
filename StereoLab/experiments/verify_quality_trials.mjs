import {chromium} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1280,height:1050},acceptDownloads:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:4190/quality-trials.html');
 await page.waitForSelector('#screen[data-ready="true"]',{timeout:30000});
 await page.locator('#play').click();
 await page.waitForFunction(()=>Number(document.querySelector('#screen').dataset.frame)>20);
 const state=await page.evaluate(()=>{
  const canvas=document.querySelector('#screen'),gl=canvas.getContext('webgl2'),pixels=new Uint8Array(4);
  gl.readPixels(960,540,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  return {error:gl.getError(),pixel:[...pixels],frame:Number(canvas.dataset.frame)};
 });
 if(state.error!==0 || state.pixel[3]!==255)throw Error('Renderer output invalid');
 await page.evaluate(()=>document.querySelector('#source').pause());
 await page.selectOption('#view','source');
 const orientationError=await page.evaluate(()=>{
  const source=document.querySelector('#source'),canvas=document.querySelector('#screen');
  const reference=document.createElement('canvas');reference.width=1920;reference.height=1080;
  const context=reference.getContext('2d');context.drawImage(source,0,0,1920,1080);
  const gl=canvas.getContext('webgl2');let error=0,count=0;
  for(let y=100;y<1000;y+=170)for(let x=100;x<1850;x+=260){
   const expected=context.getImageData(x,1079-y,1,1).data,actual=new Uint8Array(4);
   gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,actual);
   for(let c=0;c<3;c++){error+=Math.abs(expected[c]-actual[c]);count++;}
  }return error/count;
 });
 if(orientationError>12)throw Error('Source texture orientation/color mismatch');
 await page.selectOption('#view','eye');await page.locator('#play').click();
 for(const [name,value] of [['ghost','3'],['stability','4'],['detail','2']])await page.selectOption(`[name="${name}"]`,value);
 await page.locator('#rating-form button').click();
 await page.waitForFunction(()=>document.querySelector('#progress').textContent.includes('1 / 12'));
 await page.locator('#reveal').click();
 await page.locator('#variants button').nth(1).click();
 await page.waitForFunction(()=>Number(document.querySelector('#screen').dataset.frame)>12);
 // Playback must genuinely deliver frames under the new anonymous variant before scoring.
 await page.waitForTimeout(800);
 for(const name of ['ghost','stability','detail'])await page.selectOption(`[name="${name}"]`,'3');
 await page.locator('#rating-form button').click();
 await page.waitForFunction(()=>document.querySelector('#progress').textContent.includes('2 / 12'));
 const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();
 const download=await downloadPromise;const exported=JSON.parse(await readFile(await download.path(),'utf8'));
 if(Object.keys(exported.ratings).length!==2 || !exported.ratings['0:1'].unblinded)throw Error('Rating provenance lost');
 await page.selectOption('#view','depth');await page.waitForTimeout(120);
 await page.screenshot({path:process.argv[2]||'/tmp/tachi-quality-page.png'});
 await page.selectOption('#view','sbs');
 if(await page.locator('#screen').getAttribute('width')!=='3840')throw Error('SBS target dimensions');
 await page.selectOption('#clip','1');await page.waitForFunction(()=>!document.querySelector('#clip').disabled);
 await page.selectOption('#clip','2');await page.waitForFunction(()=>!document.querySelector('#clip').disabled);
 if(errors.length)throw Error('Browser errors: '+errors.join(','));
 console.log(JSON.stringify({render:state,sourceOrientationRgbError:orientationError,automatedTestRatings:2,clipsLoaded:3,unblindProvenance:true,download:true,browser:browser.version()}));
} finally {await browser.close();}
