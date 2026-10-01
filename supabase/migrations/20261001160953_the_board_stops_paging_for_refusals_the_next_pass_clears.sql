-- ============================================================================
-- THE BOARD STOPS PAGING FOR REFUSALS THE NEXT PASS CLEARS
-- ============================================================================
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-01 16:09:53 UTC.
-- Measured on production (kuklfnapbkmacvwxktbh) 2026-10-01 15:25-16:05 UTC.
-- Companion engine change: TournamentManagerBase.noteFinishRefusal,
-- TournamentManagerEliminations.rearmIfTheFinishWasRefused,
-- ServerTableEngineBase.isTransientDbError and the leave_pending alert in
-- ServerTableEngineSettlement, in the same PR. Full evidence:
-- docs/changelog/2026-10-01-the-board-stops-paging-for-refusals-the-next-pass-clears.md
--
-- The drift board (ca_drift_incidents) carried 62 open rows at 15:25 UTC. Six
-- carry real chip drift and belong to another lane. The other 56 are mirrored
-- alerts with 0.00 drift, and this migration closes the ones whose condition
-- was READ to be over, fixes the two producers in this database that were
-- measuring the wrong thing, and leaves open - by name, with the reason - the
-- ones whose condition still holds or whose decision is the owner's.
--
-- 1. Tournament.atomic_finish_refused (23 incidents, 347 open criticals).
--    342 of the 348 alerted tournaments are COMPLETED with an immutable
--    terminal receipt; the other 6 were refused inside the last ten minutes
--    and are RUNNING toward the same outcome. Every one was refused ONCE -
--    refusal_reason timeout (333) or deadlock (7): 55P03 on the single
--    platform finish lane under an 8 s lock_timeout, five attempts and the
--    resolver, ~48 s - and paid in full on a later admission. Not one names
--    money owed. The producer (engine) now alerts a transient refusal only
--    when the same tournament has reported it three times running. The rows
--    are closed here on the receipt, which is the witness that was there.
--
-- 2. postHandTasks.leave_pending_failed (14 incidents, 14 criticals). Every
--    one is a READ failure (supabase_timeout x6, lock timeout x8) on the
--    departures enumeration or the seat-move read, before any cash-out.
--    fn_unaccounted_seat_exits(interval '4 days', interval '10 minutes')
--    returned 0 rows at 15:4x UTC; no live seat on any of the 14 tables
--    carries leave_pending. A cash-out refusal never throws out of this step
--    (processLeavePending swallows it per seat), so the step's failure cannot
--    strand a chip: the seats stay leave_pending and the next boundary
--    re-reads them. The producer (engine) now raises this as a warning with
--    moves_chips:false; the trigger below already reads that as "no critical
--    incident". The rows are closed here on the seat-exit measurement.
--
-- 3. fn_ca_journal_append_only / ui-cert-cleanup (1 incident, 148
--    occurrences, firing every certification run since 2026-09-26). The
--    Create-A-Club certification retirement (scripts/ci/production-e2e-
--    account.mjs, retireProductionCreateClubFixtures) sets
--    app.ledger_maintenance = 'ui-cert-cleanup:<club>' and deletes the cert
--    club's chip_transactions rows under it. The kind was never registered in
--    ca_ledger_maintenance_kinds, so the trigger defaulted it to warning and
--    opened a board item per run - the exact shape migration 20260910132833
--    fixed for 'certification-cleanup'. 148 reasons = 148 distinct cert
--    clubs, all PostgREST/postgres, every row preserved in
--    ca_ledger_mutation_log. Registered here as info: recorded, not raised.
--
-- 4. fn_ca_cron_failure_watch / ca-stats-witness-audit-15m (1 incident).
--    ca_stats_witness_audit timed out at its 120 s statement_timeout in 21 of
--    23 runs over six hours (log: 42-118 s when it finished). Section 2f reads
--    hand_history by primary key and unnests its action log twice for EVERY
--    distinct all-in showdown hand of the trailing week - written for "~400
--    all-in hands a week"; the covering index now returns 611,169 candidate
--    seat rows. A seat that carries all_in_equity is owed and counted whatever
--    the betting did, so the action-log read is needed only for hands with a
--    seat still owed a figure. Narrowing the `hands` CTE to those hands and
--    LEFT-joining it back changes no count: owed = (equity present) OR (no
--    betting after the all-in); missing = (equity absent) AND (no betting
--    after). Rows without a `hands` match have equity present, so the first
--    disjunct holds and the second conjunct is never reached. Asserted
--    substitution over md5-pinned live text; the after-md5 was measured in a
--    rolled-back probe (before 3b3b9610..., mid ca398f0a..., after a7738fa9...).
--
-- 5. Verified by rows and closed here:
--    - ServerTableEngine.authoritative_hand_unreachable (2 incidents, 27
--      alerts): all 27 (table_id, hand_number) pairs have a hand_history row -
--      the successor generation committed the hand the fenced one could not.
--    - Tournament.satellite_qualifiers_outcome_unknown (1 incident, 3 alerts):
--      satellite 0e1d340e settled at 2026-09-28 21:22:12 - 6 awards x 50.00 =
--      300.00 with payout ids, remainder 24.00 recorded, pool 324.00.
--    - Tournament.atomic_finish_outcome_unknown (34 alerts, 2026-09-27): all
--      34 tournaments COMPLETED with a terminal receipt.
--    - fn_ca_settlement_correctness_check:settler_lag (2 incidents): the
--      rakeback_settler watermark read 2026-10-01 15:06:05 at 15:26:24, past
--      the week the 'blocking' row named and moving within its 30 min interval.
--    - ca_diamond_incidents DR0:health_critical (1 incident + 7 diamond rows):
--      fn_ca_diamond_health_watch() returned 0 findings at 16:02 UTC;
--      ca-horse-claim-due-minute ran 180/180 successes in the last 3 hours.
--    - fn_ca_guard_defs_watch (1 notice): fn_ca_settlement_correctness_check
--      was redefined on 2026-09-27 by the settlement-coverage/settler series
--      (20260927134527 .. 20260927220353, all on main); live md5 331dfe59...
--      equals the last capture (ca_guard_def_history 27781).
--
-- 6. LEFT OPEN, deliberately, each still true at 16:05 UTC:
--    - fn_union_enforce_stop_loss x2, fn_union_age_invoices x2: Club JAQK
--      (MIDWAY-2026-000005, 33,222.29) and SHARK CLUB (MIDWAY-2026-000006,
--      11,244.03) are still `overdue`; the suspension is the stop-loss working.
--      Owner decision.
--    - fn_union_law_selftest: cron job 272 union-weekly-rakeback-close is
--      active=false, stood down by the weekly-close rework lane (changelog
--      2026-09-30-the-red-workflows-get-their-verdicts.md). The self-test is
--      right to say so until that lane reactivates it or amends the list.
--    - fn_ca_conservation_sweep x3: union_eco_not_recorded and
--      union_rake_wallet_stale (the stalled weekly cascade and the rakeback
--      settler, other lanes); fn_ca_hand_commit_refusals (206 hands refused
--      for lease proof expired today - the lease-loss storm below).
--    - postHandTasks.hand_history_failed: the lease-loss storm of 15:25-15:45
--      UTC (200-395 tournament leases expiring per burst every 2-4 minutes,
--      heartbeat statements timing out while PostgREST, tournament reads and
--      the daily-missions outbox drainer waited on MultiXactOffsetSLRU /
--      MultiXactMemberSLRU LWLocks). True, live, and another lane's.
--
-- Not changed: any wallet, seat or ledger row. No chips move in this file.
-- lock_timeout 2s inside the transaction; outside the :50-:03 window.
--
-- @live-proof: (SELECT severity FROM public.ca_ledger_maintenance_kinds WHERE kind = 'ui-cert-cleanup') = 'info'
-- @live-proof: (SELECT md5(pg_get_functiondef('public.ca_stats_witness_audit(integer,integer)'::regprocedure)) = 'a7738fa961dccb1ae5229c1825adb3c3')
-- @live-proof: (SELECT count(*) FROM public.ca_drift_incidents WHERE status <> 'resolved' AND source IN ('financial_alerts:Tournament.atomic_finish_refused','financial_alerts:postHandTasks.leave_pending_failed')) = 0

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 3. The certification retirement's maintenance kind is registered as info.
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_ledger_maintenance_kinds (kind, severity, note)
VALUES ('ui-cert-cleanup', 'info',
  'retireProductionCreateClubFixtures (scripts/ci/production-e2e-account.mjs) retires the '
  || 'Create-A-Club certification fixtures: clubs owned by a reserved post-deploy identity, '
  || 'named with a certification prefix, validated before any is retired. Their '
  || 'chip_transactions rows are deleted under app.ledger_maintenance = ui-cert-cleanup:<club> '
  || 'and preserved whole in ca_ledger_mutation_log. Expected, scheduled and reversible: '
  || 'recorded, not alarming. Registered 2026-10-01 after 148 runs each opened a board item.')
