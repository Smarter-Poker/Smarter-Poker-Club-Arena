-- 20261007134548_the_diamond_tournament_lane_journal_rows_are_settled.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Issue #6411. APPLY AFTER 20261007132503, which stops the Diamond tournament
-- lane writing wallet journal rows for movements between custody and the
-- house. This file settles the rows it wrote before that.
--
-- ============================================================================
-- THE DAMAGE, READ FROM ROWS ON 2026-10-07
-- ============================================================================
--
-- The Diamond Progressive Bounty 2000 completed at 13:03:21 UTC and its 800
-- Diamond fee settled through fn_poker_diamond_tournament_drain, which wrote
-- one -200 'tournament_fee' row per entry into diamond_transactions. None moved
-- profiles.diamonds, and none should have: each fee left the entry's custody
-- for the house, and had left the wallet already, inside the entry's
-- arena_deposit row. For exactly these four wallets SUM(diamond_transactions)
-- sits 200 below profiles.diamonds; every other wallet's journal explains its
-- balance exactly. No other tournament-lane kind (Spin surplus, overlay
-- return, overlay, Spin underwrite) had written a row. No Lifetime VIP lot was
-- allocated from the four rows.
--
-- THE SETTLEMENT (CLAUDE.md 10.9). Nobody's balance moves: the wallets are
-- right and the journal is wrong. The rows are append-only and stay exactly as
-- written; each gets ONE correcting row of the opposite sign, keyed
-- 'tournament_lane_correction:<original row id>', so the correction is
-- traceable row for row and cannot be written twice (reference_id is UNIQUE and
-- the insert also checks NOT EXISTS).
--
-- WHY THE REGISTER MUST NOT FOLLOW THE CORRECTIONS. The register burn each
-- original row drove ('diamond-journal:spend:<id>') is CORRECT: the fee left the
-- player's custody and was minted to the house, and the identity is 0 with
-- those burns in it. source 'journal_backfill' is the named source
-- fn_ca_diamond_journal_origin refuses to register, for exactly this reason;
-- issuance_class 'admin' keeps the rows out of the promotional earn ledger, and
-- a positive row allocates no Lifetime VIP lot. The kind is 'adjustment', which
-- the wallet buckets as Adjustments on either sign.
--
-- WHO IS AFFECTED, AND WHAT THEY GET. Four players, every one a horse, settled
-- exactly as a human would be (CLAUDE.md 10.5): no wallet moves, and each gets
-- one correcting ledger line of +200 for the Diamond tournament fee their entry
-- had already paid: vegadeveraux, flintivorson, slatenightingale and
-- cyruswhitlock, the four entries of the Diamond Progressive Bounty 2000.
--
-- NOT A REPAIR JOB (10.12). A one-time settlement in a migration; the live
-- writers were fixed first (20261007132503). No cron, no sweep, nothing reruns.
-- No is_horse anywhere in this file: the cohort is the rows and nothing else.
--
-- One transaction (production DDL policy rule 1). Never inside :50-:03 UTC.
--
-- @live-proof: (SELECT count(*) = 4 FROM public.diamond_transactions WHERE reference_id LIKE 'tournament_lane_correction:%')

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. THE LIVE WRITERS ARE ALREADY FIXED, OR NOTHING HERE RUNS.
DO $pre$
DECLARE v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.fn_poker_diamond_tournament_drain(uuid,text,bigint,text,text,uuid)',
    'public.fn_poker_diamond_tournament_settle_overlay(uuid,text,numeric)',
    'public.fn_poker_diamond_spin_draw(uuid,uuid,uuid)'] LOOP
    IF position('INSERT INTO public.diamond_transactions' IN pg_get_functiondef(v_sig::regprocedure)) > 0 THEN
      RAISE EXCEPTION 'apply 20261007132503 first: % still writes wallet journal rows for house legs', v_sig;
    END IF;
  END LOOP;
END
$pre$;

-- 2. THE COHORT, READ ONCE, AND THE BOARD ASSERTED BEFORE ANYTHING IS WRITTEN.
CREATE TEMP TABLE zz_lane_rows ON COMMIT DROP AS
SELECT t.id, t.user_id, t.amount, t.created_at, t.transaction_type, t.reference_id
  FROM public.diamond_transactions t
 WHERE t.transaction_type IN ('tournament_fee', 'arena_spin_surplus', 'arena_guarantee_overlay_return',
                              'arena_guarantee_overlay', 'arena_spin_underwrite')
   AND NOT EXISTS (SELECT 1 FROM public.diamond_transactions c
                    WHERE c.reference_id = 'tournament_lane_correction:' || t.id::text);

CREATE TEMP TABLE zz_journal_gap ON COMMIT DROP AS
SELECT p.id AS user_id,
       p.diamonds::bigint - COALESCE((SELECT SUM(t.amount) FROM public.diamond_transactions t
                                       WHERE t.user_id = p.id), 0)::bigint AS gap
  FROM public.profiles p
 WHERE p.diamonds::bigint <> COALESCE((SELECT SUM(t.amount) FROM public.diamond_transactions t
                                        WHERE t.user_id = p.id), 0)::bigint;

