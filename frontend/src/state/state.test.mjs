// Unit tests for the app shell's pure modules (src/state/*.ts, the hash router's parser).
//
// The frontend has no test runner dependency, so this file uses node:test and the
// TypeScript compiler that is already installed: each module is transpiled (types
// erased, nothing type-checked; `npm run build` does that) into
// node_modules/.cache/empyrean-state-test/ and imported from there.
//
// Run from frontend/:  node src/state/state.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(SRC, "..", "node_modules", ".cache", "empyrean-state-test");
const MODULES = [
  "api/types.ts",
  "state/feed.ts",
  "state/timeline.ts",
  "state/statusText.ts",
  "state/setupForm.ts",
  "state/points.ts",
  "state/records.ts",
  "state/changes.ts",
  "hooks/useHashRoute.ts",
  "state/assistantContext.ts",
  "state/assistantFormat.ts",
  "state/storyMode.ts",
  "components/inspect/format.ts",
  "components/inspect/logic.ts",
  "state/working.ts",
  "state/assistantBrief.ts",
  "state/selection.ts",
];

function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const rel of MODULES) {
    const source = fs.readFileSync(path.join(SRC, rel), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
      fileName: rel,
    });
    // Relative specifiers need an explicit extension under Node's ESM resolver.
    const fixed = outputText.replace(/from "(\.{1,2}\/[^"]+?)(\.tsx?)?"/g, (_m, spec) => `from "${spec}.mjs"`);
    const target = path.join(OUT, rel.replace(/\.tsx?$/, ".mjs"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fixed);
  }
}

build();
const load = (rel) => import(pathToFileURL(path.join(OUT, rel)).href);
const feed = await load("state/feed.mjs");
const timeline = await load("state/timeline.mjs");
const statusText = await load("state/statusText.mjs");
const setup = await load("state/setupForm.mjs");
const points = await load("state/points.mjs");
const router = await load("hooks/useHashRoute.mjs");
const records = await load("state/records.mjs");
const changes = await load("state/changes.mjs");
const assistantContext = await load("state/assistantContext.mjs");
const assistantBrief = await load("state/assistantBrief.mjs");
const assistantFormat = await load("state/assistantFormat.mjs");
const storyMode = await load("state/storyMode.mjs");
const working = await load("state/working.mjs");
const selection = await load("state/selection.mjs");

// ---------------------------------------------------------------- fixtures

function event(seq, overrides = {}) {
  return {
    seq,
    turn_id: "r00001_t01_a03",
    round: 1,
    turn: 1,
    actor: "a03",
    kind: "action",
    summary: `event ${seq}`,
    details: {},
    costs: { compute: 0, essence: 0 },
    pending: false,
    timestamp: "",
    ...overrides,
  };
}

function status(overrides = {}) {
  return {
    run_id: "run_x",
    world_id: "world_x",
    state: "paused",
    round: 1,
    turn_index: 1,
    acting_agent_id: "a03",
    next_agent_id: "a01",
    next_step: "agent_turn",
    current_turn_id: "r00001_t01_a03",
    active_turn_id: null,
    active_command: null,
    last_error: null,
    pending_model_call: null,
    staged_intervention_count: 0,
    latest_seq: 10,
    feed_epoch: "e1",
    living_agent_count: 8,
    finished_reason: null,
    play_loop: false,
    real_usage: { calls: 0, interrupted_calls: 0, input_tokens: 0, output_tokens: 0, provider_cost_usd: 0 },
    ...overrides,
  };
}

function entry(turn_id, overrides = {}) {
  const parsed = /^r(\d+)_(?:t(\d+)_(.+)|end|init)$/.exec(turn_id);
  const round = parseInt(parsed[1], 10);
  const kind = turn_id.endsWith("_init") ? "init" : turn_id.endsWith("_end") ? "round_end" : "agent_turn";
  return {
    turn_id,
    kind,
    round,
    turn_index: parsed[2] ? parseInt(parsed[2], 10) : null,
    acting_agent_id: parsed[3] ?? null,
    action_name: kind === "agent_turn" ? "observe" : null,
    ok: kind === "agent_turn" ? true : null,
    decision_source: kind === "agent_turn" ? "model" : "none",
    intervention_count: 0,
    event_count: 3,
    saved_at: "",
    ...overrides,
  };
}

const TURNS = ["r00000_init", "r00001_t01_a03", "r00001_t02_a01", "r00001_end", "r00002_t01_a01", "r00002_t02_a03"].map((id) => entry(id));
const name = (id) => (id ? `${id} Name` : "none");

// ---------------------------------------------------------------- feed

test("mergeEvents drops duplicate seqs, keeps seq order and caps the length", () => {
  const merged = feed.mergeEvents([event(1), event(2)], [event(2), event(4), event(3)]);
  assert.deepEqual(
    merged.map((e) => e.seq),
    [1, 2, 3, 4],
  );
  const many = Array.from({ length: feed.MAX_FEED_EVENTS + 5 }, (_, i) => event(i + 1));
  const capped = feed.mergeEvents([], many);
  assert.equal(capped.length, feed.MAX_FEED_EVENTS);
  assert.equal(capped[0].seq, 6);
});

test("feedTag follows the INTERFACES feed format", () => {
  assert.equal(feed.feedTag(event(1)), "[r1 t1]");
  assert.equal(feed.feedTag(event(1, { turn: null, turn_id: "r00003_end", round: 3 })), "[r3 end]");
  assert.equal(feed.feedTag(event(1, { turn: null, turn_id: "r00000_init", round: 0 })), "[r0 init]");
});

test("pending model calls resolve by call id, else by the run still being in that turn", () => {
  const pending = event(5, { kind: "model_call_pending", pending: true, details: { call_id: "mc_a" } });
  const done = event(6, { kind: "model_call_completed", details: { call_id: "mc_a" } });
  assert.equal(feed.pendingStatus(pending, feed.resolvedCallIds([pending, done]), status()), "answered");
  const busy = status({ state: "waiting_model", active_turn_id: "r00001_t01_a03", pending_model_call: { call_id: "mc_a", agent_id: "a03", model_key: "k", started_at: "" } });
  assert.equal(feed.pendingStatus(pending, new Map(), busy), "waiting");
  assert.equal(feed.pendingStatus(pending, new Map(), status()), "no_answer");
  // A failed call is never reported as "answered" (the line under it says it failed).
  const failed = event(6, { kind: "model_call_failed", details: { call_id: "mc_a", infra: true } });
  assert.equal(feed.pendingStatus(pending, feed.resolvedCallIds([pending, failed]), status()), "failed");
});

test("discarded attempt lines are the saved turn's id below its recorded event range", () => {
  const events = [
    event(1, { turn_id: "r00000_init", round: 0, turn: null }),
    event(2, { turn_id: "r00001_t01_a04", kind: "round_started" }),
    event(3, { turn_id: "r00001_t01_a04", kind: "turn_started" }),
    event(4, { turn_id: "r00001_t01_a04", kind: "model_call_pending" }),
    event(5, { turn_id: "r00001_t01_a04", kind: "model_call_failed" }),
    event(6, { turn_id: "r00001_t01_a04", kind: "error" }),
    event(7, { turn_id: "r00001_t01_a04", kind: "round_started" }),
    event(8, { turn_id: "r00001_t01_a04", kind: "turn_started" }),
  ];
  assert.deepEqual(feed.discardedAttemptSeqs(events, { turn_id: "r00001_t01_a04", event_seq_start: 4 }), [2, 3]);
  assert.deepEqual(feed.discardedAttemptSeqs(events, { turn_id: "r00001_t01_a04", event_seq_start: 2 }), []);
  assert.deepEqual(feed.discardedAttemptSeqs(events, null), []);
});

test("lineCategory separates operator, failures and pending lines", () => {
  assert.equal(feed.lineCategory(event(1, { actor: "operator", kind: "operator_voice" })), "operator");
  assert.equal(feed.lineCategory(event(1, { kind: "model_call_failed" })), "error");
  assert.equal(feed.lineCategory(event(1, { details: { result: { ok: false } } })), "error");
  assert.equal(feed.lineCategory(event(1, { details: { result: { ok: true } } })), "agent");
  assert.equal(feed.lineCategory(event(1, { kind: "model_call_pending", pending: true })), "pending");
  assert.equal(feed.lineCategory(event(1, { actor: "world", kind: "upkeep" })), "world");
});

test("costText shows only non-zero charges", () => {
  assert.equal(feed.costText(event(1)), "");
  assert.equal(feed.costText(event(1, { costs: { compute: 0.8, essence: 2 } })), "0.8 compute, 2 essence");
});

test("failed calls show the provider's error, invalid decisions their reason", () => {
  const failed = event(5, { kind: "model_call_failed", details: { call_id: "mc_x_01", error: "HTTP 503: overloaded", attempts: 3, infra: true } });
  assert.equal(feed.eventDetailNote(failed), "HTTP 503: overloaded · 3 attempts · infrastructure failure: no world compute charged");
  const billed = event(5, { kind: "model_call_failed", details: { call_id: "mc_x_02", error: "claude CLI error", attempts: 1, infra: true, provider_cost_usd: 0.0132521, latency_ms: 16500 } });
  assert.equal(
    feed.eventDetailNote(billed),
    "claude CLI error · 1 attempt · infrastructure failure: no world compute charged · provider billed $0.0133 (in Real model usage) · 16.5 s",
  );
  const completed = event(8, { kind: "model_call_completed", details: { call_id: "mc_x_03", latency_ms: 6414.7, provider_cost_usd: 0.0054641, usage: { reasoning_tokens: 241 } } });
  assert.equal(feed.eventDetailNote(completed), "6.4 s · provider $0.0055 · 241 reasoning tokens (part of output)");
  assert.equal(feed.eventDetailNote(event(6, { kind: "decision_invalid", details: { reason: "unknown action 'fly'" } })), "reason: unknown action 'fly'");
  assert.equal(feed.eventDetailNote(event(7)), null);
});

