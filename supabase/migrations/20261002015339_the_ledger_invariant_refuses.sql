-- ===========================================================================
--  THE LEDGER INVARIANT REFUSES
-- ===========================================================================
--
-- Dan, 2026-10-01: "chip drifts should not be possible and should never happen
-- when EVERY SINGLE TRANSACTION is logged, and on the same ledger."
--
-- 20261001160611 installed the commit-time check (a covered balance moves only
-- by exactly the net of the chip_ledger legs written in the same transaction)
-- in mode 'observe', so live traffic could be measured before any transaction
-- was refused. This migration is stage 2: the one row becomes 'refuse', and
-- from here a transaction that would drift does not commit.
--
-- WHAT THE MEASUREMENT SAID (read from rows, 2026-10-02 01:43 UTC)
--   * 13,819 findings 22:24:25 -> 23:54:10 UTC, every one account table_stack,
--     every one the same writer (PostgREST, the hand-commit / post-commit
--     obligations pair). That class was fixed at its line by 20261001231409
--     (#5760, applied 00:04 UTC): the hand receipt carries its fees as felt
--     until the transaction that posts their legs, so each half balances.
--   * Zero findings from 00:05 to the flip under full traffic (~9,000 hands
--     per ten minutes), across every chip_ledger category live in the window:
--     buy-ins, cash-outs, add-ons, rake, jackpot drop, tournament buy-in and
--     prize, Spin entry and prize, bounty, overlay, promo, mint, burn,
--     commission, rakeback, horse funding, treasury transfer, opening
--     allocation.
--   * The two categories with no traffic since install were proved instead of
--     assumed: bbj_payout (mini and main, seated and departed recipients) was
--     executed against a live cash table in one rolled-back DO block with the
--     mode set to refuse and SET CONSTRAINTS ALL IMMEDIATE after the payout
--     returned - both commit checks passed (felt 656.25 = 656.25, pool -700 =
--     -700). ticket_redeem moves escrow to prize_liability, neither of which is
--     a covered account.
--   * The two Diamond functions that issue SET CONSTRAINTS
--     (fn_poker_diamond_tournament_drain, fn_poker_diamond_spin_draw) name only
--     zzz_diamond_entry_custody_is_the_entry, a constraint on
--     poker_diamond_custody; naming one constraint fires only its own queued
--     events, never zz_ca_*. Neither has ever run (0 Diamond movements, 0
--     Diamond Spin receipts). No pg_proc body issues SET CONSTRAINTS ALL, sets
--     this mode, disables a trigger or sets session_replication_role.
--
-- The preimage is asserted so this aborts, applying nothing, if the board
-- moved underneath it: the mode must still be observe, and nothing may have
-- been found since the fix landed. A data change only: no DDL, no reload.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  v_mode text;
  v_rows integer;
  v_since bigint;
BEGIN
  SELECT count(*), max(mode) INTO v_rows, v_mode FROM public.ca_ledger_invariant_mode;
  IF v_rows <> 1 OR v_mode IS DISTINCT FROM 'observe' THEN
    RAISE EXCEPTION 'preimage: ca_ledger_invariant_mode must be one row in observe (rows %, mode %)', v_rows, v_mode;
  END IF;
  SELECT count(*) INTO v_since FROM public.ca_ledger_invariant_findings
   WHERE found_at >= timestamptz '2026-10-02 00:05:00+00';
  IF v_since <> 0 THEN
    RAISE EXCEPTION 'preimage: % ledger invariant findings since the 00:05 UTC fix; a live writer still drifts and refusing would stop it - fix it first', v_since;
  END IF;
END $pre$;

UPDATE public.ca_ledger_invariant_mode
   SET mode = 'refuse',
       changed_at = now(),
       reason = '20261002015339: stage 2. Zero findings from 00:05 UTC (after 20261001231409 fixed the one live class) under full traffic; bbj_payout proved in a rolled-back probe; a transaction whose covered balance and chip_ledger legs disagree no longer commits'
 WHERE singleton;

DO $post$
BEGIN
  IF (SELECT mode FROM public.ca_ledger_invariant_mode) IS DISTINCT FROM 'refuse' THEN
    RAISE EXCEPTION 'the ledger invariant did not read back refuse';
  END IF;
  RAISE NOTICE 'ca_ledger_invariant_mode = refuse';
END $post$;

COMMIT;
