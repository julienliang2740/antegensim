/**
 * Quick-pick chips for Story Mode's step 0 (genre, tone, vividness, point of
 * view, chapter unit): a labelled group of toggle buttons with exactly one
 * selected.  OWNER: WP6.
 */

import type { ChipOption } from "../../state/storyMode";

export function ChipGroup<T extends string | number>(props: {
  label: string;
  options: ChipOption<T>[];
  value: T;
  onChange(value: T): void;
  disabled?: boolean;
  /** A line under the chips (what the selection means). */
  hint?: string | null;
}) {
  return (
    <div className="storymode-chip-row">
      <span className="storymode-chips-label">{props.label}</span>
      <div className="storymode-chips" role="group" aria-label={props.label}>
        {props.options.map((option) => {
          const selected = option.value === props.value;
          return (
            <button
              key={String(option.value)}
              type="button"
              className={`chip storymode-chip${selected ? " is-selected" : ""}`}
              aria-pressed={selected}
              title={option.hint}
              disabled={props.disabled}
              onClick={() => props.onChange(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {props.hint ? <span className="hint">{props.hint}</span> : null}
    </div>
  );
}
