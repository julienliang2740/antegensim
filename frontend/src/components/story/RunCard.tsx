/**
 * Step 0 of Story Mode (amended D8; OWNER: WP6): the deterministic run card
 * (cast, rounds and turns, deaths and kills, highlights) with the quick-pick
 * chips (genre, tone, vividness 1-5, point of view: chronicler or follow an
 * agent, chapter unit, turn range) and the "Story author" composer: free text
 * plus Dictate.  Nothing here calls a model; the submit button sends one
 * message (POST .../messages with the chips as picks) and the author answers
 * with the story brief.  The same card serves "Change" on a brief, with a
 * different heading and button.
 */

import { useId, useMemo } from "react";
import type { StoryRunCard } from "../../api/storyTypes";
import {
  CHAPTER_UNIT_OPTIONS,
  GENRE_OPTIONS,
  TONE_OPTIONS,
  VIVIDNESS_OPTIONS,
  estimateBoth,
  formatEstimate,
  modelTier,
  optionsWith,
  parsePov,
  povOptions,
  povValue,
  runCardSummary,
  turnLabel,
  validateTurnRange,
  type StoryChoices,
} from "../../state/storyMode";
import { DictateButton } from "../assistant/DictateButton";
import { ChipGroup } from "./Chips";

export interface RunCardProps {
  runId: string;
  card: StoryRunCard;
  /** Committed turn ids in commit order (GET /turns); null while loading or unavailable. */
  turnIds: string[] | null;
  choices: StoryChoices;
  onChoices(next: StoryChoices): void;
  text: string;
  onText(text: string): void;
  onSubmit(): void;
  /** A request is in flight (or the author is writing): controls are disabled. */
  busy: boolean;
  /** "Write the story brief" (step 0) or "Send the changes" (Change on a brief). */
  submitLabel: string;
  heading: string;
  /** Shown when the composer is for a change request (what the author will redo). */
  note?: string | null;
  onCancel?(): void;
}

