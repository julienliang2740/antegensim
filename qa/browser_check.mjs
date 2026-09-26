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
//      QA_RUN_ID=<run> (assistant steps only), QA_INSECURE_HOST (default qa-insecure.test).
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

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

async function step(page, id, title, fn, { needs = [] } = {}) {
  stepCounter += 1;
  const rec = { n: stepCounter, id, title, ok: null, skipped: null, notes: [], found: {}, error: null, screenshot: null, ms: 0 };
  const started = Date.now();
  const missing = needs.filter((key) => !state[key]);
  if (missing.length) {
    rec.skipped = `needs ${missing.join(", ")} from an earlier step`;
  } else {
    try {
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
  runTurn: /run turn/i,
  play: /^\s*(▶\s*)?play\b/i,
  pause: /^\s*(⏸\s*)?pause\b/i,
  stepRound: /step round/i,
  create: /create( run| session)?|start( run| session| simulation)?|launch|begin/i,
  validate: /validate|check setup/i,
  previous: /^(?!.*\bpan\b).*(previous|prev\b|earlier|◀|←|‹)/i,
  next: /^(?!.*\bpan\b).*(\bnext\b|later|▶|→|›)/i,
  live: /return to live|back to live|go live|^live$|live view/i,
  godMode: /god mode/i,
  back: /back to (sessions|start|entry)|sessions|leave|exit|close run|home|entry/i,
  recover: /recover|pause/i,
};

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
  const box = await findOne([...fields(page, /go to|search|find|lookup|entity id|e\.g\. a05/i)], 1500);
  if (box) {
    await box.locator.fill(entityId);
    await box.locator.press("Enter");
    rec.notes.push(`selected ${entityId} via ${box.how} + Enter`);
    return true;
  }
  return false;
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
      await tryFind(rec, "model choice in setup", fields(page, /model/i));
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
      const previous = await mustFind(rec, "previous arrow", clickables(page, RE.previous));
      await previous.click();
      await sleep(600);
      rec.found.history_indicator = await textVisible(page, /history|historical|viewing/i, 3000);
      await previous.click().catch(() => {});
      await sleep(400);
      const next = await tryFind(rec, "next arrow", clickables(page, RE.next));
      if (next) await next.click();
      const turns = await api("GET", `/runs/${state.runId}/turns`);
      const target = turns[Math.min(2, turns.length - 1)].turn_id;
      const selector = await findOne([...fields(page, /turn/i), ["combobox", page.getByRole("combobox")]], 2000);
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
    "Select each occupant of that coordinate and see its inspector (U1, U2)",
    async (rec) => {
      const results = {};
      for (const id of state.crowded.ids.slice(0, 8)) {
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
        const inspector = await textVisible(page, /stats|health|compute|species|available/i, 1500);
        results[id] = inspector ? `selected via ${item.how}` : `clicked via ${item.how}, no inspector details`;
      }
      rec.found.occupants = results;
      const failed = Object.entries(results).filter(([, v]) => !v.startsWith("selected"));
      if (failed.length) throw new Error(`occupants without an inspector: ${JSON.stringify(Object.fromEntries(failed))}`);
    },
    { needs: ["runId", "crowded"] },
  );

  await step(
    page,
    "agent-inspector",
    "Agent inspector: stats, skills, knowledge, decision packet and model call (U2)",
    async (rec) => {
      const turns = await api("GET", `/runs/${state.runId}/turns`);
      const modelTurn = [...turns].reverse().find((t) => t.kind === "agent_turn" && t.decision_source === "model");
      if (!modelTurn) throw new Error("no model-decision turn to inspect");
      const agentId = modelTurn.acting_agent_id;
      rec.found.agent = agentId;
      if (!(await selectAgentOrEntity(page, rec, agentId))) throw new Error(`could not select agent ${agentId}`);
      await sleep(600);
      for (const [label, re] of [
        ["stats", /stats|health/i],
        ["compute balance", /compute/i],
        ["skills", /skill/i],
        ["knowledge", /knowledge|notebook|memory/i],
        ["model assignment", /model/i],
      ]) {
        rec.found[`section ${label}`] = await textVisible(page, re, 1500);
      }
      let packet = await findOne(clickables(page, /decision packet|packet/i), 2500);
      if (!packet) {
        // The packet belongs to a turn: view the agent's model turn from history.
        const selector = await findOne([["combobox", page.getByRole("combobox")]], 1000);
        if (selector) {
          const options = await selector.locator.locator("option").allTextContents().catch(() => []);
          const option = options.find((o) => o.includes(modelTurn.turn_id));
          if (option) await selector.locator.selectOption({ label: option });
        }
        await selectAgentOrEntity(page, rec, agentId);
        packet = await findOne(clickables(page, /decision packet|packet/i), 2500);
      }
      if (!packet) throw new Error("no decision packet control in the agent inspector");
      rec.found["decision packet control"] = packet.how;
      await packet.locator.click();
      await sleep(800);
      rec.found.packet_content = await textVisible(page, /stable rules|stable_rules|pk_r\d+|situation|decision request/i, 3000);
      await page.screenshot({ path: path.join(OUT_DIR, `${pad(stepCounter)}-decision-packet.png`) }).catch(() => {});
      const call = await findOne(clickables(page, /model call|mc_r\d+/i), 2000);
      if (call) {
        await call.locator.click();
        await sleep(600);
        rec.found.model_call_content = await textVisible(page, /tokens|usage|latency|mc_r\d+/i, 2000);
      } else {
        rec.notes.push("no model call control found");
      }
      if (!rec.found.packet_content) throw new Error("the decision packet view shows no packet content");
    },
    { needs: ["runId"] },
  );

  await step(
    page,
    "plant-rules",
    "Plant inspector shows the instance and its species rule; the rule editor stages a species change (U3)",
    async (rec) => {
      const live = await api("GET", `/runs/${state.runId}/state`);
      const plant = Object.values(live.entities.plants).find((p) => p.alive);
      if (!plant) throw new Error("no living plant in the run");
      rec.found.plant = plant.id;
      if (!(await selectAgentOrEntity(page, rec, plant.id))) throw new Error(`could not select plant ${plant.id}`);
      await sleep(600);
      rec.found.species_shown = await textVisible(page, new RegExp(escapeRe(plant.species)), 2000);
      rec.found.stage_shown = await textVisible(page, /sprout|sapling|mature|stage/i, 1500);
      rec.found.instance_vs_rule_labels = await textVisible(page, /species rule|instance/i, 1500);
      const stagedBefore = (await api("GET", `/runs/${state.runId}/interventions`)).staged.length;
      const field = await tryFind(rec, "fruit energy field", fields(page, /fruit energy/i));
      if (!field) throw new Error("no editable 'fruit energy' species rule field");
      await fillField(field, 70);
      const stage = await mustFind(rec, "stage plant rule", clickables(page, /stage|apply|save/i));
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
    },
    { needs: ["runId"] },
  );

  await step(
    page,
    "god-mode",
    "God mode: change a context setting and send a voice; staged, then applied after a turn (U7, U8, U16)",
    async (rec) => {
      await page.keyboard.press("Escape").catch(() => {});
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
        const request = await api("GET", "/defaults?agent_count=8");
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

  if (ASSISTANT_MODE !== "0") await runAssistantSteps(page);
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
    const line = drawer.locator(".assistant-progress-line");
    if (await line.count()) {
      const t = (await line.first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      const hint = (await drawer.locator("article.assistant-msg-progress .hint").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
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
      await reply.article.locator(`.assistant-ref-turn[title="turn ${someTurn}"]`).click();
      await sleep(900);
      rec.found.turn_ref_history = await textVisible(page, new RegExp(escapeRe(someTurn)), 2000);
      rec.found.history_strip = await page.locator(".map-history-strip").isVisible().catch(() => false);
      if (!rec.found.entity_ref_selects) throw new Error("clicking the entity ref did not show a01 in the side column");
      if (!rec.found.history_strip) rec.notes.push("the turn ref did not show the history strip");
      const back = page.locator(".map-history-strip").getByRole("button", { name: /back to live/i });
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
      await setFake({ chat: { fake_script: [briefStep(BRIEF_RUN_NAME, "Six fighters in a small arena; Ash hits harder and moving costs less.", "create_run", { name: BRIEF_RUN_NAME, agent_count: 6, overlay: { agents: [{ name: "Ash", stats: { attack: 3 } }], rules: { prices: { move: 2 } }, play_delay_seconds: 0 } })] } });
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
      await waitApi("chapter 1 text", async () => (await page.locator(".storymode-chapter-text, .storymode-reader article, .storymode-reader").first().innerText().catch(() => "")).length, (n) => n > 80, 30_000).catch(() => {});
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