ON CONFLICT (kind) DO UPDATE SET severity = EXCLUDED.severity, note = EXCLUDED.note;

-- ---------------------------------------------------------------------------
-- 4. ca_stats_witness_audit reads the action log only for the gap.
-- ---------------------------------------------------------------------------
DO $subs$
DECLARE
  v_def text; v_after text; v_n integer; v_acl text; v_owner text; v_secdef boolean;
  s record;
BEGIN
  FOR s IN SELECT * FROM (VALUES
    ('ca_stats_witness_audit(integer,integer)',
      '3b3b9610697ea648ee94808ff7ca91b7', 'ca398f0a217d629781039d7da02d52d3',
      E'    FROM (SELECT DISTINCT hand_id FROM cand) c\n',
      E'    /* Only a hand with a seat still owed a figure needs its action log read:\n'
      || E'       a seat that carries all_in_equity is owed and counted whatever the\n'
      || E'       betting did, so the per-hand hand_history read below is for the gap,\n'
      || E'       not the coverage (2026-10-01: 611,169 candidate seats a week, the read\n'
      || E'       ran 42-118 s and timed out at 120 s in 21 of 23 runs). */\n'
      || E'    FROM (SELECT DISTINCT hand_id FROM cand WHERE all_in_equity IS NULL) c\n'),
    ('ca_stats_witness_audit(integer,integer)',
      'ca398f0a217d629781039d7da02d52d3', 'a7738fa961dccb1ae5229c1825adb3c3',
      E'  FROM cand c\n  JOIN hands h USING (hand_id);\n',
      E'  FROM cand c\n  LEFT JOIN hands h USING (hand_id);\n')
  ) AS x(signature, before_md5, after_md5, old_text, new_text)
  LOOP
    v_def := pg_get_functiondef(('public.' || s.signature)::regprocedure);
    IF md5(v_def) <> s.before_md5 THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %)', s.signature, md5(v_def);
    END IF;
    v_n := (length(v_def) - length(replace(v_def, s.old_text, ''))) / length(s.old_text);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the clause to change occurs % times in %, expected exactly 1', v_n, s.signature;
    END IF;
    SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef INTO v_acl, v_owner, v_secdef
      FROM pg_proc p WHERE p.oid = ('public.' || s.signature)::regprocedure;
    EXECUTE replace(v_def, s.old_text, s.new_text);
    v_after := pg_get_functiondef(('public.' || s.signature)::regprocedure);
    IF md5(v_after) <> s.after_md5 THEN
      RAISE EXCEPTION '% is not the measured text (md5 %)', s.signature, md5(v_after);
    END IF;
    IF md5(replace(v_after, s.new_text, s.old_text)) <> s.before_md5 THEN
      RAISE EXCEPTION '%: the reverse substitution does not reproduce the pinned text', s.signature;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = ('public.' || s.signature)::regprocedure
                   AND p.proacl::text IS NOT DISTINCT FROM v_acl AND pg_get_userbyid(p.proowner) = v_owner
                   AND p.prosecdef = v_secdef) THEN
      RAISE EXCEPTION '%: owner, security or grants moved', s.signature;
    END IF;
  END LOOP;
