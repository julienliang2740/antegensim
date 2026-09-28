/**
 * HelpTip: a small round "?" button that shows its explanation on hover or keyboard focus.
 * The text is also linked to the button with aria-describedby for screen readers.
 */

import { useId } from "react";
import type { ReactNode } from "react";

export interface HelpTipProps {
  /** Accessible name of the "?" button, e.g. "What is the persona tip?". */
  label: string;
  children: ReactNode;
}

export function HelpTip(props: HelpTipProps) {
  const id = useId();
  return (
    <span className="help-tip">
      <button type="button" className="help-tip-q" aria-label={props.label} aria-describedby={id}>
        ?
      </button>
      <span role="tooltip" id={id} className="help-tip-text">
        {props.children}
      </span>
    </span>
  );
}
