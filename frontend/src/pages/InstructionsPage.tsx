/**
 * "How the world works": the rules of the Empyrean written for a human
 * operator, following llm_world_running_design.md (v0.7) and the backend
 * config defaults recorded in docs/ASSUMPTIONS.md.  Static text: the numbers
 * are the shipped defaults and every one of them is configurable per run.
 *
 * The app uses a hash router ("#/..."), so the table of contents scrolls with
 * scrollIntoView instead of changing the hash.  "#/instructions?section=<id>"
 * is a first-class route (hooks/useHashRoute.ts) and opens the page scrolled
 * to that section (the assistant links docs sections this way).
 */

import { useEffect, type MouseEvent, type ReactNode } from "react";
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
  { id: "numbers", title: "Where the numbers come from" },
];

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
            The rules of the Empyrean, the world your agents live in. Numbers are the defaults shipped with the backend; every one of them can be changed per
            run.
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
          The Empyrean is the only realm in this prototype. It is a flat grid of integer coordinates <code>(x, y)</code>. The default region runs from −10 to 10
          on both axes (21 × 21 points); a move that would leave the region is refused.
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
          The terrain is generated from the run's seed: by default 4 mountain clusters of about 4 points, 3 water clusters of about 5 points, and a clear area
          within 2 steps of the origin. The same seed and setup always give the same world. There is no day or night; time is counted in rounds, and slow model
          calls never advance it.
        </p>
      </Section>

      <Section id="agents">
        <p>
          An agent is an ongoing process: an identity, stats and resources, a private notebook, memories of what happened to it, and the skills it has saved.
          Each decision is one call to the agent's model (the model on its card, else the run default). A card can also give the agent a persona, a starting
          notebook and starting skills.
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
            another agent shows only its id, name, position, health, max health, attack, speed and whether it is alive.
          </li>
          <li>Messages are limited to 256 tokens (about 1,000 characters). A longer message fails.</li>
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
              <td>200</td>
              <td>Spendable energy; no upper limit.</td>
            </tr>
            <tr>
              <td>Essence / capacity</td>
              <td>20 / 100</td>
              <td>Held essence and the most it can hold.</td>
            </tr>
            <tr>
              <td>Health / max health</td>
              <td>100 / 100</td>
              <td>Zero health is death.</td>
            </tr>
            <tr>
              <td>Attack</td>
              <td>1</td>
              <td>Damage per unit of compute committed to an attack.</td>
            </tr>
            <tr>
              <td>Speed</td>
              <td>1</td>
              <td>Higher speed acts earlier in each round.</td>
            </tr>
            <tr>
              <td>Vision / communication range</td>
              <td>0 / 0</td>
              <td>Own point only.</td>
            </tr>
            <tr>
              <td>Compute / essence absorption</td>
              <td>20% / 10%</td>
              <td>Share of absorbed compute or essence the agent keeps.</td>
            </tr>
            <tr>
              <td>Skill count / blocks per skill</td>
              <td>5 / 100</td>
              <td>How many skills it can save and how big each can be.</td>
            </tr>
          </tbody>
        </table>
        <p>A run has 6 to 12 agents. The New session page prefills 8 cards; any value on a card can be changed.</p>
      </Section>

      <Section id="resources">
        <h3>Compute: energy for thinking, acting and living</h3>
        <p>Compute is one balance that pays for everything:</p>
        <p className="doc-formula">total compute spent = cognition + world actions + interpreter work + upkeep</p>
        <ul>
          <li>
            <strong>Cognition</strong> is thinking: mind multiplier × (0.0002 × input tokens + 0.001 × output tokens). A 5,000-token prompt with a 600-token
            reply costs 1 + 0.6 = 1.6 compute. The mind multiplier is 1 for every model by default. If a call costs more than the agent has, the balance goes to
            0 and the rest is recorded as uncharged.
          </li>
          <li>
            <strong>World actions</strong> have prices; see <em>The eleven actions</em>.
          </li>
          <li>
            <strong>Interpreter work</strong> is 0.01 compute per step when a saved skill runs.
          </li>
          <li>
            <strong>Upkeep</strong> is 1 compute per round, taken at the end of the round.
          </li>
        </ul>
        <p>
          An agent with no compute cannot act or think, but time goes on. If it cannot pay its full upkeep, it pays what it has and loses 5 health. An agent at
          100 health with no compute and no help dies after 20 rounds. Compute cannot go negative.
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
          does not heal. <code>recover(budget)</code> turns compute into health at 1 health per compute, never past the maximum.
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
            <tr>
              <td>Sprout</td>
              <td>0 rounds</td>
              <td>2 energy, 0.2 essence</td>
              <td>60 / 10</td>
              <td>none</td>
              <td>none</td>
            </tr>
            <tr>
              <td>Sapling</td>
              <td>5 rounds</td>
              <td>6 energy, 0.5 essence</td>
              <td>120 / 25</td>
              <td>every 8 rounds</td>
              <td>none</td>
            </tr>
            <tr>
              <td>Mature</td>
              <td>15 rounds</td>
              <td>12 energy, 1 essence</td>
              <td>180 / 60</td>
              <td>every 5 rounds</td>
              <td>every 20 rounds</td>
            </tr>
          </tbody>
        </table>
        <ul>
          <li>
            <strong>Fruit</strong> is a separate entity at the plant's point holding 60 compute, paid from the plant's energy store. A plant has at most 3 fruit
            at a time. Fruit stays until someone absorbs it. At 20% absorption an agent gains 12 compute from a fruit and pays a 3-compute fee: 9 net.
          </li>
          <li>
            <strong>Seeds</strong> drop on land within 1 step of a mature plant, at most 2 alive per plant. A seed becomes a sprout after 10 rounds with 5
            essence supplied by the source.
          </li>
          <li>
            <strong>Essence only by killing.</strong> A living plant's essence cannot be absorbed. Attacking a plant reduces its living essence; when it reaches
            0 the plant dies and 50% of the essence it had just before the killing blow is left as residue. Its stored energy is lost. A dead plant never fruits
            again, so agents choose between a lasting food source and a one-time gain of essence.
          </li>
          <li>
            <strong>At the start</strong> the world has 12 mature fruit trees with one ripe fruit each. The first ones stand on the agents' start points, so an
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
              <td>5</td>
              <td>4</td>
            </tr>
            <tr>
              <td>
                <code>observe(point)</code>
              </td>
              <td>Lists the terrain and the entities (id, kind, position) at one point within vision range, 40 per page.</td>
              <td>1</td>
              <td>0.8</td>
            </tr>
            <tr>
              <td>
                <code>query(entity)</code>
              </td>
              <td>
                Details of one visible entity. <code>query(self)</code> returns the agent's exact stats, prices and upgrade quotes.
              </td>
              <td>1</td>
              <td>0.8</td>
            </tr>
            <tr>
              <td>
                <code>send(recipient, message)</code>
              </td>
              <td>A message to one visible agent within communication range.</td>
              <td>3</td>
              <td>2.4</td>
            </tr>
            <tr>
              <td>
                <code>broadcast(message)</code>
              </td>
              <td>A message to every agent within communication range.</td>
              <td>7</td>
              <td>5.6</td>
            </tr>
            <tr>
              <td>
                <code>absorb(source, resource)</code>
              </td>
              <td>Takes the most it can of "compute" or "essence" from fruit or residue at the same point.</td>
              <td>3</td>
              <td>2.4</td>
            </tr>
            <tr>
              <td>
                <code>transfer(recipient, resource, amount)</code>
              </td>
              <td>Gives compute or essence to a living agent at the same point. The amount is sent in full, plus the fee.</td>
              <td>1, plus the amount given</td>
              <td>0.8, plus the amount</td>
            </tr>
            <tr>
              <td>
                <code>recover(budget)</code>
              </td>
              <td>Turns compute into health, 1 for 1, only as much as is missing.</td>
              <td>the useful budget</td>
              <td>80% of it</td>
            </tr>
            <tr>
              <td>
                <code>attack(target, budget)</code>
              </td>
              <td>Deals attack × budget damage to an agent or plant at the same point.</td>
              <td>the budget</td>
              <td>80% of it</td>
            </tr>
            <tr>
              <td>
                <code>upgrade(attribute)</code>
              </td>
              <td>
                Buys one step of a stat; see <em>Upgrades</em>.
              </td>
              <td>compute + essence</td>
              <td>80% of the compute</td>
            </tr>
            <tr>
              <td>
                <code>wait(rounds)</code>
              </td>
              <td>Skips this turn and the next rounds − 1 turns. Upkeep still applies.</td>
              <td>0</td>
              <td>0</td>
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
            If it can afford it but the action fails anyway (a mountain, out of range, target gone, stat at its limit), it pays a small attempt fee of 1 compute
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
        <h3>The 20% discount</h3>
        <p>
          Every action executed from a saved skill pays 80% of its compute price. The discount applies once, even when skills call other skills. It does not
          reduce model costs, interpreter work, upkeep, essence prices or amounts transferred, and it does not weaken effects: an attack budget of 10 costs 8 in
          a skill and still deals attack × 10 damage.
        </p>
        <h3>One action per turn</h3>
        <p>
          A skill runs its local logic until it reaches an action, performs that one action on the agent's turn, and resumes on the next turn. While a skill is
          running the agent does not call its model, so a running skill also saves cognition. Each turn allows at most 100 interpreter steps at 0.01 compute
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
          Run as a skill, this takes three turns and costs 3 × 4 = 12 compute for the moves plus a few interpreter steps, and one model call to start it. Three
          direct moves cost 15 compute and three model calls.
        </p>
        <p>Limits: 5 saved skills of at most 100 blocks each (both upgradeable), no recursion, at most 4,000 characters of source per skill.</p>
      </Section>

      <Section id="upgrades">
        <p>
          <code>upgrade(attribute)</code> buys one step of one stat. Each attribute keeps its own purchase count n, and its price doubles with every purchase:{" "}
          <strong>25 × 2ⁿ compute + 2 × 2ⁿ essence</strong>. Attack is dearer and grows faster: <strong>100 × 4ⁿ compute + 10 × 4ⁿ essence</strong>. Inside a
          skill the compute part is 80%; the essence part never changes.
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
              ["essence_capacity", "+20 capacity (no essence added)"],
              ["max_health", "+20 max health (no healing)"],
              ["vision_range", "+1 point of vision"],
              ["communication_range", "+1 point of reach"],
              ["speed", "+1 speed"],
              ["compute_absorption", "+5 percentage points, up to 100%"],
              ["essence_absorption", "+5 percentage points, up to 100%"],
              ["skill_count_limit", "+1 saved skill"],
              ["skill_block_limit", "+20 blocks per skill"],
            ].map(([name, adds]) => (
              <tr key={name}>
                <td>
                  <code>{name}</code>
                </td>
                <td>{adds}</td>
                <td>25 + 2</td>
                <td>50 + 4</td>
                <td>100 + 8</td>
              </tr>
            ))}
            <tr>
              <td>
                <code>attack</code>
              </td>
              <td>+0.25 attack</td>
              <td>100 + 10</td>
              <td>400 + 40</td>
              <td>1,600 + 160</td>
            </tr>
          </tbody>
        </table>
        <p className="hint">Prices are compute + essence. A first upgrade costs as much compute as five moves.</p>
        <p>
          <code>query(self)</code> shows the current quote for every attribute. A stat at its hard limit returns <code>at_limit</code> and changes nothing.
          Movement distance, action prices and upkeep cannot be upgraded.
        </p>
      </Section>

      <Section id="conflict">
        <h3>Attack</h3>
        <p>
          <code>attack(target, budget)</code> deals <strong>attacker's attack × budget</strong> damage. With attack 1, a budget of 10 deals 10 damage and costs
          10 compute (8 in a skill). There is no armor, defense or counterattack. The target must be visible and at the same point. Because higher speed acts
          first, a compute-rich, fast agent can kill in one blow.
        </p>
        <h3>Death and residue</h3>
        <p>
          An agent at 0 health dies immediately. <strong>40% of its essence and 50% of its compute</strong> stay at its point as a residue entity; the rest is
          lost. Residue does not decay by default. The killer gets nothing automatically; anyone at the point can absorb the residue. A killed plant leaves 50%
          of its last living essence as residue.
        </p>
        <h3>Absorption</h3>
        <p>
          <code>absorb(source, resource)</code> has no amount. It processes the most it can, and the agent keeps only its absorption efficiency (20% for
          compute, 10% for essence at the start). The rest is destroyed; absorbing again cannot recover it.
        </p>
        <ul>
          <li>Compute: all available compute in the source is processed.</li>
          <li>Essence: only as much residue as fills the agent's free capacity is processed; the rest stays for later.</li>
          <li>An empty source, or no free essence capacity, fails instead of destroying anything.</li>
        </ul>
        <p>
          Example: an agent dies holding 100 essence and 80 compute. Its residue holds 40 essence and 40 compute. A second agent with 10% essence absorption
          processes the 40 essence and gains 4. With 20% compute absorption it processes the 40 compute and gains 8, minus the 3-compute fee.
        </p>
      </Section>

      <Section id="rounds">
        <ul>
          <li>
            <strong>One turn per round.</strong> Every living agent gets exactly one turn each round. Speed decides the order, highest first; ties are broken by
            a shuffle drawn from the run's seed, so runs are reproducible. Speed never grants extra turns, and a speed upgrade counts from the next round.
          </li>
          <li>
            <strong>A turn.</strong> If a skill is running, it continues to its next action. If the agent is waiting, the turn passes. Otherwise the agent's
            model receives its decision packet and returns a decision, which the engine checks and applies.
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
              <td>6,000 tokens</td>
            </tr>
            <tr>
              <td>Generation allowance</td>
              <td>1,000 tokens</td>
            </tr>
            <tr>
              <td>Recent history</td>
              <td>last 5 decisions</td>
            </tr>
            <tr>
              <td>Notebook</td>
              <td>up to 400 tokens</td>
            </tr>
            <tr>
              <td>Retrieved memories</td>
              <td>5</td>
            </tr>
            <tr>
              <td>Unread events in the digest</td>
              <td>10</td>
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
          A run always opens paused. <strong>Run turn</strong> plays one agent's turn, <strong>Step round</strong> plays to the end of the round, and{" "}
          <strong>Play</strong> / <strong>Pause</strong> run continuously with the play delay between turns. The timeline goes back to any saved turn so you can
          inspect it; history is read-only.
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

      <Section id="numbers">
        <p>
          The numbers on this page are the defaults of the backend configuration; <code>docs/ASSUMPTIONS.md</code> lists each one with its config key. They come
          from the design document where it gives a value, and are settled choices where it leaves one open. None is fixed:
        </p>
        <ul>
          <li>Agent stats, models, personas and starting skills are on each agent card on the New session page.</li>
          <li>World size, terrain, plant count and plant species are under World and Plant rules.</li>
          <li>Prices, upgrade schedule, upkeep, cognition rates, skill limits, ranges and residue fractions are under Other rules (advanced).</li>
          <li>During a run, god mode changes most of them; the Rules &amp; settings tab shows the values in force.</li>
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
