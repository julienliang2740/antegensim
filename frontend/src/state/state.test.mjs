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
  "state/profile.ts",
  "state/map3dView.ts",
  "state/map3dLayout.ts",
  "state/map3dTimeline.ts",
  "state/map3dCamera.ts",
  "state/map3dTerrain.ts",
  "state/map3dPalette.ts",
  "state/map3dGlyphs.ts",
  "state/turnEffects.ts",
  "components/inspect/mapDots.ts",
  "state/mapIndicators.ts",
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
const profile = await load("state/profile.mjs");
const turnEffects = await load("state/turnEffects.mjs");
const map3dView = await load("state/map3dView.mjs");
const map3dLayout = await load("state/map3dLayout.mjs");
const map3dTimeline = await load("state/map3dTimeline.mjs");
const map3dCamera = await load("state/map3dCamera.mjs");
const map3dTerrain = await load("state/map3dTerrain.mjs");
const map3dPalette = await load("state/map3dPalette.mjs");
const map3dGlyphs = await load("state/map3dGlyphs.mjs");
const mapDots = await load("components/inspect/mapDots.mjs");
const mapIndicators = await load("state/mapIndicators.mjs");

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
  assert.equal(step[0], 'Sends Finish round ×3 to run "Arena" (run_1) (state paused).');
  assert.match(step[1], /3 rounds/);
  const play = d({ type: "run_command", run_id: "run_2", command: "play", rounds: null });
  assert.equal(play[0], "Sends Start simulation to run run_2.");
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
  assert.equal(a({ type: "run_command", run_id: "r", command: "play", rounds: null }), "Approve: start simulation");
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

// ---------------------------------------------------------------- entity profile card

function indexEntry(turn_id, overrides = {}) {
  return { turn_id, kind: "agent_turn", round: 1, turn_index: 1, acting_agent_id: "a01", action_name: "move", ok: true, decision_source: "model", intervention_count: 0, event_count: 3, saved_at: "", ...overrides };
}

test("profile: sections per kind, Overview fallback and keyboard movement", () => {
  assert.deepEqual(profile.profileSections("agent").map((s) => s.label), ["Overview", "Decisions", "Skills", "Knowledge", "Messages", "History"]);
  assert.deepEqual(profile.profileSections("plant").map((s) => s.label), ["Overview", "Growth", "Rules", "History"]);
  for (const kind of ["fruit", "seed", "residue"]) assert.deepEqual(profile.profileSections(kind).map((s) => s.id), ["overview", "history"]);
  assert.equal(profile.sectionFor("plant", "decisions"), "overview");
  assert.equal(profile.sectionFor("agent", "decisions"), "decisions");
  assert.equal(profile.sectionFor("fruit", "history"), "history");
  assert.equal(profile.navTarget("ArrowDown", 0, 4), 1);
  assert.equal(profile.navTarget("ArrowDown", 3, 4), 0);
  assert.equal(profile.navTarget("ArrowUp", 0, 4), 3);
  assert.equal(profile.navTarget("ArrowLeft", 2, 4), 1);
  assert.equal(profile.navTarget("End", 0, 4), 3);
  assert.equal(profile.navTarget("Home", 3, 4), 0);
  assert.equal(profile.navTarget("Enter", 1, 4), null);
});

test("profile: acting turns stop at the viewed turn, newest first; message turns are send/broadcast", () => {
  const turns = [
    indexEntry("r00001_t00_init", { kind: "init", acting_agent_id: null }),
    indexEntry("r00001_t01_a01"),
    indexEntry("r00001_t02_a02", { acting_agent_id: "a02" }),
    indexEntry("r00001_end", { kind: "round_end", acting_agent_id: null }),
    indexEntry("r00002_t01_a01", { round: 2, action_name: "send" }),
    indexEntry("r00002_t02_a01", { round: 2, action_name: "broadcast", ok: false }),
  ];
  assert.deepEqual(profile.actingTurns(turns, "a01", "r00002_t01_a01").map((t) => t.turn_id), ["r00002_t01_a01", "r00001_t01_a01"]);
  assert.deepEqual(profile.actingTurns(turns, "a01", "r00001_end").map((t) => t.turn_id), ["r00001_t01_a01"]);
  // A turn that is not in the index (not loaded yet): the whole index.
  assert.equal(profile.actingTurns(turns, "a01", "r00009_t01_a01").length, 3);
  assert.deepEqual(profile.messageTurns(profile.actingTurns(turns, "a01", "r00002_t02_a01")).map((t) => t.turn_id), ["r00002_t02_a01", "r00002_t01_a01"]);
});

test("profile: a decision row reads thought, action, result, costs, skill and call ids from the events", () => {
  const events = [
    event(1, { kind: "turn_started", actor: "system" }),
    event(2, { kind: "model_call_completed", actor: "a03", details: { call_id: "mc_r00001_t01_a03_01" }, costs: { compute: 2.5, essence: 0 } }),
    event(3, { kind: "decision", details: { thought: "Eat the fruit.", notebook_updated: true, saved_skills: ["forage"], deleted_skills: [], memory_priorities: [{ record_id: "k1", priority: 0.5 }] } }),
    event(4, { kind: "action", details: { action: { name: "absorb", args: { source: "f0004", resource: "compute" } }, result: { ok: true, reason: "ok", cost_compute: 1, cost_essence: 0 }, via_skill: false, skill_name: null }, costs: { compute: 1, essence: 0 } }),
    event(5, { kind: "action", actor: "a05", details: { action: { name: "move", args: {} }, result: { ok: true } } }),
  ];
  const d = profile.decisionFromEvents("a03", events);
  assert.equal(d.thought, "Eat the fruit.");
  assert.deepEqual(d.action, { name: "absorb", args: { source: "f0004", resource: "compute" } });
  assert.equal(d.ok, true);
  assert.equal(d.costCompute, 1);
  assert.equal(d.thinkingCompute, 2.5);
  assert.deepEqual(d.callIds, ["mc_r00001_t01_a03_01"]);
  assert.equal(d.problem, null);
  assert.deepEqual(d.extras, ["notebook updated", "saved skills: forage", "memory priorities: 1"]);

  const viaSkill = profile.decisionFromEvents("a03", [
    event(1, { kind: "action", details: { action: { name: "attack", args: { target: "a02" } }, result: { ok: false, reason: "target_gone", cost_compute: 0.5, cost_essence: 0 }, via_skill: true, skill_name: "hunt" } }),
  ]);
  assert.equal(viaSkill.viaSkill, true);
  assert.equal(viaSkill.skillName, "hunt");
  assert.equal(viaSkill.ok, false);
  assert.equal(viaSkill.reason, "target_gone");
  assert.equal(viaSkill.thought, null);

  const failed = profile.decisionFromEvents("a03", [event(1, { kind: "model_call_failed", details: { call_id: "mc_x_01", error: "timeout" }, costs: { compute: 1, essence: 0 } })]);
  assert.equal(failed.action, null);
  assert.equal(failed.problem, "timeout");
  assert.deepEqual(failed.callIds, ["mc_x_01"]);
});

test("profile: sent messages pair each successful send with its delivery", () => {
  const events = [
    event(1, { kind: "action", details: { action: { name: "send", args: { recipient: "a02", message: "hello" } }, result: { ok: true } } }),
    event(2, { kind: "message_delivered", details: { recipients: ["a02"], broadcast: false } }),
    event(3, { kind: "action", details: { action: { name: "broadcast", args: { message: "anyone?" } }, result: { ok: false, reason: "insufficient_compute" } } }),
    event(4, { kind: "action", details: { action: { name: "move", args: {} }, result: { ok: true } } }),
  ];
  const sent = profile.sentMessages("a03", events);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], { kind: "send", recipient: "a02", message: "hello", ok: true, reason: null, delivered: ["a02"] });
  assert.equal(sent[1].kind, "broadcast");
  assert.equal(sent[1].ok, false);
  assert.equal(sent[1].reason, "insufficient_compute");
  assert.deepEqual(sent[1].delivered, []);
  assert.deepEqual(profile.sentMessages("a09", events), []);
});

test("profile: excerpt flattens whitespace and cuts with an ellipsis", () => {
  assert.equal(profile.excerpt("  a\n b  "), "a b");
  assert.equal(profile.excerpt("abcdefghij", 5), "abcd…");
  assert.equal(profile.excerpt("abcde", 5), "abcde");
});

// ---------------------------------------------------------------- turnEffects

/** A TurnView-shaped fixture: one acting agent, its action and result, the turn's events, the entities after the turn. */
function turnView({ actor = "a03", action = null, result = null, events = [], agents = {}, plants = {}, fruits = {}, removed = {} } = {}) {
  return {
    live: true,
    turn: { turn_id: "r00002_t01_a03", kind: "agent_turn", round: 2, acting_agent_id: actor, action, action_result: result },
    entities: { agents, plants, fruits, seeds: {}, residues: {}, removed },
    // Events default to this turn's id; a test that wants another turn's event sets turn_id itself.
    events: events.map((e) => ({ turn_id: "r00002_t01_a03", ...e })),
  };
}
const agentAt = (id, x, y, alive = true) => ({ kind: "agent", id, name: id.toUpperCase(), position: { x, y }, alive });
const plantAt = (id, x, y) => ({ kind: "plant", id, position: { x, y }, species: "fruit_tree", alive: true });

test("turnEffects: a move reads its path from the result; a blocked move keeps the agent and points at the blocked cell", () => {
  const moved = turnEffects.turnEffects(
    turnView({ action: { name: "move", args: { direction: "up" }, via_skill: false, skill_name: null }, result: { ok: true, reason: "ok", effects: { from: { x: 1, y: 1 }, to: { x: 1, y: 2 } } }, agents: { a03: agentAt("a03", 1, 2) } }),
  );
  assert.equal(moved.length, 1);
  assert.equal(moved[0].kind, "move");
  assert.deepEqual(moved[0].from, { x: 1, y: 1 });
  assert.deepEqual(moved[0].to, { x: 1, y: 2 });
  assert.deepEqual(moved[0].at, { x: 1, y: 2 });
  assert.equal(moved[0].ok, true);
  assert.equal(moved[0].amount, null);
  assert.equal(moved[0].broadcast, false);
  assert.equal(moved[0].label, "moved up");

  const blocked = turnEffects.actingEffect(
    turnView({ action: { name: "move", args: { direction: "left" }, via_skill: true, skill_name: "roam" }, result: { ok: false, reason: "blocked", effects: {} }, agents: { a03: agentAt("a03", 0, 0) } }),
  );
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.from, { x: 0, y: 0 });
  assert.deepEqual(blocked.to, { x: -1, y: 0 });
  assert.deepEqual(blocked.at, { x: 0, y: 0 });
  assert.equal(blocked.label, "moved left via skill roam (failed: blocked)");
  assert.equal(turnEffects.stepDirection({ x: 0, y: 0 }, { x: 0, y: 1 }), "up");
  assert.equal(turnEffects.stepDirection({ x: 0, y: 0 }, { x: -1, y: 0 }), "left");
  assert.equal(turnEffects.stepDirection({ x: 0, y: 0 }, { x: 0, y: 0 }), "still");
  assert.deepEqual(turnEffects.moveTarget({ x: 2, y: 2 }, "down"), { x: 2, y: 1 });
});

test("turnEffects: attack, messages, absorb and transfer name their targets and cells", () => {
  const agents = { a03: agentAt("a03", 4, 4), a05: agentAt("a05", 4, 4), a07: agentAt("a07", 9, 1) };
  const attack = turnEffects.actingEffect(
    turnView({ action: { name: "attack", args: { target: "a05", compute_budget: 5 }, via_skill: false, skill_name: null }, result: { ok: true, reason: "ok", effects: { damage: 5, target: "a05", target_health_after: 15, killed: false } }, agents }),
  );
  assert.equal(attack.kind, "attack");
  assert.deepEqual(attack.targets, ["a05"]);
  assert.deepEqual(attack.targetPoints, [{ x: 4, y: 4 }]);
  assert.equal(attack.amount, 5);
  assert.equal(attack.label, "attacked a05 (5 damage)");

  const broadcast = turnEffects.actingEffect(
    turnView({
      action: { name: "broadcast", args: { message: "hi" }, via_skill: false, skill_name: null },
      result: { ok: true, reason: "ok", effects: { delivered_visible: 2 } },
      events: [{ seq: 9, kind: "message_delivered", actor: "a03", details: { recipients: ["a05", "a07"], broadcast: true } }],
      agents,
    }),
  );
  assert.equal(broadcast.kind, "message");
  assert.deepEqual(broadcast.targets, ["a05", "a07"]);
  assert.deepEqual(broadcast.targetPoints, [{ x: 4, y: 4 }, { x: 9, y: 1 }]);
  assert.equal(broadcast.broadcast, true);
  assert.equal(broadcast.label, "broadcast to 2 agents");

  const send = turnEffects.actingEffect(
    turnView({ action: { name: "send", args: { recipient: "a07", message: "x" }, via_skill: false, skill_name: null }, result: { ok: false, reason: "out_of_range", effects: {} }, agents }),
  );
  assert.deepEqual(send.targets, ["a07"]);
  assert.equal(send.broadcast, false);
  assert.equal(send.ok, false);
  assert.equal(send.label, "sent a message to a07 (failed: out_of_range)");

  const absorb = turnEffects.actingEffect(
    turnView({
      action: { name: "absorb", args: { source: "f0004", resource: "compute" }, via_skill: false, skill_name: null },
      result: { ok: true, reason: "ok", effects: { processed: 10, gained: 2.5, lost: 7.5, source: "f0004", resource: "compute" } },
      agents,
      fruits: { f0004: { kind: "fruit", id: "f0004", position: { x: 4, y: 4 } } },
    }),
  );
  assert.equal(absorb.kind, "absorb");
  assert.deepEqual(absorb.targets, ["f0004"]);
  assert.equal(absorb.amount, 2.5);
  assert.equal(absorb.label, "absorbed from f0004 (+2.5 compute)");

  const transfer = turnEffects.actingEffect(
    turnView({ action: { name: "transfer", args: { recipient: "a05", resource: "essence", amount: 3 }, via_skill: false, skill_name: null }, result: { ok: true, reason: "ok", effects: { transferred: 3, resource: "essence", to: "a05" } }, agents }),
  );
  assert.equal(transfer.label, "transferred 3 essence to a05");
  assert.equal(transfer.amount, 3);
  assert.deepEqual(transfer.targets, ["a05"]);
});

