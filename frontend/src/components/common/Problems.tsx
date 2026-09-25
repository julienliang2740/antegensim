/**
 * Validation problems from the backend (ApiProblem: path + message), shown
 * as a summary list with paths and next to the offending field.
 */

import type { ApiProblem } from "../../api/types";

export function ProblemSummary(props: { problems: readonly ApiProblem[]; title: string }) {
  if (props.problems.length === 0) return null;
  return (
    <div className="problems" role="alert">
      <strong>{props.title}</strong>
      <ul>
        {props.problems.map((p, i) => (
          <li key={i}>
            {p.path ? <code className="problem-path">{p.path}</code> : <code className="problem-path">(whole setup)</code>}: {p.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Messages for one field, shown under it (with the path, so it can be matched to the summary). */
export function FieldProblems(props: { problems: readonly ApiProblem[] }) {
  if (props.problems.length === 0) return null;
  return (
    <div className="field-problems">
      {props.problems.map((p, i) => (
        <div key={i}>
          <code className="problem-path">{p.path}</code>: {p.message}
        </div>
      ))}
    </div>
  );
}

/** A short error line (network or API failure). */
export function ErrorLine(props: { text: string | null | undefined; prefix?: string }) {
  if (!props.text) return null;
  return (
    <div className="error-line" role="alert">
      {props.prefix ? <strong>{props.prefix} </strong> : null}
      {props.text}
    </div>
  );
}

/** Pretty JSON in a scrollable block. */
export function JsonBlock(props: { value: unknown; maxHeight?: number }) {
  let text: string;
  try {
    text = JSON.stringify(props.value, null, 2) ?? String(props.value);
  } catch {
    text = String(props.value);
  }
  return (
    <pre className="json-block" style={props.maxHeight ? { maxHeight: props.maxHeight } : undefined}>
      {text}
    </pre>
  );
}