export function RunCard(props: RunCardProps) {
  const { card, choices, turnIds, busy } = props;
  const textId = useId();
  const cast = useMemo(() => card.cast.map((c) => ({ id: c.agent_id, name: c.name })), [card.cast]);
  const pov = useMemo(() => povOptions(cast), [cast]);

  const range = useMemo(() => {
    if (!turnIds) return null;
    return validateTurnRange(choices.range, turnIds);
  }, [turnIds, choices.range]);
  const counts = range && range.ok ? range.counts : { agentTurns: card.turns, rounds: card.rounds };
  const estimates = estimateBoth(counts);
  const rangeSelectable = turnIds && turnIds.length > 0 ? turnIds : null;

  const update = (patch: Partial<StoryChoices>) => props.onChoices({ ...choices, ...patch });

  return (
    <section className="storymode-card" aria-labelledby={`${textId}-heading`}>
      <div className="storymode-card-head">
        <div>
          <span className="storymode-kicker">Step 0 · from the run's records, no model call</span>
          <h2 id={`${textId}-heading`}>{props.heading}</h2>
        </div>
        <span className="storymode-summary">{runCardSummary(card)}</span>
      </div>
      {card.parent ? (
        <p className="hint">
          A continuation of run <code>{String(card.parent.run_id ?? "")}</code> from turn <code>{String(card.parent.turn_id ?? "")}</code>: the opening will start with "Previously…".
        </p>
      ) : null}

      <h3>Cast</h3>
      <ul className="storymode-cast">
        {card.cast.map((member) => (
          <li key={member.agent_id} className={`storymode-cast-member${member.alive ? "" : " is-dead"}`} title={member.persona || undefined}>
            <div>
              <span className="storymode-cast-name">{member.name}</span> <code>{member.agent_id}</code>
            </div>
            <div className="storymode-cast-persona">{member.persona || "(no persona)"}</div>
            <div className="hint">
              {member.alive ? "living" : `died ${member.died_turn_id ? turnLabel(member.died_turn_id) : ""}`.trim()}
              {member.kills ? ` · ${member.kills} ${member.kills === 1 ? "kill" : "kills"}` : ""}
              {member.model_key ? ` · ${modelTier(member.model_key) || member.model_key}` : ""}
            </div>
          </li>
        ))}
      </ul>

      {card.highlights.length > 0 ? (
        <>
          <h3>Highlights</h3>
          <ul className="storymode-highlights">
            {card.highlights.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </>
      ) : null}

      <h3>Your choices</h3>
      <div className="storymode-picks">
        <ChipGroup label="Genre" options={optionsWith(GENRE_OPTIONS, choices.genre)} value={choices.genre} disabled={busy} onChange={(genre) => update({ genre })} />
        <ChipGroup label="Tone" options={optionsWith(TONE_OPTIONS, choices.tone)} value={choices.tone} disabled={busy} onChange={(tone) => update({ tone })} />
        <ChipGroup
          label="Vividness"
          options={VIVIDNESS_OPTIONS}
          value={choices.vividness}
          disabled={busy}
          onChange={(vividness) => update({ vividness })}
          hint={VIVIDNESS_OPTIONS.find((o) => o.value === choices.vividness)?.hint ?? null}
        />
        <ChipGroup label="Point of view" options={pov} value={povValue(choices.pov)} disabled={busy} onChange={(value) => update({ pov: parsePov(value) })} />
        <ChipGroup
          label="Chapters"
          options={CHAPTER_UNIT_OPTIONS}
          value={choices.unit}
          disabled={busy}
          onChange={(unit) => update({ unit })}
          hint={`Per turn: ${formatEstimate(estimates.turn)} · per round: ${formatEstimate(estimates.round)} (indicative; the brief gives the author's estimate)`}
        />
        <div className="storymode-chip-row">
          <span className="storymode-chips-label">Turn range</span>
          <div className="storymode-range">
            <label className="field">
              <span>From</span>
              <select value={choices.range.from ?? ""} disabled={busy || !rangeSelectable} onChange={(e) => update({ range: { ...choices.range, from: e.target.value || null } })}>
                <option value="">start of the run</option>
                {rangeSelectable?.map((id) => (
                  <option key={id} value={id}>
                    {turnLabel(id)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>To</span>
              <select value={choices.range.to ?? ""} disabled={busy || !rangeSelectable} onChange={(e) => update({ range: { ...choices.range, to: e.target.value || null } })}>
                <option value="">latest turn</option>
                {rangeSelectable?.map((id) => (
                  <option key={id} value={id}>
                    {turnLabel(id)}
                  </option>
                ))}
              </select>
            </label>
            {!turnIds ? <span className="hint">(turn list loading)</span> : null}
          </div>
          {range && !range.ok ? (
            <span className="storymode-error-note" role="alert">
              {range.problems.join(" ")}
            </span>
          ) : (
            <span className="hint storymode-estimate-line">
              Covers {counts.agentTurns} agent {counts.agentTurns === 1 ? "turn" : "turns"} in {counts.rounds} {counts.rounds === 1 ? "round" : "rounds"}.
            </span>
          )}
        </div>
      </div>

      <div className="storymode-composer">
        <label htmlFor={textId}>
          <strong>Story author</strong> <span className="hint">— anything else the author should know (a theme, whom to root for, what to leave out). Optional.</span>
        </label>
        <textarea
          id={textId}
          value={props.text}
          disabled={busy}
          maxLength={4000}
          placeholder="e.g. Tell it as a legend the survivors pass down; keep the deaths exactly as they happened."
          onChange={(e) => props.onText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !busy && (range === null || range.ok)) {
              e.preventDefault();
              props.onSubmit();
            }
          }}
        />
        {props.note ? <p className="hint">{props.note}</p> : null}
        <div className="storymode-composer-actions">
          <span className="hint">One author call ({modelTier("sonnet") || "Sonnet"} by default) writes the brief; nothing is generated until you accept it.</span>
          <DictateButton onText={(spoken) => props.onText(props.text ? `${props.text.replace(/\s+$/, "")} ${spoken}` : spoken)} runId={props.runId} ariaLabel="Dictate to the story author" disabledReason={busy ? "Wait for the author" : null} />
          {props.onCancel ? (
            <button type="button" className="btn" disabled={busy} onClick={props.onCancel}>
              Keep the brief
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" disabled={busy || (range !== null && !range.ok)} onClick={props.onSubmit} title="Ctrl/Cmd+Enter">
            {busy ? "Working…" : props.submitLabel}
          </button>
        </div>
      </div>
    </section>
  );
}
