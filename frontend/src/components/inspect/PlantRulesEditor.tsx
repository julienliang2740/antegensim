/**
 * PlantRulesEditor: readable, table-style view and editor of every plant
 * species rule (spec U3 "plant rules must be easy to see and modify";
 * schemas.PlantSpeciesRule / PlantStageRule).  Species-level fields are a
 * two-column table; stages are a table with one column per stage and one row
 * per field, so every field name is a visible label.  See PlantRulesEditorProps.
 */

import "../../inspect.css";
import type { PlantSpeciesRule, PlantStageRule } from "../../api/types";
import { NumberInput } from "./common";
import { fmtNum } from "./format";
import { SPECIES_FIELDS, STAGE_FIELDS, newSpecies, newStage, plantRuleWarnings, uniqueName } from "./plantRules";
import type { PlantRulesEditorProps } from "./props";

export function PlantRulesEditor(props: PlantRulesEditorProps) {
  const readOnly = props.readOnly ?? false;
  const fixedSpecies = props.fixedSpecies ?? false;
  const names = props.species.map((s) => s.name);

  const replaceAt = (index: number, next: PlantSpeciesRule) => {
    props.onChange(props.species.map((s, i) => (i === index ? next : s)));
  };

  const addSpecies = () => {
    props.onChange([...props.species, newSpecies(uniqueName("new_species", new Set(names)))]);
  };

  return (
    <div className="insp insp-plantrules">
      {props.species.length === 0 ? <p className="insp-muted">No plant species defined.</p> : null}
      {props.species.map((rule, index) => (
        <SpeciesCard
          key={index}
          rule={rule}
          readOnly={readOnly}
          fixedSpecies={fixedSpecies}
          highlightStage={props.highlight && props.highlight.species === rule.name ? props.highlight.stageIndex : null}
          warnings={readOnly ? [] : plantRuleWarnings(rule, names)}
          onChange={(next) => replaceAt(index, next)}
          onRemove={() => props.onChange(props.species.filter((_, i) => i !== index))}
          onDuplicate={() =>
            props.onChange([
              ...props.species,
              { ...structuredClone(rule), name: uniqueName(`${rule.name}_copy`, new Set(names)) },
            ])
          }
        />
      ))}
      {!readOnly && !fixedSpecies ? (
        <button type="button" className="insp-btn" onClick={addSpecies}>
          + Add species
        </button>
      ) : null}
    </div>
  );
}

interface SpeciesCardProps {
  rule: PlantSpeciesRule;
  readOnly: boolean;
  fixedSpecies: boolean;
  highlightStage: number | null;
  warnings: string[];
  onChange(next: PlantSpeciesRule): void;
  onRemove(): void;
  onDuplicate(): void;
}

