/**
 * "How the world works": the rules of the Empyrean written for a human
 * operator, following llm_world_running_design.md (v0.7) and docs/SYSTEM.md.
 * The numbers are read from GET /api/defaults (config.default_run_request) once
 * it answers; until then (or when the backend is down) the page shows the
 * shipped defaults written below as fallbacks.  Every number is configurable
 * per run; a run's own values are on its Rules tab.
 *
 * The app uses a hash router ("#/..."), so the table of contents scrolls with
 * scrollIntoView instead of changing the hash.  "#/instructions?section=<id>"
 * is a first-class route (hooks/useHashRoute.ts) and opens the page scrolled
 * to that section (the assistant links docs sections this way).
 */

import { useEffect, type MouseEvent, type ReactNode } from "react";
import { getDefaults } from "../api/client";
import type { RunCreateRequest } from "../api/types";
import { useFetched } from "../hooks/useFetched";
import { navigate, parseHash } from "../hooks/useHashRoute";
import "../setup.css";

/** Hash of this page without a section (App.tsx routes it as { name: "instructions" }). */
export const INSTRUCTIONS_HASH = "#/instructions";

/** True for "#/instructions" with or without "?section=<id>". */
export function isInstructionsHash(hash: string): boolean {
  return parseHash(hash).name === "instructions";
}

/** Open the page at the top (a section deep link is navigate({ name: "instructions", section })). */
export function openInstructions(): void {
  navigate({ name: "instructions", section: null });
}

const SECTIONS: { id: string; title: string }[] = [
  { id: "overview", title: "The game in brief" },
  { id: "world", title: "The Empyrean" },
  { id: "agents", title: "Agents" },
  { id: "resources", title: "Compute, essence and health" },
  { id: "plants", title: "Plants" },
  { id: "actions", title: "The eleven actions" },
  { id: "skills", title: "Saved skills" },
  { id: "upgrades", title: "Upgrades" },
  { id: "conflict", title: "Attack, death, residue and absorption" },
  { id: "rounds", title: "Rounds and initiative" },
  { id: "knowledge", title: "What agents know" },
  { id: "operator", title: "What you can do as the operator" },
  { id: "assistant", title: "The assistant, Storybook and Story Mode" },
  { id: "numbers", title: "Where the numbers come from" },
];

// ---------------------------------------------------------------------------------------------
// Numbers from GET /api/defaults (fallback: the shipped defaults as text)
// ---------------------------------------------------------------------------------------------

/** "1,600", "0.0002", "12.5": up to 4 decimals, thousands separators, no trailing zeros. */
function num(value: number | undefined | null, fallback: string): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return fallback;
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 }).replace(/^-/, "−");
}

/** A fraction as a percentage: 0.2 -> "20%". */
function pct(value: number | undefined | null, fallback: string): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return fallback;
  return `${Number((value * 100).toFixed(2))}%`;
}

