-- 20260922155223_eleven_compensation_jobs_whose_writers_are_correct_stop_running
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-22 15:52:23 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- THE PRINCIPLE
--
-- Owner policy v2.9: never add or rely on a cron, watcher, reconciler or
-- repair loop to compensate for a defect; fix the writer at its source and
-- pin it. CLAUDE.md 10.11 and 10.12 say the same thing from the other end: a
-- repair job is DEBT, and deleting it is part of the fix.
--
-- Each job below was built to catch a state that some writer used to leave
-- behind. Each of those writers is now correct at the source, in the same
-- transaction as the thing it writes. Each job's candidate set is empty now,
-- and each has done zero work for seven days or more. A job in that state
-- repairs nothing and is read as coverage: it makes a closed defect look
-- watched, and it would make a re-opened one look handled. So it stops.
--
-- Classified by four agents on 2026-09-22. Every figure marked "measured" was
-- re-verified against production by the coordinator at 15:42 UTC; the ones
-- marked "re-read" were read again, read-only, between 16:02 and 16:13 UTC
-- while this file was written. Job ids are production's.
--
-- ===========================================================================
-- 1. ca-redrive-unbanked-rake-15m (jobid 217, 7,22,37,52 * * * *)
--
-- Ran fn_redrive_unbanked_rake(200): re-drove the kind = 'rake' rows of
-- pending_fee_distributions through atomic_distribute_rake, the outbox the
-- engine wrote when it could not bank a hand's rake inline.
--
-- The writer: since 2026-09-09 21:56 UTC fn_ca_commit_hand_settlement is the
-- only accepted-hand door, and it refuses a hand whose rake is not carried by
-- its post-commit envelope (post_commit_fee_mismatch), in the transaction
-- that writes the hand. fn_ca_process_hand_post_commit_obligations banks that
-- envelope atomically, or it stays pending and visible.
--
-- Measured: kind = 'rake' unresolved = 0; the last rake row was queued
-- 2026-09-08 17:30:16 UTC (re-read). 20260920070402 kept this job as "a real
-- queue", and as a description of a queue that was right. What changed is
-- that nothing has produced rake into it for fourteen days: it drains an
-- outbox with no producer. It only ever read kind = 'rake'; the bbj_payout
-- rows in the same table are not its business and are untouched here.
--
-- NOT REMOVED: fn_redrive_unbanked_rake stays. fn_ca_auto_reconcile_tick
-- (ca-auto-reconcile-tick, jobid 164) still calls it when a drift incident is
-- open, and that job is in its own 24-hour observation window.
--
-- ===========================================================================
-- 2. rake-repair-unbanked-hourly (jobid 268, 2,17,32,47 * * * *)
--
-- Ran fn_rake_repair_unbanked(6, 200): recovered raked hands the engine did
-- not survive to bank.
--
-- The writer is the same door as in 1. Measured: financial_alerts from
-- source fn_rake_repair_unbanked in 7 days = 0. Its last real work was
-- 2026-09-14, 3 hands during an engine incident, and each of those already
-- had an envelope. That is the harm it could do: its repairs wrote NULL
-- player_contributions, and under atomic_distribute_rake's first-claim rule a
-- repair that won the race against a merely LATE envelope destroyed that
-- hand's per-player attribution.
--
-- The rake alarm no longer times its checks by this job's schedule:
-- the_rake_audit_reads_the_envelope_not_a_repair_schedule (recorded
-- 20260922150512) gives I5 and I7 the writer's own grace, and I9 counts an
-- envelope that is late rather than lost. Measured: I7 = 0 and I9 = 0 live.
--
-- NOT REMOVED: fn_rake_repair_unbanked stays defined. Nothing else calls it;
-- fn_rake_bbj_audit only names it inside a comment.
--
-- ===========================================================================
-- 3. ca-union-rake-attribution-hourly (jobid 254, 20 * * * *)
--
-- Ran fn_ca_attribute_union_rake(3): wrote ca_union_rake_attribution, the
-- club of each player who paid union cash rake, an hour after the fact.
--
-- The writer: atomic_distribute_rake records rake_attributions.club_id at
-- bank time, through fn_cash_earning_club. Measured: 100,991 attributions in
-- 24 hours, 0 with a null club.
--
-- Nothing reads what this job wrote. Re-read: the only function in the
-- database that names ca_union_rake_attribution is its own writer; no view
-- or materialized view reads it; no code in either repository does. The
-- 2026-09-03 part-three weekly close read it; the live close does not.
--
-- NOT REMOVED: the function and the table stay, as history.
--
-- ===========================================================================
-- 4. ca-bounty-backpay-hourly (jobid 225, 12 * * * *)
--
-- Ran fn_backpay_unfinalised_bounty_pools(true, 200): paid bounty pools that
-- a completed tournament had funded and never distributed.
--
-- The writer: fn_complete_tournament_terminal_pre_seat_guard pays the bounty
-- pool in the completion transaction and raises unless what it paid equals
-- the pool, and the deferred constraint trigger
-- non_satellite_completed_requires_terminal_receipt refuses COMPLETED
-- without that receipt. Measured: backpay effects in 7 days = 0; last real
-- work 2026-09-03; 0 unpaid bounty events since 2026-09-09 22:01:30 UTC.
--
-- The two leftover PKO events, a21c0cb6 and 3f19bd70 (ended 2026-09-07), are
-- escrow_short. This job could never pay them; they wait on the owner's
-- funding decision, and retiring it changes nothing for either.
--
-- NOT REMOVED: fn_backpay_unfinalised_bounty_pools stays.
-- fn_ca_settlement_lane_doctrine lists it among the functions allowed the
-- global lane, and one alert detail in fn_payout_guarantee_check still says
-- it "re-drives" a bounty residual. That sentence is now untrue. It is not
-- rewritten here, because this migration changes no function.
--
-- ===========================================================================
-- 5. ca-payout-sweep-hourly (jobid 276, 52 * * * *)
--
-- Ran fn_tournament_payout_sweep(7, true, 150000): topped up unpaid places
-- of COMPLETED events.
--
-- The writer: completion pays every place in its own transaction and raises
-- unless the cash paid equals the pool, behind the same deferred trigger as
-- in 4. Measured: tournament_payouts with source 'reconcile' in 7 days = 0;
-- last real work 2026-09-06.
--
-- NOT REMOVED: fn_tournament_payout_sweep stays.
-- tourney_payout_sweep_detect_daily, an observer that is KEPT, runs it every
-- night with p_apply = false.
--
-- ===========================================================================
-- 6. spin_repair_missing_multiplier (jobid 142, */15 * * * *)
--
-- Ran fn_spin_repair_missing_multiplier(240): reconstructed the drawn
-- multiplier of a RUNNING or COMPLETED Spin whose row carried none.
--
-- The writer: fn_spin_draw_and_settle_atomic stamps the multiplier and reads
-- it back inside the launch transaction; the launch gate refuses a paid Spin
-- RUNNING without exactly one jackpot_draw equal to that stamp; and the
-- trigger spin_tournament_contract_is_draw refuses any later change to it.
-- Measured: candidates at any age = 0; effects in 7 days = 0; last real work
-- 2026-09-06; 37,116 Spins since 2026-09-10, every one correct.
--
-- 20260920070402 kept this job because 115 zero-multiplier Spins sat in
-- REGISTERING. That is the correct state: a Spin is born undrawn and is drawn
-- by the launch that deals it, which is exactly the gate above.
--
-- NOT REMOVED: the function stays. fn_spin_sweep_unbooked still calls it.
--
-- ===========================================================================
-- 7. spin_sweep_unbooked (jobid 141, */5 * * * *)
--
-- Ran fn_spin_sweep_unbooked(60): booked the reserve movements of a Spin
-- that ran without them.
--
-- The writer: the atomic draw books the entry, draws, settles and writes its
-- receipt in one transaction. Measured: unbooked at any age = 0; no bookings
-- by this job in 14 days; last real work 2026-09-01; 0 of 37,391 draws since
-- 2026-09-10 lack a receipt.
--
-- NOT REMOVED, AND NOT THE LAST CALLER: fn_spin_sweep_unbooked stays, and
-- this retires only its pg_cron schedule. The World Hub route
-- pages/api/cron/spin-sweep.js still calls it (lookback 14 days, and through
-- it fn_spin_repair_missing_multiplier), dispatched by Open Claw at
-- 7,22,37,52 per scripts/openclaw-cron-dispatcher.py on World Hub main
-- 05571f26b8. That caller lives in another repository and is not changed
-- here; with an empty candidate set it books nothing.
--
-- ===========================================================================
-- 8. ca-spin-return-unawarded-draws-15m (jobid 353, 8,23,38,53 * * * *)
--
-- Ran fn_ca_return_unawarded_spin_draws(true, 200): returned to the reserve
-- the part of a drawn prize that a finished Spin's escrow kept.
--
-- The writer: atomic_cancel_tournament refuses to cancel a drawn Spin, and
-- terminal settlement closes the escrow at exactly 0. Measured:
-- surplus_return in 7 days = 0; 0 changes in 1,269 scheduled runs. Both
-- historical returns were written by migrations, not by this schedule.
--
-- NOT REMOVED: the function stays.
--
-- ===========================================================================
-- 9. ca-promo-accrual-retry-10m (jobid 183, 4,14,24,34,44,54 * * * *)
--
-- Ran fn_ca_retry_promo_accruals(200): retried promo accruals parked in
-- ca_pending_promo_accruals.
--
-- ca_pending_promo_accruals has NEVER held a row (re-read: 0), and nothing
-- writes it. Playthrough is applied inside the atomic settlement envelope,
-- pinned by PostCommitObligationBarrier.guard.test.ts.
--
-- NOT REMOVED: the function and the table stay.
--
-- ===========================================================================
-- 10. ca-post-commit-orphan-drain-10m (jobid 352, */10 * * * *)
--
-- Ran fn_ca_drain_orphaned_post_commit_envelopes(): applied post-commit
-- envelopes left incomplete for more than ten minutes.
--
-- The writer: the hand commit writes its outbox row and its envelope in one
-- transaction, and trigger a0_finish_hand_post_commit_obligations (BEFORE
-- DELETE on hand_projection_outbox) refuses to delete an outbox row before
-- its envelope is applied. Measured: incomplete envelopes older than ten
-- minutes = 0 (re-read at 16:12:56 UTC: 0, with 4 younger ones in flight);
-- 0 of about 2.5M retained commits ever completed more than ten minutes late.
--
-- NOT REMOVED: the function stays.
--
-- ===========================================================================
-- 11. ca-pgrst-reload-if-stale (jobid 182, */5 * * * *)
--
-- Ran fn_ca_pgrst_reload_if_stale(): sent PostgREST a schema reload every
-- five minutes whenever DDL had run in the last fifteen.
--
-- Measured: 276 forced reloads in 7 days and none fixed anything; 0 PGRST002
-- errors on every day from 2026-09-11 to 2026-09-22. It forced reloads after
-- DDL that PostgREST had already loaded. Correct at the source since
-- 20260831142242: the authenticator statement_timeout is 5min, and the event
-- triggers pgrst_ddl_watch and pgrst_drop_watch are enabled (both re-read,
-- live). tests/postgrest-is-never-reloaded-on-a-timer.law.test.ts is already
-- on main.
--
-- NOT REMOVED: the function stays; that law refuses scheduling it again.
-- pgrst-reload-watchdog is an OBSERVER and is KEPT.
--
-- ===========================================================================
-- WHAT IS DELIBERATELY NOT TOUCHED
--
-- Writer fixed, observation window still running, so NOT retired today:
-- ca-auto-reconcile-tick (24 hours), reconcile-tournament-denormals (7
-- days), reconcile-club-member-daily-profit (2026-09-23 to 2026-09-29).
-- Kept as genuine periodic work or as observers: everything else, including
-- tourney_payout_sweep_detect_daily and pgrst-reload-watchdog, which the
-- verify block below requires to still be scheduled.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- Eleven rows leave cron.job: 132 -> 121 active, 134 -> 123 in total. The two
-- retained-inactive rows (the bust sweeps 20260910073355 restored disabled)
-- are unchanged. All 134 rows belong to postgres, so the counts below are the
-- whole roster as the applying role reads it.
--
-- No DDL, so PostgREST reloads nothing. No function is created, replaced or
-- dropped. No money row is written. One transaction; it refuses rather than
-- guesses if the roster, an obligation queue, or a source barrier is not what
-- was measured.
--
-- The roster file docs/attestation/cron-roster.tsv and
-- tests/the-scheduled-work-roster-is-pinned.law.test.ts move to 121 in the
-- same change. tests/a-retired-compensation-job-is-never-scheduled-again.law.test.ts
-- refuses any later migration that schedules one of these eleven names, or
-- one of the three 20260920070402 retired, again.
--
-- @live-proof: (SELECT count(*) FROM cron.job WHERE jobname IN ('ca-redrive-unbanked-rake-15m', 'rake-repair-unbanked-hourly', 'ca-union-rake-attribution-hourly', 'ca-bounty-backpay-hourly', 'ca-payout-sweep-hourly', 'spin_repair_missing_multiplier', 'spin_sweep_unbooked', 'ca-spin-return-unawarded-draws-15m', 'ca-promo-accrual-retry-10m', 'ca-post-commit-orphan-drain-10m', 'ca-pgrst-reload-if-stale')) = 0
-- ===========================================================================