DO $board$
DECLARE v_rows bigint; v_total bigint; v_users bigint; v_pos bigint; v_gaps bigint; v_gap_total bigint; v_mismatch bigint;
BEGIN
  SELECT count(*), COALESCE(-SUM(amount),0), count(DISTINCT user_id), count(*) FILTER (WHERE amount > 0)
    INTO v_rows, v_total, v_users, v_pos FROM zz_lane_rows;
  IF v_rows <> 4 OR v_total <> 800 OR v_users <> 4 OR v_pos <> 0 THEN
    RAISE EXCEPTION 'THE BOARD MOVED. Measured 4 tournament-lane rows, 800 Diamonds, 4 wallets, no credit rows on 2026-10-07; found %, %, %, % credit rows. Re-read before settling (CLAUDE.md 10.9 rule 4).',
      v_rows, v_total, v_users, v_pos;
  END IF;
  SELECT count(*), COALESCE(SUM(gap),0) INTO v_gaps, v_gap_total FROM zz_journal_gap;
  IF v_gaps <> 4 OR v_gap_total <> 800 THEN
    RAISE EXCEPTION 'THE BOARD MOVED. Measured 4 wallets, 800 Diamonds the journal cannot explain; found % and %.',
      v_gaps, v_gap_total;
  END IF;
  -- Every gap is exactly that wallet's tournament-lane rows, and no other wallet drifts.
  SELECT count(*) INTO v_mismatch
    FROM zz_journal_gap g
    FULL JOIN (SELECT user_id, -SUM(amount) AS lane FROM zz_lane_rows GROUP BY user_id) r
      ON r.user_id = g.user_id
   WHERE g.gap IS DISTINCT FROM r.lane;
  IF v_mismatch <> 0 THEN
    RAISE EXCEPTION '% wallets drift by something other than their tournament-lane rows; stop and read them', v_mismatch;
  END IF;
END
$board$;

-- 3. ONE CORRECTING ROW PER ORIGINAL ROW. No balance moves.
INSERT INTO public.diamond_transactions
  (user_id, type, transaction_type, amount, balance_after, description,
   reference_id, source, issuance_class, counterparty, metadata)
SELECT r.user_id, 'adjustment', 'adjustment', (-r.amount)::integer,
       (SELECT COALESCE(p.diamonds, 0) FROM public.profiles p WHERE p.id = r.user_id),
       'Diamond Tournament Fee Correction. This Fee Was Already Paid Inside Your Tournament Entry, So Your Wallet Did Not Move Again.',
       'tournament_lane_correction:' || r.id::text,
       'journal_backfill', 'admin', 'adjustment',
       jsonb_build_object(
         'settlement', '20261007134548_the_diamond_tournament_lane_journal_rows_are_settled',
         'issue', 6411,
         'corrects', r.id, 'corrects_type', r.transaction_type, 'corrects_reference', r.reference_id,
         'corrects_created_at', r.created_at,
         'reason', 'fn_poker_diamond_tournament_drain journalled a fee that left custody for the house and never touched the wallet',
         'balance_changed', false)
  FROM zz_lane_rows r
 ORDER BY r.created_at, r.id;

-- 4. PROOF: the journal explains every balance, no balance moved, the register
--    did not follow, no Lifetime VIP lot moved, and the identity is whole.
DO $proof$
DECLARE v_gaps bigint; v_new bigint; v_reg bigint; v_lots bigint; v_diff numeric;
BEGIN
  SELECT count(*) INTO v_gaps FROM public.profiles p
   WHERE p.diamonds::bigint <> COALESCE((SELECT SUM(t.amount) FROM public.diamond_transactions t
                                          WHERE t.user_id = p.id), 0)::bigint;
  IF v_gaps <> 0 THEN
    RAISE EXCEPTION '% wallets still have a balance their journal cannot explain', v_gaps;
  END IF;
  SELECT count(*) INTO v_new FROM public.diamond_transactions WHERE reference_id LIKE 'tournament_lane_correction:%';
  IF v_new <> 4 THEN
    RAISE EXCEPTION '% correction rows, not 4', v_new;
  END IF;
  SELECT count(*) INTO v_reg FROM public.ca_mint_ledger m
    JOIN public.diamond_transactions t ON t.id = m.diamond_tx_id
   WHERE t.reference_id LIKE 'tournament_lane_correction:%';
  IF v_reg <> 0 THEN
    RAISE EXCEPTION 'the register followed % correction rows', v_reg;
  END IF;
  SELECT count(*) INTO v_lots FROM public.lifetime_vip_diamond_lot_allocations a
    JOIN public.diamond_transactions t ON t.id::text = a.transaction_id::text
   WHERE t.reference_id LIKE 'tournament_lane_correction:%';
  IF v_lots <> 0 THEN
    RAISE EXCEPTION 'a correction allocated % Lifetime VIP lots', v_lots;
  END IF;
  SELECT difference INTO v_diff FROM public.fn_ca_diamond_register_vs_supply();
  IF v_diff IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole (difference %)', v_diff;
  END IF;
  RAISE NOTICE '4 tournament-lane rows corrected; every journal explains its balance; register untouched; identity 0';
END
$proof$;

COMMIT;
