-- four_producers_that_measure_the_wrong_thing
--
-- CLAUDE.md 10.11/10.12: the reasoning goes in this header, not just the SQL.
-- Four open drift incidents, one of them a live outage, and in every case the
-- thing that needed changing was the PRODUCER, not the row.
--
-- ===========================================================================
-- 1. THE LIVE ONE: hand-history retention has been dead, and said so quietly
-- ===========================================================================
--
-- Incident 54809ab1, fn_ca_cron_failure_watch: sp_prune_hand_history_10m had
-- failed 12 times in 2h with zero successes. Read from cron.job_run_details:
--
--   ERROR: recorded_cash_earning_source_is_immutable
--   CONTEXT: PL/pgSQL function fn_accounting_cash_source_immutable() line 16
--     SQL statement "DELETE FROM public.rake_attributions WHERE hand_id=ANY(v_doomed)"
--     PL/pgSQL function sp_prune_hand_history(integer) line 109
--
-- Both sides are behaving correctly and they disagree, so one of them is
-- asking for the wrong thing:
--
--   * accounting_cash_source_immutable (BEFORE INSERT OR DELETE OR UPDATE on
--     rake_attributions) refuses to let an attribution move once
--     accounting_cash_accrual_batches holds a batch for its rake record. That
--     attribution IS the recorded earning source - the basis every rakeback
--     figure and every agent commission is derived from. It is right to refuse.
--   * the pruner deleted those attributions on its way to deleting the hand.
--
-- IT NEVER HAD TO. Measured: there is NO foreign key from
-- rake_attributions.hand_id to hand_history.id (the only FKs on that table are
-- to agents and profiles), so nothing referential required the delete. It was
-- a voluntary tidy-up of an accounting record by a STORAGE job.
--
-- And it was worse than unnecessary. rake_attributions also carries
-- trg_ca_club_rake_daily_user_del, so each deleted attribution DECREMENTS the
-- per-club per-user daily rake rollup - the rakeback basis cache. A retention
-- pass that ran to completion would have quietly reduced recorded club rake
-- for every horse in every pruned hand. Horses are players (10.5) and that is
-- their rakeback basis.
--
-- Dan's retention ruling (CLAUDE.md 10.5, eight days since 2026-09-17) is
-- explicitly a STORAGE decision about hand HISTORY. It says nothing about the
-- money ledger, and the money ledger is not pruned. So the fix is one line
-- removed: the pruner stops touching rake_attributions.
--
-- PROVED FIRST, ROLLED BACK (CLAUDE.md 11.5). One transaction, one DO block
-- ending in RAISE EXCEPTION, against production on 2026-09-25:
--
--   PROBE OK (rolled back): retention=8 days, hands=5, attributions on them=16
--   of which accounted=16; without the rake_attributions DELETE the prune
--   completed: idx=18 commits=5 history=5
--
-- All 16 attributions on the five oldest doomed hands were already accounted,
-- which is exactly why every run raised; with that one DELETE gone the other
-- three complete. No DDL was probed (Production DDL policy rules 3 and 7).
--
-- ===========================================================================
-- 2. A FALSE CRITICAL THAT INVITED A BANNED REPAIR JOB BACK
-- ===========================================================================
--
-- Incident b310c260, fn_ca_guard_integrity_check, CRITICAL, 35 occurrences:
-- "3 zero-drift guard(s) are MISSING or disabled - a protection was dropped".
-- The three are not protections. They are compensation jobs that 10.12
-- required to STOP RUNNING, each unscheduled by a migration that says so:
--
--   ca-auto-reconcile-tick       20260924025037_the_incident_tick_that_repairs_nothing_stops_running
--   ca-promo-accrual-retry-10m   20260922155223_eleven_compensation_jobs_whose_writers_are_correct_stop_running
--   ca-payout-sweep-hourly       20260922155223_eleven_compensation_jobs_whose_writers_are_correct_stop_running
--
-- tests/a-retired-compensation-job-is-never-scheduled-again.law.test.ts
-- forbids all three from ever being scheduled again. So a CRITICAL alarm was
-- standing over the board demanding the one action a law forbids, and the
-- cheapest way to silence it was to commit that violation. That is not a
-- cosmetic false positive.
--
-- ca_guard_inventory already has the right shape for this: fn_ca_guard_-
-- integrity_check reads `WHERE active`, and id 30 (ca-bbj-repair-unbanked-15m)
-- was deactivated on 2026-09-20 with a note naming its retiring migration.
-- These three get the identical treatment. The rows are KEPT, not deleted, so
-- the history of what was once demanded stays readable.
--
-- ===========================================================================
-- 3. A WARNING THAT IS TRUE FOR SIX DAYS OUT OF EVERY SEVEN
-- ===========================================================================
--
-- Incidents 7a7a08d6 (fn_union_credit_risk_check) and c8fa487e
-- (fn_union_governance_check), 87 occurrences each - and ONE cause, because
-- fn_union_governance_check delegates to fn_union_credit_risk_check. Both
-- report union_eco_not_recorded: "Unions with ECO enabled and no
-- union_eco_ledger row for the current settlement week".
--
--   AND NOT EXISTS (SELECT 1 FROM union_eco_ledger l
--                    WHERE l.union_id = un.id
--                      AND l.period_start >= fn_union_week_start())
--
-- fn_union_week_start() is the start of the week IN PROGRESS. The ECO ledger
-- is written when a week CLOSES. So the invariant asks for a row that cannot
-- exist yet, and it is unsatisfiable from the moment a week begins until the
-- moment it ends. Measured: it first fired at 2026-09-21 07:52, fifty-two
-- minutes after the week rolled over at 07:00, and has fired on every
-- conservation sweep since. Midway Union is the only ECO union, its 09-07 week
-- closed at 09-14 07:05 and its 09-14 week at 09-17 16:57; nothing is missing.
--
-- The invariant worth having is the one this was reaching for: once a week has
-- CLOSED, its ECO must be on file. That is the previous week, so the fence
-- moves back one week. A week that closes without ECO then fires at the next
-- sweep instead of never, and the six-day-a-week false warning stops.
-- Re-measured with the corrected predicate: 0 offenders.
--
-- ===========================================================================
-- 4. A HELPER IS NOT A CHECK
-- ===========================================================================
--
-- Incident a6323605, fn_ca_orphaned_checks_watch: "1 integrity check
-- function(s) exist that nothing ever runs." The function is
-- fn_ca_integrity_json_numeric(p_value jsonb, p_key text) - a scalar helper
-- that pulls a number out of a jsonb payload. It finds nothing, reports
-- nothing and cannot be scheduled into the sweep in any meaningful way, so
-- every remedy the alert offers is wrong for it.
--
-- fn_ca_orphaned_checks already carries this exact distinction: "A DOOR IS NOT
-- A CHECK", excluding anything whose arguments name an actor, an op id, a case
-- id or a request id. p_value belongs in that list for the same reason and it
-- is the same sentence one step further: a function HANDED the data to inspect
-- is a helper; a check goes and finds its own. Re-measured with p_value in the
-- exclusion: 0 orphans.
--
-- ===========================================================================
-- WHAT THIS MIGRATION IS NOT
-- ===========================================================================
--
-- No cron, sweep, healer, backfill, re-drive or catch-up is created, and none
-- is revived (10.12). No money moves: the only DML is four rows of inventory
-- metadata, five incident resolutions, and one call to the platform's own
-- retention job, whose schedule IS the product (10.12's first exception).
--
-- Every function body is changed by asserted substitution rather than
-- retyped: the anchor is required to appear EXACTLY ONCE in the live
-- definition before anything is replaced, so if the function is not the one
-- this was derived against, the whole transaction aborts.

-- THIS FILE CREATES NO PERSISTENT OBJECT THAT A PARSER CAN SEE. Every function
-- it changes is replaced through EXECUTE on an asserted substitution, so there
-- is no literal CREATE for declaredObjects to find, and it states its own
-- proof instead - the convention
-- tests/a-merged-migration-must-be-live.law.test.ts binds from 20260920.
-- All four expressions were run read-only against production on 2026-09-25,
-- after this migration committed, and all four returned true.
--
-- These eight comment lines were added to the file AFTER it was applied, so
-- the file is two paragraphs longer than the statements recorded at version
-- 20260925143224. That is deliberate and it changes nothing that executes:
-- this is a new migration, not a recording being pardoned by
-- scripts/ci/recording-only.mjs, so no check asks the two to be byte-equal.
-- @live-proof: (SELECT position('A RECORDED EARNING SOURCE IS NOT HAND HISTORY' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'sp_prune_hand_history')
-- @live-proof: (SELECT count(*) = 0 FROM public.ca_guard_inventory WHERE kind = 'cron' AND active AND object_a IN ('ca-auto-reconcile-tick','ca-promo-accrual-retry-10m','ca-payout-sweep-hourly'))
-- @live-proof: (SELECT position('week that has CLOSED' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_union_credit_risk_check')
-- @live-proof: (SELECT position('p_request_id|p_value' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_ca_orphaned_checks')

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '280s';

-- ---------------------------------------------------------------------------
-- 1. the pruner stops deleting a recorded earning source
-- ---------------------------------------------------------------------------
DO $mig1$
DECLARE
  v_src text; v_new text; v_anchor text; v_repl text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sp_prune_hand_history'
     AND pg_get_function_identity_arguments(p.oid) = 'p_batch integer';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'REFUSED: public.sp_prune_hand_history(integer) is absent';
  END IF;

  v_anchor := E'      DELETE FROM public.rake_attributions WHERE hand_id=ANY(v_doomed);\n';
  v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'REFUSED: expected exactly 1 rake_attributions DELETE in sp_prune_hand_history, found %. '
      'The function is not the one this change was derived against; re-read it.', v_n;
  END IF;

  v_repl := E'      -- A RECORDED EARNING SOURCE IS NOT HAND HISTORY (2026-09-25).\n'
         || E'      -- This line used to delete the pruned hands rake attributions, and\n'
         || E'      -- every run of sp_prune_hand_history_10m raised\n'
         || E'      -- recorded_cash_earning_source_is_immutable for it: the trigger\n'
         || E'      -- accounting_cash_source_immutable refuses to move an attribution once\n'
         || E'      -- accounting_cash_accrual_batches holds a batch for its rake record.\n'
         || E'      -- The trigger is right and the DELETE was never required: there is no\n'
         || E'      -- foreign key from rake_attributions.hand_id to hand_history.id. It\n'
         || E'      -- also fired trg_ca_club_rake_daily_user_del, which would have\n'
         || E'      -- decremented the per-club per-user daily rake rollup - the rakeback\n'
         || E'      -- basis - for every horse in every pruned hand (CLAUDE.md 10.5).\n'
         || E'      -- Retention is a storage decision about hand HISTORY (10.5, eight\n'
         || E'      -- days); the money ledger is not pruned, so attributions are kept.\n';

  v_new := replace(v_src, v_anchor, v_repl);
  IF v_new = v_src THEN RAISE EXCEPTION 'REFUSED: the substitution changed nothing'; END IF;
  IF position('A RECORDED EARNING SOURCE IS NOT HAND HISTORY' in v_new) = 0 THEN
    RAISE EXCEPTION 'REFUSED: the explanation of what was removed is not there';
  END IF;
  IF position('DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);' in v_new) = 0
  OR position('DELETE FROM public.hand_atomic_commits WHERE hand_id=ANY(v_doomed);' in v_new) = 0
  OR position('DELETE FROM public.hand_history WHERE id=ANY(v_doomed);' in v_new) = 0
  OR position('horse_retention_days' in v_new) = 0
  OR position('f06_hand_cards_unresolved' in v_new) = 0
  OR position('has_human IS DISTINCT FROM true' in v_new) = 0
  OR position('FOR UPDATE SKIP LOCKED' in v_new) = 0 THEN
    RAISE EXCEPTION 'REFUSED: the substitution lost part of the retention pass';
  END IF;
  IF v_new ~* 'DELETE[[:space:]]+FROM[[:space:]]+public\.rake_attributions' THEN
    RAISE EXCEPTION 'REFUSED: a rake_attributions DELETE survived the substitution';
  END IF;

  EXECUTE v_new;
  RAISE NOTICE 'sp_prune_hand_history no longer deletes a recorded earning source';
END
$mig1$;

-- ---------------------------------------------------------------------------
-- 2. three retired compensation jobs stop being demanded as guards
-- ---------------------------------------------------------------------------
DO $mig2$
DECLARE v_n int;
BEGIN
  UPDATE public.ca_guard_inventory SET active = false,
    note = 'automated repair - RETIRED 2026-09-24 by migration '
        || '20260924025037_the_incident_tick_that_repairs_nothing_stops_running under law '
        || '10.12. Over the 7 days to 2026-09-22 it rewrote auto_repair_status 139 times, '
        || 're-drove rake and BBJ 7,774 times moving nothing, and closed 0 incidents as '
        || 're-verified clean. tests/a-retired-compensation-job-is-never-scheduled-again.'
        || 'law.test.ts forbids scheduling it again, so demanding it here made a CRITICAL '
        || 'alarm ask for a law violation. Deactivated 2026-09-25, row kept as history.'
   WHERE kind = 'cron' AND object_a = 'ca-auto-reconcile-tick' AND active;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected 1 active ca-auto-reconcile-tick row, updated %', v_n; END IF;

  UPDATE public.ca_guard_inventory SET active = false,
    note = 'phase 5: promo accrual redrive every 10 min - RETIRED 2026-09-22 by migration '
        || '20260922155223_eleven_compensation_jobs_whose_writers_are_correct_stop_running '
        || 'under law 10.12, its writer being correct at the source. '
        || 'tests/a-retired-compensation-job-is-never-scheduled-again.law.test.ts forbids '
        || 'scheduling it again. Deactivated 2026-09-25, row kept as history.'
   WHERE kind = 'cron' AND object_a = 'ca-promo-accrual-retry-10m' AND active;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected 1 active ca-promo-accrual-retry-10m row, updated %', v_n; END IF;

  UPDATE public.ca_guard_inventory SET active = false,
    note = 'audit follow-through: hourly winner-payout sweep - RETIRED 2026-09-22 by '
        || 'migration 20260922155223_eleven_compensation_jobs_whose_writers_are_correct_'
        || 'stop_running under law 10.12. fn_tournament_payout_sweep stays defined and is '
        || 'still scheduled in DETECT mode only as tourney_payout_sweep_detect_daily '
        || '(p_apply false), which is the kept observer; the applying schedule is the one '
        || 'that was retired. Deactivated 2026-09-25, row kept as history.'
   WHERE kind = 'cron' AND object_a = 'ca-payout-sweep-hourly' AND active;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected 1 active ca-payout-sweep-hourly row, updated %', v_n; END IF;

  IF EXISTS (SELECT 1 FROM cron.job
              WHERE jobname IN ('ca-auto-reconcile-tick','ca-promo-accrual-retry-10m',
                                'ca-payout-sweep-hourly')) THEN
    RAISE EXCEPTION 'REFUSED: a retired compensation job is scheduled; law 10.12';
  END IF;
END
$mig2$;

-- ---------------------------------------------------------------------------
-- 3. the ECO invariant asks about the week that CLOSED
-- ---------------------------------------------------------------------------
DO $mig3$
DECLARE
  v_src text; v_new text; v_fence text; v_detail_old text; v_detail_new text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_credit_risk_check';
  IF v_src IS NULL THEN RAISE EXCEPTION 'REFUSED: fn_union_credit_risk_check is absent'; END IF;

  v_fence := 'l.period_start >= fn_union_week_start())';
  v_n := (length(v_src) - length(replace(v_src, v_fence, ''))) / length(v_fence);
  IF v_n <> 1 THEN RAISE EXCEPTION 'REFUSED: expected exactly 1 ECO week fence, found %', v_n; END IF;

  -- the detail sentence is replaced in the same pass, because a predicate that
  -- asks about the closed week while its message says "current" is the next
  -- reader's wasted hour.
  v_detail_old := $a$'Unions with ECO enabled and no union_eco_ledger row for the current '
         || 'settlement week: this week''s win tax / loss rebate is not reproducible'$a$;
  v_n := (length(v_src) - length(replace(v_src, v_detail_old, ''))) / length(v_detail_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'REFUSED: expected exactly 1 ECO detail sentence, found %', v_n; END IF;
  v_detail_new := $a$'Unions with ECO enabled and no union_eco_ledger row for the settlement '
         || 'week that has CLOSED: that week''s win tax / loss rebate is not reproducible. '
         || 'The ledger is written at close, so the week in progress is not asked about'$a$;

  v_new := replace(
             replace(v_src, v_fence,
               'l.period_start >= fn_union_week_start() - interval ''7 days'')'),
             v_detail_old, v_detail_new);
  IF position('union_eco_not_recorded' in v_new) = 0
  OR position('union_club_no_terms' in v_new) = 0
  OR position('union_club_stop_loss_breached' in v_new) = 0
  OR position('union_club_stakes_above_cap' in v_new) = 0 THEN
    RAISE EXCEPTION 'REFUSED: the substitution lost a credit-risk invariant';
  END IF;
  EXECUTE v_new;
  RAISE NOTICE 'the ECO invariant now asks about the week that closed';
END
$mig3$;

-- ---------------------------------------------------------------------------
-- 4. a function handed the data to inspect is a helper, not a check
-- ---------------------------------------------------------------------------
DO $mig4$
DECLARE v_src text; v_new text; v_anchor text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_orphaned_checks';
  IF v_src IS NULL THEN RAISE EXCEPTION 'REFUSED: fn_ca_orphaned_checks is absent'; END IF;

  v_anchor := '(p_actor|p_op_id|p_case_id|p_request_id)';
  v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'REFUSED: expected exactly 1 door-is-not-a-check argument list, found %', v_n;
  END IF;

  v_new := replace(v_src, v_anchor, '(p_actor|p_op_id|p_case_id|p_request_id|p_value)');
  IF position('ca_check_sweep_exemptions' in v_new) = 0
  OR position('fn_ca_conservation_sweep' in v_new) = 0 THEN
    RAISE EXCEPTION 'REFUSED: the substitution lost part of the orphan detector';
  END IF;
  EXECUTE v_new;
  RAISE NOTICE 'a function handed its data is no longer counted as an orphaned check';
END
$mig4$;

-- ---------------------------------------------------------------------------
-- 5. re-measure all four, then close what cleared
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_n bigint; v_rows int; v_pruned int;
  v_ref text := 'migration 20260925140016_four_producers_that_measure_the_wrong_thing';
BEGIN
  -- The retention job runs. Its schedule IS the product (10.12's first
  -- exception), so calling it once here is the job working, not a repair.
  v_pruned := public.sp_prune_hand_history(500);
  RAISE NOTICE 'retention pass completed without refusal: % hand(s) pruned', v_pruned;

  SELECT count(*) INTO v_n FROM public.fn_ca_guard_integrity_check() WHERE ok IS NOT TRUE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard integrity still reports % finding(s)', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.fn_union_credit_risk_check()
   WHERE invariant = 'union_eco_not_recorded';
  IF v_n <> 0 THEN RAISE EXCEPTION 'union_eco_not_recorded still fires'; END IF;
  SELECT count(*) INTO v_n FROM public.fn_union_governance_check()
   WHERE invariant = 'union_eco_not_recorded';
  IF v_n <> 0 THEN RAISE EXCEPTION 'union_eco_not_recorded still reaches governance'; END IF;

  SELECT count(*) INTO v_n FROM public.fn_ca_orphaned_checks();
  IF v_n <> 0 THEN RAISE EXCEPTION 'orphaned checks still reports %', v_n; END IF;

  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
         correction_ref = v_ref,
         root_cause = 'sp_prune_hand_history deleted rake_attributions on its way to deleting a hand, and accounting_cash_source_immutable correctly refuses to move an attribution whose rake record already carries an accrual batch, so every run of sp_prune_hand_history_10m raised recorded_cash_earning_source_is_immutable and hand-history retention had stopped entirely. No foreign key ever required that DELETE.',
         resolution = 'Fixed at the source: the retention pass no longer touches rake_attributions, which are a recorded earning source and the rakeback basis rather than hand history. Re-measured inside this migration by calling sp_prune_hand_history(500), which completed without refusal.'
   WHERE id::text LIKE '54809ab1%' AND status = 'open';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'expected to close 1 cron-failure incident, closed %', v_rows; END IF;

  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
         correction_ref = v_ref,
         root_cause = 'fn_ca_guard_integrity_check demanded three cron jobs that law 10.12 required to stop running - ca-auto-reconcile-tick, ca-promo-accrual-retry-10m and ca-payout-sweep-hourly - each unscheduled by a named migration and each forbidden from ever being scheduled again by a law test. The alarm was not reporting a dropped protection; it was asking for a law violation, and the cheapest way to silence it was to commit one.',
         resolution = 'Fixed in the producer: the three retired compensation jobs are marked inactive in ca_guard_inventory with a note naming their retiring migration, exactly as ca-bbj-repair-unbanked-15m was on 2026-09-20. The rows are kept so what was once demanded stays readable, and this migration asserts none of the three is scheduled. Re-measured inside it: fn_ca_guard_integrity_check reports zero findings.'
   WHERE id::text LIKE 'b310c260%' AND status = 'open';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'expected to close 1 guard-integrity incident, closed %', v_rows; END IF;

  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
         correction_ref = v_ref,
         root_cause = 'The union_eco_not_recorded invariant required a union_eco_ledger row with period_start >= fn_union_week_start(), which is the start of the week IN PROGRESS, while the ECO ledger is written when a week CLOSES. It was therefore unsatisfiable from the moment each week began: it first fired at 2026-09-21 07:52, fifty-two minutes after the week rolled over, and on every conservation sweep since. Midway Union is the only ECO union and both of its closed weeks are on file.',
         resolution = 'Fixed in the producer: the fence moves back one week, so the invariant asks that a week which has CLOSED carries its ECO row, and the detail sentence was corrected in the same pass. A week that closes without ECO now fires at the next sweep instead of being lost in six days of noise. Re-measured inside this migration: zero offenders, through both fn_union_credit_risk_check and fn_union_governance_check, which delegates to it.'
   WHERE id::text LIKE ANY (ARRAY['7a7a08d6%','c8fa487e%']) AND status = 'open';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 2 THEN RAISE EXCEPTION 'expected to close 2 ECO incidents, closed %', v_rows; END IF;

  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
         correction_ref = v_ref,
         root_cause = 'fn_ca_orphaned_checks counted fn_ca_integrity_json_numeric(p_value jsonb, p_key text) as an integrity check that nothing runs. It is a scalar helper that pulls a number out of a jsonb payload: it finds nothing and reports nothing, so every remedy the alert offered - schedule it, add it to the sweep, exempt it - was wrong for it.',
         resolution = 'Fixed in the producer, by extending the distinction it already drew. fn_ca_orphaned_checks excluded anything whose arguments name an actor, an op id, a case id or a request id under the heading A DOOR IS NOT A CHECK; p_value joins that list for the same reason one step further - a function HANDED the data to inspect is a helper, while a check goes and finds its own. Re-measured inside this migration: zero orphans.'
   WHERE id::text LIKE 'a6323605%' AND status = 'open';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'expected to close 1 orphaned-checks incident, closed %', v_rows; END IF;

  RAISE NOTICE 'four producers corrected, five incidents closed as verified_remeasured';
END
$post$;

COMMIT;
