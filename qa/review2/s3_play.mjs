import { launch, shot, log, loadState, saveState, api, status, stamp, sleep, BASE } from './lib.mjs';
const st = loadState(); const runId = st.runId;
const P = '2';
const { browser, page } = await launch();
log(`=== STEP 3: play one round (${runId})`);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3000);
const logPane = page.locator('section.activity-log');
const statusBar = page.locator('section.status-bar');
let s = await status(runId);
log('before', s.state, s.current_turn_id, s.next_step, s.next_agent_id, JSON.stringify(s.real_usage));
await page.getByRole('button', { name: 'Play', exact: true }).click();
const t0 = Date.now();
let lastKey = '', pauseClicked = false, viewedPending = false, shotWait = 0, errors = 0, recovered = 0;
const timeline = [];
while (Date.now() - t0 < 240000) {
  s = await status(runId);
  const key = `${s.state}|${s.active_turn_id}|${s.current_turn_id}`;
  if (key !== lastKey) {
    lastKey = key;
    timeline.push({ t: ((Date.now() - t0) / 1000).toFixed(1), state: s.state, active: s.active_turn_id, saved: s.current_turn_id, usd: s.real_usage.provider_cost_usd });
    log('  ', stamp(), s.state, 'active', s.active_turn_id, 'saved', s.current_turn_id, 'next', s.next_step, s.next_agent_id, 'usd', s.real_usage.provider_cost_usd.toFixed(4), s.last_error ? 'ERR ' + s.last_error : '');
  }
  if (s.state === 'waiting_model' && s.active_turn_id?.startsWith('r00001_t03') && shotWait === 0) {
    await page.waitForTimeout(1200);
    await shot(page, `${P}0-play-waiting-t03`);
    shotWait++;
  }
  if (s.state === 'waiting_model' && s.active_turn_id?.startsWith('r00001_t04') && !viewedPending) {
    await page.waitForTimeout(800);
    const btn = page.getByRole('button', { name: 'View request in progress' });
    if (await btn.count()) {
      await btn.click(); await page.waitForTimeout(1500);
      await shot(page, `${P}1-view-request-in-progress`);
      const rv = page.locator('section.record-viewer');
      if (await rv.count()) {
        log('  pending view text:', (await rv.innerText()).replace(/\n/g, ' | ').slice(0, 1500));
        await rv.screenshot({ path: new URL(`./shots/${P}2-pending-record-viewer.png`, import.meta.url).pathname });
      }
      viewedPending = true;
    }
  }
  if (s.state === 'error') {
    errors++;
    log('  ERROR state', s.last_error);
    await page.waitForTimeout(2000);
    await shot(page, `${P}5-error-state-${errors}`);
    await statusBar.screenshot({ path: new URL(`./shots/${P}6-error-statusbar-${errors}.png`, import.meta.url).pathname });
    await logPane.screenshot({ path: new URL(`./shots/${P}7-error-log-${errors}.png`, import.meta.url).pathname });
    log('  status bar:', (await statusBar.innerText()).replace(/\n/g, ' | '));
    const lines = await page.locator('.log-line').evaluateAll(ls => ls.slice(-6).map(l => l.innerText.replace(/\n/g, ' ~ ')));
    log('  last lines:', lines);
    if (errors > 3) break;
    await page.getByRole('button', { name: 'Recover (pause)' }).click();
    await page.waitForTimeout(2500);
    recovered++;
    await shot(page, `${P}8-after-recover-${recovered}`);
    await statusBar.screenshot({ path: new URL(`./shots/${P}9-after-recover-statusbar-${recovered}.png`, import.meta.url).pathname });
    s = await status(runId);
    log('  after recover', s.state, s.current_turn_id, s.last_error);
    if (s.current_turn_id.startsWith('r00001_t06') || s.current_turn_id === 'r00001_end') break;
    // continue playing unless the failed turn was t06
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    pauseClicked = false;
    continue;
  }
  if (!pauseClicked && s.active_turn_id && s.active_turn_id.startsWith('r00001_t06')) {
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    pauseClicked = true;
    log('  clicked Pause during', s.active_turn_id, s.state);
    await page.waitForTimeout(700);
    await shot(page, `${P}3-pause-requested`);
    await statusBar.screenshot({ path: new URL(`./shots/${P}4-pause-requested-statusbar.png`, import.meta.url).pathname });
  }
  if (s.state === 'paused' && Date.now() - t0 > 2000) break;
  await sleep(150);
}
s = await status(runId);
log('stopped at', s.state, s.current_turn_id, s.next_step);
log('timeline', JSON.stringify(timeline));
st.playTimeline = timeline; saveState(st);
await shot(page, `${P}A-paused-after-t06`);
await browser.close();
