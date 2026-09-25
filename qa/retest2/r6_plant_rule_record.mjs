// How the applied update_plant_rules record reads in the Turn record tab (is fruit_energy 60 -> 70 findable?).
import { launch, shot, log, loadState, api, BASE } from './lib.mjs';
const st = loadState(); const runId = st.r1[1].runId;
const { browser, page } = await launch('1440x900');
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3500);
await page.getByRole('tab', { name: /Turn record/ }).click(); await page.waitForTimeout(1500);
const rec = page.locator('.intervention-record', { hasText: 'update_plant_rules' }).first();
const toggles = rec.locator('summary');
log('summaries in the plant-rule record:', await toggles.count(), await toggles.allInnerTexts());
for (let i = 0; i < await toggles.count(); i++) await toggles.nth(i).click();
await page.waitForTimeout(400);
const txt = await rec.innerText();
log('expanded text has fruit_energy 60 and 70:', /"fruit_energy":\s*60/.test(txt), /"fruit_energy":\s*70/.test(txt), 'length', txt.length);
await rec.evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
await shot(page, 'r6-plant-rule-record-expanded');
await browser.close();
const s = (await api(`/runs/${runId}/status`)).body; log('run state after viewing', s.state);
await api(`/runs/${runId}/close`, { method: 'POST' });
