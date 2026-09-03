/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RAKE OVERRIDE RESOLUTION — pure
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Split out of useEffectiveRake so the precedence can be tested without booting
 * a Supabase client at import time. See that hook for the full history; the
 * short version is that this rule must stay identical to the server's
 * ServerTableEngineBase.getRakeOverride, or the Game Rules modal states a rake
 * the engine never takes.
 *
 *     table override  ->  club default  ->  published schedule
 */
import { getRakeConfig, type RakeOverride } from '../config/RakeConfig';

/** "1/2" -> { sb: 1, bb: 2 }. Returns null when it cannot be trusted. */
export function parseBlinds(blinds: string | undefined | null): { sb: number; bb: number } | null {
  if (!blinds) return null;
  const parts = String(blinds).split('/');
  if (parts.length < 2) return null;
  const sb = parseFloat(parts[0]);
  const bb = parseFloat(parts[1]);
  if (!Number.isFinite(sb) || !Number.isFinite(bb) || bb <= 0) return null;
  return { sb, bb };
}

/**
 * Resolve a table override and a club override into the single override the
 * schedule lookup takes. Pure, so the precedence is testable without a network.
 */
export function resolveRakeOverride(
  table: { rake_percent?: number | null; rake_cap_bb?: number | null } | null,
  club: { default_rake_percent?: number | null; rake_cap?: number | null } | null
): RakeOverride | undefined {
  // A value counts as "set" only when it is a real number >= 0. The database
  // stores -1 as the inherit sentinel, and NULL for never-configured.
  const pick = (a: unknown, b: unknown): number | undefined => {
    for (const v of [a, b]) {
      if (v === null || v === undefined) continue;
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return undefined;
  };
  const rakePercent = pick(table?.rake_percent, club?.default_rake_percent);
  const rakeCapBB = pick(table?.rake_cap_bb, club?.rake_cap);
  if (rakePercent === undefined && rakeCapBB === undefined) return undefined;
  return { rakePercent, rakeCapBB };
}

/**
 * The rake the Game Rules modal shows when neither the table nor the club has
 * an override — i.e. straight off the published schedule.
 *
 * Dan 2026-08-15 — THE GAME RULES MODAL WAS MISSTATING THE RAKE. This used to
 * be an inline `useMemo` in TablePage, and before that it did not exist at all.
 * TableModalsLayer renders `rakePercentage={rakePercent ?? 5}` and
 * `rakeCap={rakeCap ?? 3}`, fed from `tableState.rakePercent` /
 * `tableState.rakeCap` — fields that are DECLARED on the state interface and
 * passed through, but never assigned anywhere. The engine snapshot carries no
 * rake data at all (mapEngineSnapshot has zero rake references), so both were
 * permanently undefined and the modal always fell through to its placeholders.
 *
 * Net effect: every player, at every stake, was told "Rake 5% (Cap $3)". The
 * server actually takes 10% with tier caps from $3 up to $15
 * (server/src/config/RakeConfig.ts RAKE_SCHEDULE). At 10/25 we displayed a $3
 * cap against a real $15 one — a five-fold understatement of the rake.
 *
 * src/config/RakeConfig.ts holds a byte-identical copy of the server's
 * RAKE_SCHEDULE and exports getRakeConfig(), so the number shown to players is
 * the number actually taken. A CI guard keeps the two schedules from drifting
 * (scripts/ci/check-rake-schedule-parity.mjs).
 *
 * Display only — all money movement remains server-authoritative.
 *
 * Returns undefined for both when the blinds have not loaded yet, so the modal
 * shows a placeholder rather than asserting a rake that is not the real one.
 *
 * NOTE: this deliberately does NOT reuse parseBlinds() above. parseBlinds
 * rejects the whole string when the SMALL blind is unreadable; this one keeps
 * going on the big blind alone and passes null for the small, which is what
 * the modal has always done. Unifying the two would change a number shown to
 * players, and that is not something to slip into a refactor.
 */
export function resolveDisplayRake(
  blinds: string | undefined | null,
  gameType: string | undefined | null
): { rakePercent: number | undefined; rakeCap: number | undefined } {
  const parts = (blinds || '').split('/');
  const sb = parseFloat(parts[0]);
  const bb = parseFloat(parts[1]);
  if (!Number.isFinite(bb) || bb <= 0) {
    return { rakePercent: undefined, rakeCap: undefined };
  }
  const cfg = getRakeConfig(bb, gameType || 'nlh', Number.isFinite(sb) ? sb : null);
  return { rakePercent: cfg.rakePercent, rakeCap: cfg.rakeCap };
}
