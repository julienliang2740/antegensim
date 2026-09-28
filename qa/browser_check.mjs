// Empyrean browser checks (QA).
//
// Walks the required browser checks of docs/INTERFACES.md section 13 and the spec's
// "Sessions and run controls" / "Display and historical inspection" / "God mode"
// sections against a running backend + Vite dev server, saving numbered screenshots and
// a JSON log of what was found to qa/out/<timestamp>/.
//
// The UI is being built by another team, so this script never assumes exact selectors:
// it looks for roles, labels, placeholders and visible text (several candidates per
// control), verifies outcomes through the backend API where possible, and records every
// step it could not complete (with the reason) instead of crashing.  Reviewers read
// log.json and the screenshots to see which controls the UI is missing or hides.
//
// Usage (from qa/):  BASE_URL=http://127.0.0.1:5173 API_URL=http://127.0.0.1:8000 node browser_check.mjs
// Env: BASE_URL, API_URL, HEADED=1 (show the browser), STEP_TIMEOUT_MS (default 8000),
//      QA_RUN_NAME (default "qa browser <timestamp>"), QA_SKIP_ERROR_STEP=1,
//      QA_ASSISTANT=auto|0|1 (assistant steps; see runAssistantSteps), QA_ONLY_ASSISTANT=1 with
//      QA_RUN_ID=<run> (assistant steps only), QA_INSECURE_HOST (default qa-insecure.test),
//      QA_ONLY_RESUME_ARCHIVE=1 (preflight plus the resume-select-archive-delete step only; it
//      creates and deletes its own runs and never calls a model),
//      QA_ONLY_MAP=1 (preflight, the steps that create the fake-model QA run and commit round 1,
//      then map-marks and map-3d; with QA_RUN_ID=<run> only preflight and the two map steps on
//      that existing run: no run is created and no turn is run).
// Exit status: 0 when every attempted step passed, 1 otherwise (the log is always written).

import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const QA_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "");
const API_URL = (process.env.API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const HEADLESS = process.env.HEADED !== "1";
const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS ?? 8000);
const RUN_WAIT_MS = 90_000;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
const RUN_NAME = process.env.QA_RUN_NAME ?? `qa browser ${STAMP}`;
const OUT_DIR = path.join(QA_DIR, "out", STAMP);
const VOICE_TEXT = `QA browser voice ${STAMP}`;
const ASSISTANT_MODE = process.env.QA_ASSISTANT ?? "auto"; // auto | 0 | 1 (see runAssistantSteps)
const INSECURE_HOST = process.env.QA_INSECURE_HOST ?? "qa-insecure.test";
// QA_ONLY_MAP=1: only these steps run (the others are left out of the log, not skipped).
const ONLY_MAP = process.env.QA_ONLY_MAP === "1";
const MAP_ONLY_STEPS = new Set(["preflight", "entry", "new-session-cards", "create-run", "run-turn", "step-round", "map-marks", "map-3d"]);

const log = {
  base_url: BASE_URL,
  api_url: API_URL,
  run_name: RUN_NAME,
  started_at: new Date().toISOString(),
  finished_at: null,
  run_id: null,
  error_run_id: null,
  console_errors: [],
  page_errors: [],
  steps: [],
  summary: null,
};
const state = { runId: null, errorRunId: null, defaults: null, editedName: null, editedX: null };
let stepCounter = 0;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (n) => String(n).padStart(2, "0");
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function api(method, route, body) {
  const response = await fetch(`${API_URL}/api${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const error = new Error(`${method} ${route} -> ${response.status}: ${text.slice(0, 300)}`);
    error.status = response.status;
    error.body = json;
    throw error;
  }
  return json;
}

async function waitApi(what, fetcher, predicate, timeout = RUN_WAIT_MS) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fetcher();
      if (predicate(last)) return last;
    } catch (error) {
      last = { error: String(error.message ?? error) };
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)?.slice(0, 300)}`);
}

async function status(runId) {
  return api("GET", `/runs/${runId}/status`);
}

async function waitIdle(runId, timeout = RUN_WAIT_MS) {
  return waitApi(
    `run ${runId} to be idle`,
    () => status(runId),
    (s) => ["paused", "error", "finished"].includes(s.state) && !s.active_command && !s.play_loop,
    timeout,
  );
}

/** Write log.json atomically (temp file + rename) so an interrupted run never leaves half a file. */
async function writeLog() {
  const target = path.join(OUT_DIR, "log.json");
  await fs.writeFile(`${target}.tmp`, JSON.stringify(log, null, 2));
  await fs.rename(`${target}.tmp`, target);
}

async function bodyText(page) {
  return page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
}

// ---------------------------------------------------------------------------
// Locating controls without fixed selectors
// ---------------------------------------------------------------------------

/** Candidates for something clickable named by `re` (buttons first, then links, tabs, text). */
function clickables(scope, re) {
  return [
    [`button ${re}`, scope.getByRole("button", { name: re })],
    [`link ${re}`, scope.getByRole("link", { name: re })],
    [`tab ${re}`, scope.getByRole("tab", { name: re })],
    [`menuitem ${re}`, scope.getByRole("menuitem", { name: re })],
    [`radio ${re}`, scope.getByRole("radio", { name: re })],
    [`title ${re}`, scope.getByTitle(re)],
    [`text ${re}`, scope.getByText(re)],
  ];
}

/** Candidates for an input/select named by `re` (label, placeholder, accessible name). */
function fields(scope, re) {
  return [
    [`label ${re}`, scope.getByLabel(re)],
    [`placeholder ${re}`, scope.getByPlaceholder(re)],
    [`textbox ${re}`, scope.getByRole("textbox", { name: re })],
    [`spinbutton ${re}`, scope.getByRole("spinbutton", { name: re })],
    [`combobox ${re}`, scope.getByRole("combobox", { name: re })],
  ];
}

/** First candidate with a visible element, polling until `timeout`.  Returns {how, locator} or null. */
async function findOne(candidates, timeout = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  do {
    for (const [how, locator] of candidates) {
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 5); i += 1) {
        const item = locator.nth(i);
        if (await item.isVisible().catch(() => false)) return { how, locator: item };
      }
    }
    await sleep(200);
  } while (Date.now() < deadline);
  return null;
}

async function mustFind(rec, what, candidates, timeout) {
  const found = await findOne(candidates, timeout);
  if (!found) throw new Error(`could not find ${what} (tried: ${candidates.map(([how]) => how).join("; ")})`);
  rec.found[what] = found.how;
  return found.locator;
}

async function tryFind(rec, what, candidates, timeout = 2500) {
  const found = await findOne(candidates, timeout);
  rec.found[what] = found ? found.how : null;
  if (!found) rec.notes.push(`not found: ${what}`);
  return found ? found.locator : null;
}

async function textVisible(page, re, timeout = STEP_TIMEOUT_MS) {
  return (await findOne([[`text ${re}`, page.getByText(re)]], timeout)) !== null;
}

async function fillField(locator, value) {
  await locator.click({ timeout: 3000 }).catch(() => {});
  await locator.fill(String(value));
  await locator.press("Tab").catch(() => {});
}

/** The index of the first <input>/<textarea> whose current value equals `value`. */
async function inputIndexWithValue(page, value) {
  return page.evaluate((wanted) => {
    const inputs = [...document.querySelectorAll("input, textarea")];
    return inputs.findIndex((el) => el.value === wanted);
  }, value);
}

/** Mark the smallest ancestor of input #index that contains at least `minInputs` inputs
 * (an agent card) with data-qa-card, so later lookups can be scoped to it. */
async function markCard(page, inputIndex, marker, minInputs = 4) {
  return page.evaluate(
    ({ inputIndex, marker, minInputs }) => {
      const input = document.querySelectorAll("input, textarea")[inputIndex];
      let node = input?.parentElement;
      while (node && node.querySelectorAll("input, textarea, select").length < minInputs) node = node.parentElement;
      if (!node) return false;
      node.setAttribute("data-qa-card", marker);
      return true;
    },
    { inputIndex, marker, minInputs },
  );
}

/** Every run this script creates uses this free, deterministic agent model (the shipped default is a real one). */
const QA_AGENT_MODEL = "fake-heuristic";

/** A GET /defaults request with every agent on QA_AGENT_MODEL. */
function withFakeModels(request) {
  request.default_model_key = QA_AGENT_MODEL;
  for (const card of request.agents ?? []) card.model_key = null;
  return request;
}

/** Select fake-heuristic in the New session form's default-model picker (its option text starts with "fake-heuristic"). */
async function pickFakeDefaultModel(page, rec) {
  const select = page.locator("#setup-default-model");
  const label = (await select.locator("option").allTextContents()).find((t) => t.trim().startsWith(QA_AGENT_MODEL));
  if (!label) throw new Error(`no "${QA_AGENT_MODEL}" option in the default model picker`);
  await select.selectOption({ label });
  rec.found.default_model = await select.inputValue();
  if (rec.found.default_model !== QA_AGENT_MODEL) throw new Error(`the default model picker holds ${rec.found.default_model}, expected ${QA_AGENT_MODEL}`);
}

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

async function step(page, id, title, fn, { needs = [] } = {}) {
  if (ONLY_MAP && !MAP_ONLY_STEPS.has(id)) return null;
  stepCounter += 1;
  const rec = { n: stepCounter, id, title, ok: null, skipped: null, notes: [], found: {}, error: null, screenshot: null, ms: 0 };
  const started = Date.now();
  const missing = needs.filter((key) => !state[key]);
  if (missing.length) {
    rec.skipped = `needs ${missing.join(", ")} from an earlier step`;
  } else {
    try {
      if (["timeline", "map-marks", "map-3d"].includes(id)) {
        await closeProfileCard(page);
        const openPanel = page.locator('.workspace-tools button[id^="workspace-toggle-"][aria-expanded="true"]');
        if (await openPanel.count()) await openPanel.click();
      }
      const panels = { "run-turn": "Activity log", "agent-inspector": "Inspector & tools", "plant-rules": "Inspector & tools", "god-mode": "Inspector & tools" };
      if (panels[id]) await openWorkspacePanel(page, panels[id]);
      await fn(rec);
      rec.ok = true;
    } catch (error) {
      rec.ok = false;
      rec.error = String(error?.message ?? error).slice(0, 1200);
    }
  }
  rec.ms = Date.now() - started;
  const shot = `${pad(rec.n)}-${id}.png`;
  try {
    await page.screenshot({ path: path.join(OUT_DIR, shot) });
    rec.screenshot = shot;
  } catch (error) {
    rec.notes.push(`screenshot failed: ${error.message}`);
  }
  log.steps.push(rec);
  const verdict = rec.skipped ? "SKIP" : rec.ok ? "PASS" : "FAIL";
  console.log(`${pad(rec.n)} ${verdict.padEnd(4)} ${id}: ${title}${rec.error ? `\n      ${rec.error}` : ""}${rec.skipped ? ` (${rec.skipped})` : ""}`);
  await writeLog();
  return rec.ok;
}

// ---------------------------------------------------------------------------
// Shared UI actions
// ---------------------------------------------------------------------------

const RE = {
  newSession: /new session/i,
  resumeSession: /resume session/i,
  runTurn: /^advance 1 turn$/i,
  play: /^start simulation$/i,
  pause: /^pause simulation$/i,
  stepRound: /^finish round$/i,
  create: /create( run| session)?|start( run| session| simulation)?|launch|begin/i,
  validate: /validate|check setup/i,
  previous: /^(?!.*\bpan\b).*(previous|prev\b|earlier|◀|←|‹)/i,
  next: /^(?!.*\bpan\b).*(\bnext\b|later|▶|→|›)/i,
  live: /return to live|back to live|go live|^live$|live view/i,
  godMode: /god mode/i,
  back: /back to (sessions|start|entry)|sessions|leave|exit|close run|home|entry/i,
  recover: /recover|pause/i,
};

async function openWorkspacePanel(page, name) {
  const ids = { "Session & agents": "session", "Inspector & tools": "inspect", "Activity log": "activity" };
  const button = ids[name] ? page.locator(`#workspace-toggle-${ids[name]}`) : page.getByRole("button", { name, exact: true });
  if (await button.isVisible().catch(() => false) && await button.getAttribute("aria-expanded") !== "true") await button.click();
}

async function clickRunControl(page, rec, what, re) {
  const control = await mustFind(rec, what, [[`button ${re}`, page.getByRole("button", { name: re })]]);
  await control.click();
  return control;
}

async function selectAgentOrEntity(page, rec, entityId) {
  // Prefer a visible button/list item naming the id; else the "Go to"/search box.
  const direct = await findOne(
    [
      [`button ${entityId}`, page.getByRole("button", { name: new RegExp(`\\b${escapeRe(entityId)}\\b`) })],
      [`listitem ${entityId}`, page.getByRole("listitem").filter({ hasText: new RegExp(`\\b${escapeRe(entityId)}\\b`) })],
      [`row ${entityId}`, page.getByRole("row").filter({ hasText: new RegExp(`\\b${escapeRe(entityId)}\\b`) })],
    ],
    1500,
  );
  if (direct) {
    await direct.locator.click();
    rec.notes.push(`selected ${entityId} via ${direct.how}`);
    return true;
  }
  const box = await findOne([["Find entity by id", page.getByLabel("Find entity by id", { exact: true })], ...fields(page, /search|find|lookup|entity id|e\.g\. a05/i)], 1500);
  if (box) {
    await box.locator.fill(entityId);
    await box.locator.press("Enter");
    rec.notes.push(`selected ${entityId} via ${box.how} + Enter`);
    return true;
  }
  return false;
}

/** The entity profile card (opened by clicking an entity), or a locator that matches nothing. */
function profileCard(page) {
  return page.locator(".profile-card");
}

/** Close the profile card with its × when it is open (its backdrop covers the page). */
async function closeProfileCard(page) {
  const card = profileCard(page);
  if (!(await card.isVisible().catch(() => false))) return false;
  await card.getByRole("button", { name: "Close profile" }).click();
  await card.waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  console.log(`Empyrean browser check -> ${OUT_DIR}\n  UI ${BASE_URL}\n  API ${API_URL}`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") log.console_errors.push(message.text().slice(0, 500));
  });
  page.on("pageerror", (error) => log.page_errors.push(String(error.message).slice(0, 500)));

  try {
    await runSteps(page);
  } finally {
    log.finished_at = new Date().toISOString();
    const attempted = log.steps.filter((s) => !s.skipped);
    log.summary = {
      passed: attempted.filter((s) => s.ok).length,
      failed: attempted.filter((s) => !s.ok).length,
      skipped: log.steps.length - attempted.length,
      failed_steps: attempted.filter((s) => !s.ok).map((s) => s.id),
    };
    await writeLog();
    await browser.close();
  }
  console.log(`\n${log.summary.passed} passed, ${log.summary.failed} failed, ${log.summary.skipped} skipped; log ${path.join(OUT_DIR, "log.json")}`);
  return log.summary.failed === 0 ? 0 : 1;
}

