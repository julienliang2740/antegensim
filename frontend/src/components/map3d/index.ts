/**
 * The 3D view's public surface for the run page: the lazy loader (the only
 * component RunPage renders), the prefetch hook of the view switch, the switch
 * itself and the prop types.  Nothing here imports three.js, so the run page's
 * bundle stays free of it until the 3D view is chosen.
 */

// DOCS: RunPage imports only Map3dLoader, MapViewSwitch and prefetchMap3d from here; nothing in this file pulls in three.js (Map3dView is loaded lazily by Map3dLoader).

export { Map3dLoader } from "./Map3dLoader";
export { prefetchMap3d } from "./prefetch";
export { MapViewSwitch } from "./MapViewSwitch";
export type { LayerInput, Map3dProps } from "./props";