END $subs$;

-- ---------------------------------------------------------------------------
-- 1. Finish refusals whose tournament holds an immutable terminal receipt.
--    The receipt is the witness (10.9); a RUNNING tournament is not touched.
-- ---------------------------------------------------------------------------
UPDATE public.financial_alerts fa
   SET resolved = true, resolved_at = now(),
       resolution = 'verified: tournament ' || (fa.context->>'tournament_id')
         || ' is COMPLETED with an immutable terminal receipt (tournament_terminal_settlements); '
         || 'this refusal (' || COALESCE(fa.context->>'refusal_reason', 'unclassified')
         || ') was a transient on the single finish lane that the next admission cleared, and the '
         || 'winner was paid in full by that receipt. Nothing is owed. Producer fixed in the same PR: a '
         || 'transient refusal is alerted at a streak of three, not on the first pass. '
         || 'migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears'
 WHERE fa.resolved = false
   AND fa.source IN ('Tournament.atomic_finish_refused', 'Tournament.atomic_finish_outcome_unknown')
   AND EXISTS (SELECT 1 FROM public.tournaments t
                WHERE t.id = (fa.context->>'tournament_id')::uuid AND t.status = 'COMPLETED')
   AND EXISTS (SELECT 1 FROM public.tournament_terminal_settlements s
                WHERE s.tournament_id = (fa.context->>'tournament_id')::uuid);

