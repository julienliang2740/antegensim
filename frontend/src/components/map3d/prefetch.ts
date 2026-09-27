/**
 * The 3D view's chunk gate: whether this browser can create a WebGL 2 context
 * (checked once, on a throwaway canvas) and the prefetch that starts the
 * three.js chunk download early (the view switch calls it on hover).  A plain
 * module, so the loader component file exports only components.
 */

// DOCS: hasWebgl2() is cached per page; prefetchMap3d() is a no-op without WebGL 2 and once the chunk is loaded.

let webgl2: boolean | null = null;

/** True when this browser can create a WebGL 2 context. */
export function hasWebgl2(): boolean {
  if (webgl2 === null) {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2");
      webgl2 = gl !== null;
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      webgl2 = false;
    }
  }
  return webgl2;
}

/** Start downloading the 3D view's chunk (no-op without WebGL 2 or once it is loaded). */
export function prefetchMap3d(): void {
  if (!hasWebgl2()) return;
  void import("./Map3dView").catch(() => undefined);
}