test("turnEffects: world events become death, growth, fruit, germination, starvation and voice effects; turns without an action have no acting effect", () => {
  const view = turnView({
    actor: null,
    action: null,
    result: null,
    agents: { a02: agentAt("a02", 2, 3, false), a04: agentAt("a04", 5, 5) },
    plants: { p0001: plantAt("p0001", 7, 7) },
    events: [
      { seq: 1, kind: "starvation", actor: "a04", details: { agent_id: "a04", health_loss: 5, health_after: 10 } },
      { seq: 2, kind: "death", actor: "world", details: { entity_id: "a02", kind: "agent", cause: "starvation", residue_id: "res0001" } },
      { seq: 3, kind: "residue_created", actor: "world", details: { entity_id: "res0001" } },
      { seq: 4, kind: "plant_growth", actor: "world", details: { plant_id: "p0001", stage: "sapling", stage_index: 1 } },
      { seq: 5, kind: "fruit_spawned", actor: "world", details: { plant_id: "p0001", entity_id: "f0009", position: { x: 7, y: 7 } } },
      { seq: 6, kind: "germination", actor: "world", details: { plant_id: "p0002", entity_id: "s0003", position: { x: 1, y: 9 } } },
      { seq: 7, kind: "operator_voice", actor: "operator", details: { recipients: ["a04"], text: "hello" } },
      { seq: 8, kind: "upkeep", actor: "a04", details: { agent_id: "a04", paid: 1, owed: 1 } },
      // The live view can carry the next, unsaved turn's events: never this turn's effects.
      { seq: 9, turn_id: "r00002_t02_a01", kind: "death", actor: "world", details: { entity_id: "a04", kind: "agent", cause: "attack" } },
    ],
  });
  assert.equal(turnEffects.actingEffect(view), null);
  const effects = turnEffects.turnEffects(view);
  assert.deepEqual(
    effects.map((e) => e.kind),
    ["starvation", "death", "growth", "fruit", "germination", "voice"],
  );
  assert.deepEqual(effects[0].at, { x: 5, y: 5 });
  assert.equal(effects[0].amount, 5);
  assert.equal(effects[0].label, "a04 starves (-5 health)");
  assert.deepEqual(effects[1].at, { x: 2, y: 3 });
  assert.equal(effects[1].label, "a02 died (starvation)");
  assert.deepEqual(effects[2].targets, ["p0001"]);
  assert.deepEqual(effects[3].at, { x: 7, y: 7 });
  assert.deepEqual(effects[3].targets, ["f0009"]);
  assert.deepEqual(effects[4].at, { x: 1, y: 9 });
  assert.deepEqual(effects[5].targets, ["a04"]);
  assert.deepEqual(effects[5].targetPoints, [{ x: 5, y: 5 }]);
  const byPoint = turnEffects.effectsByPoint(effects);
  assert.deepEqual([...byPoint.keys()].sort(), ["1,9", "2,3", "5,5", "7,7"]);
  assert.equal(byPoint.get("7,7").length, 2);
  assert.deepEqual(turnEffects.turnEffects(null), []);
});

// ---------------------------------------------------------------- WP-2D: mapDots + mapIndicators

/** n markers of one kind (ids f0001.., a0001.., res0001..), all at (0, 0). */
const mk = (n, kind = "fruit", dead = false) =>
  Array.from({ length: n }, (_, i) => ({ id: `${kind === "residue" ? "res" : kind[0]}${String(i + 1).padStart(4, "0")}`, kind, dead, position: { x: 0, y: 0 }, title: "", line: "" }));
/** A TurnEffect of agent a03 at (1, 1). */
const fx = (kind, over = {}) => ({ kind, actor: "a03", at: { x: 1, y: 1 }, from: null, to: null, targets: [], targetPoints: [], ok: true, amount: null, broadcast: false, label: kind, ...over });

test("map dots: one diameter per zoom level, whatever the cell holds", () => {
  for (const row of mapDots.DOT_TABLE) {
    for (const n of [1, 4, 9, 10, 25, 26, 100, 400]) {
      const layout = mapDots.layoutCell(mk(n), row.cellPx);
      assert.ok(layout && layout.dots.length > 0, `${row.cellPx} px, n=${n}: a layout`);
      assert.equal(layout.total, n);
      for (const d of layout.dots) {
        assert.equal(d.r, row.d / 2, `${row.cellPx} px, n=${n}: radius`);
        assert.ok(d.cx - d.r >= 0 && d.cx + d.r <= row.cellPx, `${row.cellPx} px, n=${n}: cx ${d.cx} inside the cell`);
        assert.ok(d.cy - d.r >= 0 && d.cy + d.r <= row.cellPx, `${row.cellPx} px, n=${n}: cy ${d.cy} inside the cell`);
      }
    }
  }
});

test("map dots: the table's capacities never fall when zooming in", () => {
  assert.deepEqual(mapDots.dotSpec(44), { cellPx: 44, pad: 2, inner: 40, d: 9, pitch: 11, colsNormal: 3, colsPacked: 5 });
  const s24 = mapDots.dotSpec(24);
  assert.deepEqual([s24.d, s24.pitch, s24.colsNormal, s24.colsPacked], [8, 10, 2, 3]);
  const s128 = mapDots.dotSpec(128);
  assert.deepEqual([s128.d, s128.pitch, s128.colsNormal, s128.colsPacked], [16, 19, 6, 10]);
  const s340 = mapDots.dotSpec(340);
  assert.deepEqual([s340.d, s340.pitch, s340.colsNormal, s340.colsPacked], [24, 28, 11, 18]);
  assert.equal(mapDots.dotSpec(50), mapDots.dotSpec(44));
  let prev = null;
  for (const z of mapDots.ZOOM_LEVELS.filter((px) => px >= 24)) {
    const s = mapDots.dotSpec(z);
    assert.equal(s.cellPx, z);
    if (prev) {
      assert.ok(s.d >= prev.d, `${z} px: d`);
      assert.ok(s.colsNormal ** 2 >= prev.colsNormal ** 2, `${z} px: normal capacity`);
      assert.ok(s.colsPacked ** 2 >= prev.colsPacked ** 2, `${z} px: packed capacity`);
    }
    prev = s;
  }
  assert.equal(mapDots.ZOOM_LEVELS[mapDots.DEFAULT_ZOOM_INDEX], 44);
});

test("map dots: roomy, packed and over states at 44 px", () => {
  const roomy = mapDots.layoutCell(mk(9), 44);
  assert.equal(roomy.mode, "roomy");
  assert.equal(roomy.pitch, 11);
  assert.deepEqual([roomy.dots[0].cx, roomy.dots[0].cy], [11, 11]);
  assert.equal(roomy.badge, null);
  const packed = mapDots.layoutCell(mk(10), 44);
  assert.equal(packed.mode, "packed");
  assert.equal(packed.cols, 4);
  assert.equal(packed.pitch, 10);
  assert.equal(packed.dots.length, 10);
  assert.equal(packed.badge.count, 10);
  assert.equal(packed.badge.style, "pill");
  for (let i = 0; i < packed.dots.length; i += 1) {
    for (let j = i + 1; j < packed.dots.length; j += 1) {
      const dist = Math.hypot(packed.dots[i].cx - packed.dots[j].cx, packed.dots[i].cy - packed.dots[j].cy);
      assert.ok(dist >= 6.75, `dots ${i} and ${j} are ${dist} apart`);
    }
  }
  // The 5x5 packed grid loses the 4 slots under a two-digit pill: 21 dots fit, the 22nd goes over.
  const full = mapDots.layoutCell(mk(21), 44);
  assert.equal(full.mode, "packed");
  assert.equal(full.pitch, 8);
  assert.equal(full.dots.length, 21);
  assert.equal(full.capacity, 21);
  const over = mapDots.layoutCell(mk(22), 44);
  assert.equal(over.mode, "over");
  assert.equal(over.dots.length, 21);
  assert.equal(over.badge.count, 22);
  assert.equal(over.shown, 21);
  assert.equal(over.total, 22);
  // 14 packed at 44 px: a 4x4 grid (pitch 10) minus the two top-right slots under the pill.
  const fourteen = mapDots.layoutCell(mk(14), 44);
  assert.deepEqual([fourteen.mode, fourteen.cols, fourteen.rows, fourteen.pitch, fourteen.capacity], ["packed", 4, 4, 10, 14]);
  assert.deepEqual(fourteen.dots.slice(0, 3).map((d) => [d.cx, d.cy]), [[7, 7], [17, 7], [7, 17]]);
  // Below 36 px the count is bare digits in the top-right corner (its box includes the halo), not over the centre.
  const bare = mapDots.layoutCell(mk(10), 24);
  assert.equal(bare.badge.style, "bare");
  assert.deepEqual([bare.badge.x, bare.badge.y, bare.badge.w, bare.badge.h], [10, 1, 13, 9]);
  assert.deepEqual([bare.mode, bare.shown, bare.capacity], ["over", 7, 7]);
});

test("map dots: priority ids keep a dot when a cell overflows", () => {
  const layout = mapDots.layoutCell([...mk(2, "agent"), ...mk(28, "residue")], 44, ["res0028"]);
  assert.equal(layout.mode, "over");
  assert.ok(layout.dots.some((d) => d.marker.id === "res0028"));
  assert.deepEqual([layout.dots[0].marker.id, layout.dots[1].marker.id], ["a0001", "a0002"]);
  // More priority ids than dots (30 fruit at 24 px): the first ones in priority order keep a dot.
  const many = mk(30);
  const prio = many.slice(10, 22).map((m) => m.id);
  const packed = mapDots.layoutCell(many, 24, prio);
  assert.ok(packed.shown < prio.length);
  const drawn = new Set(packed.dots.map((d) => d.marker.id));
  assert.deepEqual(prio.filter((id) => drawn.has(id)), prio.slice(0, packed.shown));
  assert.equal(new Set(mapDots.orderMarkers(many, prio, packed.shown).map((m) => m.id)).size, 30);
  // A priority id already among the drawn dots is not pushed out by a promoted one; repeats and unknown ids are ignored.
  const edge = mapDots.orderMarkers(mk(30), ["f0009", "f0021", null, "zz", "f0021"], 9).slice(0, 9).map((m) => m.id);
  assert.ok(edge.includes("f0009") && edge.includes("f0021"));
});

test("map dots: hitCell picks the badge first, then the nearest dot centre", () => {
  const layout = mapDots.layoutCell(mk(26), 44);
  assert.deepEqual([layout.dots[0].cx, layout.dots[0].cy, layout.dots[1].cx, layout.dots[1].cy], [6, 6, 14, 6]);
  assert.deepEqual([layout.badge.x, layout.badge.y, layout.badge.w, layout.badge.h], [26, 1, 17, 12]);
  // Row 1 keeps (22, 6) beside the pill; (30, 6), (38, 6) and the two below them stay empty.
  assert.deepEqual(layout.dots.slice(2, 5).map((d) => [d.cx, d.cy]), [[22, 6], [6, 14], [14, 14]]);
  assert.equal(mapDots.hitCell(layout, 34, 6).kind, "badge");
  assert.equal(mapDots.hitCell(layout, 43, 1), null, "the pill's rounded corner is not the badge");
  const between = mapDots.hitCell(layout, 10.5, 6);
  assert.equal(between.kind, "dot");
  assert.equal(between.dot, layout.dots[1]);
  assert.equal(mapDots.hitCell(layout, 6, 6).dot, layout.dots[0]);
  assert.equal(mapDots.hitCell(layout, 0, 43), null);
  assert.equal(mapDots.hitCell(null, 5, 5), null);
  // Small cells: the pointer at the centre of a packed 30 px cell finds a dot, the corner digits the badge.
  const small = mapDots.layoutCell(mk(29), 30);
  assert.equal(mapDots.hitCell(small, 15, 15).kind, "dot");
  assert.equal(mapDots.hitCell(small, small.badge.x + small.badge.w / 2, small.badge.y + small.badge.h / 2).kind, "badge");

  // At every zoom level and count: no dot sits under the badge, every dot is hit at its centre,
  // and the packed capacity never falls when zooming in.
  for (const n of [10, 14, 22, 26, 99, 150, 400, 1500]) {
    let prevShown = 0;
    for (const row of mapDots.DOT_TABLE) {
      const l = mapDots.layoutCell(mk(n), row.cellPx);
      if (l.badge) {
        for (const d of l.dots) assert.ok(mapDots.badgeDistance(l.badge, d.cx, d.cy) >= mapDots.badgeClearance(l.badge, d.r), `${row.cellPx} px, n=${n}: dot (${d.cx}, ${d.cy}) under the badge`);
      }
      for (const d of l.dots) assert.equal(mapDots.hitCell(l, d.cx, d.cy).dot, d, `${row.cellPx} px, n=${n}: dot (${d.cx}, ${d.cy}) not hit at its centre`);
      assert.ok(l.shown >= prevShown, `${row.cellPx} px, n=${n}: ${l.shown} dots < ${prevShown} at the previous zoom`);
      assert.equal(l.shown, Math.min(n, l.capacity));
      prevShown = l.shown;
    }
  }
});