-- RE-MEASURED 2026-09-24 02:47 UTC, two days after this file was written.
-- Production had gained one job in between: ca-crash-settle-abandoned-minute,
-- scheduled 2026-09-23 by migration an_abandoned_crash_round_settles_itself.
-- So the roster this refuses to guess about is 133 active of 135 rows, not
-- 132 of 134, and eleven retirements leave 122 of 124. Every piece of
-- evidence above was re-run at that time and still reads zero. A twelfth
-- job, ca-auto-reconcile-tick, finished its observation window clean and is
-- retired by the migration immediately after this one, which takes the
-- roster to 121 of 123.
--
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $retire$
DECLARE
  v_retiring CONSTANT text[] := ARRAY[
    'ca-redrive-unbanked-rake-15m',
    'rake-repair-unbanked-hourly',
    'ca-union-rake-attribution-hourly',
    'ca-bounty-backpay-hourly',
    'ca-payout-sweep-hourly',
    'spin_repair_missing_multiplier',
    'spin_sweep_unbooked',
    'ca-spin-return-unawarded-draws-15m',
    'ca-promo-accrual-retry-10m',
    'ca-post-commit-orphan-drain-10m',
    'ca-pgrst-reload-if-stale'
  ];
  v_active  bigint;
  v_total   bigint;
  v_present bigint;
  v_owed    bigint;
  v_name    text;
  v_jobid   bigint;
