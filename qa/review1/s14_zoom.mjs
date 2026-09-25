import { launch, shot, log, loadState, BASE } from './lib.mjs';
const st = loadState();
const { browser, page } = await launch();
await page.goto(`${BASE}/#/run/${st.runId}`); await page.waitForTimeout(2500);
for (let i = 0; i < 3; i++) { await page.getByRole('button', { name: /Zoom in/ }).click(); await page.waitForTimeout(300); }
await page.evaluate(() => window.scrollTo(0, 420)); await page.waitForTimeout(400);
await shot(page, '78-map-zoomed-in');
const labels = await page.locator('svg[role=img] text').allInnerTexts();
log('map text labels after zoom-in (sample)', [...new Set(labels)].slice(0, 30));
await browser.close();
