import { launch, shot, log, loadState, saveState, api, status, stamp, sleep, BASE } from './lib.mjs';
const st = loadState(); const runId = st.runId;
const { browser, page } = await launch();
log(`=== STEP 3b: commit round end (${runId})`);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3000);
await shot(page, '2B-paused-before-round-end');
let s = await status(runId);
log('before', s.state, s.current_turn_id, s.next_step, JSON.stringify(s.real_usage));
if (s.state === 'paused' && s.next_step === 'round_end') {
  await page.getByRole('button', { name: 'Run turn', exact: true }).click();
  for (let i = 0; i < 60; i++) { await sleep(250); s = await status(runId); if (s.state === 'paused' && s.current_turn_id === 'r00001_end') break; }
}
await page.waitForTimeout(2500);
log('after', s.state, s.current_turn_id, s.next_step, JSON.stringify(s.real_usage));
await shot(page, '2C-paused-after-r00001_end');
await page.locator('section.activity-log').screenshot({ path: new URL('./shots/2D-log-after-round-end.png', import.meta.url).pathname });
const lines = await page.locator('.log-line').evaluateAll(ls => ls.map(l => l.innerText.replace(/\n/g, ' ~ ')));
for (const l of lines) log('   ', l.slice(0, 300));
await browser.close();
