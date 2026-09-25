/**
 * Species rule change next to the plant inspector (spec U3 "plant rules must
 * be easy to see and modify"; "Display and historical inspection":
 * distinguish a species/rule change from editing one instance).  Stages an
 * update_plant_rules intervention for the LIVE run's rule of this species;
 * it applies to every plant of the species at the next turn boundary.
 * Only this species' values are editable here (no rename, add or remove:
 * god mode replaces one species rule, INTERFACES section 10).
 */

import { useState } from "react";
import type { ApiProblem, Intervention, PlantSpeciesRule } from "../../api/types";
import { PlantRulesEditor, problemsFromError } from "../inspect";
import { ProblemSummary } from "../common/Problems";

export interface SpeciesRulePanelProps {
  species: string;
  /** The live run's rule for this species (null when the live rules do not have it). */
  liveRule: PlantSpeciesRule | null;
  /** The selected plant's stage (highlighted column), or null. */
  stageIndex: number | null;
  onStage(intervention: Intervention): Promise<void>;
}

export function SpeciesRulePanel(props: SpeciesRulePanelProps) {
  const [draft, setDraft] = useState<PlantSpeciesRule | null>(props.liveRule);
  const [base, setBase] = useState<PlantSpeciesRule | null>(props.liveRule);
  const [problems, setProblems] = useState<ApiProblem[]>([]);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A new live rule (after a commit) resets an untouched draft.
  if (props.liveRule !== base) {
    const untouched = JSON.stringify(draft) === JSON.stringify(base);
    setBase(props.liveRule);
    if (untouched) setDraft(props.liveRule);
  }

  if (!props.liveRule || !draft) {
    return (
      <section className="species-panel">
        <div className="panel-title">Species rule change</div>
        <p className="hint">The live rules have no species named "{props.species}".</p>
      </section>
    );
  }

  const changed = JSON.stringify(draft) !== JSON.stringify(props.liveRule);

  const stage = async () => {
    setBusy(true);
    setProblems([]);
    setOk(null);
    try {
      await props.onStage({ type: "update_plant_rules", species: props.species, rule: { ...draft, name: props.species }, origin: "ui" });
      setOk(`Staged: species rule "${props.species}" replaced at the next turn boundary.`);
    } catch (error) {
      setProblems(problemsFromError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="species-panel">
      <div className="panel-title">
        Species rule change <span className="scope-tag">every {props.species} plant</span>
      </div>
      <p className="hint">
        Edits the live run's rule for <code>{props.species}</code> (not only the selected plant). It is staged and applies at the next turn boundary; to change
        only this plant use God mode → Set stat.
      </p>
      <div className="action-row">
        <button type="button" className="btn btn-primary" disabled={busy || !changed} onClick={() => void stage()}>
          {busy ? "Staging…" : "Stage species rule change"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!changed}
          onClick={() => setDraft(props.liveRule)}
        >
          Reset draft
        </button>
        {!changed ? <span className="hint">Edit a value below to enable staging.</span> : null}
      </div>
      <ProblemSummary problems={problems} title="Not staged — fix these:" />
      {ok ? <div className="ok-line">{ok}</div> : null}
      <PlantRulesEditor
        species={[draft]}
        fixedSpecies
        highlight={props.stageIndex !== null ? { species: props.species, stageIndex: props.stageIndex } : null}
        onChange={(list) => {
          const first = list[0];
          if (first) setDraft({ ...first, name: props.species });
        }}
      />
    </section>
  );
}