/** Every number the page shows, from the defaults request or the shipped fallback text. */
function pageNumbers(d: RunCreateRequest | null) {
  const r = d?.rules;
  const w = d?.world;
  const st = d?.agents?.[0]?.stats;
  const ctx = d?.context;
  const tree = r?.plant_species?.fruit_tree;
  const stages = tree?.stages ?? [];
  const disc = r?.skills.action_discount;
  const price = (key: keyof NonNullable<typeof r>["prices"], fallback: number) => r?.prices[key] ?? fallback;
  const inSkill = (value: number) => num(value * (disc ?? 0.8), String(Number((value * 0.8).toFixed(4))));
  const up = r?.upgrades;
  const sBase = up?.standard_base_compute ?? 25;
  const sEss = up?.standard_base_essence ?? 2;
  const sGrowth = up?.standard_growth ?? 2;
  const aBase = up?.attack_base_compute ?? 100;
  const aEss = up?.attack_base_essence ?? 10;
  const aGrowth = up?.attack_growth ?? 4;
  const cBase = up?.attack_cap_base_compute ?? 100;
  const cEss = up?.attack_cap_base_essence ?? 10;
  const cGrowth = up?.attack_cap_growth ?? 4;
  const inputRate = r?.cognition.input_rate ?? 0.0002;
  const genRate = r?.cognition.generation_rate ?? 0.001;
  const absorbPrice = price("absorb", 3);
  const fruitEnergy = tree?.fruit_energy ?? 60;
  const computeAbs = st?.compute_absorption ?? 0.2;
  const essenceAbs = st?.essence_absorption ?? 0.1;
  const upkeep = r?.upkeep.compute_per_round ?? 1;
  const starve = r?.upkeep.starvation_health_loss ?? 5;
  const health = st?.health ?? 100;
  const essenceResidue = r?.death.essence_residue_fraction ?? 0.4;
  const computeResidue = r?.death.compute_residue_fraction ?? 0.5;
  const move = price("move", 5);
  return {
    loaded: d !== null,
    regionX: `${num(w?.region.min_x, "−10")} to ${num(w?.region.max_x, "10")}`,
    regionSize: w ? `${w.region.max_x - w.region.min_x + 1} × ${w.region.max_y - w.region.min_y + 1}` : "21 × 21",
    mountainClusters: num(w?.terrain.mountain_clusters, "4"),
    mountainSize: num(w?.terrain.mountain_cluster_size, "4"),
    waterClusters: num(w?.terrain.water_clusters, "3"),
    waterSize: num(w?.terrain.water_cluster_size, "5"),
    clearRadius: num(w?.terrain.keep_origin_clear_radius, "2"),
    compute: num(st?.compute, "200"),
    essence: `${num(st?.essence, "20")} / ${num(st?.essence_capacity, "100")}`,
    health: `${num(st?.health, "100")} / ${num(st?.max_health, "100")}`,
    attack: num(st?.attack, "1"),
    attackCap: num(st?.attack_cap, "50"),
    attackCapBudget: num((st?.attack_cap ?? 50) / (st?.attack && st.attack > 0 ? st.attack : 1), "50"),
    speed: num(st?.speed, "1"),
    ranges: `${num(st?.vision_range, "0")} / ${num(st?.communication_range, "0")}`,
    absorption: `${pct(st?.compute_absorption, "20%")} / ${pct(st?.essence_absorption, "10%")}`,
    computeAbs: pct(st?.compute_absorption, "20%"),
    essenceAbs: pct(st?.essence_absorption, "10%"),
    skillLimits: `${num(st?.skill_count_limit, "5")} / ${num(st?.skill_block_limit, "100")}`,
    skillCount: num(st?.skill_count_limit, "5"),
    skillBlocks: num(st?.skill_block_limit, "100"),
    cards: num(d?.agents?.length, "8"),
    messageTokens: num(r?.messages.max_message_tokens, "256"),
    messageChars: r ? num(r.messages.max_message_tokens * r.messages.chars_per_token, "1,024") : "1,024",
    inputRate: num(inputRate, "0.0002"),
    genRate: num(genRate, "0.001"),
    exampleIn: num(5000 * inputRate, "1"),
    exampleOut: num(600 * genRate, "0.6"),
    exampleTotal: num(5000 * inputRate + 600 * genRate, "1.6"),
    mind: num(r?.cognition.default_mind_multiplier, "1"),
    perOp: num(r?.skills.interpreter_cost_per_op, "0.01"),
    upkeep: num(upkeep, "1"),
    starve: num(starve, "5"),
    starveHealth: num(health, "100"),
    starveRounds: starve > 0 ? num(Math.ceil(health / starve), "20") : "20",
    healPerCompute: num(r?.recovery.health_per_compute, "1"),
    stages: [0, 1, 2].map((i) => {
      const g = stages[i];
      const fb = [
        ["Sprout", "0", "2", "0.2", "60", "10", "none", "none"],
        ["Sapling", "5", "6", "0.5", "120", "25", "every 8 rounds", "none"],
        ["Mature", "15", "12", "1", "180", "60", "every 5 rounds", "every 20 rounds"],
      ][i];
      if (!g) return fb;
      const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
      return [
        cap(g.name),
        num(g.min_age_rounds, fb[1]),
        num(g.energy_inflow_per_round, fb[2]),
        num(g.essence_inflow_per_round, fb[3]),
        num(g.max_energy, fb[4]),
        num(g.max_essence, fb[5]),
        g.fruit_interval_rounds > 0 ? `every ${num(g.fruit_interval_rounds, "")} rounds` : "none",
        g.seed_interval_rounds > 0 ? `every ${num(g.seed_interval_rounds, "")} rounds` : "none",
      ];
    }),
    fruitEnergy: num(fruitEnergy, "60"),
    maxFruit: num(tree?.max_fruit, "3"),
    fruitGain: num(fruitEnergy * computeAbs, "12"),
    fruitNet: num(fruitEnergy * computeAbs - absorbPrice, "9"),
    seedRadius: num(tree?.seed_dispersal_radius, "1"),
    maxSeeds: num(tree?.max_seeds_alive, "2"),
    germination: num(tree?.seed_germination_delay_rounds, "10"),
    seedEssence: num(tree?.initial_essence, "5"),
    plantResidue: pct(tree?.essence_residue_fraction, "50%"),
    initialPlants: num(w?.initial_plants?.fruit_tree, "12"),
    initialFruit: num(w?.initial_plant_fruit, "1"),
    prices: {
      move: [num(move, "5"), inSkill(move)],
      observe: [num(price("observe", 0.5), "0.5"), inSkill(price("observe", 0.5))],
      query: [num(price("query", 0.5), "0.5"), inSkill(price("query", 0.5))],
      send: [num(price("send", 0.5), "0.5"), inSkill(price("send", 0.5))],
      broadcast: [num(price("broadcast", 2), "2"), inSkill(price("broadcast", 2))],
      absorb: [num(absorbPrice, "3"), inSkill(absorbPrice)],
      transfer: [num(price("transfer", 1), "1"), inSkill(price("transfer", 1))],
      wait: [num(price("wait", 0), "0"), inSkill(price("wait", 0))],
    },
    pageSize: num(w?.max_entities_per_observation_page, "40"),
    feeCap: num(r?.accounting.failure_fee_cap, "1"),
    discountPct: pct(disc !== undefined ? 1 - disc : undefined, "20%"),
    skillPct: pct(disc, "80%"),
    maxOps: num(r?.skills.max_ops_per_turn, "100"),
    maxSource: num(r?.skills.max_source_chars, "4,000"),
    skillMove: inSkill(move),
    skillWalk: num(3 * move * (disc ?? 0.8), "12"),
    directWalk: num(3 * move, "15"),
    attackExampleSkill: num(10 * (disc ?? 0.8), "8"),
    std: `${num(sBase, "25")} × ${num(sGrowth, "2")}ⁿ compute + ${num(sEss, "2")} × ${num(sGrowth, "2")}ⁿ essence`,
    att: `${num(aBase, "100")} × ${num(aGrowth, "4")}ⁿ compute + ${num(aEss, "10")} × ${num(aGrowth, "4")}ⁿ essence`,
    stdSteps: [0, 1, 2].map((n) => `${num(sBase * sGrowth ** n, "")} + ${num(sEss * sGrowth ** n, "")}`),
    attSteps: [0, 1, 2].map((n) => `${num(aBase * aGrowth ** n, "")} + ${num(aEss * aGrowth ** n, "")}`),
    capSteps: [0, 1, 2].map((n) => `${num(cBase * cGrowth ** n, "")} + ${num(cEss * cGrowth ** n, "")}`),
    firstUpgradeMoves: move > 0 ? num(sBase / move, "five") : "five",
    increments: (name: string, fallback: string) => num(up?.increments?.[name], fallback),
    incrementPct: (name: string, fallback: string) => pct(up?.increments?.[name], fallback),
    essenceResidue: pct(essenceResidue, "40%"),
    computeResidue: pct(computeResidue, "50%"),
    residueExampleE: num(100 * essenceResidue, "40"),
    residueExampleC: num(80 * computeResidue, "40"),
    residueGainE: num(100 * essenceResidue * essenceAbs, "4"),
    residueGainC: num(80 * computeResidue * computeAbs, "8"),
    absorbFee: num(absorbPrice, "3"),
    cap: num(ctx?.input_token_cap, "6,000"),
    gen: num(ctx?.generation_allowance, "1,000"),
    history: num(ctx?.recent_history_length, "5"),
    notebook: num(ctx?.notebook_max_tokens, "400"),
    memories: num(ctx?.retrieved_memory_limit, "5"),
    digest: num(ctx?.new_event_digest_limit, "10"),
  };
}

