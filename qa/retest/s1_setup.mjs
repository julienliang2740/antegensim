import { launch, shot, evidence, log, loadState, saveState, api, status, sleep, BASE } from './lib.mjs';
const st = loadState();
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
const RUN_NAME = `retest main ${stamp}`;
const { browser, page } = await launch('1440x900');
log(`=== S1 setup + create (${RUN_NAME})`);
await page.goto(`${BASE}/#/`); await page.waitForTimeout(1200);
log('entry buttons', await page.getByRole('button').allInnerTexts());
await evidence(page, '01-entry');
await page.getByRole('button', { name: /New session/ }).click(); await page.waitForTimeout(2000);
// cards
const cards = page.locator('section.agent-card');
log('agent cards', await cards.count(), (await cards.evaluateAll((cs) => cs.map((c) => c.getAttribute('aria-label')))).join(' ; '));
// run name vs seed hint overlap (finding: Run name input crosses the seed hint)
const overlap = async () => page.evaluate(() => {
  const label = [...document.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith('Run name'));
  const inp = label.querySelector('input');
  const hint = [...document.querySelectorAll('.hint')].find((e) => e.textContent.includes('same seed + same setup'));
  const a = inp.getBoundingClientRect(); const b = hint.getBoundingClientRect();
  return { inputLeft: Math.round(a.left), inputRight: Math.round(a.right), hintLeft: Math.round(b.left), hintRight: Math.round(b.right), inputTop: Math.round(a.top), inputBottom: Math.round(a.bottom), hintTop: Math.round(b.top), hintBottom: Math.round(b.bottom), overlaps: a.right > b.left && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) };
});
log('1440x900 run name vs seed hint', await overlap());
await shot(page, 'a01-setup-top-1440');
// the agent cards region
await page.getByRole('heading', { name: /Agent cards/ }).scrollIntoViewIfNeeded();
await page.getByRole('heading', { name: /Agent cards/ }).evaluate((e) => e.scrollIntoView({ block: 'start' }));
await page.waitForTimeout(400);
await evidence(page, '02-new-session-cards');
// world settings: new fields present?
const worldHead = page.getByRole('heading', { name: /^World$/ });
await worldHead.evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.waitForTimeout(300);
const plantsAtStarts = page.getByLabel(/plants at agent starts/i);
const initFruit = page.getByLabel(/initial fruit per plant/i);
log('world settings: plants at agent starts', await plantsAtStarts.count(), (await plantsAtStarts.count()) ? await plantsAtStarts.first().isChecked() : null,
  '| initial fruit per plant', await initFruit.count(), (await initFruit.count()) ? await initFruit.first().inputValue() : null);
await shot(page, 'a02-world-settings-fields');
// invalid value on card 1: health 999
await page.evaluate(() => window.scrollTo(0, 0));
const card1 = cards.first();
const health = card1.getByLabel(/^\s*health\s*$/i).first();
log('card1 health field found', await health.count());
await health.fill('999'); await health.press('Tab');
await page.getByRole('region', { name: 'Setup actions' }).first().getByRole('button', { name: 'Validate setup' }).click(); await page.waitForTimeout(1500);
const summary = await page.locator('.problem-summary, [class*=problem]').first().innerText().catch(() => '');
log('validation summary:', summary.replace(/\n/g, ' | ').slice(0, 400));
log('validation state:', await page.locator('.validation').first().innerText());
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200);
await evidence(page, '03-new-session-validation-problem');
// scroll to the card with the problem too
await card1.scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
await shot(page, 'a03-validation-card1');
const runsBefore = (await api('/runs')).body.length;
// fix + name + create
await health.fill('100'); await health.press('Tab');
await page.getByRole('region', { name: 'Setup actions' }).first().getByRole('button', { name: 'Validate setup' }).click(); await page.waitForTimeout(1200);
log('after fix validation state:', await page.locator('.validation').first().innerText());
await page.getByLabel('Run name').fill(RUN_NAME);
await page.getByRole('region', { name: 'Setup actions' }).first().getByRole('button', { name: 'Create and open' }).click();
await page.waitForURL(/#\/run\//, { timeout: 20000 });
await page.waitForTimeout(3000);
const runId = decodeURIComponent(page.url().split('#/run/')[1].split('?')[0]);
const s = await status(runId);
log('created', runId, 'state', s.state, s.current_turn_id, 'runs +', (await api('/runs')).body.length - runsBefore);
log('badge', await page.locator('.state-badge').first().innerText());
await evidence(page, '04-run-paused');
st.mainRun = runId; st.mainName = RUN_NAME; saveState(st);
// 1100x750 run-name overlap
await browser.close();
const b2 = await launch('1100x750');
await b2.page.goto(`${BASE}/#/new`); await b2.page.waitForTimeout(2000);
log('1100x750 run name vs seed hint', await b2.page.evaluate(() => {
  const label = [...document.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith('Run name'));
  const inp = label.querySelector('input');
  const hint = [...document.querySelectorAll('.hint')].find((e) => e.textContent.includes('same seed + same setup'));
  const a = inp.getBoundingClientRect(); const b = hint.getBoundingClientRect();
  return { inputRight: Math.round(a.right), hintLeft: Math.round(b.left), overlaps: a.right > b.left && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) };
}));
await b2.page.screenshot({ path: new URL('./shots/a04-setup-top-1100.png', import.meta.url).pathname, clip: { x: 0, y: 0, width: 1100, height: 400 } });
await b2.browser.close();
