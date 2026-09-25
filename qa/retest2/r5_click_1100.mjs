// What the operator sees right after clicking a crowded cell at 1100x750 (single-column layout).
import { launch, shot, log, loadState, BASE, box } from './lib.mjs';
const st = loadState(); const M = st.main;
const { browser, page } = await launch('1100x750');
await page.goto(`${BASE}/#/run/${M.runId}`); await page.waitForTimeout(3500);
await page.locator('.area-map').evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
await page.locator(`rect[data-coord="${M.keyB}"]`).click(); await page.waitForTimeout(1500);
await page.mouse.move(1000, 700); await page.waitForTimeout(300);
log('1100x750 after cell click: occupant heading box', await box(page.locator('.insp-occupants .insp-panel-title')), 'first row box', await box(page.locator('.insp-occupant-row').first()), 'scrollY', await page.evaluate(() => scrollY));
await shot(page, 'o-1100x750-right-after-click');
await browser.close();