test("map dots: labels under a lone dot from 36 px and under a row from 160 px", () => {
  assert.equal(mapDots.layoutCell(mk(1), 30).labels, "none");
  const lone = mapDots.layoutCell(mk(1), 36);
  assert.equal(lone.labels, "below");
  assert.equal(lone.labelY, lone.y0 + 10 + 9);
  assert.equal(lone.labelY, 32);
  assert.equal(lone.labelFontSize, 10);
  assert.equal(mapDots.layoutCell(mk(2), 44).labels, "none");
  const row = mapDots.layoutCell(mk(2), 160);
  assert.equal(row.labels, "below");
  assert.equal(row.labelFontSize, 11);
  assert.equal(mapDots.layoutCell(mk(5), 340).labels, "none");
});

test("map dots: far-mode tiles", () => {
  const one = mapDots.tileFor(mk(1, "plant"), 10);
  assert.equal(one.side, 5);
  assert.equal(one.kind, "plant");
  assert.equal(one.showCount, false);
  assert.equal(one.showBar, false);
  assert.equal(mapDots.tileFor(mk(15), 10).side, 8);
  let prev = 0;
  for (let n = 1; n <= 40; n += 1) {
    const side = mapDots.tileFor(mk(n), 18).side;
    assert.ok(side >= prev, `N=${n}: side ${side} >= ${prev}`);
    if (n >= 15) assert.equal(side, 16);
    prev = side;
  }
  const mixed = mapDots.tileFor([...mk(1, "agent"), ...mk(3)], 18);
  assert.equal(mixed.kind, "agent");
  assert.equal(mixed.count, 4);
  assert.equal(mixed.showCount, true);
  assert.equal(mixed.fontSize, 9);
  assert.deepEqual(mixed.shares, [
    { kind: "agent", count: 1 },
    { kind: "fruit", count: 3 },
  ]);
  assert.equal(mixed.showBar, true);
  const dead = mapDots.tileFor([...mk(1, "agent", true), ...mk(1, "plant", true)], 14);
  assert.equal(dead.kind, "dead");
  assert.equal(dead.fontSize, 8);
  assert.equal(mapDots.tileFor([], 10), null);
  assert.equal(mapDots.layoutCell(mk(3), 18), null);
});

const moveFx = fx("move", { from: { x: 1, y: 1 }, to: { x: 1, y: 2 }, at: { x: 1, y: 2 }, label: "moved up" });

test("map indicators: a move gives a badge with its direction, an arrow and nothing else; a blocked move a failed badge and a failed arrow", () => {
  const moved = mapIndicators.turnMarks([moveFx], "r00002_t01_a03");
  assert.equal(moved.kind, "agent_turn");
  assert.equal(moved.actorId, "a03");
  assert.deepEqual(moved.marks, [
    { type: "badge", id: "a03", at: { x: 1, y: 2 }, glyph: "move", direction: "up", ok: true },
    { type: "arrow", id: "a03", from: { x: 1, y: 1 }, to: { x: 1, y: 2 }, ok: true },
  ]);
  assert.deepEqual(moved.markedIds, ["a03"]);
  assert.equal(moved.dropped, 0);
  const blocked = mapIndicators.turnMarks([fx("move", { ok: false, from: { x: 0, y: 0 }, to: { x: -1, y: 0 }, at: { x: 0, y: 0 }, label: "moved left (failed: blocked)" })], "r00002_t01_a03");
  assert.equal(blocked.marks[0].type, "badge");
  assert.equal(blocked.marks[0].direction, "left");
  assert.equal(blocked.marks[0].ok, false);
  assert.equal(blocked.marks[1].type, "arrow");
  assert.equal(blocked.marks[1].ok, false);
});

test("map indicators: attack, absorb, transfer and messages ring and link their counterparts and print amounts", () => {
  const attackFx = fx("attack", { targets: ["a05"], targetPoints: [{ x: 1, y: 1 }], amount: 12, label: "attacked a05 (12 damage)" });
  const attack = mapIndicators.turnMarks([attackFx], "r00002_t01_a03");
  const rings = (m) => m.marks.filter((x) => x.type === "ring");
  const links = (m) => m.marks.filter((x) => x.type === "link");
  const amounts = (m) => m.marks.filter((x) => x.type === "amount");
  assert.deepEqual(rings(attack), [{ type: "ring", id: "a05", at: { x: 1, y: 1 }, tone: "bad" }]);
  assert.deepEqual(links(attack), []);
  assert.deepEqual(amounts(attack), [{ type: "amount", id: "a05", at: { x: 1, y: 1 }, text: "−12", tone: "bad" }]);
  assert.deepEqual(amounts(mapIndicators.turnMarks([fx("attack", { targets: ["a05"], targetPoints: [{ x: 1, y: 1 }] })], "r00002_t01_a03")), []);
  const killed = mapIndicators.turnMarks([attackFx, fx("death", { actor: "world", targets: ["a05"], label: "a05 died (attack)" })], "r00002_t01_a03");
  assert.equal(rings(killed).length, 1);
  assert.equal(rings(killed)[0].tone, "bad");

  const absorb = mapIndicators.turnMarks([fx("absorb", { targets: ["f0004"], targetPoints: [{ x: 1, y: 1 }], amount: 2.5 })], "r00002_t01_a03");
  assert.deepEqual(rings(absorb), [{ type: "ring", id: "f0004", at: { x: 1, y: 1 }, tone: "absorb" }]);
  assert.deepEqual(links(absorb), []);
  assert.deepEqual(amounts(absorb), [{ type: "amount", id: "a03", at: { x: 1, y: 1 }, text: "+2.5", tone: "good" }]);

  const transfer = mapIndicators.turnMarks([fx("transfer", { targets: ["a05"], targetPoints: [{ x: 3, y: 3 }], amount: 3 })], "r00002_t01_a03");
  assert.deepEqual(rings(transfer), [{ type: "ring", id: "a05", at: { x: 3, y: 3 }, tone: "good" }]);
  assert.deepEqual(links(transfer), [{ type: "link", fromId: "a03", toId: "a05", from: { x: 1, y: 1 }, to: { x: 3, y: 3 }, tone: "good", dashed: false }]);
  assert.deepEqual(amounts(transfer), [{ type: "amount", id: "a05", at: { x: 3, y: 3 }, text: "+3", tone: "good" }]);

  const messageFx = fx("message", { targets: ["a05", "a07"], targetPoints: [{ x: 1, y: 1 }, { x: 9, y: 1 }], broadcast: true, label: "broadcast to 2 agents" });
  const broadcast = mapIndicators.turnMarks([messageFx], "r00002_t01_a03", { communicationRange: 4 });
  assert.deepEqual(rings(broadcast).map((r) => [r.id, r.tone]), [["a05", "message"], ["a07", "message"]]);
  assert.deepEqual(links(broadcast), [{ type: "link", fromId: "a03", toId: "a07", from: { x: 1, y: 1 }, to: { x: 9, y: 1 }, tone: "message", dashed: true }]);
  assert.deepEqual(broadcast.marks.filter((x) => x.type === "reach"), [{ type: "reach", id: "a03", at: { x: 1, y: 1 }, radiusCells: 4 }]);
  const sent = mapIndicators.turnMarks([{ ...messageFx, broadcast: false }], "r00002_t01_a03", { communicationRange: 4 });
  assert.equal(sent.marks.filter((x) => x.type === "reach").length, 0);
  assert.deepEqual(broadcast.markedIds, ["a03", "a05", "a07"]);
  assert.deepEqual(transfer.markedIds, ["a03", "a05"]);

  // A failed action touched nobody: only its red badge, no ring, link or amount on the target.
  const failedBadge = (glyph) => [{ type: "badge", id: "a03", at: { x: 1, y: 1 }, glyph, direction: null, ok: false }];
  const failedAttack = mapIndicators.turnMarks([fx("attack", { ok: false, targets: ["p0008"], targetPoints: [{ x: 2, y: 1 }], label: "attacked p0008 (failed: insufficient_compute)" })], "r00002_t01_a03");
  assert.deepEqual(failedAttack.marks, failedBadge("attack"));
  assert.deepEqual(failedAttack.markedIds, ["a03"]);
  const failedAbsorb = mapIndicators.turnMarks([fx("absorb", { ok: false, targets: ["p0001"], targetPoints: [{ x: 1, y: 1 }], label: "absorbed from p0001 (failed: invalid_argument)" })], "r00002_t01_a03");
  assert.deepEqual(failedAbsorb.marks, failedBadge("absorb"));
  const failedSend = mapIndicators.turnMarks([{ ...messageFx, ok: false }], "r00002_t01_a03", { communicationRange: 4 });
  assert.deepEqual(failedSend.marks, failedBadge("message"));
});

const roundEndFx = [
  fx("death", { actor: "world", at: { x: 2, y: 3 }, targets: ["a02"], label: "a02 died (starvation)" }),
  fx("starvation", { actor: "world", at: { x: 5, y: 5 }, targets: ["a04"], amount: 5, label: "a04 starves (-5 health)" }),
  fx("growth", { actor: "p0001", at: { x: 7, y: 7 }, targets: ["p0001"] }),
  fx("fruit", { actor: "p0001", at: { x: 7, y: 7 }, targets: ["f0009"], targetPoints: [{ x: 7, y: 7 }] }),
  fx("seed", { actor: "p0001", at: { x: 7, y: 7 }, targets: ["s0002"], targetPoints: [{ x: 7, y: 7 }] }),
  fx("germination", { actor: "s0003", at: { x: 1, y: 9 }, targets: ["p0002"], targetPoints: [{ x: 1, y: 9 }] }),
  fx("voice", { actor: "operator", at: null, targets: ["a05"], targetPoints: [{ x: 6, y: 6 }] }),
];

test("map indicators: observe, query, round-end events, init and the cap", () => {
  const observe = mapIndicators.turnMarks([fx("observe", { to: { x: 2, y: 5 }, targetPoints: [{ x: 2, y: 5 }] })], "r00002_t01_a03");
  assert.deepEqual(observe.marks.filter((m) => m.type === "cell"), [{ type: "cell", at: { x: 2, y: 5 }, tone: "query" }]);
  assert.deepEqual(observe.marks.filter((m) => m.type === "link"), [{ type: "link", fromId: "a03", toId: null, from: { x: 1, y: 1 }, to: { x: 2, y: 5 }, tone: "query", dashed: true }]);
  const query = mapIndicators.turnMarks([fx("query", { targets: ["p0001"], targetPoints: [{ x: 4, y: 4 }] })], "r00002_t01_a03");
  assert.deepEqual(query.marks.filter((m) => m.type === "ring"), [{ type: "ring", id: "p0001", at: { x: 4, y: 4 }, tone: "query" }]);
  const self = mapIndicators.turnMarks([fx("query", { label: "queried itself" })], "r00002_t01_a03");
  assert.deepEqual(self.marks.map((m) => m.type), ["badge"]);

  const roundEnd = mapIndicators.turnMarks(roundEndFx, "r00002_end");
  assert.equal(roundEnd.kind, "round_end");
  assert.equal(roundEnd.actorId, null);
  assert.equal(roundEnd.marks.filter((m) => m.type === "badge").length, 0);
  assert.deepEqual(
    roundEnd.marks.filter((m) => m.type === "ring").map((m) => m.tone),
    ["dead", "bad", "growth", "fruit", "seed", "growth", "voice"],
  );
  assert.deepEqual(roundEnd.marks.filter((m) => m.type === "amount"), [{ type: "amount", id: "a04", at: { x: 5, y: 5 }, text: "−5", tone: "bad" }]);

  const many = Array.from({ length: 70 }, (_, i) => fx("fruit", { actor: "p0001", at: { x: 7, y: 7 }, targets: [`f${String(i + 1).padStart(4, "0")}`], targetPoints: [{ x: 7, y: 7 }] }));
  const capped = mapIndicators.turnMarks(many, "r00002_end");
  assert.equal(capped.marks.length, mapIndicators.MAX_MARKS);
  assert.equal(capped.marks.length, 60);
  assert.equal(capped.dropped, 10);

  const init = mapIndicators.turnMarks([], "r00000_init");
  assert.equal(init.kind, "init");
  assert.deepEqual(init.marks, []);
});

test("map indicators: no action, agent view and captions", () => {
  const idle = mapIndicators.turnMarks([], "r00002_t01_a03", { positionOf: () => ({ x: 4, y: 4 }) });
  assert.deepEqual(idle.marks, [{ type: "badge", id: "a03", at: { x: 4, y: 4 }, glyph: "none", direction: null, ok: true }]);
  const own = mapIndicators.turnMarks([moveFx], "r00002_t01_a03", { agentViewOf: "a03", agentViewAt: { x: 1, y: 2 } });
  assert.deepEqual(own.marks.map((m) => m.type), ["badge", "arrow"]);
  const elsewhere = mapIndicators.turnMarks([moveFx], "r00002_t01_a03", { agentViewOf: "a03", agentViewAt: { x: 7, y: 7 } });
  assert.deepEqual(elsewhere.marks, []);
  const attackFx = fx("attack", { targets: ["a05"], targetPoints: [{ x: 1, y: 1 }], amount: 12 });
  const victim = mapIndicators.turnMarks([attackFx], "r00002_t01_a03", { agentViewOf: "a05", agentViewAt: { x: 1, y: 1 } });
  assert.deepEqual(victim.marks, []);

  const nameOf = (id) => (id === "a03" ? "Aster (a03)" : id);
  assert.equal(mapIndicators.captionFor([moveFx], "r00002_t01_a03", nameOf), "Turn r00002_t01_a03 · Aster (a03) moved up");
  assert.ok(mapIndicators.captionFor([moveFx], "r00002_t01_a03", nameOf, "a05").endsWith(" · a05 is deciding now"));
  assert.equal(
    mapIndicators.captionFor(roundEndFx, "r00002_end", nameOf),
    "Turn r00002_end · round 2 ended · 1 grew · 1 fruit · 1 seed · 1 germinated · 1 starving · 1 died · 1 voice",
  );
  assert.equal(mapIndicators.captionFor([], "r00000_init", nameOf), "Turn r00000_init · initial state");
  assert.equal(mapIndicators.captionFor([], "r00002_t01_a03", nameOf), "Turn r00002_t01_a03 · Aster (a03) took no action");
});

