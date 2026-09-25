/**
 * What the record viewer shows: a decision packet or a model call of a turn,
 * or the model call in progress (INTERFACES section 9 history routes and
 * GET /pending_model_call).
 */

export type RecordTarget =
  | { kind: "packet"; turnId: string; packetId: string }
  /** `note` is shown above the record (for example "the call in progress has finished"). */
  | { kind: "call"; turnId: string; callId: string; note?: string }
  | { kind: "pending" };

/** A stable key for loading and caching one record. */
export function targetKey(target: RecordTarget): string {
  if (target.kind === "packet") return `packet:${target.turnId}:${target.packetId}`;
  if (target.kind === "call") return `call:${target.turnId}:${target.callId}`;
  return "pending";
}

/** Turn id of a model call id: "mc_r00001_t02_a07_01" -> "r00001_t02_a07" (INTERFACES section 3); null if the id has another shape. */
export function turnIdOfCallId(callId: string): string | null {
  const match = /^mc_(.+)_\d{2,}$/.exec(callId);
  return match ? match[1] : null;
}