test("latestFailedTurn reads the failed attempt from the uncommitted feed lines", () => {
  const turn = "r00001_t05_a01";
  const events = [
    event(10, { turn_id: "r00001_t04_a06" }),
    event(11, { turn_id: turn, kind: "turn_started" }),
    event(12, { turn_id: turn, kind: "model_call_pending", pending: true, details: { call_id: "mc_r00001_t05_a01_01", model_key: "fake-heuristic" } }),
    event(13, { turn_id: turn, kind: "model_call_failed", details: { call_id: "mc_r00001_t05_a01_01", error: "HTTP 503: fake", attempts: 3, infra: true } }),
    event(14, { turn_id: turn, actor: "system", kind: "error", details: { message: "provider failure: error" } }),
  ];
  const info = feed.latestFailedTurn(events, 10);
  assert.equal(info.turnId, turn);
  assert.equal(info.agentId, "a01");
  assert.equal(info.modelKey, "fake-heuristic");
  assert.equal(info.callId, "mc_r00001_t05_a01_01");
  assert.equal(info.attempts, 3);
  assert.equal(info.callError, "HTTP 503: fake");
  assert.equal(info.message, "provider failure: error");
  assert.equal(feed.latestFailedTurn(events, 14), null, "an error already inside a saved turn is not a failed attempt");
  assert.equal(feed.latestFailedTurn(events.slice(0, 3), null), null);
});

test("unsaved feed lines are 'in progress' while running and a failed attempt when idle", () => {
  assert.equal(feed.unsavedLineTag(status({ state: "waiting_model" })), "in progress");
  assert.match(feed.unsavedLineTag(status({ state: "paused" })), /failed attempt/);
  assert.match(feed.unsavedLineTag(status({ state: "error" })), /failed attempt/);
});

test("a model call id names its turn", () => {
  assert.equal(records.turnIdOfCallId("mc_r00001_t02_a07_01"), "r00001_t02_a07");
  assert.equal(records.turnIdOfCallId("mc_r00012_end_03"), "r00012_end");
  assert.equal(records.turnIdOfCallId("nonsense"), null);
});

test("knowledge-record changes read as one sentence; other changes as before -> after", () => {
  const added = { path: "knowledge.a02.records[a02-k000006]", before: null, after: { id: "a02-k000006", kind: "operator_voice", text: "Look north" } };
  assert.equal(changes.describeRecordChange(added), 'added operator_voice record a02-k000006 for a02: "Look north"');
  const removed = { path: "knowledge.a02.records[a02-k000001]", before: { kind: "system", text: "hi" }, after: null };
  assert.equal(changes.describeRecordChange(removed), 'removed system record a02-k000001 from a02: "hi"');
  const stat = { path: "world.agents.a02.stats.health", before: 100, after: 0 };
  assert.equal(changes.describeRecordChange(stat), null);
  assert.equal(changes.describeChange(stat), "world.agents.a02.stats.health: 100 → 0");
  assert.equal(changes.isBulky({ text: "x".repeat(200) }), true);
  assert.equal(changes.isBulky(5), false);
});

// ---------------------------------------------------------------- status text and controls

test("usage is labelled fake only when every assigned model is fake", () => {
  const models = [
    { key: "fake-heuristic", provider: "fake" },
    { key: "claude", provider: "anthropic" },
  ];
  const settings = (overrides = {}) => ({ default_model_key: "fake-heuristic", model_overrides: {}, ...overrides });
  assert.equal(statusText.allModelsFake(settings(), models), true);
  assert.equal(statusText.allModelsFake(settings({ model_overrides: { a01: "claude" } }), models), false);
  assert.equal(statusText.allModelsFake(settings({ default_model_key: "unknown" }), models), null);
  assert.equal(statusText.allModelsFake(null, models), null);
});

test("the acting agent is labelled as the last saved turn's when no turn runs", () => {
  assert.equal(statusText.actingAgentLabel(status()), "Acting agent (last saved turn)");
  assert.equal(statusText.actingAgentLabel(status({ active_turn_id: "r00001_t02_a01" })), "Acting agent");
});


test("controls follow the status machine and block overlapping commands", () => {
  const paused = statusText.controlAvailability(status(), false);
  assert.deepEqual(paused, { runTurn: true, play: true, pause: false, stepRound: true, recover: false });
  const running = statusText.controlAvailability(status({ state: "waiting_model" }), false);
  assert.deepEqual(running, { runTurn: false, play: false, pause: true, stepRound: false, recover: false });
  assert.equal(statusText.controlAvailability(status({ state: "pause_requested" }), false).pause, false);
  assert.equal(statusText.controlAvailability(status({ state: "error" }), false).recover, true);
  assert.equal(statusText.controlAvailability(status({ state: "error" }), false).runTurn, false);
  assert.equal(statusText.controlAvailability(status({ state: "finished" }), false).play, true);
  assert.deepEqual(statusText.controlAvailability(status(), true), { runTurn: false, play: false, pause: false, stepRound: false, recover: false });
});

test("state sentences name 'Pause requested' and the agent a model call waits for", () => {
  assert.equal(statusText.stateWord("pause_requested"), "Pause requested");
  const waiting = status({ state: "waiting_model", pending_model_call: { call_id: "mc", agent_id: "a05", model_key: "fake-heuristic", started_at: "" } });
  assert.match(statusText.stateSentence(waiting, name), /^Waiting for model: a05 Name \(fake-heuristic\)/);
});

test("next step uses the last saved turn's round, not the in-progress round", () => {
  assert.equal(statusText.nextStepText(status({ next_step: "new_round", current_turn_id: "r00000_init", round: 1 }), name), "start round 1 (new initiative order)");
  assert.equal(
    statusText.nextStepText(status({ next_step: "new_round", current_turn_id: "r00001_end", round: 1, next_round_order: ["a03", "a01", "a05", "a02"] }), name),
    "start round 2 — likely order (4 agents): a03 Name, a01 Name, a05 Name, a02 Name (predicted; staged edits can change it)",
  );
  assert.match(statusText.nextStepText(status({ next_step: "round_end", current_turn_id: "r00002_t08_a01", round: 2 }), name), /^round 2 end/);
  assert.equal(statusText.nextStepText(status({ next_step: "agent_turn", next_agent_id: "a01" }), name), "agent turn for a01 Name");
  assert.match(statusText.nextStepText(status({ active_turn_id: "r00002_t01_a01" }), name), /in progress/);
});

// ---------------------------------------------------------------- timeline

test("turn and round navigation over the turn index", () => {
  assert.equal(timeline.neighborTurnId(TURNS, "r00001_end", -1), "r00001_t02_a01");
  assert.equal(timeline.neighborTurnId(TURNS, "r00001_end", +1), "r00002_t01_a01");
  assert.equal(timeline.neighborTurnId(TURNS, "r00000_init", -1), null);
  assert.equal(timeline.neighborTurnId(TURNS, "r00002_t02_a03", +1), null);
  assert.equal(timeline.lastTurnOfRound(TURNS, 1), "r00001_end");
  assert.equal(timeline.lastTurnOfRound(TURNS, 2), "r00002_t02_a03");
  assert.equal(timeline.lastTurnOfRound(TURNS, 3), null);
  assert.equal(timeline.firstRound(TURNS), 0);
  assert.equal(timeline.lastRound(TURNS), 2);
  assert.equal(timeline.roundOfTurnId("r00012_t03_a05"), 12);
});

test("mergeTurnIndex replaces the refreshed rounds", () => {
  const refreshed = [entry("r00002_t01_a01"), entry("r00002_t02_a03"), entry("r00002_t03_a02")];
  const merged = timeline.mergeTurnIndex(TURNS, refreshed, 2);
  assert.deepEqual(
    merged.map((t) => t.turn_id),
    ["r00000_init", "r00001_t01_a03", "r00001_t02_a01", "r00001_end", "r00002_t01_a01", "r00002_t02_a03", "r00002_t03_a02"],
  );
});

test("turn options always contain the turn id and say what happened", () => {
  assert.match(timeline.turnOptionLabel(entry("r00001_t02_a01"), name), /^t02 · a01 Name · observe ok — r00001_t02_a01$/);
  assert.match(timeline.turnOptionLabel(entry("r00001_end"), name), /^Round 1 end — r00001_end$/);
  assert.match(timeline.turnOptionLabel(entry("r00001_t03_a04", { action_name: null, decision_source: "skipped_dead" }), name), /skipped \(dead\)/);
});

// ---------------------------------------------------------------- setup form

test("problems are matched by exact path, by prefix and outside prefixes", () => {
  const problems = [
    { path: "agents[0].stats.health", message: "too high" },
    { path: "agents[0].position", message: "outside" },
    { path: "agents[10].name", message: "duplicate" },
    { path: "context.generation_allowance", message: "too big" },
    { path: "", message: "whole request" },
  ];
  assert.deepEqual(
    setup.problemsAt(problems, "agents[0].position").map((p) => p.message),
    ["outside"],
  );
  assert.deepEqual(
    setup.problemsUnder(problems, "agents[1]").map((p) => p.message),
    [],
  );
  assert.equal(setup.problemsUnder(problems, "agents[0]").length, 2);
  assert.deepEqual(
    setup.problemsOutside(problems, ["agents", "context"]).map((p) => p.message),
    ["whole request"],
  );
});

test("newCard takes the first unused template, else a fresh aNN id", () => {
  const card = (id, cardName) => ({ id, name: cardName, position: { x: 0, y: 0 }, stats: {}, persona: "", notebook: "", initial_skills: [] });
  const cards = [card("a01", "Aster"), card("a02", "Boreas")];
  const templates = [card("a01", "Aster"), card("a02", "Boreas"), card("a03", "Cyrene")];
  assert.equal(setup.newCard(cards, templates).id, "a03");
  const fallback = setup.newCard([...cards, card("a03", "Cyrene")], templates);
  assert.equal(fallback.id, "a04");
  assert.notEqual(fallback.name, "Cyrene");
});

test("withSpecies keeps plant counts across a species rename and drops removed species", () => {
  const rule = (ruleName) => ({ name: ruleName, stages: [] });
  const request = { rules: { plant_species: { fruit_tree: rule("fruit_tree"), moss: rule("moss") } }, world: { initial_plants: { fruit_tree: 12, moss: 3 } } };
  const renamed = setup.withSpecies(request, [rule("berry"), rule("moss")]);
  assert.deepEqual(Object.keys(renamed.rules.plant_species), ["berry", "moss"]);
  assert.deepEqual(renamed.world.initial_plants, { berry: 12, moss: 3 });
  const removed = setup.withSpecies(request, [rule("fruit_tree")]);
  assert.deepEqual(removed.world.initial_plants, { fruit_tree: 12 });
});

