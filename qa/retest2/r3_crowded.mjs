// (2) hover tooltip on the most crowded cell (and the agent cell) at 1440x900 and 1100x750, wide inspector on and off;
// (3) occupant list: 16-occupant cell (scroll cue, every row reachable) and 7-occupant cell (no cue needed).
import { launch, shot, evidence, log, loadState, saveState, api, BASE, box } from './lib.mjs';
const st = loadState(); const M = st.main; const runId = M.runId;
const EVID = process.env.EVID !== '0';
const results = [];

async function scrollMapIntoView(page) {
  await page.locator('.area-map').evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(400);
}
async function hoverMeasure(page, key, label) {
  const cell = page.locator(`rect[data-coord="${key}"]`);
  await cell.hover(); await page.waitForTimeout(700);
  const tip = page.locator('.insp-tooltip');
  if (!(await tip.count())) { log(`  [${label}] NO TOOLTIP at ${key}`); return { label, key, ok: false }; }
  const vw = page.viewportSize().width, vh = page.viewportSize().height;
  const tb = await box(tip), cb = await box(cell), mv = await box(page.locator('.insp-map-viewport'));
  const inner = await tip.evaluate((e) => ({ sh: e.scrollHeight, ch: e.clientHeight, sw: e.scrollWidth, cw: e.clientWidth, ov: getComputedStyle(e).overflowY,
    stats: [...e.querySelectorAll('.insp-tooltip-stats')].map((s) => ({ t: s.textContent, clipped: s.scrollWidth > s.clientWidth + 1 })),
    items: [...e.querySelectorAll('li')].map((l) => l.innerText.replace(/\n/g, ' ').slice(0, 90)), more: e.querySelector('.insp-tooltip-more')?.textContent ?? null,
    head: e.querySelector('.insp-tooltip-head')?.textContent }));
  // what is actually painted at the tooltip's corners (is it on top?)
  // the tooltip has pointer-events:none, so enable them for the probe only
  const topmost = await page.evaluate(({ x, y, r, b }) => { const t = document.querySelector('.insp-tooltip'); const layer = document.querySelector('.insp-tooltip-layer'); t.style.pointerEvents = 'auto'; if (layer) layer.style.pointerEvents = 'auto'; const out = [[x + 3, y + 3], [r - 3, y + 3], [x + 3, b - 3], [r - 3, b - 3], [(x + r) / 2, (y + b) / 2]].map(([px, py]) => { const el = document.elementFromPoint(px, py); return !!el?.closest('.insp-tooltip'); }); t.style.pointerEvents = ''; if (layer) layer.style.pointerEvents = ''; return out; }, tb);
  const inWindow = tb.x >= 0 && tb.y >= 0 && tb.r <= vw && tb.b <= vh;
  const overCell = tb.x < cb.r && tb.r > cb.x && tb.y < cb.b && tb.b > cb.y;
  const res = { label, key, vp: `${vw}x${vh}`, tooltip: tb, cell: cb, mapViewport: mv, inWindow, overCell, noInnerClip: inner.sh <= inner.ch + 1 && inner.sw <= inner.cw + 1, anyStatClipped: inner.stats.some((s) => s.clipped), onTop: topmost.every(Boolean), head: inner.head, items: inner.items.length, more: inner.more };
  res.ok = res.inWindow && !res.overCell && res.noInnerClip && !res.anyStatClipped && res.onTop && res.items > 0;
  log(`  [${label}] hover ${key}:`, res);
  log('     items:', inner.items.slice(0, 3), '…');
  results.push(res);
  return res;
}
async function wideState(page) { return (await page.locator('.inspector-width-toggle').getAttribute('aria-pressed').catch(() => null)); }

