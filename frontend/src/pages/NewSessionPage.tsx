/**
 * New session (spec U10, U11, U16 and "Sessions and run controls"): usable
 * world and plant settings, editable run-default context settings, a model
 * choice, and eight prefilled agent cards (6–64) shown as a table with one
 * row per agent; a row opens the full card in a dialog.  "Validate setup" asks the
 * backend for every problem at once (POST /runs/validate) and shows each one
 * next to its field and in a summary; "Create and open" saves the initial
 * checkpoint (POST /runs) and opens the run paused.
 *
 * A clone route loads the saved original request directly (no merge with today’s defaults),
 * clears world_id and suggests a copy name. Creation still requires the normal form action.
 *
 * Rev 4: when the assistant hands over a create_run proposal ("Open in setup
 * form instead"), sessionStorage "empyrean.assistant.setupDraft.v1" holds
 * {agent_count, partial, source}; the page fetches the defaults for that
 * agent count, merges the partial request (setupForm.mergeSetupDraft), removes
 * the key and shows a banner until the user dismisses it.
 */

import { useEffect, useState } from "react";
import { ApiClientError, createRun, getDefaults, getRunSetup, listModels, previewWorld, validateRun } from "../api/client";
import type { AgentCard, ApiProblem, MapState, RunCreateRequest } from "../api/types";
import { pointKey } from "../api/types";
import { ContextSettingsEditor, MapView, PlantRulesEditor } from "../components/inspect";
import { HelpTip } from "../components/common/HelpTip";
import { NumberField } from "../components/common/NumberField";
import { PageHeader } from "../components/common/PageHeader";
import { ErrorLine, FieldProblems, ProblemSummary } from "../components/common/Problems";
import { AgentCardDialog } from "../components/setup/AgentCardDialog";
import { AgentCardEditor } from "../components/setup/AgentCardEditor";
import { AgentTable } from "../components/setup/AgentTable";
import { ModelSelect, UnavailableModels } from "../components/setup/ModelSelect";
import { WorldSettings } from "../components/setup/WorldSettings";
import { useFetched } from "../hooks/useFetched";
import { navigate } from "../hooks/useHashRoute";
import { publishContext } from "../state/assistantContext";
import { errorText } from "../state/runSessions";
import {
  MAX_AGENTS,
  MIN_AGENTS,
  SETUP_DRAFT_KEY,
  applyOtherRules,
  mergeSetupDraft,
  newCard,
  otherRulesText,
  previewAgent,
  problemsAt,
  problemsOutside,
  problemsUnder,
  speciesList,
  withSpecies,
} from "../state/setupForm";
import type { SetupDraft } from "../state/setupForm";
import "../setup.css";

type Validation = "never" | "valid" | "invalid" | "stale";