test("advanced rules JSON merges into the rules but never replaces plant species", () => {
  const request = { rules: { prices: { move: 5 }, plant_species: { a: 1 } } };
  const ok = setup.applyOtherRules(request, '{"prices": {"move": 7}, "plant_species": {}}');
  assert.deepEqual(ok.request.rules, { prices: { move: 7 }, plant_species: { a: 1 } });
  assert.match(setup.applyOtherRules(request, "{not json").error, /not valid JSON/);
  assert.match(setup.applyOtherRules(request, "[]").error, /object/);
});

// ---------------------------------------------------------------- coordinates and routes

test("coordinate lookup accepts x,y in the usual spellings", () => {
  assert.deepEqual(points.parseCoordinate("3,4"), { x: 3, y: 4 });
  assert.deepEqual(points.parseCoordinate(" (-2, -7) "), { x: -2, y: -7 });
  assert.deepEqual(points.parseCoordinate("5 -1"), { x: 5, y: -1 });
  assert.equal(points.parseCoordinate("a05"), null);
  assert.equal(points.parseCoordinate("3,"), null);
});

test("hash routes round-trip", () => {
  assert.deepEqual(router.parseHash(""), { name: "entry" });
  assert.deepEqual(router.parseHash("#/new"), { name: "new" });
  assert.deepEqual(router.parseHash("#/resume"), { name: "resume" });
  assert.deepEqual(router.parseHash("#/run/run_1?turn=r00001_end"), { name: "run", runId: "run_1", turnId: "r00001_end" });
  assert.equal(router.routeHash({ name: "run", runId: "run_1", turnId: null }), "#/run/run_1");
  assert.deepEqual(router.parseHash(router.routeHash({ name: "run", runId: "run 2", turnId: "r00000_init" })), { name: "run", runId: "run 2", turnId: "r00000_init" });
});

test("story and instructions hash routes round-trip", () => {
  assert.deepEqual(router.parseHash("#/story"), { name: "story", runId: null, storyId: null });
  assert.deepEqual(router.parseHash("#/story/run_1"), { name: "story", runId: "run_1", storyId: null });
  assert.deepEqual(router.parseHash("#/story/run_1/st_2"), { name: "story", runId: "run_1", storyId: "st_2" });
  assert.equal(router.routeHash({ name: "story", runId: null, storyId: null }), "#/story");
  assert.equal(router.routeHash({ name: "story", runId: "run_1", storyId: null }), "#/story/run_1");
  assert.equal(router.routeHash({ name: "story", runId: "run_1", storyId: "st_2" }), "#/story/run_1/st_2");
  // a story id without a run is dropped, not misrouted
  assert.equal(router.routeHash({ name: "story", runId: null, storyId: "st_2" }), "#/story");
  for (const route of [
    { name: "story", runId: null, storyId: null },
    { name: "story", runId: "run 2", storyId: null },
    { name: "story", runId: "run/3", storyId: "story ä" },
    { name: "instructions", section: null },
    { name: "instructions", section: "skills" },
    { name: "instructions", section: "a b&c" },
  ]) {
    assert.deepEqual(router.parseHash(router.routeHash(route)), route);
  }
  assert.deepEqual(router.parseHash("#/instructions"), { name: "instructions", section: null });
  assert.deepEqual(router.parseHash("#/instructions?section=economy"), { name: "instructions", section: "economy" });
  assert.deepEqual(router.parseHash("#/instructions?section="), { name: "instructions", section: null });
  assert.equal(router.routeHash({ name: "instructions", section: null }), "#/instructions");
  assert.equal(router.routeHash({ name: "instructions", section: "skills" }), "#/instructions?section=skills");
  // a malformed escape does not throw
  assert.deepEqual(router.parseHash("#/story/%E0%A4%A"), { name: "story", runId: "%E0%A4%A", storyId: null });
});

// ---------------------------------------------------------------- assistant context store

function handlerBundle(log, tag) {
  return {
    selectEntity: (id) => (log.push([tag, "selectEntity", id]), null),
    findPoint: (p) => (log.push([tag, "findPoint", p]), null),
    viewTurn: (t) => log.push([tag, "viewTurn", t]),
    setTab: (t) => log.push([tag, "setTab", t]),
    openRecord: (r) => log.push([tag, "openRecord", r]),
    setInFlight: (b) => log.push([tag, "setInFlight", b]),
    applyStatus: (s) => log.push([tag, "applyStatus", s]),
    showError: (m) => log.push([tag, "showError", m]),
  };
}

test("assistant context publishes with stable snapshots and notifies only on change", () => {
  assistantContext.resetAssistantContextForTests();
  const empty = assistantContext.getSnapshot();
  assert.equal(empty.page, "entry");
  assert.equal(empty.runId, null);
  let calls = 0;
  const unsubscribe = assistantContext.subscribe(() => calls++);
  const input = { page: "run", runId: "run_1", runName: "Arena", liveTurnId: "r00002_end", shownTurnId: "r00001_t03_a04", tab: "inspect", selectedPoint: { x: 1, y: -2 }, selectedEntityId: "a04", selectedEntityKind: "agent", runState: "paused" };
  assistantContext.publishContext(input);
  assert.equal(calls, 1);
  const first = assistantContext.getSnapshot();
  assert.equal(first.selectedEntityId, "a04");
  assert.equal(first.lastError, null);
  assert.equal(first.storyId, null);
  // equal content (a fresh point object) keeps the same snapshot and does not notify
  assistantContext.publishContext({ ...input, selectedPoint: { x: 1, y: -2 } });
  assert.equal(calls, 1);
  assert.equal(assistantContext.getSnapshot(), first);
  assert.equal(assistantContext.contextChipText(first), "Run Arena · turn r00001_t03_a04 (history) · a04 selected");
  assistantContext.publishContext({ ...input, selectedPoint: { x: 2, y: -2 } });
  assert.equal(calls, 2);
  assert.notEqual(assistantContext.getSnapshot(), first);
  // clearing on behalf of another run is a no-op; the owner clears
  assistantContext.clearContext("run_other");
  assert.equal(assistantContext.getSnapshot().runId, "run_1");
  assistantContext.clearContext("run_1");
  assert.equal(calls, 3);
  assert.equal(assistantContext.getSnapshot().page, "entry");
  assistantContext.clearContext();
  assert.equal(calls, 3);
  unsubscribe();
  assistantContext.publishContext({ page: "story", runId: "run_1", storyId: "st_1" });
  assert.equal(calls, 3);
  assert.equal(assistantContext.contextChipText(assistantContext.getSnapshot()), "Story Mode · run_1 · story st_1");
  assistantContext.resetAssistantContextForTests();
});

test("assistant run handlers are keyed by run id and a stale unregister is ignored", () => {
  assistantContext.resetAssistantContextForTests();
  const log = [];
  const a = handlerBundle(log, "A");
  const b = handlerBundle(log, "B");
  const c = handlerBundle(log, "C");
  assert.equal(assistantContext.getHandlers("run_1"), null);
  assert.equal(assistantContext.getHandlers(null), null);
  const offA = assistantContext.registerHandlers("run_1", a);
  assistantContext.registerHandlers("run_2", c);
  assistantContext.getHandlers("run_1").viewTurn("r00001_end");
  assistantContext.getHandlers("run_2").setTab("god");
  assert.deepEqual(log, [["A", "viewTurn", "r00001_end"], ["C", "setTab", "god"]]);
  // a remount registers B before A's cleanup runs: A's unregister must not remove B
  const offB = assistantContext.registerHandlers("run_1", b);
  offA();
  assert.equal(assistantContext.getHandlers("run_1"), b);
  assistantContext.unregisterHandlers("run_1", a);
  assert.equal(assistantContext.getHandlers("run_1"), b);
  offB();
  assert.equal(assistantContext.getHandlers("run_1"), null);
  assert.equal(assistantContext.getHandlers("run_2"), c);
  assistantContext.unregisterHandlers("run_2");
  assert.equal(assistantContext.getHandlers("run_2"), null);
  assistantContext.resetAssistantContextForTests();
});

// ---------------------------------------------------------------- assistant answer formatting

