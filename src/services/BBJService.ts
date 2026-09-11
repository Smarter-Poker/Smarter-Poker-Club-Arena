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

/* `executePromoRain` REMOVED (phase 5, 2026-09-11), and with it the last
   method on this object.

   It called `fn_bbj_promo_rain`, which Dan made a deliberate stub on
   2026-09-03: "the splash pot has never been built or specified and is to be
   added later ... Until its rules exist - eligibility, size, frequency, and
   what stops a single click emptying a union's promo float - THIS MOVES NO
   CHIPS." The method did not even map `not_built_yet`, so an operator who
   filled in an amount and confirmed a dialog reading "this can't be undone"
   was rewarded with a toast reading, literally, `not_built_yet`.

   Promo is disbursed two ways, both built and both ruled on: an owner sends it
   with `fn_promo_disburse` (see WalletService), and leaderboards pay it
   automatically. The jackpot page now says that instead of offering a button
   that cannot work. */
export const BBJService = {};

export default BBJService;
