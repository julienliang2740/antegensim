/**
 * The assistant drawer (STUB from WP0; WP5 replaces this file).
 *
 * Rendered once by App.tsx as a sibling after the page, so it survives route
 * changes and RunPage remounts.  It receives the current route and reads the
 * page's published context and run handlers from state/assistantContext.ts
 * (useSyncExternalStore(subscribe, getSnapshot)).
 *
 * TODO(WP5): launcher (rail-header "Assistant" button on the run page, fixed
 * bottom-right pill elsewhere, Alt+A), docked panel at >= 1280 px on the run
 * page (useRunLayout reserveW + padding-right: var(--assistant-w)) and floating
 * elsewhere, conversations, composer with Dictate, brief cards, refs
 * linkified with state/assistantFormat.ts, Story Mode help on "#/story/...".
 */

import type { Route } from "../../hooks/useHashRoute";

export interface AssistantDrawerProps {
  /** The current hash route (App.tsx passes useHashRoute()). */
  route: Route;
}

/** Renders nothing yet; the props are the contract WP5 builds against. */
export function AssistantDrawer(_props: AssistantDrawerProps) {
  return null;
}