test("linkify finds turn ids, call ids, agent ids and points", () => {
  const parts = assistantFormat.linkify("In r00012_t03_a04, a04 ate at (3, -2); see mc_r00012_t03_a04_01 and r00012_end.");
  assert.deepEqual(parts, [
    { kind: "text", text: "In " },
    { kind: "turn", text: "r00012_t03_a04", turnId: "r00012_t03_a04" },
    { kind: "text", text: ", " },
    { kind: "entity", text: "a04", entityId: "a04" },
    { kind: "text", text: " ate at " },
    { kind: "point", text: "(3, -2)", x: 3, y: -2 },
    { kind: "text", text: "; see " },
    { kind: "call", text: "mc_r00012_t03_a04_01", callId: "mc_r00012_t03_a04_01", turnId: "r00012_t03_a04" },
    { kind: "text", text: " and " },
    { kind: "turn", text: "r00012_end", turnId: "r00012_end" },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(assistantFormat.linkify("a04"), [{ kind: "entity", text: "a04", entityId: "a04" }]);
  assert.deepEqual(assistantFormat.linkify("r00000_init"), [{ kind: "turn", text: "r00000_init", turnId: "r00000_init" }]);
  // not inside longer identifiers
  assert.deepEqual(assistantFormat.linkify("xa04 a045 a04_x"), [{ kind: "text", text: "xa04 a045 a04_x" }]);
  // known agent ids replace the aNN default, longest first
  const known = assistantFormat.linkify("Eos met a12 and a1", { agentIds: ["Eos", "a1", "a12"] });
  assert.deepEqual(
    known.filter((s) => s.kind === "entity").map((s) => s.entityId),
    ["Eos", "a12", "a1"],
  );
  assert.deepEqual(assistantFormat.linkify("a04 left", { agentIds: ["a01"] }), [{ kind: "text", text: "a04 left" }]);
  assert.deepEqual(assistantFormat.linkify(""), []);
});

test("formatAnswer builds paragraphs, lists, code and headings", () => {
  const blocks = assistantFormat.formatAnswer("## Summary\nFirst line\nsame paragraph with `a04`.\n\n- one **a04**\n  continued\n- two\n1. first\nAfter the list.\n```\nraw a04\n```");
  assert.deepEqual(blocks.map((b) => b.kind), ["heading", "paragraph", "list", "list", "paragraph", "code"]);
  assert.equal(blocks[0].level, 2);
  assert.equal(assistantFormat.inlineText(blocks[1].inlines), "First line same paragraph with a04.");
  assert.deepEqual(blocks[1].inlines.at(-2), { kind: "code", text: "a04" });
  assert.equal(blocks[2].ordered, false);
  assert.equal(blocks[2].items.length, 2);
  assert.equal(assistantFormat.inlineText(blocks[2].items[0]), "one a04 continued");
  assert.deepEqual(blocks[2].items[0][1], { kind: "strong", parts: [{ kind: "entity", text: "a04", entityId: "a04" }] });
  assert.equal(blocks[3].ordered, true);
  assert.equal(blocks[5].text, "raw a04");
  assert.deepEqual(assistantFormat.formatAnswer("  \n\n"), []);
});

// ---------------------------------------------------------------- story mode helpers

test("story mode turn ranges validate against committed turn ids", () => {
  const ids = ["r00000_init", "r00001_t01_a01", "r00001_t02_a02", "r00001_end", "r00002_t01_a01", "r00002_t02_a02", "r00002_end"];
  const all = storyMode.validateTurnRange({ from: null, to: null }, ids);
  assert.equal(all.ok, true);
  assert.deepEqual(all.counts, { agentTurns: 4, rounds: 2 });
  const part = storyMode.validateTurnRange({ from: "r00001_t02_a02", to: "r00002_t01_a01" }, ids);
  assert.deepEqual(part.turnIds, ["r00001_t02_a02", "r00001_end", "r00002_t01_a01"]);
  assert.deepEqual(part.counts, { agentTurns: 2, rounds: 2 });
  const reversed = storyMode.validateTurnRange({ from: "r00002_t01_a01", to: "r00001_t01_a01" }, ids);
  assert.equal(reversed.ok, false);
  assert.match(reversed.problems[0], /comes after/);
  assert.match(storyMode.validateTurnRange({ from: "r00009_end", to: null }, ids).problems[0], /not in this run/);
  assert.match(storyMode.validateTurnRange({ from: "r00001_end", to: "r00001_end" }, ids).problems[0], /no agent turns/);
  assert.match(storyMode.validateTurnRange({ from: null, to: null }, []).problems[0], /no recorded turns/);
  assert.deepEqual(storyMode.countTurns(["garbage", "r00003_t01_a05"]), { agentTurns: 1, rounds: 1 });
});

test("story mode estimates per turn and per round", () => {
  const model = { chapterUsd: 0.04, chapterSeconds: 20, roundFactor: 2, summaryEvery: 5, summaryUsd: 0.01, summarySeconds: 10 };
  const both = storyMode.estimateBoth({ agentTurns: 12, rounds: 3 }, model);
  assert.deepEqual(both.turn, { unit: "turn", chapters: 12, summaries: 2, costUsd: 0.5, seconds: 260 });
  assert.deepEqual(both.round, { unit: "round", chapters: 3, summaries: 0, costUsd: 0.24, seconds: 120 });
  assert.equal(storyMode.formatEstimate(both.turn), "12 chapters · ≈$0.50 · ~4 min");
  assert.equal(storyMode.formatEstimate(storyMode.estimateChapters({ agentTurns: 1, rounds: 1 }, "turn", { ...model, summaryEvery: 0 })), "1 chapter · ≈$0.04 · ~20 s");
  assert.equal(storyMode.formatDuration(7500), "~2 h 5 min");
  assert.equal(storyMode.formatUsd(0.004), "<$0.01");
  const def = storyMode.estimateChapters({ agentTurns: 0, rounds: 0 }, "turn");
  assert.deepEqual(def, { unit: "turn", chapters: 0, summaries: 0, costUsd: 0, seconds: 0 });
});

test("story mode chip options and POV values", () => {
  const pov = storyMode.povOptions([{ id: "a01", name: "Eos" }]);
  assert.deepEqual(pov.map((o) => o.value), ["chronicler", "follow:a01"]);
  assert.equal(pov[1].label, "Follow Eos");
  assert.deepEqual(storyMode.parsePov("follow:a01"), { kind: "follow", agentId: "a01" });
  assert.deepEqual(storyMode.parsePov("follow:"), { kind: "chronicler" });
  assert.deepEqual(storyMode.VIVIDNESS_OPTIONS.map((o) => o.value), [1, 2, 3, 4, 5]);
  assert.ok(storyMode.GENRE_OPTIONS.some((o) => o.value === storyMode.DEFAULT_STORY_CHOICES.genre));
  assert.ok(storyMode.TONE_OPTIONS.some((o) => o.value === storyMode.DEFAULT_STORY_CHOICES.tone));
  assert.equal(storyMode.DEFAULT_STORY_CHOICES.unit, "turn");
});

test("story mode picks round-trip through the chips", () => {
  const picks = { genre: "survival", tone: "grim", vividness: 4, pov: "follow", follow_agent_id: "a03", from_turn_id: "r00001_t01_a01", to_turn_id: null, unit: "round", language: "en" };
  const choices = storyMode.picksToChoices(picks);
  assert.deepEqual(choices, { genre: "survival", tone: "grim", vividness: 4, pov: { kind: "follow", agentId: "a03" }, unit: "round", range: { from: "r00001_t01_a01", to: null } });
  assert.deepEqual(storyMode.choicesToPicks(choices), picks);
  assert.equal(storyMode.povValue(choices.pov), "follow:a03");
  assert.deepEqual(storyMode.picksToChoices(null), storyMode.DEFAULT_STORY_CHOICES);
  assert.equal(storyMode.picksToChoices({ vividness: 9 }).vividness, 5);
  assert.equal(storyMode.choicesToPicks({ ...storyMode.DEFAULT_STORY_CHOICES, pov: { kind: "chronicler" } }).follow_agent_id, null);
  const extra = storyMode.optionsWith(storyMode.GENRE_OPTIONS, "chronicle");
  assert.equal(extra[extra.length - 1].label, "Chronicle");
  assert.equal(storyMode.optionsWith(storyMode.GENRE_OPTIONS, "myth"), storyMode.GENRE_OPTIONS);
  assert.equal(storyMode.stepZeroText("  "), "Write the story with the choices above.");
  assert.equal(storyMode.stepZeroText(" a legend "), "a legend");
});

test("story mode run card and turn captions", () => {
  assert.equal(storyMode.runCardSummary({ cast: [{}, {}], rounds: 1, turns: 12, deaths: 0, kills: 1 }), "2 agents · 1 round · 12 turns · 0 deaths · 1 kill");
  assert.equal(storyMode.turnLabel("r00003_t02_a05"), "round 3 · turn 2 · a05");
  assert.equal(storyMode.turnLabel("r00003_end"), "end of round 3");
  assert.equal(storyMode.turnLabel("r00000_init"), "start of the run");
  assert.equal(storyMode.turnLabel("garbage"), "garbage");
  assert.equal(storyMode.runProgressText({ current_turn_id: "r00000_init", last_round: 0, last_turn_index: null }), "round 0 · initial state");
  assert.equal(storyMode.runProgressText({ current_turn_id: "r00012_end", last_round: 12, last_turn_index: null }), "round 12 · round end");
  assert.equal(storyMode.runProgressText({ current_turn_id: "r00012_t03_a01", last_round: 12, last_turn_index: 3 }), "round 12 · turn 3");
  assert.equal(storyMode.planSummary([{ kind: "opening" }, { kind: "chapter" }, { kind: "chapter" }, { kind: "interlude" }]), "1 opening, 2 chapters, 1 short interlude");
  assert.equal(storyMode.modelTier("claude-cli-haiku-assistant"), "Haiku");
  assert.equal(storyMode.modelTier("fake-assistant"), "fake model");
});

test("story brief estimates prefer the backend's and fall back to the local ones", () => {
  const brief = { estimate_turn: { unit: "turn", chapters: 10, cost_usd: 0.4, seconds: 200 }, estimate_round: null };
  const both = storyMode.briefEstimates(brief, { agentTurns: 10, rounds: 2 });
  assert.equal(both.turn.chapters, 10);
  assert.equal(both.turn.costUsd, 0.4);
  assert.equal(both.round.unit, "round");
  assert.equal(both.round.chapters, 2);
  assert.deepEqual(storyMode.briefEstimates(null, null), { turn: null, round: null });
  const session = { unit: "turn", chapters_total: 10, chapters_done: 4 };
  assert.deepEqual(storyMode.remainingEstimate(brief, session), { unit: "turn", chapters: 6, summaries: 0, costUsd: 0.24, seconds: 120 });
  assert.equal(storyMode.generateAllLabel(storyMode.remainingEstimate(brief, session)), "Generate all (est. $0.24, ~2 min)");
  assert.equal(storyMode.generateAllLabel(null), "Generate all");
  assert.equal(storyMode.remainingEstimate(brief, { unit: "round", chapters_total: 2, chapters_done: 0 }), null);
});

test("story reader: phase, lazy window, availability and queue text", () => {
  const base = { status: "generating", brief: { status: "executed", chapter_plan: [] }, chapters_done: 0, chapters_total: 0, reader_position: 0, generate_all: false, end_turn_id: null, messages: [] };
  assert.equal(storyMode.storyPhase({ status: "interviewing", brief: null, chapters_done: 0 }), "interview");
  assert.equal(storyMode.storyPhase({ status: "brief_pending", brief: { status: "pending" }, chapters_done: 0 }), "brief");
  assert.equal(storyMode.storyPhase({ status: "cancelled", brief: { status: "rejected" }, chapters_done: 0 }), "interview");
  assert.equal(storyMode.storyPhase(base), "reader");
  assert.equal(storyMode.storyPhase({ status: "error", brief: { status: "executed" }, chapters_done: 0 }), "reader");
  assert.equal(storyMode.storyPhase({ status: "error", brief: { status: "invalid" }, chapters_done: 0 }), "interview");
  assert.equal(storyMode.storyPhase({ status: "cancelled", brief: null, chapters_done: 3 }), "reader");

  assert.deepEqual(storyMode.readerWindow(1, 10), [1, 2, 3, 4]);
  assert.deepEqual(storyMode.readerWindow(0, 2), [1, 2]);
  assert.deepEqual(storyMode.readerWindow(9, 10), [9, 10]);
  assert.deepEqual(storyMode.readerWindow(11, 10), []);
  assert.equal(storyMode.initialChapter({ reader_position: 0 }, 10), 1);
  assert.equal(storyMode.initialChapter({ reader_position: 7 }, 5), 5);
  assert.equal(storyMode.initialChapter({ reader_position: 3 }, 0), 1);
  assert.equal(storyMode.chapterTotal({ chapters_total: 0, brief: { chapter_plan: [{}, {}, {}] } }, []), 3);
  assert.equal(storyMode.chapterTotal({ chapters_total: 0, brief: null }, [{ number: 2 }, { number: 5 }]), 5);
  assert.equal(storyMode.chapterTotal({ chapters_total: 12, brief: null }, []), 12);

  const chapters = [{ number: 1, status: "done" }, { number: 2, status: "error" }];
  const session = { ...base, chapters_done: 1, chapters_total: 10, reader_position: 1 };
  const running = { status: "running" };
  assert.equal(storyMode.chapterAvailability(1, chapters, session, running), "ready");
  assert.equal(storyMode.chapterAvailability(2, chapters, session, running), "error");
  assert.equal(storyMode.chapterAvailability(2, [chapters[0]], session, running), "writing");
  assert.equal(storyMode.chapterAvailability(4, [chapters[0]], session, running), "queued");
  assert.equal(storyMode.chapterAvailability(5, [chapters[0]], session, running), "not_started");
  assert.equal(storyMode.chapterAvailability(9, [chapters[0]], { ...session, generate_all: true }, running), "queued");
  assert.equal(storyMode.chapterAvailability(3, [chapters[0]], { ...session, status: "paused" }, null), "not_started");
  assert.equal(storyMode.chapterAvailability(3, [chapters[0]], { ...session, status: "error" }, null), "error");

  assert.equal(storyMode.jobQueueText(null), "");
  assert.equal(storyMode.jobQueueText({ status: "queued", queue_position: 2, queued_behind: 'Queued behind "The Arena" (ch 40/285)', progress: "", cancel_requested: false }), 'Queued behind "The Arena" (ch 40/285)');
  assert.equal(storyMode.jobQueueText({ status: "queued", queue_position: 2, queued_behind: null, progress: "", cancel_requested: false }), "Queue position 2");
  assert.equal(storyMode.jobQueueText({ status: "running", queue_position: 0, queued_behind: null, progress: "chapter 3/10", cancel_requested: false }), "chapter 3/10");
  assert.equal(storyMode.jobQueueText({ status: "running", queue_position: 0, queued_behind: null, progress: "", cancel_requested: true }), "Stopping after the current chapter…");
  assert.equal(storyMode.jobQueueText({ status: "done", queue_position: 0, queued_behind: null, progress: "x", cancel_requested: false }), "");

  assert.equal(storyMode.storyPollDelay(null, null), null);
  assert.equal(storyMode.storyPollDelay({ status: "complete", messages: [] }, { status: "done" }), null);
  assert.equal(storyMode.storyPollDelay({ status: "complete", messages: [] }, { status: "queued" }), 2500);
  assert.equal(storyMode.storyPollDelay({ status: "generating", messages: [] }, null), 2500);
  assert.equal(storyMode.storyPollDelay({ status: "interviewing", messages: [{ status: "running" }] }, null, 1000), 1000);
  assert.equal(storyMode.storyPollDelay({ status: "brief_pending", messages: [{ status: "done" }] }, null), null);

  assert.equal(storyMode.canContinueStory({ end_turn_id: "r00003_end", status: "complete" }, "r00005_t01_a01"), true);
  assert.equal(storyMode.canContinueStory({ end_turn_id: "r00003_end", status: "complete" }, "r00003_end"), false);
  assert.equal(storyMode.canContinueStory({ end_turn_id: "r00003_end", status: "generating" }, "r00005_t01_a01"), false);
  assert.equal(storyMode.canContinueStory({ end_turn_id: null, status: "complete" }, "r00005_t01_a01"), false);
  assert.equal(storyMode.canContinueStory({ end_turn_id: "r00005_t01_a01", status: "complete" }, "r00003_end"), false);
});

test("story chapters: headings, paragraphs and export file names", () => {
  assert.equal(storyMode.chapterHeading({ number: 3, kind: "chapter", title: "The long night", turn_ids: [] }), "3. The long night");
  assert.equal(storyMode.chapterHeading({ number: 4, kind: "interlude", title: "", turn_ids: [] }), "4. Interlude");
  assert.equal(storyMode.chapterHeading({ number: 4, kind: "interlude", title: "Rain", turn_ids: [] }), "4. Interlude · Rain");
  assert.equal(storyMode.chapterHeading({ number: 1, kind: "opening", title: "", turn_ids: [] }), "1. Opening");
  assert.equal(storyMode.chapterHeading({ number: 9, kind: "chapter", title: " ", turn_ids: [] }), "9. Untitled chapter");
  assert.deepEqual(storyMode.paragraphs("# Title\n\nFirst.\r\n\r\nSecond\nline.\n\n\n"), ["First.", "Second\nline."]);
  assert.deepEqual(storyMode.paragraphs(""), []);
  assert.equal(storyMode.exportFileName("The Arena: A Myth!"), "the-arena-a-myth.md");
  assert.equal(storyMode.exportFileName("Épée & Ombre"), "epee-ombre.md");
  assert.equal(storyMode.exportFileName("???"), "story.md");
  assert.equal(storyMode.exportFileName("x".repeat(80)).length, 63);
});

// ---------------------------------------------------------------- storybook tab helpers

test("storybook polling, status line and paused reasons", () => {
  assert.equal(storyMode.storybookPollDelay(null), null);
  assert.equal(storyMode.storybookPollDelay({ pending_count: 0, in_flight: false }), null);
  assert.equal(storyMode.storybookPollDelay({ pending_count: 3, in_flight: false }), 2500);
  assert.equal(storyMode.storybookPollDelay({ pending_count: 0, in_flight: true }, 100), 100);
  const spend = { limit_usd: 2, spent_usd: 0.35 };
  assert.deepEqual(storyMode.storybookStatusParts({ pending_count: 3, in_flight: true, missing_count: 12, spend, entry_count: 1 }), ["3 pending", "1 entry", "spent $0.35 of $2.00", "12 missing"]);
  assert.deepEqual(storyMode.storybookStatusParts({ pending_count: 0, in_flight: true, missing_count: 0, spend, entry_count: 40 }), ["writing…", "40 entries", "spent $0.35 of $2.00"]);
  assert.equal(storyMode.writeMissingLabel({ missing_count: 12, estimate: { cost_usd: 0.05, seconds: 130 } }), "Write missing (12 entries, ≈$0.05, ~2 min)");
  assert.equal(storyMode.writeMissingLabel({ missing_count: 1, estimate: { cost_usd: 0.004, seconds: 20 } }), "Write missing (1 entry, <$0.01, ~20 s)");
  assert.equal(storyMode.storybookAutoText({ auto: true, auto_state: "on" }), "Auto on");
  assert.equal(storyMode.storybookAutoText({ auto: false, auto_state: "paused_budget" }), "Auto paused: budget reached");
  assert.equal(storyMode.storybookAutoText({ auto: true, auto_state: "paused_error" }), "Auto paused: error");
  assert.match(storyMode.storybookPausedReason({ auto_state: "paused_budget", notice: null, last_error: null, spend }), /\$2\.00 budget/);
  assert.equal(storyMode.storybookPausedReason({ auto_state: "paused_budget", notice: "custom", last_error: null, spend }), "custom");
  assert.match(storyMode.storybookPausedReason({ auto_state: "paused_error", notice: null, last_error: "boom", spend }), /after an error: boom/);
  assert.equal(storyMode.storybookPausedReason({ auto_state: "on", notice: null, last_error: null, spend }), null);
  assert.equal(storyMode.raisedBudget(2), 4);
  assert.equal(storyMode.raisedBudget(0.5), 2);
  assert.equal(storyMode.raisedBudget(0), 1);
});

test("storybook entries filter by entity, order by commit and have headings", () => {
  const entries = [
    { turn_id: "opening", kind: "opening", round: 0, text: "In the beginning a02 woke.", entities: [] },
    { turn_id: "r00001_t01_a01", kind: "turn", round: 1, text: "Eos moved north.", entities: ["a01"] },
    { turn_id: "r00001_t02_a02", kind: "turn", round: 1, text: "Kai watched Eos.", entities: ["a02", "a01"] },
    { turn_id: "r00001_end", kind: "round_end", round: 1, text: "Night fell on a02's camp." },
    { turn_id: "r00002_t01_a01", kind: "turn", round: 2, text: "a012 is not a01." },
  ];
  assert.deepEqual(storyMode.filterStorybookEntries(entries, "a01").map((e) => e.turn_id), ["r00001_t01_a01", "r00001_t02_a02", "r00002_t01_a01"]);
  assert.deepEqual(storyMode.filterStorybookEntries(entries, "a02").map((e) => e.turn_id), ["opening", "r00001_t02_a02", "r00001_end"]);
  assert.equal(storyMode.filterStorybookEntries(entries, null), entries);
  assert.equal(storyMode.entryInvolves({ turn_id: "r00002_t01_a01", text: "a012 is not a01.", entities: [] }, "a01"), true);
  assert.equal(storyMode.entryInvolves({ turn_id: "r00002_t01_a03", text: "a012 walked.", entities: [] }, "a01"), false);
  assert.equal(storyMode.entryHeading(entries[0]), "Opening");
  assert.equal(storyMode.entryHeading(entries[1], (id) => `${id} Eos`), "Round 1 · turn 1 · a01 Eos");
  assert.equal(storyMode.entryHeading(entries[3]), "End of round 1");
  assert.equal(storyMode.entryHeading({ turn_id: "weird", kind: "turn", round: 1 }), "weird");
  const ids = ["r00003_end", "r00001_t02_a02", "r00003_t08_a02", "r00000_init", "r00003_t01_a01"];
  assert.deepEqual([...ids].sort(storyMode.compareTurnIds), ["r00000_init", "r00001_t02_a02", "r00003_t01_a01", "r00003_t08_a02", "r00003_end"]);
  assert.equal(storyMode.compareTurnIds("b", "a") > 0, true);
  assert.equal(storyMode.isNearBottom({ scrollTop: 976, clientHeight: 400, scrollHeight: 1400 }), true);
  assert.equal(storyMode.isNearBottom({ scrollTop: 900, clientHeight: 400, scrollHeight: 1400 }), false);
  assert.equal(storyMode.isNearBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 300 }), true);
});