// ---------------------------------------------------------------- WP-3D-STATE: the 3D view's pure modules (src/state/map3d*.ts)
// Fixtures are inline; no DOM, no three.js.  Positions are scene units: x = world x, y up, z = -world y.

const m3dClose = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function m3dAssertClose(actual, expected, eps = 1e-6, what = "value") {
  assert.ok(m3dClose(actual, expected, eps), `${what}: ${actual} != ${expected} (eps ${eps})`);
}
function m3dAssertVec(actual, expected, eps = 1e-6, what = "vector") {
  assert.equal(actual.length, expected.length, `${what}: length`);
  for (let i = 0; i < expected.length; i++) m3dAssertClose(actual[i], expected[i], eps, `${what}[${i}]`);
}
/** A full TurnEffect (state/turnEffects.ts) with defaults, so a test names only what matters. */
function m3dEffect(kind, o = {}) {
  return {
    kind,
    actor: o.actor ?? "a01",
    at: o.at ?? null,
    from: o.from ?? null,
    to: o.to ?? null,
    targets: o.targets ?? [],
    targetPoints: o.targetPoints ?? [],
    ok: o.ok ?? true,
    amount: o.amount ?? null,
    broadcast: o.broadcast ?? false,
    label: o.label ?? kind,
  };
}
/** A TimelineContext over a slot table; unknown ids have no slot. */
function m3dContext(slots, o = {}) {
  return {
    slotOf: (id) => slots[id] ?? null,
    cellCentre: (p) => map3dLayout.cellToScene(p, 0),
    commRange: (id) => (id === "a01" ? 4 : null),
    reducedMotion: o.reducedMotion ?? false,
  };
}
const M3D_SLOTS = { a01: [0, 0, 0], a02: [3, 0, -3], a03: [1, 0, -1], p01: [5, 0, -5], p02: [1, 0, -9], f01: [5, 0, -5], f02: [5.2, 0, -5], f03: [4.8, 0, -5], s01: [6, 0, -6] };
const M3D_KINDS = ["move", "attack", "message", "absorb", "transfer", "recover", "upgrade", "wait", "observe", "query", "skill", "death", "growth", "fruit", "seed", "germination", "starvation", "voice"];
const m3dMarker = (id, kind, dead = false) => ({ id, kind, dead, position: { x: 0, y: 0 }, title: id, line: "" });

test("map3dView: parseMapViewMode and the storage key", () => {
  assert.equal(map3dView.MAP_VIEW_STORAGE_KEY, "empyrean.map.view");
  assert.equal(map3dView.DEFAULT_MAP_VIEW_MODE, "2d");
  assert.equal(map3dView.parseMapViewMode("3d"), "3d");
  // Focus handoff between the switch's two copies: taken once, only by the requested mode; null cancels.
  assert.equal(map3dView.takeSwitchFocus("3d"), false);
  map3dView.requestSwitchFocus("3d");
  assert.equal(map3dView.takeSwitchFocus("2d"), false);
  assert.equal(map3dView.takeSwitchFocus("3d"), true);
  assert.equal(map3dView.takeSwitchFocus("3d"), false);
  map3dView.requestSwitchFocus("2d");
  map3dView.requestSwitchFocus(null);
  assert.equal(map3dView.takeSwitchFocus("2d"), false);
  assert.equal(map3dView.parseMapViewMode("2d"), "2d");
  assert.equal(map3dView.parseMapViewMode(null), "2d");
  assert.equal(map3dView.parseMapViewMode("x"), "2d");
  assert.equal(map3dView.parseMapViewMode("3D"), "2d");
});

test("map3dLayout: cells, layers and scene coordinates", () => {
  assert.equal(map3dLayout.LAYER_GAP, 3);
  assert.deepEqual(map3dLayout.cellToScene({ x: 3, y: 4 }, 0), [3, 0, -4]);
  assert.deepEqual(map3dLayout.cellToScene({ x: 3, y: 4 }, 2), [3, 6, -4]);
  assert.equal(map3dLayout.layerY(2), 6);
  for (const p of [{ x: -3, y: -7 }, { x: 0, y: 0 }, { x: 5, y: -2 }, { x: -12, y: 9 }]) {
    const [x, , z] = map3dLayout.cellToScene(p, 1);
    assert.deepEqual(map3dLayout.sceneToCell(x, z), p);
    assert.deepEqual(map3dLayout.sceneToCell(x + 0.3, z - 0.3), p);
  }
  assert.equal(map3dLayout.layerOpacity(1, 0), 0.3);
  assert.equal(map3dLayout.layerOpacity(0, 0), 1);
  assert.equal(map3dLayout.nextLayer(0, -1, 1), 0);
  assert.equal(map3dLayout.nextLayer(0, 1, 1), 0);
  assert.equal(map3dLayout.nextLayer(1, 1, 3), 2);
  assert.equal(map3dLayout.nextLayer(2, 1, 3), 2);
  assert.equal(map3dLayout.nextLayer(0, 1, 0), 0);
});

test("map3dLayout: packCell never drops an occupant and keeps figures equal-sized", () => {
  assert.deepEqual(map3dLayout.packCell(0), []);
  assert.deepEqual(map3dLayout.packCell(1), [{ u: 0.5, v: 0.5, tier: 0, scale: 1 }]);
  const four = map3dLayout.packCell(4);
  assert.equal(four.length, 4);
  for (const s of four) {
    assert.equal(s.tier, 0);
    assert.equal(s.scale, 1);
    m3dAssertClose(Math.abs(s.u - 0.5), 0.205, 1e-9, "u offset");
    m3dAssertClose(Math.abs(s.v - 0.5), 0.205, 1e-9, "v offset");
  }
  assert.equal(new Set(four.map((s) => `${s.u.toFixed(4)},${s.v.toFixed(4)}`)).size, 4);
  const nine = map3dLayout.packCell(9);
  assert.equal(nine.length, 9);
  m3dAssertClose(nine[0].scale, 0.87, 0.01, "scale for 9");
  const twenty = map3dLayout.packCell(20);
  assert.equal(twenty.length, 20);
  assert.equal(twenty.filter((s) => s.tier === 0).length, 16);
  assert.equal(twenty.filter((s) => s.tier === 1).length, 4);
  const pitch = 0.82 / 4;
  for (const s of twenty) {
    assert.ok(s.u > 0 && s.u < 1 && s.v > 0 && s.v < 1, "inside the tile");
    m3dAssertClose(s.scale, 0.65, 1e-9, "scale for 16 per tier");
  }
  const ground = twenty.filter((s) => s.tier === 0);
  for (let i = 0; i < ground.length; i++) {
    for (let j = i + 1; j < ground.length; j++) {
      assert.ok(Math.hypot(ground[i].u - ground[j].u, ground[i].v - ground[j].v) >= 0.9 * pitch, "slots keep their distance");
    }
  }
  // Tier 1 repeats the grid positions of the first slots, lifted by TIER_LIFT.
  assert.deepEqual(twenty[16].u, twenty[0].u);
  assert.deepEqual(twenty[16].v, twenty[0].v);
  m3dAssertVec(map3dLayout.slotOffset(twenty[16]), [twenty[0].u - 0.5, 0.45, -(twenty[0].v - 0.5)]);
  m3dAssertVec(map3dLayout.slotOffset({ u: 0.5, v: 0.5, tier: 0, scale: 1 }), [0, 0, 0]);
  m3dAssertVec(map3dLayout.slotScenePosition({ x: 2, y: 3 }, { u: 0.7, v: 0.3, tier: 1, scale: 1 }, 1), [2.2, 3.45, -2.8]);
});

test("map3dLayout: orderForSlots, countBadge, LOD", () => {
  const markers = [m3dMarker("p01", "plant"), m3dMarker("f01", "fruit"), m3dMarker("a02", "agent"), m3dMarker("a01", "agent", true), m3dMarker("r01", "residue"), m3dMarker("s01", "seed"), m3dMarker("a03", "agent")];
  assert.deepEqual(
    map3dLayout.orderForSlots(markers, ["a03", null, undefined, "p01", "zz"]).map((m) => m.id),
    ["a03", "p01", "a02", "a01", "f01", "s01", "r01"],
  );
  assert.deepEqual(
    map3dLayout.orderForSlots(markers, []).map((m) => m.id),
    ["a02", "a03", "a01", "p01", "f01", "s01", "r01"],
  );
  assert.equal(markers[0].id, "p01", "input untouched");
  assert.equal(map3dLayout.figureKind(m3dMarker("a01", "agent", true)), "dead");
  assert.equal(map3dLayout.figureKind(m3dMarker("p01", "plant")), "plant");
  assert.equal(map3dLayout.countBadge(4), null);
  assert.equal(map3dLayout.countBadge(5), "5");
  assert.equal(map3dLayout.countBadge(40), "40");
  assert.equal(map3dLayout.lodMode(61, "figures"), "columns");
  assert.equal(map3dLayout.lodMode(56, "columns"), "columns");
  assert.equal(map3dLayout.lodMode(56, "figures"), "figures");
  assert.equal(map3dLayout.lodMode(53, "columns"), "figures");
  assert.equal(map3dLayout.columnHeight(40), 6);
  assert.equal(map3dLayout.columnHeight(2), 0.5);
  assert.equal(map3dLayout.columnHeight(0), 0);
});

test("map3dCamera: frameRegion and topView look at the board centre", () => {
  const region = { min_x: -10, max_x: 10, min_y: -10, max_y: 10 };
  const framed = map3dCamera.frameRegion(region, 0, 1);
  const tilt = (50 * Math.PI) / 180;
  const tan = Math.tan((25 * Math.PI) / 180);
  const framedDistance = (halfW, halfD, aspect) => 1.15 * Math.max(
    halfD * Math.cos(tilt) + halfW / (aspect * tan),
    halfD * Math.cos(tilt) + halfD * Math.sin(tilt) / (2 * (1 - 0.42) * tan),
    -halfD * Math.cos(tilt) + halfD * Math.sin(tilt) / (2 * 0.42 * tan),
  );
  const d = framedDistance(10.5, 10.5, 1);
  m3dAssertClose(framed.yaw, 0);
  m3dAssertClose(framed.pitch, -tilt);
  m3dAssertClose(framed.x, 0);
  m3dAssertClose(framed.y, d * Math.sin(tilt));
  m3dAssertClose(framed.z, d * Math.cos(tilt));
  assert.ok(framed.z > 0, "eye is south of the centre");
  m3dAssertClose(map3dCamera.distanceTo(framed, [0, 0, 0]), d);
  // The look ray meets the board at its centre.
  m3dAssertVec(map3dCamera.boardHit(framed, 0), [0, 0, 0], 1e-6, "frame hit");
  // A wide viewport needs less distance horizontally, but still fits the nearer south corners vertically.
  m3dAssertClose(map3dCamera.distanceTo(map3dCamera.frameRegion(region, 0, 2), [0, 0, 0]), framedDistance(10.5, 10.5, 2));
  const wide = map3dCamera.frameRegion({ min_x: 0, max_x: 99, min_y: 0, max_y: 9 }, 0, 2);
  m3dAssertClose(map3dCamera.distanceTo(wide, [49.5, 0, -4.5]), framedDistance(50, 5, 2));
  // Layer 1 lifts everything by LAYER_GAP.
  m3dAssertClose(map3dCamera.frameRegion(region, 1, 1).y, framed.y + 3);
  const top = map3dCamera.topView(region, 0);
  m3dAssertClose(top.y, 1.2 * 21);
  m3dAssertClose(top.pitch, (-89 * Math.PI) / 180);
  assert.equal(top.yaw, 0);
  m3dAssertVec(map3dCamera.boardHit(top, 0), [0, 0, 0], 1e-6, "top hit");
  assert.equal(map3dCamera.boardHit({ x: 0, y: 5, z: 0, yaw: 0, pitch: 0.2 }, 0), null);
  m3dAssertClose(map3dCamera.lodDistance(framed, 0), d);
  m3dAssertClose(map3dCamera.lodDistance({ x: 0, y: 5, z: 0, yaw: 0, pitch: 0.2 }, 0), 5);
  assert.deepEqual(map3dCamera.regionCentre({ min_x: 0, max_x: 3, min_y: -2, max_y: 2 }), { x: 1.5, y: 0 });
});

