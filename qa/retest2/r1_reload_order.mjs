// (1) Reload-ordering scenario (p3 recipe) driven through the UI in both orders.
// UI edits: voice to a01, fruit placed at (0,0) with compute 33, fruit_tree fruit_energy -> 70,
// run-default recent history -> 3, set_stat a05.stats.health -> 55; file edit: a05.json health 77.
import fs from 'node:fs';
import path from 'node:path';
import { launch, shot, log, api, waitIdle, loadState, saveState, BASE } from './lib.mjs';
const VP = process.env.VP || '1440x900';
const st = loadState();

async function scenario(order) {
  const d = (await api('/defaults?agent_count=6')).body;
  d.name = `retest2 reload order (${order})`; d.play_delay_seconds = 0;
  const runId = (await api('/runs', { method: 'POST', body: d })).body.run_id;
  await api(`/runs/${runId}/open`, { method: 'POST' });
  const sum = (await api(`/runs/${runId}`)).body;
  const live0 = (await api(`/runs/${runId}/state`)).body;
  const fe0 = live0.rules.plant_species.fruit_tree.fruit_energy;
  const rh0 = live0.settings.context.recent_history_length;
  log(`=== R1 [${order}] ${runId} at ${live0.turn.turn_id}; fruit_energy ${fe0}, recent_history ${rh0}, a05 health ${live0.entities.agents.a05.stats.health}, terrain(0,0)?`);
  const { browser, page } = await launch(VP);
  await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3000);
  await page.getByRole('tab', { name: /God mode/ }).click(); await page.waitForTimeout(1200);
  const panelTab = (name) => page.getByRole('tablist', { name: 'Intervention type' }).getByRole('tab', { name, exact: true });
  const okText = async () => (await page.locator('.insp-godmode .insp-tabpanel .insp-ok').innerText().catch(() => '')).trim();
  const problems = async () => (await page.locator('.insp-godmode .insp-tabpanel').innerText().catch(() => '')).match(/Not staged[\s\S]*/)?.[0]?.slice(0, 300) ?? '';
  const steps = {
    async voice() {
      await page.locator('#qv-text').fill(`retest2 voice (${order})`);
      await page.getByLabel('Chosen agents').check(); await page.waitForTimeout(200);
      await page.locator('.check-grid label', { hasText: /^\s*a01\b/ }).locator('input').check();
      await page.getByRole('button', { name: 'Send voice' }).click(); await page.waitForTimeout(900);
      log('  voice:', (await page.locator('.quick-box .ok-line').first().innerText().catch(() => '(no ok line)')).trim());
    },
    async place() {
      await panelTab('Place entity').click(); await page.waitForTimeout(300);
      await page.locator('#gm-pe-kind').selectOption('fruit'); await page.waitForTimeout(200);
      await page.locator('#gm-pe-pos-x').fill('0'); await page.locator('#gm-pe-pos-y').fill('0');
      await page.locator('#gm-pe-compute').fill('33'); await page.locator('#gm-pe-compute').press('Tab');
      await page.getByRole('button', { name: 'Stage placement of a new fruit' }).click(); await page.waitForTimeout(900);
      log('  place:', await okText(), await problems());
    },
    async plantRule() {
      await panelTab('Plant rules').click(); await page.waitForTimeout(300);
      const inp = page.getByLabel('fruit_tree fruit energy (fruit_energy)');
      await inp.fill(String(fe0 + 10)); await inp.press('Tab'); await page.waitForTimeout(200);
      await page.getByRole('button', { name: /Stage 1 species change/ }).click(); await page.waitForTimeout(900);
      log('  plant rule:', await okText(), await problems());
    },
    async context() {
      const qb = page.locator('section.quick-box', { hasText: 'Run-default context settings' });
      const rh = qb.getByLabel(/recent history/i).first();
      await rh.fill(String(rh0 - 2)); await rh.press('Tab'); await page.waitForTimeout(200);
      await qb.getByRole('button', { name: 'Stage run-default context change' }).click(); await page.waitForTimeout(900);
      log('  context:', (await qb.locator('.ok-line').innerText().catch(() => '(no ok line)')).trim());
    },
    async setStat() {
      await panelTab('Set stat').click(); await page.waitForTimeout(300);
      await page.locator('#gm-ss-entity').selectOption('a05'); await page.waitForTimeout(200);
      await page.locator('#gm-ss-field').selectOption('stats.health'); await page.waitForTimeout(200);
      await page.locator('#gm-ss-value').fill('55'); await page.locator('#gm-ss-value').press('Tab');
      await page.getByRole('button', { name: 'Stage stat change' }).click(); await page.waitForTimeout(900);
      log('  set_stat:', await okText(), await problems());
    },
    async reload() {
      const p = path.join(sum.run_dir, 'working', 'entities', 'agents', 'a05.json');
      const j = JSON.parse(fs.readFileSync(p, 'utf8')); j.stats.health = 77; fs.writeFileSync(p, JSON.stringify(j, null, 2));
      await page.getByRole('button', { name: 'Reload working/ files' }).click(); await page.waitForTimeout(2000);
      log('  reload:', (await page.locator('.insp-file-actions').innerText()).replace(/\n/g, ' / ').slice(0, 400).replace(/While paused[^/]*/, '[hint]'));
    },
  };
  const seq = order === 'ui-then-file' ? ['voice', 'place', 'plantRule', 'context', 'setStat', 'reload'] : ['reload', 'voice', 'place', 'plantRule', 'context', 'setStat'];
  for (const s of seq) await steps[s]();
  const staged = (await api(`/runs/${runId}/interventions`)).body.staged;
  log('  staged (API):', staged.map((x) => `${x.id}:${x.type}`).join(', '));
  const stagedUi = (await page.locator('.insp-staged-item .insp-staged-line').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').slice(0, 110));
  log('  staged (UI):'); for (const t of stagedUi) log('     ', t);
  await page.locator('.insp-staged').evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
  await shot(page, `r1-${order}-staged-${VP}`);
  // apply at the boundary
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: 'Run turn', exact: true }).click(); await page.waitForTimeout(800);
  const s = await waitIdle(runId); await page.waitForTimeout(2000);
  const tv = (await api(`/runs/${runId}/turns/${s.current_turn_id}`)).body;
  const recs = tv.turn.interventions;
  const recOrder = recs.map((r) => r.intervention.id);
  const inOrder = JSON.stringify(recOrder) === JSON.stringify(staged.map((x) => x.id));
  log('  records:', recs.map((r) => `${r.intervention.id}:${r.intervention.type}:${r.ok ? 'ok' : 'FAILED ' + r.error} [${r.changes.map((c) => `${c.path}: ${JSON.stringify(c.before)?.slice(0, 40)} -> ${JSON.stringify(c.after)?.slice(0, 40)}`).join('; ').slice(0, 260)}]`));
  log('  record order == staging order:', inOrder, recOrder.join(','));
  const kn = (await api(`/runs/${runId}/turns/${s.current_turn_id}/agents/a01/knowledge`)).body.knowledge.records;
  const voice = kn.filter((r) => r.kind === 'operator_voice').map((r) => r.text);
  const fruit33 = Object.values(tv.entities.fruits).filter((f) => f.available_compute === 33 && f.position.x === 0 && f.position.y === 0).map((f) => f.id);
  const fe = tv.rules.plant_species.fruit_tree.fruit_energy;
  const rhNow = tv.settings.context.recent_history_length;
  const eff = (await api(`/runs/${runId}/settings`)).body;
  const hp = tv.entities.agents.a05.stats.health;
  const expectHp = order === 'ui-then-file' ? 77 : 55;
  const result = {
    order, runId, turn: s.current_turn_id, allOk: recs.every((r) => r.ok), inOrder,
    voice, fruit33, fruit_energy: `${fe0} -> ${fe}`, recent_history: `${rh0} -> ${rhNow} (effective view: ${JSON.stringify(eff.run_default?.recent_history_length ?? eff.context?.recent_history_length ?? eff.settings?.context?.recent_history_length ?? null)})`,
    a05_health: hp, expected_a05_health: expectHp,
  };
  result.pass = result.allOk && inOrder && voice.length === 1 && fruit33.length === 1 && fe === fe0 + 10 && rhNow === rh0 - 2 && hp === expectHp;
  log('  RESULT', result);
  // UI: turn record section
  await page.getByRole('tab', { name: /Turn record/ }).click(); await page.waitForTimeout(1500);
  const h = page.getByRole('heading', { name: /Operator edits applied/ });
  await h.evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.evaluate(() => window.scrollBy(0, -8)); await page.waitForTimeout(300);
  const uiRecs = await page.locator('.intervention-record').evaluateAll((rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ').slice(0, 200)));
  log('  turn record (UI):'); for (const t of uiRecs) log('     ', t);
  await shot(page, `r1-${order}-turn-record-${VP}`);
  // operator log lines (activity log)
  const opLines = await page.locator('.log-line.cat-operator').evaluateAll((ls) => ls.slice(-8).map((l) => l.innerText.replace(/\n/g, ' ~ ').slice(0, 220)));
  log('  operator log lines:'); for (const l of opLines) log('     ', l);
  await browser.close();
  await api(`/runs/${runId}/close`, { method: 'POST' });
  return result;
}
const results = [];
for (const order of ['ui-then-file', 'file-then-ui']) results.push(await scenario(order));
st.r1 = results; saveState(st);
log('R1 summary', results.map((r) => `${r.order}: ${r.pass ? 'PASS' : 'FAIL'} (${r.runId})`).join(' | '));