// ---------------------------------------------------------------- assistant: setup draft, drawer state, ask requests, brief text

test("mergeSetupDraft merges dicts recursively, replaces scalars and merges agent cards by index", () => {
  const card = (id, name) => ({ id, name, model_key: null, position: { x: 0, y: 0 }, stats: { health: 100, speed: 1 }, persona: "p", notebook: "", initial_skills: [] });
  const defaults = {
    name: "Default", seed: 1, world: { region: { min_x: -5, max_x: 5 }, initial_plants: { berry: 3 } }, rules: { prices: { move: 1 }, plant_species: { berry: { name: "berry" } } },
    context: { input_token_cap: 8000 }, default_model_key: "fake-heuristic", agents: [card("a01", "Ann"), card("a02", "Bob")],
  };
  const merged = setup.mergeSetupDraft(defaults, {
    name: "Arena", world: { region: { max_x: 3 }, initial_plants: { moss: 2 } }, rules: { prices: { move: 4 } }, real_budget_usd: 2,
    agents: [{ name: "Rex", stats: { speed: 3 } }, null, { name: "extra" }],
  });
  assert.equal(merged.name, "Arena");
  assert.equal(merged.seed, 1);
  assert.deepEqual(merged.world.region, { min_x: -5, max_x: 3 });
  // a whole-dict overlay of initial_plants merges too (dicts merge recursively)
  assert.deepEqual(merged.world.initial_plants, { berry: 3, moss: 2 });
  assert.deepEqual(merged.rules.prices, { move: 4 });
  assert.equal(merged.real_budget_usd, 2);
  assert.equal(merged.agents.length, 2);
  assert.equal(merged.agents[0].name, "Rex");
  assert.deepEqual(merged.agents[0].stats, { health: 100, speed: 3 });
  assert.equal(merged.agents[0].persona, "p");
  assert.equal(merged.agents[1].name, "Bob");
  // defaults are not mutated
  assert.equal(defaults.name, "Default");
  assert.equal(defaults.agents[0].name, "Ann");
  // agents that are not a list are ignored
  assert.equal(setup.mergeSetupDraft(defaults, { agents: "nope" }).agents, defaults.agents);
  assert.equal(setup.SETUP_DRAFT_KEY, "empyrean.assistant.setupDraft.v1");
});

