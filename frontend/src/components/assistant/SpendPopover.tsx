/**
 * The spend indicator ("$0.12 of $5") and its popover: per-profile spend of
 * the scope, the limits that apply (chat per scope, storybook per run, global
 * cap) and, for a run, editable limits saved with PUT
 * /api/runs/{run}/assistant/settings.  Raising a limit is a direct control,
 * never a brief.
 *
 * DOCS: amounts are list-price estimates (the CLI's reported cost, or tokens
 * priced from a table when it reports none); nothing here touches the run's
 * own real_usage ledger (the agents' economy).
 */

import { useEffect, useRef, useState } from "react";
import { putAssistantSettings } from "../../api/assistant";
import type { BudgetView, SpendView } from "../../api/assistantTypes";
import { errorText } from "../../state/runSessions";
import { formatUsd } from "../../state/assistantBrief";

export interface SpendPopoverProps {
  spend: SpendView | null;
  /** The run whose limits are editable (null on the global scope). */
  runId: string | null;
  runName: string | null;
  /** Bump to open the popover from outside (a "Raise limit" action). */
  openRequest?: number;
  onChanged(): void;
}

const PROFILE_LABELS: Record<string, string> = {
  chat: "Chat (the drawer)",
  narrator: "Storybook narrator",
  author: "Story author",
  summarizer: "Summaries",
};

function limitText(view: BudgetView): string {
  return `${formatUsd(view.spent_usd)} of ${formatUsd(view.limit_usd)}`;
}

export function SpendIndicator(props: SpendPopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const openRequest = props.openRequest ?? 0;
  const [seenRequest, setSeenRequest] = useState(openRequest);
  if (openRequest !== seenRequest) {
    setSeenRequest(openRequest);
    setOpen(true);
  }
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const chat = props.spend?.chat ?? null;
  const exhausted = !!(chat?.exhausted || props.spend?.overall.exhausted);
  const label = chat ? limitText(chat) : "spend";
  return (
    <div className="assistant-spend" ref={rootRef}>
      <button
        type="button"
        className={`assistant-chip assistant-spend-btn${exhausted ? " assistant-chip-bad" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Assistant spend (list-price estimate) and limits"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">◔</span> {label}
      </button>
      {open ? <SpendPanel {...props} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function SpendPanel(props: SpendPopoverProps & { onClose(): void }) {
  const spend = props.spend;
  const [chatLimit, setChatLimit] = useState(spend ? String(spend.chat.limit_usd) : "");
  const [storybookLimit, setStorybookLimit] = useState(spend?.storybook ? String(spend.storybook.limit_usd) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const save = async () => {
    if (!props.runId) return;
    const chat = Number(chatLimit);
    const storybook = storybookLimit === "" ? null : Number(storybookLimit);
    if (!Number.isFinite(chat) || chat < 0 || (storybook !== null && (!Number.isFinite(storybook) || storybook < 0))) {
      setError("Limits must be numbers of USD, 0 or more.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await putAssistantSettings(props.runId, { chat_budget_usd: chat, storybook_budget_usd: storybook });
      setSaved(`Saved: chat limit ${formatUsd(chat)}${storybook !== null ? `, storybook limit ${formatUsd(storybook)}` : ""}.`);
      props.onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const profiles = Object.entries(spend?.by_profile ?? {});
  return (
    <div className="assistant-popover" role="dialog" aria-label="Assistant spend and limits">
      <div className="assistant-popover-head">
        <strong>Spend (list-price estimate)</strong>
        <button type="button" className="btn btn-small" onClick={props.onClose}>
          Close
        </button>
      </div>
      {!spend ? (
        <p className="hint">No spend information yet (the assistant did not answer the capabilities request).</p>
      ) : (
        <>
          <table className="assistant-table">
            <tbody>
              <tr>
                <th scope="row">Chat, {props.runId ? `this run${props.runName ? ` (${props.runName})` : ""}` : "home pages"}</th>
                <td>{limitText(spend.chat)}</td>
              </tr>
              {spend.storybook ? (
                <tr>
                  <th scope="row">Storybook, this run</th>
                  <td>{limitText(spend.storybook)}</td>
                </tr>
              ) : null}
              <tr>
                <th scope="row">All assistant use, every run</th>
                <td>{limitText(spend.overall)}</td>
              </tr>
            </tbody>
          </table>
          {profiles.length > 0 ? (
            <>
              <div className="assistant-popover-sub">By profile</div>
              <table className="assistant-table">
                <tbody>
                  {profiles.map(([profile, p]) => (
                    <tr key={profile}>
                      <th scope="row">{PROFILE_LABELS[profile] ?? profile}</th>
                      <td>
                        {p.calls} call{p.calls === 1 ? "" : "s"} · {formatUsd(p.cost_usd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          {props.runId ? (
            <div className="assistant-limits">
              <div className="assistant-popover-sub">Limits of this run (USD)</div>
              <label className="assistant-limit-field">
                <span>Chat</span>
                <input type="number" min={0} step={0.5} value={chatLimit} onChange={(e) => setChatLimit(e.target.value)} />
              </label>
              <label className="assistant-limit-field">
                <span>Storybook</span>
                <input type="number" min={0} step={0.5} value={storybookLimit} placeholder="unchanged" onChange={(e) => setStorybookLimit(e.target.value)} />
              </label>
              <div className="assistant-limit-actions">
                <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void save()}>
                  {busy ? "Saving…" : "Save limits"}
                </button>
                {spend.chat.exhausted ? (
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={busy}
                    onClick={() => {
                      setChatLimit(String(Math.ceil(spend.chat.limit_usd + 2)));
                    }}
                  >
                    Raise to {formatUsd(Math.ceil(spend.chat.limit_usd + 2))}
                  </button>
                ) : null}
              </div>
              {error ? <div className="error-inline">{error}</div> : null}
              {saved ? <div className="hint">{saved}</div> : null}
            </div>
          ) : (
            <p className="hint">Home-page limits come from the backend configuration (EMPYREAN_ASSISTANT_CHAT_BUDGET_USD, EMPYREAN_ASSISTANT_GLOBAL_BUDGET_USD). Per-run limits are editable on a run page.</p>
          )}
        </>
      )}
    </div>
  );
}
