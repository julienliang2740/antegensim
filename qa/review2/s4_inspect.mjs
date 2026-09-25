import { launch, shot, log, loadState, api, BASE } from './lib.mjs';
const st = loadState(); const runId = st.runId;
const ENT = process.env.ENT || 'a04';
const P = process.env.PREFIX || '3';
const { browser, page } = await launch();
log(`=== STEP 4: inspect ${ENT}`);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3000);
await page.getByPlaceholder(/e\.g\. a05/).fill(ENT);
await page.getByRole('button', { name: 'Select entity' }).click();
await page.waitForTimeout(2000);
await shot(page, `${P}0-${ENT}-selected`);
const wider = page.getByRole('button', { name: 'Wider inspector' });
if (await wider.count()) { await wider.click(); await page.waitForTimeout(800); }
const side = page.locator('.area-side');
const box = await side.boundingBox();
const sh = await side.evaluate(e => e.scrollHeight);
log('side box', box, 'scrollHeight', sh);
// scroll to "Recent action results"
for (const title of ['Recent action results', 'Received messages and voice', 'Notebook', 'Knowledge records']) {
  const h = page.getByText(new RegExp('^' + title)).first();
  if (await h.count()) { await h.scrollIntoViewIfNeeded(); await page.waitForTimeout(300); }
}
const rr = page.getByText(/^Recent action results/).first();
await rr.evaluate(e => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
await shot(page, `${P}1-${ENT}-recent-results`);
const kr = page.getByText(/^Knowledge records \(/).first();
await kr.evaluate(e => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
await shot(page, `${P}2-${ENT}-knowledge-records`);
const insp = await page.locator('.insp-inspector').innerText().catch(() => '');
const i1 = insp.indexOf('Recent action results');
log('inspector recent results:', insp.slice(i1, i1 + 700).replace(/\n/g, ' | '));
const i2 = insp.indexOf('Knowledge records (');
log('inspector knowledge records:', insp.slice(i2, i2 + 1500).replace(/\n/g, ' | '));
const i3 = insp.indexOf('Notebook');
log('inspector notebook:', insp.slice(i3, i3 + 400).replace(/\n/g, ' | '));
// open latest decision packet
await side.evaluate(e => e.scrollTop = 0);
const ob = page.getByRole('button', { name: /Open its latest decision packet/ });
log('open latest packet buttons', await ob.count(), await page.getByRole('button', { name: /decision packet|model call/i }).allInnerTexts());
await ob.first().click();
await page.waitForTimeout(2500);
const rv = page.locator('section.record-viewer');
await rv.scrollIntoViewIfNeeded();
await shot(page, `${P}3-${ENT}-packet-top`);
const det = rv.locator('details'); const nd = await det.count();
log('packet details', nd, await rv.locator('details > summary').allInnerTexts());
for (let i = 0; i < nd; i++) await det.nth(i).evaluate(d => d.open = true);
await page.waitForTimeout(500);
const rvTxt = await rv.innerText();
log('packet text length', rvTxt.length);
console.log('---- PACKET TEXT ----\n' + rvTxt.slice(0, 12000));
// screenshots of packet by scrolling the page/record
const rbox = await rv.boundingBox();
log('record viewer box', rbox);
const scroller = await rv.evaluate(e => { let n = e; while (n) { const cs = getComputedStyle(n); if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 5) return n.className || n.tagName; n = n.parentElement; } return 'window'; });
log('scroll container', scroller);
for (let k = 0; k < 10; k++) {
  const y = rbox.y + k * 800;
  await page.evaluate(y => window.scrollTo(0, y - 10), y);
  await page.waitForTimeout(250);
  const pos = await page.evaluate(() => window.scrollY);
  await shot(page, `${P}4-${ENT}-packet-${k}`);
  if (pos + 900 >= await page.evaluate(() => document.body.scrollHeight)) break;
}
// open model call
const mcb = rv.getByRole('button', { name: /Open model call/ });
log('model call buttons', await mcb.allInnerTexts());
await mcb.first().click();
await page.waitForTimeout(2500);
const rv2 = page.locator('section.record-viewer');
const d2 = rv2.locator('details'); const n2 = await d2.count();
for (let i = 0; i < n2; i++) await d2.nth(i).evaluate(d => d.open = true);
await page.waitForTimeout(400);
const t2 = await rv2.innerText();
console.log('---- MODEL CALL TEXT ----\n' + t2.slice(0, 5000));
const b2 = await rv2.boundingBox();
await page.evaluate(y => window.scrollTo(0, y - 10), b2.y + (await page.evaluate(() => window.scrollY)));
await page.waitForTimeout(300);
await shot(page, `${P}5-${ENT}-model-call-0`);
await page.evaluate(() => window.scrollBy(0, 800)); await page.waitForTimeout(300);
await shot(page, `${P}6-${ENT}-model-call-1`);
await browser.close();
