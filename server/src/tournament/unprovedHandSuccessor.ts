/**
 * AN UNPROVED HAND BELONGS TO A SUCCESSOR GENERATION (2026-10-06).
 *
 * A tournament hand whose authoritative commit was never proved leaves its
 * F06 permit in phase `attempted` on an engine that has been fenced and
 * stopped. Three doors are then shut for as long as the manager keeps its
 * lease generation:
 *
 *   1. the stopped engine will never settle again, so the permit never clears;
 *   2. the manager refuses to replace an engine that still holds a permit;
 *   3. `fn_ca_resume_hand_submission` refuses the generation that retained the
 *      hand ("the original generation ... is never its own successor"), and
 *      `fn_f06_abort_abandoned_generation` refuses a generation that is live.
 *
 * On 2026-10-06 a database stall left 78 tables of two events in exactly this
 * state. Every hand was retained and replayable; the recovery asked the same
 * closed door every fifteen seconds for an hour and forty minutes, because the
 * only thing the platform's own resolution needs - a different lease
 * generation - was something only a process restart ever supplied.
 *
 * So the manager hands the event to a successor generation itself. Nothing is
 * settled, voided or reconstructed here: the successor meets the retained
 * hand at admission and takes the door that was always designed for it.
 */
export interface RetainedPermitView {
  readonly phase: string;
  readonly binding: { readonly lease_generation: string };
}

export function unprovedHandNeedsSuccessorGeneration(input: {
  permit: RetainedPermitView | null | undefined;
  managerLeaseGeneration: string | null | undefined;
  engineReleasedProcessOwnership: boolean;
}): boolean {
  const { permit, managerLeaseGeneration } = input;
  if (!permit || !managerLeaseGeneration) return false;
  if (!input.engineReleasedProcessOwnership) return false;
  // Every other phase has an owner in this generation: unknown, reserved and
  // terminated are retired by the stopped-original custody path.
  if (permit.phase !== 'attempted') return false;
  return permit.binding.lease_generation === managerLeaseGeneration;
}

export interface HandBoundaryView {
  isRunning(): boolean;
  isBetweenHands(): boolean;
}

/**
 * The hand-off stops every table of the event. A table with cards in the air
 * finishes the hand in front of its players first; a stopped engine has none.
 */
export function everyOtherTableIsAtAHandBoundary<E extends HandBoundaryView>(
  engines: Iterable<E>,
  stoppedOriginal: E
): boolean {
  for (const engine of engines) {
    if (engine === stoppedOriginal || !engine.isRunning()) continue;
    if (!engine.isBetweenHands()) return false;
  }
  return true;
}
