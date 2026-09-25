import { launch, shot, log, loadState, saveState, api, status, stamp, sleep, BASE } from './lib.mjs';
const st = loadState(); const runId = st.runId;
const TARGET = process.env.TARGET || 'a03';
const VOICE = 'Cyrene, a voice from nowhere: a plant grows at (5,5), up and to the right of you.';
const { browser, page } = await launch();
log(`=== STEP 5: voice to ${TARGET} (${runId})`);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3000);
const statusBar = page.locator('section.status-bar');
const logPane = page.locator('section.activity-log');
await page.getByRole('tab', { name: /God mode/ }).click(); await page.waitForTimeout(1200);
await page.locator('#qv-text').fill(VOICE);
await page.getByLabel('Chosen agents').check();
await page.waitForTimeout(300);
await page.getByRole('checkbox', { name: new RegExp(TARGET) }).first().check();
await shot(page, '50-voice-form-filled');
await page.getByRole('button', { name: 'Send voice' }).click(); await page.waitForTimeout(2000);
log('ok line:', await page.locator('.ok-line').allInnerTexts());
await shot(page, '51-voice-staged');
let s = await status(runId);
log('staged count', s.staged_intervention_count, 'state', s.state, s.current_turn_id);
const iv = await api(`/runs/${runId}/interventions`);
log('interventions', JSON.stringify(iv.body).slice(0, 600));
// run turns until TARGET has acted in round 2
let acted = false;
for (let n = 1; n <= 8 && !acted; n++) {
  s = await status(runId);
  log(`-- run_turn #${n}: from ${s.current_turn_id} next ${s.next_step} ${s.next_agent_id}`);
  await page.getByRole('button', { name: 'Run turn', exact: true }).click();
  const t0 = Date.now(); let waitedShot = false;
  while (Date.now() - t0 < 150000) {
    await sleep(200);
    s = await status(runId);
    if (s.state === 'waiting_model' && !waitedShot && s.pending_model_call?.agent_id === TARGET) {
      await page.waitForTimeout(1000);
      await shot(page, `52-waiting-${TARGET}`);
      waitedShot = true;
    }
    if ((s.state === 'paused' || s.state === 'error') && Date.now() - t0 > 1000) break;
  }
  await page.waitForTimeout(2500);
  log('   now', s.state, s.current_turn_id, 'usd', s.real_usage.provider_cost_usd.toFixed(4), s.last_error || '');
  if (s.state === 'error') {
    await shot(page, `5E-error-${n}`);
    log('   status bar:', (await statusBar.innerText()).replace(/\n/g, ' | '));
    await page.getByRole('button', { name: 'Recover (pause)' }).click(); await page.waitForTimeout(2500);
    await shot(page, `5F-recovered-${n}`);
    continue;
  }
  if (s.current_turn_id.endsWith('_' + TARGET) && s.current_turn_id.startsWith('r00002')) acted = true;
  if (!acted) {
    // after the first turn of round 2, show target's knowledge (voice should be unread)
    await logPane.screenshot({ path: new URL(`./shots/53-log-after-turn-${n}.png`, import.meta.url).pathname });
    await page.getByRole('tab', { name: /Map & inspector/ }).click(); await page.waitForTimeout(800);
    await page.getByPlaceholder(/e\.g\. a05/).fill(TARGET);
    await page.getByRole('button', { name: 'Select entity' }).click(); await page.waitForTimeout(2000);
    const rm = page.getByText(/^Received messages and voice/).first();
    await rm.evaluate(e => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
    await shot(page, `54-${TARGET}-voice-in-knowledge-before-turn`);
    const insp = await page.locator('.insp-inspector').innerText().catch(() => '');
    const i = insp.indexOf('Received messages and voice');
    log('   received section:', insp.slice(i, i + 500).replace(/\n/g, ' | '));
    await page.evaluate(() => window.scrollTo(0, 0));
  }
}
st.voiceTarget = TARGET; st.afterVoice = s.current_turn_id; saveState(st);
await logPane.screenshot({ path: new URL('./shots/55-log-after-target-turn.png', import.meta.url).pathname });
const lines = await page.locator('.log-line').evaluateAll(ls => ls.slice(-18).map(l => l.innerText.replace(/\n/g, ' ~ ')));
for (const l of lines) log('   ', l.slice(0, 400));
await shot(page, '56-after-target-turn-full');
await browser.close();