UPDATE public.ca_drift_incidents i
   SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
       root_cause = 'The terminal authority refused this finish once with a transient (55P03 lock timeout or '
         || 'deadlock) on the single platform finish lane; the engine raised a critical money alert on that '
         || 'first refusal and the alert was mirrored here. The next admission completed the tournament and '
         || 'paid the winner: tournaments.status = COMPLETED and a row in tournament_terminal_settlements '
         || 'exist for this tournament_id. The alert measured lane contention, not an unpaid finish.',
       correction_ref = 'migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears',
       resolution = 'No chips moved to close this. Remeasured: the tournament this row names holds an immutable '
         || 'terminal receipt and status COMPLETED. The producer is fixed in the same PR '
         || '(TournamentManagerBase.noteFinishRefusal: a transient refusal is news at a streak of three; '
         || 'rearmIfTheFinishWasRefused rewinds the sweep cursor to the finish stage so the retry is one '
         || 'admission away, not two). A finish the lane refuses three passes running still opens a critical.'
 WHERE i.status <> 'resolved'
   AND i.source = 'financial_alerts:Tournament.atomic_finish_refused'
   AND i.tournament_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = i.tournament_id AND t.status = 'COMPLETED')
   AND EXISTS (SELECT 1 FROM public.tournament_terminal_settlements s WHERE s.tournament_id = i.tournament_id);

-- The storm row exists only because 25+ rows of this source were open at once.
UPDATE public.ca_drift_incidents i
   SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
       root_cause = 'Detector storm cap for financial_alerts:Tournament.atomic_finish_refused: more than 25 '
         || 'rows of that source were open, every one a transient finish-lane refusal on a tournament that '
         || 'then completed with a terminal receipt. The cap counted 309 further findings of the same shape.',
       correction_ref = 'migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears',
       resolution = 'No chips moved. The per-tournament rows behind this cap are closed on their receipts in '
         || 'this migration and the producer is fixed in the same PR; the source no longer has 25 open rows, '
         || 'so the cap has nothing to count. The event log keeps every capped key.'
 WHERE i.status <> 'resolved'
   AND i.dedupe_key = 'storm:financial_alerts:Tournament.atomic_finish_refused';

-- ---------------------------------------------------------------------------
-- 2. leave_pending read failures: every pending seat stayed where it was.
-- ---------------------------------------------------------------------------
UPDATE public.financial_alerts fa
   SET resolved = true, resolved_at = now(),
       resolution = 'verified: the leave_pending step failed on a READ (' || COALESCE(fa.context->>'error','')
         || ') before any cash-out; a cash-out refusal never throws out of this step. fn_unaccounted_seat_exits('
         || '4 days, 10 minutes) returned 0 rows and no live seat on table ' || (fa.context->>'table_id')
         || ' carries leave_pending, so every departure this boundary deferred was taken at a later one. '
         || 'Producer fixed in the same PR: this failure is a warning with moves_chips:false, and 55P03 gets '
         || 'the step''s retry budget. migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears'
 WHERE fa.resolved = false
   AND fa.source = 'postHandTasks.leave_pending_failed'
   AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                    WHERE s.table_id = (fa.context->>'table_id')::uuid
                      AND s.left_at IS NULL AND COALESCE(s.leave_pending, false));