test("map3dCamera: step flies horizontally, climbs, and respects the floor, ceiling and dt cap", () => {
  const s0 = { x: 0, y: 0.6, z: 0, yaw: 0, pitch: 0 };
  const held = (...codes) => new Set(codes);
  const run = (state, codes, ms, layerYValue = 0) => {
    let s = state;
    for (let t = 0; t < ms; t += 50) s = map3dCamera.step(s, held(...codes), 50, layerYValue);
    return s;
  };
  const speed = map3dCamera.speedForHeight(0.6);
  m3dAssertClose(speed, 6.36);
  const fwd = run(s0, ["KeyW"], 1000);
  m3dAssertClose(fwd.z, -speed, 1e-9, "W moves north (-z)");
  m3dAssertClose(fwd.x, 0, 1e-9);
  assert.equal(fwd.y, 0.6, "W leaves the height");
  const back = run(s0, ["KeyS"], 1000);
  m3dAssertClose(back.z, speed, 1e-9, "S moves south");
  const east = run({ ...s0, yaw: Math.PI / 2 }, ["KeyW"], 1000);
  m3dAssertClose(east.x, speed, 1e-9, "W at yaw pi/2 moves +x");
  m3dAssertClose(east.z, 0, 1e-9);
  const strafe = run(s0, ["KeyD"], 1000);
  m3dAssertClose(strafe.x, speed, 1e-9, "D strafes east");
  const diagonal = run(s0, ["KeyW", "KeyD"], 1000);
  m3dAssertClose(Math.hypot(diagonal.x, diagonal.z), speed, 1e-9, "diagonal is not faster");
  const up = map3dCamera.step(s0, held("Space"), 50, 0);
  m3dAssertClose(up.y, 0.6 + speed * 0.05, 1e-9, "Space climbs by speed * dt");
  const down = map3dCamera.step({ ...s0, y: 5 }, held("ShiftRight"), 50, 0);
  m3dAssertClose(down.y, 5 - map3dCamera.speedForHeight(5) * 0.05, 1e-9, "Shift descends");
  m3dAssertClose(run({ ...s0, y: 2 }, ["ShiftLeft"], 2000).y, 0.6, 1e-12, "floor at layerY + 0.6");
  m3dAssertClose(run({ ...s0, y: 5 }, ["ShiftLeft"], 2000, 3).y, 3.6, 1e-12, "floor follows the active layer");
  assert.equal(run({ ...s0, y: 199.9 }, ["Space"], 500).y, 200, "ceiling");
  m3dAssertClose(map3dCamera.step(s0, held("KeyW"), 200, 0).z, map3dCamera.step(s0, held("KeyW"), 50, 0).z, 1e-12, "dt 200 counts as 50");
  assert.deepEqual(map3dCamera.step(s0, held("KeyW"), -10, 0), s0, "negative dt is a no-op");
  const turned = map3dCamera.step(s0, held("KeyQ"), 50, 0);
  m3dAssertClose(turned.yaw, (-60 * Math.PI) / 180 / 20, 1e-12, "Q yaws left at 60 deg/s");
  m3dAssertClose(map3dCamera.step(s0, held("ArrowRight"), 50, 0).yaw, (60 * Math.PI) / 180 / 20, 1e-12);
  m3dAssertClose(map3dCamera.step(s0, held("ArrowUp"), 50, 0).pitch, (60 * Math.PI) / 180 / 20, 1e-12);
  assert.deepEqual(map3dCamera.step(s0, held("KeyZ", "ControlLeft"), 50, 0), s0, "unknown codes are ignored");
  assert.equal(map3dCamera.speedForHeight(0), 6);
  assert.equal(map3dCamera.speedForHeight(20), 18);
  assert.equal(map3dCamera.speedForHeight(200), 60);
  assert.equal(map3dCamera.speedForHeight(-5), 6);
  m3dAssertVec(map3dCamera.forward(0), [0, -1]);
  m3dAssertVec(map3dCamera.forward(Math.PI / 2), [1, 0]);
  m3dAssertVec(map3dCamera.lookDirection({ x: 0, y: 0, z: 0, yaw: 0, pitch: -Math.PI / 2 }), [0, -1, 0]);
});

test("map3dCamera: look, pan and wheel", () => {
  const s = { x: 0, y: 10, z: 10, yaw: 0, pitch: 0 };
  m3dAssertClose(map3dCamera.applyLook(s, 120, 0).yaw, Math.PI / 6, 1e-9, "120 px = 30 deg");
  m3dAssertClose(map3dCamera.applyLook(s, 0, 10000).pitch, (-89 * Math.PI) / 180, 1e-9, "pitch clamps at -89");
  m3dAssertClose(map3dCamera.applyLook(s, 0, -10000).pitch, (89 * Math.PI) / 180, 1e-9, "pitch clamps at +89");
  const nearPi = { ...s, yaw: 3.1 };
  const wrapped = map3dCamera.applyLook(nearPi, 40, 0); // +10 deg = 0.1745 rad past pi
  assert.ok(wrapped.yaw < 0 && wrapped.yaw > -Math.PI, `yaw wraps past pi: ${wrapped.yaw}`);
  m3dAssertClose(wrapped.yaw, 3.1 + (10 * Math.PI) / 180 - 2 * Math.PI, 1e-9);
  assert.deepEqual([map3dCamera.applyLook(s, 5, 5).x, map3dCamera.applyLook(s, 5, 5).y, map3dCamera.applyLook(s, 5, 5).z], [0, 10, 10], "look never moves the eye");
  m3dAssertClose(map3dCamera.wrapYaw(Math.PI), Math.PI);
  m3dAssertClose(map3dCamera.wrapYaw(-Math.PI), Math.PI);
  m3dAssertClose(map3dCamera.wrapYaw(3 * Math.PI + 0.5), -Math.PI + 0.5);
  // Pan: dragging right moves the eye left; dragging down moves it up.
  const panned = map3dCamera.applyPan(s, 100, 0, 10);
  m3dAssertClose(panned.x, -1.5, 1e-9);
  m3dAssertClose(panned.z, 10, 1e-9);
  m3dAssertClose(map3dCamera.applyPan(s, 0, 100, 10).y, 11.5, 1e-9);
  assert.equal(map3dCamera.applyPan({ ...s, y: 0.7 }, 0, -100, 10).y, 0.6, "pan respects the floor");
  // Wheel: toward the target for a negative deltaY, away for a positive one, never closer than 0.6.
  const target = [0, 0, 0];
  const d0 = map3dCamera.distanceTo(s, target);
  const closer = map3dCamera.applyWheel(s, -100, target);
  m3dAssertClose(map3dCamera.distanceTo(closer, target), d0 * 0.88, 1e-9, "one notch in = 12 % closer");
  const farther = map3dCamera.applyWheel(s, 100, target);
  m3dAssertClose(map3dCamera.distanceTo(farther, target), d0 * 1.12, 1e-9, "one notch out = 12 % farther");
  m3dAssertVec([closer.x, closer.y, closer.z], [0, 8.8, 8.8], 1e-9, "moves along the ray");
  const slammed = map3dCamera.applyWheel(s, -1e6, target);
  assert.ok(map3dCamera.distanceTo(slammed, target) >= 0.6 - 1e-9, "never closer than 0.6");
  const slammedHigh = map3dCamera.applyWheel({ ...s, y: 20, z: 0 }, -1e6, [0, 10, 0]);
  m3dAssertClose(map3dCamera.distanceTo(slammedHigh, [0, 10, 0]), 0.6, 1e-9, "stops exactly at 0.6 when the floor allows");
  assert.deepEqual(map3dCamera.applyWheel(s, 0, target), s, "deltaY 0 is a no-op");
  assert.equal(map3dCamera.applyWheel(s, -100, target).yaw, 0);
  // No target: dolly toward the point 20 units ahead.
  const ahead = map3dCamera.applyWheel({ ...s, pitch: 0 }, -100, null);
  m3dAssertClose(ahead.z, 10 - 20 * 0.12, 1e-9);
  assert.equal(ahead.y, 10);
  assert.equal(map3dCamera.applyWheel({ ...s, y: 0.3 }, 100, [0, 0.3, 0]).y, 0.6, "wheel respects the floor");
});

test("map3dCamera: focus, elevator, glide, bindings and the data-camera key", () => {
  const s = { x: 0, y: 10, z: 10, yaw: 0.3, pitch: (-50 * Math.PI) / 180 };
  const focused = map3dCamera.focusCell(s, { x: 2, y: 3 }, 0);
  const dir = map3dCamera.lookDirection(focused);
  m3dAssertVec([focused.x + 6 * dir[0], focused.y + 6 * dir[1], focused.z + 6 * dir[2]], [2, 0, -3], 1e-9, "cell is 6 units ahead");
  assert.equal(focused.yaw, s.yaw);
  assert.equal(focused.pitch, s.pitch);
  m3dAssertVec([map3dCamera.focusCell(s, { x: 2, y: 3 }, 1).y], [focused.y + 3], 1e-9, "focus on layer 1 is 3 higher");
  assert.equal(map3dCamera.focusCell({ ...s, pitch: 0 }, { x: 2, y: 3 }, 0).y, 0.6, "a level focus sits on the floor");
  const lifted = map3dCamera.layerElevator(s, 0, 1);
  m3dAssertClose(lifted.y - s.y, map3dLayout.LAYER_GAP, 1e-12);
  assert.deepEqual({ ...lifted, y: s.y }, s);
  m3dAssertClose(map3dCamera.layerElevator(s, 2, 0).y, s.y - 6);
  const a = { x: 0, y: 1, z: 2, yaw: 3.0, pitch: -0.2 };
  const b = { x: 10, y: 11, z: 12, yaw: -3.0, pitch: -0.8 };
  assert.deepEqual(map3dCamera.glide(a, b, 0), a);
  assert.deepEqual(map3dCamera.glide(a, b, 1), b);
  assert.deepEqual(map3dCamera.glide(a, b, 1.7), b, "t clamps at 1");
  const mid = map3dCamera.glide(a, b, 0.5);
  m3dAssertClose(mid.x, 5);
  m3dAssertClose(mid.pitch, -0.5);
  assert.ok(Math.abs(mid.yaw) > 3.05, `yaw takes the short arc through pi: ${mid.yaw}`);
  const early = map3dCamera.glide(a, b, 0.25);
  assert.ok(early.x < 2.5 && early.x > 0, "eased start");
  m3dAssertClose(map3dCamera.lookAt([0, 0, 0], [0, 0, -5]).yaw, 0);
  m3dAssertClose(map3dCamera.lookAt([0, 0, 0], [5, 0, 0]).yaw, Math.PI / 2);
  m3dAssertClose(map3dCamera.lookAt([0, 5, 0], [0, 0, 5]).pitch, -Math.PI / 4);
  assert.deepEqual(map3dCamera.lookAt([1, 1, 1], [1, 1, 1]), { yaw: 0, pitch: 0 });
  assert.deepEqual(map3dCamera.bindingFor("KeyW"), { action: "forward", hold: true });
  assert.deepEqual(map3dCamera.bindingFor("Space"), { action: "up", hold: true });
  assert.deepEqual(map3dCamera.bindingFor("ShiftLeft"), { action: "down", hold: true });
  assert.deepEqual(map3dCamera.bindingFor("ShiftRight"), { action: "down", hold: true });
  assert.deepEqual(map3dCamera.bindingFor("PageUp"), { action: "layerUp", hold: false });
  assert.deepEqual(map3dCamera.bindingFor("PageDown"), { action: "layerDown", hold: false });
  assert.deepEqual(map3dCamera.bindingFor("KeyF"), { action: "frame", hold: false });
  assert.deepEqual(map3dCamera.bindingFor("KeyT"), { action: "top", hold: false });
  assert.deepEqual(map3dCamera.bindingFor("Home"), { action: "focus", hold: false });
  assert.deepEqual(map3dCamera.bindingFor("KeyR"), { action: "replay", hold: false });
  assert.deepEqual(map3dCamera.bindingFor("Slash", "?"), { action: "help", hold: false });
  assert.deepEqual(map3dCamera.bindingFor("KeyH", "h"), { action: "help", hold: false });
  assert.deepEqual(map3dCamera.bindingFor("Escape"), { action: "escape", hold: false });
  assert.deepEqual(map3dCamera.bindingFor("ArrowUp"), { action: "pitchUp", hold: true });
  assert.deepEqual(map3dCamera.bindingFor("KeyE"), { action: "yawRight", hold: true });
  assert.equal(map3dCamera.bindingFor("KeyZ", "z"), null);
  assert.equal(map3dCamera.bindingFor("", ""), null);
  assert.equal(map3dCamera.cameraKey({ x: 1.234, y: -0.001, z: 2, yaw: 0.126, pitch: -0.5 }), '{"x":1.23,"y":0,"z":2,"yaw":0.13,"pitch":-0.5}');
  assert.equal(map3dCamera.FLOOR_ABOVE_LAYER, 0.6);
  assert.equal(map3dCamera.CEILING, 200);
  assert.equal(map3dCamera.DT_CAP_MS, 50);
  assert.equal(map3dCamera.LOOK_DEG_PER_PX, 0.25);
  assert.equal(map3dCamera.KEY_YAW_DEG_PER_S, 60);
  assert.equal(map3dCamera.KEY_PITCH_DEG_PER_S, 60);
  assert.equal(map3dCamera.DOLLY_FRACTION, 0.12);
});

