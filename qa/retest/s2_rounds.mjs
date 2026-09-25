import { launch, shot, log, loadState, saveState, api, status, sleep, waitIdle, statusText, BASE } from './lib.mjs';
const st = loadState(); const runId = st.mainRun;
const { browser, page } = await launch('1440x900');
log(`=== S2 run turn + step rounds on ${runId}`);
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(2500);
const barH = async () => Math.round((await page.locator('section.status-bar').boundingBox()).height * 10) / 10;
const h0 = await barH();
const tabsY0 = Math.round((await page.getByRole('tablist', { name: 'Run views' }).boundingBox()).y);
await page.getByRole('button', { name: 'Run turn', exact: true }).click();
// sample the bar height during the turn
const hs = new Set([h0]);
const t0 = Date.now();
while (Date.now() - t0 < 8000) { hs.add(await barH()); const s = await status(runId); if (s.state === 'paused' && Date.now() - t0 > 800) break; await sleep(100); }
await page.waitForTimeout(1500);
const h1 = await barH();
const tabsY1 = Math.round((await page.getByRole('tablist', { name: 'Run views' }).boundingBox()).y);
log('status bar height before/during/after first turn', h0, [...hs], h1, 'tabs y', tabsY0, '->', tabsY1);
log('status after first turn:', await statusText(page));
const lines = await page.locator('.log-line').evaluateAll((ls) => ls.map((l) => l.innerText.replace(/\n/g, ' ~ ')));
for (const l of lines) log('   ', l.slice(0, 300));
await shot(page, 'b01-after-first-turn');
// step rounds via the UI
for (let i = 0; i < 4; i++) {
  await page.getByRole('button', { name: 'Step round', exact: true }).click();
  await sleep(600);
  const s = await waitIdle(runId);
  log('step round ->', s.state, s.current_turn_id, 'next', s.next_step, JSON.stringify(s.next_round_order));
}
await page.waitForTimeout(2000);
const h2 = await barH();
log('status bar height after 4 rounds', h2);
log('status at round boundary:', await statusText(page));
await shot(page, 'b02-after-rounds');
// Run turn once more so the live turn is inside round 6
await page.getByRole('button', { name: 'Run turn', exact: true }).click(); await sleep(500); await waitIdle(runId); await page.waitForTimeout(1500);
log('status mid-round:', await statusText(page));
log('bar height mid-round', await barH());
st.afterRounds = (await status(runId)).current_turn_id; saveState(st);
await browser.close();
