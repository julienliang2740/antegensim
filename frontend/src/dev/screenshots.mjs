// Screenshots of the inspect harness for self-checking (not part of the app build).
// Usage: start the dev server (npx vite --port 5199 --strictPort), then
//   node src/dev/screenshots.mjs [baseUrl]
// Writes PNGs to frontend/dev-screenshots/.  Requires the playwright dev dependency.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "dev-screenshots");
mkdirSync(outDir, { recursive: true });
const base = process.argv[2] ?? "http://localhost:5199/";
const shot = (name) => join(outDir, name);

const browser = await chromium.launch();
const errors = [];

async function openPage(colorScheme = "light", query = "") {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme });
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(`${base}?harness=1${query}`);
  await page.waitForSelector(".insp-map-svg");
  return page;
}

const page = await openPage();
await page.screenshot({ path: shot("01-overview.png") });

// Map: hover the crowded cell (0,0), then click it (occupant list fills), keep hovering.
const origin = page.locator('[data-cell="0,0"]');
await origin.hover();
await page.waitForSelector(".insp-tooltip");
await page.locator("#harness-map").screenshot({ path: shot("02-map-crowded-hover.png") });
await origin.click();
await origin.hover();
await page.locator("#harness-map").screenshot({ path: shot("03-map-crowded-clicked.png") });

// Inspector: agent a01 from the occupant list.
await page.locator(".insp-occupant-row", { hasText: "a01" }).first().click();
await page.locator("#harness-inspector").screenshot({ path: shot("04-inspector-agent.png") });
await page.locator(".insp-toggle input").check();
await page.locator("#harness-inspector").screenshot({ path: shot("05-inspector-agentview.png") });
await page.locator(".insp-toggle input").uncheck();

// Plant p0001 (instance vs species).
await page.locator(".insp-occupant-row", { hasText: "p0001" }).first().click();
await page.locator("#harness-inspector").screenshot({ path: shot("06-inspector-plant.png") });

// Dead agent a05 (after death).
await page.locator(".insp-occupant-row", { hasText: "a05" }).first().click();
await page.locator("#harness-inspector").screenshot({ path: shot("07-inspector-dead-agent.png") });

// God mode: set stat form, then voice with a local problem, then place on a mountain (backend problem).
const god = page.locator("#harness-godmode");
await god.screenshot({ path: shot("08-godmode-setstat.png") });
await god.locator(".insp-tab", { hasText: "Voice" }).click();
await god.locator("button[type=submit]").click();
await god.screenshot({ path: shot("09-godmode-voice-problem.png") });
await god.locator(".insp-tab", { hasText: "Place entity" }).click();
await god.locator("#gm-pe-name").fill("Nova");
await god.locator("#gm-pe-pos-x").fill("-6");
await god.locator("#gm-pe-pos-y").fill("6");
await god.locator("button[type=submit]").click();
await god.locator(".insp-problems").waitFor();
await god.screenshot({ path: shot("10-godmode-place-backend-problem.png") });
await god.locator(".insp-tab", { hasText: "Context settings" }).click();
await god.locator("#gm-cs-scope").selectOption("a03");
await god.screenshot({ path: shot("11-godmode-context-agent.png") });
await god.locator(".insp-tab", { hasText: "Plant rules" }).click();
await god.screenshot({ path: shot("12-godmode-plant-rules.png") });
await god.locator(".insp-tab", { hasText: "Model assignment" }).click();
await god.locator("#gm-ma-model").selectOption("small-context");
await god.screenshot({ path: shot("13-godmode-model-assignment.png") });

// History: select a08 in live, switch to the round-1 turn -> before birth.
await page.close();
const hist = await openPage("light", "&entity=a08&point=6,-5&turn=history");
await hist.locator("#harness-inspector").screenshot({ path: shot("14-inspector-before-birth.png") });
await hist.close();

// Dark scheme map + inspector.
const dark = await openPage("dark", "&point=0,0&entity=a01");
await dark.locator('[data-cell="0,0"]').hover();
await dark.screenshot({ path: shot("15-dark-overview.png") });
await dark.close();

// Zoomed out map (single count badges) and zoomed in (agent ids).
const zoom = await openPage("light", "&point=0,0");
for (let i = 0; i < 3; i++) await zoom.locator("button", { hasText: "Zoom out" }).click();
await zoom.locator("#harness-map").screenshot({ path: shot("16-map-zoomed-out.png") });
for (let i = 0; i < 6; i++) await zoom.locator("button", { hasText: "Zoom in" }).click();
await zoom.locator("#harness-map").screenshot({ path: shot("17-map-zoomed-in.png") });
await zoom.close();

await browser.close();
console.log(`screenshots written to ${outDir}`);
if (errors.length) {
  console.log("console errors/warnings:");
  for (const e of errors) console.log("  " + e);
} else {
  console.log("no console errors or warnings");
}