UPDATE public.ca_drift_incidents i
   SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
       root_cause = 'The post-hand leave_pending step threw on a read (supabase_timeout or 55P03 lock timeout) '
         || 'on the departures enumeration or the seat-move read, before any cash-out, and runStep raised a '
         || 'critical because the step is moneyCritical. The step''s only throwing paths are reads and seat '
         || 'moves; a refused cash-out is swallowed per seat and the seat keeps leave_pending = true for the '
         || 'next boundary. The alert measured a deferred boundary, not a lost stack.',
       correction_ref = 'migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears',
       resolution = 'No chips moved. Remeasured 2026-10-01: fn_unaccounted_seat_exits(interval ''4 days'', '
         || 'interval ''10 minutes'') returned 0 rows platform-wide and 0 on this table; no live seat on this '
         || 'table carries leave_pending. Producer fixed in the same PR: the alert is a warning asserting '
         || 'moves_chips:false (which fn_ca_financial_alert_to_incident reads as no critical incident), and '
         || 'a lock timeout is transient to isTransientDbError so the step gets its two retries.'
 WHERE i.status <> 'resolved'
   AND i.source = 'financial_alerts:postHandTasks.leave_pending_failed'
   AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                    WHERE s.table_id = i.table_id AND s.left_at IS NULL AND COALESCE(s.leave_pending, false));

-- ---------------------------------------------------------------------------
-- 5. Verified by rows.
-- ---------------------------------------------------------------------------
UPDATE public.financial_alerts fa
   SET resolved = true, resolved_at = now(),
       resolution = 'verified: hand_history holds the row for table ' || (fa.context->>'table_id') || ' hand #'
         || (fa.context->>'hand_number') || '; the successor engine generation committed the hand this fenced '
         || 'generation could not reach. migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears'
 WHERE fa.resolved = false
   AND fa.source = 'ServerTableEngine.authoritative_hand_unreachable'
   AND EXISTS (SELECT 1 FROM public.hand_history h
                WHERE h.table_id = (fa.context->>'table_id')::uuid
                  AND h.hand_number = (fa.context->>'hand_number')::bigint);

UPDATE public.ca_drift_incidents i
   SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
       root_cause = 'An engine generation exhausted its bounded identical settlement replay for one hand and was '
         || 'terminated with that hand behind its causal barrier; the alert says so and was mirrored here as '
         || 'info. The successor generation adopted the table and committed the same hand.',
       correction_ref = 'migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears',
       resolution = 'No chips moved. Remeasured: a hand_history row exists for every (table, hand) the 27 '
         || 'underlying alerts name (27 of 27). Nothing is owed and nothing is unrecorded.'
 WHERE i.status <> 'resolved'
   AND i.source = 'financial_alerts:ServerTableEngine.authoritative_hand_unreachable'
   AND NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                    WHERE fa.source = 'ServerTableEngine.authoritative_hand_unreachable' AND fa.resolved = false);

UPDATE public.financial_alerts fa
   SET resolved = true, resolved_at = now(),
       resolution = 'verified: satellite 0e1d340e-9e67-4874-b0cb-79d06842d4bd settled at 2026-09-28 21:22:12 UTC '
         || '(tournament_satellite_settlements, receipt_version 3): 6 awards x 50.00 = 300.00 with payout ids in '
         || 'tournament_satellite_awards, remainder 24.00 in tournament_satellite_remainders, pool 324.00. The '
         || 'outcome was unknown for the fenced dealers for eight hours and is now a committed receipt. '
         || 'migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears'
 WHERE fa.resolved = false
   AND fa.source = 'Tournament.satellite_qualifiers_outcome_unknown'
   AND fa.context->>'tournament_id' = '0e1d340e-9e67-4874-b0cb-79d06842d4bd'
   AND (SELECT count(*) FROM public.tournament_satellite_awards a
         WHERE a.tournament_id = '0e1d340e-9e67-4874-b0cb-79d06842d4bd' AND a.payout_id IS NOT NULL) = 6;