async function runSteps(page) {
  if (process.env.QA_ONLY_PROFILE === "1" && process.env.QA_RUN_ID) {
    state.runId = process.env.QA_RUN_ID;
    log.run_id = state.runId;
    await runProfileCardStep(page);
    return;
  }
  if (process.env.QA_ONLY_RESUME_ARCHIVE === "1") {
    await step(page, "preflight", "Backend health and defaults reachable", async () => {
      await api("GET", "/health");
      state.defaults = await api("GET", "/defaults?agent_count=6");
    });
    await runResumeArchiveStep(page);
    return;
  }
  if (ONLY_MAP && process.env.QA_RUN_ID) {
    // The two map steps on an existing run: viewing it opens it paused and never runs a turn or calls a model.
    await step(page, "preflight", "Backend health and defaults reachable", async () => {
      await api("GET", "/health");
      state.defaults = await api("GET", "/defaults?agent_count=6");
    });
    state.runId = process.env.QA_RUN_ID;
    log.run_id = state.runId;
    await runMapMarksStep(page);
    await runMap3dStep(page);
    return;
  }
  if (process.env.QA_ONLY_ASSISTANT === "1") {
    // Iterate on the assistant steps against an existing run with committed model turns.
    state.runId = process.env.QA_RUN_ID ?? null;
    log.run_id = state.runId;
    await runAssistantSteps(page);
    return;
  }
  await step(page, "preflight", "Backend health and defaults reachable", async (rec) => {
    const health = await api("GET", "/health");
    rec.notes.push(`health ${JSON.stringify(health)}`);
    state.defaults = await api("GET", "/defaults?agent_count=8");
    rec.found.default_names = state.defaults.agents.map((a) => a.name);
  });

  await step(page, "entry", "Entry page shows New session and Resume session (U10)", async (rec) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await mustFind(rec, "New session", clickables(page, RE.newSession));
    await mustFind(rec, "Resume session", clickables(page, RE.resumeSession));
  });

  await step(
    page,
    "new-session-cards",
    "New session shows 8 prefilled agent cards (U11)",
    async (rec) => {
      const entry = await mustFind(rec, "New session", clickables(page, RE.newSession));
      await entry.click();
      const names = state.defaults.agents.map((a) => a.name);
      const shown = await waitApi(
        "8 default card names on screen",
        () =>
          page.evaluate((wanted) => {
            const values = [...document.querySelectorAll("input, textarea")].map((el) => el.value);
            const text = document.body.innerText;
            return wanted.filter((n) => values.includes(n) || text.includes(n));
          }, names),
        (found) => found.length === names.length,
        STEP_TIMEOUT_MS,
      ).catch(async () =>
        page.evaluate((wanted) => {
          const values = [...document.querySelectorAll("input, textarea")].map((el) => el.value);
          return wanted.filter((n) => values.includes(n) || document.body.innerText.includes(n));
        }, names),
      );
      rec.found.card_names = shown;
      if (shown.length !== names.length) throw new Error(`expected ${names.length} default cards, found names ${JSON.stringify(shown)}`);
      await tryFind(rec, "add card control", clickables(page, /add (agent|card)|\+ ?agent|new card/i));
      await tryFind(rec, "remove card control", clickables(page, /remove|delete/i));
      await tryFind(rec, "context settings in setup (U16)", fields(page, /input token cap|token cap|generation allowance/i));
      // The persona tip switch (A-KNOW-9): present in the Agents section and on by default.
      const tipOn = await page.evaluate(() => {
        const label = [...document.querySelectorAll("label")].find((l) => /add the tip to every persona/i.test(l.textContent || ""));
        const box = label ? label.querySelector('input[type="checkbox"]') : null;
        return box ? box.checked : null;
      });
      rec.found.persona_tip_default_on = tipOn;
      if (tipOn !== true) throw new Error(`"Add the tip to every persona" should be present and on by default (got ${tipOn})`);
      await tryFind(rec, "model choice in setup", fields(page, /model/i));
      // The browser check always creates fake-model runs (the operator default is claude-cli-haiku):
      // pick fake-heuristic as the default model before any validation or creation.
      await pickFakeDefaultModel(page, rec);
    },
    { needs: ["defaults"] },
  );

  await step(
    page,
    "edit-card",
    "Edit the first card's name and starting coordinate",
    async (rec) => {
      const firstName = state.defaults.agents[0].name;
      let index = await inputIndexWithValue(page, firstName);
      if (index < 0) {
        // The New session page lists agents in a table; "Edit…" (aria-label "Edit agent <id> <name>") opens the full card in a dialog.
        const edit = await tryFind(rec, "open the first agent card", clickables(page, new RegExp(`edit\\b.*\\b${escapeRe(firstName)}\\b`, "i")));
        if (edit) {
          await edit.click();
          await sleep(300);
          index = await inputIndexWithValue(page, firstName);
        }
      }
      if (index < 0) throw new Error(`no input holds the first card name '${firstName}'`);
      const nameInput = page.locator("input, textarea").nth(index);
      state.editedName = `${firstName} QA`;
      await fillField(nameInput, state.editedName);
      rec.found["card name input"] = `input #${index} (value '${firstName}')`;
      await markCard(page, index, "first");
      const card = page.locator('[data-qa-card="first"]');
      const xField = await tryFind(rec, "card x coordinate", [
        ...fields(card, /^\s*x\s*:?\s*$/i),
        ...fields(card, /\bx\b|position x|x coordinate|start x/i),
      ]);
      if (!xField) throw new Error("could not find the starting x coordinate field in the first card");
      state.editedX = 3;
      await fillField(xField, state.editedX);
    },
    { needs: ["defaults"] },
  );

  await step(
    page,
    "invalid-value",
    "An invalid card value shows a problem by path, then is fixed",
    async (rec) => {
      const card = page.locator('[data-qa-card="first"]');
      let invalidField = await tryFind(rec, "card health field", fields(card, /^\s*health\s*:?\s*$/i));
      let invalidValue = 999; // above max_health 100 -> agents[0].stats.health
      let fixValue = 100;
      let expectPath = /agents\[0\]\.stats\.health|agents\[0\].*health|health/i;
      if (!invalidField) {
        invalidField = await tryFind(rec, "card x coordinate (fallback)", fields(card, /^\s*x\s*:?\s*$/i));
        invalidValue = 999; // outside the region -> agents[0].position
        fixValue = state.editedX;
        expectPath = /agents\[0\]\.position|agents\[0\].*position|outside/i;
      }
      if (!invalidField) throw new Error("no numeric card field found to make invalid");
      await fillField(invalidField, invalidValue);
      // With the card open in a modal dialog, only the dialog's own Validate button is clickable.
      const dialog = page.getByRole("dialog");
      const validateScope = (await dialog.count()) > 0 ? dialog : page;
      const validate = await findOne(clickables(validateScope, RE.validate), 1500);
      if (validate) {
        await validate.locator.click();
        rec.found.validate = validate.how;
      } else {
        const create = await mustFind(rec, "create button (used to trigger validation)", clickables(page, RE.create));
        await create.click();
      }
      const shown = await textVisible(page, expectPath, STEP_TIMEOUT_MS);
      const byPath = await textVisible(page, /agents\[0\]/, 1000);
      rec.found.problem_shown = shown;
      rec.found.problem_shown_with_path = byPath;
      if (!shown) throw new Error(`no problem shown for the invalid value (${expectPath})`);
      if (!byPath) rec.notes.push("the problem is shown but not with its path agents[0]...");
      const runs = await api("GET", "/runs");
      if (runs.some((r) => r.name === RUN_NAME)) throw new Error("an invalid setup created a run");
      await fillField(invalidField, fixValue);
      if (validate) {
        await validate.locator.click();
        await sleep(800);
        if (await textVisible(page, /agents\[0\]\.stats\.health|agents\[0\]\.position/, 1000)) {
          throw new Error("the problem is still shown after fixing the value");
        }
      }
      // Close the card dialog (if any) so the rest of the page is usable again.
      if ((await page.getByRole("dialog").count()) > 0) {
        const done = await findOne([["button Done", page.getByRole("dialog").getByRole("button", { name: /^done$/i })]], 1500);
        if (done) await done.locator.click();
      }
    },
    { needs: ["defaults"] },
  );

  await step(
    page,
    "create-run",
    "Create the run; it opens paused with a status line (U12, U14)",
    async (rec) => {
      const runName = await tryFind(rec, "run name field", fields(page, /run name|session name|^name of the run/i), 1500);
      if (runName) await fillField(runName, RUN_NAME);
      // Never spend: checked again right before creating (the form's operator default is a real provider).
      await pickFakeDefaultModel(page, rec);
      const before = new Set((await api("GET", "/runs")).map((r) => r.run_id));
      const create = await mustFind(rec, "create button", clickables(page, RE.create));
      await create.click();
      const runs = await waitApi(
        "the new run to appear in GET /runs",
        () => api("GET", "/runs"),
        (list) => list.some((r) => !before.has(r.run_id)),
        30_000,
      );
      const created = runs.filter((r) => !before.has(r.run_id)).sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1))[0];
      const models = new Set(Object.values((await api("GET", `/runs/${created.run_id}/settings`)).effective_model_key));
      rec.found.agent_models = [...models];
      if (models.size !== 1 || !models.has(QA_AGENT_MODEL)) throw new Error(`the QA run's agents use ${[...models]} (expected only ${QA_AGENT_MODEL}); stopping before any turn`);
      state.runId = created.run_id;
      log.run_id = created.run_id;
      rec.found.run = { run_id: created.run_id, name: created.name };
      const init = await api("GET", `/runs/${state.runId}/turns/r00000_init`);
      const first = init.entities.agents.a01;
      rec.found.a01 = { name: first?.name, position: first?.position };
      if (state.editedName && first?.name !== state.editedName) rec.notes.push(`a01 name is '${first?.name}', expected '${state.editedName}'`);
      if (state.editedX !== null && first?.position?.x !== state.editedX) rec.notes.push(`a01 x is ${first?.position?.x}, expected ${state.editedX}`);
      if (!(await textVisible(page, /paused/i))) throw new Error("the run view does not show 'Paused'");
      rec.found.round_label = await textVisible(page, /round/i, 1000);
      rec.found.turn_label = await textVisible(page, /turn/i, 1000);
      const s = await status(state.runId);
      if (s.state !== "paused") throw new Error(`backend state is ${s.state}, expected paused`);
    },
    { needs: ["defaults"] },
  );

  await step(
    page,
    "run-turn",
    "Run turn advances exactly one agent turn; the live feed shows it (U12, U13)",
    async (rec) => {
      const before = await api("GET", `/runs/${state.runId}/turns`);
      await clickRunControl(page, rec, "Run turn", RE.runTurn);
      const s = await waitApi(
        "one committed turn",
        () => status(state.runId),
        (st) => st.state === "paused" && st.current_turn_id !== before.at(-1).turn_id,
      );
      const after = await api("GET", `/runs/${state.runId}/turns`);
      if (after.length !== before.length + 1) throw new Error(`Run turn committed ${after.length - before.length} turns`);
      rec.found.turn = s.current_turn_id;
      const agent = after.at(-1).acting_agent_id;
      await sleep(1500); // the feed polls every ~700 ms
      rec.found.feed_line = await textVisible(page, /\[r\s*0*1\s+t\s*0*1\]/i, 3000);
      rec.found.turn_or_agent_shown = (await textVisible(page, new RegExp(escapeRe(s.current_turn_id)), 1500)) || (await textVisible(page, new RegExp(`\\b${agent}\\b`), 1500));
      if (!rec.found.feed_line) rec.notes.push("no '[r1 t1] ...' feed line found (INTERFACES section 7 feed format)");
    },
    { needs: ["runId"] },
  );

  await step(
    page,
    "play-pause",
    "Play then Pause: 'Pause requested' while a turn finishes, then 'Paused' (U12)",
    async (rec) => {
      const before = (await status(state.runId)).current_turn_id;
      await clickRunControl(page, rec, "Play", RE.play);
      await waitApi("play to commit a turn", () => status(state.runId), (s) => s.current_turn_id !== before, 30_000);
      const pauseButton = await mustFind(rec, "Pause", [[`button ${RE.pause}`, page.getByRole("button", { name: RE.pause })]]);
      await pauseButton.click();
      const seen = { pause_requested_ui: false, states: [] };
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const s = await status(state.runId);
        if (!seen.states.includes(s.state)) seen.states.push(s.state);
        if (/pause requested/i.test(await bodyText(page))) seen.pause_requested_ui = true;
        if (s.state === "paused" && !s.play_loop) break;
        await sleep(100);
      }
      rec.found.observed = seen;
      if (!seen.pause_requested_ui) rec.notes.push("'Pause requested' was not observed in the UI (turns may be too fast with fake models)");
      if (!(await textVisible(page, /paused/i))) throw new Error("the UI does not show 'Paused' after pausing");
      const s = await status(state.runId);
      if (s.state !== "paused") throw new Error(`backend state ${s.state} after pause`);
    },
    { needs: ["runId"] },
  );

  await step(
    page,
    "step-round",
    "Step round finishes the current round and pauses (U12)",
    async (rec) => {
      await clickRunControl(page, rec, "Step round", RE.stepRound);
      const s = await waitApi("the round end to commit", () => status(state.runId), (st) => st.state === "paused" && st.current_turn_id.endsWith("_end"));
      rec.found.turn = s.current_turn_id;
      await sleep(1000);
      rec.found.round_end_visible = await textVisible(page, new RegExp(`${escapeRe(s.current_turn_id)}|round\\s*${s.round}.*end|end of round`, "i"), 3000);
    },
    { needs: ["runId"] },
  );

  await step(
    page,
    "timeline",
    "History: left/right arrows, turn selection, return to live (U6)",
    async (rec) => {
      const previous = await mustFind(rec, "previous arrow", [["Previous turn", page.getByRole("button", { name: "‹ Previous turn", exact: true })]]);
      await previous.click();
      await sleep(600);
      rec.found.history_indicator = await textVisible(page, /history|historical|viewing/i, 3000);
      await previous.click().catch(() => {});
      await sleep(400);
      const next = await tryFind(rec, "next arrow", [["Next turn", page.getByRole("button", { name: "Next turn ›", exact: true })]]);
      if (next) await next.click();
      const turns = await api("GET", `/runs/${state.runId}/turns`);
      const target = turns[Math.min(2, turns.length - 1)].turn_id;
      const selector = await findOne([["Turn in round", page.locator(".turn-select select")]], 2000);
      if (selector) {
        const options = await selector.locator.locator("option").allTextContents().catch(() => []);
        const option = options.find((o) => o.includes(target));
        if (option) {
          await selector.locator.selectOption({ label: option });
          rec.found.turn_selected = target;
        }
      }
      if (!rec.found.turn_selected) {
        const item = await findOne([[`text ${target}`, page.getByText(target, { exact: false })]], 2000);
        if (item) {
          await item.locator.click();
          rec.found.turn_selected = target;
        } else {
          rec.notes.push(`could not select turn ${target} directly`);
        }
      }
      await sleep(600);
      const live = await mustFind(rec, "return to live", clickables(page, RE.live));
      await live.click();
      await sleep(600);
      rec.found.live_indicator = await textVisible(page, /\blive\b/i, 3000);
      if (!rec.found.history_indicator) rec.notes.push("no 'history' indicator seen after the previous arrow");

      // A gateway page must not spill HTML into the timeline; retry loads the same saved turn.
      const latest = turns.at(-1);
      const retryTurn = [...turns].reverse().find((turn) => turn.round === latest?.round && turn.kind === "agent_turn" && turn.turn_id !== latest?.turn_id);
      if (retryTurn) {
        const routePattern = `**/api/runs/${state.runId}/turns/${retryTurn.turn_id}`;
        let attempts = 0;
        await page.route(routePattern, async (route) => {
          attempts += 1;
          if (attempts === 1) await route.fulfill({ status: 502, contentType: "text/html", body: "<!DOCTYPE html><html><body>Bad gateway</body></html>".repeat(20) });
          else await route.continue();
        });
        await page.reload({ waitUntil: "domcontentloaded" }); // clear the committed-turn cache
        await page.locator(".turn-select select").selectOption(retryTurn.turn_id);
        const error = page.locator(".timeline .error-line");
        await error.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
        const shown = await error.innerText();
        if (shown.length > 220 || /<!doctype|<html/i.test(shown)) throw new Error(`gateway HTML leaked into the timeline: ${shown.slice(0, 240)}`);
        await error.getByRole("button", { name: "Try again" }).click();
        await error.waitFor({ state: "detached", timeout: STEP_TIMEOUT_MS });
        if (attempts !== 2) throw new Error(`retry fetched the saved turn ${attempts} times, expected 2`);
        rec.found.gateway_retry = { safe_error: shown, attempts };
        await page.unroute(routePattern);
        await page.locator(".timeline-history").getByRole("button", { name: /return to live/i }).click();
      }
    },
    { needs: ["runId"] },
  );

  await step(
    page,
    "crowded-coordinate",
    "Click and hover the most crowded coordinate; every occupant is listed (U1)",
    async (rec) => {
      const live = await api("GET", `/runs/${state.runId}/state`);
      const [key, ids] = Object.entries(live.map.occupants).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
      const [x, y] = key.split(",").map(Number);
      state.crowded = { key, ids };
      rec.found.coordinate = { key, occupants: ids };
      const coordRe = new RegExp(`\\(?\\s*${x}\\s*,\\s*${y}\\s*\\)?`);
      let cell = await findOne(
        [
          [`[data-coord="${key}"]`, page.locator(`[data-coord="${key}"]`)],
          [`[data-x][data-y]`, page.locator(`[data-x="${x}"][data-y="${y}"]`)],
          [`title ${coordRe}`, page.getByTitle(coordRe)],
          [`aria-label ${coordRe}`, page.getByLabel(coordRe)],
          [`button ${coordRe}`, page.getByRole("button", { name: coordRe })],
        ],
        2500,
      );
      if (!cell) {
        const goTo = await findOne(fields(page, /go to|coordinate|lookup|x,\s*y/i), 2000);
        if (goTo) {
          await goTo.locator.fill(`${x},${y}`);
          await goTo.locator.press("Enter");
          rec.found.coordinate_lookup = goTo.how;
          await sleep(500);
          cell = await findOne([[`[data-coord="${key}"]`, page.locator(`[data-coord="${key}"]`)], [`title ${coordRe}`, page.getByTitle(coordRe)]], 1500);
        }
      }
      if (cell) {
        rec.found.cell = cell.how;
        await cell.locator.hover();
        await sleep(500);
        await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-crowded-hover.png`) }).catch(() => {});
        rec.found.hover_shows_something = await textVisible(page, new RegExp(ids.map(escapeRe).join("|")), 1500);
        await cell.locator.click();
      } else if (!rec.found.coordinate_lookup) {
        throw new Error(`could not click coordinate ${key} (no data-coord/title/aria-label and no coordinate lookup field)`);
      }
      await sleep(600);
      // A click on a dot (or a cell with one entity) opens that entity's profile card; the occupant list stays behind it.
      rec.found.profile_card_opened = await closeProfileCard(page);
      const listed = [];
      for (const id of ids) if (await textVisible(page, new RegExp(`\\b${escapeRe(id)}\\b`), 800)) listed.push(id);
      rec.found.occupants_listed = listed;
      if (listed.length !== ids.length) throw new Error(`occupant list shows ${listed.length}/${ids.length}: missing ${ids.filter((i) => !listed.includes(i))}`);
    },
    { needs: ["runId"] },
  );

  await step(
    page,
    "select-occupants",
    "Select each occupant of that coordinate and see its profile card (U1, U2)",
    async (rec) => {
      const results = {};
      for (const id of state.crowded.ids.slice(0, 8)) {
        await closeProfileCard(page);
        const item = await findOne(
          [
            [`button ${id}`, page.getByRole("button", { name: new RegExp(`\\b${escapeRe(id)}\\b`) })],
            [`listitem ${id}`, page.getByRole("listitem").filter({ hasText: new RegExp(`\\b${escapeRe(id)}\\b`) })],
            [`text ${id}`, page.getByText(new RegExp(`\\b${escapeRe(id)}\\b`))],
          ],
          1500,
        );
        if (!item) {
          results[id] = "not clickable";
          continue;
        }
        await item.locator.click();
        await sleep(300);
        const card = profileCard(page);
        const shown = (await card.isVisible().catch(() => false)) && (await card.getAttribute("data-entity-id")) === id;
        const details = shown && (await findOne([[`card text`, card.getByText(/stats|health|compute|species|available/i)]], 1500)) !== null;
        results[id] = details ? `selected via ${item.how}` : `clicked via ${item.how}, no profile card with details`;
      }
      await closeProfileCard(page);
      rec.found.occupants = results;
      const failed = Object.entries(results).filter(([, v]) => !v.startsWith("selected"));
      if (failed.length) throw new Error(`occupants without a profile card: ${JSON.stringify(Object.fromEntries(failed))}`);
    },
    { needs: ["runId", "crowded"] },
  );

  await step(
    page,
    "agent-inspector",
    "Agent profile card: stats, skills, knowledge, decision packet and model call (U2)",
    async (rec) => {
      const turns = await api("GET", `/runs/${state.runId}/turns`);
      const modelTurn = [...turns].reverse().find((t) => t.kind === "agent_turn" && t.decision_source === "model");
      if (!modelTurn) throw new Error("no model-decision turn to inspect");
      const agentId = modelTurn.acting_agent_id;
      rec.found.agent = agentId;
      await closeProfileCard(page);
      if (!(await selectAgentOrEntity(page, rec, agentId))) throw new Error(`could not select agent ${agentId}`);
      const card = await waitVisible(profileCard(page), "the agent's profile card");
      await sleep(600);
      const inCard = (re) => findOne([[`card text ${re}`, card.getByText(re)]], 1500).then((f) => f !== null);
      rec.found["section stats"] = await inCard(/^Stats$/);
      rec.found["compute balance"] = await inCard(/compute/i);
      rec.found["model assignment"] = await inCard(/^model$/);
      for (const [label, tab, re] of [
        ["skills", "Skills", /saved skills/i],
        ["knowledge", "Knowledge", /notebook|knowledge records/i],
      ]) {
        await card.getByRole("tab", { name: tab }).click();
        rec.found[`section ${label}`] = await inCard(re);
      }
      await card.getByRole("tab", { name: "Decisions" }).click();
      const row = card.locator(`li[data-turn-id="${modelTurn.turn_id}"]`);
      const packet = await findOne([[`Packet of ${modelTurn.turn_id}`, row.getByRole("button", { name: /^Packet$/ })], ["any Packet", card.getByRole("button", { name: /^Packet$/ })]], 4000);
      if (!packet) throw new Error("no decision packet control in the agent's Decisions");
      rec.found["decision packet control"] = packet.how;
      await packet.locator.click();
      await sleep(800);
      rec.found.card_hidden_under_record = !(await card.isVisible().catch(() => false));
      rec.found.packet_content = await textVisible(page, /stable rules|stable_rules|pk_r\d+|situation|decision request/i, 3000);
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-decision-packet.png`) }).catch(() => {});
      await page.keyboard.press("Escape");
      await sleep(500);
      rec.found.card_back_after_record = await card.isVisible().catch(() => false);
      const call = await findOne([["Model call", card.getByRole("button", { name: /^Model call( \d+)?$/ })]], 3000);
      if (call) {
        await call.locator.click();
        await sleep(600);
        rec.found.model_call_content = await textVisible(page, /tokens|usage|latency|mc_r\d+/i, 2000);
        await page.getByRole("button", { name: "Close record view", exact: true }).click();
        await sleep(400);
      } else {
        rec.notes.push("no model call control found");
      }
      await closeProfileCard(page);
      if (!rec.found.packet_content) throw new Error("the decision packet view shows no packet content");
      if (!rec.found.card_back_after_record) throw new Error("the profile card did not come back after the record viewer closed");
    },
    { needs: ["runId"] },
  );

  await step(
    page,
    "plant-rules",
    "Plant profile card shows the instance and its species rule; the Rules section stages a species change (U3)",
    async (rec) => {
      const live = await api("GET", `/runs/${state.runId}/state`);
      const plant = Object.values(live.entities.plants).find((p) => p.alive);
      if (!plant) throw new Error("no living plant in the run");
      rec.found.plant = plant.id;
      await closeProfileCard(page);
      if (!(await selectAgentOrEntity(page, rec, plant.id))) throw new Error(`could not select plant ${plant.id}`);
      const card = await waitVisible(profileCard(page), "the plant's profile card");
      await sleep(600);
      rec.found.species_shown = await textVisible(page, new RegExp(escapeRe(plant.species)), 2000);
      rec.found.stage_shown = await textVisible(page, /sprout|sapling|mature|stage/i, 1500);
      rec.found.instance_label = await textVisible(page, /instance values/i, 1500);
      await card.getByRole("tab", { name: "Rules" }).click();
      rec.found.instance_vs_rule_labels = await textVisible(page, /species rule/i, 1500);
      const stagedBefore = (await api("GET", `/runs/${state.runId}/interventions`)).staged.length;
      const field = await tryFind(rec, "fruit energy field", fields(card, /fruit energy/i));
      if (!field) throw new Error("no editable 'fruit energy' species rule field");
      await fillField(field, 70);
      const stage = await mustFind(rec, "stage plant rule", clickables(card, /stage species rule change|stage|apply|save/i));
      await stage.click();
      const staged = await waitApi(
        "a staged update_plant_rules",
        () => api("GET", `/runs/${state.runId}/interventions`),
        (r) => r.staged.length > stagedBefore && r.staged.some((iv) => iv.type === "update_plant_rules"),
        STEP_TIMEOUT_MS,
      );
      const iv = staged.staged.find((x) => x.type === "update_plant_rules");
      rec.found.staged_rule = { species: iv.species, fruit_energy: iv.rule?.fruit_energy };
      if (iv.rule?.fruit_energy !== 70) rec.notes.push(`staged fruit_energy is ${iv.rule?.fruit_energy}, expected 70`);
      await closeProfileCard(page);
    },
    { needs: ["runId"] },
  );

  await step(
    page,
    "god-mode",
    "God mode: change a context setting and send a voice; staged, then applied after a turn (U7, U8, U16)",
    async (rec) => {
      await page.keyboard.press("Escape").catch(() => {});
      await openWorkspacePanel(page, "Inspector & tools");
      const god = await mustFind(rec, "God mode", clickables(page, RE.godMode));
      await god.click();
      await sleep(500);
      const stagedBefore = (await api("GET", `/runs/${state.runId}/interventions`)).staged.length;

      const history = await tryFind(rec, "recent history length field", fields(page, /recent history/i));
      if (history) {
        await fillField(history, 3);
        const stage = await tryFind(rec, "stage context settings", clickables(page, /stage|apply|queue|save/i));
        if (stage) await stage.click();
      }
      await sleep(500);
      const voice = await tryFind(rec, "voice text", [...fields(page, /what the agents hear|voice|message/i), ["textarea", page.locator("textarea")]]);
      if (voice) {
        await fillField(voice, VOICE_TEXT);
        const all = await findOne(clickables(page, /broadcast|all agents|everyone/i), 1500);
        if (all) {
          await all.locator.click().catch(() => {});
          rec.found.voice_recipients = all.how;
        }
        const send = await tryFind(rec, "send voice", clickables(page, /send voice|stage voice|send|stage/i));
        if (send) await send.click();
      }
      const staged = await waitApi(
        "the staged interventions",
        () => api("GET", `/runs/${state.runId}/interventions`),
        (r) => r.staged.length > stagedBefore,
        STEP_TIMEOUT_MS,
      ).catch(() => ({ staged: [] }));
      const types = staged.staged.map((iv) => iv.type);
      rec.found.staged_types = types;
      rec.found.staged_list_in_ui = await textVisible(page, /staged|pending edits|queued/i, 2000);
      if (!types.includes("update_context_settings")) rec.notes.push("no update_context_settings staged from the UI");
      if (!types.includes("voice")) rec.notes.push("no voice staged from the UI");
      if (!types.length) throw new Error("nothing was staged from god mode");

      await clickRunControl(page, rec, "Run turn", RE.runTurn);
      const s = await waitIdle(state.runId);
      const view = await api("GET", `/runs/${state.runId}/turns/${s.current_turn_id}`);
      const applied = view.turn.interventions.map((r) => `${r.intervention.type}:${r.ok}`);
      rec.found.applied_in_turn = { turn: s.current_turn_id, applied };
      const left = (await api("GET", `/runs/${state.runId}/interventions`)).staged.length;
      if (left !== 0) throw new Error(`${left} interventions still staged after a turn`);
      if (!applied.length) throw new Error("the next turn recorded no intervention");
      await sleep(1500);
      rec.found.voice_in_feed = types.includes("voice") ? await textVisible(page, new RegExp(escapeRe(VOICE_TEXT)), 2000) : null;
    },
    { needs: ["runId"] },
  );

  await step(
    page,
    "resume",
    "Resume flow: back to the entry page, Resume session, open the run paused (U10)",
    async (rec) => {
      const back = await findOne(clickables(page, RE.back), 1500);
      if (back) {
        await back.locator.click();
        rec.found.back = back.how;
      } else {
        rec.notes.push("no in-app way back to the entry page found; navigating to BASE_URL");
        await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      }
      const resume = await mustFind(rec, "Resume session", clickables(page, RE.resumeSession));
      await resume.click();
      const summary = (await api("GET", "/runs")).find((r) => r.run_id === state.runId);
      const label = await mustFind(rec, "the run in the list", [
        [`button ${summary.name}`, page.getByRole("button", { name: new RegExp(escapeRe(summary.name)) })],
        [`row ${summary.name}`, page.getByRole("row").filter({ hasText: summary.name })],
        [`text ${summary.name}`, page.getByText(summary.name, { exact: false })],
        [`text ${state.runId}`, page.getByText(state.runId, { exact: false })],
      ]);
      rec.found.list_shows_round = await textVisible(page, new RegExp(`round\\s*${summary.last_round}|r0*${summary.last_round}\\b`, "i"), 1500);
      await label.click();
      const open = await findOne(clickables(page, /^open$|^resume$|open run|resume run|load/i), 1500);
      if (open) await open.locator.click();
      if (!(await textVisible(page, /paused/i))) throw new Error("the resumed run does not show 'Paused'");
      const s = await status(state.runId);
      rec.found.status = { state: s.state, current_turn_id: s.current_turn_id };
      if (s.state !== "paused") throw new Error(`resumed run state ${s.state}`);
    },
    { needs: ["runId"] },
  );

  if (process.env.QA_SKIP_ERROR_STEP !== "1") {
    await step(
      page,
      "error-recovery",
      "Error state is shown and 'Recover (pause)' returns to paused (A-COG-5)",
      async (rec) => {
        const request = withFakeModels(await api("GET", "/defaults?agent_count=8"));
        request.name = `${RUN_NAME} error`;
        request.play_delay_seconds = 0;
        for (const card of request.agents) card.fake_options = { fail: { status: "timeout", rounds: [1], failing_attempts: 3 } };
        const created = await api("POST", "/runs", request);
        state.errorRunId = created.run_id;
        log.error_run_id = created.run_id;
        await api("POST", `/runs/${created.run_id}/close`).catch(() => {});
        await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        const resume = await mustFind(rec, "Resume session", clickables(page, RE.resumeSession));
        await resume.click();
        const entry = await mustFind(rec, "the error run in the list", [
          [`text ${request.name}`, page.getByText(request.name, { exact: false })],
          [`text ${created.run_id}`, page.getByText(created.run_id, { exact: false })],
        ]);
        await entry.click();
        const open = await findOne(clickables(page, /^open$|^resume$|open run|resume run|load/i), 1500);
        if (open) await open.locator.click();
        await clickRunControl(page, rec, "Run turn", RE.runTurn);
        const s = await waitIdle(created.run_id);
        rec.found.backend_state = s.state;
        rec.found.last_error = s.last_error;
        if (s.state !== "error") throw new Error(`expected the error state, got ${s.state}`);
        if (!(await textVisible(page, /error/i))) throw new Error("the UI does not show the error state");
        await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-error-state.png`) }).catch(() => {});
        await openWorkspacePanel(page, "Session & agents");
        const recover = await mustFind(rec, "Recover (pause)", [
          [`button recover`, page.getByRole("button", { name: /recover/i })],
          [`button pause`, page.getByRole("button", { name: RE.pause })],
        ]);
        await recover.click();
        const after = await waitApi("paused after recovery", () => status(created.run_id), (st) => st.state === "paused", 15_000);
        rec.found.after_recover = after.state;
        if (!(await textVisible(page, /paused/i))) throw new Error("the UI does not show 'Paused' after recovery");
      },
      { needs: ["defaults"] },
    );
  }

  if (ASSISTANT_MODE !== "0" && !ONLY_MAP) await runAssistantSteps(page);
  if (!ONLY_MAP) await runResumeArchiveStep(page);
  if (!ONLY_MAP) await runProfileCardStep(page);
  await runMapMarksStep(page);
  await runMap3dStep(page);
}

// ---------------------------------------------------------------------------
// Entity profile card (runs last, on the QA run; never calls a model)
// ---------------------------------------------------------------------------
//
// Opens the run page live, centres the map on the living agent with the most turns, clicks its
// dot and checks the card: the board stays visible behind a see-through backdrop, Overview comes
// first, Decisions lists the agent's turns and "View turn" on an older row moves the page (and
// the card's "as of turn") to that turn, Skills and Knowledge show their content, ArrowDown on the
// side list selects the next section, and Escape closes the card.  Extra screenshots
// profile-overview and profile-decisions.

async function runProfileCardStep(page) {
  await step(
    page,
    "profile-card",
    "Profile card from a map dot: board visible behind it; Overview, Decisions (View turn), Skills, Knowledge; arrows move; Escape closes",
    async (rec) => {
      await gotoRun(page, state.runId);
      await closeDrawer(page);
      await closeProfileCard(page);
      const turns = await api("GET", `/runs/${state.runId}/turns`);
      const live = await api("GET", `/runs/${state.runId}/state`);
      // A living agent that acted at least twice, so its Decisions list has an older turn to view.
      const acted = (id) => turns.filter((t) => t.kind === "agent_turn" && t.acting_agent_id === id).length;
      const agent = Object.values(live.entities.agents).filter((a) => a.alive).sort((a, b) => acted(b.id) - acted(a.id))[0];
      if (!agent || acted(agent.id) < 2) throw new Error("no living agent with two turns");
      rec.found.agent = agent.id;
      // Centre the map on the agent's cell ("Go to" also selects that point), then click the dot drawn there.
      const map = page.locator("main.run-center");
      await map.getByLabel("Go to x").fill(String(agent.position.x));
      await map.getByLabel("Go to y").fill(String(agent.position.y));
      await map.getByRole("button", { name: /^Go$/ }).click();
      await sleep(600);
      const cell = page.locator(`main.run-center [data-coord="${agent.position.x},${agent.position.y}"]`);
      const dots = await cell.evaluate((rect) => {
        const svg = rect.ownerSVGElement;
        const box = rect.getBoundingClientRect();
        return [...svg.querySelectorAll("circle.insp-dot-agent")]
          .map((c) => c.getBoundingClientRect())
          .filter((b) => b.left >= box.left - 1 && b.right <= box.right + 1 && b.top >= box.top - 1 && b.bottom <= box.bottom + 1)
          .map((b) => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 }));
      });
      if (dots.length === 0) throw new Error(`no agent dot drawn in cell ${agent.position.x},${agent.position.y}`);
      await page.mouse.click(dots[0].x, dots[0].y);
      const card = await waitVisible(profileCard(page), "the profile card after a map dot click");
      rec.found.opened_for = await card.getAttribute("data-entity-id");
      const kind = await card.getAttribute("class");
      if (!/profile-kind-agent/.test(kind ?? "")) throw new Error(`the dot opened a card for ${rec.found.opened_for} (${kind})`);

      // The backdrop dims the board but leaves it in view: part of the map lies outside the card.
      const look = await page.evaluate(() => {
        const backdrop = document.querySelector(".profile-backdrop");
        const alpha = Number((getComputedStyle(backdrop).backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1] ?? "0,0,0,1").split(",")[3] ?? 1);
        const cardBox = document.querySelector(".profile-card").getBoundingClientRect();
        const mapBox = document.querySelector("main.run-center .insp-map-svg").getBoundingClientRect();
        const mapOutside = mapBox.left < cardBox.left - 20 || mapBox.bottom > cardBox.bottom + 20 || mapBox.top < cardBox.top - 20;
        return { alpha, mapOutside, cardW: Math.round(cardBox.width), winW: window.innerWidth };
      });
      rec.found.backdrop = look;
      if (!(look.alpha > 0 && look.alpha <= 0.5)) throw new Error(`backdrop alpha ${look.alpha} (expected a dim, see-through backdrop)`);
      if (!look.mapOutside) throw new Error("the card covers the whole map");

      const tab = (name) => card.getByRole("tab", { name });
      if ((await tab("Overview").getAttribute("aria-selected")) !== "true") throw new Error("Overview is not the first section shown");
      await waitVisible(card.getByText(/^Stats$/), "Overview's Stats");
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-profile-overview.png`) }).catch(() => {});

      await tab("Decisions").click();
      const rows = card.locator("li.profile-row");
      await waitVisible(rows, "a Decisions row");
      rec.found.decision_rows = await rows.count();
      const older = rows.nth(1);
      const olderTurn = await older.getAttribute("data-turn-id");
      await waitVisible(older.getByText(/^action |^result |no action|thinking/), "the older row's loaded events", 6000).catch(() => null);
      await older.getByRole("button", { name: "View turn" }).click();
      await waitVisible(page.locator(".timeline-history"), "the history strip after View turn");
      rec.found.view_turn = olderTurn;
      await page.waitForFunction((turn) => document.querySelector(".profile-card .profile-sub code")?.textContent === turn, olderTurn, { timeout: STEP_TIMEOUT_MS });
      rec.found.card_header_turn = await card.locator(".profile-sub code").innerText();
      if (rec.found.card_header_turn !== olderTurn) throw new Error(`the card shows turn ${rec.found.card_header_turn}, expected ${olderTurn}`);
      if (!(await card.isVisible())) throw new Error("View turn closed the card");
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-profile-decisions.png`) }).catch(() => {});

      await tab("Skills").click();
      await waitVisible(card.getByText(/saved skills/i), "Skills: saved skills");
      await tab("Knowledge").click();
      await waitVisible(card.getByText(/^Notebook$/), "Knowledge: notebook");
      rec.found.knowledge_records = await card.getByText(/knowledge records \(\d+\)/i).first().innerText().catch(() => null);
      await tab("Knowledge").focus();
      await page.keyboard.press("ArrowDown");
      rec.found.arrow_down_selects = await tab("Messages").getAttribute("aria-selected");
      if (rec.found.arrow_down_selects !== "true") throw new Error("ArrowDown on Knowledge did not select Messages");

      await page.keyboard.press("Escape");
      await card.waitFor({ state: "detached", timeout: 3000 });
      rec.found.escape_closes = true;
      rec.found.history_kept = await page.locator(".timeline-history").isVisible();
      await page.locator(".timeline-history").getByRole("button", { name: /return to live/i }).click();
    },
    { needs: ["runId"] },
  );

}

// ---------------------------------------------------------------------------
// Map marks and the 3D view (run after profile-card on the QA run; never call a model)
// ---------------------------------------------------------------------------
//
// map-marks (2D): the viewed turn's action marks (g.insp-marks keyed by the turn id, the acting
// agent's badge with its glyph, the move arrow) and their text twin in the first status line;
// the marks group survives a live refresh; one dot size per zoom level; group tiles in far mode;
// a packed cell's count badge lists every occupant; the Action marks chip and the Key button.
// map-3d: the three.js chunk loads only when "3D view" is chosen; the board's counts against the
// API; a selected agent's label sits on its cell and opens its profile card; keys, drag and
// wheel move the camera; frame region matches map3dCamera.frameRegion; help card; the choice
// persists across a reload; a history move replays; "2D map" restores the SVG.

/** The badge glyph the 2D map draws for an action name (mapIndicators.glyphFor via turnEffects). */
const ACTION_GLYPH = {
  move: "move",
  attack: "attack",
  send: "message",
  broadcast: "message",
  absorb: "absorb",
  transfer: "transfer",
  recover: "recover",
  upgrade: "upgrade",
  wait: "wait",
  observe: "observe",
  query: "query",
  run_skill: "skill",
};
const glyphOf = (name) => (name ? (ACTION_GLYPH[name] ?? "skill") : "none");

const centreMap = (page) => page.locator("main.run-center");
const viewRadio = (page, name) => page.getByRole("radiogroup", { name: "Map view", exact: true }).getByRole("radio", { name, exact: true });

/** Console and page errors so far (a map step fails when it adds any). */
const errorCount = () => log.console_errors.length + log.page_errors.length;
function assertNoNewErrors(rec, before) {
  const added = [...log.console_errors, ...log.page_errors].slice(before);
  rec.found.new_console_or_page_errors = added.length;
  if (added.length) throw new Error(`console or page errors during the step: ${JSON.stringify(added.slice(0, 3))}`);
}

/** Show the 2D map when a previous visit left the 3D view chosen. */
async function show2dMap(page) {
  const radio = viewRadio(page, "2D map");
  if ((await radio.count()) && (await radio.getAttribute("aria-checked")) !== "true") await radio.click();
  await waitVisible(page.locator("main.run-center .insp-map-svg"), "the 2D map");
}

async function zoomPx(page) {
  return parseInt(await page.locator("main.run-center .insp-zoom-level").innerText(), 10);
}

/** Click Zoom in / Zoom out until the readout shows `px`. */
async function zoomToPx(page, px) {
  for (let i = 0; i < 20; i += 1) {
    const now = await zoomPx(page);
    if (now === px) return;
    const name = now < px ? "Zoom in" : "Zoom out";
    const button = centreMap(page).getByRole("button", { name, exact: true });
    if (await button.isDisabled()) throw new Error(`cannot reach ${px} px: ${name} is disabled at ${now} px`);
    await button.click();
    await sleep(150);
  }
  throw new Error(`the zoom readout never reached ${px} px`);
}

/** Centre the 2D map on a point with Go to (this also selects the point). */
async function goToPoint(page, p) {
  const map = centreMap(page);
  await map.getByLabel("Go to x").fill(String(p.x));
  await map.getByLabel("Go to y").fill(String(p.y));
  await map.getByRole("button", { name: /^Go$/ }).click();
  await sleep(400);
}

/** Select an entity through the Inspector tab's "Find entity by id" (works in both map views), then close its card. */
async function selectById(page, id) {
  await openWorkspacePanel(page, "Inspector & tools");
  await page.locator("#tab-inspect").click();
  await page.locator("#find-entity").fill(id);
  await page.getByRole("button", { name: "Select entity", exact: true }).click();
  await waitVisible(profileCard(page), `the profile card of ${id}`);
  await closeProfileCard(page);
  await page.getByRole("button", { name: "Close inspector panel", exact: true }).click();
  await sleep(300);
}

/** The dots drawn inside a cell of the 2D map, and the count badges inside it. */
async function cellContents(page, key) {
  return page.locator(`main.run-center [data-coord="${key}"]`).evaluate((rect) => {
    const svg = rect.ownerSVGElement;
    const box = rect.getBoundingClientRect();
    const inside = (b) => {
      const x = b.left + b.width / 2;
      const y = b.top + b.height / 2;
      return x >= box.left - 0.5 && x <= box.right + 0.5 && y >= box.top - 0.5 && y <= box.bottom + 0.5;
    };
    const dots = [...svg.querySelectorAll("[data-dot-radius].insp-dot")].filter((c) => inside(c.getBoundingClientRect())).length;
    const badges = [...svg.querySelectorAll("g.insp-dot-badge")]
      .filter((g) => inside(g.getBoundingClientRect()))
      .map((g) => {
        const b = g.getBoundingClientRect();
        const text = g.querySelector("text");
        return { count: g.getAttribute("data-count"), bare: text?.classList.contains("is-bare") ?? false, x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
    return { dots, badges };
  });
}

async function dotRadii(page) {
  return page.evaluate(() => [...new Set([...document.querySelectorAll("main.run-center .insp-map-svg [data-dot-radius].insp-dot")].map((c) => c.getAttribute("data-dot-radius")))]);
}

async function runMapMarksStep(page) {
  await step(
    page,
    "map-marks",
    "2D map: action marks and caption of the viewed turn, equal dots, group tiles, count badge, Action marks and Key",
    async (rec) => {
      const errorsBefore = errorCount();
      await page.setViewportSize({ width: 1400, height: 900 });
      await gotoRun(page, state.runId);
      await closeDrawer(page);
      await closeProfileCard(page);
      await show2dMap(page);
      const map = centreMap(page);
      const s = await waitIdle(state.runId);
      const live = await api("GET", `/runs/${state.runId}/state`);
      const liveTurn = await api("GET", `/runs/${state.runId}/turns/${s.current_turn_id}`);
      rec.found.live_turn = { id: s.current_turn_id, kind: liveTurn.turn.kind };
      await page.mouse.move(5, 5);

      const marksChip = map.getByRole("checkbox", { name: "Action marks", exact: true });
      if ((await marksChip.getAttribute("aria-checked")) !== "true") {
        rec.notes.push("the Action marks chip was off (stored in this browser); switched it on");
        await marksChip.click();
      }
      const selectAll = map.locator(".insp-legend").getByRole("button", { name: "Select all", exact: true });
      if (await selectAll.isEnabled()) {
        rec.notes.push("some entity kinds were hidden (stored in this browser); pressed Select all");
        await selectAll.click();
      }

      // 1. The live turn: one marks group keyed by the turn id; the fixed action line names what happened.
      const liveGroup = map.locator(`.insp-map-svg g.insp-marks[data-turn-id="${s.current_turn_id}"]`);
      await liveGroup.waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS });
      rec.found.live_marks_kind = await liveGroup.getAttribute("data-kind");
      if (rec.found.live_marks_kind !== liveTurn.turn.kind) throw new Error(`marks data-kind ${rec.found.live_marks_kind}, turn kind ${liveTurn.turn.kind}`);
      const caption = map.locator(".insp-map-status-action");
      rec.found.live_caption = await caption.getAttribute("title");
      if ((await caption.getAttribute("data-turn-id")) !== s.current_turn_id || !rec.found.live_caption.includes(s.current_turn_id)) {
        throw new Error(`the action line does not name turn ${s.current_turn_id}: "${rec.found.live_caption}"`);
      }

      // 2. The same group element survives a hover and a live refresh (it is keyed by the turn id, not remounted).
      await liveGroup.evaluate((g) => {
        g.dataset.qaMark = "kept";
      });
      const svgBox = await map.locator(".insp-map-svg").boundingBox();
      await page.mouse.move(svgBox.x + svgBox.width / 2, svgBox.y + svgBox.height / 2);
      await sleep(2800); // longer than one idle poll (2.5 s)
      rec.found.marks_kept_after_refresh = (await map.locator('.insp-map-svg g.insp-marks[data-qa-mark="kept"]').count()) === 1;
      if (!rec.found.marks_kept_after_refresh) throw new Error("the marks group was remounted by a hover or a live refresh of the same turn");
      await page.mouse.move(5, 5);

      // 3. An agent turn in history: the actor's badge carries the action's glyph; a successful move has an arrow.
      const turns = await api("GET", `/runs/${state.runId}/turns`);
      const agentTurns = turns.filter((t) => t.kind === "agent_turn" && t.action_name);
      const pick = [...agentTurns].reverse().find((t) => t.action_name === "move" && t.ok === true) ?? agentTurns.at(-1);
      if (!pick) throw new Error("the run has no agent turn with an action");
      const view = await api("GET", `/runs/${state.runId}/turns/${pick.turn_id}`);
      const actor = pick.acting_agent_id;
      await gotoRun(page, state.runId, pick.turn_id);
      await closeProfileCard(page);
      await zoomToPx(page, 44);
      await goToPoint(page, view.entities.agents[actor].position);
      await page.mouse.move(5, 5);
      const group = map.locator(`.insp-map-svg g.insp-marks[data-turn-id="${pick.turn_id}"]`);
      await group.waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS });
      const badge = group.locator(`g.insp-mark-badge[data-actor="${actor}"]`);
      await badge.first().waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS });
      const arrows = await group.locator("line.insp-mark-arrow").count();
      rec.found.history_turn = {
        id: pick.turn_id,
        action: pick.action_name,
        ok: pick.ok,
        group_kind: await group.getAttribute("data-kind"),
        badge_action: await badge.first().getAttribute("data-action"),
        badge_word: (await badge.first().textContent())?.trim(),
        badge_ok: await badge.first().getAttribute("data-ok"),
        arrows,
        caption: await caption.getAttribute("title"),
        visible_action: await caption.innerText(),
      };
      if (rec.found.history_turn.group_kind !== "agent_turn") throw new Error(`marks data-kind ${rec.found.history_turn.group_kind} for an agent turn`);
      if (rec.found.history_turn.badge_action !== glyphOf(pick.action_name)) throw new Error(`badge glyph ${rec.found.history_turn.badge_action}, expected ${glyphOf(pick.action_name)} for ${pick.action_name}`);
      if (!rec.found.history_turn.badge_word || rec.found.history_turn.badge_word.length < 4) throw new Error(`badge does not explain the action: "${rec.found.history_turn.badge_word}"`);
      if (pick.action_name === "move" && pick.ok && arrows < 1) throw new Error("a successful move drew no arrow");
      if (!rec.found.history_turn.caption.includes(pick.turn_id) || !rec.found.history_turn.caption.includes(actor)) {
        throw new Error(`the caption does not name turn ${pick.turn_id} and ${actor}: "${rec.found.history_turn.caption}"`);
      }
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-map-marks-turn.png`) }).catch(() => {});
      await gotoRun(page, state.runId);
      await closeProfileCard(page);
      if (await page.locator(".timeline-history").isVisible().catch(() => false)) {
        await page.locator(".timeline-history").getByRole("button", { name: /return to live/i }).click();
        await sleep(500);
      }

      // 4. One dot size per zoom level: r 4.5 at 44 px, 5 at 56 px.
      await map.getByRole("button", { name: "Fit map", exact: true }).click();
      await zoomToPx(page, 44);
      const r44 = await dotRadii(page);
      await map.getByRole("button", { name: "Zoom in", exact: true }).click();
      await sleep(200);
      const r56 = await dotRadii(page);
      rec.found.dot_radius = { "44px": r44, [`${await zoomPx(page)}px`]: r56 };
      if (r44.length !== 1 || r44[0] !== "4.5") throw new Error(`dot radii at 44 px: ${JSON.stringify(r44)} (expected one size, 4.5)`);
      if (r56.length !== 1 || r56[0] !== "5") throw new Error(`dot radii at 56 px: ${JSON.stringify(r56)} (expected one size, 5)`);

      // 5. Far mode: one group tile per occupied cell at 10 px and no dots; digits on tiles of two or more at 18 px.
      await map.getByRole("button", { name: "Fit map", exact: true }).click();
      await zoomToPx(page, 10);
      const occupied = Object.values(live.map.occupants).filter((ids) => ids.length > 0).length;
      const far = await page.evaluate(() => ({
        tiles: document.querySelectorAll("main.run-center .insp-map-svg rect.insp-tile").length,
        dots: document.querySelectorAll("main.run-center .insp-map-svg [data-dot-radius].insp-dot").length,
      }));
      rec.found.far_10px = { ...far, occupied_cells: occupied, zoom_out_disabled: await map.getByRole("button", { name: "Zoom out", exact: true }).isDisabled() };
      if (far.tiles !== occupied) throw new Error(`${far.tiles} group tiles at 10 px for ${occupied} occupied cells`);
      if (far.dots !== 0) throw new Error(`${far.dots} dots drawn at 10 px (far mode draws tiles only)`);
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-map-far.png`) }).catch(() => {});
      await zoomToPx(page, 18);
      const digits = await page.evaluate(() =>
        [...document.querySelectorAll("main.run-center .insp-map-svg rect.insp-tile[data-count]")]
          .map((t) => ({ count: Number(t.getAttribute("data-count")), text: t.parentNode.querySelector("text.insp-tile-count")?.textContent ?? null }))
          .filter((t) => t.count >= 2),
      );
      rec.found.tiles_with_digits_18px = digits.length;
      const wrong = digits.filter((t) => t.text !== (t.count > 99 ? "99+" : String(t.count)));
      if (wrong.length) throw new Error(`tiles without their count at 18 px: ${JSON.stringify(wrong.slice(0, 5))}`);

      // 6. The most crowded cell: at 44 px every dot up to the packed capacity; a count badge when packed; the badge lists every occupant.
      const [key, ids] = Object.entries(live.map.occupants).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
      const [cx, cy] = key.split(",").map(Number);
      const n = ids.length;
      await zoomToPx(page, 44);
      await goToPoint(page, { x: cx, y: cy });
      await page.mouse.move(5, 5);
      const at44 = await cellContents(page, key);
      rec.found.crowded = { key, occupants: n, dots_44px: at44.dots, badges_44px: at44.badges.map((b) => b.count) };
      if (at44.dots > n || at44.dots < Math.min(n, 9)) throw new Error(`${at44.dots} dots in ${key} for ${n} occupants at 44 px`);
      if (n > 9 && !at44.badges.some((b) => b.count === String(n))) throw new Error(`no count badge "${n}" on the packed cell ${key} at 44 px`);
      let clicked = null;
      for (const px of [44, 36, 30, 24]) {
        await zoomToPx(page, px);
        await page.mouse.move(5, 5);
        const inCell = await cellContents(page, key);
        const b = inCell.badges.find((x) => x.count === String(n));
        if (!b) continue;
        rec.found.crowded.packed_hint = await map.locator(".insp-map-zoomhint").innerText().catch(() => null);
        await page.mouse.click(b.x, b.y);
        const tip = await waitVisible(page.locator(".insp-tooltip"), "the cell tooltip after a count-badge click");
        const tipText = await tip.innerText();
        const missing = ids.filter((id) => !tipText.includes(id));
        clicked = { px, style: b.bare ? "bare" : "pill", listed: n - missing.length, profile_card: await profileCard(page).isVisible().catch(() => false) };
        if (missing.length) throw new Error(`the tooltip of the count badge misses ${missing}`);
        if (clicked.profile_card) throw new Error("a count-badge click opened a profile card");
        await page.keyboard.press("Escape");
        await sleep(300);
        break;
      }
      rec.found.badge_click = clicked;
      if (!clicked) {
        if (n > 4) throw new Error(`no count badge on ${key} (${n} occupants) at 44, 36, 30 or 24 px`);
        rec.notes.push(`the most crowded cell ${key} holds ${n} occupants, which fit unpacked at every dot zoom level: the count-badge click was not exercised`);
      }
      await zoomToPx(page, 44);

      // 7. The Action marks chip hides and restores the marks.
      await marksChip.click();
      await sleep(200);
      rec.found.marks_off = { groups: await map.locator(".insp-map-svg g.insp-marks").count(), checked: await marksChip.getAttribute("aria-checked") };
      if (rec.found.marks_off.groups !== 0 || rec.found.marks_off.checked !== "false") throw new Error(`Action marks off: ${JSON.stringify(rec.found.marks_off)}`);
      await marksChip.click();
      await sleep(200);
      rec.found.marks_on = { groups: await map.locator(".insp-map-svg g.insp-marks").count(), checked: await marksChip.getAttribute("aria-checked") };
      if (rec.found.marks_on.groups !== 1 || rec.found.marks_on.checked !== "true") throw new Error(`Action marks on: ${JSON.stringify(rec.found.marks_on)}`);

      // 8. Key: collapsed by default; opens the explanations and the terrain entries; remembered per browser.
      const closeInspector = page.getByRole("button", { name: "Close inspector panel", exact: true });
      if (await closeInspector.isVisible()) await closeInspector.click();
      const keyButton = map.locator(".insp-legend").getByRole("button", { name: "Key", exact: true });
      const keyStored = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("empyrean.map.key.")).map((k) => [k, localStorage.getItem(k)])));
      rec.found.key_initially_expanded = await keyButton.getAttribute("aria-expanded");
      if (rec.found.key_initially_expanded === "true") {
        rec.notes.push("the Key was open (stored in this browser); closing it first");
        await keyButton.click();
      }
      if ((await map.locator(".insp-legend-key").count()) !== 0) throw new Error("the key items show while Key is collapsed");
      await keyButton.click();
      const key2 = await waitVisible(map.locator(".insp-legend-key"), "the map key after pressing Key");
      const keyText = await key2.innerText();
      rec.found.key_open = { expanded: await keyButton.getAttribute("aria-expanded"), stored: await keyStored(), has_packed: keyText.includes("packed: zoom in"), has_terrain: keyText.includes("mountain (impassable)") };
      if (rec.found.key_open.expanded !== "true" || !rec.found.key_open.has_packed || !rec.found.key_open.has_terrain) throw new Error(`Key open: ${JSON.stringify(rec.found.key_open)}`);
      if (!Object.values(rec.found.key_open.stored).includes("1")) throw new Error(`Key open is not stored: ${JSON.stringify(rec.found.key_open.stored)}`);
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-map-key.png`) }).catch(() => {});
      await keyButton.click();
      await sleep(200);
      rec.found.key_closed = { expanded: await keyButton.getAttribute("aria-expanded"), items: await map.locator(".insp-legend-key").count() };
      if (rec.found.key_closed.expanded !== "false" || rec.found.key_closed.items !== 0) throw new Error(`Key closed: ${JSON.stringify(rec.found.key_closed)}`);

      // 9. Dark scheme screenshot; the legend and status lines leave the map at least 220 px.
      await page.emulateMedia({ colorScheme: "dark" });
      await sleep(300);
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-map-dark.png`) }).catch(() => {});
      await page.emulateMedia({ colorScheme: "light" });
      rec.found.map_viewport_height = Math.round((await map.locator(".insp-map-viewport").boundingBox()).height);
      if (rec.found.map_viewport_height < 220) throw new Error(`the map viewport is ${rec.found.map_viewport_height} px tall`);
      assertNoNewErrors(rec, errorsBefore);
    },
    { needs: ["runId"] },
  );
}

/** The 3D view's data-* attributes (camera parsed). */
async function map3dAttrs(page) {
  const attrs = await page.evaluate(() => {
    const root = document.querySelector(".map3d");
    return root ? { ...root.dataset } : null;
  });
  if (attrs?.camera) attrs.cameraPose = JSON.parse(attrs.camera);
  return attrs;
}

/** The pose of map3dCamera.frameRegion(region, 0, aspect), including perspective fit for the nearer south corners. */
function expectedFrame(region, aspect) {
  const cols = region.max_x - region.min_x + 1;
  const rows = region.max_y - region.min_y + 1;
  const tilt = (50 * Math.PI) / 180;
  const halfW = cols / 2;
  const halfD = rows / 2;
  const tan = Math.tan((25 * Math.PI) / 180);
  const d = 1.15 * Math.max(
    halfD * Math.cos(tilt) + halfW / (aspect * tan),
    halfD * Math.cos(tilt) + halfD * Math.sin(tilt) / (2 * (1 - 0.42) * tan),
    -halfD * Math.cos(tilt) + halfD * Math.sin(tilt) / (2 * 0.42 * tan),
  );
  const cx = (region.min_x + region.max_x) / 2;
  const cy = (region.min_y + region.max_y) / 2;
  return { x: cx, y: d * Math.sin(tilt), z: -cy + d * Math.cos(tilt), yaw: 0, pitch: -tilt };
}

/** Hold a key on the focused 3D viewport for `ms`, then let one frame settle. */
async function holdKey(page, code, ms) {
  await page.keyboard.down(code);
  await sleep(ms);
  await page.keyboard.up(code);
  await sleep(200);
}

async function runMap3dStep(page) {
  await step(
    page,
    "map-3d",
    "3D view: chunk only on demand, board counts, a label opens the card, keys, drag, wheel, frame, help, persistence, history replay, back to 2D",
    async (rec) => {
      const errorsBefore = errorCount();
      await page.setViewportSize({ width: 1400, height: 900 });
      await gotoRun(page, state.runId);
      // A fresh page in the 2D view with the help card not yet seen (so the first 3D open shows it).
      await page.evaluate(() => {
        localStorage.setItem("empyrean.map.view", "2d");
        localStorage.removeItem("empyrean.map3d.helpSeen");
      });
      await page.mouse.move(5, 5);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitVisible(page.locator("main.run-center .insp-map-svg"), "the 2D map after a reload");
      await sleep(800);
      await closeDrawer(page);
      await closeProfileCard(page);
      await waitIdle(state.runId);
      const live = await api("GET", `/runs/${state.runId}/state`);
      const turns = await api("GET", `/runs/${state.runId}/turns`);
      const e = live.entities;
      const living = Object.values(e.agents).filter((a) => a.alive);
      const acted = (id) => turns.filter((t) => t.kind === "agent_turn" && t.acting_agent_id === id).length;
      const agent = [...living].sort((a, b) => acted(b.id) - acted(a.id) || a.id.localeCompare(b.id))[0] ?? null;
      if (agent) {
        // The selected agent's label always shows (a crowded label may drop out).
        rec.found.agent = { id: agent.id, position: `${agent.position.x},${agent.position.y}`, turns: acted(agent.id) };
      } else {
        rec.notes.push("no living agent in this run: the label checks expect no label and the label click is not checked");
      }

      // The projected board must work without any WebGL context.
      await page.evaluate(() => {
        window.__qaWebglRequests = [];
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
          if (/webgl|experimental-webgl/i.test(kind)) {
            window.__qaWebglRequests.push(kind);
            return null;
          }
          return original.call(this, kind, ...args);
        };
      });
      // 1. The CPU board chunk arrives only with the view switch.
      const resources = () => page.evaluate(() => performance.getEntriesByType("resource").map((r) => r.name));
      const chunkRe = /(Map3dView|three)[.-]/;
      const before = (await resources()).filter((n) => chunkRe.test(n));
      rec.found.chunk_before_click = before;
      if (before.length) throw new Error(`the 3D chunk loaded before "3D view" was chosen: ${before.join(", ")}`);
      const started = Date.now();
      await viewRadio(page, "3D view").click();
      await page.waitForSelector('.map3d[data-ready="1"], [data-webgl="unavailable"], .map3d-fallback[data-webgl="failed"]', { timeout: 30_000 });
      rec.found.ready_ms = Date.now() - started;
      if (await page.locator('[data-webgl="unavailable"]').count()) {
        rec.notes.push("WebGL 2 is unavailable in this browser: checked the fallback only");
        await waitVisible(page.getByText(/WebGL 2 is unavailable/), "the no-WebGL fallback text");
        await waitVisible(page.getByRole("button", { name: "Back to 2D map", exact: true }), "Back to 2D map");
        await viewRadio(page, "2D map").click();
        return;
      }
      if (await page.locator('.map3d-fallback[data-webgl="failed"]').count()) {
        throw new Error(`the 3D view could not load: ${await page.locator(".map3d-fallback").innerText()}`);
      }
      rec.found.chunk_after_click = (await resources()).filter((n) => /Map3dView/.test(n)).map((n) => n.replace(/^https?:\/\/[^/]+/, ""));
      if (!rec.found.chunk_after_click.length) throw new Error("no Map3dView resource was requested after the click");
      rec.found.svg_hidden_not_detached = (await page.locator("main.run-center .insp-map-svg").count()) === 1 && (await page.locator("main.run-center .insp-map-svg").isHidden());
      if (!rec.found.svg_hidden_not_detached) throw new Error("the 2D map is not kept mounted and hidden under the 3D view");
      if ((await viewRadio(page, "3D view").getAttribute("aria-checked")) !== "true") throw new Error('"3D view" is not aria-checked');

      // 2. The help card opens on the first 3D open; Escape closes it.
      const help = page.locator(".map3d-help");
      rec.found.help_on_first_open = await help.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false);
      if (!rec.found.help_on_first_open) throw new Error("the help card did not open on the first 3D open");
      if (!(await help.innerText()).includes("W A S D")) throw new Error("the help card does not list W A S D");
      await page.keyboard.press("Escape");
      await help.waitFor({ state: "detached", timeout: 3000 });

      // 3. The board against the API.
      const counts = { agents: Object.keys(e.agents).length, entities: ["agents", "plants", "fruits", "seeds", "residues"].reduce((sum, k) => sum + Object.keys(e[k] ?? {}).length, 0) };
      const a = await map3dAttrs(page);
      rec.found.board = {
        renderer: a.renderer,
        software: a.software,
        draw_calls: Number(a.drawCalls),
        triangles: Number(a.triangles),
        frame_ms: Number(a.frameMs),
        entities: Number(a.entities),
        agents: Number(a.agents),
        api: counts,
        layer: a.layer,
        lod: a.lod,
      };
      if (rec.found.board.entities !== counts.entities) throw new Error(`data-entities ${a.entities}, the API has ${counts.entities}`);
      if (rec.found.board.agents !== counts.agents) throw new Error(`data-agents ${a.agents}, the API has ${counts.agents}`);
      if (a.renderer !== "Canvas 2D (CPU)" || a.software !== "1" || Number(a.triangles) !== 0) throw new Error("the board must use CPU Canvas 2D");
      if (!Number.isFinite(Number(a.frameMs))) throw new Error("invalid frame timing");
      if ((await page.evaluate(() => window.__qaWebglRequests)).length) throw new Error("the board requested WebGL");
      if ((await resources()).some((n) => /\/three[._/]/.test(n))) throw new Error("the board loaded Three.js");
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-map-3d-board.png`) }).catch(() => {});

      // 4. Labels: in agent view, use what the agent believes is alive, not the true live roster.
      //    The selected agent's label is on its believed cell; a click opens its card and
      //    Escape closes it with the focus back on the board.
      if (agent) await selectById(page, agent.id);
      const animations = page.locator(".map3d-toolbar").getByRole("checkbox", { name: "Animations" });
      if (await animations.isEnabled()) await animations.uncheck();
      await page.mouse.move(5, 5);
      await sleep(300);
      const labelIds = await page.locator("button.map3d-label[data-entity-id]").evaluateAll((els) => els.map((el) => el.dataset.entityId));
      const knowledge = agent ? await api("GET", `/runs/${state.runId}/agents/${agent.id}/knowledge`) : null;
      const latestKnown = new Map();
      for (const sighting of knowledge?.observed_entities ?? []) {
        const prior = latestKnown.get(sighting.id);
        if (!prior || sighting.observed_round >= prior.observed_round) latestKnown.set(sighting.id, sighting);
      }
      const expectedLabels = knowledge
        ? new Set([agent.id, ...[...latestKnown.values()].filter((sighting) => sighting.kind === "agent" && sighting.alive !== false).map((sighting) => sighting.id)])
        : new Set(living.map((x) => x.id));
      rec.found.labels = { shown: labelIds.length, known_living_agents: expectedLabels.size };
      const strangers = labelIds.filter((id) => !expectedLabels.has(id));
      if (strangers.length) throw new Error(`labels outside the viewed agent's known living agents: ${strangers}`);
      if (labelIds.length > expectedLabels.size) throw new Error(`${labelIds.length} labels for ${expectedLabels.size} known living agents`);
      if (agent) {
        const label = page.locator(`button.map3d-label[data-entity-id="${agent.id}"]`);
        if ((await label.count()) !== 1) throw new Error(`no label for the selected agent ${agent.id}`);
        rec.found.labels.selected_cell = await label.getAttribute("data-cell");
        const believed = knowledge.believed_self.position;
        if (believed && rec.found.labels.selected_cell !== `${believed.x},${believed.y}`) throw new Error(`label of ${agent.id} on ${rec.found.labels.selected_cell}, believed position is ${believed.x},${believed.y}`);
        if (!(await page.locator(".map3d .insp-map-agentview-note").innerText()).includes("Dark cells")) throw new Error("agent view fog did not activate on selection");
        rec.found.status_selected = await page.locator(".map3d-status-row").innerText();
        await label.click();
        const card = await waitVisible(profileCard(page), "the profile card after a label click");
        rec.found.label_card = { id: await card.getAttribute("data-entity-id"), agent_card: /profile-kind-agent/.test((await card.getAttribute("class")) ?? "") };
        if (rec.found.label_card.id !== agent.id || !rec.found.label_card.agent_card) throw new Error(`the label opened ${JSON.stringify(rec.found.label_card)}`);
        await page.keyboard.press("Escape");
        await card.waitFor({ state: "detached", timeout: 3000 });
        await sleep(300);
        rec.found.focus_after_card = await page.evaluate(() => document.activeElement?.className ?? null);
        if (!/map3d-viewport/.test(rec.found.focus_after_card ?? "")) throw new Error(`focus after closing the card is on "${rec.found.focus_after_card}", not the 3D viewport`);
        await openWorkspacePanel(page, "Inspector & tools");
        await page.getByRole("button", { name: "Clear selection", exact: true }).click();
        await page.getByRole("button", { name: "Close inspector panel", exact: true }).click();
      }

      // 5. Keys (the viewport has focus): F frames, W flies north, Space up, Shift down, Q turns; F again equals frameRegion.
      const viewport = page.locator(".map3d-viewport");
      await viewport.focus();
      await page.keyboard.press("f");
      await sleep(700);
      const c0 = (await map3dAttrs(page)).cameraPose;
      await holdKey(page, "KeyW", 300);
      const c1 = (await map3dAttrs(page)).cameraPose;
      await holdKey(page, "Space", 200);
      const c2 = (await map3dAttrs(page)).cameraPose;
      await holdKey(page, "ShiftLeft", 200);
      const c3 = (await map3dAttrs(page)).cameraPose;
      await holdKey(page, "KeyQ", 200);
      const c4 = (await map3dAttrs(page)).cameraPose;
      rec.found.keys = { w_dz: +(c1.z - c0.z).toFixed(2), w_dy: +(c1.y - c0.y).toFixed(3), space_dy: +(c2.y - c1.y).toFixed(2), shift_dy: +(c3.y - c2.y).toFixed(2), q_dyaw: +(c4.yaw - c3.yaw).toFixed(2) };
      if (!(c1.z < c0.z) || Math.abs(c1.y - c0.y) > 0.001) throw new Error(`W: ${JSON.stringify({ c0, c1 })}`);
      if (!(c2.y > c1.y)) throw new Error("Space did not raise the camera");
      if (!(c3.y < c2.y)) throw new Error("Shift did not lower the camera");
      if (c4.yaw === c3.yaw) throw new Error("Q did not turn the camera");
      await page.keyboard.press("f");
      await sleep(700);
      const framed = (await map3dAttrs(page)).cameraPose;
      const vbox = await viewport.boundingBox();
      const expect = expectedFrame(live.map.region, vbox.width / vbox.height);
      rec.found.frame = { got: framed, expected: Object.fromEntries(Object.entries(expect).map(([k, v]) => [k, +v.toFixed(2)])) };
      const off = ["x", "y", "z", "yaw", "pitch"].filter((k) => Math.abs(framed[k] - expect[k]) > 0.05);
      if (off.length) throw new Error(`F does not frame the region (${off.join(", ")}): ${JSON.stringify(rec.found.frame)}`);

      // 6. Drag looks (120 px = 30 degrees) without changing the selection; the wheel dollies toward the board.
      const selectedBefore = await page.locator(".map3d-status-row").innerText();
      const mx = vbox.x + vbox.width / 2;
      const my = vbox.y + vbox.height / 2;
      await page.mouse.move(mx, my);
      await page.mouse.down();
      await page.mouse.move(mx + 120, my, { steps: 6 });
      await page.mouse.up();
      await sleep(250);
      const dragged = (await map3dAttrs(page)).cameraPose;
      rec.found.drag_dyaw = +(dragged.yaw - framed.yaw).toFixed(4);
      if (Math.abs(dragged.yaw - framed.yaw - 0.5236) > 0.05) throw new Error(`a 120 px drag turned the camera by ${rec.found.drag_dyaw} rad (expected 0.5236)`);
      if ((await page.locator(".map3d-status-row").innerText()) !== selectedBefore) throw new Error("the drag changed the selection");
      const r = live.map.region;
      const centre = { x: (r.min_x + r.max_x) / 2, z: -(r.min_y + r.max_y) / 2 };
      const dist = (c) => Math.hypot(c.x - centre.x, c.y, c.z - centre.z);
      await page.mouse.wheel(0, -300);
      await sleep(400);
      const wheeled = (await map3dAttrs(page)).cameraPose;
      rec.found.wheel = { before: +dist(dragged).toFixed(2), after: +dist(wheeled).toFixed(2) };
      if (!(dist(wheeled) < dist(dragged))) throw new Error(`the wheel did not bring the camera closer: ${JSON.stringify(rec.found.wheel)}`);

      // 7. One layer today: Layer up / Layer down disabled, PageUp changes nothing; ? opens the help card.
      const toolbar = page.locator(".map3d-toolbar");
      rec.found.layer_buttons_disabled = (await toolbar.getByRole("button", { name: "Layer up", exact: true }).isDisabled()) && (await toolbar.getByRole("button", { name: "Layer down", exact: true }).isDisabled());
      if (!rec.found.layer_buttons_disabled) throw new Error("Layer up / Layer down are enabled with one layer");
      await viewport.focus();
      await page.keyboard.press("PageUp");
      await sleep(200);
      rec.found.layer_after_pageup = (await map3dAttrs(page)).layer;
      if (rec.found.layer_after_pageup !== "1/1") throw new Error(`data-layer ${rec.found.layer_after_pageup} after PageUp`);
      await page.keyboard.press("?");
      await waitVisible(help, "the help card after ?");
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-map-3d-help.png`) }).catch(() => {});
      await page.keyboard.press("Escape");
      await help.waitFor({ state: "detached", timeout: 3000 });

      // 8. The choice persists across a reload (and the help card stays closed once seen).
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('.map3d[data-ready="1"]', { timeout: 30_000 });
      rec.found.persisted = { stored: await page.evaluate(() => localStorage.getItem("empyrean.map.view")), help_shown_again: await help.isVisible().catch(() => false) };
      if (rec.found.persisted.stored !== "3d") throw new Error(`empyrean.map.view is ${rec.found.persisted.stored} after choosing 3D`);
      if (rec.found.persisted.help_shown_again) throw new Error("the help card opened again after it was seen");
      await closeDrawer(page);

      // 9. History: the newest successful move is drawn at its destination with its chip, and Replay turn animates it.
      const move = [...turns].reverse().find((t) => t.kind === "agent_turn" && t.action_name === "move" && t.ok === true);
      if (!move) {
        rec.notes.push("no successful move in this run: history replay not checked");
      } else {
        const view = await api("GET", `/runs/${state.runId}/turns/${move.turn_id}`);
        const to = view.turn.action_result?.effects?.to;
        await gotoRun(page, state.runId, move.turn_id);
        await page.waitForSelector(`.map3d[data-turn="${move.turn_id}"][data-ready="1"]`, { timeout: 15_000 });
        await selectById(page, move.acting_agent_id);
        await viewport.focus();
        await page.keyboard.press("f");
        await sleep(700);
        await page.mouse.move(5, 5);
        const actorLabel = page.locator(`button.map3d-label[data-entity-id="${move.acting_agent_id}"]`);
        const chip = page.locator(`.map3d-chip[data-effect-kind="move"][data-actor="${move.acting_agent_id}"]`);
        rec.found.history = {
          turn: move.turn_id,
          data_turn: (await map3dAttrs(page)).turn,
          actor: move.acting_agent_id,
          actor_cell: (await actorLabel.count()) ? await actorLabel.getAttribute("data-cell") : null,
          api_to: to ? `${to.x},${to.y}` : null,
          chip: (await chip.count()) ? await chip.first().innerText() : null,
        };
        if (rec.found.history.data_turn !== move.turn_id) throw new Error(`data-turn ${rec.found.history.data_turn}, expected ${move.turn_id}`);
        if (rec.found.history.actor_cell !== rec.found.history.api_to) throw new Error(`the actor's label is on ${rec.found.history.actor_cell}, the move went to ${rec.found.history.api_to}`);
        if (!rec.found.history.chip) throw new Error(`no move chip over ${move.acting_agent_id}`);
        if (await animations.isEnabled()) await animations.check();
        await toolbar.getByRole("button", { name: "Replay turn animation", exact: true }).click();
        const t0 = Date.now();
        let sawOne = null;
        let backToZero = null;
        while (Date.now() - t0 < 1500) {
          const anim = (await map3dAttrs(page)).animating;
          if (anim === "1" && sawOne === null) {
            sawOne = Date.now() - t0;
            await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-map-3d-history.png`) }).catch(() => {});
          }
          if (anim === "0" && sawOne !== null) {
            backToZero = Date.now() - t0;
            break;
          }
          await sleep(30);
        }
        rec.found.history.replay = { animating_after_ms: sawOne, done_after_ms: backToZero };
        if (sawOne === null || sawOne > 300) throw new Error(`Replay turn: data-animating "1" after ${sawOne} ms (expected within 300 ms)`);
        if (backToZero === null) throw new Error("Replay turn: still animating after 1.5 s");
      }
      await page.emulateMedia({ colorScheme: "dark" });
      await sleep(700);
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-map-3d-dark.png`) }).catch(() => {});
      await page.emulateMedia({ colorScheme: "light" });

      // 10. Back to the 2D map (so later runs and developers start in 2D).
      await viewRadio(page, "2D map").click();
      await waitVisible(page.locator("main.run-center .insp-map-svg"), "the 2D map after choosing 2D map");
      rec.found.back_to_2d = { map3d_left: await page.locator(".map3d").count(), stored: await page.evaluate(() => localStorage.getItem("empyrean.map.view")) };
      if (rec.found.back_to_2d.map3d_left !== 0 || rec.found.back_to_2d.stored !== "2d") throw new Error(`back to 2D: ${JSON.stringify(rec.found.back_to_2d)}`);
      if (await page.locator(".timeline-history").isVisible().catch(() => false)) {
        await page.locator(".timeline-history").getByRole("button", { name: /return to live/i }).click();
      }
      assertNoNewErrors(rec, errorsBefore);
    },
    { needs: ["runId"] },
  );
}

