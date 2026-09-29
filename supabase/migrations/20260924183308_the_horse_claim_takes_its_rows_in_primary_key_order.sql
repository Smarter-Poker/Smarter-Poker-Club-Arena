-- 20260924183308_the_horse_claim_takes_its_rows_in_primary_key_order
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-24 18:33:08 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- THE THIRTEENTH JOB WAS AUDITED FOR RETIREMENT AND KEPT. IT DEADLOCKS.
--
-- ca-horse-claim-due-minute runs SELECT public.fn_ca_horse_claim_due(500)
-- every minute, 1,440 times a day, the same cadence as ca-auto-reconcile-tick
-- which this programme retired on 2026-09-24. It was read against the same
-- standard and it is NOT the same thing. The evidence either way is below,
-- because the next agent will ask again.
--
-- WHY IT IS NOT A COMPENSATION LOOP. It repairs no state and corrects no
-- writer. It IS the horse's claim button. A human is shown a completed reward
-- and presses Claim; a horse has no browser, so the engine presses for it,
-- which is the input-device branch CLAUDE.md 10.5 allows by name alongside
-- HorseLogic, scheduleHorseAction and the synthetic heartbeat. Nothing else
-- claims for a horse, so there is no writer it is standing in for. The law
-- tests/a-horse-claim-button-is-keyed-to-who-is-owed.law.test.ts argued this
-- when the claim was moved off the event path on 2026-09-08, and the argument
-- still holds.
--
-- WHAT WAS MEASURED, production 2026-09-24 18:19 to 18:30 UTC:
--
--   candidate set now, and at 10 minutes, 1 hour, 7 days                  0
--   claims in 24h / 7d / 14d                       1,224 / 17,314 / 46,456
--   claims since 2026-09-09 (steady state)                           54,661
--     of those, paid on the first tick after completion    54,141 (99.05%)
--     paid more than one day after completion                             0
--   busiest single minute in 14 days, against a limit of 500            294
--   minutes that hit the 500 cap                                          0
--   cron runs retained / failed                                  20,870 / 1
--
-- The counter-argument was taken seriously and it fails on the numbers. The
-- clock never ADDS a row to its candidate set: completed_at >= now() - 7 days
-- is a lower bound, so time only ever removes. Rows enter when a writer sets
-- completed. That is the shape of a poll standing in for a trigger, and 99.05%
-- of rows waiting exactly one tick is what that looks like. But the state it
-- acts on is not a defect: completed and unclaimed is the normal, correct
-- state of a reward for every player, and a human sits in it for up to seven
-- days by choice. Paying it is an action in the domain, not a correction of a
-- bad write. Retiring this would leave horses unpaid, which is the opposite of
-- what retiring ca-auto-reconcile-tick did. It stays.
--
-- WHAT IS ACTUALLY WRONG WITH IT, and what this migration fixes.
--
-- 33 claims failed with `deadlock detected` between 2026-09-09 01:12 and
-- 2026-09-22 13:17, across 29 separate horses, filed as CH3:horse_claim_failed.
--
-- fn_expire_daily_challenge_rewards had this same failure on 2026-09-09 and
-- its fix is in its own body: take the rows in primary key order, because
-- "ordering by primary key gives every caller the same acquisition order,
-- which is what makes a cycle impossible", and SKIP LOCKED so a row another
-- writer is holding right now is left for the next run.
--
-- This claim loop never got that fix. It walks ORDER BY u.completed_at, u.id
-- and holds every row lock it takes for the whole batch, because the entire
-- FOR loop is one transaction. The four daily-missions-outbox-minute shards
-- run on the same minute and each updates one player's challenge rows in a
-- single unordered bulk UPDATE. Two writers taking overlapping rows in
-- different orders is the cycle, and the deadlock timestamps sit in the
-- overnight hours where the outbox drain, the reward expiry at 00:07 and this
-- job all land together.
--
-- NO MONEY WAS LOST. Every one of the 1,982 rewards belonging to those 29
-- horses was claimed on a later tick; 0 expired unclaimed. The cost was
-- latency and a warning incident per occurrence, not a short player. The
-- 5,627 rewards worth 196,169 diamonds that DID expire unclaimed all completed
-- between 2026-08-31 19:10 and 2026-09-01 11:11, before this job first ran at
-- 2026-09-08 04:40, and are not in scope here.
--
-- THE FIX. Pick the oldest candidates first, which is what keeps a limit from
-- stranding whatever is closest to expiring, then take their locks in primary
-- key order with SKIP LOCKED. Selection fairness is unchanged; acquisition
-- order is now the same one every other writer on this table uses, and the
-- loop no longer waits on a challenge row at all, so it cannot be the waiting
-- party in a cycle.
--
-- @live-proof: (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_ca_horse_claim_due' AND p.prosrc LIKE '%SKIP LOCKED%' AND p.prosrc LIKE '%ORDER BY u.id%') = 1
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $precheck$
DECLARE
  v_active bigint;
  v_total  bigint;
  v_src    text;
BEGIN
  -- (a) The roster this was measured against. This migration schedules and
  --     unschedules nothing, so the count must be unchanged on both sides.
  SELECT count(*) FILTER (WHERE active), count(*) INTO v_active, v_total FROM cron.job;
  IF v_active IS DISTINCT FROM 121 OR v_total IS DISTINCT FROM 123 THEN
    RAISE EXCEPTION 'refused: cron.job holds % active of % rows; this expected 121 of 123. Re-measure, do not guess.',
      v_active, v_total;
  END IF;

  -- (b) The job stays. A retirement would be a different migration with a
  --     different argument, and this one must not be mistaken for it.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-horse-claim-due-minute' AND active) THEN
    RAISE EXCEPTION 'refused: ca-horse-claim-due-minute is not scheduled; this migration fixes it, it does not create it';
  END IF;

  -- (c) The defect is present as described: the loop orders by completed_at
  --     and takes no skip-locked batch.
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_horse_claim_due';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'refused: fn_ca_horse_claim_due is not defined';
  END IF;
  IF v_src LIKE '%SKIP LOCKED%' THEN
    RAISE EXCEPTION 'refused: fn_ca_horse_claim_due already takes a skip-locked batch; someone else has been here';
  END IF;

  -- (d) The precedent this copies is still live, so the two agree afterwards.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_expire_daily_challenge_rewards'
         AND p.prosrc LIKE '%SKIP LOCKED%') <> 1 THEN
    RAISE EXCEPTION 'refused: fn_expire_daily_challenge_rewards no longer uses the ordered skip-locked pattern this copies';
  END IF;
