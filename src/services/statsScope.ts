/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  STATS SCOPE — which asset a figure is about (2026-09-20)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A profit figure is not a number. It is a number AND the thing it is
 * denominated in, and the moment those two are separated the number is
 * worthless - worse than worthless, because it still looks like an answer.
 *
 * ═══ THE DEFECT THIS EXISTS FOR ════════════════════════════════════════════
 *
 * The live projection `fn_project_hand_side_effects_after_post_commit_20260908`
 * gates projections 1, 2 and 3 on a `v_diamond` flag, so club-member state,
 * legacy `player_stats` totals and positional aggregates all keep Diamond
 * hands out. Projection 4 - which writes `ca_hand_player_idx` and
 * `ca_hand_player_stat` - has no such gate, and `ca_hand_player_stat` carries
 * no club or asset column at all (verified read-only on production
 * 2026-09-20: user_id, hand_id, tournament_id, is_cash, game_variant, profit,
 * won_amt ... and nothing that says which currency any of it is in).
 *
 * Every stats RPC over that table takes `p_user` and nothing else:
 *
 *   ca_player_stats_overview_v2(p_user, p_days, p_tz)
 *   ca_player_stats_pulse(p_user)
 *   ca_player_ev_curve(p_user, p_days, p_limit)
 *   ca_player_hand_grid(p_user, p_position, p_variant, p_days)
 *   ca_player_class_hands(p_user, p_hand_class, p_position, p_variant, p_days, p_limit)
 *   ca_player_nemesis(p_user, p_days, p_min_hands, p_limit)
 *   ca_player_rake_stats(p_user, p_days)
 *
 * So the day the cash switch opens, one Diamond hand and one chip hand sum
 * into a single `profit`, a single `won_amt`, a single `net` and a single
 * `rake_paid`, and the player is shown the total as though it meant something.
 * Nothing in the database would refuse it and nothing in the client would
 * notice.
 *
 * ═══ WHAT THIS MODULE DOES, AND WHAT IT DELIBERATELY DOES NOT ══════════════
 *
 * It makes the asset dimension EXPLICIT on the client side of every stats
 * read, so that:
 *
 *  1. no read can be issued without naming the asset it is about, and
 *  2. a scope the database cannot yet separate returns an honest unknown
 *     rather than a mixed figure wearing that scope's label.
 *
 * It does NOT fix the projection or the RPCs. That is schema and function
 * work, it needs a migration, and it is written up with the exact remaining
 * SQL in `docs/runbooks/diamond-stats-asset-dimension-2026-09-20.md`.
 *
 * ═══ WHY THE CHIP SCOPE READS AN UNSCOPED RPC AND IS STILL CORRECT ═════════
 *
 * `STATS_RPCS_ARE_SCOPED` is false: the RPCs above accept no scope argument,
 * and sending one would be a PGRST202 on every stats read in the app. While it
 * is false, a chip-scoped read calls the unscoped RPC, and that is exact
 * rather than approximate - `ca_hand_player_stat` holds only chip rows,
 * because Diamond cash play has never been open (`ca_arena_settings
 * .cash_games_enabled` is false) so projection 4 has never had a Diamond hand
 * to write. The unscoped answer IS the chip answer, today.
 *
 * That is a fact with an expiry date, which is exactly the kind of claim
 * CLAUDE.md 10.86 says to date and give a reader. Its reader is
 * `tests/chip-and-diamond-figures-never-sum.law.test.ts`, which requires the
 * newest definition of the projection to gate its `ca_hand_player_stat` write
 * per asset. Open the switch without that gate and the law goes red, rather
 * than the figures going quietly wrong.
 *
 * A diamond-scoped read is refused here for the same reason, from the other
 * side: there is no way to ask for Diamond figures alone yet, so it answers
 * "could not tell" instead of handing back a chip total relabelled.
 */

/** The asset a stats figure is denominated in. */
export type StatsScope = 'chips' | 'diamonds';

export const CHIP_STATS: StatsScope = 'chips';
export const DIAMOND_STATS: StatsScope = 'diamonds';

/**
 * Whether the stats RPCs accept and honour a scope argument.
 *
 * FLIP THIS WITH THE MIGRATION, NOT BEFORE. When the scoped RPCs land, this
 * becomes true, `statsScopeArgs` starts sending `p_asset`, and every scope
 * becomes readable. The runbook names the exact SQL.
 */
export const STATS_RPCS_ARE_SCOPED = false;

/** The name an unreadable scope reports, so a panel can say so out loud. */
export const STATS_SCOPE_UNREADABLE = 'stats_scope_unavailable';

/**
 * The scope argument for an RPC call.
 *
 * Empty while the RPCs are unscoped: passing an argument a function does not
 * declare is a hard PostgREST failure, not a no-op.
 */
export function statsScopeArgs(scope: StatsScope): Record<string, unknown> {
  return STATS_RPCS_ARE_SCOPED ? { p_asset: scope } : {};
}

/**
 * Whether a read in this scope can be answered truthfully right now.
 *
 * Chips: yes - the unscoped table is all chips (see the header).
 * Diamonds: not until the RPCs can separate them. The caller must render an
 * unknown; it must never fall back to the unscoped figure.
 */
export function statsScopeIsReadable(scope: StatsScope): boolean {
  return STATS_RPCS_ARE_SCOPED || scope === CHIP_STATS;
}