// ---------------------------------------------------------------------------
// Resume page housekeeping: multi-select, archive, restore, delete (run archive)
// ---------------------------------------------------------------------------
//
// Creates five closed runs "<QA_RUN_NAME> tidy-N" and one open run "<QA_RUN_NAME> busy" through
// the API (run creation never calls a model), then drives the Resume page: Ctrl-click two rows,
// Shift-click a range, Archive selected, the archive view, Restore one, Delete one through the
// confirmation dialog, and a refused delete of the open run.  Every outcome is checked against
// GET /api/runs?archived=0|1.  Extra screenshots: resume-selection-toolbar, resume-archive-view,
// resume-delete-dialog, resume-delete-refused.  The step removes the runs it created.

async function runResumeArchiveStep(page) {
  const created = [];
  await step(
    page,
    "resume-select-archive-delete",
    "Resume page: Ctrl/Shift multi-select, archive, archive view, restore, delete with confirmation",
    async (rec) => {
      const prefix = `${RUN_NAME} tidy-`;
      const request = withFakeModels(await api("GET", "/defaults?agent_count=6"));
      request.play_delay_seconds = 0;
      for (let i = 1; i <= 5; i += 1) {
        const run = await api("POST", "/runs", { ...request, name: `${prefix}${i}` });
        created.push(run.run_id);
        await api("POST", `/runs/${run.run_id}/close`);
        // no background storybook opening job (it would make a delete answer run_in_use for a moment)
        await api("PUT", `/runs/${run.run_id}/assistant/settings`, { storybook_auto: false }).catch(() => {});
      }
      const busy = await api("POST", "/runs", { ...request, name: `${RUN_NAME} busy` }); // stays open
      created.push(busy.run_id);
      rec.found.created = created;

      await page.goto(`${BASE_URL}/#/resume`, { waitUntil: "domcontentloaded" });
      const filterBox = await mustFind(rec, "Filter by name or id", fields(page, /filter by name or id/i));
      await filterBox.fill(prefix);
      const rows = page.locator("table.resume-table tbody tr");
      await waitApi("five filtered rows", async () => rows.count(), (n) => n === 5, 10_000);
      const order = await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-run-id")));
      rec.found.order = order;
      const row = (id) => page.locator(`tr[data-run-id="${id}"]`);
      const cell = (id) => row(id).locator("td").nth(3); // "Saved at": plain text, not a control
      const checked = async () => rows.evaluateAll((trs) => trs.filter((tr) => tr.querySelector("input.resume-check")?.checked).map((tr) => tr.getAttribute("data-run-id")));

      await cell(order[0]).click({ modifiers: ["Control"] });
      await cell(order[2]).click({ modifiers: ["Control"] });
      const afterCtrl = await checked();
      if (afterCtrl.join() !== [order[0], order[2]].join()) throw new Error(`Ctrl-click selected ${afterCtrl}`);
      await cell(order[4]).click({ modifiers: ["Shift"] });
      const expected = [order[0], order[2], order[3], order[4]];
      const afterShift = await checked();
      rec.found.selected_after_shift = afterShift;
      if (afterShift.join() !== expected.join()) throw new Error(`Shift-click range gave ${afterShift}, expected ${expected}`);
      const toolbar = page.getByRole("region", { name: "Selected runs" });
      await waitVisible(toolbar.getByText("4 selected"), "the toolbar count '4 selected'");
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-resume-selection-toolbar.png`) });

      await toolbar.getByRole("button", { name: "Archive selected" }).click();
      await waitVisible(page.getByText("Archived 4 runs."), "the notice 'Archived 4 runs.'");
      await waitApi("one active tidy row", async () => rows.count(), (n) => n === 1, 10_000);
      const activeIds = (await api("GET", "/runs")).map((r) => r.run_id);
      const archivedIds = (await api("GET", "/runs?archived=1")).map((r) => r.run_id);
      if (!activeIds.includes(order[1]) || expected.some((id) => activeIds.includes(id))) throw new Error("the active list after archiving is wrong");
      if (!expected.every((id) => archivedIds.includes(id))) throw new Error("the archive does not hold the four runs");

      await page.getByRole("button", { name: "View archive" }).click();
      await waitVisible(page.getByRole("button", { name: "Back to active runs" }), "the archive view");
      await waitApi("four archived rows", async () => rows.count(), (n) => n === 4, 10_000);
      rec.found.archive_rows_have_open = await page.locator("table.resume-table .run-open").count();
      if (rec.found.archive_rows_have_open) throw new Error("archived rows show an Open button");
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-resume-archive-view.png`) });

      await row(order[0]).getByRole("button", { name: "Restore", exact: true }).click();
      await waitApi("three archived rows", async () => rows.count(), (n) => n === 3, 10_000);
      if (!(await api("GET", "/runs")).some((r) => r.run_id === order[0])) throw new Error("the restored run is not active");

      await row(order[2]).locator("input.resume-check").click();
      await waitVisible(toolbar.getByText("1 selected"), "the toolbar count '1 selected'");
      await toolbar.getByRole("button", { name: "Delete selected…" }).click();
      const dialog = page.getByRole("dialog");
      await waitVisible(dialog, "the delete dialog");
      const dialogText = await dialog.innerText();
      rec.found.dialog_names_run = dialogText.includes(`${prefix}`) && dialogText.includes(order[2]);
      rec.found.dialog_warns = /cannot be undone/i.test(dialogText) && /permanently/i.test(dialogText);
      if (!rec.found.dialog_names_run || !rec.found.dialog_warns) throw new Error(`the dialog does not name the run or warn: ${dialogText.slice(0, 300)}`);
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-resume-delete-dialog.png`) });
      await dialog.getByRole("button", { name: "Delete 1 run" }).click();
      await dialog.waitFor({ state: "hidden", timeout: 10_000 });
      await waitVisible(page.getByText("Deleted 1 run permanently."), "the notice 'Deleted 1 run permanently.'");
      const gone = await api("GET", `/runs/${order[2]}`).then(() => false, (error) => error.status === 404);
      if (!gone) throw new Error("the deleted run still answers GET /runs/{id}");
      await waitApi("two archived rows", async () => rows.count(), (n) => n === 2, 10_000);
      const archivedNow = (await api("GET", "/runs?archived=1")).map((r) => r.run_id).filter((id) => order.includes(id));
      if (archivedNow.sort().join() !== [order[3], order[4]].sort().join()) throw new Error(`archive holds ${archivedNow}`);

      await page.getByRole("button", { name: "Back to active runs" }).click();
      await waitApi("two active tidy rows", async () => rows.count(), (n) => n === 2, 10_000);
      const activeNow = (await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-run-id")))).sort();
      if (activeNow.join() !== [order[0], order[1]].sort().join()) throw new Error(`active rows ${activeNow}`);

      // an open run is refused, and the dialog says so next to that run
      await filterBox.fill(`${RUN_NAME} busy`);
      await waitApi("the busy row", async () => rows.count(), (n) => n === 1, 10_000);
      await cell(busy.run_id).click();
      await toolbar.getByRole("button", { name: "Delete selected…" }).click();
      await waitVisible(dialog, "the delete dialog for the open run");
      await dialog.getByRole("button", { name: "Delete 1 run" }).click();
      await waitVisible(dialog.getByText(/Not deleted:/), "the per-run refusal in the dialog");
      rec.found.refusal = (await dialog.getByText(/Not deleted:/).first().innerText()).slice(0, 200);
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-resume-delete-refused.png`) });
      await dialog.getByRole("button", { name: "Close" }).click();
      if (!(await api("GET", `/runs/${busy.run_id}`)).run_id) throw new Error("the open run was deleted");
    },
    { needs: ["defaults"] },
  );
  for (const runId of created) {
    await api("POST", `/runs/${runId}/close`).catch(() => {});
    await api("DELETE", `/runs/${runId}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Assistant, Storybook, Story Mode and Dictate steps (rev 4)
// ---------------------------------------------------------------------------
//
// Mode (QA_ASSISTANT): "auto" (default) runs the free steps whenever the backend has the
// assistant (opening the drawer, layout, tabs, Dictate state and reading the Storybook spend
// nothing) and the steps that call a model ONLY when every assistant profile is on a fake key.
// Against a backend with live assistant models those steps are skipped, so this script never
// spends money.  Brief cards need a scripted fake chat reply: the QA launcher
// qa/assistant_fake_server.py exposes PUT /api/_qa/fake_metadata for that; without it the
// brief steps are skipped (the plain server's fake only returns its default answer).
// "0" skips every assistant step.  QA_INSECURE_HOST (default qa-insecure.test) is mapped to
// 127.0.0.1 in a second browser to check Dictate on a non-secure origin; the Vite server must
// allow that Host (server.allowedHosts), otherwise that sub-check is recorded as not run.

const ASSISTANT_VIEW = { width: 1440, height: 900 };
const ASSISTANT_Q = "What is happening in this run right now?";
const FIRST_QUESTION = "What is Empyrean and how do I start?";
const BRIEF_RUN_NAME = `QA brief arena ${STAMP}`;

const drawerLoc = (page) => page.locator('aside[aria-label="Assistant"]');

function overlaps(a, b) {
  return !!(a && b && a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5);
}

function roundBox(b) {
  return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null;
}

async function boxOf(locator) {
  return (await locator.count()) ? locator.first().boundingBox().catch(() => null) : null;
}

async function hScroll(page) {
  return page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }));
}

async function setFake(meta) {
  await api("PUT", "/_qa/fake_metadata", meta);
}

async function waitVisible(locator, what, timeout = STEP_TIMEOUT_MS) {
  try {
    await locator.first().waitFor({ state: "visible", timeout });
  } catch {
    throw new Error(`${what} did not become visible within ${timeout} ms`);
  }
  return locator.first();
}

async function gotoRun(page, runId, turnId = null) {
  await page.goto(`${BASE_URL}/#/run/${runId}${turnId ? `?turn=${turnId}` : ""}`, { waitUntil: "domcontentloaded" });
  await waitVisible(page.locator("main.run-center"), "the run page map");
  await sleep(800);
}

async function openRailDrawer(page) {
  const drawer = drawerLoc(page);
  if (await drawer.isVisible().catch(() => false)) return drawer;
  await page.locator('.run-rail [data-control="assistant-launcher"]').first().click();
  return waitVisible(drawer, "the assistant drawer");
}

async function openDrawerAnywhere(page) {
  const drawer = drawerLoc(page);
  if (await drawer.isVisible().catch(() => false)) return drawer;
  const launcher = await findOne([["assistant launcher", page.locator('[data-control="assistant-launcher"]')]], 3000);
  if (!launcher) throw new Error("no assistant launcher on this page");
  await launcher.locator.click();
  return waitVisible(drawer, "the assistant drawer");
}

async function closeDrawer(page) {
  const drawer = drawerLoc(page);
  if (!(await drawer.isVisible().catch(() => false))) return;
  await drawer.getByRole("button", { name: /close the assistant/i }).click();
  await drawer.waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
}

/** Type into the drawer composer, send, and wait until a new assistant message is final.
 * Samples the progress line every 400 ms while it runs (returned as `progress`). */
async function askDrawer(page, text, timeout = 30_000, shot = null) {
  const drawer = drawerLoc(page);
  const box = drawer.locator("#assistant-composer-text");
  await box.fill(text);
  const all = drawer.locator("article.assistant-msg-assistant");
  const before = await all.count();
  await drawer.getByRole("button", { name: /^send$/i }).click();
  const progress = [];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // The message in progress is the shared working indicator: its note is the ticking step line, its label "Thinking…" or the step note.
    const line = drawer.locator("article.assistant-msg-progress .working-note");
    if (await line.count()) {
      const t = (await line.first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      const hint = (await drawer.locator("article.assistant-msg-progress .working-label").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (t && progress.at(-1)?.text !== t) progress.push({ t_ms: timeout - (deadline - Date.now()), text: t, hint });
      if (shot && !shot.done && timeout - (deadline - Date.now()) > shot.afterMs) {
        shot.done = true;
        await page.screenshot({ path: shot.path }).catch(() => {});
      }
    }
    const n = await all.count();
    const running = await drawer.locator("article.assistant-msg-progress").count();
    if (n > before && running === 0) {
      const last = all.nth(n - 1);
      return { article: last, text: (await last.innerText()).trim(), progress };
    }
    await sleep(400);
  }
  throw new Error(`no final assistant reply within ${timeout} ms (progress seen: ${JSON.stringify(progress)})`);
}

async function latestConversation() {
  const list = await api("GET", "/assistant/conversations?all=1");
  return list.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0] ?? null;
}

function briefStep(title, summary, type, args) {
  return { kind: "brief", brief: { title, summary, steps: [], warnings: [], action: { type, args } } };
}

async function runAssistantSteps(page) {
  const A = { mode: ASSISTANT_MODE, fake: false, hook: false, capabilities: null };
  log.assistant = A;

  await step(page, "assistant-preflight", "Assistant capabilities: models, fake or live, speech, storybook auto default", async (rec) => {
    const cap = await api("GET", "/assistant/capabilities");
    A.capabilities = { available: cap.available, models: cap.models.map((m) => `${m.profile}=${m.model_key}${m.fake ? " (fake)" : ""}${m.available ? "" : " UNAVAILABLE"}`), speech: cap.speech?.status };
    A.fake = cap.models.length > 0 && cap.models.every((m) => m.fake);
    if (ASSISTANT_MODE === "1" && !A.fake) throw new Error("QA_ASSISTANT=1 but the assistant models are not all fake");
    try {
      await api("GET", "/_qa/fake_metadata");
      A.hook = A.fake;
    } catch {
      A.hook = false;
    }
    state.assistantReady = cap.available ? true : null;
    state.assistantFake = A.fake ? true : null;
    state.assistantHook = A.hook ? true : null;
    rec.found.capabilities = A.capabilities;
    rec.found.fake_scripting_hook = A.hook;
    if (!A.fake) rec.notes.push("assistant models are live here: steps that call a model are skipped (no spend)");
    if (A.fake && !A.hook) rec.notes.push("no /api/_qa/fake_metadata hook: brief steps are skipped (the plain fake only returns its default answer)");
    if (state.runId) {
      const settings = await api("GET", `/runs/${state.runId}/assistant/settings`);
      const narrator = cap.models.find((m) => m.profile === "narrator");
      rec.found.qa_run_storybook_auto = settings.storybook_auto ?? settings.settings?.storybook_auto ?? settings;
      const auto = typeof rec.found.qa_run_storybook_auto === "boolean" ? rec.found.qa_run_storybook_auto : null;
      const expected = narrator?.fake ? true : false; // the QA run's agents are all fake-heuristic
      rec.found.storybook_auto_expected = expected;
      if (auto !== null && auto !== expected) throw new Error(`storybook auto for an all-fake-agent run is ${auto}, expected ${expected} (narrator ${narrator?.model_key})`);
    }
    if (!cap.available) throw new Error("the assistant reports available=false");
  });

  await step(
    page,
    "assistant-entry-drawer",
    "Entry page: the Assistant pill opens a floating drawer (focus in the composer), hides while open, closes back to the pill",
    async (rec) => {
      await page.setViewportSize(ASSISTANT_VIEW);
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await closeDrawer(page);
      const pill = await waitVisible(page.getByRole("button", { name: /open the assistant/i }), "the Assistant pill");
      rec.found.pill_title = await pill.getAttribute("title");
      rec.found.pill_status = await pill.locator(".assistant-dot").getAttribute("aria-label").catch(() => null);
      rec.found.new_here_link = await textVisible(page, /new here\?/i, 1500);
      await pill.click();
      const drawer = await waitVisible(drawerLoc(page), "the assistant drawer");
      await sleep(300);
      rec.found.drawer_class = await drawer.getAttribute("class");
      rec.found.focus_in_composer = await page.evaluate(() => document.activeElement?.id === "assistant-composer-text");
      rec.found.pill_hidden_while_open = (await page.getByRole("button", { name: /open the assistant/i }).count()) === 0;
      rec.found.suggestions = await drawer.locator(".assistant-suggestion").allInnerTexts();
      rec.found.scroll = await hScroll(page);
      rec.found.drawer_box = roundBox(await drawer.boundingBox());
      if (!/assistant-drawer-floating/.test(rec.found.drawer_class)) throw new Error(`drawer on the entry page is not floating: ${rec.found.drawer_class}`);
      if (!rec.found.pill_hidden_while_open) throw new Error("the pill is still shown while the drawer is open");
      if (rec.found.scroll.overflow) throw new Error(`horizontal scroll with the drawer open: ${JSON.stringify(rec.found.scroll)}`);
      if (!rec.found.focus_in_composer) rec.notes.push("focus did not move to the composer on open");
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-entry-drawer-open.png`) }).catch(() => {});
      await closeDrawer(page);
      await waitVisible(page.getByRole("button", { name: /open the assistant/i }), "the Assistant pill after close");
      rec.found.focus_back_on_launcher = await page.evaluate(() => document.activeElement?.getAttribute("data-control") === "assistant-launcher");
      await page.keyboard.press("Alt+a");
      rec.found.alt_a_opens = await drawerLoc(page).isVisible().catch(() => false);
      await page.keyboard.press("Alt+a");
      await sleep(300);
      rec.found.alt_a_closes = !(await drawerLoc(page).isVisible().catch(() => false));
      if (!rec.found.alt_a_opens || !rec.found.alt_a_closes) rec.notes.push(`Alt+A toggle: opens ${rec.found.alt_a_opens}, closes ${rec.found.alt_a_closes}`);
    },
    { needs: ["assistantReady"] },
  );

  await step(
    page,
    "assistant-run-docked",
    "Run page at 1440x900: the rail-header Assistant button docks the drawer; it covers neither the map nor the side column; no horizontal scroll",
    async (rec) => {
      await page.setViewportSize(ASSISTANT_VIEW);
      await gotoRun(page, state.runId);
      await closeDrawer(page);
      await sleep(400);
      const map = page.locator("main.run-center");
      const side = page.locator("section.run-side");
      const mapClosed = await map.boundingBox();
      const sideClosed = await side.boundingBox();
      state.mapClosed = mapClosed;
      const drawer = await openRailDrawer(page);
      await sleep(600);
      const mapOpen = await map.boundingBox();
      const sideOpen = await side.boundingBox();
      const dBox = await drawer.boundingBox();
      rec.found.map_closed = roundBox(mapClosed);
      rec.found.map_docked = roundBox(mapOpen);
      rec.found.side_closed = roundBox(sideClosed);
      rec.found.side_docked = roundBox(sideOpen);
      rec.found.drawer = roundBox(dBox);
      rec.found.drawer_class = await drawer.getAttribute("class");
      rec.found.map_bbox_unchanged = JSON.stringify(roundBox(mapClosed)) === JSON.stringify(roundBox(mapOpen));
      rec.found.scroll = await hScroll(page);
      rec.found.rail_button_pressed = await page.locator('.run-rail [data-control="assistant-launcher"]').getAttribute("aria-pressed");
      if (!/assistant-drawer-docked/.test(rec.found.drawer_class)) throw new Error(`drawer is not docked at 1440 px: ${rec.found.drawer_class}`);
      if (overlaps(dBox, mapOpen)) throw new Error(`the docked drawer overlaps the map: drawer ${JSON.stringify(roundBox(dBox))} map ${JSON.stringify(roundBox(mapOpen))}`);
      if (overlaps(dBox, sideOpen)) throw new Error("the docked drawer overlaps the side column");
      if (mapOpen.width < 360) throw new Error(`the map is ${Math.round(mapOpen.width)} px wide beside the docked drawer (< MIN_MAP_W 360)`);
      if (rec.found.scroll.overflow) throw new Error(`horizontal scroll with the docked drawer: ${JSON.stringify(rec.found.scroll)}`);
      if (!rec.found.map_bbox_unchanged) rec.notes.push(`docked reserve reflows the page: the map changes from ${Math.round(mapClosed.width)} to ${Math.round(mapOpen.width)} px wide (by design: useRunLayout subtracts the drawer width); it is never covered`);
    },
    { needs: ["assistantReady", "runId"] },
  );

  await step(
    page,
    "assistant-run-floating",
    "Float: the drawer overlays and the map box is exactly the closed-drawer box; Dock again; 1280 px docks at 360 px, 1200 px floats",
    async (rec) => {
      const drawer = await openRailDrawer(page);
      const float = drawer.getByRole("button", { name: /^float$/i });
      await float.click();
      await sleep(600);
      const mapFloat = await page.locator("main.run-center").boundingBox();
      rec.found.drawer_class_float = await drawer.getAttribute("class");
      rec.found.map_floating = roundBox(mapFloat);
      rec.found.map_unchanged_when_floating = JSON.stringify(roundBox(mapFloat)) === JSON.stringify(roundBox(state.mapClosed));
      rec.found.scroll_float = await hScroll(page);
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-run-floating.png`) }).catch(() => {});
      if (!/assistant-drawer-floating/.test(rec.found.drawer_class_float)) throw new Error("Float did not float the drawer");
      if (!rec.found.map_unchanged_when_floating) throw new Error(`floating drawer changed the map box: ${JSON.stringify(roundBox(state.mapClosed))} -> ${JSON.stringify(roundBox(mapFloat))}`);
      await drawer.getByRole("button", { name: /^dock$/i }).click();
      await sleep(500);
      rec.found.drawer_class_redock = await drawer.getAttribute("class");
      if (!/assistant-drawer-docked/.test(rec.found.drawer_class_redock)) throw new Error("Dock did not dock the drawer again");
      const widths = {};
      for (const w of [1280, 1200]) {
        await page.setViewportSize({ width: w, height: 900 });
        await sleep(600);
        const d = await drawerLoc(page).boundingBox();
        const m = await page.locator("main.run-center").boundingBox();
        widths[w] = { drawer_class: await drawerLoc(page).getAttribute("class"), drawer: roundBox(d), map: roundBox(m), overlap: overlaps(d, m), scroll: await hScroll(page) };
      }
      rec.found.widths = widths;
      await page.setViewportSize(ASSISTANT_VIEW);
      await sleep(400);
      if (!/docked/.test(widths[1280].drawer_class) || widths[1280].overlap || widths[1280].map.w < 360 || widths[1280].scroll.overflow) throw new Error(`1280 px docked arithmetic failed: ${JSON.stringify(widths[1280])}`);
      if (!/floating/.test(widths[1200].drawer_class)) throw new Error(`1200 px should float: ${widths[1200].drawer_class}`);
      if (widths[1200].scroll.overflow) throw new Error(`horizontal scroll at 1200 px: ${JSON.stringify(widths[1200].scroll)}`);
    },
    { needs: ["assistantReady", "runId", "mapClosed"] },
  );

  await step(
    page,
    "assistant-tabs-row",
    "Tabs row: five tabs on one line under 34 px at 1280/1440/1920 with 'God mode (3)', drawer closed and docked",
    async (rec) => {
      const staged = [];
      for (let i = 1; i <= 3; i += 1) {
        const r = await api("POST", `/runs/${state.runId}/interventions`, { type: "voice", recipients: { mode: "broadcast_all" }, text: `QA tabs ${i}`, origin: "ui" });
        staged.push(r.staged.at(-1).id);
      }
      try {
        await gotoRun(page, state.runId);
        await waitVisible(page.getByRole("tab", { name: /god mode \(3\)/i }), "the 'God mode (3)' tab");
        const results = {};
        let bad = [];
        for (const w of [1280, 1440, 1920]) {
          for (const open of [false, true]) {
            await page.setViewportSize({ width: w, height: 900 });
            if (open) await openRailDrawer(page);
            else await closeDrawer(page);
            await sleep(500);
            const m = await page.evaluate(() => {
              const tabs = document.querySelector(".tabs");
              if (!tabs) return null;
              const items = [...tabs.querySelectorAll('[role="tab"]')];
              const tops = [...new Set(items.map((t) => Math.round(t.getBoundingClientRect().top)))];
              const tr = tabs.getBoundingClientRect();
              const hidden = items.filter((t) => t.getBoundingClientRect().right > tr.right + 1).map((t) => `${t.innerText.replace(/\s+/g, " ").trim()} (${Math.round(t.getBoundingClientRect().right - tr.right)} px hidden)`);
              return { height: Math.round(tr.height * 10) / 10, count: items.length, lines: tops.length, labels: items.map((t) => t.innerText.replace(/\s+/g, " ").trim()), overflowX: tabs.scrollWidth > tabs.clientWidth, width: Math.round(tabs.clientWidth), scrollWidth: tabs.scrollWidth, clipped: hidden };
            });
            const key = `${w}${open ? "-docked" : ""}`;
            results[key] = m;
            if (!m || m.height >= 34 || m.count !== 5 || m.lines !== 1) bad.push(key);
            if (m?.overflowX) rec.notes.push(`${key}: tabs row scrolls horizontally (${m.width} of ${m.scrollWidth} px visible; clipped: ${m.clipped.join(", ") || "none"})`);
          }
        }
        rec.found.tabs = results;
        await page.setViewportSize(ASSISTANT_VIEW);
        await page.locator(".tabs").screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-tabs-1440-docked.png`) }).catch(() => {});
        await openRailDrawer(page);
        await sleep(400);
        if (bad.length) throw new Error(`tabs row not a single line under 34 px with 5 tabs at: ${bad.join(", ")} (${JSON.stringify(Object.fromEntries(bad.map((k) => [k, results[k]])))})`);
      } finally {
        for (const id of staged) await api("DELETE", `/runs/${state.runId}/interventions/${id}`).catch(() => {});
      }
    },
    { needs: ["assistantReady", "runId"] },
  );

  await step(
    page,
    "assistant-ask-answer",
    "Ask on the run page: the fake answer arrives; the question carries its context chip ('Looking at: run … · turn …')",
    async (rec) => {
      await setFake({}).catch(() => {});
      await page.setViewportSize(ASSISTANT_VIEW);
      await gotoRun(page, state.runId);
      const drawer = await openRailDrawer(page);
      const chip = drawer.locator(".assistant-context-chip");
      rec.found.context_chip_title = await chip.getAttribute("title");
      rec.found.context_chip_checked = await chip.locator("input").isChecked();
      const reply = await askDrawer(page, ASSISTANT_Q);
      rec.found.answer = reply.text.slice(0, 300);
      rec.found.progress_seen = reply.progress;
      const user = drawer.locator("article.assistant-msg-user").last();
      rec.found.user_context_line = (await user.locator(".assistant-msg-ctx").innerText().catch(() => "")).trim();
      if (!/fake assistant/i.test(reply.text)) throw new Error(`unexpected answer: ${reply.text.slice(0, 200)}`);
      if (!/Looking at: run .*turn /i.test(rec.found.user_context_line)) throw new Error(`the question shows no run/turn context chip: '${rec.found.user_context_line}'`);
      const conv = await latestConversation();
      rec.found.conversation = { id: conv?.conversation_id, run_id: conv?.run_id, title: conv?.title };
      if (conv?.run_id !== state.runId) rec.notes.push(`conversation scope is ${conv?.run_id}, expected ${state.runId}`);
    },
    { needs: ["assistantFake", "runId"] },
  );

  await step(
    page,
    "assistant-progress-and-refs",
    "Scripted slow answer: progress line 'step k/4 · Ns · $x' ticks; ref chips (entity, turn, doc) act on the run page",
    async (rec) => {
      const turns = await api("GET", `/runs/${state.runId}/turns`);
      const someTurn = turns[Math.min(3, turns.length - 1)].turn_id;
      await setFake({ chat: { fake_script: [{ kind: "answer", text: `a01 is near the centre; see turn ${someTurn}.`, refs: [{ kind: "entity", id: "a01", label: "a01" }, { kind: "turn", id: someTurn, label: someTurn }, { kind: "doc", id: "SYSTEM.md#overview", label: "System overview" }] }], fake_options: { sleep_ms: 4500 } } });
      const drawer = await openRailDrawer(page);
      // Sample the API job's elapsed_s alongside the UI line.
      const apiElapsed = [];
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          const conv = await latestConversation().catch(() => null);
          if (conv) {
            const v = await api("GET", `/assistant/conversations/${conv.conversation_id}`).catch(() => null);
            if (v?.job && ["queued", "running"].includes(v.job.status)) apiElapsed.push({ elapsed_s: v.job.elapsed_s, step: v.job.step, progress: v.job.progress });
          }
          await sleep(700);
        }
      })();
      const reply = await askDrawer(page, "Where is a01 and what did it do?", 30_000, { afterMs: 2500, path: path.join(OUT_DIR, `${pad(stepCounter)}-progress-midway.png`) }).finally(() => {
        sampling = false;
      });
      await sampler;
      rec.found.progress_ui = reply.progress;
      rec.found.progress_api = apiElapsed;
      const uiSeconds = reply.progress.map((p) => Number((p.text.match(/·\s*(\d+)\s*s/) ?? [])[1] ?? NaN)).filter((n) => !Number.isNaN(n));
      rec.found.ui_seconds = uiSeconds;
      if (!reply.progress.length) rec.notes.push("no progress line was seen during a 4.5 s fake call");
      else if (Math.max(...uiSeconds) === 0) rec.notes.push("the progress line stayed at 0 s for the whole 4.5 s first step");
      const staleHints = reply.progress.filter((p) => /·\s*0 s\s*·/.test(p.hint ?? "") && !/·\s*0 s\s*·/.test(p.text));
      if (staleHints.length) rec.notes.push(`the line under the ticking progress shows the backend's stale '${staleHints[0].hint}' while the line above ticks ('${staleHints.at(-1).text}')`);
      const apiSecs = apiElapsed.map((e) => e.elapsed_s).filter((n) => typeof n === "number");
      if (apiSecs.length && Math.max(...apiSecs) === 0) rec.notes.push("API job.elapsed_s stayed 0 while the first step ran (elapsed is written per step)");
      const refs = reply.article.locator(".assistant-refs button");
      rec.found.ref_chips = (await refs.allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
      if (rec.found.ref_chips.some((t) => /^turn turn /i.test(t))) rec.notes.push("the engine-added 'as of' turn chip reads 'TURN turn <id>' (label repeats the kind)");
      if ((await refs.count()) < 3) throw new Error(`expected 3 ref chips, got ${JSON.stringify(rec.found.ref_chips)}`);
      await reply.article.locator(".assistant-ref-entity").click();
      await sleep(700);
      rec.found.entity_ref_selects = await page.locator("section.run-side").innerText().then((t) => /\ba01\b/.test(t)).catch(() => false);
      // The entity link also opens a01's profile card over the page; close it so the turn link and the history strip are reachable.
      rec.found.entity_ref_opens_card = (await profileCard(page).getAttribute("data-entity-id").catch(() => null)) === "a01";
      await closeProfileCard(page);
      await reply.article.locator(`.assistant-ref-turn[title="turn ${someTurn}"]`).click();
      await sleep(900);
      rec.found.turn_ref_history = await textVisible(page, new RegExp(escapeRe(someTurn)), 2000);
      rec.found.history_strip = await page.locator(".timeline-history").isVisible().catch(() => false);
      if (!rec.found.entity_ref_selects) throw new Error("clicking the entity ref did not show a01 in the side column");
      if (!rec.found.history_strip) rec.notes.push("the turn ref did not show the history strip");
      const back = page.locator(".timeline-history").getByRole("button", { name: /return to live/i });
      if (await back.count()) await back.click();
      await setFake({});
    },
    { needs: ["assistantHook", "runId"] },
  );

  await step(
    page,
    "assistant-first-time-user",
    "First-time user: 'New here? Ask the assistant' prefills the question; the answer links a docs section",
    async (rec) => {
      await closeDrawer(page);
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await closeDrawer(page);
      await page.getByRole("button", { name: /ask the assistant: "what is empyrean/i }).click();
      const drawer = await waitVisible(drawerLoc(page), "the drawer from 'New here?'");
      await sleep(400);
      rec.found.prefilled = await drawer.locator("#assistant-composer-text").inputValue();
      if (rec.found.prefilled !== FIRST_QUESTION) throw new Error(`composer prefilled with '${rec.found.prefilled}'`);
      // A fresh global conversation for the scripted flow.
      const picker = drawer.locator("select").first();
      if ((await picker.locator('option[value="__new"]').count()) > 0) await picker.selectOption("__new");
      await setFake({ chat: { fake_script: [{ kind: "answer", text: "Empyrean is a grid world where LLM agents survive on compute. Start with New session: the defaults create a paused run you step with Run turn.", refs: [{ kind: "doc", id: "SYSTEM.md#overview", label: "System overview" }, { kind: "control", id: "assistant-launcher", label: "Assistant" }] }] } });
      const reply = await askDrawer(page, FIRST_QUESTION);
      rec.found.answer = reply.text.slice(0, 200);
      rec.found.doc_chip = await reply.article.locator(".assistant-ref-doc").count();
      const ctx = (await drawer.locator("article.assistant-msg-user").last().locator(".assistant-msg-ctx").innerText().catch(() => "")).trim();
      rec.found.user_context_line = ctx;
      if (!rec.found.doc_chip) throw new Error("no docs ref chip in the answer");
      await setFake({});
    },
    { needs: ["assistantHook"] },
  );

  await step(
    page,
    "assistant-create-run-brief",
    "Fake create_run brief: the card's deterministic 'What will happen', setup diff and the assistant's description; Approve creates the run and navigates",
    async (rec) => {
      await setFake({ chat: { fake_script: [briefStep(BRIEF_RUN_NAME, "Six fighters in a small arena; Ash hits harder and moving costs less.", "create_run", { name: BRIEF_RUN_NAME, agent_count: 6, overlay: { default_model_key: QA_AGENT_MODEL, agents: [{ name: "Ash", stats: { attack: 3 } }], rules: { prices: { move: 2 } }, play_delay_seconds: 0 } })] } });
      const drawer = await openDrawerAnywhere(page);
      const reply = await askDrawer(page, "Set up a small fight arena with six agents");
      const card = reply.article.locator("section.assistant-brief");
      await waitVisible(card, "the brief card");
      const primary = card.locator(".assistant-brief-primary");
      rec.found.what_will_happen = (await primary.locator(".assistant-brief-label").innerText()).trim();
      rec.found.lines = await primary.locator(".assistant-brief-lines > li").allInnerTexts();
      rec.found.diff_summary = (await card.locator(".assistant-brief-diff summary").innerText().catch(() => "")).trim();
      rec.found.diff = await card.locator(".assistant-brief-difflist li").allInnerTexts();
      rec.found.prose_label = (await card.locator(".assistant-brief-prose .assistant-brief-label").innerText().catch(() => "")).trim();
      rec.found.in_reply_to = (await card.locator(".assistant-brief-reply").innerText().catch(() => "")).trim();
      rec.found.status_badge = (await card.locator(".assistant-brief-head .assistant-badge").innerText()).trim();
      if (!/what will happen/i.test(rec.found.what_will_happen)) throw new Error("no 'What will happen' section");
      if (!rec.found.lines.some((l) => l.includes(`Creates a paused run "${BRIEF_RUN_NAME}" with 6 agents`))) throw new Error(`deterministic line missing: ${JSON.stringify(rec.found.lines)}`);
      if (!rec.found.diff.some((d) => d.includes("rules.prices.move"))) throw new Error(`setup diff lacks rules.prices.move: ${JSON.stringify(rec.found.diff)}`);
      if (!/assistant's description/i.test(rec.found.prose_label)) throw new Error("no \"Assistant's description\" section");
      await card.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-create-run-brief-card.png`) }).catch(() => {});
      const approve = card.getByRole("button", { name: /^approve: create run$/i });
      if (await approve.isDisabled()) throw new Error("Approve: create run is disabled");
      const before = new Set((await api("GET", "/runs")).map((r) => r.run_id));
      await approve.click();
      const runs = await waitApi("the brief's run", () => api("GET", "/runs"), (list) => list.some((r) => !before.has(r.run_id) && r.name === BRIEF_RUN_NAME), 20_000);
      const created = runs.find((r) => !before.has(r.run_id) && r.name === BRIEF_RUN_NAME);
      const briefModels = new Set(Object.values((await api("GET", `/runs/${created.run_id}/settings`)).effective_model_key));
      if (briefModels.size !== 1 || !briefModels.has(QA_AGENT_MODEL)) throw new Error(`the brief's run uses ${[...briefModels]} (expected only ${QA_AGENT_MODEL}); no turn will be run on it`);
      state.briefRunId = created.run_id;
      rec.found.run = created.run_id;
      await waitApi("navigation to the new run", async () => page.url(), (u) => u.includes(`#/run/${created.run_id}`), 10_000);
      await waitVisible(page.locator("main.run-center"), "the new run page");
      await sleep(800);
      rec.found.now_about = (await drawerLoc(page).locator(".assistant-banner-info").innerText().catch(() => "")).trim();
      const conv = await latestConversation();
      rec.found.conversation_run_id = conv?.run_id;
      rec.found.brief_status_after = (await drawerLoc(page).locator("section.assistant-brief .assistant-brief-head .assistant-badge").last().innerText().catch(() => "")).trim();
      const s = await status(created.run_id);
      rec.found.new_run_state = s.state;
      const init = await api("GET", `/runs/${created.run_id}/turns/r00000_init`);
      rec.found.a01 = { name: init.entities.agents.a01?.name, attack: init.entities.agents.a01?.stats?.attack };
      if (s.state !== "paused") throw new Error(`new run state ${s.state}`);
      if (conv?.run_id !== created.run_id) throw new Error(`conversation not rebound: ${conv?.run_id}`);
      if (!/now about/i.test(rec.found.now_about)) rec.notes.push("no 'Now about: <run>' banner after approval");
      await setFake({});
    },
    { needs: ["assistantHook"] },
  );

  await step(
    page,
    "assistant-interventions-brief",
    "Fake stage_interventions brief with an unknown entity shows its validation problem (Approve disabled); Ask for changes -> corrected brief -> Approve stages it",
    async (rec) => {
      const drawer = await openRailDrawer(page);
      // The engine gives a brief with fixable validation problems ONE repair step, so the fake chat
      // model must answer the repair call with the same invalid brief for the card to appear.
      const badBrief = briefStep("Boost", "Set compute of the selected agent to 50.", "stage_interventions", { interventions: [{ type: "set_stat", entity_id: "zz99", field: "stats.compute", value: 50 }] });
      await setFake({ chat: { fake_script: [badBrief, badBrief] } });
      const reply = await askDrawer(page, "Give the selected agent 50 compute");
      const card = reply.article.locator("section.assistant-brief");
      await waitVisible(card, "the interventions brief card");
      rec.found.problems = await card.locator(".assistant-brief-problems li").allInnerTexts();
      rec.found.lines = await card.locator(".assistant-brief-primary .assistant-brief-lines > li").allInnerTexts();
      const approve = card.getByRole("button", { name: /^approve: stage 1 edit$/i });
      rec.found.approve_disabled = await approve.isDisabled();
      await card.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-interventions-brief-problem.png`) }).catch(() => {});
      if (!rec.found.problems.some((p) => /interventions\[0\]\.entity_id/.test(p) && /zz99/.test(p))) throw new Error(`validation problem not shown: ${JSON.stringify(rec.found.problems)}`);
      if (!rec.found.approve_disabled) throw new Error("Approve is enabled on an invalid brief");
      await card.getByRole("button", { name: /^ask for changes$/i }).click();
      await sleep(300);
      rec.found.composer_quote = await drawer.locator("#assistant-composer-text").inputValue();
      rec.found.waiting = await card.locator(".assistant-brief-waiting").isVisible().catch(() => false);
      await setFake({ chat: { fake_script: [briefStep("Boost", "Set compute of a01 to 50.", "stage_interventions", { interventions: [{ type: "set_stat", entity_id: "a01", field: "stats.compute", value: 50 }] })] } });
      const fixed = await askDrawer(page, `${rec.found.composer_quote}\nI meant a01`);
      const card2 = fixed.article.locator("section.assistant-brief");
      await waitVisible(card2, "the corrected brief card");
      rec.found.old_status = (await card.locator(".assistant-brief-head .assistant-badge").innerText()).trim();
      rec.found.new_lines = await card2.locator(".assistant-brief-primary .assistant-brief-lines > li").allInnerTexts();
      const approve2 = card2.getByRole("button", { name: /^approve: stage 1 edit$/i });
      if (await approve2.isDisabled()) throw new Error("Approve is disabled on the corrected brief");
      await approve2.click();
      await waitVisible(card2.locator(".assistant-brief-result"), "the executed result");
      rec.found.result = (await card2.locator(".assistant-brief-result").innerText()).replace(/\s+/g, " ").trim();
      const staged = (await api("GET", `/runs/${state.briefRunId}/interventions`)).staged;
      rec.found.staged = staged.map((iv) => ({ id: iv.id, type: iv.type, origin: iv.origin, note: iv.note }));
      if (!staged.some((iv) => iv.origin === "assistant" && iv.type === "set_stat")) throw new Error("no assistant-origin set_stat staged");
      if (!/replaced/i.test(rec.found.old_status)) rec.notes.push(`old brief status '${rec.found.old_status}' (expected 'replaced by a newer proposal')`);
      await setFake({});
    },
    { needs: ["assistantHook", "briefRunId"] },
  );

  await step(
    page,
    "assistant-godmode-badge",
    "'Open God mode (1 staged)' opens God mode; the staged list shows the assistant origin badge",
    async (rec) => {
      const drawer = drawerLoc(page);
      const open = drawer.getByRole("button", { name: /open god mode \(1 staged\)/i });
      await open.click();
      await sleep(700);
      rec.found.god_tab_selected = await page.getByRole("tab", { name: /god mode/i }).getAttribute("aria-selected");
      const t0 = Date.now();
      let badges = [];
      while (Date.now() - t0 < 8000) {
        badges = await page.locator("section.run-side .insp-badge").allInnerTexts();
        if (badges.some((b) => /^assistant$/i.test(b.trim()))) break;
        await sleep(500);
      }
      rec.found.god_tab_label = (await page.getByRole("tab", { name: /god mode/i }).innerText()).trim();
      rec.found.rail_staged_edits = (await page.locator(".run-rail").innerText()).match(/STAGED EDITS\s*(\d+)/i)?.[1] ?? null;
      if (!badges.some((b) => /^assistant$/i.test(b.trim()))) {
        await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-godmode-before-reload.png`) }).catch(() => {});
        rec.notes.push(`the staged edit did not show within 8 s of approval (tab '${rec.found.god_tab_label}', rail staged edits ${rec.found.rail_staged_edits}); reloading the page`);
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitVisible(page.locator("main.run-center"), "the run page after reload");
        await page.getByRole("tab", { name: /god mode/i }).click();
        await sleep(800);
        badges = await page.locator("section.run-side .insp-badge").allInnerTexts();
        rec.found.after_reload = { tab: (await page.getByRole("tab", { name: /god mode/i }).innerText()).trim(), badges };
        if (badges.some((b) => /^assistant$/i.test(b.trim()))) throw new Error(`the assistant-staged edit only appears after a page reload (before: tab '${rec.found.god_tab_label}', rail staged edits ${rec.found.rail_staged_edits})`);
      }
      rec.found.badge_ms = Date.now() - t0;
      rec.found.badges = badges;
      if (!badges.some((b) => /^assistant$/i.test(b.trim()))) throw new Error(`no 'assistant' badge in the staged list: ${JSON.stringify(badges)}`);
      const badge = page.locator("section.run-side .insp-badge", { hasText: /^assistant$/i }).first();
      rec.found.staged_row = (await badge.locator("xpath=..").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    },
    { needs: ["assistantHook", "briefRunId"] },
  );

  await step(
    page,
    "assistant-storybook-readonly",
    "Storybook tab on the QA run (read-only, never presses Write missing): label, Auto on/off per the default rule, status line",
    async (rec) => {
      await gotoRun(page, state.runId);
      const cap = await api("GET", "/assistant/capabilities");
      const narratorFake = cap.models.find((m) => m.profile === "narrator")?.fake ?? false;
      await page.getByRole("tab", { name: /storybook|^story$/i }).click();
      await waitVisible(page.locator(".storybook-status"), "the storybook status line");
      await sleep(1200);
      rec.found.narrator_fake = narratorFake;
      rec.found.label = await textVisible(page, /AI-written narrative; the Turn record has the facts/, 2000);
      rec.found.auto_button = (await page.locator(".storybook-auto").innerText()).trim();
      rec.found.status_line = (await page.locator(".storybook-status-parts").innerText()).trim();
      const missingBtn = page.locator(".storybook-status").getByRole("button", { name: /write missing/i });
      rec.found.write_missing = (await missingBtn.count()) ? (await missingBtn.first().innerText()).trim() : null;
      const hint = page.locator(".storybook-list > .hint");
      rec.found.empty_hint = (await hint.count()) ? (await hint.first().innerText()).trim() : null;
      rec.found.entries_listed = await page.locator(".storybook-entry-heading").count();
      const expectAuto = narratorFake; // QA run agents are all fake: a paid narrator keeps auto off
      if (!rec.found.label) throw new Error("the 'AI-written narrative' label is missing");
      if (/auto on/i.test(rec.found.auto_button) !== expectAuto) throw new Error(`storybook shows '${rec.found.auto_button}', expected Auto ${expectAuto ? "on" : "off"} (narrator fake: ${narratorFake})`);
    },
    { needs: ["assistantReady", "runId"] },
  );

  await step(
    page,
    "assistant-storybook",
    "Storybook tab on a fake run (auto on): status line and entries appear as turns commit",
    async (rec) => {
      const runId = state.briefRunId ?? state.runId;
      await gotoRun(page, runId);
      const settings = await api("GET", `/runs/${runId}/assistant/settings`);
      rec.found.settings = settings;
      for (let i = 0; i < 2; i += 1) {
        const before = (await status(runId)).current_turn_id;
        await clickRunControl(page, rec, "Run turn", RE.runTurn);
        await waitApi("a committed turn", () => status(runId), (s) => s.state === "paused" && s.current_turn_id !== before, 30_000);
      }
      await page.getByRole("tab", { name: /storybook|^story$/i }).click();
      const sb = await waitApi("storybook entries", () => api("GET", `/runs/${runId}/assistant/storybook`), (v) => (v.entries?.length ?? 0) >= 2, 30_000);
      rec.found.api = { entries: sb.entries.length, opening: !!sb.opening, status: sb.status ? { auto: sb.status.auto, auto_state: sb.status.auto_state, pending: sb.status.pending_count, missing: sb.status.missing_count, spent: sb.status.spend?.spent_usd } : null };
      await sleep(3000);
      rec.found.label = await textVisible(page, /AI-written narrative; the Turn record has the facts/, 2000);
      rec.found.auto_button = (await page.locator(".storybook-auto").innerText().catch(() => "")).trim();
      rec.found.status_line = (await page.locator(".storybook-status-parts").innerText().catch(() => "")).trim();
      rec.found.entry_headings = (await page.locator(".storybook-entry-heading").allInnerTexts()).slice(0, 6).map((t) => t.replace(/\s+/g, " "));
      rec.found.first_entry = (await page.locator(".storybook-text").first().innerText().catch(() => "")).slice(0, 200);
      rec.found.story_link = await page.locator(".storybook").getByRole("button", { name: /make a story of this run/i }).count();
      if (!/auto on/i.test(rec.found.auto_button)) throw new Error(`auto is '${rec.found.auto_button}' on a fake-narrator run`);
      if (!/entr(y|ies)/.test(rec.found.status_line)) throw new Error(`no status line: '${rec.found.status_line}'`);
      if (rec.found.entry_headings.length < 2) throw new Error(`only ${rec.found.entry_headings.length} entries rendered`);
    },
    { needs: ["assistantFake"] },
  );

  await step(
    page,
    "assistant-escape-record-viewer",
    "Escape inside the drawer closes the drawer but not the record viewer underneath",
    async (rec) => {
      const turns = await api("GET", `/runs/${state.runId}/turns`);
      const modelTurn = [...turns].reverse().find((t) => t.kind === "agent_turn" && t.decision_source === "model");
      if (!modelTurn) throw new Error("no model turn to open a record for");
      await gotoRun(page, state.runId, modelTurn.turn_id);
      await closeDrawer(page);
      await page.getByRole("tab", { name: /turn record/i }).click();
      await sleep(600);
      const opener = await findOne(clickables(page.locator("section.run-side"), /decision packet|model call|mc_r\d+|pk_r\d+/i), 3000);
      if (!opener) throw new Error("no record link (decision packet / model call) in the Turn record tab");
      rec.found.record_opener = opener.how;
      await opener.locator.click();
      const viewer = await waitVisible(page.locator("section.record-viewer"), "the record viewer");
      rec.found.record_title = await viewer.getAttribute("aria-label");
      await openRailDrawer(page);
      await sleep(400);
      rec.found.focus_in_drawer = await page.evaluate(() => !!document.activeElement?.closest('aside[aria-label="Assistant"]'));
      await page.keyboard.press("Escape");
      await sleep(500);
      rec.found.drawer_closed = !(await drawerLoc(page).isVisible().catch(() => false));
      rec.found.record_viewer_still_open = await page.locator("section.record-viewer").isVisible().catch(() => false);
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-after-escape.png`) }).catch(() => {});
      if (!rec.found.focus_in_drawer) rec.notes.push("focus was not inside the drawer when Escape was pressed");
      if (!rec.found.drawer_closed) throw new Error("Escape inside the drawer did not close it");
      if (!rec.found.record_viewer_still_open) throw new Error("Escape inside the drawer also closed the record viewer");
      await page.keyboard.press("Escape");
      await sleep(400);
      rec.found.second_escape_closes_viewer = !(await page.locator("section.record-viewer").isVisible().catch(() => false));
    },
    { needs: ["assistantReady", "runId"] },
  );

  await step(
    page,
    "story-mode",
    "Story Mode: run picker, step-0 run card with chips, brief with both estimates, Accept, first chapters, Export Markdown",
    async (rec) => {
      await closeDrawer(page);
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: /story mode/i }).first().click();
      await waitApi("#/story", async () => page.url(), (u) => /#\/story\/?$/.test(u), 5000);
      const summary = (await api("GET", "/runs")).find((r) => r.run_id === state.runId);
      const row = page.getByRole("row").filter({ has: page.getByText(summary.name, { exact: true }) });
      await waitVisible(row, `the run '${summary.name}' in the picker`);
      rec.found.picker_rows = await page.getByRole("row").count();
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-story-picker.png`) }).catch(() => {});
      await row.getByRole("button", { name: /^story$/i }).click();
      await page.getByRole("button", { name: /^new story$/i }).click();
      await waitVisible(page.getByRole("heading", { name: /^cast$/i }), "the step-0 run card");
      rec.found.card_headings = await page.locator(".storymode-card h2, .storymode-card h3").allInnerTexts();
      rec.found.chip_groups = await page.locator('.storymode-chips[role="group"]').evaluateAll((els) => els.map((e) => `${e.getAttribute("aria-label")}: ${[...e.querySelectorAll("button")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.innerText.trim()).join("/")}`));
      rec.found.story_dictate = await page.getByRole("button", { name: /dictate to the story author/i }).count();
      rec.found.step0_model_calls = null;
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-story-step0.png`) }).catch(() => {});
      if (rec.found.chip_groups.length < 4) throw new Error(`expected quick-pick chip groups, got ${JSON.stringify(rec.found.chip_groups)}`);
      await page.getByRole("button", { name: /^write the story brief$/i }).click();
      const brief = await waitVisible(page.locator("section.storymode-brief"), "the story brief", 30_000);
      await sleep(500);
      rec.found.estimates = (await brief.locator('[role="radio"]').allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
      if (rec.found.estimates.length !== 2 || !/per turn/i.test(rec.found.estimates[0]) || !/per round/i.test(rec.found.estimates[1])) throw new Error(`expected per-turn and per-round estimates: ${JSON.stringify(rec.found.estimates)}`);
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-story-brief.png`), fullPage: true }).catch(() => {});
      const accept = brief.getByRole("button", { name: /^accept: write/i });
      rec.found.accept_label = (await accept.innerText()).trim();
      await accept.click();
      await waitVisible(page.locator(".storymode-progress"), "the reader", 20_000);
      // Wait for the page's own count ("1 of 11 chapters written"; the story view is polled every 2.5 s), not for any
      // reader text: the chapter list alone is longer than 80 characters, so a text-length wait passed at once.
      await waitApi("chapter 1 counted in the reader", async () => (await page.locator(".storymode-progress").innerText().catch(() => "")).replace(/\s+/g, " ").trim(), (t) => /^[1-9]\d* of \d+ chapters? written/.test(t), 30_000).catch(() => {});
      await sleep(2500);
      rec.found.progress = (await page.locator(".storymode-progress").innerText()).replace(/\s+/g, " ").trim();
      rec.found.chapter_heading = (await page.locator(".storymode-reader h2, main h2").last().innerText().catch(() => "")).trim();
      const url = page.url();
      const m = url.match(/#\/story\/([^/]+)\/([^/?]+)/);
      if (m) {
        const v = await api("GET", `/runs/${m[1]}/assistant/stories/${m[2]}`);
        rec.found.api = { status: v.session.status, chapters_done: v.session.chapters_done, chapters_total: v.session.chapters_total, chapters: v.chapters.map((c) => `${c.number}:${c.kind}`) };
        state.storyId = m[2];
      }
      if (!rec.found.api || rec.found.api.chapters_done < 1) throw new Error(`no chapter written: ${JSON.stringify(rec.found.api)}`);
      const exportBtn = page.getByRole("button", { name: /^export markdown$/i });
      if (await exportBtn.isDisabled()) throw new Error("Export Markdown is disabled after chapter 1");
      const [download] = await Promise.all([page.waitForEvent("download", { timeout: 10_000 }), exportBtn.click()]);
      const file = path.join(OUT_DIR, `story-export-${download.suggestedFilename()}`);
      await download.saveAs(file);
      const md = await fs.readFile(file, "utf8");
      rec.found.export = { file: path.basename(file), bytes: md.length, first_line: md.split("\n")[0].slice(0, 120) };
      if (!md.startsWith("# ")) throw new Error(`export does not start with a Markdown title: ${md.slice(0, 80)}`);
    },
    { needs: ["assistantFake", "runId"] },
  );

  await step(
    page,
    "assistant-dictate",
    "Dictate: present in the composer; enabled on a secure origin only when speech is ready; disabled with its reason on a non-secure origin",
    async (rec) => {
      await page.setViewportSize(ASSISTANT_VIEW);
      const cap = await api("GET", "/assistant/capabilities");
      rec.found.speech = cap.speech;
      const probe = async (p) => {
        const drawer = await waitVisible(drawerLoc(p), "the drawer");
        const b = drawer.locator('[data-control="dictate"]');
        await waitVisible(b, "the Dictate button");
        // The button starts as "Checking whether speech is available…" (disabled) until the capabilities answer; read the settled state.
        await waitApi("the Dictate availability check", async () => (await b.getAttribute("title")) ?? "", (t) => !/^checking whether speech/i.test(t), 10_000).catch(() => {});
        return { secure: await p.evaluate(() => window.isSecureContext), aria_disabled: await b.getAttribute("aria-disabled"), title: await b.getAttribute("title"), label: await b.getAttribute("aria-label") };
      };
      const origins = {};
      for (const base of [BASE_URL, BASE_URL.replace("127.0.0.1", "localhost")]) {
        await page.goto(base, { waitUntil: "domcontentloaded" });
        await page.keyboard.press("Alt+a");
        if (!(await drawerLoc(page).isVisible().catch(() => false))) await page.getByRole("button", { name: /open the assistant/i }).click();
        origins[base] = await probe(page);
        await closeDrawer(page);
      }
      const insecureUrl = BASE_URL.replace(/\/\/[^/:]+/, `//${INSECURE_HOST}`);
      const browser2 = await chromium.launch({ headless: HEADLESS, args: [`--host-resolver-rules=MAP ${INSECURE_HOST} 127.0.0.1`] });
      try {
        const p2 = await (await browser2.newContext({ viewport: ASSISTANT_VIEW })).newPage();
        const resp = await p2.goto(insecureUrl, { waitUntil: "domcontentloaded" });
        if (!resp || resp.status() >= 400) {
          origins[insecureUrl] = { skipped: `HTTP ${resp?.status()} (the dev server does not allow Host ${INSECURE_HOST}; add it to server.allowedHosts)` };
        } else {
          await p2.getByRole("button", { name: /open the assistant/i }).click();
          const r = await probe(p2);
          await drawerLoc(p2).locator('[data-control="dictate"]').click({ force: true });
          await sleep(300);
          r.message_after_click = (await drawerLoc(p2).locator(".dictate-message").innerText().catch(() => "")).trim();
          r.phase_after_click = await drawerLoc(p2).locator('[data-control="dictate"]').getAttribute("data-phase");
          origins[insecureUrl] = r;
          await p2.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-dictate-insecure.png`) }).catch(() => {});
        }
      } finally {
        await browser2.close();
      }
      rec.found.origins = origins;
      const ready = cap.speech?.status === "ready";
      for (const [url, r] of Object.entries(origins)) {
        if (r.skipped) {
          rec.notes.push(`${url}: not checked: ${r.skipped}`);
          continue;
        }
        const disabled = r.aria_disabled === "true";
        const shouldBe = !(r.secure && ready);
        if (disabled !== shouldBe) throw new Error(`${url}: secure=${r.secure}, speech ${cap.speech?.status}: Dictate aria-disabled=${r.aria_disabled}, expected ${shouldBe}`);
        if (!r.secure && !/secure page/i.test(r.title ?? "")) throw new Error(`${url}: non-secure origin without the 'secure page' reason: ${r.title}`);
        if (!r.secure && r.phase_after_click !== "idle") throw new Error(`${url}: clicking the blocked Dictate started ${r.phase_after_click}`);
      }
      const on127 = origins[BASE_URL];
      if (on127?.secure) rec.notes.push("http://127.0.0.1 IS a secure context in Chromium (loopback is potentially trustworthy); only a non-loopback host such as the machine's IP is insecure");
    },
    { needs: ["assistantReady"] },
  );
}

main()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    console.error("browser check aborted:", error);
    log.fatal = String(error?.stack ?? error).slice(0, 2000);
    await fs.mkdir(OUT_DIR, { recursive: true }).catch(() => {});
    await writeLog().catch(() => {});
    process.exit(2);
  });
