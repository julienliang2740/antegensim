/**
 * On-demand detail view of a decision packet or a model call record (spec
 * "Budget delivery and inspection": persist and expose the exact request,
 * selected memory ids, notebook version, token usage and omission reasons;
 * "Display and historical inspection": load historical details on demand).
 *
 * Shown inline above the tabs (not a blocking overlay) so the map, the
 * controls and the log stay usable; Escape or "Close" hides it (the page
 * then returns focus and scroll to the button that opened it).
 *
 * "Model call in progress" follows the run: once status.pending_model_call
 * no longer names the watched call, the viewer loads the call's saved record
 * (turn id taken from the call id, INTERFACES section 3) and switches to it.
 * If the turn is not saved yet (still finishing, or failed and waiting for its
 * re-run) it says so and retries at every commit.
 */

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { getDecisionPacket, getModelCall, getPendingModelCall, getTurn } from "../../api/client";
import type { DecisionPacketRecord, ModelCallRecord, ModelCallSummary, PendingModelCallView, RunState, TurnView } from "../../api/types";
import { useFetched } from "../../hooks/useFetched";
import { withReopen } from "../../state/runSessions";
import { ErrorLine, JsonBlock } from "../common/Problems";
import { targetKey, turnIdOfCallId } from "../../state/records";
import type { RecordTarget } from "../../state/records";

type Loaded = { kind: "packet"; packet: DecisionPacketRecord } | { kind: "call"; call: ModelCallRecord } | { kind: "pending"; view: PendingModelCallView };

export interface RecordViewerProps {
  runId: string;
  target: RecordTarget;
  /** The turn shown in the map/inspector (its model calls link a packet to its calls). */
  viewedTurn: TurnView | null;
  /** status.pending_model_call?.call_id: the call the run is waiting for now. */
  pendingCallId: string | null;
  /** status.current_turn_id: a finished call's record is retried at every commit. */
  savedTurnId: string;
  runState: RunState;
  onOpen(target: RecordTarget): void;
  onClose(): void;
}

