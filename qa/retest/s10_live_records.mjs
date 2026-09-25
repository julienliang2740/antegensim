// Read-only look at the stored live (claude-cli-haiku) run from review2: no run controls are pressed,
// so no model is called.  Checks reasoning tokens and provider cost formatting on real provider data.
import { launch, shot, log, api, status, BASE } from './lib.mjs';
const runId = 'run_20260925_183039_9341';
const turnId = 'r00002_t02_a03';
const before = await status(runId);
log(`=== S10 stored live run records (${runId}) status before: ${before.state ?? JSON.stringify(before).slice(0, 80)}`);
const { browser, page } = await launch('1440x900');
await page.goto(`${BASE}/#/run/${runId}?turn=${turnId}`); await page.waitForTimeout(3500);
await page.getByRole('tab', { name: /Turn record/ }).click(); await page.waitForTimeout(1500);
const btns = await page.getByRole('button', { name: /Open model call/ }).allInnerTexts();
log('turn record model call buttons:', btns);
await page.getByRole('heading', { name: /Decision packet and model calls/ }).evaluate((e) => e.scrollIntoView({ block: 'start' })).catch(() => {});
await shot(page, 'j01-live-turn-record-buttons');
await page.getByRole('button', { name: /Open model call mc_r00002_t02_a03_03/ }).click(); await page.waitForTimeout(2500);
const rv = page.locator('section.record-viewer');
const txt = await rv.innerText();
log('live model call record (head):', txt.slice(0, 1100).replace(/\n+/g, ' | '));
await rv.evaluate((e) => e.scrollIntoView({ block: 'start' }));
await shot(page, 'j02-live-model-call-record');
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
await page.getByRole('button', { name: /Open model call mc_r00002_t02_a03_01/ }).click(); await page.waitForTimeout(2500);
const txt2 = await page.locator('section.record-viewer').innerText();
log('live FAILED model call record (head):', txt2.slice(0, 1100).replace(/\n+/g, ' | '));
await page.locator('section.record-viewer').evaluate((e) => e.scrollIntoView({ block: 'start' }));
await shot(page, 'j03-live-failed-call-record');
log('status bar usage:', (await page.getByRole('region', { name: 'Run status' }).innerText()).replace(/\n+/g, ' | ').slice(0, 600));
// the activity log lines of live model calls
const notes = await page.locator('.log-line').evaluateAll((ls) => ls.filter((l) => /model_call_(completed|failed)/.test(l.innerText)).slice(-4).map((l) => l.innerText.replace(/\n/g, ' ~ ')));
for (const n of notes) log('   ', n.slice(0, 300));
await page.getByRole('button', { name: 'Back to sessions' }).click(); await page.waitForTimeout(1500);
await browser.close();
const after = await api(`/runs/${runId}/status`);
log('status after leaving', after.status, JSON.stringify(after.body).slice(0, 100));