function clearSetupDraft(): void {
  try {
    window.sessionStorage.removeItem(SETUP_DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

/** Read the assistant's setup draft (null when absent or unreadable); cleared after it is applied. */
function takeSetupDraft(): SetupDraft | null {
  try {
    const raw = window.sessionStorage.getItem(SETUP_DRAFT_KEY);
    if (!raw) return null;
    // Not removed here: React StrictMode runs the mount effect twice in development, and the
    // second run must still see the draft (it is cleared once the form has been prefilled).
    const parsed = JSON.parse(raw) as Partial<SetupDraft>;
    if (!parsed.partial || typeof parsed.partial !== "object") return null;
    const count = typeof parsed.agent_count === "number" ? Math.min(MAX_AGENTS, Math.max(MIN_AGENTS, Math.round(parsed.agent_count))) : 8;
    return { agent_count: count, partial: parsed.partial, source: typeof parsed.source === "string" ? parsed.source : "the assistant" };
  } catch {
    return null;
  }
}

export function NewSessionPage({ cloneRunId }: { cloneRunId?: string }) {
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
  const [openCard, setOpenCard] = useState<number | null>(null);
  const [draftBanner, setDraftBanner] = useState<string | null>(null);

  useEffect(() => {
    document.title = "New session · Empyrean";
    publishContext({ page: "new" });
    let cancelled = false;
    const draft = cloneRunId ? null : takeSetupDraft();
    // The MAX_AGENTS request only supplies templates for "Add agent"; if it
    // fails (e.g. an older backend that caps agent_count lower) new rows copy
    // the last card instead (setupForm.newCard).
    Promise.all([cloneRunId ? getRunSetup(cloneRunId) : getDefaults(draft?.agent_count ?? 8), getDefaults(MAX_AGENTS).catch(() => null)])
      .then(([defaults, full]) => {
        if (cancelled) return;
        const initial = cloneRunId ? { ...defaults, name: `${defaults.name.slice(0, 73)} (copy)`, world_id: null } : draft ? mergeSetupDraft(defaults, draft.partial) : defaults;
        setRequest(initial);
        if (draft) clearSetupDraft();
        setTemplates(full?.agents ?? defaults.agents);
        setRulesText(otherRulesText(initial));
        if (cloneRunId) setDraftBanner(defaults.name);
        else if (draft) setDraftBanner(draft.source);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [cloneRunId]);

  if (loadError) {
    return (
      <div className="page">
        <PageHeader title="New session" />
        <ErrorLine text={loadError} prefix={cloneRunId ? "Could not load this session’s original setup:" : "Could not load the defaults from the backend:"} />
      </div>
    );
  }
  if (!request) {
    return (
      <div className="page">
        <PageHeader title="New session" />
        <p className="hint">{cloneRunId ? "Loading the saved setup…" : "Fetching the defaults…"}</p>
      </div>
    );
  }

  const modelList = models.data ?? [];
  const update = (next: RunCreateRequest) => {
    setRequest(next);
    if (validation !== "never") setValidation("stale");
  };
  const setCard = (index: number, card: AgentCard) => update({ ...request, agents: request.agents.map((c, i) => (i === index ? card : c)) });
  const removeCard = (index: number) => {
    update({ ...request, agents: request.agents.filter((_, i) => i !== index) });
    setOpenCard((open) => (open === null || open === index ? null : open > index ? open - 1 : open));
  };
  const shownCard = openCard !== null && openCard < request.agents.length ? openCard : null;
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
      {draftBanner ? (
        <div className="banner setup-draft-banner" role="status">
          <span>
            {cloneRunId ? <><strong>Cloned setup</strong> from "{draftBanner}". These are the original starting settings, not the current simulation state. Review and edit them, then create a new world. The source session stays unchanged.</> : <><strong>Prefilled by the assistant</strong> from its proposal "{draftBanner}": review the values below, then Validate setup and Create. Nothing was created yet.</>}
          </span>
          <button type="button" className="btn btn-small" onClick={() => setDraftBanner(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

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

      <section className="setup-section" aria-label="Agents">
        <h2>
          Agents ({request.agents.length}; {MIN_AGENTS}–{MAX_AGENTS} allowed)
        </h2>
        <p className="hint">
          One row per agent, prefilled from {cloneRunId ? "the saved setup" : "the defaults"}. Click a row or "Edit…" to open its full card: every stat, model, persona, notebook, context settings
          and starting skills.
        </p>
        <div className="persona-tip-toggle">
          <label>
            <input
              type="checkbox"
              checked={request.context.persona_tip}
              onChange={(e) => update({ ...request, context: { ...request.context, persona_tip: e.target.checked } })}
            />{" "}
            Add the tip to every persona
          </label>
          <HelpTip label="What is the persona tip?">
            On by default. The tip is added after each agent's persona: it reminds agents that a repeated routine can be
            saved as a skill (no thinking cost while it runs) and that other agents are options too (message them, give
            them compute, attack them, absorb what the dead leave). We add it so agents do interesting things: without it
            they mostly forage alone and the scenario is often very boring. Only turn it off if you know what you are
            doing, for example to test what agents do completely unprompted. A card can override it under its context
            settings.
          </HelpTip>
          <span className="hint">{request.context.persona_tip ? "on (recommended)" : "off: agents get their persona only"}</span>
          <details>
            <summary>Show the tip text</summary>
            <blockquote>{request.context.persona_tip_text || "(empty: the shipped tip text is used)"}</blockquote>
          </details>
        </div>
        <FieldProblems problems={at("agents")} />
        <AgentTable
          cards={request.agents}
          problems={problems}
          defaultModelKey={request.default_model_key}
          canRemove={request.agents.length > MIN_AGENTS}
          openIndex={shownCard}
          onEdit={setOpenCard}
          onRemove={removeCard}
        />
        <div className="action-row">
          <button
            type="button"
            className="btn"
            disabled={request.agents.length >= MAX_AGENTS}
            onClick={() => update({ ...request, agents: [...request.agents, newCard(request.agents, templates)] })}
          >
            Add agent
          </button>
          {request.agents.length >= MAX_AGENTS ? (
            <span className="hint">At most {MAX_AGENTS} agents.</span>
          ) : request.agents.length <= MIN_AGENTS ? (
            <span className="hint">A run needs at least {MIN_AGENTS} agents.</span>
          ) : null}
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

      {shownCard !== null ? (
        <AgentCardDialog
          title={`Agent ${request.agents[shownCard].id || `card ${shownCard + 1}`} · ${request.agents[shownCard].name || "(no name)"}`}
          subtitle={`Row ${shownCard + 1} of ${request.agents.length}. Changes apply to the table as you type.`}
          onClose={() => setOpenCard(null)}
          footer={
            <>
              <button type="button" className="btn" disabled={busy !== null} onClick={() => void validate()}>
                {busy === "validate" ? "Validating…" : "Validate setup"}
              </button>
              <span className={`validation validation-${validation}`}>
                {validation === "invalid"
                  ? `${problemsUnder(problems, `agents[${shownCard}]`).length} problem(s) on this agent, ${problems.length} in total.`
                  : validationText}
              </span>
            </>
          }
        >
          <AgentCardEditor
            card={request.agents[shownCard]}
            index={shownCard}
            problems={problems}
            models={modelList}
            defaultModelKey={request.default_model_key}
            runContext={request.context}
            canRemove={request.agents.length > MIN_AGENTS}
            inDialog
            onChange={(next) => setCard(shownCard, next)}
            onRemove={() => removeCard(shownCard)}
          />
        </AgentCardDialog>
      ) : null}
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
