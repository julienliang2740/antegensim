import { launch, shot, log, loadState, api, BASE, sleep } from './lib.mjs';
const st = loadState(); const runId = st.runId;
const { browser, page } = await launch();
log('=== STEP 12: staged-count lag');
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(2500);
await page.getByRole('tab', { name: /God mode/ }).click(); await page.waitForTimeout(1000);
const statusStaged = async () => (await page.getByRole('region', { name: 'Run status' }).innerText()).replace(/\n/g,' ').match(/STAGED EDITS\s+(\d+)/i)?.[1];
await page.locator('#qv-text').fill('lag probe');
await page.getByRole('button', { name: 'Send voice' }).click();
const t0 = Date.now(); const samples = [];
while (Date.now() - t0 < 6000) { samples.push(`${Date.now()-t0}ms status=${await statusStaged()} tab=${(await page.getByRole('tab', { name: /God mode/ }).innerText()).replace('God mode','').trim()}`); await sleep(250); }
const changes = samples.filter((s, i) => i === 0 || s.split(' ').slice(1).join(' ') !== samples[i-1].split(' ').slice(1).join(' '));
log('samples (changes only):', changes);
await shot(page, '75-staged-count-mismatch-probe');
// discard it again
const disc = page.getByText(/voice to all living agents: "lag probe"/).locator('xpath=..').getByRole('button', { name: 'Discard' });
await disc.click().catch(e => log('discard click failed', String(e).slice(0,100)));
await page.waitForTimeout(1500);
log('staged after discard', (await api(`/runs/${runId}/interventions`)).body.staged.length);
await browser.close();