function scrollToSection(event: MouseEvent, id: string) {
  event.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function Section(props: { id: string; children: ReactNode }) {
  const title = SECTIONS.find((s) => s.id === props.id)?.title ?? props.id;
  return (
    <section className="doc-section" id={props.id} aria-labelledby={`${props.id}-title`}>
      <div className="doc-section-head">
        <h2 id={`${props.id}-title`}>{title}</h2>
        <a href={INSTRUCTIONS_HASH} className="doc-top-link" onClick={(e) => scrollToSection(e, "contents")}>
          Back to contents
        </a>
      </div>
      {props.children}
    </section>
  );
}

export function InstructionsPage(props: { section?: string | null }) {
  const section = props.section ?? null;
  const defaults = useFetched("defaults:8", () => getDefaults(8));
  const N = pageNumbers(defaults.data);
  useEffect(() => {
    document.title = "How the world works · Empyrean";
  }, []);
  // Open at the linked section (or the top); runs again when a link names another section.
  useEffect(() => {
    const target = section ? document.getElementById(section) : null;
    if (target) target.scrollIntoView({ block: "start" });
    else window.scrollTo(0, 0);
  }, [section]);

  return (
    <div className="page doc-page">
      <header className="doc-header">
        <button type="button" className="btn" onClick={() => navigate({ name: "entry" })}>
          ← Back
        </button>
        <div>
          <h1>How the world works</h1>
          <p className="doc-lead">
            The rules of the Empyrean, the world your agents live in. Numbers are the defaults of this backend
            {N.loaded ? " (read from it just now)" : " (shipped defaults; the backend has not answered yet)"}; every one of them can be changed per run, and a
            run's own values are on its Rules tab.
          </p>
        </div>
      </header>

      <nav className="doc-toc" id="contents" aria-label="Contents">
        <h2>Contents</h2>
        <ol>
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={INSTRUCTIONS_HASH} onClick={(e) => scrollToSection(e, s.id)}>
                {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <Section id="overview">
        <p>
          The Empyrean is a small artificial-life world whose inhabitants are LLM agents. Each agent is a point on a grid with three resources:
          <strong> compute</strong>, <strong>essence</strong> and <strong>health</strong>. On its turn, an agent's model is shown what the agent knows and
          replies with one decision: one action (or a saved skill to run), plus optional notes and new skills.
        </p>
        <p>
          Thinking costs compute, acting costs compute, and staying alive costs compute. New compute enters the world only through plants, which grow fruit from
          an outside source. An agent with no compute starves; an agent at zero health dies.
        </p>
        <p>
          Nothing else is scripted. There are no goals, factions, jobs or tech tree: agents decide what to pursue, and the engine enforces the rules and keeps
          an exact account of every resource. You watch, inspect every decision the agents made, and can intervene at any turn.
        </p>
      </Section>

      <Section id="world">
        <p>
          The Empyrean is the only realm in this prototype. It is a flat grid of integer coordinates <code>(x, y)</code>. The default region runs from {N.regionX}
          on both axes ({N.regionSize} points); a move that would leave the region is refused.
        </p>
        <p>
          <strong>Unlimited co-location.</strong> Agents are points, not bodies. Any number of agents, plants, fruit and residue can share one point without
          collision or crowding. Because many things can share a point, actions target entities by id, not by position.
        </p>
        <p>Every point has one of three terrains:</p>
        <table className="data-table doc-table">
          <thead>
            <tr>
              <th>Terrain</th>
              <th>Movement</th>
              <th>Plants</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Land</td>
              <td>Normal movement.</td>
              <td>Plants grow and seeds germinate.</td>
            </tr>
            <tr>
              <td>Mountain</td>
              <td>Impassable. A move into a mountain fails and the agent stays where it was. No skill, speed or upgrade crosses a mountain.</td>
              <td>Nothing.</td>
            </tr>
            <tr>
              <td>Water</td>
              <td>Walkable at the ordinary move price; no special ability needed.</td>
              <td>Nothing grows on water and seeds never germinate there.</td>
            </tr>
          </tbody>
        </table>
        <p>
          The terrain is generated from the run's seed: by default {N.mountainClusters} mountain clusters of about {N.mountainSize} points, {N.waterClusters} water clusters of about{" "}
          {N.waterSize} points, and a clear area within {N.clearRadius} steps of the origin. The same seed and setup always give the same world. There is no day or night; time is counted in rounds, and slow model
          calls never advance it.
        </p>
      </Section>

      <Section id="agents">
        <p>
          An agent is an ongoing process: an identity, stats and resources, a private notebook, memories of what happened to it, and the skills it has saved.
          Each decision is one call to the agent's model (the model on its card, else the run default). A card can also give the agent a persona, a starting
          notebook and starting skills.
        </p>
        <p>
          By default a short <strong>persona tip</strong> follows every persona: it reminds the agent that a repeated routine can be saved as a skill that
          costs no thinking while it runs, and that other agents are options too (message them, give them compute, attack them, absorb what the dead leave).
          It names options, never goals. Without it, agents mostly forage alone. The New session form can switch it off, and a card can override it.
        </p>
        <h3>Local knowledge</h3>
        <ul>
          <li>
            <strong>Vision range starts at 0.</strong> An agent sees only the entities at its own point. Observing or querying anything farther away needs
            vision upgrades. Distances are Manhattan distances (|dx| + |dy|).
          </li>
          <li>
            <strong>Communication range starts at 0.</strong> An agent can send a message to one agent at its own point, or broadcast to everyone at its point.
            Reaching farther needs communication upgrades, which are separate from vision.
          </li>
          <li>
            <strong>Unknown-source reception.</strong> A message can reach an agent that cannot see the sender. The recipient then gets it from an "unknown"
            source. A name written inside a message is just text; nothing verifies it.
          </li>
          <li>
            <strong>Private state stays private.</strong> Sharing a point does not reveal another agent's notebook, memories, skills or balances. Querying
            another agent shows only its id, name, position, health, max health, attack, attack cap, speed and whether it is alive.
          </li>
          <li>
            Messages are limited to {N.messageTokens} tokens (about {N.messageChars} characters). A longer message fails.
          </li>
        </ul>
        <h3>Starting values of a default card</h3>
        <table className="data-table doc-table">
          <thead>
            <tr>
              <th>Stat</th>
              <th>Default</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Compute</td>
              <td>{N.compute}</td>
              <td>Spendable energy; no upper limit.</td>
            </tr>
            <tr>
              <td>Essence / capacity</td>
              <td>{N.essence}</td>
              <td>Held essence and the most it can hold.</td>
            </tr>
            <tr>
              <td>Health / max health</td>
              <td>{N.health}</td>
              <td>Zero health is death.</td>
            </tr>
            <tr>
              <td>Attack</td>
              <td>{N.attack}</td>
              <td>Damage per unit of compute committed to an attack.</td>
            </tr>
            <tr>
              <td>Attack cap</td>
              <td>{N.attackCap}</td>
              <td>The most damage one attack can deal. A stronger target needs several hits.</td>
            </tr>
            <tr>
              <td>Speed</td>
              <td>{N.speed}</td>
              <td>Higher speed resolves earlier in each round: the faster agent gets a contested fruit or strikes first.</td>
            </tr>
            <tr>
              <td>Vision / communication range</td>
              <td>{N.ranges}</td>
              <td>Own point only.</td>
            </tr>
            <tr>
              <td>Compute / essence absorption</td>
              <td>{N.absorption}</td>
              <td>Share of absorbed compute or essence the agent keeps.</td>
            </tr>
            <tr>
              <td>Skill count / blocks per skill</td>
              <td>{N.skillLimits}</td>
              <td>How many skills it can save and how big each can be.</td>
            </tr>
          </tbody>
        </table>
        <p>A run has 6 to 64 agents. The New session page prefills {N.cards} cards; any value on a card can be changed.</p>
      </Section>

      <Section id="resources">
        <h3>Compute: energy for thinking, acting and living</h3>
        <p>Compute is one balance that pays for everything:</p>
        <p className="doc-formula">total compute spent = cognition + world actions + interpreter work + upkeep</p>
        <ul>
          <li>
            <strong>Cognition</strong> is thinking: mind multiplier × ({N.inputRate} × input tokens + {N.genRate} × output tokens). A 5,000-token prompt with a
            600-token reply costs {N.exampleIn} + {N.exampleOut} = {N.exampleTotal} compute. The mind multiplier is {N.mind} for every model by default. If a call costs more than the agent has, the balance goes to
            0 and the rest is recorded as uncharged.
          </li>
          <li>
            <strong>World actions</strong> have prices; see <em>The eleven actions</em>.
          </li>
          <li>
            <strong>Interpreter work</strong> is {N.perOp} compute per step when a saved skill runs.
          </li>
          <li>
            <strong>Upkeep</strong> is {N.upkeep} compute per round, taken at the end of the round.
          </li>
        </ul>
        <p>
          An agent with no compute cannot act or think, but time goes on. If it cannot pay its full upkeep, it pays what it has and loses {N.starve} health. An agent at{" "}
          {N.starveHealth} health with no compute and no help dies after {N.starveRounds} rounds. Compute cannot go negative.
        </p>
        <p>
          In-world compute is not money. Real provider costs are a separate ledger; set a real budget in USD on the New session page to stop a run when it is
          reached. The fake models are free and deterministic.
        </p>
        <h3>Essence: the currency of growth</h3>
        <p>
          Essence is a separate resource held up to the agent's essence capacity. It is spent on upgrades. Having zero essence is harmless. Raising the capacity
          adds no essence. Fruit contains no essence; essence comes from killing plants or from the residue of the dead.
        </p>
        <h3>Health: life</h3>
        <p>
          Damage and starvation reduce health. At 0 the agent dies at once; remaining compute does not save it and death cannot be undone. Raising max health
          does not heal. <code>recover(budget)</code> turns compute into health at {N.healPerCompute} health per compute, never past the maximum.
        </p>
      </Section>

      <Section id="plants">
        <p>
          A plant is a channel from an ultimate source outside the world. Every round, each living plant on land receives energy and essence from that source.
          This is the only way new resources enter the world. More plants mean more inflow; there is no world-wide cap.
        </p>
        <h3>Growth stages of the default species, fruit_tree</h3>
        <table className="data-table doc-table">
          <thead>
            <tr>
              <th>Stage</th>
              <th>From age</th>
              <th>Inflow per round</th>
              <th>Store limit (energy / essence)</th>
              <th>Fruit</th>
              <th>Seeds</th>
            </tr>
          </thead>
          <tbody>
            {N.stages.map((row) => (
              <tr key={row[0]}>
                <td>{row[0]}</td>
                <td>{row[1]} rounds</td>
                <td>
                  {row[2]} energy, {row[3]} essence
                </td>
                <td>
                  {row[4]} / {row[5]}
                </td>
                <td>{row[6]}</td>
                <td>{row[7]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul>
          <li>
            <strong>Fruit</strong> is a separate entity at the plant's point holding {N.fruitEnergy} compute, paid from the plant's energy store. A plant has at
            most {N.maxFruit} fruit at a time. Fruit stays until someone absorbs it. At {N.computeAbs} absorption an agent gains {N.fruitGain} compute from a
            fruit and pays a {N.absorbFee}-compute fee: {N.fruitNet} net.
          </li>
          <li>
            <strong>Seeds</strong> drop on land within {N.seedRadius} step of a mature plant, at most {N.maxSeeds} alive per plant. A seed becomes a sprout
            after {N.germination} rounds with {N.seedEssence} essence supplied by the source.
          </li>
          <li>
            <strong>Essence only by killing.</strong> A living plant's essence cannot be absorbed. Attacking a plant reduces its living essence; when it reaches
            0 the plant dies and {N.plantResidue} of the essence it had just before the killing blow is left as residue. Its stored energy is lost. A dead plant never fruits
            again, so agents choose between a lasting food source and a one-time gain of essence.
          </li>
          <li>
            <strong>At the start</strong> the world has {N.initialPlants} mature fruit trees with {N.initialFruit} ripe fruit each. The first ones stand on the agents' start points, so an
            agent that sees only its own point can still find food; the rest are placed at random on land.
          </li>
        </ul>
        <p>Species, stages and all their numbers are editable on the New session page and in god mode.</p>
      </Section>

      <Section id="actions">
        <p>
          On each turn an agent performs exactly one action. The price is in compute and comes on top of the cognition spent deciding. The last column is the
          price when the action runs inside a saved skill.
        </p>
        <table className="data-table doc-table doc-actions">
          <thead>
            <tr>
              <th>Action</th>
              <th>What it does</th>
              <th>Price</th>
              <th>In a skill</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>move(direction)</code>
              </td>
              <td>One step: "up" (y+1), "down" (y−1), "left" (x−1) or "right" (x+1). No diagonals.</td>
              <td>{N.prices.move[0]}</td>
              <td>{N.prices.move[1]}</td>
            </tr>
            <tr>
              <td>
                <code>observe(point)</code>
              </td>
              <td>Lists the terrain and the entities (id, kind, position) at one point within vision range, {N.pageSize} per page.</td>
              <td>{N.prices.observe[0]}</td>
              <td>{N.prices.observe[1]}</td>
            </tr>
            <tr>
              <td>
                <code>query(entity)</code>
              </td>
              <td>
                Details of one visible entity. <code>query(self)</code> returns the agent's exact stats, prices and upgrade quotes.
              </td>
              <td>{N.prices.query[0]}</td>
              <td>{N.prices.query[1]}</td>
            </tr>
            <tr>
              <td>
                <code>send(recipient, message)</code>
              </td>
              <td>A message to one visible agent within communication range.</td>
              <td>{N.prices.send[0]}</td>
              <td>{N.prices.send[1]}</td>
            </tr>
            <tr>
              <td>
                <code>broadcast(message)</code>
              </td>
              <td>A message to every agent within communication range.</td>
              <td>{N.prices.broadcast[0]}</td>
              <td>{N.prices.broadcast[1]}</td>
            </tr>
            <tr>
              <td>
                <code>absorb(source, resource)</code>
              </td>
              <td>Takes the most it can of "compute" or "essence" from fruit or residue at the same point.</td>
              <td>{N.prices.absorb[0]}</td>
              <td>{N.prices.absorb[1]}</td>
            </tr>
            <tr>
              <td>
                <code>transfer(recipient, resource, amount)</code>
              </td>
              <td>Gives compute or essence to a living agent at the same point. The amount is sent in full, plus the fee.</td>
              <td>{N.prices.transfer[0]}, plus the amount given</td>
              <td>{N.prices.transfer[1]}, plus the amount</td>
            </tr>
            <tr>
              <td>
                <code>recover(budget)</code>
              </td>
              <td>Turns compute into health, {N.healPerCompute} health per compute, only as much as is missing.</td>
              <td>the useful budget</td>
              <td>{N.skillPct} of it</td>
            </tr>
            <tr>
              <td>
                <code>attack(target, budget)</code>
              </td>
              <td>Deals attack × budget damage, at most the attack cap, to an agent or plant at the same point.</td>
              <td>the budget, cut to attack cap ÷ attack</td>
              <td>{N.skillPct} of it</td>
            </tr>
            <tr>
              <td>
                <code>upgrade(attribute)</code>
              </td>
              <td>
                Buys one step of a stat; see <em>Upgrades</em>.
              </td>
              <td>compute + essence</td>
              <td>{N.skillPct} of the compute</td>
            </tr>
            <tr>
              <td>
                <code>wait(rounds)</code>
              </td>
              <td>Skips this turn and the next rounds − 1 turns. Upkeep still applies.</td>
              <td>{N.prices.wait[0]}</td>
              <td>{N.prices.wait[1]}</td>
            </tr>
          </tbody>
        </table>
        <p>Instead of an action, a decision can run one of the agent's saved skills.</p>
        <h3>Ranges and failures</h3>
        <ul>
          <li>
            <code>absorb</code>, <code>transfer</code> and <code>attack</code> need the target at the same point. <code>observe</code> and <code>query</code>{" "}
            use vision range. <code>send</code> and <code>broadcast</code> use communication range.
          </li>
          <li>If an agent cannot afford an action, it fails at no charge.</li>
          <li>
            If it can afford it but the action fails anyway (a mountain, out of range, target gone, stat at its limit), it pays a small attempt fee of {N.feeCap} compute
            or the action price if lower. The turn is used either way.
          </li>
          <li>
            Every action returns the same record: <code>ok</code>, <code>reason</code>, <code>cost_compute</code>, <code>cost_essence</code>, <code>round</code>
            , <code>data</code> and <code>effects</code>.
          </li>
        </ul>
      </Section>

      <Section id="skills">
        <p>
          Agents can write small programs, save them under a name and run them later. A skill may use the actions above and the blocks below; it cannot touch
          the world in any other way. Skills are checked when saved, and an invalid one is rejected (the compute spent writing it is not refunded).
        </p>
        <table className="data-table doc-table">
          <thead>
            <tr>
              <th>Block</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>SET name = expression</code>
              </td>
              <td>Store a value; an action stores its result record.</td>
            </tr>
            <tr>
              <td>
                <code>IF condition … ELSE … END</code>
              </td>
              <td>Branch; ELSE is optional.</td>
            </tr>
            <tr>
              <td>
                <code>REPEAT count … END</code>
              </td>
              <td>Repeat a fixed number of times.</td>
            </tr>
            <tr>
              <td>
                <code>FOR_EACH item IN list … END</code>
              </td>
              <td>Go through a list the agent already has, such as the entities of an observation.</td>
            </tr>
            <tr>
              <td>
                <code>CALL skill(arguments) INTO name</code>
              </td>
              <td>Run another saved skill and keep its return value.</td>
            </tr>
            <tr>
              <td>
                <code>RETURN expression</code> / <code>STOP</code>
              </td>
              <td>End this skill with a value / end this skill and every skill that called it.</td>
            </tr>
          </tbody>
        </table>
        <p>
          Expressions allow numbers, strings, true/false, variables, fields such as <code>result.ok</code>, points <code>(x, y)</code>, arithmetic, comparisons
          and AND / OR / NOT. <code>self</code> and <code>here</code> (the current point) are always available.
        </p>
        <h3>The {N.discountPct} discount</h3>
        <p>
          Every action executed from a saved skill pays {N.skillPct} of its compute price. The discount applies once, even when skills call other skills. It does not
          reduce model costs, interpreter work, upkeep, essence prices or amounts transferred, and it does not weaken effects: an attack budget of 10 costs {N.attackExampleSkill} in
          a skill and still deals attack × 10 damage.
        </p>
        <h3>One action per turn</h3>
        <p>
          A skill runs its local logic until it reaches an action, performs that one action on the agent's turn, and resumes on the next turn. While a skill is
          running the agent does not call its model, so a running skill also saves cognition. Each turn allows at most {N.maxOps} interpreter steps at {N.perOp} compute
          each.
        </p>
        <p>Example: walk three points up, stopping if a move fails.</p>
        <pre className="doc-code">
          {`REPEAT 3
    SET step = move("up")
    IF step.ok == false
        RETURN step.reason
    END
END
RETURN "completed"`}
        </pre>
        <p>
          Run as a skill, this takes three turns and costs 3 × {N.skillMove} = {N.skillWalk} compute for the moves plus a few interpreter steps, and one model
          call to start it. Three direct moves cost {N.directWalk} compute and three model calls.
        </p>
        <p>
          Limits: {N.skillCount} saved skills of at most {N.skillBlocks} blocks each (both upgradeable), no recursion, at most {N.maxSource} characters of
          source per skill.
        </p>
      </Section>

      <Section id="upgrades">
        <p>
          <code>upgrade(attribute)</code> buys one step of one stat. Each attribute keeps its own purchase count n, and its price doubles with every purchase:{" "}
          <strong>{N.std}</strong>. Attack is dearer and grows faster: <strong>{N.att}</strong>. Inside a skill the compute part is {N.skillPct}; the
          essence part never changes.
        </p>
        <table className="data-table doc-table">
          <thead>
            <tr>
              <th>Attribute</th>
              <th>Each purchase adds</th>
              <th>1st</th>
              <th>2nd</th>
              <th>3rd</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["essence_capacity", `+${N.increments("essence_capacity", "20")} capacity (no essence added)`],
              ["max_health", `+${N.increments("max_health", "20")} max health (no healing)`],
              ["vision_range", `+${N.increments("vision_range", "1")} point of vision`],
              ["communication_range", `+${N.increments("communication_range", "1")} point of reach`],
              ["speed", `+${N.increments("speed", "1")} speed`],
              ["compute_absorption", `+${N.incrementPct("compute_absorption", "5%")} (percentage points), up to 100%`],
              ["essence_absorption", `+${N.incrementPct("essence_absorption", "5%")} (percentage points), up to 100%`],
              ["skill_count_limit", `+${N.increments("skill_count_limit", "1")} saved skill`],
              ["skill_block_limit", `+${N.increments("skill_block_limit", "20")} blocks per skill`],
            ].map(([name, adds]) => (
              <tr key={name}>
                <td>
                  <code>{name}</code>
                </td>
                <td>{adds}</td>
                <td>{N.stdSteps[0] || "25 + 2"}</td>
                <td>{N.stdSteps[1] || "50 + 4"}</td>
                <td>{N.stdSteps[2] || "100 + 8"}</td>
              </tr>
            ))}
            <tr>
              <td>
                <code>attack</code>
              </td>
              <td>+{N.increments("attack", "0.25")} attack</td>
              <td>{N.attSteps[0] || "100 + 10"}</td>
              <td>{N.attSteps[1] || "400 + 40"}</td>
              <td>{N.attSteps[2] || "1,600 + 160"}</td>
            </tr>
            <tr>
              <td>
                <code>attack_cap</code>
              </td>
              <td>+{N.increments("attack_cap", "25")} damage per attack</td>
              <td>{N.capSteps[0] || "100 + 10"}</td>
              <td>{N.capSteps[1] || "400 + 40"}</td>
              <td>{N.capSteps[2] || "1,600 + 160"}</td>
            </tr>
          </tbody>
        </table>
        <p className="hint">Prices are compute + essence. A first upgrade costs as much compute as {N.firstUpgradeMoves} moves.</p>
        <p>
          <code>query(self)</code> shows the current quote for every attribute. A stat at its hard limit returns <code>at_limit</code> and changes nothing.
          Movement distance, action prices and upkeep cannot be upgraded.
        </p>
      </Section>

      <Section id="conflict">
        <h3>Attack</h3>
        <p>
          <code>attack(target, budget)</code> deals <strong>attacker's attack × budget</strong> damage, <strong>at most the attacker's attack cap</strong> (
          {N.attackCap} damage per hit to start). With attack 1, a budget of 10 deals 10 damage and costs 10 compute ({N.attackExampleSkill} in a skill). A budget
          above attack cap ÷ attack ({N.attackCapBudget} to start) is cut to it, and only the cut budget is charged. A target with more health than the cap needs
          several hits, so it gets turns in between to flee, recover or strike back. There is no armor or automatic counterattack. The target must be visible and at
          the same point. The attack cap can be upgraded like attack, and just as steeply.
        </p>
        <h3>Death and residue</h3>
        <p>
          An agent at 0 health dies immediately.{" "}
          <strong>
            {N.essenceResidue} of its essence and {N.computeResidue} of its compute
          </strong>{" "}
          stay at its point as a residue entity; the rest is
          lost. Residue does not decay by default. The killer gets nothing automatically; anyone at the point can absorb the residue. A killed plant leaves {N.plantResidue}
          of its last living essence as residue.
        </p>
        <h3>Absorption</h3>
        <p>
          <code>absorb(source, resource)</code> has no amount. It processes the most it can, and the agent keeps only its absorption efficiency ({N.computeAbs} for
          compute, {N.essenceAbs} for essence at the start). The rest is destroyed; absorbing again cannot recover it.
        </p>
        <ul>
          <li>Compute: all available compute in the source is processed.</li>
          <li>Essence: only as much residue as fills the agent's free capacity is processed; the rest stays for later.</li>
          <li>An empty source, or no free essence capacity, fails instead of destroying anything.</li>
        </ul>
        <p>
          Example: an agent dies holding 100 essence and 80 compute. Its residue holds {N.residueExampleE} essence and {N.residueExampleC} compute. A second
          agent with {N.essenceAbs} essence absorption processes the {N.residueExampleE} essence and gains {N.residueGainE}. With {N.computeAbs} compute
          absorption it processes the {N.residueExampleC} compute and gains {N.residueGainC}, minus the {N.absorbFee}-compute fee.
        </p>
      </Section>

      <Section id="rounds">
        <ul>
          <li>
            <strong>One turn per round.</strong> Every living agent gets exactly one turn each round. Speed decides the order, highest first; ties are broken by
            a shuffle drawn from the run's seed, so runs are reproducible. Speed never grants extra turns, and a speed upgrade counts from the next round.
          </li>
          <li>
            <strong>Everyone decides at once.</strong> At the start of a round every agent that will think gets its decision packet, built from what it knows
            at that moment, and all the model calls run at the same time, so a round takes about as long as one call. Nobody sees what the others chose.
          </li>
          <li>
            <strong>A turn.</strong> The decisions then resolve one agent at a time in speed order. If a skill is running, it continues to its next action. If
            the agent is waiting, the turn passes. Otherwise its round decision is checked against the world as the faster agents left it and applied: if a
            faster agent already took the fruit, moved away or killed the target, the action fails (<code>empty_source</code>, <code>target_gone</code>,{" "}
            <code>out_of_range</code>). An agent killed before its turn does not act. Messages and damage from this round reach an agent at its next decision.
          </li>
          <li>
            <strong>Round end.</strong> After the last turn: plants grow and take in source inflow, fruit and seeds appear, seeds germinate, residue decays (off
            by default), upkeep is paid or starvation damage applied, and deaths are resolved.
          </li>
          <li>Agents placed by the operator during a round join from the next round. Every turn is saved as a checkpoint, which is what the timeline shows.</li>
          <li>A run finishes when no agent is alive or the maximum number of rounds (if set) is reached.</li>
        </ul>
      </Section>

      <Section id="knowledge">
        <p>
          An agent knows only what reached it: its action results, the observations and queries it paid for, messages, damage it took and the operator's voice.
          Each of these is a record stamped with its round.
        </p>
        <ul>
          <li>
            <strong>Observations are snapshots.</strong> An observation from round 12 says what was at that point in round 12. Others move, eat fruit and die in
            the meantime. The engine re-checks everything when an action happens, so acting on stale knowledge simply fails.
          </li>
          <li>
            <strong>Its own stats are a belief.</strong> The packet shows the agent's last <code>query(self)</code> plus the changes it was told about since
            (its own costs, damage, transfers). Upkeep is not reported unless it starves, so the belief drifts. <code>query(self)</code> costs 1 compute and
            returns exact values, prices and upgrade quotes.
          </li>
          <li>
            <strong>Events wait for the next decision.</strong> Messages and damage are read at the agent's next decision. Receiving them costs no action and
            does not trigger an extra turn.
          </li>
        </ul>
        <h3>The decision packet</h3>
        <p>
          Each model call receives the rules, the agent's skill list, its believed state, its last result and a digest of unread events. What room remains goes
          to the full unread events, the notebook, recent history and the most relevant memories.
        </p>
        <table className="data-table doc-table">
          <thead>
            <tr>
              <th>Context setting</th>
              <th>Default</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Input token cap</td>
              <td>{N.cap} tokens</td>
            </tr>
            <tr>
              <td>Generation allowance</td>
              <td>{N.gen} tokens</td>
            </tr>
            <tr>
              <td>Recent history</td>
              <td>last {N.history} decisions</td>
            </tr>
            <tr>
              <td>Notebook</td>
              <td>up to {N.notebook} tokens</td>
            </tr>
            <tr>
              <td>Retrieved memories</td>
              <td>{N.memories}</td>
            </tr>
            <tr>
              <td>Unread events in the digest</td>
              <td>{N.digest}</td>
            </tr>
          </tbody>
        </table>
        <p>
          A decision contains a thought, optional notebook changes, skills to save or delete, memories to keep in mind, and one action. You can read the exact
          packet and the model's reply for every turn in the run's turn record.
        </p>
      </Section>

      <Section id="operator">
        <h3>Run controls</h3>
        <p>
          A run always opens paused. <strong>Advance 1 turn</strong> plays one agent's turn, <strong>Finish round</strong> plays to the end of the round, and{" "}
          <strong>Start simulation</strong> / <strong>Pause simulation</strong> run continuously with the play delay between turns. The timeline goes back to any saved turn so you can
          inspect it. Under Start replay at, choose a round and turn, then use Play from selected turn to watch saved actions through the latest saved round. Play from beginning starts at the first checkpoint; playback never generates new turns.
        </p>
        <h3>God mode</h3>
        <p>
          God-mode edits are staged, then applied in order at the next turn boundary. Nobody is charged, and each edit is recorded with its before and after
          values.
        </p>
        <ul>
          <li>
            <strong>Voice from nowhere:</strong> a message to all living agents, to chosen agents, or to everyone at a point. Agents receive it from an unknown
            source.
          </li>
          <li>
            <strong>Change the world:</strong> set any stat of an entity; place or remove agents, plants, fruit, seeds and residue.
          </li>
          <li>
            <strong>Change minds:</strong> add or remove an agent's knowledge records, or replace its notebook.
          </li>
          <li>
            <strong>Change the rules:</strong> plant species, action prices, models (run default or per agent), context settings, max rounds, real budget and
            play delay.
          </li>
        </ul>
        <h3>Editing files</h3>
        <p>
          Each run keeps its current checkpoint as JSON files in a <code>working/</code> folder; god mode shows the path. Pause, edit the files, then press{" "}
          <strong>Reload working/ files</strong>. Invalid files are reported and nothing changes. Valid changes are staged as one edit and applied like any
          other.
        </p>
        <h3>Continuations</h3>
        <p>
          To change the past, go to a saved turn and use <strong>Create continuation from turn …</strong> in god mode. It creates a new run that starts from
          that checkpoint; the original run and its later turns stay untouched. Resume session lists both.
        </p>
      </Section>

      <Section id="assistant">
        <p>
          The <strong>Assistant</strong> (the button in the run page's left rail, the button at the bottom right of other pages, or Alt+A) answers
          questions about the world, the controls and what is happening in a run. It reads the run's saved records to answer, links its answers to turns,
          entities and these sections, and says which turn an answer is based on. Agent thoughts it quotes are beliefs, not facts.
        </p>
        <p>
          It can also do things for you, but only with your approval: ask it to set up a run, play or step rounds, stage god-mode edits or create a
          continuation, and it shows an execution brief (what will happen, any problems, the cost so far). Nothing changes until you press Approve. Its model
          spend is shown in the drawer and is separate from the agents' economy and from a run's real budget.
        </p>
        <p>
          The <strong>Storybook</strong> tab on the run page is an AI-written narrative with one entry per turn. The Turn record tab stays the account of
          the facts. <strong>Story Mode</strong> on the entry page turns a finished or running run into a chaptered story after a short interview (genre,
          tone, vividness, point of view) and a story brief you accept. <strong>Dictate</strong>, the microphone button in the assistant's text boxes,
          turns speech into text locally; open the UI through localhost for the microphone to work.
        </p>
      </Section>

      <Section id="numbers">
        <p>
          The numbers on this page are the defaults of the backend configuration; <code>docs/ASSUMPTIONS.md</code> lists each one with its config key. They come
          from the design document where it gives a value, and are settled choices where it leaves one open. None is fixed:
        </p>
        <ul>
          <li>Agent stats, models, personas and starting skills are on each agent card on the New session page.</li>
          <li>World size, terrain, plant count and plant species are under World and Plant rules.</li>
          <li>Prices, upgrade schedule, upkeep, cognition rates, skill limits, ranges and residue fractions are under Other rules (advanced).</li>
          <li>During a run, god mode changes most of them; the Rules tab shows the values in force.</li>
        </ul>
        <p>
          <button type="button" className="btn" onClick={() => navigate({ name: "entry" })}>
            ← Back
          </button>{" "}
          <button type="button" className="btn btn-primary" onClick={() => navigate({ name: "new" })}>
            New session
          </button>
        </p>
      </Section>
    </div>
  );
}
