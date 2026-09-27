/**
 * Loads the 3D view on demand.  The only component the run page renders from
 * this folder: it checks once whether the browser can create a WebGL 2 context
 * (cached for the page's lifetime), shows the no-WebGL fallback without ever
 * requesting the three.js chunk, and otherwise mounts Map3dView through
 * React.lazy inside an error boundary and a Suspense fallback.  The WebGL
 * check and prefetchMap3d() live in ./prefetch.ts (re-exported by index.ts).
 */

// DOCS: the three.js chunk (Map3dView-<hash>.js) is requested only when the 3D view is chosen or hovered; no WebGL 2 -> data-webgl="unavailable" fallback with "Back to 2D map".

import { Suspense, lazy } from "react";
import { Map3dBoundary } from "./Map3dBoundary";
import { hasWebgl2 } from "./prefetch";
import type { Map3dProps } from "./props";

const Map3dView = lazy(() => import("./Map3dView"));

export function Map3dLoader(props: Map3dProps) {
  if (!hasWebgl2()) {
    return (
      <div className="map3d-fallback insp" role="alert" data-webgl="unavailable">
        {props.legendExtra}
        <p>This browser cannot draw the 3D view (WebGL 2 is unavailable). The 2D map keeps working.</p>
        <button type="button" className="insp-btn" onClick={props.onBackTo2d}>
          Back to 2D map
        </button>
      </div>
    );
  }
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