for (const vp of ['1440x900', '1100x750']) {
  const { browser, page } = await launch(vp);
  await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3500);
  log(`=== R3 ${vp} on ${runId}`);
  const layout = await page.evaluate(() => { const r = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && `${Math.round(b.left)}..${Math.round(b.right)} w${Math.round(b.width)}`; }; return { map: r('.area-map'), side: r('.area-side'), log: r('.activity-log'), docOverflow: document.documentElement.scrollWidth - innerWidth }; });
  log('  layout (no selection):', layout);
  await scrollMapIntoView(page);
  await hoverMeasure(page, M.keyB, `${vp} no-selection`);
  if (vp === '1440x900' && EVID) await evidence(page, '08-crowded-cell-hover');
  else await shot(page, `h-${vp}-no-selection-hoverB`);
  // select the agent in cell A so the width toggle is there
  await page.locator(`rect[data-coord="${M.keyA}"]`).click(); await page.waitForTimeout(1200);
  await page.locator('.insp-occupant-row', { hasText: M.agent }).first().click(); await page.waitForTimeout(1500);
  for (let pass = 0; pass < 2; pass++) {
    const wide = await wideState(page);
    const lay = await page.evaluate(() => { const r = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && `${Math.round(b.left)}..${Math.round(b.right)}`; }; return { map: r('.area-map'), viewport: r('.insp-map-viewport'), side: r('.area-side') }; });
    log(`  wide inspector aria-pressed=${wide}`, lay);
    await scrollMapIntoView(page);
    await hoverMeasure(page, M.keyB, `${vp} wide=${wide} B`);
    await shot(page, `h-${vp}-wide-${wide}-hoverB`);
    await hoverMeasure(page, M.keyA, `${vp} wide=${wide} A`);
    await shot(page, `h-${vp}-wide-${wide}-hoverA`);
    // scroll hides the tooltip
    await page.mouse.wheel(0, 60); await page.waitForTimeout(400);
    log('  tooltip after page scroll:', await page.locator('.insp-tooltip').count());
    if (!(await page.locator('.inspector-width-toggle').isVisible())) { log(`  [${vp}] width toggle hidden (single-column layout: the inspector sits under the map), so there is no wide/narrow mode to switch`); break; }
    await page.locator('.inspector-width-toggle').click(); await page.waitForTimeout(800);
  }
  // ---- (3) occupant list, 16 occupants
  await page.locator('.inspector-width-toggle').evaluate((b) => b.getAttribute('aria-pressed')).then((w) => log('  wide now', w));
  await scrollMapIntoView(page);
  await page.locator(`rect[data-coord="${M.keyB}"]`).click(); await page.waitForTimeout(1500);
  const head = await page.locator('.insp-occupants .insp-panel-title').innerText();
  const sc = page.locator('.insp-occupants-scroll');
  const scInfo = await sc.evaluate((e) => ({ sh: e.scrollHeight, ch: e.clientHeight, maxH: getComputedStyle(e).maxHeight, top: e.scrollTop }));
  const cue = page.locator('.insp-scroll-cue');
  const cueText = (await cue.count()) ? await cue.innerText() : null;
  const cueBox = await box(cue);
  const scBox = await box(sc);
  const sideBox = await box(page.locator('.area-side'));
  const vh = page.viewportSize().height;
  log(`  [${vp}] 16-cell list: head "${head.replace(/\n/g, ' ')}", scroll box`, scInfo, 'box', scBox, 'cue', cueText, cueBox, 'side column', sideBox, 'cue within window:', cueBox ? cueBox.b <= vh : null);
  const rows = page.locator('.insp-occupant-row');
  const n = await rows.count();
  const ids = await rows.evaluateAll((rs) => rs.map((r) => r.querySelector('.insp-occupant-id')?.textContent));
  const missing = M.occB.filter((id) => !ids.includes(id));
  // reach each row: scroll it into view inside the list and check visibility, then select it
  const reach = [];
  for (let i = 0; i < n; i++) {
    const r = rows.nth(i);
    await r.scrollIntoViewIfNeeded(); await page.waitForTimeout(80);
    const rb = await box(r); const sb = await box(sc);
    const visible = rb && sb && rb.y >= sb.y - 1 && rb.b <= sb.b + 1;
    reach.push(visible);
  }
  log(`  [${vp}] rows ${n}/${M.occB.length}, missing ${JSON.stringify(missing)}, every row scrolled into full view: ${reach.every(Boolean)}`);
  const atEnd = await sc.evaluate((e) => ({ top: Math.round(e.scrollTop), max: e.scrollHeight - e.clientHeight }));
  log(`  [${vp}] after reaching the last row: scroll`, atEnd, 'cue present:', await cue.count());
  // click the last row -> inspector
  await rows.nth(n - 1).click(); await page.waitForTimeout(900);
  log(`  [${vp}] last row click -> inspector head:`, (await page.locator('.insp-inspector').first().innerText().catch(() => '')).split('\n').slice(0, 2).join(' | '));
  // back to the top with the cue for the evidence shot
  await sc.evaluate((e) => (e.scrollTop = 0)); await page.waitForTimeout(400);
  log(`  [${vp}] back at top, cue:`, (await cue.count()) ? await cue.innerText() : null);
  await page.locator('.area-side').evaluate((e) => (e.scrollTop = 0)); await page.waitForTimeout(200);
  await page.locator('.insp-occupants').evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.evaluate(() => window.scrollBy(0, -8)); await page.waitForTimeout(400);
  if (vp === '1440x900' && EVID) await evidence(page, '09-crowded-cell-occupants');
  else await shot(page, `o-${vp}-16-cell-top`);
  await sc.evaluate((e) => (e.scrollTop = e.scrollHeight)); await page.waitForTimeout(400);
  await shot(page, `o-${vp}-16-cell-end`);
  // ---- 7-occupant cell
  await scrollMapIntoView(page);
  await page.locator(`rect[data-coord="${M.keyA}"]`).click(); await page.waitForTimeout(1500);
  const n7 = await rows.count();
  const sc7 = await sc.evaluate((e) => ({ sh: e.scrollHeight, ch: e.clientHeight }));
  log(`  [${vp}] 7-cell list: rows ${n7}, scroll`, sc7, 'overflows:', sc7.sh > sc7.ch + 2, 'cue:', await cue.count());
  await page.locator('.insp-occupants').evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
  await shot(page, `o-${vp}-7-cell`);
  await browser.close();
}
st.r3 = results.map((r) => ({ label: r.label, ok: r.ok, tooltip: r.tooltip, cell: r.cell, inWindow: r.inWindow, overCell: r.overCell }));
saveState(st);
log('R3 hover summary:', results.map((r) => `${r.label}: ${r.ok ? 'ok' : 'PROBLEM'}`).join(' | '));
