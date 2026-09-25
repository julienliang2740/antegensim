import { launch, shot, log, loadState, api, BASE } from './lib.mjs';
const st = loadState(); const runId = st.runId;
const VP = process.env.VP || '1440x900'; const P = process.env.PREFIX || '';
const ENT = process.env.ENT || 'a06';
const { browser, page } = await launch(VP);
log(`=== STEP 5b: inspector pane for ${ENT} (${VP})`);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(2500);
await page.getByPlaceholder(/e\.g\. a05/).fill(ENT);
await page.getByRole('button', { name: 'Select entity' }).click();
await page.waitForTimeout(2000);
const side = page.locator('.area-side');
const box = await side.boundingBox();
const sh = await side.evaluate(e => e.scrollHeight);
log('side pane box', box, 'scrollHeight', sh);
let i = 0;
for (let y = 0; y < sh && i < 8; y += Math.floor(box.height * 0.9), i++) {
  await side.evaluate((e, y) => { e.scrollTop = y; }, y);
  await page.waitForTimeout(250);
  await shot(page, `${P}24-inspector-${ENT}-part${i}`, { clip: { x: Math.max(0, box.x - 4), y: box.y, width: Math.min(box.width + 8, 1440), height: box.height } });
}
const txt = await page.locator('.insp-inspector').innerText();
log('inspector text length', txt.length);
console.log(txt.slice(0, 6000));
await browser.close();
