-- 20260907235112_the_ledger_learns_the_word_wheel_prize.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- chip_ledger_category_check learns ONE word, 'wheel_prize': a union bank or a
-- standalone club treasury paying a Diamond Wheel prize into a member wallet
-- (20260907233833). Dropped and re-added NOT VALID, the way 20260903165749 did
-- for the hierarchy words: no scan of the journal, no long lock.
--
-- It is its own migration because the ACCESS EXCLUSIVE lock this takes on
-- chip_ledger must be held by a transaction that holds NOTHING ELSE. The first
-- attempt, inside the bridge-rate migration, deadlocked (40P01) against a live
-- writer that held chip_ledger and was waiting on a lock that transaction had
-- already taken; Postgres killed the migration and it rolled back clean.
-- lock_timeout bounds this one: if live play holds the table for longer than
-- three seconds, this fails cleanly and is re-run, it never waits.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ── 3. the ledger vocabulary learns the wheel ─────────────────────────────────
ALTER TABLE public.chip_ledger DROP CONSTRAINT chip_ledger_category_check;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_category_check
  CHECK ((category = ANY (ARRAY['buyin'::text, 'cashout'::text, 'rake'::text, 'commission'::text, 'transfer'::text, 'player_funding'::text, 'agent_funding'::text, 'mint'::text, 'burn'::text, 'legacy_seed_reconcile'::text, 'rakeback'::text, 'settlement'::text, 'tournament_buyin'::text, 'tournament_prize'::text, 'bounty'::text, 'adjustment'::text, 'refund'::text, 'addon'::text, 'rebuy'::text, 'table_cashout'::text, 'tournament_refund'::text, 'bbj_contribution'::text, 'bbj_payout'::text, 'promo'::text, 'promo_release'::text, 'promo_send'::text, 'credit_draw'::text, 'credit_repayment'::text, 'insurance'::text, 'spin_entry'::text, 'spin_prize'::text, 'overlay'::text, 'correction'::text, 'reversal'::text, 'escrow_hold'::text, 'escrow_release'::text, 'treasury_transfer'::text, 'horse_funding'::text, 'fee'::text, 'eco'::text, 'pnl_settlement'::text, 'union_send'::text, 'cashier_send'::text, 'cashier_claim_back'::text, 'ticket_issue'::text, 'ticket_redeem'::text, 'club_opening_allocation'::text, 'leaderboard_payout'::text, 'club_bank_send'::text, 'club_bank_claim'::text, 'agent_send'::text, 'agent_claim'::text, 'union_settlement'::text, 'wheel_prize'::text])))
  NOT VALID;


DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.chip_ledger'::regclass AND conname = 'chip_ledger_category_check';
  IF v_def NOT LIKE '%''wheel_prize''%' OR v_def NOT LIKE '%NOT VALID' THEN
    RAISE EXCEPTION 'POST-APPLY: chip_ledger_category_check lacks wheel_prize or is not NOT VALID';
  END IF;
  IF v_def NOT LIKE '%''union_settlement''%' OR v_def NOT LIKE '%''spin_prize''%' THEN
    RAISE EXCEPTION 'POST-APPLY: an existing word went missing from chip_ledger_category_check';
  END IF;
END $$;

COMMIT;