test("drawer state clamps the width, dedups changes and reserves room only when docked on a wide run page", () => {
  assistantContext.resetAssistantContextForTests();
  const initial = assistantContext.getDrawerState();
  assert.deepEqual(initial, { open: false, docked: true, width: assistantContext.DRAWER_DEFAULT_W, status: "unknown" });
  let calls = 0;
  const off = assistantContext.subscribeDrawer(() => calls++);
  assert.equal(assistantContext.setDrawerState({ open: false }), initial);
  assert.equal(calls, 0);
  assistantContext.setDrawerState({ open: true, width: 5000 });
  assert.equal(calls, 1);
  const wide = assistantContext.getDrawerState();
  assert.equal(wide.width, assistantContext.DRAWER_MAX_W);
  assert.equal(assistantContext.clampDrawerWidth(10), assistantContext.DRAWER_MIN_W);
  assert.equal(assistantContext.clampDrawerWidth(NaN), assistantContext.DRAWER_DEFAULT_W);
  assert.equal(assistantContext.clampDrawerWidth(500, 420), 420);
  // reserve: run page, docked, open, window >= 1280
  const state = { open: true, docked: true, width: 400, status: "ready" };
  assert.equal(assistantContext.dockReserve(state, 1440, "run"), 400);
  assert.equal(assistantContext.dockReserve(state, 1279, "run"), 0);
  assert.equal(assistantContext.dockReserve(state, 1440, "entry"), 0);
  assert.equal(assistantContext.dockReserve({ ...state, docked: false }, 1440, "run"), 0);
  assert.equal(assistantContext.dockReserve({ ...state, open: false }, 1440, "run"), 0);
  // the page keeps DOCK_PAGE_MIN_W: a 720 px drawer at 1280 px is capped
  assert.equal(assistantContext.dockReserve({ ...state, width: 720 }, 1280, "run"), 1280 - assistantContext.DOCK_PAGE_MIN_W);
  assert.equal(assistantContext.dockReserve({ ...state, width: 360 }, 1280, "run"), 360);
  off();
  assistantContext.resetAssistantContextForTests();
});

test("askAssistant opens the drawer, notifies listeners and keeps the last request for a late subscriber", () => {
  assistantContext.resetAssistantContextForTests();
  const seen = [];
  const first = assistantContext.askAssistant("Why did the run stop?");
  assert.equal(first.autoSend, false);
  assert.equal(assistantContext.getDrawerState().open, true);
  const off = assistantContext.subscribeAsk((r) => seen.push(r.text));
  assert.deepEqual(assistantContext.takeLastAsk(), first);
  assert.equal(assistantContext.takeLastAsk(), null);
  const second = assistantContext.askAssistant("Summarize turn r00001_end", { autoSend: true });
  assert.equal(second.autoSend, true);
  assert.ok(second.id > first.id);
  assert.deepEqual(seen, ["Summarize turn r00001_end"]);
  off();
  assistantContext.askAssistant("ignored");
  assert.deepEqual(seen, ["Summarize turn r00001_end"]);
  assistantContext.resetAssistantContextForTests();
});

test("describeAction renders the primary section from the typed action, never from prose", () => {
  const d = assistantBrief.describeAction;
  assert.deepEqual(d(null), ["This proposal could not be validated, so nothing can be executed from it."]);
  assert.deepEqual(d({ type: "create_run", name: "Arena", agent_count: 8, overlay: { default_model_key: "fake-heuristic" } }), [
    'Creates a paused run "Arena" with 8 agents with model fake-heuristic.',
    "Nothing is spent until you play it.",
  ]);
  const step = d({ type: "run_command", run_id: "run_1", command: "step_round", rounds: 3 }, { runNames: { run_1: "Arena" }, onScreenRunId: "run_1", runState: "paused" });
  assert.equal(step[0], 'Sends Step round ×3 to run "Arena" (run_1) (state paused).');
  assert.match(step[1], /3 rounds/);
  const play = d({ type: "run_command", run_id: "run_2", command: "play", rounds: null });
  assert.equal(play[0], "Sends Play to run run_2.");
  const staged = d({
    type: "stage_interventions",
    run_id: "run_1",
    interventions: [
      { type: "set_stat", entity_id: "a01", field: "health", value: 50 },
      { type: "voice", recipients: { mode: "broadcast_all" }, text: "A storm is coming" },
    ],
  });
  assert.equal(staged.length, 3);
  assert.match(staged[0], /Stages 2 god-mode edits on run run_1 \(origin: assistant\)/);
  assert.equal(staged[1], "• set a01.health = 50");
  assert.match(staged[2], /voice to all living agents: "A storm is coming"/);
  assert.deepEqual(d({ type: "create_continuation", run_id: "run_1", from_turn_id: "r00002_end", name: null }), ["Creates a new run that continues run_1 from turn r00002_end (opens paused)."]);
  assert.deepEqual(d({ type: "open_run", run_id: "run_9" }), ["Opens run run_9 in this tab. Nothing executes."]);
  assert.deepEqual(d({ type: "update_assistant_settings", run_id: "run_1", storybook_auto: true, chat_budget_usd: 8, storybook_budget_usd: null }), [
    "Changes the assistant settings of run run_1: automatic storybook on, chat budget $8.00.",
  ]);
  assert.deepEqual(assistantBrief.describeSetupDiff([{ path: "world.region.max_x", default: 5, value: 3 }, { path: "real_budget_usd", default: null, value: 2 }]), [
    "world.region.max_x: 5 → 3",
    "real_budget_usd: none → 2",
  ]);
});

test("approve labels name the effect; run commands need their run on screen", () => {
  const a = assistantBrief.approveLabel;
  assert.equal(a({ type: "create_run", name: "x", agent_count: 6, overlay: {} }), "Approve: create run");
  assert.equal(a({ type: "run_command", run_id: "r", command: "step_round", rounds: 3 }), "Approve: step 3 rounds");
  assert.equal(a({ type: "run_command", run_id: "r", command: "step_round", rounds: 1 }), "Approve: step 1 round");
  assert.equal(a({ type: "run_command", run_id: "r", command: "play", rounds: null }), "Approve: play");
  assert.equal(a({ type: "stage_interventions", run_id: "r", interventions: [{ type: "remove_entity", entity_id: "p1" }] }), "Approve: stage 1 edit");
  assert.equal(a({ type: "open_run", run_id: "r" }), "Open run");
  assert.equal(a(null), "Approve");
  assert.equal(assistantBrief.requiresOnScreenRun({ type: "run_command", run_id: "run_1", command: "play", rounds: null }), "run_1");
  assert.equal(assistantBrief.requiresOnScreenRun({ type: "open_run", run_id: "run_1" }), null);
  assert.equal(assistantBrief.quoteBrief("Fight arena"), "> Fight arena\nChange this: ");
});

test("the error table maps model and API codes to plain text and an action", () => {
  const g = assistantBrief.errorGuidance;
  assert.equal(g(null, "not_logged_in").action, "login");
  assert.match(g(null, "not_logged_in").text, /Run `claude` once/);
  assert.equal(g(null, "cli_missing").action, "install");
  assert.equal(g(null, "timeout").action, "shorter");
  assert.equal(g(null, "budget_exceeded").action, "shorter");
  assert.equal(g(null, "rate_limited").action, "retry");
  assert.equal(g(null, "schema_mismatch").action, "retry");
  assert.equal(g(null, "cancelled").text, "Stopped at your request.");
  assert.equal(g(null, "assistant_unavailable").action, "docs");
  assert.equal(g(null, "assistant_budget_exhausted", "chat $5.00").action, "raise_limit");
  assert.match(g(null, "assistant_budget_exhausted", "chat $5.00").text, /chat \$5\.00/);
  assert.equal(g(null, "conversation_busy").action, "none");
  assert.equal(g(null, "brief_not_pending").actionLabel, "");
  assert.equal(g("malformed", null).action, "retry");
  assert.equal(g("refusal", null).action, "none");
  assert.equal(g("interrupted", null).action, "retry");
  assert.equal(g(null, null, "boom").text, "Something went wrong: boom");
  assert.equal(g(null, null).text, "Something went wrong.");
});

