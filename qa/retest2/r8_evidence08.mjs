// Curated 08-crowded-cell-hover: the 7-occupant agent cell (every kind, each with its stats), no selection, default wide layout.
import { launch, evidence, log, loadState, BASE, box } from './lib.mjs';
const st = loadState(); const M = st.main;
const { browser, page } = await launch('1440x900');
await page.goto(`${BASE}/#/run/${M.runId}`); await page.waitForTimeout(3500);
await page.locator('.area-map').evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(400);
const cell = page.locator(`rect[data-coord="${M.keyA}"]`);
await cell.hover(); await page.waitForTimeout(800);
const tb = await box(page.locator('.insp-tooltip')); const cb = await box(cell);
log('=== R8 08 evidence: tooltip', tb, 'cell', cb, 'items', await page.locator('.insp-tooltip li').count(), 'window 1440x900 inside:', tb.x >= 0 && tb.r <= 1440 && tb.y >= 0 && tb.b <= 900);
await evidence(page, '08-crowded-cell-hover');
await browser.close();
