/**
 * New session (spec U10, U11, U16 and "Sessions and run controls"): usable
 * world and plant settings, editable run-default context settings, a model
 * choice, and eight prefilled agent cards (6–11).  "Validate setup" asks the
 * backend for every problem at once (POST /runs/validate) and shows each one
 * next to its field and in a summary; "Create and open" saves the initial
 * checkpoint (POST /runs) and opens the run paused.
 */

import { useEffect, useState } from "react";
import { ApiClientError, createRun, getDefaults, listModels, previewWorld, validateRun } from "../api/client";
import type { AgentCard, ApiProblem, MapState, RunCreateRequest } from "../api/types";
import { pointKey } from "../api/types";
import { ContextSettingsEditor, MapView, PlantRulesEditor } from "../components/inspect";
import { NumberField } from "../components/common/NumberField";
import { PageHeader } from "../components/common/PageHeader";
import { ErrorLine, FieldProblems, ProblemSummary } from "../components/common/Problems";
import { AgentCardEditor } from "../components/setup/AgentCardEditor";
import { ModelSelect, UnavailableModels } from "../components/setup/ModelSelect";
import { WorldSettings } from "../components/setup/WorldSettings";
import { useFetched } from "../hooks/useFetched";
import { navigate } from "../hooks/useHashRoute";
import { errorText } from "../state/runSessions";
import {
  MAX_AGENTS,
  MIN_AGENTS,
  applyOtherRules,
  newCard,
  otherRulesText,
  previewAgent,
  problemsAt,
  problemsOutside,
  problemsUnder,
  speciesList,
  withSpecies,
} from "../state/setupForm";

type Validation = "never" | "valid" | "invalid" | "stale";

