import { launch, shot, log, loadState, api, BASE } from './lib.mjs';
const st = loadState(); const runId = st.runId;
const ENT = process.env.ENT || 'a04';
const P = process.env.PREFIX || '37';
const { browser, page } = await launch();
log(`=== STEP 4b: packet + model call scroll shots for ${ENT}`);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3000);
await page.getByPlaceholder(/e\.g\. a05/).fill(ENT);
await page.getByRole('button', { name: 'Select entity' }).click();
await page.waitForTimeout(2000);
await page.getByRole('button', { name: /Open its latest decision packet/ }).first().click();
await page.waitForTimeout(2500);
const rv = page.locator('section.record-viewer');
await page.evaluate(() => window.scrollTo(0, 0));
// open only the section details, not the exact messages (to keep it readable), then the situation structured
const sums = await rv.locator('details > summary').allInnerTexts();
log('sections', sums);
const det = rv.locator('details');
for (let i = 0; i < await det.count(); i++) {
  const s = sums[i] || '';
  await det.nth(i).evaluate((d, open) => d.open = open, !/stable_rules|Exact messages/.test(s));
}
await page.waitForTimeout(400);
const H = await rv.evaluate(e => e.scrollHeight);
log('record viewer scrollHeight', H, 'clientHeight', await rv.evaluate(e => e.clientHeight));
// find offsets of situation and decision_request
for (const [name, re] of [['situation', /^situation/], ['decision', /^decision_request/], ['structured', /^Situation \(structured\)/]]) {
  const idx = sums.findIndex(s => re.test(s));
  if (idx < 0) continue;
  const off = await det.nth(idx).evaluate(d => { const rv = d.closest('section.record-viewer'); return d.getBoundingClientRect().top - rv.getBoundingClientRect().top + rv.scrollTop; });
  await rv.evaluate((e, y) => { e.scrollTop = y - 10; }, off);
  await page.waitForTimeout(300);
  await rv.screenshot({ path: new URL(`./shots/${P}-${ENT}-packet-${name}.png`, import.meta.url).pathname });
  log('  shot', `${P}-${ENT}-packet-${name}.png`);
  const txt = await det.nth(idx).innerText();
  console.log(`---- ${name} ----\n` + txt.slice(0, 3000));
}
// model call
await rv.evaluate(e => { e.scrollTop = 0; });
await rv.getByRole('button', { name: /Open model call/ }).first().click();
await page.waitForTimeout(2500);
const rv2 = page.locator('section.record-viewer');
await rv2.evaluate(e => { e.scrollTop = 0; });
await rv2.screenshot({ path: new URL(`./shots/${P}-${ENT}-model-call.png`, import.meta.url).pathname });
const t2 = await rv2.innerText();
console.log('---- MODEL CALL (head) ----\n' + t2.slice(0, 1800));
await browser.close();
