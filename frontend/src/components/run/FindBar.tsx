/**
 * Entity lookup by id and coordinate lookup (spec "Display and historical
 * inspection": simple map navigation and coordinate lookup; the operator
 * should not need to view the entire plane at once).
 */

import { useState } from "react";
import type { Point } from "../../api/types";
import { parseCoordinate } from "../../state/points";

export interface FindBarProps {
  /** Select an entity by id; returns an error message when it is unknown. */
  onFindEntity(id: string): string | null;
  /** Select a point; returns an error message when it is outside the region. */
  onFindPoint(p: Point): string | null;
}

export function FindBar(props: FindBarProps) {
  const [entityText, setEntityText] = useState("");
  const [pointText, setPointText] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const findEntity = () => {
    const id = entityText.trim();
    if (!id) return setMessage("Type an entity id such as a05 or p0003.");
    setMessage(props.onFindEntity(id));
  };
  const findPoint = () => {
    const p = parseCoordinate(pointText);
    if (!p) return setMessage(`"${pointText}" is not a coordinate; type it as x,y (for example 3,-2).`);
    setMessage(props.onFindPoint(p));
  };

  return (
    <div className="find-bar">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          findEntity();
        }}
      >
        <label htmlFor="find-entity">Find entity by id</label>
        <input id="find-entity" type="text" value={entityText} placeholder="e.g. a05 or p0003" onChange={(e) => setEntityText(e.target.value)} />
        <button type="submit" className="btn btn-small">
          Select entity
        </button>
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          findPoint();
        }}
      >
        <label htmlFor="find-point">Coordinate (x,y)</label>
        <input id="find-point" type="text" value={pointText} placeholder="e.g. 3,-2" onChange={(e) => setPointText(e.target.value)} />
        <button type="submit" className="btn btn-small">
          Select point
        </button>
      </form>
      {message ? <span className="error-inline">{message}</span> : null}
    </div>
  );
}
