/**
 * The assistant launchers: the fixed bottom-right pill used on the .page
 * routes (hidden while the drawer is open) and the compact rail-header button
 * the run page mounts next to "Back to sessions".  Both toggle the drawer
 * through the shared store and show the status dot from the capabilities
 * (ready / fake model / model offline / assistant unavailable).
 *
 * DOCS: control label "Assistant"; shortcut Alt+A toggles the drawer from
 * anywhere.  data-control="assistant-launcher" lets answers flash it.
 */

import { useSyncExternalStore } from "react";
import type { AssistantStatus } from "../../state/assistantContext";
import { getDrawerState, setDrawerState, subscribeDrawer } from "../../state/assistantContext";

export const LAUNCHER_TITLE = "Ask about the world, the controls, or what is happening; it can also set up and run things for you (with your approval). Alt+A";

const STATUS_TEXT: Record<AssistantStatus, string> = {
  unknown: "checking the assistant…",
  ready: "assistant ready",
  fake: "assistant ready (fake model: free, canned answers)",
  offline: "AI model offline: answers come from the docs only",
  unavailable: "assistant not available in this backend",
};

export function StatusDot(props: { status: AssistantStatus }) {
  return <span className={`assistant-dot assistant-dot-${props.status}`} title={STATUS_TEXT[props.status]} aria-label={STATUS_TEXT[props.status]} role="img" />;
}

/** Fixed pill (bottom-right) for pages without a rail; renders nothing while the drawer is open. */
export function LauncherPill() {
  const drawer = useSyncExternalStore(subscribeDrawer, getDrawerState, getDrawerState);
  if (drawer.open) return null;
  return (
    <button
      type="button"
      className="assistant-pill"
      data-control="assistant-launcher"
      title={LAUNCHER_TITLE}
      aria-label="Open the assistant"
      aria-keyshortcuts="Alt+A"
      onClick={() => setDrawerState({ open: true })}
    >
      <span className="assistant-pill-icon" aria-hidden="true">
        ✦
      </span>
      Assistant
      <StatusDot status={drawer.status} />
    </button>
  );
}

/** Compact toggle for the run page's rail header. */
export function LauncherButton(props: { className?: string }) {
  const drawer = useSyncExternalStore(subscribeDrawer, getDrawerState, getDrawerState);
  return (
    <button
      type="button"
      className={`btn btn-small assistant-rail-btn${drawer.open ? " assistant-rail-btn-open" : ""}${props.className ? ` ${props.className}` : ""}`}
      data-control="assistant-launcher"
      title={LAUNCHER_TITLE}
      aria-pressed={drawer.open}
      aria-keyshortcuts="Alt+A"
      onClick={() => setDrawerState({ open: !drawer.open })}
    >
      <span aria-hidden="true">✦</span> Assistant <StatusDot status={drawer.status} />
    </button>
  );
}