UPDATE public.ca_drift_incidents i
   SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
       root_cause = 'The satellite qualifier settlement''s outcome could not be resolved by the dealers that '
         || 'asked at 12:36-13:25 UTC on 2026-09-28, so they fenced themselves and alerted. The settlement '
         || 'committed at 21:22:12 the same day through the satellite terminal authority.',
       correction_ref = 'migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears',
       resolution = 'No chips moved to close this. Remeasured: tournament_satellite_settlements holds the receipt '
         || '(pool 324.00, 6 qualifiers, remainder 24.00), tournament_satellite_awards holds 6 awards of 50.00 '
         || 'each with payout ids, tournament_satellite_remainders holds the 24.00. All six qualifiers paid.'
 WHERE i.status <> 'resolved'
   AND i.source = 'financial_alerts:Tournament.satellite_qualifiers_outcome_unknown'
   AND i.tournament_id = '0e1d340e-9e67-4874-b0cb-79d06842d4bd'
   AND (SELECT count(*) FROM public.tournament_satellite_awards a
         WHERE a.tournament_id = i.tournament_id AND a.payout_id IS NOT NULL) = 6;

UPDATE public.ca_drift_incidents i
   SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
       root_cause = 'The rakeback settler watermark stopped advancing (2026-09-28 04:15 UTC, 77 minutes; and the '
         || 'blocking row: 76 cash rake records inside the week due to settle sat above the watermark). The '
         || 'settler was later repaired by its own lane (#5288, #5296) and the watermark has moved past the week.',
       correction_ref = 'verified: daemon_state.rakeback_settler high_water_mark read 2026-10-01 15:06:05 UTC at '
         || '15:26:24 UTC, inside its 30 minute interval and past the week end this row named',
       resolution = 'No chips moved to close this. Remeasured 2026-10-01 16:0x UTC: the watermark is advancing '
         || 'within the settler interval and is past 2026-09-28, so neither the stalled nor the blocking '
         || 'condition holds. fn_ca_settlement_correctness_check raises a fresh row if either returns.'
 WHERE i.status <> 'resolved'
   AND i.source = 'fn_ca_settlement_correctness_check:settler_lag'
   AND (SELECT d.high_water_mark FROM public.daemon_state d WHERE d.daemon = 'rakeback_settler')
         > timestamptz '2026-09-29 00:00:00+00';

UPDATE public.ca_diamond_incidents d
   SET resolved_at = now(),
       resolution = 'verified: fn_ca_diamond_health_watch() returned no findings at 2026-10-01 16:02 UTC and '
         || 'ca-horse-claim-due-minute (cron job 346) ran 180 of 180 successes in the preceding 3 hours; the '
         || 'horse rewards past the sweep interval have been claimed. '
         || 'migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears'
 WHERE d.resolved_at IS NULL
   AND d.rule = 'DR0:health_critical'
   AND public.fn_ca_diamond_health_watch() = 0;

UPDATE public.ca_drift_incidents i
   SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
       root_cause = 'fn_ca_diamond_health_watch reported 1,689 horse rewards owed past the sweep interval: '
         || 'fn_ca_horse_claim_due, the only thing that presses a horse''s claim button, was not keeping up '
         || '(its lock span was measured by #5686 at 23.9 s average, 120 s max). Horses are players (10.5): '
         || 'a reward a horse is owed is money owed.',
       correction_ref = 'verified: fn_ca_diamond_health_watch() = 0 findings at 2026-10-01 16:02 UTC; cron job '
         || 'ca-horse-claim-due-minute 180/180 successes in the prior 3 hours',
       resolution = 'No chips moved to close this. Remeasured: the health watch that opened this reports nothing '
         || 'owed past the interval, so the claims have been pressed. The 7 DR0 rows on the diamond board are '
         || 'resolved with the same reading in this migration.'
 WHERE i.status <> 'resolved'
   AND i.source = 'ca_diamond_incidents'
   AND i.dedupe_key = 'diamond-rule:DR0:health_critical:1'
   AND public.fn_ca_diamond_health_watch() = 0;

