import { launch, shot, log, loadState, api, BASE } from './lib.mjs';
const st = loadState(); const runId = st.runId;
const VP = process.env.VP || '1440x900'; const P = process.env.PREFIX || '';
const ENT = process.env.ENT || 'a02';
const { browser, page } = await launch(VP);
log(`=== STEP 5c: wider inspector + packet + model call for ${ENT} (${VP})`);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(2500);
await page.getByPlaceholder(/e\.g\. a05/).fill(ENT);
await page.getByRole('button', { name: 'Select entity' }).click();
await page.waitForTimeout(2000);
await page.getByRole('button', { name: 'Wider inspector' }).click();
await page.waitForTimeout(800);
const side = page.locator('.area-side');
let box = await side.boundingBox();
log('side after wider', box);
await shot(page, `${P}25-wider-inspector`);
// scroll to knowledge records
const kr = page.getByText(/Knowledge records \(/).first();
await kr.scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
await shot(page, `${P}26-wider-inspector-knowledge`);
// expand one knowledge record
const firstRec = page.locator('.insp-inspector details summary, .insp-inspector [aria-expanded]').filter({ hasText: /You|your/ }).first();
if (await firstRec.count()) { await firstRec.click(); await page.waitForTimeout(300); await shot(page, `${P}27-knowledge-record-expanded`); }
// Open latest decision packet
const ob = page.getByRole('button', { name: /Open its latest decision packet/ });
log('open latest packet button present', await ob.count());
await side.evaluate(e => e.scrollTop = 0);
await ob.first().click();
await page.waitForTimeout(2000);
log('url now', page.url());
const tabsel = await page.locator('[role=tab][aria-selected=true]').allInnerTexts().catch(()=>[]);
log('selected tab', tabsel);
await shot(page, `${P}28-decision-packet`);
const bodyTxt = await page.locator('body').innerText();
const idx = bodyTxt.search(/decision packet/i);
log('packet view text excerpt:', bodyTxt.slice(Math.max(0, idx - 100), idx + 1500).replace(/\n+/g, ' / '));
await page.evaluate(() => window.scrollTo(0, 700)); await page.waitForTimeout(300);
await shot(page, `${P}29-decision-packet-scrolled`);
await page.evaluate(() => window.scrollTo(0, 1400)); await page.waitForTimeout(300);
await shot(page, `${P}30-decision-packet-scrolled2`);
// model call record
const mc = page.getByRole('button', { name: /^Open$|model call|Open call|mc_/ });
log('model call buttons', await mc.allInnerTexts());
await browser.close();