test("map3dTimeline: agent action clips arrive at the saved turn", () => {
  const ctx = m3dContext(M3D_SLOTS);
  const kinds = (tl) => tl.clips.map((c) => c.kind);
  const build = (...effects) => {
    const tl = map3dTimeline.buildTimeline(effects, ctx);
    assert.ok(map3dTimeline.timelineIsValid(tl), "every clip ends by 700 ms");
    assert.ok(map3dTimeline.timelineDuration(tl) <= map3dTimeline.TIMELINE_MAX_MS);
    for (const c of tl.clips) assert.ok(c.t1 <= 700 && c.t0 <= c.t1, `clip ${c.kind} times`);
    return tl;
  };
  // move ok: slide from the origin cell to the slot, plus a trail.
  const move = build(m3dEffect("move", { actor: "a01", from: { x: 1, y: 0 }, to: { x: 0, y: 0 }, at: { x: 0, y: 0 }, label: "moved left" }));
  assert.deepEqual(kinds(move), ["slide", "trail"]);
  assert.deepEqual(move.clips[0].from, [1, 0, 0]);
  assert.deepEqual(move.clips[0].to, [0, 0, 0]);
  assert.equal(move.clips[0].id, "a01");
  assert.deepEqual([move.clips[0].t0, move.clips[0].t1], [0, 450]);
  assert.deepEqual([move.clips[1].from, move.clips[1].to], [[1, 0, 0], [0, 0, 0]]);
  const start = map3dTimeline.sampleTimeline(move, 0);
  m3dAssertVec(start.entities.get("a01").offset, [1, 0, 0], 1e-12, "start offset = from - slot");
  assert.equal(start.entities.get("a01").scale, 1);
  assert.equal(start.done, false);
  assert.equal(start.fx.length, 1);
  assert.equal(start.fx[0].kind, "trail");
  assert.equal(start.fx[0].opacity, 1);
  const midway = map3dTimeline.sampleTimeline(move, 225);
  const off = midway.entities.get("a01").offset;
  assert.ok(off[0] > 0 && off[0] < 1, "still on its way");
  assert.ok(off[1] > 0.1, "hops");
  const end = map3dTimeline.sampleTimeline(move, 700);
  assert.equal(end.done, true);
  assert.equal(end.entities.size, 0, "no override at the end");
  assert.deepEqual(end.fx, []);
  assert.equal(map3dTimeline.sampleTimeline(move, 450).entities.has("a01"), false, "the slide is over at 450");
  assert.equal(map3dTimeline.sampleTimeline(move, 450).done, false, "the trail still fades");
  // move failed: a puff only.
  assert.deepEqual(kinds(build(m3dEffect("move", { ok: false, from: { x: 0, y: 0 }, to: { x: 0, y: 1 }, at: { x: 0, y: 0 } }))), ["puff"]);
  // attack, not killed: directed strike, target burst, flash, floating damage.
  const attack = build(m3dEffect("attack", { actor: "a01", targets: ["a02"], amount: 5, label: "attacked a02 (5 damage)" }));
  assert.deepEqual(kinds(attack), ["lunge", "beam", "puff", "flash", "float"]);
  assert.equal(attack.clips[4].text, "-5");
  assert.equal(attack.clips[3].id, "a02");
  assert.deepEqual([attack.clips[3].t0, attack.clips[3].t1], [120, 600]);
  const hit = map3dTimeline.sampleTimeline(attack, 150);
  assert.equal(hit.entities.get("a02").tint, "bad");
  assert.ok(Math.hypot(...hit.entities.get("a01").offset) > 0.1, "the attacker lunges");
  assert.deepEqual(hit.fx.map((effect) => effect.kind), ["beam", "puff", "float"]);
  assert.equal(hit.fx[2].text, "-5");
  assert.ok(hit.fx[2].position[1] > 0.6, "the number floats above the target");
  // attack that killed, with the death of the same id in the same turn: exactly one tilt.
  const kill = build(m3dEffect("attack", { actor: "a01", targets: ["a02"], amount: 9, label: "attacked a02 (9 damage, killed)" }), m3dEffect("death", { actor: "world", targets: ["a02"], at: { x: 3, y: 3 } }));
  assert.equal(kinds(kill).filter((k) => k === "tilt").length, 1);
  const dying = map3dTimeline.sampleTimeline(kill, 0);
  m3dAssertClose(dying.entities.get("a02").tilt, -Math.PI / 2, 1e-12, "starts upright");
  m3dAssertClose(dying.entities.get("a02").offset[1], 0.15, 1e-12, "starts lifted, sinks onto the saved pose");
  assert.equal(map3dTimeline.sampleTimeline(kill, 650).entities.has("a02"), false, "tilt and flash are over");
  // Failed actions give the actor a brief red attempt cue.
  assert.deepEqual(kinds(build(m3dEffect("attack", { ok: false, targets: ["a02"] }))), ["puff"]);
  // broadcast: ripple to the communication range and a bounce per recipient.
  const broadcast = build(m3dEffect("message", { actor: "a01", broadcast: true, targets: ["a02", "a03", "zz"], at: { x: 0, y: 0 } }));
  assert.deepEqual(kinds(broadcast), ["ripple", "bounce", "bounce"]);
  assert.equal(broadcast.clips[0].value, 4, "ripple grows to commRange(a01)");
  assert.deepEqual(broadcast.clips[1].id, "a02");
  const rippling = map3dTimeline.sampleTimeline(broadcast, 300);
  assert.equal(rippling.fx[0].kind, "ripple");
  assert.ok(rippling.fx[0].radius > 0.2 && rippling.fx[0].radius < 4);
  assert.ok(rippling.fx[0].opacity > 0 && rippling.fx[0].opacity < 0.8);
  assert.equal(rippling.entities.has("a02"), false, "the bounce has not started");
  assert.ok(map3dTimeline.sampleTimeline(broadcast, 475).entities.get("a02").offset[1] > 0.1, "bounce peak");
  const unknownRange = build(m3dEffect("message", { actor: "a02", broadcast: true, at: { x: 3, y: 3 } }));
  assert.equal(unknownRange.clips[0].value, map3dTimeline.DEFAULT_COMM_RANGE);
  // Send draws a directed beam; failed sends show the actor's attempt.
  const send = build(m3dEffect("message", { actor: "a01", targets: ["a02"], label: "sent a message to a02" }));
  assert.deepEqual(kinds(send), ["beam"]);
  assert.deepEqual([send.clips[0].from, send.clips[0].to], [[0, 0, 0], [3, 0, -3]]);
  assert.deepEqual(kinds(build(m3dEffect("message", { ok: false, targets: ["a02"] }))), ["puff"]);
  // absorb / transfer: particles and a floating gain.
  const absorb = build(m3dEffect("absorb", { actor: "a01", targets: ["f01"], amount: 3 }));
  assert.deepEqual(kinds(absorb), ["particles", "float"]);
  assert.deepEqual([absorb.clips[0].from, absorb.clips[0].to], [[5, 0, -5], [0, 0, 0]]);
  assert.equal(absorb.clips[1].text, "+3");
  const transfer = build(m3dEffect("transfer", { actor: "a01", targets: ["a02"], amount: 2.5 }));
  assert.deepEqual(kinds(transfer), ["particles", "float"]);
  assert.deepEqual(transfer.clips[0].to, [3, 0, -3]);
  assert.equal(transfer.clips[1].text, "+2.5");
  m3dAssertVec(transfer.clips[1].from, [3, 0.7, -3], 1e-12, "the number starts over the recipient");
  // recover / upgrade / observe / query / wait / skill.
  const recover = build(m3dEffect("recover", { actor: "a01", amount: 4 }));
  assert.deepEqual(kinds(recover), ["pulse", "float"]);
  assert.equal(recover.clips[0].colour, "good");
  assert.equal(recover.clips[1].text, "+4");
  const upgrade = build(m3dEffect("upgrade", { actor: "a01" }));
  assert.deepEqual(kinds(upgrade), ["pulse"]);
  assert.equal(upgrade.clips[0].colour, "warn");
  assert.ok(upgrade.clips[0].to[1] > upgrade.clips[0].from[1], "the ring rises");
  const observe = build(m3dEffect("observe", { actor: "a01", to: { x: 2, y: 2 } }));
  assert.deepEqual(kinds(observe), ["quad"]);
  assert.deepEqual(observe.clips[0].from, [2, 0, -2]);
  const query = build(m3dEffect("query", { actor: "a01", targets: ["a02"] }));
  assert.deepEqual(kinds(query), ["beam"]);
  assert.equal(query.clips[0].t1, 300);
  assert.deepEqual(kinds(build(m3dEffect("query", { actor: "a01", targets: [] }))), [], "query self: chip only");
  assert.deepEqual(kinds(build(m3dEffect("wait"))), ["pulse"]);
  assert.deepEqual(kinds(build(m3dEffect("skill"))), ["pulse"]);
  assert.deepEqual(kinds(build(m3dEffect("voice", { actor: "operator", targets: ["a01"] }))), ["pulse"]);
  assert.deepEqual(map3dTimeline.buildTimeline([], ctx), { clips: [], duration: 0 });
  assert.equal(map3dTimeline.sampleTimeline(map3dTimeline.buildTimeline([], ctx), 0).done, true);
});

test("map3dTimeline: world clips, staggered spawns, scaling, reduced motion and missing data", () => {
  const ctx = m3dContext(M3D_SLOTS);
  const roundEnd = [
    m3dEffect("growth", { actor: "p01", targets: ["p01"], at: { x: 5, y: 5 } }),
    m3dEffect("fruit", { actor: "p01", targets: ["f01"], at: { x: 5, y: 5 } }),
    m3dEffect("fruit", { actor: "p01", targets: ["f02"], at: { x: 5, y: 5 } }),
    m3dEffect("fruit", { actor: "p01", targets: ["f03"], at: { x: 5, y: 5 } }),
    m3dEffect("seed", { actor: "p01", targets: ["s01"], at: { x: 6, y: 6 } }),
    m3dEffect("germination", { actor: "s09", targets: ["p02"], at: { x: 1, y: 9 } }),
    m3dEffect("death", { actor: "world", targets: ["a02"], at: { x: 3, y: 3 }, label: "a02 died (starvation)" }),
    m3dEffect("starvation", { actor: "world", targets: ["a03"], at: { x: 1, y: 1 }, amount: 5 }),
    m3dEffect("voice", { actor: "operator", targets: ["a01", "a03"] }),
  ];
  const tl = map3dTimeline.buildTimeline(roundEnd, ctx);
  assert.ok(map3dTimeline.timelineIsValid(tl));
  const byKind = (kind) => tl.clips.filter((c) => c.kind === kind);
  assert.equal(byKind("pop").length, 6, "growth + 3 fruit + seed + germination");
  const growth = tl.clips.find((c) => c.id === "p01");
  assert.equal(growth.kind, "pop");
  assert.equal(growth.value, 0.8);
  assert.deepEqual([growth.t0, growth.t1], [0, 450]);
  const spawnPops = tl.clips.filter((c) => c.kind === "pop" && c.value === 0);
  assert.deepEqual(spawnPops.map((c) => c.id), ["f01", "f02", "f03", "s01", "p02"], "spawns keep their order");
  assert.deepEqual(spawnPops.map((c) => c.t0), [0, 30, 60, 90, 120], "30 ms stagger");
  assert.deepEqual(spawnPops.map((c) => c.t1 - c.t0), [300, 300, 300, 300, 300]);
  assert.equal(byKind("tilt").length, 1);
  assert.equal(byKind("flash").length, 1);
  assert.equal(byKind("float")[0].text, "-5");
  assert.equal(tl.clips.filter((c) => c.effectKind === "voice").length, 2);
  assert.equal(map3dTimeline.timelineDuration(tl), 600);
  const start = map3dTimeline.sampleTimeline(tl, 0);
  m3dAssertClose(start.entities.get("f01").scale, 0, 1e-12, "a spawned fruit starts invisible");
  m3dAssertClose(start.entities.get("f03").scale, 0, 1e-12, "a later spawn holds its start pose until its turn");
  m3dAssertClose(start.entities.get("p01").scale, 0.8, 1e-12, "growth starts at 80 %");
  assert.equal(start.entities.get("a03").tint, "bad");
  const later = map3dTimeline.sampleTimeline(tl, 200);
  assert.ok(later.entities.get("f01").scale > 0.9, "the first pop is nearly done");
  assert.ok(later.entities.get("p02").scale > 0 && later.entities.get("p02").scale < later.entities.get("f01").scale, "the last pop lags");
  const end = map3dTimeline.sampleTimeline(tl, 700);
  assert.equal(end.done, true);
  assert.equal(end.entities.size, 0);
  assert.deepEqual(end.fx, []);
  // scaleTimeline halves every time.
  const half = map3dTimeline.scaleTimeline(tl, 0.5);
  assert.equal(half.duration, 300);
  half.clips.forEach((c, i) => {
    assert.equal(c.t0, tl.clips[i].t0 / 2);
    assert.equal(c.t1, tl.clips[i].t1 / 2);
  });
  assert.equal(tl.clips.find((c) => c.id === "f01").t1, 300, "the original is untouched");
  assert.equal(map3dTimeline.scaleTimeline(tl, 0).duration, 0);
  assert.equal(map3dTimeline.sampleTimeline(map3dTimeline.scaleTimeline(tl, 0), 0).done, true);
  // reducedMotion: every duration 0, the sample is the saved turn at once.
  const still = map3dTimeline.buildTimeline(roundEnd, m3dContext(M3D_SLOTS, { reducedMotion: true }));
  assert.equal(still.clips.length, tl.clips.length, "the clips still exist for the chips' sake");
  for (const c of still.clips) assert.deepEqual([c.t0, c.t1], [0, 0]);
  assert.equal(still.duration, 0);
  const instant = map3dTimeline.sampleTimeline(still, 0);
  assert.equal(instant.done, true);
  assert.equal(instant.entities.size, 0);
  assert.deepEqual(instant.fx, []);
  assert.equal(map3dTimeline.progress(still.clips[0], 0), 1);
  // 60 spawns: 40 animated, the stagger compressed so the last still ends by 700 ms.
  const manySlots = {};
  const many = [];
  for (let i = 0; i < 60; i++) {
    manySlots[`f${i}`] = [i, 0, 0];
    many.push(m3dEffect("fruit", { actor: "p01", targets: [`f${i}`], at: { x: i, y: 0 } }));
  }
  const crowd = map3dTimeline.buildTimeline(many, m3dContext(manySlots));
  assert.equal(crowd.clips.length, 40);
  assert.ok(map3dTimeline.timelineIsValid(crowd));
  assert.equal(crowd.clips[39].t1, 700);
  assert.ok(crowd.clips[1].t0 > 0 && crowd.clips[1].t0 < 30, "stagger shrinks below 30 ms");
  // Missing data degrades to the chip alone and never throws.
  const tolerant = map3dTimeline.buildTimeline(
    [
      m3dEffect("move", { actor: "a01", from: null, to: { x: 0, y: 0 }, at: { x: 0, y: 0 } }),
      m3dEffect("attack", { actor: "a01", targets: ["gone"], amount: 3 }),
      m3dEffect("death", { actor: "world", targets: ["nobody"], at: null }),
      m3dEffect("absorb", { actor: "ghost", targets: ["f01"], amount: 1 }),
      m3dEffect("transfer", { actor: "a01", targets: [], amount: 1 }),
      m3dEffect("growth", { actor: "p99", targets: ["p99"] }),
      m3dEffect("observe", { actor: "a01", to: null }),
      m3dEffect("fruit", { actor: "p01", targets: [] }),
      m3dEffect("starvation", { actor: "world", targets: [] }),
      m3dEffect("message", { actor: "zz", broadcast: true, targets: ["a01"] }),
    ],
    ctx,
  );
  assert.deepEqual(tolerant.clips.map((c) => c.kind), ["bounce"], "only the recipient with a slot bounces");
  assert.equal(map3dTimeline.sampleTimeline(tolerant, 100).entities.size, 0);
  // A move whose actor has no slot still draws the trail between the cells.
  const teleport = map3dTimeline.buildTimeline([m3dEffect("move", { actor: "ghost", from: { x: 0, y: 0 }, to: { x: 0, y: 1 } })], ctx);
  assert.deepEqual(teleport.clips.map((c) => c.kind), ["trail"]);
  // Chips: above the actor's slot, else the target, else the cell; one per voice recipient.
  const chips = map3dTimeline.chipPlacements(
    [
      m3dEffect("move", { actor: "a01", at: { x: 0, y: 0 } }),
      m3dEffect("death", { actor: "world", targets: ["a02"], at: { x: 3, y: 3 } }),
      m3dEffect("fruit", { actor: "world", targets: [], at: { x: 7, y: 7 } }),
      m3dEffect("voice", { actor: "operator", targets: ["a01", "a03", "nobody"] }),
      m3dEffect("wait", { actor: "nobody", at: null }),
    ],
    ctx,
  );
  assert.deepEqual(
    chips.map((c) => [c.effect.kind, c.id, c.position]),
    [
      ["move", "a01", [0, 0.9, 0]],
      ["death", "a02", [3, 0.9, -3]],
      ["fruit", null, [7, 0.9, -7]],
      ["voice", "a01", [0, 0.9, 0]],
      ["voice", "a03", [1, 0.9, -1]],
    ],
  );
  // Easing shapes.
  assert.equal(map3dTimeline.easeInOut(0), 0);
  assert.equal(map3dTimeline.easeInOut(1), 1);
  assert.equal(map3dTimeline.easeInOut(0.5), 0.5);
  assert.equal(map3dTimeline.easeOut(1), 1);
  assert.ok(map3dTimeline.easeOut(0.5) > 0.5);
  m3dAssertClose(map3dTimeline.easeOutBack(0), 0, 1e-12);
  m3dAssertClose(map3dTimeline.easeOutBack(1), 1, 1e-12);
  assert.ok(map3dTimeline.easeOutBack(0.7) > 1, "overshoots");
  assert.equal(map3dTimeline.formatAmount(5, "-"), "-5");
  assert.equal(map3dTimeline.formatAmount(2.346, "+"), "+2.35");
  assert.equal(map3dTimeline.formatAmount(-3, "+"), "+3");
});

