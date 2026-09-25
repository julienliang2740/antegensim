import { launch, shot, log, loadState, saveState, api, sleep, BASE } from './lib.mjs';
const st = loadState(); const runId = st.runId;
const { browser, page } = await launch();
log('=== STEP 3: run controls on', runId);
await page.goto(`${BASE}/#/run/${runId}`);
await page.waitForTimeout(2000);
const badge = () => page.locator('.state-badge').first().innerText().catch(()=> '?');
const statusText = async () => (await page.getByRole('region', { name: 'Run status' }).innerText().catch(()=>'')).replace(/\n+/g,' | ');
const logText = async () => (await page.getByRole('region', { name: 'Live activity log' }).innerText().catch(()=>''));
log('initial badge', await badge());
log('initial status', await statusText());
// help
await page.getByLabel('Help: what the run buttons do').click();
await page.waitForTimeout(300);
await shot(page, '10-controls-help-open');
await page.getByLabel('Help: what the run buttons do').click();
// tooltips on buttons
for (const n of ['Run turn','Play','Pause','Step round']) {
  const b = page.getByRole('button', { name: n, exact: true });
  log(`button ${n}: disabled=${await b.isDisabled()} title=${await b.getAttribute('title')}`);
}
// Run turn
const before = (await api(`/runs/${runId}/status`)).body;
log('api before run turn', before.state, before.current_turn_id);
await page.getByRole('button', { name: 'Run turn', exact: true }).click();
const samples = [];
for (let i=0;i<30;i++){ samples.push(await badge()); await sleep(100); }
log('badge samples after Run turn', [...new Set(samples)]);
await page.waitForTimeout(1500);
const after = (await api(`/runs/${runId}/status`)).body;
log('api after run turn', after.state, after.current_turn_id, 'latest_seq', after.latest_seq);
log('status after run turn', await statusText());
const lt = await logText();
log('log after run turn (tail)', lt.split('\n').slice(-14).join(' / '));
await shot(page, '11-after-run-turn');
// Play ~10 s
await page.getByRole('button', { name: 'Play', exact: true }).click();
const playSamples = [];
const t0 = Date.now();
while (Date.now()-t0 < 10000) { playSamples.push(await badge()); await sleep(150); }
log('badge samples during play', [...new Set(playSamples)]);
await shot(page, '12-during-play');
const pauseBtn = page.getByRole('button', { name: 'Pause', exact: true });
log('pause enabled during play', !(await pauseBtn.isDisabled()));
await pauseBtn.click();
const ps = [];
const t1 = Date.now();
let shotTaken = false;
while (Date.now()-t1 < 4000) { const b = await badge(); ps.push(`${Date.now()-t1}ms:${b}`); if (!shotTaken && /request/i.test(b)) { await shot(page, '13-pause-requested'); shotTaken = true; } await sleep(40); }
const seq = []; for (const s of ps) { const v = s.split(':')[1]; if (seq[seq.length-1] !== v) seq.push(v); }
log('badge sequence after Pause click', seq, 'first samples', ps.slice(0,6));
await shot(page, '14-after-pause');
const ap = (await api(`/runs/${runId}/status`)).body;
log('api after pause', ap.state, ap.current_turn_id);
log('status after pause', await statusText());
// Step round
await page.getByRole('button', { name: 'Step round', exact: true }).click();
const ss=[]; const t2=Date.now();
while (Date.now()-t2 < 8000) { const b = await badge(); if (ss[ss.length-1]!==b) ss.push(b); const s=(await api(`/runs/${runId}/status`)).body; if (s.state==='paused' && Date.now()-t2>600) break; await sleep(100);} 
await page.waitForTimeout(1200);
const as = (await api(`/runs/${runId}/status`)).body;
log('badge seq step round', ss, 'api after step round', as.state, as.current_turn_id, 'next_step', as.next_step);
log('status after step round', await statusText());
await shot(page, '15-after-step-round');
await page.locator('.activity-log').screenshot({ path: new URL('./shots/16-activity-log-after-step-round.png', import.meta.url).pathname });
st.afterStepRound = as.current_turn_id; saveState(st);
await browser.close();
