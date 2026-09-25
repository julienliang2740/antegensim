import { launch, shot, log, saveState, loadState, api, BASE } from './lib.mjs';
const { browser, page } = await launch();
const st = loadState();
log('=== STEP 1: new session with claude-cli-haiku, 6 agents, $1.00, delay 0');
await page.goto(BASE + '/#/');
await page.waitForTimeout(1000);
await page.getByRole('button', { name: /New session/ }).click();
await page.waitForTimeout(2000);
const runName = 'review2 live haiku ' + new Date().toISOString().slice(11,19).replace(/:/g,'');
await page.getByLabel('Run name').fill(runName);
const sel = page.locator('#setup-default-model');
const opts = await sel.locator('option').evaluateAll(os => os.map(o => ({ v: o.value, t: o.textContent, d: o.disabled })));
log('default model options', opts);
await sel.selectOption('claude-cli-haiku');
await page.waitForTimeout(500);
log('selected', await sel.inputValue());
const heading = await page.getByRole('heading', { name: /Agent cards/ }).innerText();
log('agent cards heading', heading);
// reduce to 6 cards if needed
let n = await page.locator('section.agent-card').count();
while (n > 6) {
  await page.locator('section.agent-card').nth(n - 1).getByRole('button', { name: 'Remove this card' }).click();
  await page.waitForTimeout(300);
  n = await page.locator('section.agent-card').count();
}
log('cards now', n, await page.getByRole('heading', { name: /Agent cards/ }).innerText());
const budget = page.getByLabel(/Real budget in USD/);
await budget.fill('1.00');
const delay = page.getByLabel(/Play delay/);
await delay.fill('0');
await page.waitForTimeout(300);
log('budget', await budget.inputValue(), 'delay', await delay.inputValue());
await page.getByRole('button', { name: 'Validate setup' }).first().click();
await page.waitForTimeout(2000);
log('validate:', (await page.getByRole('region', { name: 'Setup actions' }).innerText()).replace(/\n/g, ' | '));
await page.evaluate(() => window.scrollTo(0, 0));
await shot(page, '01-setup-run-section');
// model select close-up + hint
const row = page.locator('#setup-default-model').locator('xpath=ancestor::div[contains(@class,"form-row")]');
await row.scrollIntoViewIfNeeded();
log('model row text:', (await row.innerText()).replace(/\n/g, ' | '));
// context section hint mentions model window
const ctxHint = await page.getByRole('heading', { name: /Context settings \(run defaults\)/ }).locator('xpath=following-sibling::p[1]').innerText().catch(() => '');
log('context hint:', ctxHint);
// card 1 model line
const card1 = page.locator('section.agent-card').first();
await card1.scrollIntoViewIfNeeded();
await shot(page, '02-setup-agent-cards');
log('card1 text:', (await card1.innerText()).replace(/\n/g, ' | ').slice(0, 600));
await page.evaluate(() => window.scrollTo(0, 0));
await page.getByRole('button', { name: 'Create and open' }).first().click();
await page.waitForURL(/#\/run\//, { timeout: 20000 });
await page.waitForTimeout(3000);
const runId = decodeURIComponent(page.url().split('#/run/')[1].split('?')[0]);
log('created run', runId);
await shot(page, '03-run-page-initial');
st.runId = runId; st.runName = runName; saveState(st);
const set = await api(`/runs/${runId}/settings`);
log('settings default model', set.body?.default_model_key, 'budget', set.body?.real_budget_usd, 'delay', set.body?.play_delay_seconds, 'overrides', JSON.stringify(set.body?.model_overrides));
const s = await api(`/runs/${runId}/status`);
log('status', JSON.stringify(s.body));
await browser.close();
