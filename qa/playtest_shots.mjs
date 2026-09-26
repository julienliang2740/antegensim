// Screenshots of the playtest artefacts through the real UI (fake assistant keys, no spend):
// the Storybook tab with the Sonnet-written entries and the drawer showing the executed
// create-run brief card.  Backend: qa/worlds-playtest/sonnet on 8024; Vite on 5184.
//   BASE_URL=http://127.0.0.1:5184 node qa/playtest_shots.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5184";
const RUN = "run_20260926_034607_b7c5";
const OUT = path.resolve("docs/evidence/screenshots/assistant");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const notes = [];
try {
  await page.goto(`${BASE}/#/run/${RUN}`);
  await page.waitForTimeout(2500);
  const storybookTab = page.getByRole("tab", { name: /Storybook/ }).or(page.getByRole("button", { name: /^Storybook$/ }));
  await storybookTab.first().click({ timeout: 8000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "playtest-01-storybook-tab-sonnet-entries.png") });
  notes.push("storybook tab shot taken");
  const launcher = page.getByRole("button", { name: /^Assistant/ });
  await launcher.first().click({ timeout: 8000 });
  await page.waitForTimeout(1500);
  // pick the conversation of the arena brief if a picker exists
  const picker = page.locator('aside[aria-label="Assistant"] select').first();
  if (await picker.count()) {
    const options = await picker.locator("option").allTextContents();
    const idx = options.findIndex((t) => /arena|hunters|pit/i.test(t));
    if (idx >= 0) {
      await picker.selectOption({ index: idx });
      await page.waitForTimeout(1500);
      notes.push(`selected conversation: ${options[idx]}`);
    } else {
      notes.push(`no arena conversation among: ${options.join(" | ")}`);
    }
  }
  await page.screenshot({ path: path.join(OUT, "playtest-02-drawer-conversation.png") });
  notes.push("drawer shot taken");
  // The approved create_run brief rebound its conversation to the NEW run (R11): open that run.
  const NEW_RUN = process.env.NEW_RUN ?? "run_20260926_084428_44bb";
  await page.goto(`${BASE}/#/run/${NEW_RUN}`);
  await page.waitForTimeout(2500);
  const launcher2 = page.getByRole("button", { name: /^Assistant/ });
  if (!(await page.locator('aside[aria-label="Assistant"]').count())) await launcher2.first().click({ timeout: 8000 });
  await page.waitForTimeout(1500);
  const picker2 = page.locator('aside[aria-label="Assistant"] select').first();
  if (await picker2.count()) {
    const options = await picker2.locator("option").allTextContents();
    const idx = options.findIndex((t) => /arena|hunters|pit/i.test(t));
    if (idx >= 0) {
      await picker2.selectOption({ index: idx });
      await page.waitForTimeout(1500);
      notes.push(`new run: selected conversation: ${options[idx]}`);
    } else notes.push(`new run: options ${options.join(" | ")}`);
  }
  await page.screenshot({ path: path.join(OUT, "playtest-03-create-run-brief-executed-rebound.png") });
  notes.push("create-run brief shot taken");
} catch (err) {
  notes.push(`error: ${err.message}`);
  await page.screenshot({ path: path.join(OUT, "playtest-99-error.png") });
} finally {
  await browser.close();
}
console.log(notes.join("\n"));
