/**
 * One editable agent card (spec U11 "each agent should be, like, a card" /
 * "pre-fill it with defaults"; "Sessions and run controls": each card exposes
 * name, model, starting coordinate, initial stats/resources and optional
 * context-setting overrides prefilled from run defaults).  Problems returned
 * by setup validation are shown next to the field they name
 * (agents[i].stats.health, agents[i].position, ...).  On the New session
 * page it is shown inside AgentCardDialog (inDialog: two columns, persona
 * and skills expanded).
 */

import type { AgentCard, AgentStats, ApiProblem, ContextSettings, ModelInfo, SkillSaveRequest } from "../../api/types";
import { INTEGER_STATS } from "../../api/types";
import { ContextSettingsEditor } from "../inspect";
import { NumberField } from "../common/NumberField";
import { FieldProblems } from "../common/Problems";
import { problemsAt, problemsUnder } from "../../state/setupForm";
import { ModelSelect } from "./ModelSelect";

const STAT_ORDER: (keyof AgentStats)[] = [
  "compute",
  "essence",
  "essence_capacity",
  "health",
  "max_health",
  "attack",
  "attack_cap",
  "speed",
  "vision_range",
  "communication_range",
  "compute_absorption",
  "essence_absorption",
  "skill_count_limit",
  "skill_block_limit",
];

const INTEGER_STAT_NAMES: readonly string[] = INTEGER_STATS;

export interface AgentCardEditorProps {
  card: AgentCard;
  index: number;
  problems: ApiProblem[];
  models: ModelInfo[];
  defaultModelKey: string;
  runContext: ContextSettings;
  canRemove: boolean;
  /** Shown in the card dialog: two-column layout, persona section expanded, no card border. */
  inDialog?: boolean;
  onChange(card: AgentCard): void;
  onRemove(): void;
}