function SpeciesCard({ rule, readOnly, fixedSpecies, highlightStage, warnings, onChange, onRemove, onDuplicate }: SpeciesCardProps) {
  const setStage = (i: number, next: PlantStageRule) => onChange({ ...rule, stages: rule.stages.map((s, j) => (j === i ? next : s)) });
  const lastAge = rule.stages.length ? rule.stages[rule.stages.length - 1].min_age_rounds : 0;

  return (
    <div className="insp-species">
      <div className="insp-species-head">
        <span className="insp-species-title">
          Species <code>{rule.name || "(unnamed)"}</code>
        </span>
        {!readOnly && !fixedSpecies ? (
          <span className="insp-species-actions">
            <button type="button" className="insp-btn insp-btn-small" onClick={onDuplicate}>
              Duplicate
            </button>
            <button type="button" className="insp-btn insp-btn-small insp-btn-danger" onClick={onRemove}>
              Remove species
            </button>
          </span>
        ) : null}
      </div>

      <table className="insp-table insp-rules-table">
        <tbody>
          <tr>
            <th scope="row" className="insp-fieldname-cell">name</th>
            <td>
              {readOnly || fixedSpecies ? (
                <code>{rule.name}</code>
              ) : (
                <input type="text" aria-label="species name" value={rule.name} onChange={(e) => onChange({ ...rule, name: e.target.value })} />
              )}
            </td>
            <td className="insp-hint">species key (rules.plant_species){fixedSpecies && !readOnly ? "; cannot be renamed here" : ""}</td>
          </tr>
          <tr>
            <th scope="row" className="insp-fieldname-cell">description</th>
            <td colSpan={2}>
              {readOnly ? (
                rule.description || <span className="insp-muted">(none)</span>
              ) : (
                <input
                  type="text"
                  className="insp-wide"
                  aria-label="species description"
                  value={rule.description}
                  onChange={(e) => onChange({ ...rule, description: e.target.value })}
                />
              )}
            </td>
          </tr>
          {SPECIES_FIELDS.map((spec) => (
            <tr key={spec.field}>
              <th scope="row" className="insp-fieldname-cell">{spec.field}</th>
              <td>
                {readOnly ? (
                  fmtNum(rule[spec.field])
                ) : (
                  <NumberInput
                    ariaLabel={`${rule.name} ${spec.field.replace(/_/g, " ")} (${spec.field})`}
                    integer={spec.integer}
                    value={rule[spec.field]}
                    onChange={(n) => onChange({ ...rule, [spec.field]: n })}
                  />
                )}
              </td>
              <td className="insp-hint">{spec.hint}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="insp-subtitle">Stages ({rule.stages.length}) — one column per stage, in age order</div>
      <div className="insp-scroll-x">
        <table className="insp-table insp-stage-table">
          <thead>
            <tr>
              <th>field</th>
              {rule.stages.map((_stage, i) => (
                <th key={i} className={highlightStage === i ? "insp-highlight-col" : undefined}>
                  stage {i}
                  {highlightStage === i ? <div className="insp-badge insp-badge-info">this plant</div> : null}
                  {!readOnly && rule.stages.length > 1 ? (
                    <div>
                      <button
                        type="button"
                        className="insp-btn insp-btn-small insp-btn-danger"
                        onClick={() => onChange({ ...rule, stages: rule.stages.filter((_, j) => j !== i) })}
                      >
                        Remove
                      </button>
                    </div>
                  ) : null}
                </th>
              ))}
              <th className="insp-hint">meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className="insp-fieldname-cell">name</th>
              {rule.stages.map((stage, i) => (
                <td key={i} className={highlightStage === i ? "insp-highlight-col" : undefined}>
                  {readOnly ? (
                    <strong>{stage.name}</strong>
                  ) : (
                    <input
                      type="text"
                      aria-label={`stage ${i} name`}
                      value={stage.name}
                      onChange={(e) => setStage(i, { ...stage, name: e.target.value })}
                    />
                  )}
                </td>
              ))}
              <td className="insp-hint">stage label</td>
            </tr>
            {STAGE_FIELDS.map((spec) => (
              <tr key={spec.field}>
                <th scope="row" className="insp-fieldname-cell">{spec.field}</th>
                {rule.stages.map((stage, i) => (
                  <td key={i} className={highlightStage === i ? "insp-highlight-col" : undefined}>
                    {readOnly ? (
                      fmtNum(stage[spec.field])
                    ) : (
                      <NumberInput
                        ariaLabel={`stage ${i} ${spec.field}`}
                        integer={spec.integer}
                        value={stage[spec.field]}
                        onChange={(n) => setStage(i, { ...stage, [spec.field]: n })}
                      />
                    )}
                  </td>
                ))}
                <td className="insp-hint">{spec.hint}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly ? (
        <button
          type="button"
          className="insp-btn insp-btn-small"
          onClick={() => onChange({ ...rule, stages: [...rule.stages, newStage(`stage_${rule.stages.length}`, lastAge + 5)] })}
        >
          + Add stage
        </button>
      ) : null}
      {warnings.length > 0 ? (
        <ul className="insp-warnings">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
