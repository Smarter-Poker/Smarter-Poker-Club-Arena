/**
 * One place that turns `ca_player_stats_full.overall` into a playstyle.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two call sites (the share card on PlayerStatsPage and the badge in
 * TrophyRoom) were each doing the same fraction-to-count conversion inline,
 * against the same 300-hand threshold, and had ALREADY drifted — one wrapped in
 * try/catch and the other did not, and only one named the threshold. Both also
 * carried the same bug, below.
 *
 * THE BUG THEY BOTH HAD
 * ---------------------
 * `playerStyleClassifier.classify()` derives its aggression factor from
 * `aggressiveActions` / `passiveActions`. Neither caller passed them, so AF
 * defaulted to exactly 1.0 on every call — and with AF pinned at 1, the
 * classifier's branches for shark (>=2.5), lag (>=2.0), maniac (>2.5) and tag
 * (>=1.5) are ALL UNREACHABLE. Only nit, rock, calling_station, fish and the
 * default could ever be returned, so no player could ever be told they were
 * aggressive, no matter how they played.
 *
 * Both callers were also passing `threeBetCount` and `wtsdCount`, which
 * `classify()` ignores entirely.
 *
 * `overall.aggression_factor` is right there in the payload. This module
 * reconstitutes plausible aggressive/passive action counts from it so the
 * classifier receives the ratio it actually reads.
 */

import {
  playerStyleClassifier,
  type PlayerStyleResult,
} from '../../services/PlayerStyleClassifier';

/** Below this many hands a style label is a coin flip, not a read. */
export const STYLE_MIN_HANDS = 300;

export interface StyleSourceStats {
  total_hands: number;
  vpip: number; // fraction 0..1
  pfr: number; // fraction 0..1
  aggression_factor: number;
}

/**
 * @returns the classified style, or null when there are too few hands to say
 *          anything honest about it.
 */
export function playerStyleFromStats(
  overall: StyleSourceStats | null | undefined
): PlayerStyleResult | null {
  if (!overall) return null;
  const hands = overall.total_hands;
  if (!Number.isFinite(hands) || hands < STYLE_MIN_HANDS) return null;

  try {
    // The RPC returns rates as FRACTIONS; the classifier wants COUNTS. This is
    // the single place that conversion happens.
    const vpipCount = Math.round((overall.vpip || 0) * hands);
    const pfrCount = Math.round((overall.pfr || 0) * hands);

    // AF = aggressive / passive. The classifier only ever reads the ratio, so
    // any pair with the right quotient works; a passive base of `hands` keeps
    // both numbers in a realistic range and avoids a divide-by-zero inside the
    // classifier when AF is 0.
    const af = Number.isFinite(overall.aggression_factor)
      ? Math.max(0, overall.aggression_factor)
      : 1;
    const passiveActions = Math.max(1, hands);
    const aggressiveActions = Math.round(passiveActions * af);

    return playerStyleClassifier.classify({
      handsPlayed: hands,
      vpipCount,
      pfrCount,
      aggressiveActions,
      passiveActions,
    });
  } catch {
    // A cosmetic badge must never take a stats page down.
    return null;
  }
}
