import { launch, shot, log, loadState, saveState, api, BASE } from './lib.mjs';
const st = loadState(); const runId = st.runId;
const { browser, page } = await launch();
log('=== STEP 7a: god mode staging on', runId);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(2500);
await page.getByRole('tab', { name: /God mode/ }).click(); await page.waitForTimeout(1200);
const stagedList = async () => (await page.getByText(/Staged edits \(\d+\)/).first().locator('xpath=..').innerText().catch(()=> '')).replace(/\n/g,' / ');
const feedback = async () => (await page.locator('.ok-line, .insp-ok, [role=alert], .problem-summary, .insp-problems').allInnerTexts()).join(' | ').slice(0,400);
// 1. voice to one agent (quick panel)
await page.locator('#qv-text').fill('A voice for Boreas only: look east.');
await page.getByLabel('Chosen agents').check();
await page.waitForTimeout(300);
const qvBoxes = page.locator('input[type=checkbox]').filter({ has: page.locator('xpath=.') });
await page.getByRole('checkbox', { name: /a02/ }).first().check();
await page.getByRole('button', { name: 'Send voice' }).click(); await page.waitForTimeout(1200);
log('after voice to a02:', await feedback());
// 2. voice to all
await page.locator('#qv-text').fill('Everyone: the storm is coming.');
await page.getByLabel('All living agents (broadcast)').check();
await page.getByRole('button', { name: 'Send voice' }).click(); await page.waitForTimeout(1200);
log('after broadcast voice:', await feedback());
await shot(page, '38-god-voices-staged');
// 3. run-default context change (quick panel)
const rhl = page.getByLabel('Recent history length').first();
await rhl.fill('6');
await page.getByRole('button', { name: 'Stage run-default context change' }).click(); await page.waitForTimeout(1200);
log('after run context change:', await feedback());
// 4. set stat a03 compute 150
await page.getByRole('tab', { name: 'Set stat', exact: true }).click(); await page.waitForTimeout(400);
await page.locator('#gm-ss-entity').selectOption({ value: 'a03' }).catch(async e => { log('select a03 by value failed', String(e).slice(0,100)); });
await page.locator('#gm-ss-field').selectOption('stats.compute');
await page.locator('#gm-ss-value').fill('150');
await page.getByRole('button', { name: 'Stage stat change' }).click(); await page.waitForTimeout(1200);
log('after set stat:', await feedback());
// 5. place a fruit at (1,0)
await page.getByRole('tab', { name: 'Place entity', exact: true }).click(); await page.waitForTimeout(400);
await page.locator('#gm-pe-kind').selectOption('fruit');
await page.waitForTimeout(300);
const peX = page.locator('#gm-pe-point-x, [id^=gm-pe][id$=-x]').first();
log('place point fields', await page.locator('[id^=gm-pe]').evaluateAll(es => es.map(e => e.id)));
await shot(page, '39-god-place-entity-form');
// 6. agent-scope context settings for a03
await page.getByRole('tab', { name: 'Context settings', exact: true }).click(); await page.waitForTimeout(400);
await page.locator('#gm-cs-scope').selectOption('a03'); await page.waitForTimeout(400);
await shot(page, '40-god-context-agent-scope');
await browser.close();
