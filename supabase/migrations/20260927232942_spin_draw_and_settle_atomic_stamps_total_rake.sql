-- 20260927232942_spin_draw_and_settle_atomic_stamps_total_rake
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-27 23:29:42 UTC.
--
-- ===========================================================================
--  A SPIN THAT DRAWS ITS MULTIPLIER NEVER STAMPS ITS OWN RAKE
-- ===========================================================================
--
-- Production Alerts board (Smarter-Poker/Smarter-Poker-Club-Arena#5070),
-- SpinUnfilledBacklog: 121 open rows across 13 tournaments, all created
-- 2026-09-08 13:34-14:44 UTC, all status='REGISTERING', started_at IS NULL,
-- with a booked spin_reserve_ledger 'jackpot_draw' and spin_multiplier
-- stamped (2x-100x), 1-2 live seats where 3 were required. Read live on
-- 2026-09-27: every one of the 13 has tournaments.prize_pool exactly equal
-- to tournament_escrow.prize_balance, but tournaments.total_rake is 0.00
-- while tournament_escrow.fee_balance holds the real rake (always exactly
-- 12% of prize_pool - 0.24/2.00, 24.00/200.00, 0.48/4.00, ... across all 13,
-- confirming one systemic cause, not 13 unrelated data errors).
--
-- ROOT CAUSE, read from public.fn_spin_draw_and_settle_atomic
-- (20260910034412_spin_draw_gate_reads_zero_as_undrawn_and_stamps_the_row.sql):
-- the ONE UPDATE public.tournaments this function issues at draw time sets
-- spin_multiplier, prize_pool, spin_locked_tiers, blind_structure and
-- payout_structure from the draw it just booked - but never total_rake,
-- even though the same statement's own v_settle (fn_spin_settle_game's
-- return value, already in scope) carries the exact rake amount as
-- 'house_rake'. total_rake=0 stays wrong forever unless some LATER step
-- corrects it; for a Spin whose launch completes normally that later step
-- is presumably reached, but any Spin that draws and then never launches
-- (this fleet's engine died at the 2026-09-08 12:49-14:53 UTC maintenance
-- break before completing launch for these 13 - see
-- 20260911173003_a_game_that_was_dealt_finishes_with_the_field_it_has.sql's
-- own header for that incident) is left with a permanently wrong cache.
--
-- This is not merely cosmetic: fn_ca_tournament_refund_plan and
-- atomic_cancel_tournament both assert tournaments.total_rake equals
-- tournament_escrow.fee_balance before they will touch a tournament at all
-- (P0404 'caches do not equal exact escrow before cancellation', proved live
-- in a rolled-back probe against 8904c10b-6a47-4934-bdf2-def1b1e76f0b on
-- 2026-09-27 - the drift alone is enough to refuse the platform's own
-- cancellation authority). A stuck Spin can never be recovered while its own
-- cache disagrees with its own escrow.
--
-- FIX: the same UPDATE now also stamps total_rake from v_settle's
-- 'house_rake', and the existing exact-readback IF right after it (which
-- already re-reads spin_multiplier/prize_pool/spin_locked_tiers from the
-- row to prove the write landed) now checks total_rake the same way. Applied
-- only inside the `v_provenance = 'at_draw'` branch, unchanged for the
-- separate `legacy_projection` cutover-recovery path, which never runs this
-- UPDATE at all. No other line of the function changes.
--
-- DATA CORRECTION: the 13 already-affected rows' total_rake is brought into
-- line with tournament_escrow.fee_balance, which was ALREADY correct (synced
-- from rake_records by fn_ca_escrow_apply independently of this bug). No
-- wallet, chip_ledger, rake_records or spin_reserve_ledger row is touched or
-- created - this corrects one denormalized cache column to match evidence
-- that already exists, exactly as CLAUDE.md 10.9 requires before any
-- financial-adjacent write. It does not cancel, settle or pay these 13
-- tournaments: fn_ca_tournament_refund_plan enforces a SEPARATE invariant
-- (escrow vs. tournament_refund_entitlements) that Spin's seat-first buy-in
-- never populates, drawn or not - a distinct, deeper gap in the cancellation
-- path, not fixed here, and documented on the board for the next run.
--
-- Verification: rolled-back production probe (CLAUDE.md 11.5) confirmed
-- (a) the transformed function body is valid PL/pgSQL and applies with no
-- syntax error, (b) the exact preimage/postimage md5 pair below, (c) the
-- one-time UPDATE's WHERE clause matches exactly the 13 rows this incident
-- named and zero others, re-checked by the DO block after it.
--
-- Law to add in a follow-up: a regression test pinning that a fresh Spin
-- draw stamps total_rake = house_rake in the same transaction (fails on the
-- preimage, passes on this migration) belongs in
-- server/src/tournament/ or supabase/tests alongside this repo's other
-- spin-tournament-contract guards; not written in this migration because it
-- requires a live PostgreSQL harness this session could not run locally
-- (CLAUDE.md 11.5 rule 5 - the logic is reasoned about and proved by probe
-- instead, stated here plainly).
--
-- This migration replaces a function body via string surgery on its own
-- pg_get_functiondef text (EXECUTE v_new) rather than a static CREATE
-- statement, so check-migrations-are-live.mjs's declaredObjects scan finds
-- no object to watch. tests/a-merged-migration-must-be-live.law.test.ts
-- requires a live-proof line for exactly that shape:
-- @live-proof: NOT EXISTS (SELECT 1 FROM public.tournaments t JOIN public.tournament_escrow e ON e.tournament_id = t.id WHERE t.id IN ('2aa4cba1-506f-426b-a1ba-d8e22e018533','6d359f61-d681-49ba-82f3-00493178e5b3','7284506c-093c-491a-8da7-5816bf1ccccf','44d7e2d8-66ed-48ae-a1cb-306ae92b6dfa','482e90bb-ef9d-4135-9067-9f0332c94142','8904c10b-6a47-4934-bdf2-def1b1e76f0b','8d5969da-df76-44fa-8c83-5608b844ca06','95e43b6e-c1c9-445e-a1d9-cbe711e3bac1','efd5455d-d188-4171-becb-1d35b016d06a','c2fd1c7e-9572-4b95-90dd-3b999777a145','9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8','b3b65e07-6b3a-4b6c-b5d1-aeb5af17fa99','b67ab0cb-e2d6-4955-8f43-4bff32551400') AND t.total_rake IS DISTINCT FROM e.fee_balance)

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $fix$
DECLARE
  v_orig text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_orig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'fn_spin_draw_and_settle_atomic' AND n.nspname = 'public';

  IF v_orig IS NULL OR md5(v_orig) <> '19e06d2d13a5f53cd7c59686802dae4a' THEN
    RAISE EXCEPTION 'PREIMAGE: fn_spin_draw_and_settle_atomic is not the definition read 2026-09-27 (got %)',
      md5(v_orig);
  END IF;

  v_new := replace(
    replace(v_orig,
      E'    UPDATE public.tournaments\n       SET spin_multiplier   = v_multiplier,\n           prize_pool        = v_prize,\n           spin_locked_tiers = v_locked,\n           blind_structure   = v_blinds::text,\n           payout_structure  = v_payouts::text\n     WHERE id = p_tournament_id;',
      E'    UPDATE public.tournaments\n       SET spin_multiplier   = v_multiplier,\n           prize_pool        = v_prize,\n           total_rake        = COALESCE((v_settle->>''house_rake'')::numeric, 0),\n           spin_locked_tiers = v_locked,\n           blind_structure   = v_blinds::text,\n           payout_structure  = v_payouts::text\n     WHERE id = p_tournament_id;'
    ),
    E'            AND t.spin_locked_tiers IS NOT DISTINCT FROM v_locked) THEN',
    E'            AND t.spin_locked_tiers IS NOT DISTINCT FROM v_locked\n            AND t.total_rake IS NOT DISTINCT FROM COALESCE((v_settle->>''house_rake'')::numeric, 0)) THEN'
  );

  IF md5(v_new) <> '15068828849d2ded72c3eaf3373761b7' THEN
    RAISE EXCEPTION 'TRANSFORM: expected postimage functiondef md5 15068828849d2ded72c3eaf3373761b7, got %',
      md5(v_new);
  END IF;

  EXECUTE v_new;