test("suggestions follow the context and the chip mirrors the store", () => {
  const base = { page: "run", runId: "run_1", runName: "Arena", liveTurnId: "r00002_end", shownTurnId: "r00001_t01_a01", tab: "inspect", selectedPoint: { x: 1, y: 2 }, selectedEntityId: "a01", selectedEntityKind: "agent", runState: "error", lastError: "boom", storyId: null };
  const run = assistantBrief.buildSuggestions(base, { selectedName: "Eos" });
  assert.equal(run[0], "Why did the run stop?");
  assert.equal(run[1], "What is Eos up to?");
  assert.ok(run.includes("Summarize turn r00001_t01_a01"));
  assert.ok(run.length <= 5);
  const home = assistantBrief.buildSuggestions({ ...base, page: "entry", runId: null });
  assert.equal(home[0], "What is Empyrean and how do I start?");
  assert.ok(home.includes("Set up a fight arena"));
  const offline = assistantBrief.buildSuggestions({ ...base, page: "entry", runId: null }, { available: false });
  assert.ok(!offline.some((s) => s.startsWith("Set up")));
  assert.deepEqual(assistantBrief.chipFromContext(base), {
    page: "run", run_id: "run_1", run_name: "Arena", shown_turn_id: "r00001_t01_a01", live_turn_id: "r00002_end", tab: "inspect",
    selected_entity_id: "a01", selected_entity_kind: "agent", selected_point: "1,2", run_state: "error", last_error: "boom", story_id: null,
  });
  assert.equal(assistantBrief.scopeRunId(base), "run_1");
  assert.equal(assistantBrief.scopeRunId({ ...base, page: "new" }), null);
  assert.equal(assistantBrief.scopeRunId({ ...base, page: "story" }), "run_1");
  assert.equal(assistantBrief.progressLine(2, 4, 18.4, 0.031), "step 2/4 · 18 s · $0.03");
  assert.equal(assistantBrief.progressLine(0, 0, 75, 0), "step 1 · 1 min 15 s · $0.00");
  assert.equal(assistantBrief.formatUsd(0.001), "<$0.01");
  assert.equal(assistantBrief.docSectionFor("SYSTEM.md#economy"), "resources");
  assert.equal(assistantBrief.docSectionFor("CONTROLS.md#god-mode"), "operator");
  assert.equal(assistantBrief.docSectionFor("nothing-here"), null);
  assert.equal(assistantBrief.searchDocSections("attack death residue")[0].id, "conflict");
  assert.deepEqual(assistantBrief.searchDocSections("zz"), []);
});

test("progressNote keeps the backend's step note and drops its stale seconds and cost", () => {
  assert.equal(assistantBrief.progressNote("step 1/4 · 0 s · $0.00"), null);
  assert.equal(assistantBrief.progressNote("step 2/4 · 3 s · $0.01 · reading the run"), "reading the run");
  assert.equal(assistantBrief.progressNote("step 2/4 · 3 s · $0.01 · a · b"), "a · b");
  assert.equal(assistantBrief.progressNote("step 3 · 0 s · $0.00"), null);
  assert.equal(assistantBrief.progressNote("queued"), "Queued…");
  assert.equal(assistantBrief.progressNote("Summarising the log"), "Summarising the log");
  assert.equal(assistantBrief.progressNote(""), null);
  assert.equal(assistantBrief.progressNote(null), null);
  assert.equal(assistantBrief.progressNote(undefined), null);
});

test("effectStatusFor returns an approved brief's run status only for the run on screen", () => {
  const status = { run_id: "run_1", staged_intervention_count: 1 };
  const effect = { run_id: "run_1", run_summary: null, status, staged_ids: ["iv_0001"], rounds_done: null, rounds_requested: null, message: "", executed_at: null };
  assert.equal(assistantBrief.effectStatusFor(effect, "run_1"), status);
  assert.equal(assistantBrief.effectStatusFor(effect, "run_2"), null);
  assert.equal(assistantBrief.effectStatusFor(effect, null), null);
  assert.equal(assistantBrief.effectStatusFor({ ...effect, status: null }, "run_1"), null);
  assert.equal(assistantBrief.effectStatusFor(null, "run_1"), null);
  assert.equal(assistantBrief.effectStatusFor(undefined, "run_1"), null);
});

test("refChipText drops a leading copy of the chip's kind", () => {
  assert.equal(assistantFormat.refChipText(["turn", "turn"], "turn r00002_t01_a04", "r00002_t01_a04"), "r00002_t01_a04");
  assert.equal(assistantFormat.refChipText(["turn", "turn"], "Turn: r00002_end", "r00002_end"), "r00002_end");
  assert.equal(assistantFormat.refChipText(["turn", "turn"], "turn:r00002_end", "r00002_end"), "r00002_end");
  assert.equal(assistantFormat.refChipText(["docs", "doc"], "docs SYSTEM.md#economy", "SYSTEM.md#economy"), "SYSTEM.md#economy");
  assert.equal(assistantFormat.refChipText(["docs", "doc"], "doc SYSTEM.md", "SYSTEM.md"), "SYSTEM.md");
  // not a prefix word, or nothing after it: unchanged
  assert.equal(assistantFormat.refChipText(["turn", "turn"], "turnover in round 3", "r00003_end"), "turnover in round 3");
  assert.equal(assistantFormat.refChipText(["entity", "entity"], "entity", "a04"), "entity");
  assert.equal(assistantFormat.refChipText(["entity", "entity"], "Eos (a04)", "a04"), "Eos (a04)");
  // no label: the id
  assert.equal(assistantFormat.refChipText(["run", "run"], null, "run_1"), "run_1");
  assert.equal(assistantFormat.refChipText(["run", "run"], "  ", "run_1"), "run_1");
});

test("working indicator: elapsed seconds tick from a start timestamp, a new piece of work restarts a local counter", () => {
  const t0 = Date.parse("2026-09-26T10:00:00Z");
  assert.equal(working.formatElapsed(0), "0 s");
  assert.equal(working.formatElapsed(59.4), "59 s");
  assert.equal(working.formatElapsed(65), "1 min 05 s");
  assert.equal(assistantBrief.formatElapsed(65), "1 min 05 s");
  assert.equal(working.startMs("2026-09-26T10:00:00Z"), t0);
  assert.equal(working.startMs(t0), t0);
  assert.equal(working.startMs(null), null);
  assert.equal(working.startMs(""), null);
  assert.equal(working.startMs("not a date"), null);
  assert.equal(working.elapsedSince("2026-09-26T10:00:00Z", t0 + 12_900), 12);
  assert.equal(working.elapsedSince(t0, t0 - 5000), 0); // clock skew never goes negative
  assert.equal(working.elapsedSince(undefined, t0), null);
  const first = working.trackStart(null, "job1:ch2", null, t0);
  assert.deepEqual(first, { key: "job1:ch2", startMs: t0 });
  assert.equal(working.trackStart(first, "job1:ch2", null, t0 + 9000), first); // same work: keep counting
  assert.deepEqual(working.trackStart(first, "job1:ch3", null, t0 + 9000), { key: "job1:ch3", startMs: t0 + 9000 });
  assert.deepEqual(working.trackStart(first, "job2", "2026-09-26T09:59:50Z", t0), { key: "job2", startMs: t0 - 10_000 });
});

test("storyWork names what the story's model is doing: sending, the author, a chapter, the queue, stopping", () => {
  const session = { status: "interviewing", chapters_done: 0, chapters_total: 0, brief: null, superseded_briefs: [], generate_all: false, spent_usd: 0.12, job_budget_usd: 2, messages: [{ role: "user", created_at: "2026-09-26T10:00:00Z" }] };
  const job = { job_id: "j1", status: "running", queue_position: 0, queued_behind: null, cancel_requested: false, started_at: "2026-09-26T10:00:01Z" };
  assert.equal(storyMode.storyWork(null, job, []), null);
  assert.equal(storyMode.storyWork(session, null, []), null);
  assert.equal(storyMode.storyWork(session, { ...job, status: "done" }, []), null);
  const sending = storyMode.storyWork(session, null, [], true);
  assert.equal(sending.state, "sending");
  assert.equal(sending.stage, "author");
  assert.match(sending.label, /^Sending your choices to the story author/);
  const author = storyMode.storyWork(session, job, []);
  assert.equal(author.label, "Story author is thinking…");
  assert.equal(author.stage, "author");
  assert.equal(author.startedAt, job.started_at);
  assert.equal(author.cancellable, true);
  assert.match(author.note, /story brief from your choices/);
  assert.match(storyMode.storyWork({ ...session, superseded_briefs: [{}] }, job, []).note, /new story brief from your changes/);
  const queued = storyMode.storyWork(session, { ...job, status: "queued", started_at: null, queued_behind: 'Queued behind "The Arena" (ch 40/285)' }, []);
  assert.equal(queued.label, 'Queued behind "The Arena" (ch 40/285)…');
  assert.equal(queued.startedAt, "2026-09-26T10:00:00Z"); // counts from the user's request
  assert.equal(storyMode.storyWork(session, { ...job, status: "queued", queue_position: 2 }, []).label, "Queued (position 2)…");
  const stopping = storyMode.storyWork(session, { ...job, cancel_requested: true }, []);
  assert.equal(stopping.state, "stopping");
  assert.equal(stopping.cancellable, false);
  assert.equal(storyMode.storyWork({ ...session, status: "cancelled" }, { ...job, cancel_requested: true }, []).label, "Stopping the story author…");
  const gen = { ...session, status: "generating", chapters_done: 2, chapters_total: 11, brief: { status: "executing", chapter_plan: [] } };
  const chapters = [
    { number: 1, created_at: "2026-09-26T10:00:20Z" },
    { number: 2, created_at: "2026-09-26T10:00:45Z" },
  ];
  const ch = storyMode.storyWork(gen, job, chapters);
  assert.equal(ch.label, "Writing chapter 3 of 11…");
  assert.equal(ch.stage, "chapters");
  assert.equal(ch.chapter, 3);
  assert.equal(ch.startedAt, "2026-09-26T10:00:45Z"); // the previous chapter's time, later than the job's start
  assert.equal(ch.key, "j1:ch3");
  assert.match(ch.note, /Written 3 ahead of where you read · spent \$0\.12 of \$2\.00/);
  assert.equal(storyMode.storyWork({ ...gen, chapters_done: 0 }, job, []).startedAt, job.started_at);
  assert.equal(storyMode.storyWork({ ...gen, chapters_done: 0 }, job, []).label, "Writing chapter 1 of 11…");
  assert.match(storyMode.storyWork({ ...gen, generate_all: true }, job, chapters).note, /^Writing every remaining chapter/);
  assert.equal(storyMode.storyWork(gen, { ...job, cancel_requested: true }, chapters).label, "Stopping after the current chapter…");
  assert.equal(storyMode.storyWork({ ...gen, chapters_done: 11 }, job, chapters).label, "Finishing the story…");
  // The session count trails the chapter files for one poll: chapter 1 is on screen, so the banner names chapter 2.
  assert.equal(storyMode.storyWork({ ...gen, chapters_done: 0 }, job, [chapters[0]]).label, "Writing chapter 2 of 11…");
});

