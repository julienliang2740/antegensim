import { launch, shot, log, loadState, BASE } from './lib.mjs';
const st = loadState(); const { browser, page } = await launch(process.env.VP||'1440x900');
await page.goto(`${BASE}/#/run/${st.runId}`); await page.waitForTimeout(2500);
await page.getByRole('tab', { name: 'God mode' }).click().catch(async () => page.getByText('God mode', { exact: true }).first().click());
await page.waitForTimeout(1500);
await shot(page, '37-godmode-tab', { fullPage: true });
const ctrls = await page.locator('main, .run-left').first().locator('button, input, select, textarea, [role=tab]').evaluateAll(els => els.filter(e => e.offsetParent).map(e => `${e.tagName} [${e.getAttribute('role')||''}] ${e.getAttribute('aria-label')||''} | ${(e.innerText||e.value||e.placeholder||'').slice(0,50).replace(/\n/g,' ')}`));
console.log(ctrls.join('\n'));
await browser.close();
