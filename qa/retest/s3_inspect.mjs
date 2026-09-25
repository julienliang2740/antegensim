import { launch, shot, evidence, log, loadState, saveState, api, status, sleep, statusText, BASE } from './lib.mjs';
const st = loadState(); const runId = st.mainRun;
const { browser, page } = await launch('1440x900');
log(`=== S3 history, crowded cell, inspector on ${runId}`);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3000);
const tl = page.getByRole('region', { name: 'History timeline' });
// ---- history
await tl.getByRole('button', { name: /Previous round/ }).click(); await page.waitForTimeout(1500);
await tl.getByRole('button', { name: /Previous round/ }).click(); await page.waitForTimeout(1500);
const sel = tl.locator('select');
const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => o.value));
const target = opts.find((v) => /_t03_/.test(v)) || opts[1];
await sel.selectOption(target); await page.waitForTimeout(2000);
log('history mode text:', (await tl.innerText()).replace(/\n/g, ' / '));
await page.getByRole('tab', { name: /Turn record/ }).click(); await page.waitForTimeout(1500);
await evidence(page, '07-history-view');
await page.getByRole('tab', { name: /Map & inspector/ }).click(); await page.waitForTimeout(500);
await tl.getByRole('button', { name: 'Return to live' }).click(); await page.waitForTimeout(2000);
log('after return to live:', (await tl.innerText()).split('\n')[0]);
// ---- crowded cell
const live = (await api(`/runs/${runId}/state`)).body;
const [key, ids] = Object.entries(live.map.occupants).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
log('most crowded', key, ids);
st.crowded = { key, ids };
const cell = page.locator(`rect[data-coord="${key}"]`);
await cell.scrollIntoViewIfNeeded();
await cell.hover(); await page.waitForTimeout(800);
const tip = await page.locator('.insp-tooltip').innerText().catch(() => '(no tooltip)');
log('tooltip:', tip.replace(/\n/g, ' | '));
await evidence(page, '08-crowded-cell-hover');
await cell.click(); await page.waitForTimeout(1200);
const occ = await page.locator('.insp-occupant-row').allInnerTexts();
log('occupant rows', occ.length, occ.map((t) => t.replace(/\n/g, ' ')).slice(0, 12));
const missing = ids.filter((id) => !occ.some((t) => t.includes(id)));
log('occupants missing from list:', missing);
await page.getByRole('heading', { name: 'Occupants' }).evaluate((e) => e.scrollIntoView({ block: 'start' })).catch(() => {});
await page.waitForTimeout(300);
await evidence(page, '09-crowded-cell-occupants');
// ---- agent inspector: pick the agent at that cell with the most model calls
const agentId = ids.find((id) => id.startsWith('a')) || 'a02';
st.inspectAgent = agentId; saveState(st);
await page.locator('.insp-occupant-row', { hasText: agentId }).first().click(); await page.waitForTimeout(2000);
const wide = await page.locator('.inspector-width-toggle').getAttribute('aria-pressed');
const sideW = Math.round((await page.locator('.area-side').boundingBox()).width);
log('wide inspector default aria-pressed', wide, 'side column width', sideW);
const overflow = async () => page.evaluate(() => [...document.querySelectorAll('.insp-inspector .insp-section-body')].map((e) => ({ t: e.previousElementSibling?.textContent?.slice(0, 45), sw: e.scrollWidth, cw: e.clientWidth })).filter((x) => x.sw > x.cw + 2));
log('sections overflowing sideways (wide):', await overflow());
const all = await page.evaluate(() => [...document.querySelectorAll('.insp-inspector .insp-section-body')].map((e) => `${e.previousElementSibling?.textContent?.slice(0, 30)} ${e.scrollWidth}/${e.clientWidth}`));
log('all section widths:', all);
// any element inside the inspector clipped horizontally (text cut) — check cells whose scrollWidth > clientWidth
const clipped = await page.evaluate(() => [...document.querySelectorAll('.insp-inspector td, .insp-inspector th, .insp-inspector pre, .insp-inspector code')].filter((e) => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX !== 'visible').slice(0, 8).map((e) => `${e.tagName} ${e.scrollWidth}/${e.clientWidth} ${e.textContent.slice(0, 40)}`));
log('clipped cells:', clipped);
await page.locator('.area-side').evaluate((e) => (e.scrollTop = 0));
await page.locator('.area-inspector').evaluate((e) => e.scrollIntoView({ block: 'start' }));
await page.waitForTimeout(400);
await evidence(page, '10-agent-inspector');
const inspTxt = await page.locator('.insp-inspector').innerText();
log('inspector sections:', (await page.locator('.insp-inspector .insp-section-title').allInnerTexts()).join(' ; '));
// knowledge records
await page.evaluate(() => { const h = [...document.querySelectorAll('.insp-inspector .insp-section-title')].find((e) => /Knowledge records/.test(e.textContent)); h?.scrollIntoView({ block: 'start' }); });
await page.waitForTimeout(400);
const rec = await page.locator('.insp-record-text').first().evaluate((e) => ({ w: Math.round(e.getBoundingClientRect().width), text: e.textContent.slice(0, 80) })).catch(() => null);
log('first knowledge record text block', rec);
await shot(page, 'c01-knowledge-records');
// recent action results + current action
await page.evaluate(() => { const h = [...document.querySelectorAll('.insp-inspector .insp-section-title')].find((e) => /Recent action results/.test(e.textContent)); h?.scrollIntoView({ block: 'start' }); });
await page.waitForTimeout(300);
await shot(page, 'c02-recent-results');
// narrow mode as well
await page.locator('.inspector-width-toggle').click(); await page.waitForTimeout(700);
log('sections overflowing sideways (narrow):', await overflow(), 'side width', Math.round((await page.locator('.area-side').boundingBox()).width));
await page.evaluate(() => { const h = [...document.querySelectorAll('.insp-inspector .insp-section-title')].find((e) => /Knowledge records/.test(e.textContent)); h?.scrollIntoView({ block: 'start' }); });
await page.waitForTimeout(300);
await shot(page, 'c03-knowledge-records-narrow');
await page.locator('.inspector-width-toggle').click(); await page.waitForTimeout(500);
// agent view
await page.locator('.insp-toggle input').check(); await page.waitForTimeout(1200);
const banners = await page.locator('.insp-banner-agentview').allInnerTexts();
log('agent view banners:', banners.map((b) => b.replace(/\n/g, ' ')));
const occRowAV = await page.locator('.insp-occupant-row').first().innerText().catch(() => '');
log('occupant row in agent view:', occRowAV.replace(/\n/g, ' '));
await page.locator('.area-side').evaluate((e) => (e.scrollTop = 0));
await page.evaluate(() => window.scrollTo(0, 380)); await page.waitForTimeout(300);
await shot(page, 'c04-agent-view');
await page.locator('.insp-toggle input').uncheck(); await page.waitForTimeout(800);
await page.evaluate(() => window.scrollTo(0, 0));
await browser.close();
