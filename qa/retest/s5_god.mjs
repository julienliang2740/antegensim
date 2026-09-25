import fs from 'node:fs';
import path from 'node:path';
import { launch, shot, evidence, log, loadState, saveState, api, status, sleep, waitIdle, statusText, BASE } from './lib.mjs';
const st = loadState(); const runId = st.mainRun;
const VOICE = 'A voice from nowhere: ripe fruit waits at (-1,-1).';
const { browser, page } = await launch('1440x900');
log(`=== S5 god mode on ${runId}`);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3000);
await page.getByRole('tab', { name: /God mode/ }).click(); await page.waitForTimeout(1200);
const counts = async () => page.evaluate(() => {
  const dt = [...document.querySelectorAll('.status-fact dt')].find((e) => /staged edits/i.test(e.textContent));
  const tab = [...document.querySelectorAll('button[role=tab]')].find((b) => /God mode/.test(b.textContent));
  return `status=${dt?.nextElementSibling?.textContent} tab=${tab?.textContent.replace('God mode', '').trim()}`;
});
log('before voice:', await counts());
// ---- voice to chosen agents a07 + a03
await page.locator('#qv-text').fill(VOICE);
await page.getByLabel('Chosen agents').check(); await page.waitForTimeout(300);
for (const id of ['a07', 'a03']) await page.getByRole('checkbox', { name: new RegExp(`^\\s*${id}\\b`) }).first().check();
await page.getByRole('button', { name: 'Send voice' }).click();
const t0 = Date.now(); const samples = [];
while (Date.now() - t0 < 3000) { samples.push(`${Date.now() - t0}ms ${await counts()}`); await sleep(100); }
const changes = samples.filter((s, i) => i === 0 || s.split(' ').slice(1).join(' ') !== samples[i - 1].split(' ').slice(1).join(' '));
log('staged-count samples (changes only):', changes);
log('voice ok line:', await page.locator('.ok-line').allInnerTexts());
// scroll so the voice box and the status bar are both visible
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200);
await page.locator('.quick-box').first().evaluate((e) => e.scrollIntoView({ block: 'center' })); await page.waitForTimeout(300);
await evidence(page, '14-god-mode-voice');
// ---- run-default context settings: recent history length 5 -> 3
const qb = page.locator('section.quick-box', { hasText: 'Run-default context settings' });
const rh = qb.getByLabel(/recent history/i).first();
log('recent history field', await rh.count(), await rh.inputValue().catch(() => null));
await rh.fill('3'); await rh.press('Tab'); await page.waitForTimeout(300);
await qb.getByRole('button', { name: 'Stage run-default context change' }).click(); await page.waitForTimeout(1500);
log('context ok line:', await qb.locator('.ok-line').allInnerTexts());
await qb.evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
await evidence(page, '15-god-mode-context-settings');
const ctxOverflow = await page.evaluate(() => [...document.querySelectorAll('.quick-box')].map((b) => { const t = b.querySelector('table'); const br = b.getBoundingClientRect(); const tr = t?.getBoundingClientRect(); return { boxRight: Math.round(br.right), tableRight: tr && Math.round(tr.right) }; }));
log('quick-box tables vs box (1440):', ctxOverflow);
// ---- crowd a07's cell: place two fruits and a seed there (same endpoint the Place entity form uses)
const a07 = (await api(`/runs/${runId}/state`)).body.entities.agents.a07;
const pos = a07.position; st.crowdPoint = pos; saveState(st);
for (const ent of [
  { kind: 'fruit', id: '', position: pos, available_compute: 25, available_essence: 0 },
  { kind: 'fruit', id: '', position: pos, available_compute: 40, available_essence: 0 },
  { kind: 'seed', id: '', position: pos, species: 'fruit_tree', germinates_round: 99 },
]) {
  const r = await api(`/runs/${runId}/interventions`, { method: 'POST', body: { type: 'place_entity', entity: ent, origin: 'ui' } });
  log('stage place', ent.kind, r.status, JSON.stringify(r.body).slice(0, 200));
}
// placement rejection wording via the UI form: plant on water
// ---- working/ reload: edit a05 health in the working copy
const summary = (await api(`/runs/${runId}`)).body;
const wdir = path.join(summary.run_dir, 'working');
const a05Path = path.join(wdir, 'entities', 'agents', 'a05.json');
const a05 = JSON.parse(fs.readFileSync(a05Path, 'utf8'));
log('a05 health on disk before', a05.stats.health, 'BASE_TURN', fs.readFileSync(path.join(wdir, 'BASE_TURN'), 'utf8').trim());
a05.stats.health = 77; fs.writeFileSync(a05Path, JSON.stringify(a05, null, 2));
await page.reload(); await page.waitForTimeout(3000);
await page.getByRole('tab', { name: /God mode/ }).click(); await page.waitForTimeout(1200);
const folder = await page.locator('.insp-path').first().innerText();
const folderHint = await page.locator('.insp-working-dir .insp-hint').last().innerText();
log('working folder shown:', folder, '| exists on disk:', fs.existsSync(folder), '| hint:', folderHint.replace(/\n/g, ' '));
await page.getByRole('button', { name: 'Reload working/ files' }).click(); await page.waitForTimeout(2500);
const fa = page.locator('.insp-file-actions');
log('reload result:', (await fa.innerText()).replace(/\n/g, ' / ').slice(0, 900));
await fa.evaluate((e) => e.scrollIntoView({ block: 'center' })); await page.waitForTimeout(300);
await shot(page, 'e01-working-reload-changes');
// invalid reload: a02 health 500 -> error names the file
const a02Path = path.join(wdir, 'entities', 'agents', 'a02.json');
const a02orig = fs.readFileSync(a02Path, 'utf8');
const a02 = JSON.parse(a02orig); a02.stats.health = 500; fs.writeFileSync(a02Path, JSON.stringify(a02, null, 2));
await page.getByRole('button', { name: 'Reload working/ files' }).click(); await page.waitForTimeout(2500);
log('invalid reload result:', (await fa.innerText()).replace(/\n/g, ' / ').slice(0, 700));
await fa.evaluate((e) => e.scrollIntoView({ block: 'center' })); await page.waitForTimeout(300);
await shot(page, 'e02-working-reload-invalid');
fs.writeFileSync(a02Path, a02orig);
// staged list
const iv = (await api(`/runs/${runId}/interventions`)).body;
log('staged now:', iv.staged.map((x) => x.type));
const stagedList = page.locator('.insp-staged-item');
log('staged rows in UI:', (await stagedList.allInnerTexts()).map((t) => t.replace(/\n/g, ' ').slice(0, 200)));
await stagedList.first().evaluate((e) => e.scrollIntoView({ block: 'start' })).catch(() => {});
await page.waitForTimeout(300);
await shot(page, 'e03-staged-list');
log('counts now:', await counts());
// ---- apply with Run turn
await page.evaluate(() => window.scrollTo(0, 0));
await page.getByRole('button', { name: 'Run turn', exact: true }).click(); await sleep(800);
const s = await waitIdle(runId); await page.waitForTimeout(2000);
const tv = (await api(`/runs/${runId}/turns/${s.current_turn_id}`)).body;
log('applied at', s.current_turn_id, (tv.turn.interventions || []).map((r) => `${r.intervention?.type}:${r.ok}${r.error ? ':' + r.error : ''}`));
log('a05 health after', tv.entities.agents.a05.stats.health, 'context recent_history', (await api(`/runs/${runId}/settings`)).body.context?.recent_history_length);
const opLines = await page.locator('.log-line.cat-operator').evaluateAll((ls) => ls.slice(-8).map((l) => l.innerText.replace(/\n/g, ' ~ ')));
log('operator log lines:'); for (const l of opLines) log('   ', l.slice(0, 300));
await page.getByRole('tab', { name: /Turn record/ }).click(); await page.waitForTimeout(1500);
await shot(page, 'e04-turn-record-applied-edits');
await page.getByRole('heading', { name: /Operator edits applied/ }).evaluate((e) => e.scrollIntoView({ block: 'start' })).catch(() => {});
await page.waitForTimeout(300);
await shot(page, 'e05-turn-record-applied-edits-scrolled');
st.afterGod = s.current_turn_id; saveState(st);
await browser.close();
// ---- 1100x750 quick panel
const b2 = await launch('1100x750');
await b2.page.goto(`${BASE}/#/run/${runId}`); await b2.page.waitForTimeout(3000);
await b2.page.getByRole('tab', { name: /God mode/ }).click(); await b2.page.waitForTimeout(1200);
const spill = await b2.page.evaluate(() => [...document.querySelectorAll('.quick-box')].map((b) => { const t = b.querySelector('table'); const br = b.getBoundingClientRect(); const tr = t?.getBoundingClientRect(); return { boxRight: Math.round(br.right), tableRight: tr && Math.round(tr.right), boxScrolls: b.scrollWidth > b.clientWidth }; }));
const logLeft = await b2.page.evaluate(() => Math.round(document.querySelector('.activity-log')?.getBoundingClientRect().left ?? -1));
log('1100x750 quick-box tables vs box:', spill, 'log panel left', logLeft, 'doc overflow', await b2.page.evaluate(() => document.documentElement.scrollWidth - innerWidth));
await b2.page.locator('section.quick-box', { hasText: 'Run-default context settings' }).evaluate((e) => e.scrollIntoView({ block: 'start' }));
await b2.page.waitForTimeout(300);
await b2.page.screenshot({ path: new URL('./shots/e06-quick-panel-1100.png', import.meta.url).pathname });
await b2.browser.close();
