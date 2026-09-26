/**
 * Sizes of the run page's adjustable panels (left rail, right column, log)
 * set with the drag splitters, remembered in localStorage and clamped to the
 * window so the map always keeps at least MIN_MAP_W pixels.  Null = the
 * default size.  Used only by the three-column layout (window >= 1200 px).
 *
 * `reserveW` (rev 4): pixels the docked assistant drawer takes on the right
 * (state/assistantContext.dockReserve); it is subtracted from the window width
 * before the clamps so the map keeps MIN_MAP_W beside the drawer, and returned
 * as `reservedW` for the page's --assistant-w padding.
 */

import { useCallback, useEffect, useState } from "react";

export interface PanelSizes {
  railW: number | null;
  sideW: number | null;
  /** Right column width while it is wide (God mode, Rules, "Wider panel"). */
  sideWideW: number | null;
  logH: number | null;
}

export const MIN_RAIL_W = 200;
export const MAX_RAIL_W = 480;
export const MIN_SIDE_W = 300;
export const MIN_MAP_W = 360;
export const MIN_LOG_H = 120;
/** Room kept for the tabs above the log. */
const MIN_TABS_H = 200;
/** Page padding plus the two splitters. */
const CHROME_W = 20 + 16;
const THREE_COLUMN_MIN_W = 1200;
const STORAGE_KEY = "empyrean.runLayout.v1";
const EMPTY: PanelSizes = { railW: null, sideW: null, sideWideW: null, logH: null };

function load(): PanelSizes {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Record<keyof PanelSizes, unknown>>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return { railW: num(parsed.railW), sideW: num(parsed.sideW), sideWideW: num(parsed.sideWideW), logH: num(parsed.logH) };
  } catch {
    return EMPTY;
  }
}

function save(sizes: PanelSizes): void {
  try {
    if (Object.values(sizes).every((v) => v === null)) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
  } catch {
    // Storage blocked: sizes still apply for this page.
  }
}

export interface RunLayout {
  /** True when the three-column layout (and the splitters) is in use. */
  threeColumn: boolean;
  railW: number;
  sideW: number;
  logH: number;
  railMax: number;
  sideMax: number;
  logMax: number;
  setRailW(v: number): void;
  setSideW(v: number): void;
  setLogH(v: number): void;
  /** Back to the default size of one panel (double-click on its splitter). */
  resetPart(part: "rail" | "side" | "log"): void;
  reset(): void;
  /** Pixels reserved on the right for the docked assistant drawer (0 when floating or closed). */
  reservedW: number;
}

export function useRunLayout(sideWide: boolean, reserveW = 0): RunLayout {
  const [sizes, setSizes] = useState<PanelSizes>(load);
  const [win, setWin] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setWin({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => save(sizes), [sizes]);

  // The docked drawer takes room from the window before anything is clamped.
  const reservedW = Math.max(0, Math.min(Math.round(reserveW), win.w));
  const pageW = win.w - reservedW;
  const large = pageW >= 1560;
  const defaultRail = large ? 268 : 252;
  const defaultSide = large ? 440 : 390;
  const defaultWide = Math.round(Math.min(620, pageW * 0.44));
  const defaultLog = Math.round(win.h * 0.36);

  // Clamp: the map keeps MIN_MAP_W; the right column gives way first, then the rail.
  const spare = pageW - CHROME_W - MIN_MAP_W;
  const railW = Math.max(MIN_RAIL_W, Math.min(MAX_RAIL_W, sizes.railW ?? defaultRail, spare - MIN_SIDE_W));
  const sideMax = Math.max(MIN_SIDE_W, spare - railW);
  const wanted = sideWide ? (sizes.sideWideW ?? Math.max(defaultWide, sizes.sideW ?? defaultSide)) : (sizes.sideW ?? defaultSide);
  const sideW = Math.max(MIN_SIDE_W, Math.min(sideMax, wanted));
  const railMax = Math.max(MIN_RAIL_W, Math.min(MAX_RAIL_W, spare - sideW));
  const logMax = Math.max(MIN_LOG_H, win.h - MIN_TABS_H - 24);
  const logH = Math.max(MIN_LOG_H, Math.min(logMax, sizes.logH ?? defaultLog));

  const setRailW = useCallback((v: number) => setSizes((s) => ({ ...s, railW: Math.round(v) })), []);
  const setSideW = useCallback((v: number) => setSizes((s) => (sideWide ? { ...s, sideWideW: Math.round(v) } : { ...s, sideW: Math.round(v) })), [sideWide]);
  const setLogH = useCallback((v: number) => setSizes((s) => ({ ...s, logH: Math.round(v) })), []);
  const reset = useCallback(() => setSizes(EMPTY), []);
  const resetPart = useCallback(
    (part: "rail" | "side" | "log") =>
      setSizes((s) => (part === "rail" ? { ...s, railW: null } : part === "log" ? { ...s, logH: null } : sideWide ? { ...s, sideWideW: null } : { ...s, sideW: null })),
    [sideWide],
  );

  return { threeColumn: win.w >= THREE_COLUMN_MIN_W, railW, sideW, logH, railMax, sideMax, logMax, setRailW, setSideW, setLogH, resetPart, reset, reservedW };
}
