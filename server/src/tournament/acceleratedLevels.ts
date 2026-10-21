/**
 * ACCELERATED MTT (2026-08-22 parity): once late registration has closed, an
 * accelerated tournament runs its remaining blind levels at HALF length —
 * ceil(minutes / 2), with the owner's five-minute minimum applied afterwards.
 *
 * Pure on purpose: TournamentManagerBase.levelDurationMs applies this to the
 * format-normalized base duration, and the unit tests exercise the rule with
 * no engine or DB in the room.
 */
export function acceleratedLevelMs(baseMs: number): number {
  const ms = Number(baseMs);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(5, Math.ceil(ms / 60_000 / 2)) * 60_000;
}
