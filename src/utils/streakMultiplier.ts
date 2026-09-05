/**
 * The login-streak multiplier, mirrored from the database.
 *
 * `public.fn_get_streak_multiplier(p_streak_days)` is what the reward path
 * actually pays. Before 2026-09-04 the profile page computed its own
 * `1 + streak * 0.1`, so a seven-day streak advertised "1.7x" while the
 * ledger paid 1.5x. A multiplier a player can read must be the multiplier
 * the platform pays; this table is the SQL, verbatim, and the test pins it.
 *
 * Callers: ProfilePage (hero streak plate). No other client-side copy of this
 * ladder exists - BonusService.getWheelStats carries a different, wheel-only
 * ladder that is deliberately not this one.
 */
/* Module-local: `streakMultiplier` below is the only reader. It was exported
   for a countdown that was never wired to a surface (see the note below). */
const STREAK_MULTIPLIER_STEPS: ReadonlyArray<{ days: number; multiplier: number }> = [
  { days: 30, multiplier: 2.0 },
  { days: 14, multiplier: 1.8 },
  { days: 7, multiplier: 1.5 },
  { days: 3, multiplier: 1.2 },
];

export function streakMultiplier(streakDays: number): number {
  const days = Number.isFinite(streakDays) ? Math.floor(streakDays) : 0;
  for (const step of STREAK_MULTIPLIER_STEPS) {
    if (days >= step.days) return step.multiplier;
  }
  return 1.0;
}

/*
 * REMOVED 2026-09-05: `daysToNextStreakStep`. It was written for a "3 days to
 * 1.5x" countdown on the streak plate that was never wired to any surface, so
 * its only caller was the test that pinned it. Dead code with green pins reads
 * as covered and cannot be reached by a player; if the countdown is wanted,
 * bring it back in the commit that renders it.
 */
