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
//      QA_RUN_NAME (default "qa browser <timestamp>"), QA_SKIP_ERROR_STEP=1.
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
