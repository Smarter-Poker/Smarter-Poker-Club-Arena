-- ===========================================================================
--  EVERY CHIP STORE REFUSES
-- ===========================================================================
--
-- Dan, 2026-10-01: "fix any and all issues with the chip drift ... chip
-- drifts should not be possible."
--
-- 20261002030942 put the nine remaining chip stores (promo floats, agent
-- wallets, club wallets, insurance banks, Spin reserves, tournament escrow, the
-- ticket float, and the opening / leaderboard clearing stores) under the
-- commit-time ledger check in OBSERVE, applied 04:14:45 UTC. This is stage 2:
-- the nine rows become 'refuse', so a transaction in which any chip store's
-- balance and its chip_ledger legs disagree no longer commits, anywhere.
--
-- WHAT THE MEASUREMENT SAID (read from rows; the window and its counts are in
-- docs/changelog/2026-10-02-every-chip-store-balances-with-its-ledger-row.md)
--   * Zero findings on any store from 04:14:45 UTC to this file's preimage,
--     under full traffic, across every live category on the new stores:
--     tournament buy-in, prize, bounty, rake and burn out of escrow, Spin entry
--     and drawn prize through the reserve, the five-minute jackpot promo sweep
--     into the club promo float, and the club opening allocations through the
--     opening clearing store.
--   * The doors with no traffic in the window were proved, not assumed, each
--     in one rolled-back DO block with the store's check fired at the end:
--     the agent wallet (fn_agent_wallet_self_stake: one leg, balanced), the
--     club promo float to a player wallet and to an agent promo wallet
--     (fn_club_promo_wallet_send: balanced), and a stand-down with no leg on
--     the legacy union promo fund (recorded under observe, refused under
--     refuse). The club wallet and insurance balances have no stand-down
--     writer in pg_proc and no writer that posts its own leg for them: the
--     journal trigger always writes their leg, so they balance by
--     construction.
--
-- THE ONE WRITER THE READING FOUND, retired at its line (CLAUDE.md 10.11)
--   fn_clawback_chips_atomic (called only by the World Hub route
--   /api/club-arena/clawback-chips, service_role, 0 uses ever) took the chips
--   back from agents.player_balance - a mirror column that is 0.00 on every
--   row - or from the dead public.wallets pool, and credited the agent through
--   agents.business_balance. sync_agent_wallet_columns turns that into an
--   agent_wallet_balance move, and the journal trigger, which is column-listed
--   on agent_wallet_balance, never fires for a write that names only the
--   mirror: chips appearing in an agent wallet out of a non-chip column, with
--   no leg. The invariant would now refuse it; the function is retired so it
--   cannot be called into a refusal either. The real undo, the one the client
--   has used since the agent wallet shipped, is fn_agent_wallet_claim_back.
--   Pinned to the live body read on 2026-10-02.
--
-- The preimage aborts, applying nothing, if any finding exists since 04:14:45
-- or the nine are not still observe. A data change plus one function body: no
-- table lock, no trigger, nothing dropped.
-- ===========================================================================
-- @live-proof: (SELECT count(*) FROM public.ca_ledger_invariant_store_mode WHERE mode = 'refuse') = 15

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  v_observe integer;
  v_since bigint;
  v_live text;
BEGIN
  SELECT count(*) INTO v_observe FROM public.ca_ledger_invariant_store_mode WHERE mode = 'observe';
  IF v_observe <> 9 THEN
    RAISE EXCEPTION 'preimage: expected the nine new stores in observe, found %', v_observe;
  END IF;
  SELECT count(*) INTO v_since FROM public.ca_ledger_invariant_findings
   WHERE found_at >= timestamptz '2026-10-02 04:14:45+00';
  IF v_since <> 0 THEN
    RAISE EXCEPTION 'preimage: % ledger invariant findings since 04:14:45 UTC; a live writer still drifts and refusing would stop it - fix it first', v_since;
  END IF;
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_live
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fn_clawback_chips_atomic';
  IF v_live IS DISTINCT FROM '8f766700e80f50630983cb1fccbff194' THEN
    RAISE EXCEPTION 'preimage: fn_clawback_chips_atomic is not the body read on 2026-10-02 (md5 %); re-read it', v_live;
  END IF;
END $pre$;

UPDATE public.ca_ledger_invariant_store_mode
   SET mode = 'refuse',
       changed_at = now(),
       reason = '20261002042417: stage 2. Zero findings from 04:14:45 UTC under full traffic; the doors with no traffic proved in rolled-back probes; a transaction whose chip store and chip_ledger legs disagree no longer commits'
 WHERE mode = 'observe';

CREATE OR REPLACE FUNCTION public.fn_clawback_chips_atomic(p_transaction_id uuid, p_club_id uuid, p_agent_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  /* RETIRED 2026-10-02. This took the chips back from agents.player_balance (a
     mirror column, 0.00 on every row) or the dead public.wallets pool, and
     credited the agent through agents.business_balance - which moves
     agent_wallet_balance with no chip_ledger leg, because the journal trigger
     never fires for a write that names only the mirror. Chips would appear in
     an agent wallet out of a column that holds none. It never ran (0 clawback
     rows). The undo is fn_agent_wallet_claim_back, which moves the real
     wallets and writes the leg. Nothing is moved here. */
  RETURN jsonb_build_object('success', false, 'error', 'clawback_retired',
    'message', 'Use the agent wallet claim back (fn_agent_wallet_claim_back)',
    'transaction_id', p_transaction_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_clawback_chips_atomic(uuid, uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;

DO $post$
BEGIN
  IF (SELECT count(*) FROM public.ca_ledger_invariant_store_mode WHERE mode = 'refuse') <> 15
     OR EXISTS (SELECT 1 FROM public.ca_ledger_invariant_store_mode WHERE mode <> 'refuse') THEN
    RAISE EXCEPTION 'the fifteen chip stores did not read back refuse';
  END IF;
  IF (SELECT mode FROM public.ca_ledger_invariant_mode) IS DISTINCT FROM 'refuse' THEN
    RAISE EXCEPTION 'the global fallback must stay refuse';
  END IF;
  RAISE NOTICE 'every chip store refuses: % stores', (SELECT count(*) FROM public.ca_ledger_invariant_store_mode);
END $post$;

COMMIT;
