import { launch, shot, log, loadState, BASE } from './lib.mjs';
const st = loadState(); const runId = st.mainRun; const key = st.crowded.key;
const { browser, page } = await launch('1440x900');
await page.goto(`${BASE}/#/run/${runId}`); await page.waitForTimeout(3000);
const map = page.locator('.area-map');
await map.evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(400);
const cell = page.locator(`rect[data-coord="${key}"]`);
await cell.hover(); await page.waitForTimeout(900);
log('tooltip overflow', await page.locator('.insp-tooltip').evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight, ov: getComputedStyle(e).overflow, rows: [...e.querySelectorAll('.insp-tooltip-stats')].map((r) => `${r.scrollWidth}/${r.clientWidth} ${getComputedStyle(r).whiteSpace} ${getComputedStyle(r).textOverflow}`) })));
const cb = await cell.boundingBox(); const tb = await page.locator('.insp-tooltip').boundingBox();
log('cell box', cb, 'tooltip box', tb, 'tooltip covers cell:', tb.x < cb.x + cb.width && tb.x + tb.width > cb.x && tb.y < cb.y + cb.height && tb.y + tb.height > cb.y);
await cell.click(); await page.waitForTimeout(1500);
const scrollers = await page.evaluate(() => {
  const out = [];
  const list = document.querySelector('.insp-occupant-row')?.closest('section, div');
  let n = document.querySelector('.insp-occupant-row');
  while (n && n !== document.body) { const cs = getComputedStyle(n); if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 2) out.push({ cls: String(n.className).slice(0, 60), sh: n.scrollHeight, ch: n.clientHeight, maxH: cs.maxHeight }); n = n.parentElement; }
  return out;
});
log('scroll containers above the occupant rows:', scrollers);
const rows = await page.locator('.insp-occupant-row').evaluateAll((rs) => rs.map((r) => { const b = r.getBoundingClientRect(); return `${r.innerText.split('\n')[0]} y=${Math.round(b.y)} h=${Math.round(b.height)}`; }));
log('rows', rows);
// click the seed row precisely
await page.locator('.insp-occupant-row').filter({ hasText: /^\s*S\s+s0001/ }).first().click().catch((e) => log('seed click failed', String(e).slice(0, 100)));
await page.waitForTimeout(800);
log('seed inspector head:', (await page.locator('.insp-inspector').first().innerText()).split('\n').slice(0, 3).join(' | '));
await browser.close();
