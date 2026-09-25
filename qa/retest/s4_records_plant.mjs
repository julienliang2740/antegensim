import { launch, shot, evidence, log, loadState, saveState, api, status, sleep, BASE } from './lib.mjs';
const st = loadState(); const runId = st.mainRun; const ENT = st.inspectAgent || 'a07';
const { browser, page } = await launch('1440x900');
log(`=== S4 decision packet, model call record, plant inspector on ${runId} (${ENT})`);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3000);
await page.getByPlaceholder(/e\.g\. a05/).fill(ENT);
await page.getByRole('button', { name: 'Select entity' }).click(); await page.waitForTimeout(1800);
await page.getByRole('button', { name: /Open its latest decision packet/ }).click(); await page.waitForTimeout(2500);
const rv = page.locator('section.record-viewer');
log('record viewer:', await rv.getAttribute('aria-label'));
const secTitles = await rv.locator('details > summary').allInnerTexts();
log('packet sections:', secTitles.map((t) => t.replace(/\n/g, ' ')).slice(0, 20));
await rv.evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(400);
await evidence(page, '11-decision-packet');
const rvTxt = await rv.innerText();
log('packet head text:', rvTxt.slice(0, 900).replace(/\n+/g, ' | '));
// open the model call from the packet
await rv.getByRole('button', { name: /Open model call/ }).first().click(); await page.waitForTimeout(2500);
const rv2 = page.locator('section.record-viewer');
log('record viewer now:', await rv2.getAttribute('aria-label'));
await rv2.evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(400);
await evidence(page, '12-model-call-record');
const t2 = await rv2.innerText();
log('model call text (head):', t2.slice(0, 1400).replace(/\n+/g, ' | '));
await page.keyboard.press('Escape'); await page.waitForTimeout(500);
// ---- plant inspector: find a mature plant that is not fruiting now, else any mature plant
const live = (await api(`/runs/${runId}/state`)).body;
const plants = Object.values(live.entities.plants).filter((p) => p.alive);
const fruitsBy = {};
for (const f of Object.values(live.entities.fruits || {})) if (f.alive !== false) fruitsBy[f.source_plant_id || f.plant_id] = (fruitsBy[f.source_plant_id || f.plant_id] || 0) + 1;
const plant = plants.find((p) => p.stage_index === 2 && !fruitsBy[p.id]) || plants.find((p) => p.stage_index === 2) || plants[0];
log('plant chosen', plant.id, plant.species, 'stage', plant.stage_index, 'energy', plant.energy, 'pos', JSON.stringify(plant.position), 'rounds_since_fruit', plant.rounds_since_fruit);
st.plant = plant.id; saveState(st);
await page.getByPlaceholder(/e\.g\. a05/).fill(plant.id);
await page.getByRole('button', { name: 'Select entity' }).click(); await page.waitForTimeout(2000);
const row = async (label) => page.evaluate((label) => { const th = [...document.querySelectorAll('.insp-inspector th')].find((e) => e.textContent.trim() === label); return th ? th.nextElementSibling.textContent : null; }, label);
log('next fruit row:', await row('next fruit'));
log('next seed row:', await row('next seed'));
await page.locator('.area-inspector').evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(400);
await evidence(page, '13-plant-inspector-rules');
// scroll further to the species rule part
await page.evaluate(() => { const h = [...document.querySelectorAll('.insp-inspector .insp-section-title')].find((e) => /Species rule/.test(e.textContent)); h?.scrollIntoView({ block: 'start' }); });
await page.waitForTimeout(300);
await shot(page, 'd01-plant-species-rule');
const overflow = await page.evaluate(() => [...document.querySelectorAll('.insp-inspector .insp-section-body')].map((e) => ({ t: e.previousElementSibling?.textContent?.slice(0, 45), sw: e.scrollWidth, cw: e.clientWidth })).filter((x) => x.sw > x.cw + 2));
log('plant inspector overflow:', overflow);
// species panel: stage a fruit energy change
const panel = page.locator('section.species-panel');
log('species panel present', await panel.count());
if (await panel.count()) {
  await panel.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  const fe = panel.getByLabel(/fruit energy/).first();
  log('species panel fruit energy before', await fe.inputValue());
  await fe.fill('70');
  await panel.getByRole('button', { name: 'Stage species rule change' }).click(); await page.waitForTimeout(1500);
  log('panel message:', (await panel.locator('.ok-line, .problem-summary, [role=alert]').allInnerTexts()).join(' | '));
  await shot(page, 'd02-species-rule-staged');
  const iv = (await api(`/runs/${runId}/interventions`)).body;
  log('staged:', iv.staged.map((x) => `${x.type}:${x.species ?? ''}:${x.rule?.fruit_energy ?? ''}`));
}
await browser.close();
