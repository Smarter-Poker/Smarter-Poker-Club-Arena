-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260908010225; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260908010225   (the stamp IS the apply time, UTC: 2026-09-08 01:02:25)
--   name        the_ledger_learns_plinko_and_crash_prizes
--   created_by  (not recorded)
--   statements  1 statement(s), 3237 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260908010225 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     CONSTRAINT     chip_ledger_category_check on public.chip_ledger

--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- 20260908010225_the_ledger_learns_plinko_and_crash_prizes.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- chip_ledger_category_check learns TWO words, 'plinko_prize' and
-- 'crash_prize': a union bank or a standalone club treasury paying a Diamond
-- Plinko or Diamond Crash payout into a member wallet (20260908010241, the two
-- alternates to the wheel Dan asked for on 2026-09-08). Dropped and re-added
-- NOT VALID, the way 20260907235112 did for 'wheel_prize': no scan of the
-- journal, no long lock.
--
-- Its own migration for the reason that one was: the ACCESS EXCLUSIVE lock on
-- chip_ledger must be held by a transaction that holds NOTHING ELSE, or it
-- deadlocks against live play (40P01 on 2026-09-07). lock_timeout bounds it.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE public.chip_ledger DROP CONSTRAINT chip_ledger_category_check;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_category_check
  CHECK ((category = ANY (ARRAY['buyin'::text, 'cashout'::text, 'rake'::text, 'commission'::text, 'transfer'::text, 'player_funding'::text, 'agent_funding'::text, 'mint'::text, 'burn'::text, 'legacy_seed_reconcile'::text, 'rakeback'::text, 'settlement'::text, 'tournament_buyin'::text, 'tournament_prize'::text, 'bounty'::text, 'adjustment'::text, 'refund'::text, 'addon'::text, 'rebuy'::text, 'table_cashout'::text, 'tournament_refund'::text, 'bbj_contribution'::text, 'bbj_payout'::text, 'promo'::text, 'promo_release'::text, 'promo_send'::text, 'credit_draw'::text, 'credit_repayment'::text, 'insurance'::text, 'spin_entry'::text, 'spin_prize'::text, 'overlay'::text, 'correction'::text, 'reversal'::text, 'escrow_hold'::text, 'escrow_release'::text, 'treasury_transfer'::text, 'horse_funding'::text, 'fee'::text, 'eco'::text, 'pnl_settlement'::text, 'union_send'::text, 'cashier_send'::text, 'cashier_claim_back'::text, 'ticket_issue'::text, 'ticket_redeem'::text, 'club_opening_allocation'::text, 'leaderboard_payout'::text, 'club_bank_send'::text, 'club_bank_claim'::text, 'agent_send'::text, 'agent_claim'::text, 'union_settlement'::text, 'wheel_prize'::text, 'plinko_prize'::text, 'crash_prize'::text])))
  NOT VALID;

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.chip_ledger'::regclass AND conname = 'chip_ledger_category_check';
  IF v_def NOT LIKE '%''plinko_prize''%' OR v_def NOT LIKE '%''crash_prize''%' OR v_def NOT LIKE '%NOT VALID' THEN
    RAISE EXCEPTION 'POST-APPLY: chip_ledger_category_check lacks plinko_prize / crash_prize or is not NOT VALID';
  END IF;
  IF v_def NOT LIKE '%''wheel_prize''%' OR v_def NOT LIKE '%''union_settlement''%' OR v_def NOT LIKE '%''spin_prize''%' THEN
    RAISE EXCEPTION 'POST-APPLY: an existing word went missing from chip_ledger_category_check';
  END IF;
END $$;

COMMIT;
