-- 20260906004441_the_replay_reads_the_balances_and_the_journal_at_one_instant.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 7 gate, 2026-09-06 00:5x UTC):
--
-- With the keying corrected, a judged run over a 2.5 minute window fell from
-- 159 disagreements to 9, and every one of the nine is the same shape: the
-- felt read 6.45 above its journal on a movement of 5,686.37, a club treasury
-- 0.22 on 24.39, three BBJ banks between 0.06 and 0.13, one player wallet
-- 20.00 flat. They are the window's edge, not chips: the run fixes the end of
-- its window and then reads the balances, so a leg that commits in between is
-- in the balance and not yet in the journal. The two-interval rule already
-- cancels it on the next run, which is why nothing accumulates.
--
-- But it does not have to happen at all. A REPEATABLE READ transaction takes
-- one snapshot of the database and answers every read in the run from it, so
-- the balances and the journal come from the same instant by construction and
-- the edge disappears. The nightly job now asks for that isolation before it
-- calls the replay; anything else that calls the replay by hand gets the old
-- behaviour and the two-interval rule, which is correct but noisier.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DO $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'ca-ledger-replay-nightly';
  IF v_id IS NULL THEN RAISE EXCEPTION 'ca-ledger-replay-nightly is not scheduled'; END IF;
  PERFORM cron.alter_job(v_id, command => $c$ SET statement_timeout = '600s';
          SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
          SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-ledger-replay'))
                      THEN (public.fn_ca_ledger_replay(5000))::text
                      ELSE 'locked' END; $c$);
END $$;

COMMENT ON FUNCTION public.fn_ca_ledger_replay(integer) IS
  'Chip standard Phase 7.1: checks that each account''s change between its own two most recent readings equals the journal''s net over the same interval. CALL IT IN A REPEATABLE READ TRANSACTION (the nightly job does): under READ COMMITTED a leg that commits between the window end and the balance read shows as a residue, which the two-interval rule then cancels on the next run.';

DO $$
BEGIN
  IF (SELECT command FROM cron.job WHERE jobname = 'ca-ledger-replay-nightly') NOT LIKE '%REPEATABLE READ%' THEN
    RAISE EXCEPTION 'the nightly replay does not ask for one snapshot';
  END IF;
END $$;

COMMIT;