test("map3dTerrain: one merged board with raised mountains and sunk water", () => {
  const map = {
    region: { min_x: 0, max_x: 2, min_y: 0, max_y: 1 },
    cells: { "0,0": "land", "1,0": "mountain", "2,0": "land", "0,1": "land", "1,1": "land", "2,1": "water" },
    occupants: {},
  };
  const palette = { land: [0.9, 0.93, 0.82], mountain: [0.6, 0.56, 0.51], mountainSide: [0.48, 0.45, 0.41], water: [0.56, 0.76, 0.93] };
  const arrays = map3dTerrain.buildTerrainArrays(map, palette);
  assert.equal(arrays.indices.length / 3, 20, "4 land x 2 + 1 water x 2 + 1 mountain x 10");
  assert.equal(map3dTerrain.terrainTriangleCount(map), 20);
  assert.equal(arrays.faceCell.length, 20);
  assert.equal(arrays.positions.length, 3 * (5 * 4 + 20));
  assert.equal(arrays.normals.length, arrays.positions.length);
  assert.equal(arrays.colors.length, arrays.positions.length);
  const sameColour = (i, c) => m3dClose(arrays.colors[3 * i], c[0], 1e-6) && m3dClose(arrays.colors[3 * i + 1], c[1], 1e-6) && m3dClose(arrays.colors[3 * i + 2], c[2], 1e-6);
  const vertexCount = arrays.positions.length / 3;
  let mountainTops = 0;
  let sides = 0;
  let waters = 0;
  let lands = 0;
  for (let i = 0; i < vertexCount; i++) {
    const y = arrays.positions[3 * i + 1];
    if (sameColour(i, palette.mountain)) {
      mountainTops++;
      m3dAssertClose(y, 0.6, 1e-6, "mountain top");
    } else if (sameColour(i, palette.mountainSide)) {
      sides++;
      assert.ok(m3dClose(y, 0, 1e-6) || m3dClose(y, 0.6, 1e-6), `side vertex y ${y}`);
    } else if (sameColour(i, palette.water)) {
      waters++;
      m3dAssertClose(y, -0.15, 1e-6, "water");
    } else {
      assert.ok(sameColour(i, palette.land));
      lands++;
      m3dAssertClose(y, 0, 1e-6, "land");
    }
  }
  assert.deepEqual([mountainTops, sides, waters, lands], [4, 16, 4, 16]);
  for (let c = 0; c < 3; c++) assert.ok(palette.mountainSide[c] < palette.mountain[c], "sides are darker");
  // The mountain block covers cell (1, 0): scene x in [0.5, 1.5], z in [-0.5, 0.5].
  for (let i = 0; i < vertexCount; i++) {
    if (!sameColour(i, palette.mountain) && !sameColour(i, palette.mountainSide)) continue;
    const x = arrays.positions[3 * i];
    const z = arrays.positions[3 * i + 2];
    assert.ok(m3dClose(Math.abs(x - 1), 0.5, 1e-6) && m3dClose(Math.abs(z), 0.5, 1e-6), `mountain corner (${x}, ${z})`);
  }
  // Every triangle winds counter-clockwise around its stored normal (three.js front face).
  for (let f = 0; f < 20; f++) {
    const [ia, ib, ic] = [arrays.indices[3 * f], arrays.indices[3 * f + 1], arrays.indices[3 * f + 2]];
    const p = (i) => [arrays.positions[3 * i], arrays.positions[3 * i + 1], arrays.positions[3 * i + 2]];
    const [a, b, c] = [p(ia), p(ib), p(ic)];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const n = [arrays.normals[3 * ia], arrays.normals[3 * ia + 1], arrays.normals[3 * ia + 2]];
    assert.ok(cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] > 0, `face ${f} winding`);
    assert.equal(arrays.normals[3 * ib], n[0], "flat shading: one normal per quad");
  }
  // faceCell and cellOfFace agree, with and without the arrays.
  for (let f = 0; f < 20; f++) {
    const viaTable = map3dTerrain.cellOfFace(map, f, arrays);
    assert.deepEqual(map3dTerrain.cellOfFace(map, f), viaTable, `face ${f}`);
    assert.deepEqual(map3dTerrain.cellOfIndex(map, arrays.faceCell[f]), viaTable);
    assert.equal(map3dTerrain.cellIndex(map, viaTable), arrays.faceCell[f]);
  }
  assert.deepEqual(map3dTerrain.cellOfFace(map, 0), { x: 0, y: 0 });
  assert.deepEqual(map3dTerrain.cellOfFace(map, 2), { x: 1, y: 0 });
  assert.deepEqual(map3dTerrain.cellOfFace(map, 11), { x: 1, y: 0 }, "the mountain's last side triangle");
  assert.deepEqual(map3dTerrain.cellOfFace(map, 12), { x: 2, y: 0 });
  assert.deepEqual(map3dTerrain.cellOfFace(map, 19), { x: 2, y: 1 });
  assert.equal(map3dTerrain.cellOfFace(map, 20), null);
  assert.equal(map3dTerrain.cellOfFace(map, -1), null);
  assert.equal(map3dTerrain.cellOfFace(map, 20, arrays), null);
  assert.equal(map3dTerrain.terrainAt(map, { x: 9, y: 9 }), "land", "a missing cell counts as land");
  assert.equal(map3dTerrain.cellIndex(map, { x: 2, y: 1 }), 5);
  assert.equal(map3dTerrain.regionCols(map), 3);
  assert.equal(map3dTerrain.regionRows(map), 2);
  // Grid: 4 segments per land cell at GRID_Y.
  const grid = map3dTerrain.gridLineArrays(map);
  assert.equal(grid.length, 4 * 4 * 6);
  for (let i = 1; i < grid.length; i += 3) m3dAssertClose(grid[i], 0.005, 1e-9, "grid height");
  // Border: 4 outline segments, plus the origin lines only when 0 lies inside the span.
  const border = map3dTerrain.borderLineArrays(map);
  assert.equal(border.length, (4 + 2) * 6, "0 is inside both spans of 0..2 x 0..1");
  assert.equal(map3dTerrain.originLineCount(map), 2);
  m3dAssertVec(Array.from(border.subarray(0, 6)), [-0.5, 0.01, -1.5, 2.5, 0.01, -1.5], 1e-9, "north edge of the outline");
  m3dAssertVec(Array.from(border.subarray(24, 30)), [0, 0.01, -1.5, 0, 0.01, 0.5], 1e-9, "x = 0 line through the column's centre");
  m3dAssertVec(Array.from(border.subarray(30, 36)), [-0.5, 0.01, 0, 2.5, 0.01, 0], 1e-9, "y = 0 line through the row's centre");
  const offGrid = { region: { min_x: 1, max_x: 3, min_y: -3, max_y: -1 }, cells: {}, occupants: {} };
  assert.equal(map3dTerrain.borderLineArrays(offGrid).length, 4 * 6, "no origin line when 0 is outside both spans");
  assert.equal(map3dTerrain.originLineCount(offGrid), 0);
  const halfGrid = { region: { min_x: -1, max_x: 1, min_y: 2, max_y: 3 }, cells: {}, occupants: {} };
  assert.equal(map3dTerrain.borderLineArrays(halfGrid).length, 5 * 6, "only the x = 0 line");
  assert.equal(map3dTerrain.gridLineArrays(halfGrid).length, 6 * 4 * 6, "missing cells are land");
  assert.deepEqual(map3dTerrain.buildTerrainArrays({ region: { min_x: 0, max_x: -1, min_y: 0, max_y: 0 }, cells: {}, occupants: {} }, palette).indices.length, 0, "an empty region gives empty arrays");
  assert.equal(map3dTerrain.LAND_Y, 0);
  assert.equal(map3dTerrain.MOUNTAIN_Y, 0.6);
  assert.equal(map3dTerrain.WATER_Y, -0.15);
});

