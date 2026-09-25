import { launch, shot, log, loadState, BASE } from './lib.mjs';
const st = loadState();
for (const vp of ['1440x900', '1100x750']) {
  const { browser, page } = await launch(vp);
  await page.goto(`${BASE}/#/new`); await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const name = [...document.querySelectorAll('label')].find(l => l.textContent.trim().startsWith('Run name'));
    const inp = name?.querySelector('input') || document.querySelector('input');
    const hint = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.includes('same seed + same setup'));
    const a = inp.getBoundingClientRect(), b = hint.getBoundingClientRect();
    return { input: [a.left, a.right, a.top, a.bottom].map(Math.round), hint: [b.left, b.right, b.top, b.bottom].map(Math.round), overlapX: Math.round(a.right - b.left), overlapY: Math.round(Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)), hintClass: hint.className, inputParentW: Math.round(inp.parentElement.getBoundingClientRect().width) };
  });
  log(vp, 'run-name vs seed-hint', r);
  await page.screenshot({ path: new URL(`./shots/${vp === '1440x900' ? '' : 's-'}69-runname-seed-overlap-${vp}.png`, import.meta.url).pathname, clip: { x: 20, y: 170, width: 720, height: 110 } });
  await page.goto(`${BASE}/#/run/${st.runId}`); await page.waitForTimeout(2500);
  await page.getByRole('tab', { name: /God mode/ }).click(); await page.waitForTimeout(1200);
  const o = await page.evaluate(() => [...document.querySelectorAll('table')].filter(t => t.offsetParent).map(t => { const p = t.closest('section, .panel, .gm-quick, .insp, div'); const tr = t.getBoundingClientRect(); let q = t.parentElement; while (q && getComputedStyle(q).borderStyle === 'none') q = q.parentElement; const pr = q.getBoundingClientRect(); return { cls: t.className, right: Math.round(tr.right), boxRight: Math.round(pr.right), boxCls: q.className, over: Math.round(tr.right - pr.right) }; }).filter(x => x.over > 0));
  log(vp, 'god-mode tables overflowing their bordered container', o);
  await browser.close();
}
