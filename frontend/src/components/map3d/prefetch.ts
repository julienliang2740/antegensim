/**
 * Prefetch the CPU canvas board's view chunk when its switch is hovered.
 */

// DOCS: prefetchMap3d() loads the Canvas 2D board code on hover.

/** Start downloading the 3D view's chunk. */
export function prefetchMap3d(): void {
  void import("./Map3dView").catch(() => undefined);
}
