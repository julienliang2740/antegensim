import { launch, shot, evidence, log, loadState, saveState, api, status, sleep, waitIdle, BASE } from './lib.mjs';
const st = loadState(); const runId = st.mainRun;
log(`=== S6 crowded cell (re-staged placements) on ${runId}`);
const live0 = (await api(`/runs/${runId}/state`)).body;
const pos = live0.entities.agents.a07.position;
for (const ent of [
  { kind: 'fruit', id: '', position: pos, available_compute: 25, available_essence: 0 },
  { kind: 'fruit', id: '', position: pos, available_compute: 40, available_essence: 0 },
  { kind: 'seed', id: '', position: pos, species: 'fruit_tree', germinates_round: 99 },
  { kind: 'residue', id: '', position: pos, available_compute: 5, available_essence: 2, source_id: 'a99', source_kind: 'agent' },
]) {
  const r = await api(`/runs/${runId}/interventions`, { method: 'POST', body: { type: 'place_entity', entity: ent, origin: 'ui' } });
  log('stage place', ent.kind, r.status, r.status >= 300 ? JSON.stringify(r.body).slice(0, 300) : 'ok');
}
const { browser, page } = await launch('1440x900');
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3000);
await page.getByRole('button', { name: 'Run turn', exact: true }).click(); await sleep(800);
const s = await waitIdle(runId); await page.waitForTimeout(2500);
const live = (await api(`/runs/${runId}/state`)).body;
const key = `${pos.x},${pos.y}`;
const ids = live.map.occupants[key];
log('applied at', s.current_turn_id, 'occupants at', key, ids);
st.crowded = { key, ids }; saveState(st);
// bring the whole map into view
const map = page.locator('.area-map');
await map.evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(400);
const cell = page.locator(`rect[data-coord="${key}"]`);
await cell.hover(); await page.waitForTimeout(900);
const tip = await page.locator('.insp-tooltip').innerText().catch(() => '(no tooltip)');
log('tooltip:', tip.replace(/\n/g, ' | '));
const tb = await page.locator('.insp-tooltip').boundingBox().catch(() => null);
log('tooltip box', tb);
await evidence(page, '08-crowded-cell-hover');
await cell.click(); await page.waitForTimeout(1500);
const occ = await page.locator('.insp-occupant-row').allInnerTexts();
log('occupant rows', occ.length, occ.map((t) => t.replace(/\n/g, ' ')));
log('occupants missing from list:', ids.filter((id) => !occ.some((t) => t.includes(id))));
// selecting each occupant shows an inspector
const res = {};
for (const id of ids) {
  await page.locator('.insp-occupant-row', { hasText: id }).first().click(); await page.waitForTimeout(700);
  const head = await page.locator('.insp-inspector').first().innerText().catch(() => '');
  res[id] = head.split('\n').slice(0, 2).join(' ').slice(0, 90);
}
log('inspector heads per occupant:', res);
await page.locator('.insp-occupant-row', { hasText: ids[0] }).first().click(); await page.waitForTimeout(700);
await page.getByRole('heading', { name: /Occupants at/ }).evaluate((e) => e.scrollIntoView({ block: 'start' })).catch(() => {});
await page.evaluate(() => window.scrollBy(0, -10)); await page.waitForTimeout(400);
await evidence(page, '09-crowded-cell-occupants');
await browser.close();
