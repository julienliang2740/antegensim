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
