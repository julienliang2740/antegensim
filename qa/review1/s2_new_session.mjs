import { launch, shot, log, saveState, loadState, api, sleep, BASE } from './lib.mjs';
const { browser, page } = await launch();
const st = loadState();
log('=== STEP 1/2: entry + new session');
await page.goto(BASE + '/#/');
await page.waitForTimeout(800);
await shot(page, '01-entry');
await page.getByRole('button', { name: /New session/ }).click();
await page.waitForTimeout(1500);
await shot(page, '02-new-session-top');
// run name
const runName = 'review1 operator ' + new Date().toISOString().slice(11,19).replace(/:/g,'');
await page.getByLabel('Run name').fill(runName);
log('run name set', runName);
const card = i => page.getByRole('region', { name: new RegExp(`^Agent card ${i}:`) });
// card 2 coords
const c2x = await card(2).getByLabel('x', { exact: true }).inputValue();
const c2y = await card(2).getByLabel('y', { exact: true }).inputValue();
log('card2 coords', c2x, c2y);
await card(1).getByLabel('name', { exact: true }).fill('Aurelia');
await card(1).getByLabel('x', { exact: true }).fill(c2x);
await card(1).getByLabel('y', { exact: true }).fill(c2y);
log('card1 renamed Aurelia and moved to', c2x, c2y);
const c1label = await card(1).getAttribute('aria-label').catch(()=>null);
log('card1 aria-label now', c1label);
// compute -5 on card 3
const comp3 = card(3).getByLabel('compute', { exact: true });
await comp3.fill('-5');
await page.getByRole('button', { name: 'Validate setup' }).first().click();
await page.waitForTimeout(1500);
await shot(page, '03-validate-negative-compute-top');
await comp3.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await shot(page, '04-validate-negative-compute-field');
const bodyText = await page.locator('body').innerText();
const pathShown = /agents\[2\]\.stats\.compute/.test(bodyText);
log('problem path agents[2].stats.compute shown on page:', pathShown);
const card3Text = await card(3).innerText();
log('card3 problem text near field:', (card3Text.match(/.*(negative|>=|≥|must|compute).*$/gim) || []).slice(0,5));
const inv = await comp3.getAttribute('aria-invalid');
log('compute aria-invalid', inv, 'class', await comp3.getAttribute('class'));
// fix
await comp3.fill('200');
await page.getByRole('button', { name: 'Validate setup' }).first().click();
await page.waitForTimeout(1200);
log('after fix status line:', (await page.getByRole('region', { name: 'Setup actions' }).innerText()).replace(/\n/g,' | '));
// add card
await page.getByRole('button', { name: 'Add agent card' }).click();
await page.waitForTimeout(500);
const heading = await page.getByRole('heading', { name: /Agent cards/ }).innerText();
log('after add:', heading);
await card(9).scrollIntoViewIfNeeded();
await shot(page, '05-added-card-9');
log('card 9 label:', await card(9).getAttribute('aria-label'), 'id', await card(9).getByLabel('id', { exact: true }).inputValue(), 'x,y', await card(9).getByLabel('x',{exact:true}).inputValue(), await card(9).getByLabel('y',{exact:true}).inputValue());
// remove card 8 (Halcyon)
await card(8).getByRole('button', { name: 'Remove this card' }).click();
await page.waitForTimeout(500);
log('after remove:', await page.getByRole('heading', { name: /Agent cards/ }).innerText());
const labels = await page.locator('section.agent-card').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
log('cards now:', labels);
// model override card 2
const sel = card(2).locator('select').first();
const opts = await sel.locator('option').allInnerTexts();
log('model options', opts);
await sel.selectOption({ label: opts.find(o => o.startsWith('fake-scripted')) });
log('card2 model =', await sel.inputValue());
// context default: recent history length
const rhl = page.getByLabel('Recent history length').first();
log('recent history length before', await rhl.inputValue());
await rhl.fill('8');
// plant rule: fruit energy
const fe = page.getByLabel(/fruit_tree fruit energy/).first();
log('fruit energy before', await fe.inputValue());
await fe.fill('75');
await page.getByRole('button', { name: 'Validate setup' }).first().click();
await page.waitForTimeout(1500);
log('validate status:', (await page.getByRole('region', { name: 'Setup actions' }).innerText()).replace(/\n/g,' | '));
await rhl.scrollIntoViewIfNeeded();
await shot(page, '06-context-default-changed');
await fe.scrollIntoViewIfNeeded();
await shot(page, '07-plant-rule-fruit-energy');
await page.evaluate(() => window.scrollTo(0,0));
await shot(page, '08-validated-top');
// create
await page.getByRole('button', { name: 'Create and open' }).first().click();
await page.waitForURL(/#\/run\//, { timeout: 15000 });
await page.waitForTimeout(2500);
const runId = decodeURIComponent(page.url().split('#/run/')[1].split('?')[0]);
log('created run', runId);
await shot(page, '09-run-page-initial');
st.runId = runId; st.runName = runName; saveState(st);
const s = await api(`/runs/${runId}/state`);
const agents = s.body.world?.agents || {};
log('backend: a01', JSON.stringify(agents.a01?.name), agents.a01?.position, 'a02 pos', agents.a02?.position, 'ids', Object.keys(agents));
const set = await api(`/runs/${runId}/settings`);
log('backend settings keys', Object.keys(set.body||{}));
log('context recent_history_length', JSON.stringify(set.body?.run_context ?? set.body?.context ?? set.body).slice(0,400));
await browser.close();
