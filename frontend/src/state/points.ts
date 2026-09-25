/** Coordinate text parsing for the coordinate lookup (spec "Display and historical inspection": coordinate lookup). */

import type { Point } from "../api/types";

/** Parse "3,4", "(3, 4)", "3 4" or "-2,-7" into a point; null when it is not a coordinate. */
export function parseCoordinate(text: string): Point | null {
  const match = /^\s*\(?\s*(-?\d+)\s*(?:,|\s)\s*(-?\d+)\s*\)?\s*$/.exec(text);
  if (!match) return null;
  return { x: parseInt(match[1], 10), y: parseInt(match[2], 10) };
}
