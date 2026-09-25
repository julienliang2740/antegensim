import { launch, shot, log, loadState, api, BASE } from './lib.mjs';
const st = loadState(); const runId = st.runId;
const VP = process.env.VP || '1440x900'; const P = process.env.PREFIX || '';
const ENT = process.env.ENT || 'a02';
const { browser, page } = await launch(VP);
log(`=== STEP 5d: packet sections + model call record for ${ENT}`);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(2500);
await page.getByPlaceholder(/e\.g\. a05/).fill(ENT);
await page.getByRole('button', { name: 'Select entity' }).click();
await page.waitForTimeout(1800);
await page.getByRole('button', { name: /Open its latest decision packet/ }).click();
await page.waitForTimeout(2000);
const rv = page.locator('section.record-viewer');
const scroller = await rv.evaluate(e => { let n = e; const out=[]; for (const c of [e, ...e.querySelectorAll('*')]) { const cs = getComputedStyle(c); if ((cs.overflowY==='auto'||cs.overflowY==='scroll') && c.scrollHeight > c.clientHeight+5) out.push(`${c.tagName}.${c.className} sh=${c.scrollHeight} ch=${c.clientHeight}`);} return out; });
log('record viewer scrollers', scroller);
// expand all sections (details) in the packet
const det = rv.locator('details');
const nd = await det.count(); log('packet details count', nd);
for (let i = 0; i < nd; i++) await det.nth(i).evaluate(d => d.open = true);
const secTitles = await rv.locator('details > summary').allInnerTexts();
log('packet sections', secTitles);
const rvTxt = await rv.innerText();
const sit = rvTxt.indexOf('situation');
log('situation excerpt', rvTxt.slice(sit, sit + 800).replace(/\n+/g,' / '));
const fmt = rvTxt.search(/decision_format|DECISION FORMAT|response format/i);
log('format excerpt', rvTxt.slice(fmt, fmt + 400).replace(/\n+/g,' / '));
// screenshot a few positions of the record viewer scroll box
const sb = rv.locator('.record-body, .record-scroll').first();
const hasSb = await sb.count();
const target = hasSb ? sb : rv;
const H = await target.evaluate(e => e.scrollHeight);
for (let k = 0, y = 0; y < H && k < 5; k++, y += 550) {
  await target.evaluate((e, y) => { e.scrollTop = y; }, y); await page.waitForTimeout(200);
  await rv.screenshot({ path: new URL(`./shots/${P}31-packet-section-${k}.png`, import.meta.url).pathname });
}
// open model call record
await target.evaluate(e => { e.scrollTop = 0; });
await rv.getByRole('button', { name: /Open model call/ }).first().click();
await page.waitForTimeout(2000);
const rv2 = page.locator('section.record-viewer');
log('record viewer title now', await rv2.getAttribute('aria-label'));
const d2 = rv2.locator('details'); const n2 = await d2.count();
for (let i = 0; i < n2; i++) await d2.nth(i).evaluate(d => d.open = true);
const t2 = await rv2.innerText();
console.log('---- MODEL CALL VIEW TEXT (first 3500) ----\n' + t2.slice(0, 3500));
const H2 = await rv2.evaluate(e => e.scrollHeight);
for (let k = 0, y = 0; y < H2 && k < 5; k++, y += 550) {
  await rv2.evaluate((e, y) => { e.scrollTop = y; }, y); await page.waitForTimeout(200);
  await rv2.screenshot({ path: new URL(`./shots/${P}32-model-call-${k}.png`, import.meta.url).pathname });
}
await browser.close();