test("storybookWorkingLabel says how many turns are being narrated; the status line then omits the pending count", () => {
  assert.equal(storyMode.storybookWorkingLabel({ pending_count: 3, in_flight: true }), "Narrating 3 turns…");
  assert.equal(storyMode.storybookWorkingLabel({ pending_count: 1, in_flight: false }), "Narrating 1 turn…");
  assert.equal(storyMode.storybookWorkingLabel({ pending_count: 0, in_flight: true }), "Narrating…");
  assert.equal(storyMode.storybookWorkingLabel({ pending_count: 0, in_flight: false }), null);
  assert.equal(storyMode.storybookWorkingLabel(null), null);
  const spend = { limit_usd: 2, spent_usd: 0.35 };
  assert.deepEqual(storyMode.storybookStatusParts({ pending_count: 3, in_flight: true, missing_count: 0, spend, entry_count: 1 }, false), ["1 entry", "spent $0.35 of $2.00"]);
});


test("story mode run picker: unfinished stories first, finished newest first", () => {
  const story = (over) => ({ story_id: "s", run_id: "r1", run_name: "", title: "T", status: "complete", unit: "turn", chapters_done: 0, chapters_total: 0, spent_usd: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...over });
  const stories = [
    story({ story_id: "a", run_id: "r1", status: "generating", chapters_done: 3, chapters_total: 11, title: "The Chronicle", updated_at: "2026-01-03T00:00:00Z" }),
    story({ story_id: "b", run_id: "r2", status: "brief_pending", updated_at: "2026-01-05T00:00:00Z" }),
    story({ story_id: "c", run_id: "r1", status: "interviewing", updated_at: "2026-01-02T00:00:00Z" }),
    story({ story_id: "d", run_id: "r3", status: "complete", updated_at: "2026-01-04T00:00:00Z" }),
    story({ story_id: "e", run_id: "r9", status: "complete", updated_at: "2026-01-06T00:00:00Z" }),
    story({ story_id: "f", run_id: "r2", status: "cancelled", updated_at: "2026-01-09T00:00:00Z" }),
  ];
  const work = storyMode.unfinishedByRun(stories);
  assert.deepEqual([...work.keys()].sort(), ["r1", "r2"]);
  assert.equal(work.get("r1").count, 2);
  assert.equal(work.get("r1").story.story_id, "a");
  const runs = [
    { run_id: "r3", saved_at: "2026-01-09T00:00:00Z" },
    { run_id: "r1", saved_at: "2026-01-01T00:00:00Z" },
    { run_id: "r4", saved_at: "2026-01-08T00:00:00Z" },
    { run_id: "r2", saved_at: "2026-01-02T00:00:00Z" },
  ];
  assert.deepEqual(storyMode.orderRunsForPicker(runs, work).map((r) => r.run_id), ["r2", "r1", "r3", "r4"]);
  assert.equal(storyMode.unfinishedStoryText(work.get("r1")), "writing 3 of 11 · The Chronicle (+1 more)");
  assert.equal(storyMode.unfinishedStoryText(work.get("r2")), "Story brief waiting for you · T");
  assert.equal(storyMode.unfinishedStoryText(undefined), "");
  assert.deepEqual(storyMode.finishedStoriesNewestFirst(stories).map((s) => s.story_id), ["e", "d"]);
});

// ---------------------------------------------------------------- selection (Resume page multi-select)

const IDS = ["r1", "r2", "r3", "r4", "r5"];
const sel = (...ids) => new Set(ids);
const sorted = (set) => [...set].sort();

test("selection: a plain checkbox click toggles and sets the anchor", () => {
  let out = selection.applySelectionClick(sel(), null, "r2", IDS, { ctrl: false, shift: false, source: "checkbox" });
  assert.deepEqual(sorted(out.selection), ["r2"]);
  assert.equal(out.anchor, "r2");
  out = selection.applySelectionClick(sel("r2", "r4"), "r2", "r4", IDS, { ctrl: false, shift: false, source: "checkbox" });
  assert.deepEqual(sorted(out.selection), ["r2"]);
  assert.equal(out.anchor, "r4");
  // source defaults to the checkbox
  assert.deepEqual(sorted(selection.applySelectionClick(sel("r1"), "r1", "r3", IDS, { ctrl: false, shift: false }).selection), ["r1", "r3"]);
});

test("selection: ctrl/cmd-click toggles on the checkbox and on the row; a plain row click selects only that row", () => {
  let out = selection.applySelectionClick(sel("r1"), "r1", "r3", IDS, { ctrl: true, shift: false, source: "row" });
  assert.deepEqual(sorted(out.selection), ["r1", "r3"]);
  assert.equal(out.anchor, "r3");
  out = selection.applySelectionClick(out.selection, out.anchor, "r1", IDS, { ctrl: true, shift: false, source: "checkbox" });
  assert.deepEqual(sorted(out.selection), ["r3"]);
  out = selection.applySelectionClick(sel("r1", "r3", "r5"), "r5", "r2", IDS, { ctrl: false, shift: false, source: "row" });
  assert.deepEqual(sorted(out.selection), ["r2"]);
  assert.equal(out.anchor, "r2");
  // a plain row click on the only selected row keeps it selected
  assert.deepEqual(sorted(selection.applySelectionClick(sel("r2"), "r2", "r2", IDS, { ctrl: false, shift: false, source: "row" }).selection), ["r2"]);
});

test("selection: shift-click adds the range from the anchor in either direction and keeps the anchor", () => {
  let out = selection.applySelectionClick(sel("r1"), "r2", "r4", IDS, { ctrl: false, shift: true, source: "checkbox" });
  assert.deepEqual(sorted(out.selection), ["r1", "r2", "r3", "r4"]);
  assert.equal(out.anchor, "r2");
  out = selection.applySelectionClick(sel(), "r4", "r2", IDS, { ctrl: false, shift: true, source: "row" });
  assert.deepEqual(sorted(out.selection), ["r2", "r3", "r4"]);
  // ctrl + shift is still a range
  out = selection.applySelectionClick(sel(), "r5", "r5", IDS, { ctrl: true, shift: true, source: "row" });
  assert.deepEqual(sorted(out.selection), ["r5"]);
  // the anchor is not shown (filtered out) or missing: behaves like a ctrl-click
  out = selection.applySelectionClick(sel("r1"), "gone", "r3", IDS, { ctrl: false, shift: true });
  assert.deepEqual(sorted(out.selection), ["r1", "r3"]);
  assert.equal(out.anchor, "r3");
  out = selection.applySelectionClick(sel(), null, "r3", IDS, { ctrl: false, shift: true });
  assert.deepEqual(sorted(out.selection), ["r3"]);
});

test("selection: the example flow of the browser check (two ctrl-clicks, then a shift range)", () => {
  let state = { selection: sel(), anchor: null };
  state = selection.applySelectionClick(state.selection, state.anchor, "r1", IDS, { ctrl: true, shift: false, source: "row" });
  state = selection.applySelectionClick(state.selection, state.anchor, "r3", IDS, { ctrl: true, shift: false, source: "row" });
  state = selection.applySelectionClick(state.selection, state.anchor, "r5", IDS, { ctrl: false, shift: true, source: "row" });
  assert.deepEqual(sorted(state.selection), ["r1", "r3", "r4", "r5"]);
  assert.deepEqual(selection.selectedInOrder(state.selection, IDS), ["r1", "r3", "r4", "r5"]);
});

test("selection: the header checkbox reflects and toggles only the shown rows; filtering keeps hidden selections", () => {
  const shown = ["r2", "r3"];
  assert.equal(selection.headerState(sel(), shown), "none");
  assert.equal(selection.headerState(sel("r1"), shown), "none");
  assert.equal(selection.headerState(sel("r1", "r2"), shown), "some");
  assert.equal(selection.headerState(sel("r2", "r3"), shown), "all");
  assert.equal(selection.headerState(sel("r2"), []), "none");
  assert.deepEqual(sorted(selection.toggleAllShown(sel("r1", "r2"), shown)), ["r1", "r2", "r3"]);
  assert.deepEqual(sorted(selection.toggleAllShown(sel("r1", "r2", "r3"), shown)), ["r1"]);
});

test("selection: prune drops ids that no longer exist and keeps the same set when nothing changed", () => {
  const current = sel("r1", "r9");
  assert.deepEqual(sorted(selection.pruneSelection(current, IDS)), ["r1"]);
  const same = sel("r1", "r2");
  assert.equal(selection.pruneSelection(same, IDS), same);
});


test("agent view overlay: one marker per entity, the latest sighting wins", async () => {
  const logic = await load("components/inspect/logic.mjs");
  const overlay = {
    agentId: "a01", agentName: "Aster", believedPosition: { x: 0, y: 0 },
    observed: [
      { id: "a02", kind: "agent", alive: true, position: { x: 1, y: 0 }, observed_round: 3 },
      { id: "a02", kind: "agent", alive: true, position: { x: 2, y: 0 }, observed_round: 7 },
      { id: "a01", kind: "agent", alive: true, position: { x: 0, y: 0 }, observed_round: 7 },
      { id: "p0001", kind: "plant", alive: true, position: { x: 1, y: 0 }, observed_round: 1 },
    ],
  };
  const markers = logic.overlayMarkers(overlay);
  assert.deepEqual(markers.map((m) => m.id).sort(), ["a01", "a02", "p0001"]);
  assert.deepEqual(markers.find((m) => m.id === "a02").position, { x: 2, y: 0 });
  assert.equal(markers.find((m) => m.id === "a01").self, true);
});