UPDATE public.ca_drift_incidents i
   SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
       root_cause = 'fn_ca_settlement_correctness_check was redefined after its 2026-09-27 05:25 UTC baseline: the '
         || 'settlement-coverage and settler-cursor migrations of that day (20260927134527, 20260927140721, '
         || '20260927141959, 20260927142005, 20260927220353) each replaced it, all on main. The notice asks '
         || 'that the redefinition be declared, which this is.',
       correction_ref = 'verified: live md5(pg_get_functiondef) = 331dfe59b157b733bc1efc99bbf193d0, equal to '
         || 'ca_guard_def_history id 27781 (the capture that raised this); every redefining migration is in '
         || 'supabase_migrations.schema_migrations',
       resolution = 'No chips moved. The guard is the text main says it is; the redefinitions are reviewed '
         || 'migrations, not a hand edit. The watch raises again on the next unexplained change.'
 WHERE i.status <> 'resolved'
   AND i.source = 'fn_ca_guard_defs_watch'
   AND i.dedupe_key = 'guard-def-drift:fn_ca_settlement_correctness_check:331dfe59b157'
   AND md5(pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure))
         = '331dfe59b157b733bc1efc99bbf193d0';

UPDATE public.ca_drift_incidents i
   SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
       root_cause = 'The Create-A-Club certification retirement sets app.ledger_maintenance = '
         || 'ui-cert-cleanup:<club> and deletes the cert club''s chip_transactions rows under it. That kind was '
         || 'never registered in ca_ledger_maintenance_kinds, so fn_ca_journal_append_only defaulted it to '
         || 'warning and opened a board item on every certification run - 148 occurrences, 148 distinct cert '
         || 'clubs, every row preserved in ca_ledger_mutation_log. The same shape 20260910132833 fixed for '
         || 'certification-cleanup.',
       correction_ref = 'migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears',
       resolution = 'No chips moved. The kind is registered as info in this migration, so the trigger records the '
         || 'bypass (as it always did) and does not raise it. An unregistered kind still defaults to warning '
         || 'and still raises; a cert cleanup that touches a non-cert account is still refused upstream by '
         || 'retireProductionCreateClubFixtures before any RPC is called.'
 WHERE i.status <> 'resolved'
   AND i.source = 'fn_ca_journal_append_only'
   AND i.dedupe_key = 'journal-bypass:chip_transactions:DELETE:ui-cert-cleanup';

UPDATE public.ca_drift_incidents i
   SET status = 'resolved', resolved_at = now(), closure_basis = 'operator',
       root_cause = 'ca-stats-witness-audit-15m (cron job 263) ran ca_stats_witness_audit past its 120 s '
         || 'statement_timeout in 21 of 23 runs over six hours. Section 2f read hand_history by primary key and '
         || 'unnested the action log twice for every distinct all-in showdown hand of the trailing week - '
         || 'written for ~400 hands, now 611,169 candidate seat rows. The job did not fail for a transient; the '
         || 'query it runs had outgrown its budget.',
       correction_ref = 'migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears',
       resolution = 'No chips moved. The query is narrowed in this migration to read the action log only for '
         || 'hands with a seat still owed an equity figure (result-identical by the counting rule, see header). '
         || 'Closed by the agent that fixed it, not by remeasure: the next successful runs are the proof, and '
         || 'fn_ca_cron_failure_watch keys its rows by job and day so a failure tomorrow opens a fresh row.'
 WHERE i.status <> 'resolved'
   AND i.source = 'fn_ca_cron_failure_watch'
   AND i.dedupe_key LIKE 'cron-failing:ca-stats-witness-audit-15m:%';

-- fn_ca_tournament_finished_but_not_completed: a decided event whose finish the
-- lane refused and whose retry waited in the scheduler queue (the same cause
-- as section 1, seen from the other side). Closed only on the receipt.
UPDATE public.financial_alerts fa
   SET resolved = true, resolved_at = now(),
       resolution = 'verified: tournament ' || (fa.context->>'tournament_id') || ' is COMPLETED with an immutable '
         || 'terminal receipt; the decided-but-unfinished state this check saw was a finish refused once on the '
         || 'lane and retried from the back of the elimination scheduler queue. Producer fixed in the same PR '
         || '(the retry rewinds to the finish stage). migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears'
 WHERE fa.resolved = false
   AND fa.source = 'fn_ca_tournament_finished_but_not_completed'
   AND NULLIF(fa.context->>'tournament_id', '') IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.tournaments t
                WHERE t.id = (fa.context->>'tournament_id')::uuid AND t.status = 'COMPLETED')
   AND EXISTS (SELECT 1 FROM public.tournament_terminal_settlements s
                WHERE s.tournament_id = (fa.context->>'tournament_id')::uuid);