export function NewSessionPage() {
  const [request, setRequest] = useState<RunCreateRequest | null>(null);
  const [templates, setTemplates] = useState<AgentCard[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const models = useFetched("models", () => listModels());
  const [problems, setProblems] = useState<ApiProblem[]>([]);
  const [validation, setValidation] = useState<Validation>("never");
  const [busy, setBusy] = useState<"validate" | "create" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MapState | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [rulesText, setRulesText] = useState("");
  const [rulesTextError, setRulesTextError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "New session · Empyrean";
    let cancelled = false;
    Promise.all([getDefaults(8), getDefaults(MAX_AGENTS)])
      .then(([defaults, full]) => {
        if (cancelled) return;
        setRequest(defaults);
        setTemplates(full.agents);
        setRulesText(otherRulesText(defaults));
      })
      .catch((e) => {
        if (!cancelled) setLoadError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <div className="page">
        <PageHeader title="New session" />
        <ErrorLine text={loadError} prefix="Could not load the defaults from the backend:" />
      </div>
    );
  }
  if (!request) {
    return (
      <div className="page">
        <PageHeader title="New session" />
        <p className="hint">Fetching the defaults…</p>
      </div>
    );
  }

  const modelList = models.data ?? [];
  const update = (next: RunCreateRequest) => {
    setRequest(next);
    if (validation !== "never") setValidation("stale");
  };
  const setCard = (index: number, card: AgentCard) => update({ ...request, agents: request.agents.map((c, i) => (i === index ? card : c)) });
  const defaultModel = modelList.find((m) => m.key === request.default_model_key) ?? null;
  const at = (...paths: string[]) => problemsAt(problems, ...paths);
  const generalProblems = problemsOutside(problems, [
    "agents",
    "world",
    "context",
    "rules",
    "name",
    "seed",
    "default_model_key",
    "max_rounds",
    "play_delay_seconds",
    "real_budget_usd",
  ]);

  const validate = async () => {
    setBusy("validate");
    setActionError(null);
    try {
      const result = await validateRun(request);
      setProblems(result.problems);
      setValidation(result.ok ? "valid" : "invalid");
    } catch (error) {
      if (error instanceof ApiClientError && error.problems.length > 0) {
        setProblems(error.problems);
        setValidation("invalid");
      } else setActionError(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy("create");
    setActionError(null);
    try {
      const created = await createRun(request);
      navigate({ name: "run", runId: created.run_id, turnId: null });
    } catch (error) {
      if (error instanceof ApiClientError && error.problems.length > 0) {
        setProblems(error.problems);
        setValidation("invalid");
        setActionError("The run was not created: fix the problems listed below.");
      } else setActionError(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const runPreview = async () => {
    setPreviewError(null);
    try {
      setPreview(await previewWorld({ seed: request.seed, world: request.world }));
    } catch (error) {
      setPreviewError(errorText(error));
    }
  };

  const validationText =
    validation === "never"
      ? "Not validated yet."
      : validation === "valid"
        ? "Setup is valid."
        : validation === "invalid"
          ? `${problems.length} problem${problems.length === 1 ? "" : "s"} found.`
          : "Setup changed since the last validation; press Validate setup again.";

  return (
    <div className="page setup-page">
      <PageHeader title="New session" subtitle="Set up the world and the agents, validate, then create the run. It opens paused at its initial checkpoint." />

      <div className="setup-actions" role="region" aria-label="Setup actions">
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void validate()}>
          {busy === "validate" ? "Validating…" : "Validate setup"}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void create()}>
          {busy === "create" ? "Creating…" : "Create and open"}
        </button>
        <span className={`validation validation-${validation}`}>{validationText}</span>
        <ErrorLine text={actionError} />
      </div>
      <ProblemSummary problems={problems} title="Setup problems (path: message) — each is also shown next to its field:" />

      <section className="setup-section">
        <h2>Run</h2>
        <div className="form-table">
          <div className="form-row">
            <label className="field field-wide">
              <span>Run name</span>
              <input type="text" value={request.name} onChange={(e) => update({ ...request, name: e.target.value })} />
            </label>
            <FieldProblems problems={at("name")} />
          </div>
          <div className="form-row">
            <label className="field">
              <span>Seed</span>
              <NumberField integer value={request.seed} invalid={at("seed").length > 0} onChange={(v) => update({ ...request, seed: v ?? 0 })} />
            </label>
            <span className="hint">same seed + same setup = same terrain, plants and initiative order</span>
            <FieldProblems problems={at("seed")} />
          </div>
          <div className="form-row form-row-wide">
            <label className="field field-wide" htmlFor="setup-default-model">
              <span>Default model (every card without its own model)</span>
              <ModelSelect
                id="setup-default-model"
                models={modelList}
                value={request.default_model_key}
                onChange={(key) => update({ ...request, default_model_key: key })}
                invalid={at("default_model_key").length > 0}
              />
            </label>
            {defaultModel && defaultModel.provider !== "fake" ? (
              <span className="hint text-warn">Real provider: every decision is a paid model call. Consider a real budget below.</span>
            ) : (
              <span className="hint">fake models are deterministic and free</span>
            )}
            <FieldProblems problems={at("default_model_key")} />
            <UnavailableModels models={modelList} />
            <ErrorLine text={models.error} prefix="Models:" />
          </div>
          <div className="form-row">
            <label className="field">
              <span>Max rounds (empty = no limit)</span>
              <NumberField integer optional value={request.max_rounds ?? null} onChange={(v) => update({ ...request, max_rounds: v })} />
            </label>
            <FieldProblems problems={at("max_rounds")} />
          </div>
          <div className="form-row">
            <label className="field">
              <span>Play delay (seconds between turns)</span>
              <NumberField value={request.play_delay_seconds ?? 0} onChange={(v) => update({ ...request, play_delay_seconds: v ?? 0 })} />
            </label>
            <FieldProblems problems={at("play_delay_seconds")} />
          </div>
          <div className="form-row">
            <label className="field">
              <span>Real budget in USD (empty = no limit)</span>
              <NumberField optional value={request.real_budget_usd ?? null} onChange={(v) => update({ ...request, real_budget_usd: v })} />
            </label>
            <span className="hint">the run stops with an error when provider-reported cost reaches this</span>
            <FieldProblems problems={at("real_budget_usd")} />
          </div>
        </div>
      </section>

      <section className="setup-section">
        <h2>
          Agent cards ({request.agents.length}; {MIN_AGENTS}–{MAX_AGENTS} allowed)
        </h2>
        <p className="hint">Each card becomes one agent. Values are prefilled from the defaults; change anything, then validate.</p>
        <FieldProblems problems={at("agents")} />
        <div className="card-grid">
          {request.agents.map((card, index) => (
            <AgentCardEditor
              key={index}
              card={card}
              index={index}
              problems={problems}
              models={modelList}
              defaultModelKey={request.default_model_key}
              runContext={request.context}
              canRemove={request.agents.length > MIN_AGENTS}
              onChange={(next) => setCard(index, next)}
              onRemove={() => update({ ...request, agents: request.agents.filter((_, i) => i !== index) })}
            />
          ))}
        </div>
        <div className="action-row">
          <button
            type="button"
            className="btn"
            disabled={request.agents.length >= MAX_AGENTS}
            onClick={() => update({ ...request, agents: [...request.agents, newCard(request.agents, templates)] })}
          >
            Add agent card
          </button>
          {request.agents.length >= MAX_AGENTS ? <span className="hint">At most {MAX_AGENTS} agents.</span> : null}
        </div>
      </section>

      <section className="setup-section">
        <h2>Context settings (run defaults)</h2>
        <p className="hint">
          How much each agent sees per decision. Cards can override single values. Checked against the default model
          {defaultModel
            ? ` (${defaultModel.key}: context window ${defaultModel.capabilities.context_window}, max output ${defaultModel.capabilities.max_output_tokens})`
            : ""}
          .
        </p>
        <ContextSettingsEditor
          value={request.context}
          onChange={(context) => update({ ...request, context })}
          capabilities={defaultModel?.capabilities ?? null}
        />
        <FieldProblems problems={problemsUnder(problems, "context")} />
      </section>

      <section className="setup-section">
        <h2>World</h2>
        <WorldSettings request={request} problems={problems} onChange={(world) => update({ ...request, world })} />
        <div className="action-row">
          <button type="button" className="btn" onClick={() => void runPreview()}>
            Preview world
          </button>
          <span className="hint">Shows the terrain this seed generates and where the cards start (plants are placed when the run is created).</span>
        </div>
        <ErrorLine text={previewError} prefix="Preview failed:" />
        {preview ? <WorldPreview map={preview} cards={request.agents} /> : null}
        <FieldProblems
          problems={problemsOutside(problemsUnder(problems, "world"), [
            "world.region",
            "world.terrain",
            "world.initial_plants",
            "world.initial_plant_stage",
            "world.max_entities_per_observation_page",
          ])}
        />
      </section>

      <section className="setup-section">
        <h2>Plant rules</h2>
        <p className="hint">Every species and stage. Growth, fruit and seeds follow these rules; they can be changed later in god mode.</p>
        <PlantRulesEditor species={speciesList(request)} onChange={(list) => update(withSpecies(request, list))} />
        <FieldProblems problems={problemsUnder(problems, "rules.plant_species")} />
      </section>

      <section className="setup-section">
        <h2>Other rules (advanced)</h2>
        <details>
          <summary>Prices, upkeep, cognition rates, skills, ranges and the rest as JSON</summary>
          <p className="hint">Edit and press "Use these rules". Plant species are edited above.</p>
          <textarea className="mono json-edit" rows={18} value={rulesText} onChange={(e) => setRulesText(e.target.value)} aria-label="Other rules as JSON" />
          <div className="action-row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                const result = applyOtherRules(request, rulesText);
                if ("error" in result) setRulesTextError(result.error);
                else {
                  setRulesTextError(null);
                  update(result.request);
                }
              }}
            >
              Use these rules
            </button>
            <button type="button" className="btn" onClick={() => setRulesText(otherRulesText(request))}>
              Reload from the form
            </button>
          </div>
          <ErrorLine text={rulesTextError} prefix="Rules JSON:" />
        </details>
        <FieldProblems problems={problemsOutside(problemsUnder(problems, "rules"), ["rules.plant_species"])} />
      </section>

      {generalProblems.length > 0 ? <ProblemSummary problems={generalProblems} title="Other problems:" /> : null}

      <div className="setup-actions setup-actions-bottom">
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void validate()}>
          Validate setup
        </button>
        <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void create()}>
          Create and open
        </button>
        <span className={`validation validation-${validation}`}>{validationText}</span>
      </div>
    </div>
  );
}

function WorldPreview(props: { map: MapState; cards: AgentCard[] }) {
  const agents = props.cards.map(previewAgent);
  const r = props.map.region;
  const notes = agents
    .map((a) => {
      const inside = a.position.x >= r.min_x && a.position.x <= r.max_x && a.position.y >= r.min_y && a.position.y <= r.max_y;
      const terrain = props.map.cells[pointKey(a.position)] ?? "land";
      if (!inside) return `${a.id} ${a.name} starts outside the region`;
      if (terrain === "mountain") return `${a.id} ${a.name} starts on a mountain (the backend moves it to the nearest land)`;
      if (terrain === "water") return `${a.id} ${a.name} starts on water`;
      return null;
    })
    .filter((n): n is string => n !== null);
  return (
    <div className="world-preview">
      {notes.length > 0 ? (
        <ul className="warnings">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : (
        <p className="hint">Every card starts on land inside the region.</p>
      )}
      <MapView
        map={props.map}
        entities={agents}
        selectedPoint={null}
        selectedEntityId={null}
        onSelectPoint={() => {}}
        onSelectEntity={() => {}}
        heightPx={420}
      />
    </div>
  );
}