END;
$fix$;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'fn_spin_draw_and_settle_atomic' AND n.nspname = 'public'
       AND md5(pg_get_functiondef(p.oid)) = '15068828849d2ded72c3eaf3373761b7'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_spin_draw_and_settle_atomic body/owner/security/volatility drifted from the intended fix';
  END IF;
END
$post$;

-- One-time cache correction for the exact 13 legacy rows this bug already
-- produced. See header: brings tournaments.total_rake into line with
-- tournament_escrow.fee_balance, which already carries the correct amount.
WITH legacy_spin_rake_drift AS (
  SELECT t.id, e.fee_balance
    FROM public.tournaments t
    JOIN public.tournament_escrow e ON e.tournament_id = t.id
   WHERE t.variant = 'spin'
     AND t.status = 'REGISTERING'
     AND t.started_at IS NULL
     AND COALESCE(t.spin_multiplier, 0) > 0
     AND t.total_rake IS DISTINCT FROM e.fee_balance
     AND EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                  WHERE l.tournament_id = t.id AND l.kind = 'jackpot_draw')
     AND NOT EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.tournament_id = t.id)
     AND NOT EXISTS (SELECT 1 FROM public.tables tb JOIN public.hand_history hh
                       ON hh.table_id = tb.id WHERE tb.tournament_id = t.id)
)
UPDATE public.tournaments t
   SET total_rake = d.fee_balance
  FROM legacy_spin_rake_drift d
 WHERE t.id = d.id;