UPDATE public.ca_drift_incidents i
   SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
       root_cause = 'fn_ca_tournament_finished_but_not_completed saw a decided tournament (one player left) '
         || 'unfinished for more than 15 minutes. Its finish had been refused once on the single finish lane '
         || '(55P03) and the retry waited at the back of an elimination scheduler queue whose oldest wait was '
         || '589-1,121 s, then ran stages 3..8 before asking the finish again.',
       correction_ref = 'migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears',
       resolution = 'No chips moved to close this. Remeasured: the tournament is COMPLETED with an immutable '
         || 'terminal receipt and its winner paid. Producer fixed in the same PR: rearmIfTheFinishWasRefused '
         || 'rewinds the sweep cursor to the finish stage so the retry is one admission away.'
 WHERE i.status <> 'resolved'
   AND i.source = 'financial_alerts:fn_ca_tournament_finished_but_not_completed'
   AND NULLIF(i.metadata->>'tournament_id', '') IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.tournaments t
                WHERE t.id = (i.metadata->>'tournament_id')::uuid AND t.status = 'COMPLETED')
   AND EXISTS (SELECT 1 FROM public.tournament_terminal_settlements s
                WHERE s.tournament_id = (i.metadata->>'tournament_id')::uuid);

-- Echo alerts raised by fn_ca_raise_drift_incident when each incident opened:
-- closed with the incident they echo, never on their own.
UPDATE public.financial_alerts fa
   SET resolved = true, resolved_at = now(),
       resolution = 'verified: echo of drift incident ' || (fa.context->>'incident_id') || ', resolved in '
         || 'migration 20261001160953_the_board_stops_paging_for_refusals_the_next_pass_clears; see that row.'
 WHERE fa.resolved = false
   AND fa.source LIKE 'drift_incident:%'
   AND EXISTS (SELECT 1 FROM public.ca_drift_incidents i
                WHERE i.id = (fa.context->>'incident_id')::uuid
                  AND i.status = 'resolved'
                  AND i.correction_ref LIKE '%20261001160953%');

-- ---------------------------------------------------------------------------
-- ASSERTIONS. Abort the whole transaction if the board moved underneath us.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n integer; v_open_refusals integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.ca_drift_incidents
   WHERE status <> 'resolved'
     AND source IN ('financial_alerts:Tournament.atomic_finish_refused',
                    'financial_alerts:postHandTasks.leave_pending_failed',
                    'financial_alerts:ServerTableEngine.authoritative_hand_unreachable',
                    'financial_alerts:Tournament.satellite_qualifiers_outcome_unknown',
                    'fn_ca_journal_append_only');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: % incidents of a class this migration closes are still open - a tournament '
      'without a receipt or a table with a live leave_pending seat has appeared; read it, do not force it.', v_n;
  END IF;

  -- A refusal on a tournament still RUNNING is left alone on purpose; say how many.
  SELECT count(*) INTO v_open_refusals FROM public.financial_alerts fa
   WHERE fa.resolved = false AND fa.source = 'Tournament.atomic_finish_refused';
  RAISE NOTICE 'atomic_finish_refused alerts still open (tournaments not yet COMPLETED with a receipt): %',
    v_open_refusals;

  IF (SELECT severity FROM public.ca_ledger_maintenance_kinds WHERE kind = 'ui-cert-cleanup') IS DISTINCT FROM 'info' THEN
    RAISE EXCEPTION 'ASSERT FAILED: ui-cert-cleanup is not registered as info';
  END IF;

  IF md5(pg_get_functiondef('public.ca_stats_witness_audit(integer,integer)'::regprocedure))
       <> 'a7738fa961dccb1ae5229c1825adb3c3' THEN
    RAISE EXCEPTION 'ASSERT FAILED: ca_stats_witness_audit is not the measured text';
  END IF;
END $$;

COMMIT;
