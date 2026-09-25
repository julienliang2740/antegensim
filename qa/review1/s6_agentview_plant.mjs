import { launch, shot, log, loadState, saveState, api, BASE } from './lib.mjs';
const st = loadState(); const runId = st.runId;
const VP = process.env.VP || '1440x900'; const P = process.env.PREFIX || '';
const { browser, page } = await launch(VP);
log(`=== STEP 5e/6: agent view + plant (${VP})`);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(2500);
const side = page.locator('.area-side');
// agent view on a02
await page.getByPlaceholder(/e\.g\. a05/).fill('a02');
await page.getByRole('button', { name: 'Select entity' }).click();
await page.waitForTimeout(1800);
const toggle = page.locator('.insp-toggle input');
await toggle.check();
await page.waitForTimeout(1500);
const txtOn = await page.locator('.insp-inspector').innerText();
log('agent view ON sections:', (await page.locator('.insp-inspector summary, .insp-inspector .insp-section-title').allInnerTexts()).join(' ; '));
await shot(page, `${P}33-agent-view-on`);
// does the map change in agent view?
const mapCellsHidden = await page.locator('.insp-map, svg').first().evaluate(e => e.outerHTML.includes('unknown') || e.outerHTML.includes('fog')).catch(()=>null);
log('map shows fog/unknown in agent view?', mapCellsHidden);
const mapLegend = await page.locator('.insp-legend').innerText().catch(()=> '');
log('legend (agent view on):', mapLegend.replace(/\n/g,' / '));
await page.locator('.area-side').evaluate(e => e.scrollTop = 0);
await page.evaluate(() => window.scrollTo(0, 400)); await page.waitForTimeout(300);
await shot(page, `${P}34-agent-view-map`);
await toggle.uncheck(); await page.waitForTimeout(800);
// plant
const s = (await api(`/runs/${runId}/state`)).body;
const plants = Object.values(s.entities.plants);
const plant = plants.find(p => p.stage_index === 2) || plants[0];
log('plant chosen', plant.id, plant.species, 'stage', plant.stage_index, 'pos', plant.position);
await page.evaluate(() => window.scrollTo(0, 0));
await page.getByPlaceholder(/e\.g\. a05/).fill(plant.id);
await page.getByRole('button', { name: 'Select entity' }).click();
await page.waitForTimeout(1800);
const box = await side.boundingBox();
const H = await side.evaluate(e => e.scrollHeight);
log('side pane height', H);
for (let k = 0, y = 0; y < H && k < 7; k++, y += Math.floor(box.height*0.9)) {
  await side.evaluate((e, y) => { e.scrollTop = y; }, y); await page.waitForTimeout(250);
  await shot(page, `${P}35-plant-${plant.id}-part${k}`, { clip: { x: Math.max(0, box.x - 4), y: box.y, width: box.width + 8, height: box.height } });
}
const ptxt = await page.locator('.insp-inspector').innerText();
console.log('--- PLANT INSPECTOR ---\n' + ptxt.slice(0, 2500));
// species rule change panel
const panel = page.locator('section.species-panel');
log('species panel present', await panel.count());
const fe = panel.getByLabel(/fruit energy/).first();
log('panel fruit energy before', await fe.inputValue());
await fe.fill('90');
await panel.getByRole('button', { name: 'Stage species rule change' }).click();
await page.waitForTimeout(1500);
log('panel message:', (await panel.locator('.ok-line, .problem-summary, [role=alert]').allInnerTexts()).join(' | '));
await panel.scrollIntoViewIfNeeded();
const pb = await panel.boundingBox();
await shot(page, `${P}36-species-rule-staged`);
const iv = (await api(`/runs/${runId}/interventions`)).body;
log('staged interventions', JSON.stringify(iv).slice(0, 300));
log('status bar staged edits:', (await page.getByRole('region', { name: 'Run status' }).innerText()).match(/STAGED EDITS\s*\|?\s*\n?\s*(\d+)/i)?.[1]);
await browser.close();