export function AgentCardEditor(props: AgentCardEditorProps) {
  const { card, index } = props;
  const prefix = `agents[${index}]`;
  const mine = problemsUnder(props.problems, prefix);
  const at = (...paths: string[]) => problemsAt(mine, ...paths.map((p) => `${prefix}.${p}`));
  const shownPaths = new Set<string>([
    `${prefix}.id`,
    `${prefix}.name`,
    `${prefix}.model_key`,
    `${prefix}.position`,
    `${prefix}.position.x`,
    `${prefix}.position.y`,
    ...STAT_ORDER.map((s) => `${prefix}.stats.${s}`),
  ]);
  const otherProblems = mine.filter((p) => !shownPaths.has(p.path));
  const set = (patch: Partial<AgentCard>) => props.onChange({ ...card, ...patch });
  const setStat = (stat: keyof AgentStats, value: number) => set({ stats: { ...card.stats, [stat]: value } });
  const modelKey = card.model_key || props.defaultModelKey;
  const capabilities = props.models.find((m) => m.key === modelKey)?.capabilities ?? null;
  const overrideCount = card.context_overrides ? Object.values(card.context_overrides).filter((v) => v !== null && v !== undefined).length : 0;
  const idField = `card-${index}`;

  return (
    <section
      className={`agent-card${mine.length ? " has-problems" : ""}${props.inDialog ? " agent-card-dialog" : ""}`}
      aria-label={`Agent card ${index + 1}: ${card.name}`}
    >
      <div className="card-main">
        <div className="card-head">
          <label className="field field-short">
            <span>id</span>
            <input
              type="text"
              className={at("id").length ? "field-invalid" : undefined}
              value={card.id ?? ""}
              placeholder="auto"
              onChange={(e) => set({ id: e.target.value || null })}
            />
          </label>
          <label className="field">
            <span>name</span>
            <input type="text" className={at("name").length ? "field-invalid" : undefined} value={card.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="field" htmlFor={`${idField}-model`}>
            <span>model</span>
            <ModelSelect
              id={`${idField}-model`}
              models={props.models}
              value={card.model_key ?? ""}
              onChange={(key) => set({ model_key: key || null })}
              emptyLabel={`run default (${props.defaultModelKey})`}
              invalid={at("model_key").length > 0}
            />
          </label>
        </div>
        <FieldProblems problems={at("id", "name", "model_key")} />

        <fieldset className="card-group">
          <legend>Starting coordinate</legend>
          <div className="inline-fields">
            <label className="field field-short">
              <span>x</span>
              <NumberField
                integer
                value={card.position.x}
                invalid={at("position", "position.x").length > 0}
                onChange={(x) => set({ position: { ...card.position, x: x ?? 0 } })}
              />
            </label>
            <label className="field field-short">
              <span>y</span>
              <NumberField
                integer
                value={card.position.y}
                invalid={at("position", "position.y").length > 0}
                onChange={(y) => set({ position: { ...card.position, y: y ?? 0 } })}
              />
            </label>
          </div>
          <FieldProblems problems={at("position", "position.x", "position.y")} />
        </fieldset>

        <fieldset className="card-group">
          <legend>Initial stats and resources</legend>
          <div className="stat-grid">
            {STAT_ORDER.map((stat) => {
              const statProblems = at(`stats.${stat}`);
              return (
                <div key={stat} className="stat-cell">
                  <label className="field field-stat">
                    <span className="stat-label" title={`stats.${stat}`}>
                      {stat.replace(/_/g, " ")}
                    </span>
                    <NumberField
                      integer={INTEGER_STAT_NAMES.includes(stat)}
                      value={card.stats[stat]}
                      invalid={statProblems.length > 0}
                      onChange={(v) => setStat(stat, v ?? 0)}
                    />
                  </label>
                  <FieldProblems problems={statProblems} />
                </div>
              );
            })}
          </div>
        </fieldset>
      </div>

      <div className="card-side">
        <details className="card-more" open={problemsUnder(mine, `${prefix}.context_overrides`).length > 0}>
          <summary>Context settings for this agent ({overrideCount ? `${overrideCount} override(s)` : "run defaults"})</summary>
          <ContextSettingsEditor
            value={props.runContext}
            onChange={() => {}}
            overrides={card.context_overrides ?? null}
            onOverridesChange={(overrides) => set({ context_overrides: overrides })}
            capabilities={capabilities}
            label={`Tick "override" to change a value for ${card.name} only; checked against ${modelKey}.`}
          />
        </details>

        <details className="card-more" open={props.inDialog || problemsUnder(mine, `${prefix}.initial_skills`).length > 0}>
          <summary>
            Persona, starting notebook and initial skills ({card.initial_skills.length} skill{card.initial_skills.length === 1 ? "" : "s"})
          </summary>
          <label className="block-label" htmlFor={`${idField}-persona`}>
            Persona (optional; shown to the agent as part of its identity)
          </label>
          <textarea id={`${idField}-persona`} rows={2} value={card.persona} onChange={(e) => set({ persona: e.target.value })} />
          <label className="block-label" htmlFor={`${idField}-notebook`}>
            Starting notebook (optional; the agent's own notes)
          </label>
          <textarea id={`${idField}-notebook`} rows={2} value={card.notebook} onChange={(e) => set({ notebook: e.target.value })} />
          <SkillsEditor idPrefix={idField} skills={card.initial_skills} onChange={(initial_skills) => set({ initial_skills })} />
        </details>
      </div>

      {otherProblems.length > 0 ? (
        <div className="card-problems">
          <strong>Other problems on this card:</strong>
          <FieldProblems problems={otherProblems} />
        </div>
      ) : null}

      <div className="card-foot">
        <button type="button" className="btn btn-danger btn-small" disabled={!props.canRemove} onClick={props.onRemove}>
          Remove this agent
        </button>
        {!props.canRemove ? <span className="hint">A run needs at least 6 agents.</span> : null}
      </div>
    </section>
  );
}

function SkillsEditor(props: { idPrefix: string; skills: SkillSaveRequest[]; onChange(skills: SkillSaveRequest[]): void }) {
  const replace = (i: number, patch: Partial<SkillSaveRequest>) => props.onChange(props.skills.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="skills-editor">
      <div className="block-label">Initial skills (the skill language of the design; checked when you validate)</div>
      {props.skills.map((skill, i) => (
        <div key={i} className="skill-edit">
          <div className="inline-fields">
            <label className="field">
              <span>skill name</span>
              <input type="text" value={skill.name} onChange={(e) => replace(i, { name: e.target.value })} />
            </label>
            <label className="field">
              <span>parameters (comma-separated)</span>
              <input
                type="text"
                value={skill.params.join(", ")}
                onChange={(e) =>
                  replace(i, {
                    params: e.target.value
                      .split(",")
                      .map((p) => p.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <button type="button" className="btn btn-small btn-danger" onClick={() => props.onChange(props.skills.filter((_, j) => j !== i))}>
              Remove skill
            </button>
          </div>
          <label className="block-label" htmlFor={`${props.idPrefix}-skill-${i}`}>
            source
          </label>
          <textarea
            id={`${props.idPrefix}-skill-${i}`}
            className="mono"
            rows={4}
            value={skill.source}
            onChange={(e) => replace(i, { source: e.target.value })}
          />
        </div>
      ))}
      <button
        type="button"
        className="btn btn-small"
        onClick={() => props.onChange([...props.skills, { name: `skill${props.skills.length + 1}`, params: [], source: "" }])}
      >
        Add initial skill
      </button>
    </div>
  );
}