export function RecordViewer(props: RecordViewerProps) {
  const { runId, target } = props;
  const key = targetKey(target);
  const loaded = useFetched<Loaded>(key, async () => {
    if (target.kind === "packet") return { kind: "packet", packet: await getDecisionPacket(runId, target.turnId, target.packetId) };
    if (target.kind === "call") return { kind: "call", call: await getModelCall(runId, target.turnId, target.callId) };
    return { kind: "pending", view: await withReopen(runId, () => getPendingModelCall(runId)) };
  });
  const { onClose } = props;
  // A packet of another turn: load that turn's call list so the packet can link to its calls.
  const packetTurnId = target.kind === "packet" ? target.turnId : null;
  const needsTurn = packetTurnId !== null && props.viewedTurn?.turn.turn_id !== packetTurnId;
  const otherTurn = useFetched<TurnView>(needsTurn ? packetTurnId : null, () => getTurn(runId, packetTurnId ?? ""));
  const turnCalls: ModelCallSummary[] = !needsTurn
    ? (props.viewedTurn?.model_calls ?? [])
    : otherTurn.dataKey === packetTurnId && otherTurn.data
      ? otherTurn.data.model_calls
      : [];
  const sectionRef = useRef<HTMLElement | null>(null);
  // Scroll to the viewer when the operator opens a record, not when it switches by itself (a finished call).
  const autoSwitched = target.kind === "call" && !!target.note;
  useEffect(() => {
    if (!autoSwitched) sectionRef.current?.scrollIntoView({ block: "nearest" });
  }, [key, autoSwitched]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title =
    target.kind === "packet" ? `Decision packet ${target.packetId}` : target.kind === "call" ? `Model call ${target.callId}` : "Model call in progress";
  const data = loaded.dataKey === key ? loaded.data : null;

  // "In progress" view: has the watched call finished?  Then load its saved record and switch to it.
  const watchedCallId = target.kind === "pending" && data?.kind === "pending" ? data.view.record.call_id : null;
  const watchedTurnId = watchedCallId ? turnIdOfCallId(watchedCallId) : null;
  const callFinished = watchedCallId !== null && props.pendingCallId !== watchedCallId;
  const savedKey = callFinished && watchedTurnId ? `${watchedCallId}@${props.savedTurnId}` : null;
  const saved = useFetched<ModelCallRecord>(savedKey, () => getModelCall(runId, watchedTurnId ?? "", watchedCallId ?? ""));
  const savedRecord = saved.dataKey === savedKey ? saved.data : null;
  const { onOpen } = props;
  useEffect(() => {
    if (savedRecord) {
      onOpen({ kind: "call", turnId: savedRecord.turn_id, callId: savedRecord.call_id, note: "The call that was in progress has finished; this is its saved record." });
    }
  }, [savedRecord, onOpen]);

  return (
    <section className="record-viewer" aria-label={title} ref={sectionRef}>
      <div className="record-head">
        <strong>{title}</strong>
        {target.kind !== "pending" ? (
          <span className="hint">
            {" "}
            of turn <code>{target.turnId}</code>
          </span>
        ) : null}
        <button type="button" className="btn" onClick={props.onClose}>
          Close record view
        </button>
      </div>
      {loaded.loading && !data ? <p className="hint">Fetching the record…</p> : null}
      {target.kind === "pending" && loaded.error && !data ? (
        <p className="hint">No model call is in progress now (it may have just finished). Open its record from the turn record or the agent's inspector.</p>
      ) : (
        <ErrorLine text={loaded.error} prefix="Could not load:" />
      )}
      {target.kind === "call" && target.note ? <div className="record-note">{target.note}</div> : null}
      {target.kind === "pending" && data?.kind === "pending" && !callFinished ? (
        <div className="record-note">Waiting for the model. This view switches to the saved record when the call finishes.</div>
      ) : null}
      {callFinished && !savedRecord ? (
        <div className="record-note record-note-warn">
          This call has finished; its record is saved with turn <code>{watchedTurnId ?? "?"}</code>.{" "}
          {props.runState === "error" || props.runState === "paused"
            ? "That turn has not been saved yet (the attempt failed): the record is carried into the re-run and opens once the turn is saved."
            : saved.loading
              ? "Loading the saved record…"
              : "The turn is still finishing; the saved record opens as soon as it commits."}{" "}
          {watchedTurnId && watchedCallId ? (
            <button type="button" className="btn btn-small" onClick={saved.reload}>
              Try to open the saved record
            </button>
          ) : null}
          {saved.error && !saved.loading ? <span className="hint"> (not found yet)</span> : null}
        </div>
      ) : null}
      {data?.kind === "packet" ? (
        <PacketView packet={data.packet} calls={turnCalls.filter((c) => c.packet_id === data.packet.packet_id)} onOpen={props.onOpen} />
      ) : null}
      {data?.kind === "call" ? <ModelCallView call={data.call} onOpen={props.onOpen} /> : null}
      {data?.kind === "pending" && !callFinished ? (
        <>
          <ModelCallView call={data.view.record} onOpen={props.onOpen} />
          {data.view.packet ? <PacketView packet={data.view.packet} calls={[]} onOpen={props.onOpen} /> : null}
        </>
      ) : null}
    </section>
  );
}

/** Display rounding only (the stored record keeps full precision). */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/** "$0.005464": six decimals, trailing zeros trimmed down to four (no floating-point noise). */
function usd(value: number): string {
  const text = value.toFixed(6).replace(/(\.\d{4}\d*?)0+$/, "$1");
  return `$${text}`;
}

function Facts(props: { rows: [string, ReactNode][] }) {
  return (
    <table className="facts">
      <tbody>
        {props.rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PacketView(props: { packet: DecisionPacketRecord; calls: ModelCallSummary[]; onOpen(target: RecordTarget): void }) {
  const p = props.packet;
  const s = p.effective_settings;
  return (
    <div className="packet-view">
      <Facts
        rows={[
          ["agent", <code key="agent">{p.agent_id}</code>],
          ["round / turn", `${p.round} / ${p.turn_id}`],
          [
            "affordable",
            p.affordable ? (
              "yes"
            ) : (
              <span key="affordable" className="text-bad">
                no — {p.unaffordable_reason}
              </span>
            ),
          ],
          ["input token estimate", `${p.input_token_estimate} (incl. ${p.overhead_tokens} request overhead)`],
          ["generation allowance", String(p.generation_allowance)],
          ["reserved compute (bound only)", num(p.reservation_compute)],
          ["notebook version", String(p.notebook_version)],
          [
            "effective settings",
            `input cap ${s.input_token_cap}, generation ${s.generation_allowance}, recent history ${s.recent_history_length}, notebook ${s.notebook_max_tokens}, retrieved ${s.retrieved_memory_limit}, digest ${s.new_event_digest_limit}, weights r${s.weights.relevance}/c${s.weights.recency}/i${s.weights.importance}, skill source ${s.include_skill_source ? "yes" : "no"}`,
          ],
          ["selected records", p.selected_record_ids.length ? p.selected_record_ids.join(", ") : "none"],
          ["unread shown (digest)", p.digest_record_ids.length ? p.digest_record_ids.join(", ") : "none"],
          [
            "omitted (counts)",
            Object.keys(p.omitted_counts).length
              ? Object.entries(p.omitted_counts)
                  .map(([reason, n]) => `${reason}: ${n}`)
                  .join(", ")
              : "nothing omitted",
          ],
          ["created", p.created_at],
        ]}
      />
      {props.calls.length > 0 ? (
        <div className="record-links">
          {props.calls.map((c) => (
            <button
              key={c.call_id}
              type="button"
              className="btn btn-small"
              onClick={() => props.onOpen({ kind: "call", turnId: p.turn_id, callId: c.call_id })}
            >
              Open model call {c.call_id}
            </button>
          ))}
        </div>
      ) : null}
      <h4>Sections in the order the model saw them</h4>
      {p.sections.map((section) => (
        <details key={section.name} className="packet-section" open={section.name !== "stable_rules"}>
          <summary>
            <code>{section.name}</code> — ~{section.token_estimate} tokens{section.record_ids.length ? `, records ${section.record_ids.join(", ")}` : ""}
          </summary>
          <pre className="text-block">{section.text}</pre>
        </details>
      ))}
      {p.omitted.length > 0 ? (
        <details className="packet-section">
          <summary>Omitted records ({p.omitted.length} listed)</summary>
          <table className="data-table">
            <thead>
              <tr>
                <th>record</th>
                <th>reason</th>
                <th>score</th>
              </tr>
            </thead>
            <tbody>
              {p.omitted.map((o) => (
                <tr key={`${o.record_id}-${o.reason}`}>
                  <td>
                    <code>{o.record_id}</code>
                  </td>
                  <td>{o.reason}</td>
                  <td>{o.score === null ? "" : o.score.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
      <details className="packet-section">
        <summary>Exact messages sent ({p.messages.length})</summary>
        {p.messages.map((m, i) => (
          <div key={i}>
            <div className="hint">
              message {i + 1}: <strong>{m.role}</strong>
            </div>
            <pre className="text-block">{m.content}</pre>
          </div>
        ))}
      </details>
      <details className="packet-section">
        <summary>Situation (structured)</summary>
        <JsonBlock value={p.situation} maxHeight={360} />
      </details>
    </div>
  );
}

export function ModelCallView(props: { call: ModelCallRecord; onOpen(target: RecordTarget): void }) {
  const c = props.call;
  const r = c.result;
  const u = r?.usage;
  const pending = c.status === "pending";
  const waiting = "waiting for the reply";
  return (
    <div className="call-view">
      <Facts
        rows={[
          ["agent", <code key="agent">{c.agent_id}</code>],
          ["status", `${c.status}${r ? ` (result: ${r.status})` : pending ? " (the model has not answered yet)" : ""}`],
          ["model", `${c.model_key} — ${c.provider}/${c.model_id}${r?.response_model ? `, served by ${r.response_model}` : ""}`],
          ["started / finished", `${c.started_at} / ${c.finished_at ?? (pending ? "still running" : "not finished")}`],
          ["latency", r ? `${r.latency_ms.toFixed(1)} ms over ${r.attempts} attempt(s)` : pending ? "pending" : "—"],
          [
            "usage (tokens)",
            u
              ? `input ${u.input_tokens}, cache read ${u.cache_read_tokens}, cache write ${u.cache_creation_tokens}, output ${u.output_tokens}` +
                (u.reasoning_tokens > 0 ? ` (of which reasoning ${u.reasoning_tokens})` : "") +
                `, billed input ${u.billed_input_tokens} (source: ${u.source})`
              : pending
                ? waiting
                : "—",
          ],
          [
            "world compute",
            `reserved ${num(c.reservation_compute)}, charged ${num(c.charged_compute)}, uncharged ${num(c.uncharged_compute)}, mind multiplier ${num(c.mind_multiplier)}`,
          ],
          ["provider cost", r?.provider_cost_usd !== null && r?.provider_cost_usd !== undefined ? usd(r.provider_cost_usd) : pending ? waiting : "not reported"],
          ["stop reason", r?.stop_reason ?? "—"],
          ["error", c.error ?? r?.error ?? "none"],
          ["attempt errors", r && r.attempt_errors.length ? r.attempt_errors.join(" | ") : "none"],
          ["request", `max output ${c.request.max_output_tokens} tokens, timeout ${c.request.timeout_seconds}s per attempt, ${c.request.max_retries} retries`],
        ]}
      />
      {c.packet_id ? (
        <div className="record-links">
          <button type="button" className="btn btn-small" onClick={() => props.onOpen({ kind: "packet", turnId: c.turn_id, packetId: c.packet_id ?? "" })}>
            Open decision packet {c.packet_id}
          </button>
        </div>
      ) : null}
      <h4>Model output (as returned)</h4>
      <pre className="text-block">{r?.text ?? (pending ? `(${waiting})` : "(no text)")}</pre>
      {r?.parsed ? (
        <details className="packet-section" open>
          <summary>Parsed JSON</summary>
          <JsonBlock value={r.parsed} maxHeight={300} />
        </details>
      ) : null}
      <details className="packet-section">
        <summary>Request messages ({c.request.messages.length})</summary>
        {c.request.messages.map((m, i) => (
          <div key={i}>
            <div className="hint">
              message {i + 1}: <strong>{m.role}</strong>
            </div>
            <pre className="text-block">{m.content}</pre>
          </div>
        ))}
      </details>
      <details className="packet-section">
        <summary>Model reference snapshot (no secrets)</summary>
        <JsonBlock value={c.ref_snapshot} maxHeight={260} />
      </details>
    </div>
  );
}
