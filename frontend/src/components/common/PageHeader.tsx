/** Page title with a "Back to sessions" button (every page except the entry page). */

import type { ReactNode } from "react";
import { navigate } from "../../hooks/useHashRoute";

export function PageHeader(props: { title: string; subtitle?: ReactNode; back?: boolean }) {
  return (
    <header className="page-header">
      <div>
        <h1>{props.title}</h1>
        {props.subtitle ? <div className="page-subtitle">{props.subtitle}</div> : null}
      </div>
      {props.back === false ? null : (
        <button type="button" className="btn" onClick={() => navigate({ name: "entry" })}>
          Back to sessions
        </button>
      )}
    </header>
  );
}
