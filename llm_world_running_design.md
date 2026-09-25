# LLM Artificial Life World

Running design document · Version 0.7 · September 25, 2026

## Contents

- [Executive summary](#executive-summary)
- [Compact specification](#compact-specification)
- [Design principles](#design-principles)
- [The world and the two realms](#the-world-and-the-two-realms)
  - [Coordinates vision and communication](#coordinates-vision-and-communication)
  - [Spawned terrain and passage](#spawned-terrain-and-passage)
  - [What stuff means here](#what-stuff-means-here)
- [Energy and essence](#energy-and-essence)
  - [Energy as metabolism](#energy-as-metabolism)
  - [Current essence and capacity](#current-essence-and-capacity)
  - [Residue and extraction](#residue-and-extraction)
  - [An open resource economy](#an-open-resource-economy)
- [Compute metering](#compute-metering)
- [Plants and agents](#plants-and-agents)
  - [Plants as channels from the ultimate source](#plants-as-channels-from-the-ultimate-source)
  - [Growth leaves fruit and seeds](#growth-leaves-fruit-and-seeds)
  - [Agent continuity](#agent-continuity)
- [Agent stats and health](#agent-stats-and-health)
  - [Minimal agent stats](#minimal-agent-stats)
  - [Health damage and recovery](#health-damage-and-recovery)
  - [Agent death and essence residue](#agent-death-and-essence-residue)
- [Empyrean actions and coded skills](#empyrean-actions-and-coded-skills)
  - [Action blocks and approximate costs](#action-blocks-and-approximate-costs)
  - [Saved skill compute discount](#saved-skill-compute-discount)
  - [Observe query and action feedback](#observe-query-and-action-feedback)
  - [Failure and resource handling](#failure-and-resource-handling)
  - [Absorption efficiency](#absorption-efficiency)
  - [Upgradeable attributes and prices](#upgradeable-attributes-and-prices)
  - [Turns speed and skill execution](#turns-speed-and-skill-execution)
  - [Imperative blocks and expressions](#imperative-blocks-and-expressions)
  - [Examples using only the defined blocks](#examples-using-only-the-defined-blocks)
- [Construction in the Empyrean](#construction-in-the-empyrean)
- [Conflict injury and extraction in the Empyrean](#conflict-injury-and-extraction-in-the-empyrean)
- [Creating new life](#creating-new-life)
- [STARTING PROTOTYPE REALM - The Empyrean](#starting-prototype-realm---the-empyrean)
- [The later Mortal Realm](#the-later-mortal-realm)
- [Minimum prototype](#minimum-prototype)
- [Illustrative trajectory](#illustrative-trajectory)
- [What not to hard code](#what-not-to-hard-code)
- [Open decisions and next experiments](#open-decisions-and-next-experiments)
- [Sources and revision history](#sources-and-revision-history)
  - [Revision history](#revision-history)

## Executive summary

We are starting in **the Empyrean**, the higher realm, populated by disembodied godlike LLM agents. The Mortal Realm is a larger, later project with material physics and bodies. This order lets us explore agency, resources, invented abilities, and persistent consequences before solving physical construction. “Godlike” describes the inhabitants and setting; agents still have finite resources and causal limits. [U2]

**Principles.** Begin with a few composable operations, local knowledge, scarce operating resources, and persistent consequences. Agents choose what to pursue. For this experiment, we assume they care about continued existence and their capabilities; this is a working premise, not a claim about subjective experience. The original aim remains that they be “genuine causal actors in the simulated world.” [N, §1]

**World.** The Empyrean is the one and only realm implemented for the prototype. It is a vast two-dimensional coordinate plane, initially using integers around `(0, 0)`. Agents float as points, and any number of distinct entities can share a coordinate without bodily collision or crowding. Terrain includes normal land, impassable mountains, and traversable water where nothing grows. World generation and any future mountain-crossing mechanics remain deferred. There is no day or night.

**Vision and communication.** Agents initially see everything present at their own point and can communicate there one-to-one or by broadcast. Seeing and communicating beyond that point are capabilities to develop. A reachable recipient can receive a message without seeing its sender; the source then appears unknown. [U3]

**Resources and health.** Compute fuels cognition, coded skills, actions, upgrades, upkeep, and recovery. Health determines agent survival; compute starvation rapidly reduces it. Essence is separately held and can be spent upgrading stats. Both essence capacity and maximum health can be upgraded now without refilling their current values. Death releases a fraction of essence into residue; recovery from that residue depends on the absorber's efficiency.

**Plants.** Plants are deterministic living channels from an ultimate resource source whose parameters the designer sets. They grow to a limit; some have leaves, some have fruit, and plants have seeds. Fruit yields substantial energy. A plant's essence can only be taken by killing it. Resources genuinely enter the world through this source: the ecology is not restricted to redistributing a fixed stock or sharing a fixed allowance at each coordinate.

**Abilities.** Agents compose a fixed vocabulary of actions using simple imperative blocks: assignments, branches, loops, and saved-skill calls. Queries expose permitted data for decisions; upgrades change allowed stats. Skills have count and size limits. Actions executed through a saved skill receive a 20 percent compute-cost discount, applied once. Construction, persistent networks, and fields are deferred.

**Conflict and new life.** Attack deals damage equal to the attack stat multiplied by committed compute. Higher speed acts earlier under the proposed round scheduler. Absorption and recovery use explicit actions. Creating a new agent funds a new independent process at a coordinate; it does not construct a body. Parental essence allocation, recovery, inheritance, and control remain open, with no automatic control suggested initially.

**Development order.** Build and test only the Empyrean now. Later, develop a much richer Mortal Realm with physical bodies, materials, occupancy, construction, and embodied conflict. Both realms use coordinates and can share resource accounting, agent memory, and metering, while their causal mechanisms differ.

**How to read this document.** The terrain revision [U7] updates the saved-skill discount revision [U6], action and coding discussion [U5], and health revision [U4] and takes precedence over earlier directions [U1–U3] and source documents [N, S]. “Current direction” records current preferences. Italic *Suggestion*, *Proposal*, and *Open* notes mark ideas still under discussion. A proposal section remains tentative even when its examples use definite language. Research references provide precedents for individual ideas, not validation of this world as a whole.

## Compact specification

| Area | Current direction | Open or proposed |
| --- | --- | --- |
| Active realm | Empyrean is the one and only prototype realm; disembodied godlike agents | Specific nonphysical causal operations |
| Later realm | Mortal Realm with bodies and material physics | Much larger future design; no first-prototype dependency |
| Coordinates | Integer grid; one-point up/down/left/right moves | Proposed Manhattan reach |
| Empyrean occupancy | Arbitrarily many entities per coordinate | Runtime population limits are separate experimental constraints |
| Time | No day/night; proposed rounds, one action per agent per round, speed determines initiative | Scheduler calibration and tie-breaking |
| Knowledge | All entities at the current point are visible; persistent memories | Develop vision beyond the current point; detail and processing costs |
| Communication | Same-point one-to-one and broadcast initially; unseen senders appear unknown | Develop outward reach; receiving does not require seeing the sender |
| Terrain | Land is traversable; mountains are impassable; water is traversable but supports no growth | World generation and future mountain mechanics remain deferred |
| Energy | One spendable balance for cognition, action, and upkeep | Name and rates |
| Essence | Separate agent resource; cap growth adds no essence; upgrades spend essence | Death residue fraction |
| Health | Agent life measure; maximum health upgradeable; compute funds healing | Initial health, recovery, and rapid starvation rates |
| Absorption | Starts at 20 percent compute and 10 percent essence; upgradeable | Proposed processing losses and source yields |
| Residue | Recoverable resources remain after death | Fraction recovered, persistence, decay, access |
| Plants | Deterministic channels from a designer-configured ultimate source | Per-plant rates, source policy, maturation |
| Growth | Plants grow to a limit and can have leaves, fruit, and seeds | Species differences, regrowth, germination |
| Harvest | Fruit yields energy; plant essence requires killing the plant | Seed and leaf harvesting details |
| Basic actions | Directional move, observe, query, send, broadcast, absorb, transfer, recover, attack, upgrade, wait | Numerical costs are provisional; agents cannot change them yet |
| Invented abilities | Imperative coded skills composed from listed actions | Interpreter and storage defaults |
| Construction | Deferred | No constructs, networks, or fields in the current prototype |
| Conflict | Attack multiplier × compute budget; damage reduces agent health | First-strike balance and plant damage rule |
| Birth | A funded independent agent process at a point | Essence seed, inheritance, recovery, control |
| Working premise | Assume agents care about persistence and capability | Observe behavior without repeatedly reopening the premise |
| Prototype | Small Empyrean experiment | All numerical starting values remain tentative |

## Design principles

1. **Make consequences operational.** Spending energy limits actual cognition and action. Changes to resources, memory, and ongoing processes persist.
2. **Use few ingredients with many combinations.** A small set of operations should support useful and hostile applications. Avoid predefined abilities and construction recipes.
3. **Keep information local.** Agents begin with vision and communication at their own point. They develop capabilities to extend those ranges. Coordinates also support abstract terrain and passage rules without requiring bodily physics.
4. **Give every effect a mechanism.** An agent can invent a name or intention, but the engine needs an executable account of what changes and what it costs.
5. **Keep resource sources explicit.** The ultimate source may add resources. Transfers and consumption must still account for where each amount came from and went.
6. **Keep history real.** Damage, depleted fruit, saved routines, upgraded stats, and residue remain changed until a defined process changes them again.
7. **Make greater causal influence consequential.** Broader reach, longer duration, more targets, or intervention in another process should require corresponding capacity and expenditure.
8. **Test the nonphysical world first.** Bodies and material physics belong to the later Mortal Realm. Do not quietly reintroduce them as requirements for Empyrean abilities.

These retain the source principles “Low-level affordances,” “Local knowledge,” “Persistent consequences,” and “Causal depth,” while changing the substrate they apply to. [S, §2]

**Working assumption.** We proceed as though agents care about their existence and capabilities. We still record what they actually do. There is no need to make the question of subjective caring a recurring design blocker. [U2]

## The world and the two realms

| Feature | Empyrean now | Mortal Realm later |
| --- | --- | --- |
| Agent presence | A point with identity, state, resources, and memories | A located agent with a physical body or embodiment |
| Plant presence | A point-based living process with growth and resource stores | A physical organism whose geometry and material needs need design |
| Coordinates | Integer `(x, y)` initially | Coordinates also apply; resolution remains open |
| Shared location | No occupancy limit or collision | Occupancy and contact rules will need to be defined |
| Movement | Changes coordinates without a body; spawned terrain may restrict passage | Depends on material environment and body capabilities |
| Terrain | Spawned land, mountains, and water with abstract crossing rules | Richer physical terrain to design later |
| Construction | Deferred; current agents save skills instead | Material arrangements, bodies, tools, and infrastructure |
| Injury | Attack reduces agent health | May additionally involve physical damage |
| Development status | Current project | Deferred, substantially larger project |

### Coordinates vision and communication

Two agents can be at `(4, -2)` without displacing each other. So can a thousand plants and residue deposits. Each remains a distinct entity; targeting uses identity as well as coordinates.

**Starting vision:** an agent can see all entities present at its current coordinate. Vision beyond that point is a capability it must develop. Seeing an entity does not automatically reveal its private memories or all internal state. [U3]

**Starting communication:** an agent can send a one-to-one message to another agent at its point or broadcast to agents at that point. Sending beyond the current point is a capability it must develop. Vision range and communication reach are separate capabilities; broader vision alone does not automatically provide broader sending reach.

**Asymmetric reception:** the recipient need not see the sender to receive a valid message. If A can see B and has communication reach to B, but B cannot see A, B receives the message from an **unknown source**. The same visibility rule applies to received broadcasts. Delivery does not automatically reveal the sender's identity or position, expand the recipient's vision, or grant the reach needed to reply. Any name claimed inside the message is message content, not automatically verified source information.

*Implementation note — all colocated entities remain visible even when there are too many to fit in one model context. A navigable listing or paged observation can manage context size without making entities invisible. Detailed inspection and processing still follow the resource rules.*

Outward vision and communication are now upgraded through `upgrade`. Movement is one cardinal step. The action section gives provisional costs and a proposed Manhattan range metric. Same-point visibility and asymmetric reception remain unchanged.

“Unlimited things at one point” is a world rule about occupancy. It does not require actually instantiating infinitely many objects or processing infinitely many actions. Finite experiment budgets and population limits should be recorded separately.

### Spawned terrain and passage

**Current direction:** the prototype uses three terrain categories: normal land, mountains, and water. There is no separate river category or river mechanic. Terrain rules are abstract map rules, not a material physics simulation. [U7]

| Terrain | Passage in this prototype | Growth |
| --- | --- | --- |
| Normal land | Ordinary cardinal movement is allowed | Plants can grow under their normal rules |
| Mountains | Permanent barriers for this version; agents cannot enter or cross them | No additional mountain ecology specified |
| Water | Agents can walk across it using ordinary movement, with the same compute cost | Nothing grows on water; no plant growth or seed germination |

Mountains cannot be bypassed through a skill, higher speed, or an existing upgrade. A move into a mountain fails and leaves position unchanged, following the normal failed-move rules. Agents may go around a mountain where traversable points provide a route. Mountain crossing, alteration, and other mountain mechanics are deferred.

Water requires no crossing ability or special equipment. Its ecological distinction is that it cannot support growth; agents can traverse or share a water coordinate without making it a place for plants to grow.

*Deferred — world generation, random seeding, terrain distribution, and placement of initial plants and agents will be designed later. Whether terrain affects longer-range vision or communication remains undecided; movement restrictions alone do not imply an occlusion rule.*

Terrain restrictions concern passage between coordinates. They do not impose an occupancy limit on entities sharing a valid point. Agent-created solid walls and physical construction remain outside the current design; spawned barriers are a separate terrain rule.

### What stuff means here

The Empyrean still contains things: agents, plants, fruit, seeds, resource deposits, essence residue, and messages. They have identities and state. Leaves, branches, and height can describe a plant's growth state or appearance without introducing volume, collision, gravity, or a third spatial dimension.

Construction is deferred. Agent-written skills are stored programs executed through the listed actions, not separate objects or independent processes.

Use the proposed round scheduler for deterministic growth and upkeep. API latency and how often the observer opens its view do not change ecological time.

## Energy and essence

### Energy as metabolism

Compute is spendable fuel, also called energy in earlier sections. It pays for model usage, coding, world actions, upgrades, upkeep, and health recovery. The original notes describe “compute-like resources as metabolism.” [N, §2.2] This is one world balance, distinct from the real host billing ledger.

For agents, unpaid upkeep now causes rapid **health** deterioration, not essence drain. See the agent stats section for provisional rates. Compute is required before taking a paid action; expected harvest proceeds cannot pay an action's initial fee.

### Current essence and capacity

Agent essence is a separate held resource used for upgrades and potentially other later mechanics. Ordinary damage reduces health. Essence capacity is upgradeable in this version; raising it creates no essence. Zero agent essence alone does not cause death. No age-based death is required.

Plants retain their existing life-associated essence model pending a separate plant-health decision. Their living essence cannot be harvested. The conflict section supplies a provisional rule for attacking plants without leaking essence before death.

### Residue and extraction

Residue exists. Agent death is caused by zero health; a configured fraction of held essence becomes residue. Absorption then recovers a fraction according to the absorber's efficiency. Both losses are recorded separately. Compute residue policy and death yield remain parameters to settle, not silently assumed full recovery.

Kill a plant before taking its essence. Fruit supplies compute, not harvestable essence; leaf or seed operations must not bypass that restriction. A dead plant stops growth and source inflow. Processing residue removes the raw quantity actually processed, and failed absorption cannot duplicate it. No automatic kill reward is paid.

*Open — death yield, residue decay, and the provisional plant damage rule. The action and absorption sections define the current agent-side behavior.*

### An open resource economy

New energy and essence can enter through plants from the ultimate source. The previous preference for essence “conservation or near-conservation” is not binding here. [S, §4.1; U2] We want a world that can grow, while retaining clear accounts of inflow, storage, transfer, expenditure, and loss.

The distinction is simple: authorized source inflow creates new world resources; moving resources between existing balances does not. A construct cannot become a new source just because an agent calls it a generator.

## Compute metering

Keep the original components, expressed as three bills:

**Total energy cost = cognition cost + charged world-action cost + interpreter cost + upkeep.**

For actions executed inside a saved skill, charged world-action compute is 80 percent of the normal price. Cognition, interpreter work, and upkeep are unchanged. This is a fixed execution rule, not an agent-modifiable price parameter.

**Cognition cost = Mind Multiplier × (input rate × input tokens + generation rate × generated tokens).**

| Component | Plain meaning |
| --- | --- |
| Input tokens | Everything actually sent into the model: instructions, observations, memories, history, and tool results |
| Generated tokens | Generated output and any separately reported reasoning usage, counted once |
| Input and generation rates | Conversion factors from measured usage to world energy |
| Mind Multiplier | Relative operating cost of the selected model; start at 1 for a shared model |
| World-action cost | Energy to execute the validated action, separate from thinking about it |
| Upkeep | Energy to sustain living processes for elapsed simulation time |

The substrate draft's useful distinction is “thinking about an action” versus “actually causing it.” [S, §4.3] A failed plan still consumed cognition. Observing can incur both a sensing cost and the later cost of processing its result; they pay for different operations.

*Suggested enforcement:*

1. At a scheduled decision, reserve an affordable maximum for the model call from the current balance; upkeep is settled separately at the end of the round.
2. Build a bounded context and generation allowance that fit that reservation.
3. Charge measured usage after the call and release the unused reservation.
4. Validate and charge the selected action against the remaining balance before applying it.

*Implementation note — use the usage fields actually exposed by the chosen model service. Do not double-count reasoning already included in output totals or invent hidden-token measurements. Define a conservative bound or explicit fallback when usage is unavailable. System failures and retries need an experiment-wide accounting policy.*

*Suggestion — initially use the same model and context limits for all agents, retaining the Mind Multiplier for later model diversity. Do not equate more essence with automatically receiving a stronger LLM.* [S, §4.4]

*Caution — world energy and the real experiment budget are separate ledgers. A flourishing farm cannot authorize unlimited paid API calls. If the host budget is exhausted, pause the experiment explicitly rather than presenting the pause as an ecological event.*

## Plants and agents

Agents use LLMs and persistent memories. Plants use deterministic rules. Both have energy and essence, but plant growth draws on the ultimate source while agent acquisition depends on the permitted world interactions.

### Plants as channels from the ultimate source

**Current direction.** A plant is a living gate through which resources enter the world. The source is configured by the designer. To an inhabitant, growth may appear spontaneous or magical; the engine still records the source contribution. Plants can grow to a certain size or maturity and stop enlarging. Individual resource stores also have limits. [U2]

**This replaces the previous per-location sharing proposal.** We are not requiring all plants at a coordinate to divide one fixed local supply. More plants may deliberately increase production. Multiple plants can germinate and grow at the same eligible land point without competing for physical space. Water never supports plant spawning, germination, or growth; additional source channels do not override this terrain rule.

*Suggested first policy — each living plant has configured energy and essence inflow rates, with stage-dependent limits. A master source setting controls those rates; an optional total world budget can be introduced if desired. In the absence of that optional budget, additional mature plants increase aggregate inflow. Decide and record the policy rather than silently imposing a local cap.*

*Design consequence — widespread planting may eventually make energy abundant. That is a permissible experiment outcome. If continued scarcity is desired, maturation time, production rates, harvest effort, and optional source limits are available controls; collision or land scarcity is unnecessary.*

### Growth leaves fruit and seeds

| Component or process | Current direction | Detail still open |
| --- | --- | --- |
| Plant growth | Deterministic growth up to an individual limit | Stages, maturation time, maximum size, effect on production |
| Branches and height | Can describe growth and visual form | Any abstract effect on fruit count or rates; no physical geometry required |
| Leaves | Some plants have them | Whether they affect capture, growth, or harvesting; no assigned function yet |
| Fruit | Stores substantial energy that agents can harvest | Yield, ripening, number, regrowth, and harvest cost |
| Plant essence | Held by the living plant; obtainable only by killing it | Accumulation rate, cap, and residue yield |
| Seeds | Plants produce seeds that can start new plants | Production cost, dispersal, dormancy, and germination |
| Maturity | Plant enlargement stops at a limit | Whether fruit and seed production continue afterward |

*Suggestion — allow mature plants to keep producing fruit and seeds after reaching their size limit, subject to finite output and storage. Otherwise every mature plant eventually becomes inert even if left alive. This continuing production is a proposal, not yet a decision.*

*Suggestion — fruit contains harvestable energy and no harvestable essence. Leaves cannot yield essence while the plant lives. This creates a meaningful choice: retain a continuing energy source, or destroy it for its accumulated essence.*

*Suggestion — start seeds as dormant records with no harvestable essence. Germination opens a funded plant channel, and initial living essence is explicitly supplied by the ultimate source. Seed production and germination require defined costs or delays. This keeps seeds from becoming a loophole for taking the parent's essence without killing it. Other seed funding rules remain possible.*

*Open — natural spawning in addition to seed propagation; whether plants can be moved; species variation; pruning; how destructive harvesting affects energy stores; and whether agents can modify a plant's channel within designer-set bounds.*

### Agent continuity

An agent is its ongoing state and decision process, not merely one model call. Retain identity, memory, policy, resources, and learned techniques across calls. Assemble context from local observations and relevant memories, following the original notes' “The context question: how does the agent know what is going on?” [N, §4.3]

Being a point does not imply that every part of this state is public. Shared coordinates do not reveal private memories automatically.

## Agent stats and health

**Current model.** Health determines agent survival. Compute pays for operation, coding, actions, and recovery. Essence is separately held and spent on upgrades; a fraction becomes residue at death. No action-point currency exists. [U4, U5]

### Minimal agent stats

*Provisional starting values — the 20 percent compute and 10 percent essence absorption efficiencies follow the latest discussion; other numerical defaults below are suggestions for a first experiment, not calibrated results.*

| Resource or attribute | Suggested starting value | Meaning and progression |
| --- | --- | --- |
| Compute balance | 200 | Spendable fuel; no separate compute storage cap initially |
| Essence | 20 | Held resource; ordinary injury does not reduce it; upgrades can spend it |
| Essence capacity | 100 | Maximum held essence; upgradeable now; increasing it adds no essence |
| Health / maximum health | 100 / 100 | Zero health means death; maximum health is upgradeable now; raising it does not heal |
| Attack | 1 | Damage multiplier applied to committed compute; upgradeable |
| Speed | 1 | Determines initiative order each round; upgradeable |
| Movement step | 1 coordinate | Fixed cardinal step per move; chaining moves travels farther |
| Vision range | 0 | Current point only initially; upgradeable |
| Communication range | 0 | Same-point direct messages and broadcasts initially; upgradeable |
| Compute absorption efficiency | 20 percent | Fraction of processed source compute recovered; upgradeable up to 100 percent |
| Essence absorption efficiency | 10 percent | Fraction of processed residue essence recovered; upgradeable up to 100 percent |
| Saved skill count limit | 5 | Maximum stored skills; upgradeable |
| Per-skill block limit | 100 | Maximum blocks in a saved skill; upgradeable |

Movement range is not an upgrade in this version: `move(direction)` always moves one point. Speed determines who acts first, not the distance of one move or the number of actions granted per round. This replaces the earlier action-duration proposal for the initial turn-based model.

Skill size counts action statements, control statements, assignments, calls, and expression operations; formatting, names, and structural end markers do not add capacity cost. Calls count in the caller and reference another saved skill whose own size is also checked. Creating, editing, and testing skills costs compute through model usage and execution. No additional storage stat is needed initially.

### Health damage and recovery

For agents, **damage = attack × nominal committed compute**. The saved-skill discount reduces the charged compute, not the resulting damage. Damage reduces health, not essence. At zero health the agent dies immediately; remaining compute cannot postpone death and later recovery cannot resurrect it.

`recover(compute_budget)` deliberately spends compute to restore the caller's health up to maximum health. *Suggested initial conversion: 1 compute restores 1 health. Calculate the useful nominal amount, up to the supplied budget, then apply the saved-skill discount if applicable; do not charge for healing past the cap. The action still occupies a turn.*

**Rapid deterioration:** an agent unable to pay upkeep loses health rapidly. *Suggested initial values: upkeep is 1 compute per round; inability to pay that full amount causes 5 health loss at the end of the round. Consume any partial upkeep payment, but do not create a negative compute balance. With no rescue or other damage, an agent at 100 health and zero compute lasts 20 rounds. Rate and initial resources need calibration against actual model costs.*

Zero compute prevents paid actions and model calls; time and starvation continue. Incoming transfers or already-permitted events can supply compute before the end-of-round upkeep step. A paid action that spends the last compute unit does not kill the agent immediately; unpaid upkeep then causes the defined health loss.

Zero essence alone is not an agent death condition. Raising essence capacity or maximum health increases the limit only; it does not refill essence or restore health.

### Agent death and essence residue

Death is resolved once. A configured fraction of the essence held immediately before death moves into residue, and the remainder is lost. Capacity is not used to compute this amount. The former agent retains no spendable copy. Absorbing the residue is a separate action that uses the absorber's essence efficiency.

*Illustrative accounting — death with 100 essence at a hypothetical 40 percent residue fraction leaves 40. An absorber with 10 percent efficiency can gain 4 from processing all 40, assuming enough capacity. The death fraction is still undecided; the two losses are distinct. Remaining compute at death needs its own explicit residue rule.*

Ordinary attacks cannot extract essence from a living agent. Plant essence likewise requires killing the plant first. Several absorbers draw from a single diminishing residue balance; no automatic reward goes to whoever dealt the final damage.

## Empyrean actions and coded skills

**Current direction:** use composable actions and simple imperative blocks. Agents write, save, and execute skills. Persistent networks, constructed objects, and fields are outside the active prototype. `upgrade` changes permitted attributes; ordinary skill code cannot assign directly to world state. [U5]

### Action blocks and approximate costs

*All costs below are provisional compute units. The table gives normal direct-action prices, additional to metered LLM cognition, interpreter work, and upkeep. Saved skills pay 80 percent of the action compute price as specified below. Agents cannot change these base prices or the discount rate. Future price modification may become possible but should require substantial essence and compute; no such operation is provided now.*

| Action block | What it does | Approximate compute cost |
| --- | --- | --- |
| `move(direction)` | Move one coordinate: `"up"`, `"down"`, `"left"`, or `"right"`; invalid passage fails | 5 |
| `observe(point)` | Return terrain and a list of entities at one point within vision range | 1 |
| `query(entity)` | Return the entity's currently permitted data; `self` returns own stats and prices | 1 |
| `send(recipient, message)` | Send one direct message within communication range | 3 |
| `broadcast(message)` | Send a message throughout current communication range | 7 |
| `absorb(source, resource)` | Process the maximum eligible amount of source compute or residue essence that can fit | 3 |
| `transfer(recipient, resource, amount)` | Transfer a specified amount from the caller's balance to a valid recipient | 1 |
| `recover(compute_budget)` | Commit a nominal healing budget; initially 1 health per nominal compute | Useful nominal amount; skill charge is 80 percent |
| `attack(target, compute_budget)` | Commit a nominal budget; deal attack-stat times that amount as damage | Nominal budget directly; 80 percent through a skill |
| `upgrade(attribute)` | Buy the next increment of one allowed attribute | Price in the upgrade table; also spends essence |
| `wait(rounds)` | Skip the specified positive number of the caller's action turns | 0 action cost; normal upkeep continues |

Direction mapping is `up = (0, +1)`, `down = (0, -1)`, `left = (-1, 0)`, and `right = (+1, 0)`. No diagonal move or destination argument is provided. A path is a sequence of moves. Moving into a mountain fails without changing position. Moving onto or across water is allowed at the ordinary movement price; water supports no growth. No mountain-crossing upgrade exists in this prototype.

*Suggested range defaults — use Manhattan distance, with radius zero meaning the current point. `observe` and queries of other entities follow vision range. Sending and broadcasting follow communication range. Attack, absorption, and transfer initially require the same coordinate. More vision does not automatically grant remote attack or extraction.*

`resource` is either `"compute"` or `"essence"`. Transfer is a voluntary act by the holder, not a way to withdraw from another entity. The caller must cover both the amount sent and any compute fee; an essence recipient must have capacity for the full amount. No partial transfer is performed on failure. Plants do not acquire a voluntary transfer interface that bypasses destructive essence harvesting.

*Suggested message limit — 256 tokens per send or broadcast for these flat prices. Extra messages cost extra actions. Broadcast fan-out follows current range; increasing range is paid through upgrades. Revisit per-recipient cost if later experiments show excessive fan-out, rather than leaving message size unlimited.*

### Saved skill compute discount

**Current rule — saved skills receive 20 percent off action compute costs.** Pay `0.8 × normal action compute cost` for each action actually executed through a saved, validated skill. Directly requested individual actions pay the normal price. The incentive is repeatable techniques plus cheaper execution. [U6]

| Example | Direct action compute | Saved-skill action compute |
| --- | --- | --- |
| Move | 5 | 4 |
| Observe or query | 1 | 0.8 |
| Send or absorb | 3 | 2.4 |
| Broadcast | 7 | 5.6 |
| Transfer fee | 1 | 0.8 |
| Five moves | 25 | 20 |
| First ordinary upgrade | 25 | 20; the 2-essence price is unchanged |
| Attack with nominal budget 10 | 10 | 8; damage still uses a budget of 10 |
| Recover 10 missing health with budget 10 | 10 | 8; restores the same 10 health |

The discount applies only to the action's compute charge, including the compute portion of upgrades. It does not reduce transferred resource quantities, resource stock consumed during absorption, essence prices, model usage, interpreter work, or upkeep. It does not change action effects or the number of turns. A transfer of 10 compute through a skill still sends all 10 and charges a separate 0.8 fee.

For attack and recovery, `compute_budget` now denotes the nominal budget before this execution discount. Affordability uses the actual discounted charge. This convention deliberately makes a saved skill more efficient at producing the same effect; it does not secretly lower attack damage or healing alongside the price.

Apply the discount exactly once, even when skills call other skills or contain loops. A single-action saved skill also qualifies; there is no minimum chain length. Such wrappers still occupy saved-skill capacity and cost compute to author. Merely naming an ad hoc action a skill is insufficient: execution must use the validated saved-skill interface.

Charge per executed action, not in advance for the whole program. Unexecuted branches cost no action compute; earlier charges remain if a later action fails. For a charged failed attempt, first compute the ordinary attempt fee, then multiply it by 0.8. Insufficient-funds failures remain zero action charge. Retain fractional compute rather than rounding each discounted action up or down to an integer.

### Observe query and action feedback

`observe(point)` lists **what is there**. Each entry supplies `id`, `kind`, and `position`; it does not dump every entity's full state. Its data contains `point`, `terrain`, `entities`, and `observed_round`. Listing every entity at a crowded point may use pagination without granting extra hidden state. A result list remains a snapshot, not a live database connection.

`query(entity)` supplies **details about one entity**. The agent must currently be able to see the entity; knowing an old ID does not bypass range. Querying `self` is always a valid target if the caller can afford the action. Current co-location makes entities visible; it does not make all internal data public. All returned snapshots include their round.

| Query target | Proposed data returned |
| --- | --- |
| `self` | `position`, `health`, `max_health`, `compute`, `essence`, `essence_capacity`, `attack`, `speed`, `vision_range`, `communication_range`, `compute_absorption`, `essence_absorption`, `skill_count_limit`, `skill_block_limit`, `costs`, and `upgrade_quotes` |
| Another agent | Public identity/position and public combat stats such as health, maximum health, attack, and speed; no private memories or skill code |
| Fruit or residue | Identity/position, `kind`, `available_compute`, `available_essence`, and whether each resource can be absorbed |
| Plant | Identity/position, maturity, its vitality, and visible fruit/seed IDs; live essence cannot be extracted |

*Visibility choice — private agent balances are not revealed by the initial public query schema. This is a proposed boundary, not a technical requirement; it can be changed deliberately. Message reception retains the unknown-source rule and does not itself authorize a query of an unseen sender.*

Every action returns the same record shape: `ok`, `reason`, `cost_compute`, `cost_essence`, `round`, `data`, and `effects`. Fields that have nothing to report are empty or zero. Success uses `reason = "ok"`; failures can include `"blocked"`, `"out_of_range"`, `"insufficient_compute"`, `"insufficient_essence"`, `"target_gone"`, or `"at_limit"`. A skill can store the result and branch on `result.ok`. Effects report what happened, including actual movement, transferred amounts, healing, or damage, without leaking hidden state.

`query(self).data.costs` exposes both normal and saved-skill compute prices, the 0.8 multiplier, recovery conversion, upkeep, and interpreter cost. `upgrade_quotes` contains a named entry for each upgrade, with `base_compute`, `skill_compute`, `compute`, `essence`, `next_value`, and `allowed`. `compute` is the effective price in the query's current execution mode: discounted inside a saved skill, normal for a direct query. `essence` is unchanged in either mode. Own compute and essence in the query response are post-query-payment balances. Upgrade quotes are snapshots; `upgrade` revalidates the current price and balances when executed.

Incoming damage and received messages produce event records available at the next decision or skill-resume boundary. Processing those records in an LLM context costs cognition as usual. Receiving an event does not grant an extra action or trigger a free LLM call.

### Failure and resource handling

*Suggested execution rule — validate and debit each action atomically when its turn arrives. Failed moves leave position unchanged; failed upgrades leave all stats unchanged. Earlier successful actions in a skill stay completed if a later block fails.*

If the caller cannot afford the full effective quoted action after any skill discount, fail without an action debit and without allowing negative balances. Otherwise, an affordable request that fails a target or legality check costs only a small attempt fee: `min(1, normal action compute cost)`, multiplied by 0.8 inside a saved skill, with no essence debit. This fee is included in, not added to, successful action prices. A failed attempt still consumes that turn. Invalid block syntax is rejected when saving the skill; the cognition spent writing it is not refunded.

A budget must be positive and finite; counts and `wait` duration are positive integers. Recovery quotes at most the useful healing cost and can complete as a zero-cost no-op at full health. Attack requires the full effective charge for its nominal budget. Transfers require the whole outgoing amount plus the effective fee. The engine never trusts an earlier observation as proof that a target is still present or a source is still full.

### Absorption efficiency

The absorb call has no amount argument. It attempts the maximum eligible absorption from the selected source and resource, using the source state at execution time. A living plant is never an eligible essence source, and another living agent's balance is not freely absorbable.

*Proposed accounting — efficiency is a conversion yield. The raw amount processed is removed from the source; the absorbed fraction enters the agent's balance, and the rest is lost. Repeating the action cannot recover the lost fraction. Source compute does not pay the action fee retroactively: the caller must already afford the effective fee: 3 compute directly or 2.4 through a saved skill.*

For compute, with no storage cap, process all available source compute. At 20 percent efficiency, processing 100 source compute gains 20, destroys the other 80, and costs 3 directly or 2.4 through a saved skill: net caller gain 17 or 17.6 respectively, before interpreter costs and upkeep. For essence, process no more raw residue than needed to fill the caller's remaining capacity. At 10 percent efficiency and 5 free capacity, process at most 50 residue essence, gain 5, and leave any unprocessed residue in place.

If a source has no eligible resource or the caller has no essence capacity left, fail rather than destroying resource for zero gain. Use precise resource accounting rather than rounding each fractional transfer into free resources. A fruiting plant can later create fresh fruit under its source rules; that is new inflow, not recovery of discarded material.

### Upgradeable attributes and prices

`upgrade(attribute)` purchases exactly one increment, including when invoked inside a skill. There is no arbitrary-value stat setter and no unlock tree. Each attribute has its own successful-upgrade count `n`, starting at zero. Costs are paid from current compute and essence, then the stat changes atomically. Upgrades never reduce current health or essence merely to fit a newly changed cap because all listed cap upgrades increase it.

*Suggested price schedule — most upgrades cost `25 × 2^n` compute and `2 × 2^n` essence. Attack costs `100 × 4^n` compute and `10 × 4^n` essence. These are normal prices and already include executing the upgrade; there is no additional success fee. Saved skills pay 80 percent of the compute portion, with the essence price unchanged. Failed attempts follow the general failure rule. There is no price-modification upgrade in this version.*

| Accepted attribute name | Increment per purchase | First purchase | Subsequent scaling |
| --- | --- | --- | --- |
| `"essence_capacity"` | +20 capacity; no essence refill | 25 compute + 2 essence | Double per prior purchase of this attribute |
| `"max_health"` | +20 maximum health; no healing | 25 compute + 2 essence | Double |
| `"vision_range"` | +1 coordinate radius | 25 compute + 2 essence | Double |
| `"communication_range"` | +1 coordinate radius | 25 compute + 2 essence | Double |
| `"speed"` | +1 initiative speed | 25 compute + 2 essence | Double |
| `"compute_absorption"` | +5 percentage points, capped at 100 percent | 25 compute + 2 essence | Double |
| `"essence_absorption"` | +5 percentage points, capped at 100 percent | 25 compute + 2 essence | Double |
| `"skill_count_limit"` | +1 saved skill | 25 compute + 2 essence | Double |
| `"skill_block_limit"` | +20 blocks per saved skill | 25 compute + 2 essence | Double |
| `"attack"` | +0.25 to damage multiplier | 100 compute + 10 essence | Quadruple per prior attack purchase |

*Reason for this schedule — a normal first upgrade costs as much compute as five moves, making it a real choice without forbidding early experimentation. Essence adds an acquisition requirement. Per-attribute doubling discourages repeatedly maximizing one stat while allowing different builds. Attack has a premium, a smaller increment, and steeper growth because every increase multiplies all future attack spending. These are test values, not a claim of balanced combat.*

Absorption upgrades add percentage points: 20 percent becomes 25 percent, not 24 percent. At a hard limit, an upgrade returns `at_limit`, changes nothing, and does not charge the full upgrade price. The only upgrade targets are listed above; movement step, action prices, upkeep, and interpreter costs are not editable.

### Turns speed and skill execution

*Suggested initial scheduler — use rounds. Each living agent gets one world-action turn per round. Higher speed acts earlier. Ties use a seeded, reproducible tie-break each round. Speed upgrades change ordering from the next round. Speed does not grant extra turns in this first model, and there is no separate action-point balance.*

A skill executes local logic until it reaches an action, performs that one action on the agent's turn, records its result, and resumes afterward for the next turn. Chaining five moves in a saved skill therefore takes five turns and costs 20 action compute instead of 25, plus interpreter work and upkeep. It does not execute five moves ahead of another agent's one turn. Other agents can act between a query and the action that uses its data.

For the first scheduler, action duration is one turn; attack budget affects damage, not duration. `wait(3)` consumes the caller's current action turn and its next two turns. After all turns in a round, advance deterministic plant processes, settle upkeep and starvation, and resolve resulting deaths. API latency does not advance simulation time. Higher budgets, speed, and this sequential ordering can create first-strike advantages; measure those before adding armor, cooldowns, or further combat stats.

*Interpreter suggestion — charge 0.01 compute per evaluated instruction or expression operation. Permit at most 100 such steps per agent turn before yielding to its next turn, and stop when compute is insufficient. World-action costs are additional. Reject recursive skill-call cycles initially. This bounds execution even when a short program contains large loops; these are engine limits rather than action points or new upgrade stats.*

### Imperative blocks and expressions

Use a small structured language with the following blocks. The text examples below are its readable notation, not unrestricted Python or host code. The saved representation can be a validated block tree with an allowlisted action vocabulary.

| Block | Allowed form | Meaning |
| --- | --- | --- |
| Assignment | `SET variable = expression` | Store a value locally; an action expression stores its result record |
| Sequence | Statements written in order | Run the next statement after the previous one |
| Branch | `IF condition ... ELSE ... END` | Choose a branch; `ELSE` is optional |
| Counted loop | `REPEAT count ... END` | Repeat a fixed integer number of times; equivalent to a simple counted for-loop |
| List loop | `FOR_EACH item IN list ... END` | Visit entries in an already-observed snapshot list |
| Saved skill call | `CALL skill_name(arguments) INTO variable` | Run a saved skill and store its returned value; its actions use later turns normally |
| Return | `RETURN expression` | End this skill, returning a value to its caller |
| Stop | `STOP` | End the entire current skill invocation, including callers |

Expressions permit numbers, strings, booleans, local variables, record fields, coordinate pairs `(x_expression, y_expression)`, `+ - * /`, comparisons `== != < <= > >=`, and boolean `AND OR NOT`. Coordinates expose `x` and `y` fields, so an agent with sufficient vision can use `observe((here.x + 1, here.y))`. Division by zero or an unavailable field returns a runtime error; it does not invent a value. Variables and field access read only local snapshots, action results, or supplied events. There is no unrestricted filesystem, network, code execution, or direct world-state assignment.

`self` is the caller's own entity handle. `here` is its current coordinate when evaluated. Only these two basic references are implicit; live stats and prices come through `query(self)`. A stored query does not update itself. Query another entity for permitted fresh data, and store the result before branching on its fields.

`FOR_EACH` does not access a global list. It iterates a list such as `observation.data.entities` returned by `observe`. Entries may become stale while the skill runs; `query` or the attempted action then returns a failure if the entity moved or disappeared. The loop is ordinary list iteration, not a new sensory capability.

Skill writing and editing use a separate validated save interface subject to count and block limits. A saved skill has a name, declared parameters, and a block tree. Validate block names, argument types, referenced skill names, and size before accepting it; use a small interpreter rather than executing unrestricted generated code. The LLM's work consumes metered compute; saving does not confer new world effects. `upgrade` is a normal in-world action available both directly and inside skills. Skills cannot set health, compute, prices, or attribute values by assigning to a field.

### Examples using only the defined blocks

**Move three points upward, stopping if a move fails.**

```text
REPEAT 3
    SET movement_result = move("up")
    IF movement_result.ok == false
        RETURN movement_result.reason
    END
END
RETURN "completed"
```

**Find usable fruit at the current point, query it, absorb it, then recover if affordable.** Fruit is represented as a listed entity with `kind = "fruit"`.

```text
SET observation = observe(here)
IF observation.ok == false
    RETURN observation.reason
END
FOR_EACH entity IN observation.data.entities
    IF entity.kind == "fruit"
        SET fruit_details = query(entity.id)
        IF fruit_details.ok == true
            IF fruit_details.data.available_compute > 0
                SET absorption_result = absorb(entity.id, "compute")
                IF absorption_result.ok == true
                    SET own_details = query(self)
                    IF own_details.ok == true
                        IF own_details.data.health < own_details.data.max_health AND own_details.data.compute >= 10
                            SET recovery_result = recover(5)
                        END
                    END
                    RETURN absorption_result
                END
            END
        END
    END
END
RETURN "no_food_absorbed"
```

**Buy one vision upgrade if the current quote is affordable.** The extra 5 compute leaves a small margin for the local logic; execution still rechecks affordability.

```text
SET own_details = query(self)
IF own_details.ok == false
    RETURN own_details.reason
END
SET upgrade_quote = own_details.data.upgrade_quotes.vision_range
IF upgrade_quote.allowed == true
    IF own_details.data.compute >= upgrade_quote.compute + 5 AND own_details.data.essence >= upgrade_quote.essence
        SET upgrade_result = upgrade("vision_range")
        RETURN upgrade_result
    END
END
RETURN "upgrade_not_affordable_or_unavailable"
```

These examples use only declared blocks, action calls, operators, and data fields. A failed action yields a result that later logic can inspect. As saved skills, these examples pay 80 percent of the normal action compute prices. Total cost additionally depends on which branches run, interpreter work, upkeep, and any LLM calls used to author or revise them.

## Construction in the Empyrean

**Deferred.** We are not implementing construction, persistent resource networks, autonomous constructed objects, or fields in the current prototype. The active scope is agent stats, basic actions, upgrades, and saved coded skills. Plants and terrain remain world entities; saving a skill does not create a separate world object.

## Conflict injury and extraction in the Empyrean

Use the explicit `attack(target, compute_budget)` action. For an agent target, subtract `attacker.attack × compute_budget` from health and resolve death immediately at zero. There is no defense, armor, critical-hit, or accuracy stat initially. A nominal budget of 2 at attack 1 deals 2 damage; the same budget at attack 3 deals 6. The charge is 2 for a direct action or 1.6 inside a saved skill. This follows the stated multiplication rule and corrects the inconsistent numerical example in the discussion. [U5]

*Plant compatibility suggestion — until separate plant health is introduced, attacks reduce the plant's existing living-essence vitality measure. Damage does not release essence while it remains alive. On the lethal hit, use the positive essence immediately before that hit to calculate its configured death residue, then zero the living balance. Earlier nonlethal damage has already reduced potential yield. This is a provisional bridge to the plant rules, not an additional agent stat.*

Attacking does not automatically absorb the target's resources. After death, a separate `absorb(residue, "essence")` or compute absorption draws on actual remains and uses the caller's efficiency. Source depletion and death are recorded once. A subsequent attack against an already-dead target fails.

*Balance note — linear budget-scaled damage and initiative can allow one-hit kills. Expensive attack upgrades slow growth in the multiplier but do not prevent a compute-rich agent dealing a large single hit. We retain that possibility for now as requested; log attack budgets, deaths, and opportunities to respond before changing the rule.*

Point agents do not block each other by occupancy. Spawned terrain may constrain escape routes through its passage rules. Cooperative transfer, recovery, movement, and attack are available responses; there is no automatic counterattack, constructed shield, or network sabotage mechanic in this version.

## Creating new life

**Current direction.** New life costs resources. Children can grow their essence and capacity; parents need a recovery path. No age-based death or automatic parental control is required.

*Suggested Empyrean rule — instantiate a new agent process at a coordinate with initial energy, essence, capacity, identity, and permitted starting memories. There is no body or material assembly requirement. Pay the creation cost separately from the resources transferred to the child.*

*Illustrative accounting only — a parent with 80 essence transfers a seed of 10, leaving 70. The child starts with 10 essence and capacity at least 10. Raising the child's cap later does not refill it. The parent can acquire additional residue essence to recover; fruit alone restores energy, not essence.*

This keeps essence allocation as a candidate rather than the definition of birth. The previous substrate document says “Life creation is Essence allocation”; that remains open for agents. [S, §8] A funded gestation rule is an alternative, but its essence source must be explicit. Plant germination uses the plant channel rules above and need not match agent birth.

*Suggested default — no automatic parent control. Inherited instructions and memories are initial conditions, not guarantees of obedience. Inheritance, copying, and any future control mechanisms remain unsettled.*

*Implementation note — a new agent brings ongoing inference expense. Record any experimental population ceiling separately from in-world birth requirements.*

## STARTING PROTOTYPE REALM - The Empyrean

**The Empyrean is the one and only realm we are building and running for the current prototype.** Every initial agent, plant, terrain feature, and action belongs to it. The Mortal Realm is a future project and is not part of this implementation. Initial agents already inhabit the Empyrean; there is no prior realm, ascent sequence, or entry threshold to implement. [U3]

*Deferred — how Empyrean agents compare with mortal agents, whether travel between realms is possible, what crosses between them, and whether higher-realm actions eventually have greater costs. None of these comparisons is necessary to make the first realm work.*

## The later Mortal Realm

This is a separate, larger development phase. It uses coordinates too, and can reuse agent persistence, energy/essence accounting, plants as a conceptual starting point, and compute metering. Physical rules must be designed deliberately; Empyrean co-location and nonphysical effects do not silently become mortal physics.

*Suggestions retained for later:*

| Topic | Possible Mortal Realm approach | What must be added |
| --- | --- | --- |
| Bodies and self-upgrades | Configurable bodies and attached artifacts | Footprint, contact, permitted properties, material costs |
| Low-level actions | Move material, join/separate pieces, route resources | Work, resistance, reach, occupancy |
| Construction | Arrange common material into barriers, containers, conduits, and tools | Actual causal properties; a barrier must block something |
| Conflict | Breach, sever, injure, repair, and extract through shared mechanics | Damage to physical structures and its relation to essence |
| Growth | Body growth can support greater capacity | Material supply, size tradeoffs, and upkeep |
| More radical substrate | Artificial chemistry or local reaction systems | A larger separate research effort |

The earlier draft's “persistent substrate configurations with causal properties” belongs here in its material sense. [S, §6] EvoGym's “modular and expressive robot design space” provides a precedent for body/controller design [R2]; Combinatory Chemistry provides a precedent for computational reaction systems [R3]. Neither is required to implement the Empyrean.

*Scope boundary — physical bodies, constructed solid walls, collision-based traps, matter conservation, gravity, and material crafting remain future topics. Spawned Empyrean land, mountains, and water use abstract map and passage rules; their inclusion does not require this later physical simulation.*

## Minimum prototype

*Tentative experiment — Empyrean only. All numerical costs and defaults are starting hypotheses.*

| Element | Starting choice or proposal |
| --- | --- |
| World | A modest integer-coordinate region; unlimited co-location |
| Terrain | Traversable land, impassable mountains, and traversable water with no growth; generation deferred |
| Population | 4–8 agents sharing one LLM and Mind Multiplier 1 |
| Resources | Compute, agent health, essence/capacity, and residue |
| Plants | One deterministic fruit/seed plant with explicit source inflows |
| Actions | The eleven action blocks and provisional prices above |
| Skills | Imperative block programs, saved under count and size limits |
| Progression | Listed upgrades available now, including health/essence capacity and absorption |
| Conflict | Budget-scaled attack and speed-based initiative; no armor or construction |
| Time | One world action per agent per round; interleaved skill execution |
| Deferred | Construction, persistent networks, fields, agent birth action, and the Mortal Realm |
| Observation | Action results, query snapshots, events, resource ledgers, and saved skills |

Verify a basic loop: observe a point, query fruit, absorb compute, recover health, upgrade a stat, and act on a failed move. Then introduce attack and residue absorption, simultaneous competition for a source, and multi-turn skills.

*Important checks — failed moves do not move; failed upgrades do not change stats; queries respect visibility; prices are visible to the caller; raising caps does not fill them; absorption losses cannot be recovered by retrying; attack charges the nominal budget adjusted for saved-skill execution; no skill gets multiple world actions in one turn; constructs are not required.*

*Open before a run — seed planting/germination interaction, agent birth action, source yield/rates, death residue fractions, and plant attack semantics need a final minimal choice. Seeds and future reproduction remain in the design, but the current action list does not pretend to implement them.*

## Illustrative trajectory

*An illustration of the selected blocks, not a prediction or assigned objective.*

An agent observes its point, queries listed fruit, and absorbs compute. It learns that successful feeding requires accounting for the 3-compute fee and its 20 percent yield. It writes a skill that loops over observed fruit and recovers health only when enough compute remains.

Another agent uses `query(self)` to inspect upgrade quotes, then buys greater vision through `upgrade("vision_range")`. It can inspect nearby points, but still needs multiple cardinal moves to travel and cannot attack remotely merely because it sees farther.

An agent spends compute attacking a plant under the provisional plant rule, then absorbs part of the resulting essence residue. It can spend that essence on absorption efficiency, capacity, speed, or another listed stat. Upgrading capacity does not itself refill a balance.

When another agent attacks, speed determines which action occurs first in the round. A queued recovery or movement skill may succeed, fail, or arrive too late. Each result is observable to the acting agent and can be used by later branches of its skill.

## What not to hard code

*Tentative restraint list, adapted from the earlier draft. [S, §12]*

- A tech tree of named spells, powers, constructs, or divine ranks.
- Required bodies, material collision physics, or exclusive occupancy in the Empyrean; spawned terrain uses separate abstract passage rules.
- Territorial ownership merely because an agent is present at a coordinate.
- A Mortal Realm stage that must be completed before entering the Empyrean.
- A fixed per-coordinate plant inflow limit carried over from the previous proposal.
- Free essence from cap growth or harvestable plant essence in fruit.
- Unlimited effect strength because an inhabitant is described as a god.
- Assigned societies, factions, jobs, currencies, morality scores, or civilization goals.
- Automatic parental obedience or new effects awarded for impressive descriptions.

Still define the actual causal rules: visibility, reach, time, source inflow, legal transformations, protection, injury, death, and resource transfers. We are postponing material physics, not the need for consistent consequences.

## Open decisions and next experiments

| Priority | Question | Next step |
| --- | --- | --- |
| 1 | Are cognition and action costs comparable enough for agents to function? | Calibrate input/output weights alongside the proposed compute prices |
| 1 | Do low absorption yields support survival? | Choose fruit inflows that permit feeding after fees, upkeep, and cognition |
| 1 | How much residue survives death? | Fix and log a death fraction separately from absorption efficiency |
| 1 | Is the provisional plant-damage rule acceptable? | Test whether essence vitality should remain or plants need separate health |
| 1 | How severe is first-strike dominance? | Measure deaths by attack budget and speed; retain the simple formula initially |
| 1 | What are the minimal seed and germination actions? | Specify before claiming active cultivation is implemented |
| 2 | Are upgrades affordable and diverse enough? | Review the per-stat doubling schedule and attack premium |
| Later | How should the world be generated? | Decide map seeding, terrain distribution, and initial placement; mountain mechanics remain deferred |
| 2 | How much data about other agents is public? | Review the proposed query schema; preserve unknown-source reception |
| Later | How are new agents created? | Add a funded birth action after the basic survival loop works |
| Later | Should costs become modifiable? | Require substantial essence and compute; not supported now |
| Later | Should construction or the Mortal Realm return? | Treat as a separate expansion, not a prerequisite |

**Current decisions:** Empyrean only; point agents and unlimited co-location; local starting vision and direct/broadcast communication; developed outward ranges; health-based agent death; separate essence; fractional residue; 20/10 percent initial absorption efficiencies; directional moves; observe lists and query details; explicit attack; upgradeable capacities and other listed stats; simple imperative skills with a non-stacking 20 percent action-compute discount; impassable mountains and traversable water with no growth; no action points; no agent-controlled price modification or construction.

## Sources and revision history

Source references throughout use document section numbers and short exact quotations so the original passages can be found with text search. Research precedents support individual design ideas; they do not validate this proposed world as a whole.

**[N] Original concept notes.** `llm_artificial_life_simulation_notes(1).docx`, titled *Open-Ended LLM Artificial-Life Simulation*. Key locators: §1 “genuine causal actors in the simulated world”; §2.2 “compute-like resources as metabolism”; §4.3 “The context question: how does the agent know what is going on?” The OpenLife discussion in these notes is background from the supplied document, not an independently verified result used to establish this draft's claims.

**[S] Earlier substrate design.** `llm_world_substrate_design(1).docx`, titled *LLM Artificial-Life World Substrate*. Key locators: §2 “Low-level affordances”; §4.1 “conservation or near-conservation”; §4.3 “thinking about an action”; §6 “persistent substrate configurations with causal properties”; §7 “contested world modification”; §8 “Life creation is Essence allocation”; §9 “World-rule”.

**[U1] Initial design direction.** The initial discussion, also supplied as `Pasted text(20260925-022428).txt`. This revised [N] and [S], including integer Cartesian space, plants and agents, metabolic upkeep, non-draining essence with growth and injury, tentative reproduction, two realms, and open-ended abilities and construction. The subsequent instruction adds this document's clickable contents.

**[U2] Empyrean first revision.** Follow-up discussion on September 24, 2026. Key exact phrases: “we just start with the Epirian realm”; “you don't need bodies”; “it just increases capacity”; “essence can only be, like, taken by killing the plant.” This is the controlling direction for version 0.2. The canonical spelling retained is **Empyrean**.

**[U3] Vision communication and terrain revision.** Follow-up discussion on September 24, 2026. Key exact phrases: “you can see, like, everything in your point”; “one-to-one communication”; “unknown source”; “normal land, there's mountains, there's water”; “the one and only realm we are doing rn for the prototype”. This controlled version 0.3, when mountain blockage was provisional. The current terrain rules in [U7] supersede those earlier open crossing questions.

**[U4] Agent health and stats revision.** Discussion on September 24, 2026 separating health from essence and requesting agent stats, speed, skill count/size limits, compute-funded recovery, and fractional essence residue.

**[U5] Actions costs and coding revision.** Discussion on September 25, 2026. Searchable phrases: “input is just up, down, left, right”; “call it attack”; “new action called Query”; “in this version, we should be able to modify essence capacity and health capacity”. This controls version 0.5. Costs, upgrade schedules, scheduler details, and absorption-loss treatment marked as suggestions are design proposals.

**[U6] Saved skill discount.** Discussion on September 25, 2026. Exact phrase: “a 20% off discount”. Saved skill execution pays 80 percent of normal action compute costs; implementation details specify excluded resource quantities, unchanged effects, and non-stacking calls. The higher-speed-first ordering already exists and is retained.

**[U7] Terrain defaults.** Discussion on September 25, 2026. Exact phrases: “perma barriers”; “there are no such things as rivers”; “you can walk on water”; “nothing will grow on water”. Mountains are impassable in this version. Water is an ordinary traversable terrain category with no growth. World generation and future mountain mechanics are deferred.

**[R1] Voyager.** Wang et al., *Voyager: An Open-Ended Embodied Agent with Large Language Models* (2023). [Paper and abstract](https://arxiv.org/abs/2305.16291). Locator: “ever-growing skill library of executable code”. Used for compositional executable techniques, not as evidence of new physical laws or absence of a tech tree.

**[R2] Evolution Gym.** Bhatia et al., *Evolution Gym: A Large-Scale Benchmark for Evolving Soft Robots* (NeurIPS 2021). [Authors' project overview](https://evolutiongym.github.io/) and [paper](https://arxiv.org/abs/2201.09863). Locator: “modular and expressive robot design space”. Used for the distinction between improving a controller and changing the body it controls.

**[R3] Combinatory Chemistry.** Kruszewski and Mikolov, *Emergence of Self-Reproducing Metabolisms as Recursive Algorithms in an Artificial Chemistry* (2021 preprint). [Paper and abstract](https://arxiv.org/abs/2103.08245). Locator: “minimalistic Artificial Chemistry with conservation laws”. Used as a precedent for a more radical reaction-based substrate.

### Revision history

| Version | Change |
| --- | --- |
| 0.7 | Set mountains as impassable barriers and water as traversable with no growth; removed the river distinction; deferred world generation and future mountain mechanics |
| 0.6 | Added the fixed 20 percent saved-skill action-compute discount; reconciled affordability, upgrade quotes, budgeted effects, failure fees, and cost examples; retained higher-speed-first initiative |
| 0.5 | Replaced ability alternatives with priced actions, queries, upgrades, imperative blocks and valid examples; added attack and absorption stats; reconciled health and starvation; deferred construction; selected a provisional turn scheduler and upgrade economy |
| 0.4 | Scoped agent-stats update: separated health from essence, defined compute-funded recovery and fractional essence residue, distinguished speed from movement range, and added skill count/size limits; action and coding proposals remain outside this document |
| 0.3 | Defined initial same-point vision and direct/broadcast communication, developed outward reach, and unknown-source reception; added spawned land/mountains/water with tentative crossing rules; renamed the prototype realm section and removed its suggestions while retaining its deferred note |
| 0.2 | Reversed development order to Empyrean first; confirmed residue and capacity-only growth; replaced fixed local plant supply with ultimate-source channels; added fruit, leaves, seeds, and destructive essence harvesting; replaced bodily construction with nonphysical action and construct options; moved material ideas to the future Mortal Realm |
| 0.1 | Consolidated both source documents under the latest direction; placed compact specification after executive summary; added clickable contents; separated current preferences from proposals; explored abilities and construction in parallel; retained open decisions and a minimal experimental scope |

*For future revisions — record what changed, why, and whether the reason was a preference, a consistency fix, or an observed result. Preserve rejected options briefly when they explain an important design choice.*