BEGIN
  -- (a) The roster this was measured against. If another writer has moved
  --     it, the arithmetic below is not ours to assume: refuse, never guess.
  SELECT count(*) FILTER (WHERE active), count(*)
    INTO v_active, v_total
    FROM cron.job;
  IF v_active IS DISTINCT FROM 133 OR v_total IS DISTINCT FROM 135 THEN
    RAISE EXCEPTION 'refused: cron.job holds % active of % rows; this retirement was re-measured at 133 of 135 on 2026-09-24. Another writer changed the roster. Re-measure, do not guess.',
      v_active, v_total;
  END IF;
  SELECT count(*) INTO v_present
    FROM cron.job
   WHERE jobname = ANY (v_retiring) AND active;
  IF v_present IS DISTINCT FROM 11 THEN
    RAISE EXCEPTION 'refused: % of the eleven jobs are active, measured 11', v_present;
  END IF;

  -- (b) Nothing is owed that one of these jobs would have been the one to
  --     deliver. Each was zero when measured; a non-zero now means the
  --     evidence moved, and the job must not be retired on stale evidence.
  SELECT count(*) INTO v_owed
    FROM public.pending_fee_distributions
   WHERE resolved_at IS NULL AND kind = 'rake';
  IF v_owed > 0 THEN
    RAISE EXCEPTION 'refused: % unresolved rake outbox row(s); the redrive still has work', v_owed;
  END IF;
  SELECT count(*) INTO v_owed FROM public.ca_pending_promo_accruals;
  IF v_owed > 0 THEN
    RAISE EXCEPTION 'refused: % pending promo accrual row(s); that table has never held one', v_owed;
  END IF;
  SELECT count(*) INTO v_owed
    FROM public.hand_atomic_commits c
   WHERE c.post_commit_payload IS NOT NULL
     AND c.post_commit_completed_at IS NULL
     AND c.committed_at < now() - interval '10 minutes';
  IF v_owed > 0 THEN
    RAISE EXCEPTION 'refused: % post-commit envelope(s) incomplete for over ten minutes; the orphan drain still has work', v_owed;
  END IF;

  -- (c) The source fixes each retirement relies on are in place. If one is
  --     missing or disabled, this would remove a net from an open defect.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.tournaments'::regclass
       AND t.tgname = 'non_satellite_completed_requires_terminal_receipt'
       AND t.tgenabled = 'O' AND t.tgdeferrable AND t.tginitdeferred
  ) THEN
    RAISE EXCEPTION 'refused: the deferred terminal-receipt trigger on tournaments is absent, disabled or not deferred';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.tournaments'::regclass
       AND t.tgname = 'spin_tournament_contract_is_draw'
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'refused: spin_tournament_contract_is_draw is absent or disabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.hand_projection_outbox'::regclass
       AND t.tgname = 'a0_finish_hand_post_commit_obligations'
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'refused: a0_finish_hand_post_commit_obligations is absent or disabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_commit_hand_settlement'
       AND position('post_commit_fee_mismatch' in p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION 'refused: the accepted-hand door no longer refuses rake outside its envelope';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'atomic_distribute_rake'
       AND position('fn_cash_earning_club' in p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION 'refused: atomic_distribute_rake no longer records the earning club at bank time';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'fn_complete_tournament_launch_before_lease_generation'
       AND position('jackpot_draw' in p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION 'refused: the Spin launch gate no longer reads the jackpot draw';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('fn_spin_draw_and_settle_atomic',
                           'fn_ca_process_hand_post_commit_obligations',
                           'fn_complete_tournament_terminal_pre_seat_guard')) <> 3 THEN
    RAISE EXCEPTION 'refused: an atomic writer this retirement relies on is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE r.rolname = 'authenticator'
       AND 'statement_timeout=5min' = ANY (r.rolconfig)
  ) THEN
    RAISE EXCEPTION 'refused: the authenticator statement_timeout is no longer 5min';
  END IF;
  IF (SELECT count(*) FROM pg_event_trigger e
       WHERE e.evtname IN ('pgrst_ddl_watch', 'pgrst_drop_watch')
         AND e.evtenabled <> 'D') <> 2 THEN
    RAISE EXCEPTION 'refused: a PostgREST DDL event trigger is absent or disabled';
  END IF;

  -- (d) Retire. Only a job that is present is unscheduled.
  FOREACH v_name IN ARRAY v_retiring LOOP
    v_jobid := NULL;
    SELECT j.jobid INTO v_jobid FROM cron.job j WHERE j.jobname = v_name;
    IF v_jobid IS NULL THEN
      RAISE NOTICE 'already absent: %', v_name;
    ELSE
      PERFORM cron.unschedule(v_jobid);
      RAISE NOTICE 'retired % (jobid %)', v_name, v_jobid;
    END IF;
  END LOOP;
END;
$retire$;

DO $verify$
DECLARE
  v_left     bigint;
  v_names    text;
  v_active   bigint;
  v_total    bigint;
  v_inactive text;
  v_missing  text;
BEGIN
  -- None of the eleven remains, active or not.
  SELECT count(*), coalesce(string_agg(jobname, ', ' ORDER BY jobname), '')
    INTO v_left, v_names
    FROM cron.job
   WHERE jobname IN ('ca-redrive-unbanked-rake-15m',
                     'rake-repair-unbanked-hourly',
                     'ca-union-rake-attribution-hourly',
                     'ca-bounty-backpay-hourly',
                     'ca-payout-sweep-hourly',
                     'spin_repair_missing_multiplier',
                     'spin_sweep_unbooked',
                     'ca-spin-return-unawarded-draws-15m',
                     'ca-promo-accrual-retry-10m',
                     'ca-post-commit-orphan-drain-10m',
                     'ca-pgrst-reload-if-stale');
  IF v_left > 0 THEN
    RAISE EXCEPTION 'failed: still scheduled: %', v_names;
  END IF;

  -- Exactly 121 active remain, 123 rows in total, and the two inactive rows
  -- are the bust sweeps 20260910073355 restored disabled.
  SELECT count(*) FILTER (WHERE active), count(*),
         coalesce(string_agg(jobname, ', ' ORDER BY jobname) FILTER (WHERE NOT active), '')
    INTO v_active, v_total, v_inactive
    FROM cron.job;
  IF v_active IS DISTINCT FROM 122 OR v_total IS DISTINCT FROM 124 THEN
    RAISE EXCEPTION 'failed: % active of % rows remain, expected 122 of 124', v_active, v_total;
  END IF;
  IF v_inactive IS DISTINCT FROM 'ca-eliminate-absent-players, ca-release-broke-seats' THEN
    RAISE EXCEPTION 'failed: the retained-inactive rows changed: %', v_inactive;
  END IF;

  -- The jobs kept for observation, and the observers, are still scheduled.
  SELECT string_agg(k.jobname, ', ' ORDER BY k.jobname)
    INTO v_missing
    FROM unnest(ARRAY['ca-auto-reconcile-tick',
                      'reconcile-tournament-denormals',
                      'reconcile-club-member-daily-profit',
                      'tourney_payout_sweep_detect_daily',
                      'pgrst-reload-watchdog']) AS k(jobname)
   WHERE NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = k.jobname AND j.active);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'failed: a job kept on purpose is not scheduled: %', v_missing;
  END IF;

  -- The functions kept on purpose are still there, and still reached the way
  -- the header says: the redrive through the incident-gated tick, the payout
  -- sweep through the observer in detect mode only.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('fn_redrive_unbanked_rake', 'fn_tournament_payout_sweep')) <> 2 THEN
    RAISE EXCEPTION 'failed: a function this retirement keeps on purpose is gone';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_auto_reconcile_tick'
       AND position('fn_redrive_unbanked_rake' in p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION 'failed: fn_ca_auto_reconcile_tick no longer reaches the rake redrive';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cron.job j
     WHERE j.jobname = 'tourney_payout_sweep_detect_daily'
       AND j.command ~ 'fn_tournament_payout_sweep\(\s*\d+\s*,\s*false\s*,'
  ) THEN
    RAISE EXCEPTION 'failed: tourney_payout_sweep_detect_daily no longer runs the sweep in detect mode';
  END IF;

  RAISE NOTICE 'PASS: eleven compensation jobs retired; 122 active of 124; the observed and observing jobs, and the functions kept on purpose, are in place';
END;
$verify$;

COMMIT;
