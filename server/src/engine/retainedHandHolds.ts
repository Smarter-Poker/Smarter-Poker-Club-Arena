/**
 * WHICH CASH TABLES ARE HELD BY A RETAINED-HAND REFUSAL (2026-10-09).
 *
 * GameServer holds a cash table whose retained hand the resume door refuses
 * from durable state: the table is not rebuilt, and is asked again every few
 * minutes. Nothing told the horse fleet, so it went on seating horses at
 * tables that could not deal. On 2026-10-09 three Diamond cash tables held
 * since 2026-10-07 had 17 horses and 21,745 Diamonds of their buy-ins sitting
 * at them, every one seated after the hold began.
 *
 * One process-local set, written only by GameServer's hold and release, read by
 * the fleet before it seats anyone. A held table is withheld, never closed: the
 * moment the door admits it again GameServer releases the hold and the fleet
 * seats it on its next cycle.
 */
const held = new Set<string>();

export function markRetainedHandHold(tableId: string): void {
  held.add(tableId);
}

export function clearRetainedHandHold(tableId: string): void {
  held.delete(tableId);
}

export function tableHeldByRetainedHand(tableId: string): boolean {
  return held.has(tableId);
}

/** Test seam. */
export function __resetRetainedHandHolds(): void {
  held.clear();
}
