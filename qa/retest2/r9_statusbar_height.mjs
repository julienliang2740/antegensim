// Status bar height at a round boundary (Next step lists every agent, wraps) vs mid-round, both viewports.
import { launch, shot, log, loadState, api, waitIdle, BASE } from './lib.mjs';
const st = loadState(); const runId = st.main.runId;
for (const vp of ['1440x900', '1100x750']) {
  const { browser, page } = await launch(vp);
  await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3000);
  const measure = async () => ({ bar: Math.round((await page.locator('section.status-bar').boundingBox()).height), tabsY: Math.round((await page.getByRole('tablist', { name: 'Run views' }).boundingBox()).y), next: await page.evaluate(() => { const dt = [...document.querySelectorAll('.status-fact dt')].find((e) => /next step/i.test(e.textContent)); return dt?.nextElementSibling?.textContent.slice(0, 60); }) });
  const s0 = (await api(`/runs/${runId}/status`)).body;
  log(`=== R9 ${vp} at ${s0.current_turn_id} (${s0.next_step}):`, await measure());
  if (s0.next_step !== 'new_round') { await api(`/runs/${runId}/commands`, { method: 'POST', body: { command: 'step_round' } }); await waitIdle(runId); await page.waitForTimeout(2000); log(`  after step_round (${(await api(`/runs/${runId}/status`)).body.next_step}):`, await measure()); }
  await page.getByRole('button', { name: 'Run turn', exact: true }).click(); await page.waitForTimeout(600); await waitIdle(runId); await page.waitForTimeout(2000);
  const s1 = (await api(`/runs/${runId}/status`)).body;
  log(`  after Run turn, ${s1.current_turn_id} (${s1.next_step}):`, await measure());
  await browser.close();
}
