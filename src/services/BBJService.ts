/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ SERVICE — the one client-side jackpot action
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * SCOPE (deliberately tiny, 2026-08-18). This file used to carry 583 lines of
 * client-side jackpot logic, of which exactly ONE method was reachable from the
 * app. The rest was not merely unused — it was WRONG, and it disagreed with the
 * server that actually pays:
 *
 *   - `calculateContribution()` returned a flat `bigBlind * 0.5`. The real
 *     schedule is stakes-tiered (0.6bb at nano down to 0.03bb at nosebleeds),
 *     so this was off by up to 20x. It had unit tests asserting the wrong
 *     number, which made the mistake look verified.
 *   - `checkBBJTrigger()` implemented "Quad 2s or better" — a FOURTH wrong
 *     qualifying rule (the widget said Quad 8s, the FAQ said Quad 8s, the
 *     jackpot page said Quad 2s) — and, like the server bug that mispaid
 *     $99k, it never checked that the WINNING hand was quads or better, never
 *     checked both hole cards played, and ignored the per-variant floors.
 *   - `recordContribution()` / `executePromoPayout()` were client paths toward
 *     money movement. Both are moot: every money-moving BBJ function in the
 *     database is service-role only (verified: anon=false, authenticated=false
 *     on bbj_record_contribution, bbj_atomic_payout_v2, fn_bbj_repair_unbanked
 *     and fn_bbj_promo_payout_atomic), so they could only ever have failed.
 *
 * Qualification, fees, allocation and payouts belong to the server and the
 * database; a second divergent copy in the browser is a liability with no
 * upside. Read-only jackpot data now comes from purpose-built RPCs
 * (fn_bbj_recent_hits, fn_bbj_pool_facts, fn_bbj_my_contribution,
 * fn_bbj_analytics) and display rules from src/config/RakeConfig.
 *
 * What remains is the single genuine client action: an owner distributing the
 * promo pool, which fn_bbj_promo_rain authorises server-side.
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';

export interface BBJPool {
  id: string;
  union_id: string | null;
  club_id: string | null;
  main_balance: number;
  backup_balance: number;
  promo_balance: number;
  total_contributed: number;
  last_hit_at?: string | null;
  last_hit_amount?: number;
  created_at?: string;
  updated_at?: string;
}

export const BBJService = {
  /**
   * Distribute part of the promo pool to currently-active players.
   *
   * Authorisation is the RPC's job (SECURITY DEFINER, checks club/union
   * ownership itself); the UI gate is a convenience, not the control.
   * Returns the number of players paid.
   */
  async executePromoRain(poolId: string, amount: number, reason = 'Promo rain'): Promise<number> {
    const { data, error } = await supabase.rpc('fn_bbj_promo_rain', {
      p_pool_id: poolId,
      p_amount: amount,
      p_reason: reason,
    });
    if (error) {
      reportError(error, 'BBJService.executePromoRain');
      throw new Error(error.message);
    }
    if (!data?.success) {
      const map: Record<string, string> = {
        not_authorized: 'Only the club/union owner can distribute the promo pool.',
        no_active_players: 'No active players to rain to right now.',
        insufficient_promo_balance: 'Not enough in the promo pool for that amount.',
        invalid_amount: 'Enter a valid amount.',
        pool_not_found: 'Promo pool not found.',
      };
      throw new Error(map[data?.error] || data?.error || 'Promo rain failed');
    }
    masterBus.emit('BALANCE_UPDATED', { source: 'bbj_promo_rain' });
    return Number(data.recipient_count || 0);
  },
};

export default BBJService;
