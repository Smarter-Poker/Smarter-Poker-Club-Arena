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
import type { RakeOverride } from '../config/RakeConfig';

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

