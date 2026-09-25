import { launch, loadState, BASE } from './lib.mjs';
const st = loadState(); const { browser, page } = await launch(process.env.VP||'1440x900');
await page.goto(`${BASE}/#/run/${st.runId}`); await page.waitForTimeout(2500);
await page.locator('rect[data-coord="0,2"]').click(); await page.waitForTimeout(800);
await page.locator('.insp-occupant-row').first().click(); await page.waitForTimeout(1500);
const info = await page.evaluate(() => {
  const out = []; let e = document.querySelector('.insp-inspector');
  while (e) { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); out.push(`${e.tagName}.${(e.className||'').toString().slice(0,40)} h=${Math.round(r.height)} w=${Math.round(r.width)} top=${Math.round(r.top)} ovY=${cs.overflowY} ovX=${cs.overflowX} sh=${e.scrollHeight} ch=${e.clientHeight} pos=${cs.position}`); e = e.parentElement; }
  return { chain: out, docH: document.documentElement.scrollHeight, winH: innerHeight };
});
console.log(JSON.stringify(info, null, 1));
// overflowing descendants of inspector (content wider than box)
const wide = await page.evaluate(() => [...document.querySelectorAll('.insp-inspector *')].filter(e => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX !== 'visible').slice(0,10).map(e => `${e.tagName}.${e.className} sw=${e.scrollWidth} cw=${e.clientWidth} ovX=${getComputedStyle(e).overflowX}`));
console.log(wide);
const inspR = await page.locator('.insp-inspector').boundingBox();
const clipped = await page.evaluate((ir) => [...document.querySelectorAll('.insp-inspector td, .insp-inspector pre, .insp-inspector code')].filter(e => { const r = e.getBoundingClientRect(); return r.right > ir.x + ir.width + 1; }).slice(0,8).map(e => `${e.tagName} right=${Math.round(e.getBoundingClientRect().right)} text=${e.textContent.slice(0,50)}`), inspR);
console.log('insp box', inspR, 'children beyond right edge', clipped);
await browser.close();