END;
$precheck$;

CREATE OR REPLACE FUNCTION public.fn_ca_horse_claim_due(p_limit integer DEFAULT 500)
 RETURNS TABLE(claimed integer, capped integer, failed integer, ran boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; v_claimed integer := 0; v_capped integer := 0; v_failed integer := 0; v_msg text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'fn_ca_horse_claim_due: service_role required';
  END IF;

  -- THE PLATFORM FREEZE (CLAUDE.md 13 rule 5). This moves money every minute, and profiles and
  -- diamond_transactions are NOT among the tables zz_freeze_guard protects - so nothing else would
  -- have stopped it crediting inside a :55-:00 break.
  IF public.fn_platform_frozen() THEN
    RETURN QUERY SELECT 0, 0, 0, false;
    RETURN;
  END IF;

  -- xact-scoped: released at commit or rollback, with no unlock path to miss. The session-scoped
  -- form skipped its unlock on a statement timeout, because EXCEPTION WHEN OTHERS does not trap
  -- query_canceled - harmless under pg_cron (the backend exits) and a permanent leak from a pooled
  -- service_role backend, which also holds EXECUTE on this.
  IF NOT pg_try_advisory_xact_lock(hashtext('ca_horse_claim_due')) THEN
    -- `ran = false` and not a zero count: "another run holds the lock" and "nothing was owed" are
    -- different answers and must not share a representation (CLAUDE.md 10.86 rule 1).
    RETURN QUERY SELECT 0, 0, 0, false;
    RETURN;
  END IF;

  -- OLDEST FIRST TO CHOOSE, PRIMARY KEY ORDER TO LOCK (2026-09-24).
  --
  -- 33 claims died with `deadlock detected` between 2026-09-09 and 2026-09-22,
  -- across 29 horses. The whole loop is one transaction, so it holds every row
  -- lock it takes until it ends; it took them in completed_at order, while the
  -- four outbox drain shards update one player's rows in a single unordered
  -- bulk UPDATE on the same minute. Overlapping rows taken in two different
  -- orders is the cycle.
  --
  -- fn_expire_daily_challenge_rewards hit this on 2026-09-09 and its body
  -- carries the answer: primary key order gives every caller the same
  -- acquisition order, which is what makes a cycle impossible, and SKIP LOCKED
  -- leaves a row somebody is holding right now for the next run rather than
  -- waiting behind it. A skipped row is not a stranded one; it is still the
  -- oldest thing owed a minute later, so it is picked first next time.
  --
  -- The inner select still chooses by completed_at, so the limit continues to
  -- take what is closest to expiring. Only the order the locks are acquired in
  -- has changed, and the loop now never waits on a challenge row at all.
  FOR r IN
    WITH oldest AS (
      SELECT u.id
        FROM public.user_daily_challenges u
        JOIN public.profiles p ON p.id = u.user_id AND p.is_horse
       WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
         AND u.completed_at >= now() - interval '7 days'
       ORDER BY u.completed_at, u.id
       LIMIT GREATEST(COALESCE(p_limit, 500), 1)
    )
    SELECT u.id, u.user_id
      FROM public.user_daily_challenges u
      JOIN oldest o ON o.id = u.id
     ORDER BY u.id
       FOR UPDATE OF u SKIP LOCKED
  LOOP
    BEGIN
      PERFORM public.claim_daily_challenge_serialized_body(r.user_id, r.id, NULL);
      v_claimed := v_claimed + 1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg LIKE '%DR7:user_over_daily_cap%' THEN
        -- COUNTED, NOT FILED. A thousand horses meet the cap daily so an incident would be an
        -- always-on alarm, but returning it means the caller can see a run that paid nothing
        -- because everything was capped - which after DR7 arms is the difference between a
        -- backlog draining and a backlog dying.
        v_capped := v_capped + 1;
      ELSE
        v_failed := v_failed + 1;
        BEGIN
          PERFORM public.fn_ca_diamond_incident(
            'CH3:horse_claim_failed', 'warning', r.user_id, NULL, 'fn_ca_horse_claim_due',
            jsonb_build_object('challenge_row_id', r.id, 'sqlerrm', v_msg));
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END IF;
    END;
  END LOOP;

  RETURN QUERY SELECT v_claimed, v_capped, v_failed, true;
END $function$;

DO $verify$
DECLARE
  v_active bigint;
  v_total  bigint;
  v_src    text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_horse_claim_due';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'failed: fn_ca_horse_claim_due is not defined';
  END IF;
  IF v_src NOT LIKE '%SKIP LOCKED%' THEN
    RAISE EXCEPTION 'failed: the claim loop does not take a skip-locked batch';
  END IF;
  IF v_src NOT LIKE '%ORDER BY u.id%' THEN
    RAISE EXCEPTION 'failed: the claim loop does not take its rows in primary key order';
  END IF;
  IF v_src NOT LIKE '%ORDER BY u.completed_at, u.id%' THEN
    RAISE EXCEPTION 'failed: the candidate select no longer chooses the oldest first';
  END IF;
  IF v_src NOT LIKE '%pg_try_advisory_xact_lock%' THEN
    RAISE EXCEPTION 'failed: the run lock was dropped';
  END IF;
  IF v_src NOT LIKE '%fn_platform_frozen%' THEN
    RAISE EXCEPTION 'failed: the freeze guard was dropped';
  END IF;
  IF v_src NOT LIKE '%claim_daily_challenge_serialized_body%' THEN
    RAISE EXCEPTION 'failed: the claim no longer goes through the platform path';
  END IF;

  -- The job is untouched. This migration fixes how it takes its rows; it does
  -- not schedule, unschedule or re-time anything.
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'ca-horse-claim-due-minute'
                    AND active
                    AND schedule = '* * * * *'
                    AND command = 'SELECT public.fn_ca_horse_claim_due(500)') THEN
    RAISE EXCEPTION 'failed: ca-horse-claim-due-minute is not scheduled as it was';
  END IF;

  SELECT count(*) FILTER (WHERE active), count(*) INTO v_active, v_total FROM cron.job;
  IF v_active IS DISTINCT FROM 121 OR v_total IS DISTINCT FROM 123 THEN
    RAISE EXCEPTION 'failed: % active of % rows, expected the roster unchanged at 121 of 123', v_active, v_total;
  END IF;

  RAISE NOTICE 'PASS: the horse claim chooses oldest first and locks in primary key order; roster unchanged at 121 of 123';
END;
$verify$;

COMMIT;