DO $data_post$
DECLARE
  v_remaining integer;
  v_corrected integer;
BEGIN
  SELECT count(*) INTO v_remaining
    FROM public.tournaments t
    JOIN public.tournament_escrow e ON e.tournament_id = t.id
   WHERE t.variant = 'spin' AND t.status = 'REGISTERING' AND t.started_at IS NULL
     AND COALESCE(t.spin_multiplier, 0) > 0
     AND t.total_rake IS DISTINCT FROM e.fee_balance
     AND EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                  WHERE l.tournament_id = t.id AND l.kind = 'jackpot_draw');
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'DATA POSTIMAGE: % legacy drawn-spin row(s) still have a total_rake/escrow mismatch',
      v_remaining;
  END IF;

  SELECT count(*) INTO v_corrected
    FROM public.tournaments t
   WHERE t.id IN (
     '2aa4cba1-506f-426b-a1ba-d8e22e018533', '6d359f61-d681-49ba-82f3-00493178e5b3',
     '7284506c-093c-491a-8da7-5816bf1ccccf', '44d7e2d8-66ed-48ae-a1cb-306ae92b6dfa',
     '482e90bb-ef9d-4135-9067-9f0332c94142', '8904c10b-6a47-4934-bdf2-def1b1e76f0b',
     '8d5969da-df76-44fa-8c83-5608b844ca06', '95e43b6e-c1c9-445e-a1d9-cbe711e3bac1',
     'efd5455d-d188-4171-becb-1d35b016d06a', 'c2fd1c7e-9572-4b95-90dd-3b999777a145',
     '9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8', 'b3b65e07-6b3a-4b6c-b5d1-aeb5af17fa99',
     'b67ab0cb-e2d6-4955-8f43-4bff32551400')
     AND t.total_rake > 0;
  IF v_corrected <> 13 THEN
    RAISE EXCEPTION 'DATA POSTIMAGE: expected exactly 13 named legacy rows corrected, got %', v_corrected;
  END IF;
END
$data_post$;

COMMIT;
