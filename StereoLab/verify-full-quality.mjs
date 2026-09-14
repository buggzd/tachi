import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
    const page=await browser.newPage({viewport:{width:1400,height:1100}});const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:4190/full-quality-trials.html');
    await page.waitForSelector('canvas[data-ready="true"]');
    const count=await page.locator('#clip option').count();if (!process.argv.includes('--partial')) assert.equal(count,3); else assert.ok(count>0);
    for(let clip=0;clip<count;clip++){
        if(clip){await page.selectOption('#clip',String(clip));await page.waitForSelector('canvas[data-ready="true"]');}
        await page.click('#play');await page.waitForFunction(()=>Number(document.querySelector('canvas').dataset.frame)>=10);await page.click('#play');
        await page.waitForTimeout(100);const frame=await page.locator('canvas').getAttribute('data-frame');
        const images=[];
        for(const variant of ['original','quality','temporal','provenance','holes']){
            await page.selectOption('#variant',variant);await page.waitForSelector('canvas[data-ready="true"]');
            assert.equal(await page.locator('canvas').getAttribute('data-frame'),frame);
            images.push(await page.evaluate(()=>document.querySelector('canvas').toDataURL()));
        }
        assert.notEqual(images[0],images[1]);assert.notEqual(images[1],images[4]);
        await page.selectOption('#view','sbs');assert.equal(await page.locator('canvas').getAttribute('width'),'3840');
        await page.selectOption('#view','right');await page.selectOption('#view','left');
        await page.click('#next');await page.waitForFunction(f=>Number(document.querySelector('canvas').dataset.frame)===Number(f)+1,frame);
    }
    await page.selectOption('#variant','temporal');await page.waitForSelector('canvas[data-ready="true"]');
    await page.screenshot({path:'.local/full-quality-preview.png',fullPage:true});
    assert.deepEqual(errors,[]);console.log(`PASS full Quality: ${count} clips, same-frame switching, playback, views, frame step`);
} finally {await browser.close();}
