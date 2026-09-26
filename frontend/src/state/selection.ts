/**
 * Multi-select for tables (Resume page runs table): checkbox and row clicks with the usual
 * modifier keys, as pure functions so they are unit-tested in state.test.mjs.
 *
 *   - plain click on a checkbox: toggle that row, it becomes the anchor;
 *   - ctrl/cmd-click on a checkbox or on the row: toggle that row, it becomes the anchor;
 *   - shift-click (checkbox or row): add the contiguous range from the anchor to the clicked
 *     row, in the order shown; the anchor stays (without a shown anchor it behaves like a
 *     ctrl-click);
 *   - plain click on the row (not on a button, link or checkbox): select only that row.
 *
 * Selections are sets of ids and survive filtering: rows hidden by a filter stay selected, and
 * the header checkbox reflects only the shown rows (`headerState`, `toggleAllShown`).
 */

export type SelectionSource = "checkbox" | "row";

export interface SelectionModifiers {
  /** Ctrl on Windows/Linux, Cmd (metaKey) on macOS. */
  ctrl: boolean;
  shift: boolean;
  /** Where the click landed; a plain row click selects only that row. */
  source?: SelectionSource;
}

export interface SelectionResult {
  selection: ReadonlySet<string>;
  anchor: string | null;
}

function toggled(selection: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The selection and anchor after one click on row `clickedId` (see the module comment). */
export function applySelectionClick(
  currentSelection: ReadonlySet<string>,
  anchorId: string | null,
  clickedId: string,
  orderedIds: readonly string[],
  modifiers: SelectionModifiers,
): SelectionResult {
  const source = modifiers.source ?? "checkbox";
  if (modifiers.shift) {
    const from = anchorId === null ? -1 : orderedIds.indexOf(anchorId);
    const to = orderedIds.indexOf(clickedId);
    if (from >= 0 && to >= 0) {
      const next = new Set(currentSelection);
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      for (let i = lo; i <= hi; i += 1) next.add(orderedIds[i]);
      return { selection: next, anchor: anchorId };
    }
    return { selection: toggled(currentSelection, clickedId), anchor: clickedId };
  }
  if (modifiers.ctrl || source === "checkbox") {
    return { selection: toggled(currentSelection, clickedId), anchor: clickedId };
  }
  return { selection: new Set([clickedId]), anchor: clickedId };
}

export type HeaderCheckState = "none" | "some" | "all";

/** The header checkbox for the shown rows: "all" (checked), "some" (indeterminate) or "none". */
export function headerState(selection: ReadonlySet<string>, shownIds: readonly string[]): HeaderCheckState {
  if (shownIds.length === 0) return "none";
  const count = shownIds.filter((id) => selection.has(id)).length;
  if (count === 0) return "none";
  return count === shownIds.length ? "all" : "some";
}

/** Header checkbox click: select every shown row, or clear the shown rows when all already are.
 * Selected rows hidden by the filter are kept either way. */
export function toggleAllShown(selection: ReadonlySet<string>, shownIds: readonly string[]): Set<string> {
  const next = new Set(selection);
  if (headerState(selection, shownIds) === "all") {
    for (const id of shownIds) next.delete(id);
  } else {
    for (const id of shownIds) next.add(id);
  }
  return next;
}

/** Drop ids that no longer exist (after a reload); the same set object when nothing changed. */
export function pruneSelection(selection: ReadonlySet<string>, existingIds: readonly string[]): ReadonlySet<string> {
  const existing = new Set(existingIds);
  const kept = [...selection].filter((id) => existing.has(id));
  return kept.length === selection.size ? selection : new Set(kept);
}

/** Selected ids in the given order (for the actions and the dialog list). */
export function selectedInOrder(selection: ReadonlySet<string>, orderedIds: readonly string[]): string[] {
  return orderedIds.filter((id) => selection.has(id));
}
