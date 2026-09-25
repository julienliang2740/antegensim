// (4) agent view filtering, (5) 'data' expandable, (6) Set stat current value / input width,
// (7) predicted next-round order names all agents; curated 10-agent-inspector.
import { launch, shot, evidence, log, loadState, saveState, api, status, BASE, box, statusText } from './lib.mjs';
const st = loadState(); const M = st.main; const runId = M.runId; const AG = M.agent;
const out = {};
const nameOf = {};
const live = (await api(`/runs/${runId}/state`)).body;
for (const a of Object.values(live.entities.agents)) nameOf[a.id] = a.name;
const s0 = await status(runId);
log(`=== R4 on ${runId} at ${s0.current_turn_id}; next_step ${s0.next_step}; next_round_order ${JSON.stringify(s0.next_round_order)}`);

for (const vp of ['1440x900', '1100x750']) {
  const { browser, page } = await launch(vp);
  await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3500);
  // ---- (7) Next step row
  const ns = await page.evaluate(() => {
    const dt = [...document.querySelectorAll('.status-fact dt')].find((e) => /next step/i.test(e.textContent));
    const dd = dt?.nextElementSibling; if (!dd) return null;
    const b = dd.getBoundingClientRect();
    return { text: dd.textContent, title: dd.getAttribute('title'), sw: dd.scrollWidth, cw: dd.clientWidth, ws: getComputedStyle(dd).whiteSpace, h: Math.round(b.height), right: Math.round(b.right) };
  });
  const allNamed = s0.next_round_order.every((id) => ns?.text.includes(id) && ns?.text.includes(nameOf[id]));
  const orderOk = s0.next_round_order.map((id) => ns.text.indexOf(id)).every((v, i, a) => i === 0 || v > a[i - 1]);
  const barH = Math.round((await page.locator('section.status-bar').boundingBox()).height);
  log(`  [${vp}] Next step: "${ns?.text}" | all ${s0.next_round_order.length} agents named: ${allNamed}, in order: ${orderOk}, clipped: ${ns.sw > ns.cw + 1}, white-space ${ns.ws}, row h ${ns.h}, status bar h ${barH}, doc overflow ${await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)}`);
  out[`next_${vp}`] = { allNamed, orderOk, clipped: ns.sw > ns.cw + 1 };
  await page.screenshot({ path: new URL(`./shots/n-${vp}-next-step.png`, import.meta.url).pathname, clip: { x: 0, y: 0, width: page.viewportSize().width, height: Math.min(page.viewportSize().height, barH + 140) } });
  // ---- select the agent at its cell
  await page.locator('.area-map').evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
  await page.locator(`rect[data-coord="${M.keyA}"]`).click(); await page.waitForTimeout(1200);
  await page.locator('.insp-occupant-row', { hasText: AG }).first().click(); await page.waitForTimeout(2000);
  // ---- (5) data expandable in Current action and result
  const sec = page.locator('.insp-inspector .insp-section', { has: page.locator('.insp-section-title', { hasText: /Current action and result/ }) }).first();
  const secFound = await sec.count();
  const secText = secFound ? (await sec.innerText()).replace(/\n/g, ' | ').slice(0, 600) : '(section not found)';
  log(`  [${vp}] Current action and result:`, secText);
  const btn = sec.getByRole('button', { name: /Show full JSON/ });
  const nBtn = await btn.count();
  log(`  [${vp}] Show full JSON buttons: ${nBtn}`, nBtn ? await btn.allInnerTexts() : '');
  if (vp === '1440x900') {
    await page.locator('.area-side').evaluate((e) => (e.scrollTop = 0));
    await page.locator('.area-inspector').evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    await evidence(page, '10-agent-inspector');
  }
  if (nBtn) {
    // the data row's button (last one in the section)
    const dataRow = sec.locator('tr', { has: page.locator('th, td', { hasText: /^data$/ }) }).first();
    const dataBtn = (await dataRow.count()) ? dataRow.getByRole('button') : btn.last();
    await dataBtn.click(); await page.waitForTimeout(500);
    const full = await sec.locator('.insp-json-full').last().evaluate((e) => ({ text: e.textContent, sw: e.scrollWidth, cw: e.clientWidth, ov: getComputedStyle(e).overflowX, h: Math.round(e.getBoundingClientRect().height) })).catch(() => null);
    const ids = M.occA.filter((id) => id !== AG);
    const hasAll = full ? ids.every((id) => full.text.includes(id)) : false;
    log(`  [${vp}] expanded data: ${full?.text.length} chars, contains all ${ids.length} co-located ids: ${hasAll}, pre ${full?.sw}/${full?.cw} overflow-x ${full?.ov}, h ${full?.h}; button now "${await dataBtn.innerText()}" aria-expanded=${await dataBtn.getAttribute('aria-expanded')}`);
    const secOverflow = await sec.evaluate((e) => { const b = e.querySelector('.insp-section-body'); return b ? `${b.scrollWidth}/${b.clientWidth}` : null; });
    log(`  [${vp}] section body scrollWidth/clientWidth ${secOverflow}`);
    await sec.evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
    await shot(page, `d-${vp}-data-expanded`);
    out[`data_${vp}`] = { hasAll, len: full?.text.length };
    await dataBtn.click(); await page.waitForTimeout(300);
    log(`  [${vp}] after Hide: full blocks ${await sec.locator('.insp-json-full').count()}, button "${await dataBtn.innerText()}"`);
  }
  // ---- (4) agent view
  await page.locator('.insp-toggle input').check(); await page.waitForTimeout(1500);
  const kv = (await api(`/runs/${runId}/agents/${AG}/knowledge`)).body;
  const obs = kv.observed_entities; const believed = kv.believed_self.position;
  const note = await page.locator('.insp-map-agentview-note').innerText().catch(() => '(no note)');
  log(`  [${vp}] agent view ON. map note: "${note.replace(/\n/g, ' ')}"`);
  log(`  [${vp}] API observed_entities (${obs.length}):`, obs.map((o) => `${o.id}@${o.position.x},${o.position.y} r${o.observed_round} ${o.source}`).join(', '), '| believed', believed);
  // marker cells in the SVG: which cells carry badges
  const badgeCells = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('rect[data-coord]')].map((r) => ({ k: r.getAttribute('data-coord'), b: r.getBoundingClientRect() }));
    const texts = [...document.querySelectorAll('.insp-map-svg text.insp-badge-text')];
    const hits = new Map();
    for (const t of texts) { const tb = t.getBoundingClientRect(); const cx = tb.left + tb.width / 2, cy = tb.top + tb.height / 2; const c = cells.find((c) => cx >= c.b.left && cx <= c.b.right && cy >= c.b.top && cy <= c.b.bottom); if (c) hits.set(c.k, [...(hits.get(c.k) || []), t.textContent]); }
    return Object.fromEntries(hits);
  });
  log(`  [${vp}] cells with badges in agent view:`, badgeCells);
  const expectedCells = new Set([...obs.map((o) => `${o.position.x},${o.position.y}`), believed ? `${believed.x},${believed.y}` : null].filter(Boolean));
  const extra = Object.keys(badgeCells).filter((k) => !expectedCells.has(k));
  log(`  [${vp}] badge cells not in the agent's knowledge: ${JSON.stringify(extra)}`);
  // hover the crowded cell B and a02's cell: nothing known there
  await page.locator('.area-map').evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
  for (const key of [M.keyB, '1,0', M.keyA]) {
    await page.locator(`rect[data-coord="${key}"]`).hover(); await page.waitForTimeout(600);
    const t = await page.locator('.insp-tooltip').innerText().catch(() => '(no tooltip)');
    log(`  [${vp}] agent-view hover ${key}: ${t.replace(/\n/g, ' | ').slice(0, 400)}`);
    if (key === M.keyA) await shot(page, `av-${vp}-hover-own-cell`);
  }
  await page.mouse.move(5, 5); await page.waitForTimeout(300);
  // occupant list in agent view (still at the agent's cell)
  const occHead = await page.locator('.insp-occupants .insp-panel-title').innerText();
  const occNote = await page.locator('.insp-occupants .insp-banner-agentview').innerText().catch(() => '(no note)');
  const occRows = await page.locator('.insp-occupant-row').evaluateAll((rs) => rs.map((r) => r.innerText.replace(/\n/g, ' ')));
  const expectedHere = obs.filter((o) => `${o.position.x},${o.position.y}` === M.keyA).map((o) => o.id).concat(believed && `${believed.x},${believed.y}` === M.keyA ? [AG] : []);
  const rowIds = occRows.map((t) => t.split(' ').find((w) => /^[a-z]+\d+$/.test(w)));
  log(`  [${vp}] agent-view list head "${occHead.replace(/\n/g, ' ')}", note "${occNote.replace(/\n/g, ' ').slice(0, 120)}"`);
  log(`  [${vp}] agent-view rows (${occRows.length}):`, occRows.map((t) => t.slice(0, 100)));
  const same = JSON.stringify([...rowIds].sort()) === JSON.stringify([...expectedHere].sort());
  const leaksValues = occRows.some((t) => /compute \d|health \d/.test(t));
  log(`  [${vp}] rows == the agent's sightings at ${M.keyA} + itself: ${same} (${rowIds.join(',')} vs ${expectedHere.join(',')}); true values shown: ${leaksValues}`);
  const removedToggle = await page.locator('text=show removed-entity markers').count();
  log(`  [${vp}] 'show removed-entity markers' control in agent view: ${removedToggle}`);
  out[`av_${vp}`] = { extraCells: extra, rowsMatch: same, leaksValues, note: /only what/.test(note) && /only what this agent has observed/.test(occNote) };
  await page.locator('.area-map').evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
  await shot(page, `av-${vp}-map-and-list`);
  // what happens when the operator clicks another cell / a sighting row while in agent view
  await page.locator('.insp-occupant-row', { hasText: 'f0013' }).first().click(); await page.waitForTimeout(1200);
  const afterRow = { note: (await page.locator('.insp-map-agentview-note').innerText().catch(() => '(none)')).replace(/\n/g, ' ').slice(0, 160), head: (await page.locator('.insp-occupants .insp-panel-title').innerText()).replace(/\n/g, ' '), inspecting: (await page.locator('.inspector-nav .hint').innerText().catch(() => '')).trim(), toggle: await page.locator('.insp-toggle').count() };
  log(`  [${vp}] after clicking sighting row f0013 in agent view:`, afterRow);
  await shot(page, `av-${vp}-after-sighting-click`);
  // back to the agent, then click an empty/other cell
  await page.locator('.area-lists').getByText(new RegExp(`^${AG} `)).first().click().catch(() => {}); await page.waitForTimeout(1200);
  log(`  [${vp}] re-selected ${AG} from the roster; note: ${(await page.locator('.insp-map-agentview-note').innerText().catch(() => '(none)')).replace(/\n/g, ' ').slice(0, 90)}`);
  await page.locator('.area-map').evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
  await page.locator(`rect[data-coord="${M.keyB}"]`).click(); await page.waitForTimeout(1200);
  const afterCell = { note: (await page.locator('.insp-map-agentview-note').innerText().catch(() => '(none)')).replace(/\n/g, ' ').slice(0, 160), head: (await page.locator('.insp-occupants .insp-panel-title').innerText()).replace(/\n/g, ' '), rows: await page.locator('.insp-occupant-row').count() };
  log(`  [${vp}] after clicking cell ${M.keyB} in agent view:`, afterCell);
  await shot(page, `av-${vp}-after-other-cell-click`);
  out[`avclick_${vp}`] = { afterRow, afterCell };
  // agent view off again
  await page.locator('.area-lists').getByText(new RegExp(`^${AG} `)).first().click().catch(() => {}); await page.waitForTimeout(1000);
  if (await page.locator('.insp-toggle input').count()) await page.locator('.insp-toggle input').uncheck().catch(() => {});
  // ---- (6) Set stat current value / input width
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('tab', { name: /God mode/ }).click(); await page.waitForTimeout(1200);
  await page.getByRole('tablist', { name: 'Intervention type' }).getByRole('tab', { name: 'Set stat', exact: true }).click(); await page.waitForTimeout(300);
  await page.locator('#gm-ss-entity').selectOption(AG); await page.waitForTimeout(200);
  await page.locator('#gm-ss-field').selectOption('stats.compute'); await page.waitForTimeout(300);
  const exact = live.entities.agents[AG].stats.compute;
  const cur = await page.locator('.insp-formrow', { hasText: 'Current value' }).innerText();
  const inp = await page.locator('#gm-ss-value').evaluate((e) => ({ value: e.value, w: Math.round(e.getBoundingClientRect().width), sw: e.scrollWidth, cw: e.clientWidth }));
  log(`  [${vp}] Set stat ${AG}.stats.compute exact ${exact}: current row "${cur.replace(/\n/g, ' | ')}"; New value input "${inp.value}" width ${inp.w}px, text fits: ${inp.sw <= inp.cw + 1}`);
  out[`setstat_${vp}`] = { exact, cur, inp };
  await page.locator('.insp-godmode .insp-tabpanel').evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
  await shot(page, `s-${vp}-set-stat`);
  await browser.close();
}
st.r4 = out; saveState(st);
log('R4 done', JSON.stringify(out).slice(0, 1500));
