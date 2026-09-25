import { launch, shot, evidence, log, loadState, saveState, api, status, sleep, waitIdle, statusText, BASE } from './lib.mjs';
const st = loadState();
const d = (await api('/defaults?agent_count=8')).body;
d.name = 'retest slow fake (sleep 4s)'; d.play_delay_seconds = 0.5;
for (const c of d.agents) c.fake_options = { sleep_ms: 4000 };
const cr = await api('/runs', { method: 'POST', body: d });
const runId = cr.body.run_id; st.slowRun = runId; saveState(st);
log(`=== S8 play / pending call / pause requested on ${runId} (create ${cr.status})`);
const { browser, page } = await launch('1440x900');
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3000);
const barH = async () => Math.round((await page.locator('section.status-bar').boundingBox()).height * 10) / 10;
const h0 = await barH();
await page.getByRole('button', { name: 'Play', exact: true }).click();
// wait for the first pending call
let s;
for (let i = 0; i < 100; i++) { s = await status(runId); if (s.state === 'waiting_model' && s.pending_model_call) break; await sleep(100); }
await page.waitForTimeout(1500);
log('state', s.state, 'pending', JSON.stringify(s.pending_model_call));
log('status bar:', await statusText(page));
log('bar height idle/waiting', h0, await barH());
const waitingLines = await page.locator('.log-line.log-waiting').evaluateAll((ls) => ls.map((l) => l.innerText.replace(/\n/g, ' ~ ')));
log('waiting log lines:', waitingLines);
log('controls:', (await page.getByRole('region', { name: 'Run controls' }).innerText()).replace(/\n/g, ' | '));
await evidence(page, '05-playing-pending-call');
// open the request in progress
await page.getByRole('button', { name: 'View request in progress' }).click(); await page.waitForTimeout(1200);
const rv = page.locator('section.record-viewer');
log('pending viewer title:', await rv.getAttribute('aria-label').catch(() => null));
const pvText = await rv.innerText().catch(() => '');
log('pending viewer text:', pvText.slice(0, 1400).replace(/\n+/g, ' | '));
await rv.evaluate((e) => e.scrollIntoView({ block: 'start' })).catch(() => {});
await shot(page, 'h01-pending-call-view');
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
await page.evaluate(() => window.scrollTo(0, 0));
// wait until the next call is pending and pause during it
for (let i = 0; i < 200; i++) { s = await status(runId); if (s.state === 'waiting_model' && s.pending_model_call) { const age = (Date.now() - Date.parse(s.pending_model_call.started_at)) / 1000; if (age < 2.5) break; } await sleep(100); }
await page.getByRole('button', { name: 'Pause', exact: true }).click();
const seen = []; let shotTaken = false;
const t0 = Date.now();
while (Date.now() - t0 < 20000) {
  const badge = (await page.locator('.state-badge').first().innerText().catch(() => '')).trim();
  if (seen[seen.length - 1] !== badge) seen.push(badge);
  if (/pause requested/i.test(badge) && !shotTaken) { await page.waitForTimeout(700); log('status bar (pause requested):', await statusText(page)); log('controls:', (await page.getByRole('region', { name: 'Run controls' }).innerText()).replace(/\n/g, ' | ')); await evidence(page, '06-pause-requested'); shotTaken = true; }
  if (badge === 'Paused') break;
  await sleep(120);
}
log('badge sequence after Pause:', seen);
await page.waitForTimeout(1500);
s = await status(runId);
log('after pause', s.state, s.current_turn_id, 'play_loop', s.play_loop);
await shot(page, 'h02-paused-after-play');
const lines = await page.locator('.log-line').evaluateAll((ls) => ls.slice(-10).map((l) => l.innerText.replace(/\n/g, ' ~ ')));
for (const l of lines) log('   ', l.slice(0, 260));
await browser.close();
await api(`/runs/${runId}/close`, { method: 'POST' });
