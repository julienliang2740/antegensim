import { launch, shot, log, loadState, saveState, api, status, stamp, sleep, BASE } from './lib.mjs';
const st = loadState(); const runId = st.runId;
const P = process.env.PREFIX || '1';
const { browser, page } = await launch();
log(`=== STEP 2: run turn once (${runId})`);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3000);
const before = await status(runId);
log('before', before.state, before.current_turn_id, before.next_step, before.next_agent_id);
const logPane = page.locator('section.activity-log');
const statusBar = page.locator('section.status-bar');
await page.getByRole('button', { name: 'Run turn', exact: true }).click();
const t0 = Date.now();
let sawWaiting = false, shotsWaiting = 0, states = [];
while (Date.now() - t0 < 120000) {
  const badge = (await page.locator('.state-badge').first().innerText().catch(() => '')).trim();
  if (!states.length || states[states.length - 1].badge !== badge) { states.push({ t: ((Date.now() - t0) / 1000).toFixed(1), badge }); log('  ui badge', stamp(), badge); }
  if (badge === 'Waiting for model' && shotsWaiting < 2) {
    await page.waitForTimeout(shotsWaiting === 0 ? 800 : 2500);
    await shot(page, `${P}0-waiting-full-${shotsWaiting}`);
    await statusBar.screenshot({ path: new URL(`./shots/${P}1-waiting-statusbar-${shotsWaiting}.png`, import.meta.url).pathname });
    await logPane.screenshot({ path: new URL(`./shots/${P}2-waiting-log-${shotsWaiting}.png`, import.meta.url).pathname });
    log('  status bar text:', (await statusBar.innerText()).replace(/\n/g, ' | '));
    const lastLines = await page.locator('.log-line').evaluateAll(ls => ls.slice(-4).map(l => l.innerText.replace(/\n/g, ' ~ ')));
    log('  last log lines:', lastLines);
    const ctl = await page.locator('section.run-controls').innerText();
    log('  controls:', ctl.replace(/\n/g, ' | '));
    sawWaiting = true; shotsWaiting++;
  }
  if (badge === 'Paused' || badge === 'Error') { if (Date.now() - t0 > 1500) break; }
  await page.waitForTimeout(150);
}
await page.waitForTimeout(2500);
const after = await status(runId);
log('after', JSON.stringify(after));
log('sawWaiting', sawWaiting, 'badge timeline', states);
await shot(page, `${P}3-after-full`);
await logPane.screenshot({ path: new URL(`./shots/${P}4-after-log.png`, import.meta.url).pathname });
await statusBar.screenshot({ path: new URL(`./shots/${P}5-after-statusbar.png`, import.meta.url).pathname });
const lines = await page.locator('.log-line').evaluateAll(ls => ls.map(l => l.innerText.replace(/\n/g, ' ~ ')));
log('log lines after:'); for (const l of lines) log('   ', l.slice(0, 400));
st.afterStep2 = after.current_turn_id; saveState(st);
await browser.close();