test("map3dPalette: CSS colours, missing tokens, health, species and dominant kinds", () => {
  m3dAssertVec(map3dPalette.parseCssColor("#1f5fbf"), [31 / 255, 95 / 255, 191 / 255]);
  m3dAssertVec(map3dPalette.parseCssColor("#fff"), [1, 1, 1]);
  m3dAssertVec(map3dPalette.parseCssColor("  #1F5FBF "), [31 / 255, 95 / 255, 191 / 255]);
  m3dAssertVec(map3dPalette.parseCssColor("rgb(31, 95, 191)"), [31 / 255, 95 / 255, 191 / 255]);
  m3dAssertVec(map3dPalette.parseCssColor("rgba(0,0,0,0.16)"), [0, 0, 0]);
  m3dAssertVec(map3dPalette.parseCssColorAlpha("rgba(0, 0, 0, 0.16)"), [0, 0, 0, 0.16]);
  m3dAssertVec(map3dPalette.parseCssColorAlpha("rgb(0 0 0 / 50%)"), [0, 0, 0, 0.5]);
  m3dAssertVec(map3dPalette.parseCssColorAlpha("#80808080"), [128 / 255, 128 / 255, 128 / 255, 128 / 255]);
  m3dAssertVec(map3dPalette.parseCssColorAlpha("rgb(100%, 0%, 50%)"), [1, 0, 0.5, 1]);
  assert.equal(map3dPalette.parseCssColor(""), null);
  assert.equal(map3dPalette.parseCssColor("   "), null);
  assert.equal(map3dPalette.parseCssColor(null), null);
  assert.equal(map3dPalette.parseCssColor("transparent"), null);
  assert.equal(map3dPalette.parseCssColor("#12"), null);
  assert.equal(map3dPalette.parseCssColor("#gggggg"), null);
  assert.equal(map3dPalette.parseCssColor("rgb(1, 2)"), null);
  assert.equal(map3dPalette.parseCssColor("var(--insp-fg)"), null);
  // A stub that has no tokens: every role grey and every token reported once.
  const empty = map3dPalette.readPalette(() => "");
  assert.deepEqual(empty.missing, map3dPalette.PALETTE_TOKENS);
  assert.ok(empty.missing.includes("--insp-agent") && empty.missing.includes("--insp-other"));
  assert.deepEqual(empty.agent, [0.5, 0.5, 0.5]);
  assert.deepEqual(empty.land, [0.5, 0.5, 0.5]);
  assert.equal(empty.gridAlpha, 1);
  assert.equal(map3dPalette.PALETTE_TOKENS.length, Object.keys(map3dPalette.ROLE_TOKENS).length);
  assert.ok(map3dPalette.PALETTE_TOKENS.every((t) => t.startsWith("--insp-")));
  assert.equal(map3dPalette.ROLE_TOKENS.fruit, "--insp-other");
  const throwing = map3dPalette.readPalette(() => {
    throw new Error("no style");
  });
  assert.equal(throwing.missing.length, map3dPalette.PALETTE_TOKENS.length);
  // The shipped light theme.
  const light = { "--insp-good": "#1e7b34", "--insp-warn-border": "#d9a800", "--insp-bad": "#b3261e", "--insp-plant": "#2e7d32", "--insp-mountain": "rgb(155, 143, 130)", "--insp-grid": "rgba(0, 0, 0, 0.16)", "--insp-agent": "#1f5fbf" };
  const partial = map3dPalette.readPalette((name) => light[name] ?? "");
  assert.equal(partial.missing.length, map3dPalette.PALETTE_TOKENS.length - Object.keys(light).length);
  assert.ok(!partial.missing.includes("--insp-agent"));
  m3dAssertClose(partial.gridAlpha, 0.16);
  m3dAssertVec(partial.agent, [31 / 255, 95 / 255, 191 / 255]);
  m3dAssertVec(map3dPalette.healthColour(1, partial), partial.good, 1e-12, "full health = good");
  m3dAssertVec(map3dPalette.healthColour(0, partial), partial.bad, 1e-12, "no health = bad");
  m3dAssertVec(map3dPalette.healthColour(0.5, partial), partial.warn, 1e-12, "half = warn");
  m3dAssertVec(map3dPalette.healthColour(0.75, partial), map3dPalette.mix(partial.warn, partial.good, 0.5), 1e-12);
  m3dAssertVec(map3dPalette.healthColour(7, partial), partial.good, 1e-12, "clamped");
  m3dAssertVec(map3dPalette.healthColour(Number.NaN, partial), partial.bad, 1e-12, "NaN counts as 0");
  // Terrain palette: sides 20 % darker than the mountain top.
  const terrain = map3dPalette.terrainPalette(partial);
  m3dAssertVec(terrain.mountainSide, partial.mountain.map((c) => c * 0.8), 1e-12);
  assert.deepEqual(terrain.mountain, partial.mountain);
  // Species hue: stable, integer, within +-14.
  for (const species of ["oak", "fruit_tree", "", "a", "the same very long species name indeed"]) {
    const shift = map3dPalette.speciesHueShift(species);
    assert.equal(shift, map3dPalette.speciesHueShift(species), "stable");
    assert.ok(Number.isInteger(shift) && shift >= -14 && shift <= 14, `${species}: ${shift}`);
  }
  assert.equal(map3dPalette.speciesHueShift(""), 0);
  assert.ok(new Set(["oak", "pine", "fern", "moss", "reed", "birch", "maple"].map(map3dPalette.speciesHueShift)).size > 1, "species differ");
  m3dAssertVec(map3dPalette.shiftHue([1, 0, 0], 120), [0, 1, 0], 1e-9, "red + 120 deg = green");
  m3dAssertVec(map3dPalette.shiftHue([1, 0, 0], -120), [0, 0, 1], 1e-9, "red - 120 deg = blue");
  m3dAssertVec(map3dPalette.shiftHue([0.3, 0.3, 0.3], 30), [0.3, 0.3, 0.3], 1e-12, "grey has no hue");
  const shifted = map3dPalette.shiftHue(partial.plant, 14);
  assert.ok(Math.hypot(shifted[0] - partial.plant[0], shifted[1] - partial.plant[1], shifted[2] - partial.plant[2]) > 0.01, "a 14 degree shift is visible");
  m3dAssertVec(map3dPalette.hslToRgb(map3dPalette.rgbToHsl(partial.plant)), partial.plant, 1e-9, "HSL round trip");
  m3dAssertVec(map3dPalette.plantColour("oak", true, partial), partial.dead, 1e-12);
  m3dAssertVec(map3dPalette.plantColour("oak", false, partial), map3dPalette.shiftHue(partial.plant, map3dPalette.speciesHueShift("oak")), 1e-12);
  m3dAssertVec(map3dPalette.mix([0, 0, 0], [1, 1, 1], 0.25), [0.25, 0.25, 0.25]);
  m3dAssertVec(map3dPalette.mix([0, 0, 0], [1, 1, 1], 7), [1, 1, 1], 1e-12, "t clamps");
  m3dAssertVec(map3dPalette.darken([1, 0.5, 0], 0.2), [0.8, 0.4, 0]);
  m3dAssertVec(map3dPalette.ghostTint([0, 0, 0], partial), partial.land.map((c) => c / 2), 1e-12);
  assert.equal(map3dPalette.rgbToCss([31 / 255, 95 / 255, 191 / 255]), "rgb(31, 95, 191)");
  assert.equal(map3dPalette.kindColour("fruit", partial), partial.fruit);
  assert.equal(map3dPalette.kindColour("dead", partial), partial.dead);
  // Dominant kind: any living agent wins, else the majority, ties to the earlier drawing rank.
  assert.equal(map3dPalette.dominantKind([m3dMarker("p1", "plant"), m3dMarker("p2", "plant"), m3dMarker("a1", "agent")]), "agent");
  assert.equal(map3dPalette.dominantKind([m3dMarker("p1", "plant"), m3dMarker("f1", "fruit"), m3dMarker("f2", "fruit")]), "fruit");
  assert.equal(map3dPalette.dominantKind([m3dMarker("a1", "agent", true), m3dMarker("p1", "plant")]), "dead");
  assert.equal(map3dPalette.dominantKind([m3dMarker("r1", "residue"), m3dMarker("s1", "seed")]), "seed");
  assert.equal(map3dPalette.dominantKind([m3dMarker("p1", "plant", true), m3dMarker("f1", "fruit"), m3dMarker("f2", "fruit"), m3dMarker("f3", "fruit")]), "fruit");
  assert.equal(map3dPalette.dominantKind([]), null);
});

test("map3dGlyphs: an ASCII SVG path per effect kind, a strike for failures, chip text", () => {
  assert.equal(M3D_KINDS.length, 18);
  assert.deepEqual([...map3dGlyphs.GLYPH_KINDS].sort(), [...M3D_KINDS].sort());
  const ascii = (s) => [...s].every((ch) => ch.codePointAt(0) <= 0x7f);
  for (const kind of M3D_KINDS) {
    const ok = map3dGlyphs.glyphFor(kind, true);
    assert.ok(ok.path.length > 0, `${kind} has a path`);
    assert.ok(ok.label.length > 0, `${kind} has a label`);
    assert.ok(/^M/.test(ok.path), `${kind} path starts with a move`);
    assert.ok(ascii(ok.path) && ascii(ok.label), `${kind} glyph is ASCII`);
    assert.ok(!ok.path.includes(map3dGlyphs.STRIKE_PATH), `${kind} ok has no strike`);
    const failed = map3dGlyphs.glyphFor(kind, false);
    assert.ok(failed.path.startsWith(ok.path) && failed.path.endsWith(map3dGlyphs.STRIKE_PATH), `${kind} failed adds the strike`);
    assert.ok(failed.label.endsWith("(failed)"));
    assert.ok(ascii(failed.path) && ascii(failed.label));
  }
  assert.equal(map3dGlyphs.glyphFor("move", true).label, "move");
  assert.equal(map3dGlyphs.glyphFor("voice", true).label, "operator voice");
  assert.notEqual(map3dGlyphs.glyphFor("move", true).path, map3dGlyphs.glyphFor("attack", true).path);
  assert.equal(map3dGlyphs.glyphFor("fruit", true).path, map3dGlyphs.glyphFor("seed", true).path, "spawns share the sprout");
  assert.equal(map3dGlyphs.glyphFor("nonsense", true).path, map3dGlyphs.glyphFor("skill", true).path, "unknown kinds fall back to the gear");
  assert.equal(map3dGlyphs.GLYPH_VIEWBOX, "0 0 24 24");
  assert.equal(map3dGlyphs.STRIKE_PATH, "M4 20 L20 4");
  const long = "attacked a02 (5 damage, killed) via skill hunt_and_gather"; // 57 chars
  assert.equal(long.length, 57);
  const cut = map3dGlyphs.chipText({ label: long });
  assert.equal(cut.length, 40);
  assert.ok(cut.endsWith("…"), "ends with an ellipsis");
  assert.equal(cut, `${long.slice(0, 39).trimEnd()}…`);
  assert.equal(map3dGlyphs.chipText({ label: "moved up" }), "moved up");
  assert.equal(map3dGlyphs.chipText({ label: "x".repeat(40) }), "x".repeat(40), "exactly 40 is kept");
  assert.equal(map3dGlyphs.chipText({ label: "  padded  " }), "padded");
  assert.equal(map3dGlyphs.CHIP_TEXT_MAX, 40);
  assert.equal(map3dGlyphs.chipClasses({ kind: "move", ok: true }), "map3d-chip map3d-chip-move");
  assert.equal(map3dGlyphs.chipClasses({ kind: "attack", ok: false }), "map3d-chip map3d-chip-attack map3d-chip-failed");
});

// ---------------------------------------------------------------- WP-3D fix pass: the 3D overlay placement (map3dLayout.placeOverlay)

const m3dBox = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });
const m3dPlace = (entries, cap = 40) => map3dLayout.placeOverlay(entries, cap).map((p) => `${p.key}#${p.box}`);

test("map3dLayout: boxesOverlap keeps a gap and treats touching edges as apart", () => {
  const a = m3dBox(0, 0, 10, 10);
  assert.equal(map3dLayout.boxesOverlap(a, m3dBox(5, 5, 10, 10)), true, "intersecting");
  assert.equal(map3dLayout.boxesOverlap(a, m3dBox(10, 0, 10, 10)), false, "touching edges without a gap");
  assert.equal(map3dLayout.boxesOverlap(a, m3dBox(11, 0, 10, 10), 2), true, "1 px apart is too close for a 2 px gap");
  assert.equal(map3dLayout.boxesOverlap(a, m3dBox(12, 0, 10, 10), 2), false, "2 px apart is clear");
  assert.equal(map3dLayout.boxesOverlap(a, m3dBox(3, 20, 4, 4), 2), false, "below with room");
  assert.equal(map3dLayout.OVERLAY_GAP, 2);
});

test("map3dLayout: placeOverlay never lets two placed boxes overlap (crowded labels fall back to the id, then drop out)", () => {
  // Three agent labels over one spot, nearest first; each can shrink to its id (the second box).
  const label = (key, depth, x) => ({ key, priority: 2, depth, boxes: [m3dBox(x, 100, 70, 15), m3dBox(x + 25, 100, 20, 15)] });
  const placed = m3dPlace([label("far", 9, 40), label("near", 5, 0), label("mid", 7, 20)]);
  assert.deepEqual(placed, ["near#0"], "the nearest keeps its full text; the others have no room even as ids");
  const spread = m3dPlace([label("a", 5, 0), label("b", 6, 50)]);
  assert.deepEqual(spread, ["a#0", "b#1"], "the second label fits as its id beside the first");
  // Whatever is placed, no two chosen boxes come within the gap.
  const many = Array.from({ length: 30 }, (_, i) => label(`l${i}`, i % 7, (i * 23) % 200));
  const byKey = new Map(many.map((e) => [e.key, e]));
  const chosen = map3dLayout.placeOverlay(many, 40).map((p) => byKey.get(p.key).boxes[p.box]);
  for (let i = 0; i < chosen.length; i++) for (let j = i + 1; j < chosen.length; j++) assert.equal(map3dLayout.boxesOverlap(chosen[i], chosen[j], map3dLayout.OVERLAY_GAP), false);
  assert.ok(chosen.length >= 2 && chosen.length < 30);
});

test("map3dLayout: placeOverlay order: pinned first and always, then priority, depth and key; free entries take no room", () => {
  const spot = m3dBox(0, 0, 60, 15);
  const entries = [
    { key: "label:a02", priority: 2, depth: 1, boxes: [spot] },
    { key: "chip:0", priority: 4, depth: 8, boxes: [spot, m3dBox(0, -17, 60, 15)] },
    { key: "label:a01", pinned: true, priority: 3, depth: 20, boxes: [spot] },
    { key: "float:x", free: true, priority: 5, depth: 2, boxes: [spot] },
    { key: "badge:0,0", priority: 1, depth: 1, boxes: [m3dBox(0, -40, 18, 15)] },
  ];
  assert.deepEqual(m3dPlace(entries), ["label:a01#0", "float:x#0", "chip:0#1", "badge:0,0#0"], "the hovered label stays; the chip stacks above it; the plain label drops out");
  // The result does not depend on the input order.
  assert.deepEqual(m3dPlace([...entries].reverse()), m3dPlace(entries));
  // Two pinned labels are both kept even when they overlap.
  assert.deepEqual(m3dPlace([{ key: "b", pinned: true, priority: 3, depth: 2, boxes: [spot] }, { key: "a", pinned: true, priority: 3, depth: 1, boxes: [spot] }]), ["a#0", "b#0"]);
  // Equal priority and depth: the key breaks the tie.
  assert.deepEqual(m3dPlace([{ key: "z", priority: 2, depth: 1, boxes: [spot] }, { key: "y", priority: 2, depth: 1, boxes: [spot] }]), ["y#0"]);
  // The cap counts every placed entry (pinned and free included); an entry with no boxes is skipped.
  const row = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, priority: 2, depth: i, boxes: [m3dBox(i * 100, 0, 50, 15)] }));
  assert.equal(map3dLayout.placeOverlay(row, 4).length, 4);
  assert.deepEqual(m3dPlace([{ key: "empty", priority: 9, depth: 0, boxes: [] }, ...row.slice(0, 1)]), ["k0#0"]);
});
