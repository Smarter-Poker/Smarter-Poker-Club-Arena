/**
 * ACCELERATED MTT (2026-08-22 parity): once late registration has closed, an
 * accelerated tournament runs its remaining blind levels at HALF length —
 * ceil(minutes / 2), so a 5-minute level becomes 3, a 1-minute level stays 1,
 * and no level can ever collapse below a minute.
 *
 * Pure on purpose: TournamentManagerBase.levelDurationMs applies this to the
 * format-normalized base duration, and the unit tests exercise the rule with
 * no engine or DB in the room.
 */
export function acceleratedLevelMs(baseMs: number): number {
  const ms = Number(baseMs);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / 60_000 / 2)) * 60_000;
}
