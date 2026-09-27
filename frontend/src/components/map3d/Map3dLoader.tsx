/**
 * Loads the 3D view on demand.  The only component the run page renders from
 * this folder: it mounts the CPU canvas board through React.lazy inside an
 * error boundary and a Suspense fallback.
 */

// DOCS: the Canvas 2D board chunk is requested only when the 3D view is chosen or hovered.

import { Suspense, lazy } from "react";
import { Map3dBoundary } from "./Map3dBoundary";
import type { Map3dProps } from "./props";

const Map3dView = lazy(() => import("./Map3dView"));

export function Map3dLoader(props: Map3dProps) {
  return (
    <Map3dBoundary onBackTo2d={props.onBackTo2d} legendExtra={props.legendExtra}>
      {/* No switch in the loading line: it lasts under a second, and a copy here would take the
          keyboard focus handed over by the switch and drop it when the view replaces it. */}
      <Suspense fallback={<p className="hint map3d-loading">Loading the 3D view…</p>}>
        <Map3dView {...props} />
      </Suspense>
    </Map3dBoundary>
  );
}
