/**
 * Evidence gates for a tournament that was found in COMPLETING after its
 * engine disappeared. These helpers never choose a winner and never write;
 * they only identify snapshots that cannot prove a poker result.
 */

/**
 * Horse-only hand history is retained for seven days in production. Stop one
 * day inside that boundary so an empty history is still meaningful even while
 * the retention job and recovery scan overlap.
 */
export const HAND_EVIDENCE_WINDOW_DAYS = 6;

interface StackEvidence {
  chips: number | string | null | undefined;
}

/** A multi-player field with one identical stored stack has no ranking signal. */
export function chipsCannotRank(field: readonly StackEvidence[]): boolean {
  if (field.length < 2) return false;
  const first = field[0]?.chips ?? null;
  return field.every((row) => (row.chips ?? null) === first);
}

interface HandEvidence {
  startedAt: string | null | undefined;
  anyHandDealt: boolean;
  now?: number;
}

/**
 * True only while the hand-history retention window can prove that an empty
 * result means no hand was dealt. Invalid or future start timestamps fail
 * closed because neither is evidence of real play.
 */
export function noHandWasEverDealt(input: HandEvidence): boolean {
  if (input.anyHandDealt) return false;
  if (!input.startedAt) return true;
  const startedAt = Date.parse(input.startedAt);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(now) || startedAt > now) return true;
  return now - startedAt <= HAND_EVIDENCE_WINDOW_DAYS * 86_400_000;
}
