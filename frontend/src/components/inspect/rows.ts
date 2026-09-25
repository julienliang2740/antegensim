/**
 * Row type of KeyValueTable (common.tsx) and a builder for rows whose value is
 * rich JSX, which keeps JSX out of bare array literals.
 */

import type { ReactNode } from "react";

export type KeyValueRow = [label: ReactNode, value: ReactNode, title?: string];

export function kv(label: ReactNode, value: ReactNode, title?: string): KeyValueRow {
  return [label, value, title];
}
