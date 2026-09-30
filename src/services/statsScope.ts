/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  STATS SCOPE — which asset a figure is about (2026-09-20, scoped 2026-09-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A profit figure is not a number. It is a number AND the thing it is
 * denominated in, and the moment those two are separated the number is
 * worthless - worse than worthless, because it still looks like an answer.
 *
 * ═══ THE DEFECT THIS EXISTS FOR ════════════════════════════════════════════
 *
 * The per-hand stat table (`ca_hand_player_stat`) and the player-to-hand index
 * (`ca_hand_player_idx`) had no club or asset column, and every stats RPC took
 * `p_user` and nothing else. So the first Diamond hand ever dealt would have
 * added its profit, winnings and rake to the player's chip figures, with
 * nothing able to tell them apart again.
 *
 * ═══ WHAT THE DATABASE DOES NOW (migration 20260920065728) ═════════════════
 *
 * `a_diamond_hand_keeps_its_own_statistics`, applied 2026-09-29:
 *
 *  - both tables carry `asset`, set from the hand itself by a BEFORE INSERT
 *    trigger, so every writer labels a Diamond hand as Diamond;
 *  - every stats RPC takes `p_asset` ('chips' | 'diamonds', default 'chips')
 *    as its last argument and reads that asset only:
 *
 *      ca_player_stats_overview_v2(p_user, p_days, p_tz, p_asset)
 *      ca_player_stats_pulse(p_user, p_asset)
 *      ca_player_ev_curve(p_user, p_days, p_limit, p_asset)
 *      ca_player_hand_grid(p_user, p_position, p_variant, p_days, p_asset)
 *      ca_player_class_hands(p_user, p_hand_class, p_position, p_variant, p_days, p_limit, p_asset)
 *      ca_player_nemesis(p_user, p_days, p_min_hands, p_limit, p_asset)
 *      ca_player_rake_stats(p_user, p_days, p_asset)
 *
 * ═══ WHAT THIS MODULE DOES ═════════════════════════════════════════════════
 *
 * It makes the asset EXPLICIT on the client side of every stats read, so
 * that no read can be issued without naming the asset it is about. With the
 * RPCs scoped, `statsScopeArgs` sends `p_asset` and both scopes are readable.
 *
 * `STATS_RPCS_ARE_SCOPED` stays as the single switch the law
 * `tests/chip-and-diamond-figures-never-sum.law.test.ts` pins to the
 * migration: it is true exactly while the migration that scopes the RPCs is
 * in the repository. Were it ever false again, a Diamond read would answer
 * "could not tell" rather than a chip total relabelled.
 */

/** The asset a stats figure is denominated in. */
export type StatsScope = 'chips' | 'diamonds';

export const CHIP_STATS: StatsScope = 'chips';
export const DIAMOND_STATS: StatsScope = 'diamonds';

/**
 * Whether the stats RPCs accept and honour a scope argument.
 *
 * True since migration 20260920065728_a_diamond_hand_keeps_its_own_statistics
 * (applied 2026-09-29): every stats RPC takes `p_asset`.
 */
export const STATS_RPCS_ARE_SCOPED = true;

/** The name an unreadable scope reports, so a panel can say so out loud. */
export const STATS_SCOPE_UNREADABLE = 'stats_scope_unavailable';

/**
 * The scope argument for an RPC call.
 *
 * Empty only while the RPCs are unscoped: passing an argument a function does
 * not declare is a hard PostgREST failure, not a no-op.
 */
export function statsScopeArgs(scope: StatsScope): Record<string, unknown> {
  return STATS_RPCS_ARE_SCOPED ? { p_asset: scope } : {};
}

/**
 * Whether a read in this scope can be answered truthfully right now.
 *
 * With the RPCs scoped, both assets are. Were they unscoped, only chips would
 * be, and a Diamond read must then render an unknown; it must never fall back
 * to the unscoped figure.
 */
export function statsScopeIsReadable(scope: StatsScope): boolean {
  return STATS_RPCS_ARE_SCOPED || scope === CHIP_STATS;
}
