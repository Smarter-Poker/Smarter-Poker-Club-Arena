-- ===========================================================================
--  THE STALE LAUNCH ALERTS CLOSE ON THEIR VERIFIED CAUSES
-- ===========================================================================
--
-- Every financial_alerts row and drift incident this file closes was read
-- against production on 2026-10-05, and each group below re-asserts the
-- reading it is closed on before it is closed, so the file rolls back whole if
-- the board has moved. Nothing here moves money, rewrites a ledger row, or
-- deletes anything (CLAUDE.md 10.9, 10.12). Where a cause needed a code fix,
-- the fix is named; where the alert was a detector reading a state the
-- platform produces on purpose, the detector was corrected first
-- (20261005113359) and this file only runs after it.
--
-- Prerequisites, all asserted: 20261005111107 (overpay detector), 20261005113359
-- (close-owed and spin detectors), 20261005113403 (certification maintenance
-- kinds). The union_accounting_scheduler and weekly_club_accounting "waits for
-- a quiet hour" warnings of 09:40 today are TRUE and stay open: the week's
-- close is gated until 2026-10-06 13:00 UTC.
--
-- THE GROUPS
--
--  A. postHandTasks.leave_pending_failed x2 (2026-10-03 23:43:46/48). The
--     departures read timed out in the 23:43 database stall, moves_chips
--     false. Both tables (1f2ddc10, 9dbe0190) are closed with no open seat.
--
--  B. drift_incident mirrors whose incident is already resolved, each checked
--     against today's state, not the incident's "aged out" note:
--     - fn_union_treasury_selftest (settler lag 1.04 h, 2026-09-13):
--       fn_settler_lag_check() healthy.
--     - postHandTasks.hand_history_failed (table 556bee8a hand 17634654,
--       2026-09-29): the hand has its atomic commit; it settled.
--     - fn_ca_trial_balance_watch x3 (2026-09-28, 588.30 / 265.80 / -265.00):
--       its last three runs filed nothing.
--     - fn_ca_ratchet_watch x2 (2026-09-28): prize_overpay is the refund
--       defect fixed by 20261005111107 (count 0); undeclared_money_paths is 0
--       against a baseline of 0.
--     - reconcile_ledger_nightly (-1.00, 2026-09-17): no critical row in
--       ledger_reconcile_log since 2026-09-29.
--     And the mirrors of incidents closed by 20261005111107, 20261005113403
--     and group C here.
--
--  C. The two union_eco_not_recorded incidents (33554dc5, 82e4c285, 07:52
--     today): the close they asked about is not owed until its gate passes;
--     fn_union_credit_risk_check no longer reports it (20261005113359).
--
--  D. fn_union_treasury_selftest x3 (2026-08-21 bbj drift -2.50, 2026-08-24
--     lapsed_week_unclosed, 2026-09-13 settler lag): the selftest reads
--     healthy - BBJ conservation healthy, settler 0.2 h behind, and the
--     gated week no longer reads as lapsed.
--
--  E. fn_union_integrity_sweep x44 (2026-08-20 to 2026-10-03, "review by
--     agent"). Reviewed: 43 are agent_roster_winning only (a roster's 24-hour
--     net against its rake, an outcome measure) with no co-seating and no
--     transfer signal beside them; 2 are direct_chip_transfer: on 2026-09-01
--     every sender is an agent and 414 of the 446 pairs go to the sender's own
--     roster, which is agent credit distribution, and on 2026-08-21 the one
--     transfer is a 1.00 trade-view verification claim to the admin account; 1 is
--     co_seating among 16 accounts on 2026-08-20. No row shows chips moving
--     between players at a table outside play. The sweep keeps running and
--     keeps filing new signals for review.
--
--  F. fn_union_rake_basis_refresh x13 (2026-09-26 to 09-29,
--     union_cash_sources_do_not_match_bank): the open-week snapshot refreshes
--     again; asserted current within two hours.
--
--  G. fn_spin_repair_missing_multiplier x3 (2026-08-22): no RUNNING or
--     COMPLETED Spin created since 2026-08-23 lacks its drawn multiplier
--     (231,483 read today).
--
--  H. Stable Hand x4: the controller beats (210 in the last hour today), its
--     horse-state writes land, and the Deep Stack Society treasury holds
--     634,496.69, over a year of the board's 1,500 a day.
--
--  I. fn_ca_duplicate_structure_payout_check x2 (2026-09-01, 688.30): no
--     finisher has held two structure payouts for one place since
--     2026-09-02 (33 days read). The 688.30 paid then is not taken back
--     (10.9 rule 3).
--
--  J. chip_standard.duplicate_rake_attribution (2026-09-06): the producer
--     was closed by 20260906023024 and rake_records carries a unique index on
--     hand_id, so the duplicate cannot recur.
--
--  K. fn_ca_release_broke_seats (2026-09-09): that job is disabled, and read
--     at 11:30 UTC no open seat anywhere held a zero stack.
--
--  L. fn_cash_pot_conservation_check (2026-09-06, one hand, 600.00, no
--     winner): the 600.00, no-winner, no-table shape is the settled-hand
--     fixture of tests/e2e/production-daily-missions.spec.ts; retention now
--     prunes a leaked one (20261005111120). The check reads zero today.
--
--  M. fn_spin_fairness_check (2026-09-07, tiers_locked): the premise was the
--     odds sheet removed on 2026-09-05; corrected in 20261005113359. The
--     check reads clean on every money-bearing verdict today.
--
--  N. fn_tournament_payout_sweep and _truncated (2026-09-01): the eight
--     tournaments it named are each paid exactly their 75.00 pool, and
--     fn_ca_tournament_underpaid_count() is 0.
--
--  O. TournamentRecurring.freeBuyAudit (2026-09-11): the watch read every
--     freeroll (all carry free_buy) as the five-slot board. The engine now
--     reads the board by name (FREE_BUY_BOARD_NAMES, same pull request); the
--     board's own rows are all on their slot hour, on the minute.
-- ===========================================================================
-- @live-proof: (SELECT count(*) = 0 FROM public.financial_alerts WHERE resolved_at IS NULL AND created_at < '2026-10-05 07:00+00' AND source NOT IN ('union_accounting_scheduler', 'weekly_club_accounting'))

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '170s';

-- PREREQUISITES -------------------------------------------------------------
DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_prize_overpay_unexplained(interval)'::regprocedure)) <> '5fdb9c82f01aabe5646b4ff9ed7a96da'
     OR md5(pg_get_functiondef('public.fn_union_credit_risk_check()'::regprocedure)) <> '2084a5cb1b27c36df2b7512a168694db'
     OR md5(pg_get_functiondef('public.fn_union_treasury_selftest()'::regprocedure)) <> '1f31f451e801a2d196c71822e97a13fe'
     OR md5(pg_get_functiondef('public.fn_spin_fairness_check(integer)'::regprocedure)) <> '7020ab8e6d565b3aa1884a5252364e49'
     OR (SELECT count(*) FROM public.ca_ledger_maintenance_kinds
          WHERE kind IN ('stale-cert-recovery', 'cert-residue-recovery') AND severity = 'info') <> 2 THEN
    RAISE EXCEPTION 'a prerequisite migration is not installed';
  END IF;
END $pre$;

-- A. LEAVE_PENDING ----------------------------------------------------------
DO $a$
BEGIN
  IF EXISTS (SELECT 1 FROM public.table_seats s
              WHERE s.table_id IN ('1f2ddc10-f580-425a-9bbc-18f3d758c55b', '9dbe0190-9687-4713-8d67-50254d86687b')
                AND s.left_at IS NULL) THEN
    RAISE EXCEPTION 'A: a departure on the two stalled tables is still open';
  END IF;
END $a$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-05: the departures read timed out in the 2026-10-03 23:43Z database stall with moves_chips false; both tables completed every departure afterwards and are closed with no open seat. Root fix of the stall: compute headroom (2026-10-03 the database keeps memory headroom). migration 20261005113407'
 WHERE resolved_at IS NULL AND source = 'postHandTasks.leave_pending_failed'
   AND created_at BETWEEN '2026-10-03 23:43:00+00' AND '2026-10-03 23:45:00+00';

-- C. THE ECO INCIDENTS ------------------------------------------------------
DO $c$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fn_union_credit_risk_check() x WHERE x.invariant = 'union_eco_not_recorded')
     OR EXISTS (SELECT 1 FROM public.fn_union_governance_check() x WHERE x.invariant = 'union_eco_not_recorded') THEN
    RAISE EXCEPTION 'C: union_eco_not_recorded still reports';
  END IF;
END $c$;
SELECT public.fn_ca_incident_action(
         i.id, 'resolve',
         'No missing ECO. The week 2026-09-28..10-05 ended at 07:00 UTC; its close, which writes union_eco_ledger, is due at 09:00 UTC and is held by accounting_close_gates until 2026-10-06 13:00 UTC (coordinator decision 2026-10-03). The invariant now asks once the close is owed.',
         NULL,
         'fn_union_credit_risk_check asked for the closed week''s ECO row before its close was owed.',
         'migration 20261005113359')
  FROM public.ca_drift_incidents i
 WHERE i.dedupe_key IN ('sweep:fn_union_credit_risk_check:2026-10-05', 'sweep:fn_union_governance_check:2026-10-05')
   AND i.resolved_at IS NULL;

-- B. MIRRORS OF RESOLVED INCIDENTS ------------------------------------------
DO $b$
BEGIN
  IF (public.fn_settler_lag_check()->>'healthy') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'B: the rakeback settler is not healthy';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                  WHERE a.table_id = '556bee8a-1a96-4abf-9953-59f13126eb69' AND a.hand_number = 17634654) THEN
    RAISE EXCEPTION 'B: hand 17634654 has no atomic commit';
  END IF;
  IF EXISTS (SELECT 1 FROM (SELECT r.detail FROM public.ca_detector_runs r
                             WHERE r.detector = 'fn_ca_trial_balance_watch'
                             ORDER BY r.ran_at DESC LIMIT 3) x
              WHERE COALESCE((x.detail->>'filed')::int, -1) <> 0) THEN
    RAISE EXCEPTION 'B: a recent trial balance run filed a finding';
  END IF;
  IF (SELECT count(*) FROM public.fn_ca_undeclared_money_paths()) <> 0
     OR public.fn_ca_prize_overpay_count() <> 0 THEN
    RAISE EXCEPTION 'B: a ratchet still reads above zero';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_reconcile_log l
              WHERE l.run_date >= DATE '2026-09-29' AND l.severity = 'critical') THEN
    RAISE EXCEPTION 'B: reconcile_ledger_nightly filed a critical since 2026-09-29';
  END IF;
END $b$;
UPDATE public.financial_alerts a SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-05 against current state, and its incident ' || i.id::text || ' is resolved. '
    || CASE a.source
         WHEN 'drift_incident:financial_alerts:fn_union_treasury_selftest' THEN 'The rakeback settler reads healthy (fn_settler_lag_check).'
         WHEN 'drift_incident:financial_alerts:postHandTasks.hand_history_failed' THEN 'The refused hand (table 556bee8a, hand 17634654) has its atomic commit: it settled.'
         WHEN 'drift_incident:fn_ca_trial_balance_watch' THEN 'The trial balance''s last three runs filed nothing; the 2026-09-28 differences closed.'
         WHEN 'drift_incident:fn_ca_ratchet_watch' THEN 'prize_overpay was registration refunds counted as prizes (fixed, 20261005111107); undeclared_money_paths reads 0 against a baseline of 0.'
         WHEN 'drift_incident:ledger_reconcile_log:reconcile_ledger_nightly' THEN 'reconcile_ledger_nightly has filed no critical since 2026-09-29.'
         WHEN 'drift_incident:fn_ca_journal_append_only' THEN 'Certification recovery maintenance, registered info (20261005113403).'
         WHEN 'drift_incident:fn_ca_conservation_sweep:fn_union_credit_risk_check' THEN 'The ECO close was not yet owed (20261005113359).'
         WHEN 'drift_incident:fn_ca_conservation_sweep:fn_union_governance_check' THEN 'The ECO close was not yet owed (20261005113359).'
         ELSE COALESCE(i.resolution, '')
       END || ' migration 20261005113407'
  FROM public.ca_drift_incidents i
 WHERE a.resolved_at IS NULL
   AND a.source LIKE 'drift_incident:%'
   AND a.created_at < '2026-10-05 11:40+00'
   AND i.id = (a.context->>'incident_id')::uuid
   AND i.resolved_at IS NOT NULL;

-- D. TREASURY SELFTEST ------------------------------------------------------
DO $d$
DECLARE v jsonb;
BEGIN
  v := public.fn_union_treasury_selftest();
  IF (v->>'healthy') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'D: the union treasury selftest is not healthy: %', left(v::text, 600);
  END IF;
END $d$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-05: fn_union_treasury_selftest reads healthy - no breach, BBJ conservation healthy, the rakeback settler current. The lapsed-week check no longer reads a close that is not yet owed as lapsed (20261005113359). migration 20261005113407'
 WHERE resolved_at IS NULL AND source = 'fn_union_treasury_selftest' AND created_at < '2026-09-14';

-- E. UNION INTEGRITY SWEEP SIGNALS ------------------------------------------
DO $e$
BEGIN
  IF EXISTS (SELECT 1 FROM public.financial_alerts a,
                    jsonb_array_elements(COALESCE(a.context->'direct_chip_transfer', '[]'::jsonb)) x
              WHERE a.resolved_at IS NULL AND a.source = 'fn_union_integrity_sweep'
                AND NOT EXISTS (SELECT 1 FROM public.agents ag WHERE ag.user_id = (x->>'from_user')::uuid)
                -- the one exception read: a single 1.00 transfer to the admin
                -- account, chip_transactions note 'Trade view verification claim 2'
                AND NOT ((x->>'total')::numeric = 1 AND (x->>'transfers')::int = 1
                         AND (x->>'to_user') = '47965354-0e56-43ef-931c-ddaab82af765')) THEN
    RAISE EXCEPTION 'E: a flagged transfer was not sent by an agent';
  END IF;
END $e$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'reviewed 2026-10-05: ' || CASE
      WHEN jsonb_array_length(COALESCE(context->'direct_chip_transfer', '[]'::jsonb)) > 0
        THEN CASE WHEN jsonb_array_length(context->'direct_chip_transfer') = 1
                    THEN 'the one transfer was a single 1.00 trade-view verification transfer (chip_transactions note ''Trade view verification claim 2'') to the admin account, not chips moving between opponents.'
                    ELSE 'direct transfers were sent by agents (on 2026-09-01, 414 of 446 pairs to the sender''s own roster): agent credit distribution, not chips moving between opponents.' END
      WHEN jsonb_array_length(COALESCE(context->'co_seating', '[]'::jsonb)) > 0
        THEN 'repeated co-seating with no transfer or roster-winning signal beside it.'
      ELSE 'a roster''s 24-hour net against its rake (an outcome measure) with no co-seating and no transfer signal beside it.'
    END || ' No collusion evidence in the recorded rows. migration 20261005113407'
 WHERE resolved_at IS NULL AND source = 'fn_union_integrity_sweep' AND created_at < '2026-10-05';

-- F. RAKE BASIS REFRESH -----------------------------------------------------
DO $f$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.union_rake_basis_snapshot s
                  WHERE s.period_start = public.fn_union_week_start(now())
                    AND s.computed_at > now() - interval '2 hours') THEN
    RAISE EXCEPTION 'F: the open-week rake basis snapshot is not current';
  END IF;
END $f$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-05: the open-week rake basis snapshot refreshes again (current within two hours) and no failure has been filed since 2026-09-29 17:35. union_cash_sources_do_not_match_bank was the refresh refusing a week whose cash sources the settler had not yet banked. migration 20261005113407'
 WHERE resolved_at IS NULL AND source = 'fn_union_rake_basis_refresh' AND created_at < '2026-09-30';

-- G. SPIN MULTIPLIER --------------------------------------------------------
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tournaments t
              WHERE (upper(COALESCE(t.tournament_type, '')) = 'SPIN' OR lower(COALESCE(t.variant, '')) = 'spin')
                AND t.status IN ('RUNNING', 'COMPLETED')
                AND t.created_at > '2026-08-23'
                AND t.spin_multiplier IS NULL) THEN
    RAISE EXCEPTION 'G: a Spin since 2026-08-23 lacks its multiplier';
  END IF;
END $g$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-05: no RUNNING or COMPLETED Spin created since 2026-08-23 lacks its drawn multiplier; these three were reconstructed from the prize actually paid. migration 20261005113407'
 WHERE resolved_at IS NULL AND source = 'fn_spin_repair_missing_multiplier' AND created_at < '2026-08-23';

-- H. STABLE HAND ------------------------------------------------------------
DO $h$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.stable_hand_beats WHERE beat_at > now() - interval '15 minutes')
     OR NOT EXISTS (SELECT 1 FROM public.stable_hand_horse_state WHERE updated_at > now() - interval '1 hour')
     OR (SELECT chip_treasury FROM public.clubs WHERE id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3') < 45000 THEN
    RAISE EXCEPTION 'H: the Stable Hand is not beating, writing, or funded';
  END IF;
END $h$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-05: the Stable Hand controller beats (within 15 minutes), its horse-state counters write, and the Deep Stack Society treasury holds more than 30 days of the board''s 1,500 a day. migration 20261005113407'
 WHERE resolved_at IS NULL
   AND source IN ('HorseFleet.stableHandHeartbeat', 'HorseFleet.stableHandState', 'StableHandExecutor.checkBanks')
   AND created_at < '2026-10-03';

-- I. DUPLICATE STRUCTURE PAYOUTS --------------------------------------------
DO $i$
DECLARE v jsonb;
BEGIN
  v := public.fn_ca_duplicate_structure_payout_check(24 * 34);
  IF COALESCE((v->>'players_double_paid')::int, -1) <> 0 THEN
    RAISE EXCEPTION 'I: a duplicate structure payout exists: %', left(v::text, 400);
  END IF;
END $i$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-05: no finisher has held more than one structure payout for one place since 2026-09-02 (34 days read). The 688.30 paid beyond the ladder on 2026-08-31/09-01 is not taken back: an overpay our defect caused is absorbed by the house (CLAUDE.md 10.9 rule 3). migration 20261005113407'
 WHERE resolved_at IS NULL AND source = 'fn_ca_duplicate_structure_payout_check' AND created_at < '2026-09-02';

-- J. DUPLICATE RAKE ATTRIBUTION ---------------------------------------------
DO $j$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND tablename = 'rake_records'
                    AND indexdef ILIKE '%UNIQUE%(hand_id)%') THEN
    RAISE EXCEPTION 'J: rake_records has no unique hand_id';
  END IF;
END $j$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-05: the producer was closed by 20260906023024 and rake_records carries a unique index on hand_id, so a hand cannot be attributed twice again; the historical rows stay as recorded. migration 20261005113407'
 WHERE resolved_at IS NULL AND source = 'chip_standard.duplicate_rake_attribution' AND created_at < '2026-09-07';

-- K. BROKE SEATS ------------------------------------------------------------
DO $k$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-release-broke-seats' AND active) THEN
    RAISE EXCEPTION 'K: the broke-seat job still runs';
  END IF;
END $k$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-05: ca-release-broke-seats is disabled, and read at 11:30 UTC no open seat anywhere held a zero stack (cash 0, tournament 0). migration 20261005113407'
 WHERE resolved_at IS NULL AND source = 'fn_ca_release_broke_seats' AND created_at < '2026-09-10';

-- L. CASH POT ---------------------------------------------------------------
DO $l$
DECLARE v jsonb;
BEGIN
  v := public.fn_cash_pot_conservation_check(24);
  IF COALESCE((v->>'conditions_alerted')::int, -1) <> 0 OR COALESCE((v->>'no_winner_recorded')::int, -1) <> 0 THEN
    RAISE EXCEPTION 'L: the cash pot check reads a finding: %', left(v::text, 400);
  END IF;
END $l$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-05: one hand, 600.00, no winner and no table is the settled-hand fixture of tests/e2e/production-daily-missions.spec.ts (pot_size 600, winners [], table_id NULL), not a played hand; retention prunes a leaked fixture (20261005111120). The check reads zero. migration 20261005113407'
 WHERE resolved_at IS NULL AND source = 'fn_cash_pot_conservation_check' AND created_at < '2026-09-07';

-- M. SPIN FAIRNESS ----------------------------------------------------------
DO $m$
DECLARE v jsonb;
BEGIN
  v := public.fn_spin_fairness_check(7);
  IF COALESCE((v->>'alerts_raised')::int, -1) <> 0
     OR v->>'verdict' IN ('off_ladder', 'distribution_critical', 'expectation_drift', 'distribution_warning') THEN
    RAISE EXCEPTION 'M: the spin fairness check reads a money finding: %', left(v::text, 400);
  END IF;
END $m$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-05: the warning''s premise, an odds sheet at buy-in advertising the full ladder, was removed on 2026-09-05 by Dan''s ruling; the wheel shows a locked tier as LOCKED. The check now reports a lock without raising (20261005113359) and reads clean on off-ladder, distribution and expectation. migration 20261005113407'
 WHERE resolved_at IS NULL AND source = 'fn_spin_fairness_check' AND created_at < '2026-09-08';

-- N. PAYOUT SWEEP -----------------------------------------------------------
DO $n$
BEGIN
  IF public.fn_ca_tournament_underpaid_count() <> 0
     OR EXISTS (SELECT 1 FROM public.tournaments t
                 WHERE t.id IN ('6aa19ddc-c142-4bd1-93c9-3ebb696130e7', '5bf1dd01-b725-4fc6-9bd6-ffd6af91bb1a',
                                'd2f0a9b5-fcbe-4d44-a3cf-4414f551c561', 'a8e37fe2-3821-453f-be5a-01729a046456',
                                '0a511397-43eb-4340-86ed-c8647f2750d7', 'bf81ad19-a8cd-4d97-99b3-3e632411770a',
                                '45a5324c-9023-491d-93d5-802ee24c40cb', '8ad9e70c-2a7c-4e86-b5b8-46f5fb5542d2')
                   AND (t.status <> 'COMPLETED'
                        OR round(COALESCE(t.prize_pool, 0), 2) <> COALESCE((SELECT round(sum(p.amount), 2)
                                                                             FROM public.tournament_payouts p
                                                                            WHERE p.tournament_id = t.id), 0))) THEN
    RAISE EXCEPTION 'N: a named tournament is not paid in full, or one is underpaid';
  END IF;
END $n$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-05: the eight tournaments the sweep named are COMPLETED and paid exactly their prize pool, and fn_ca_tournament_underpaid_count() is 0. migration 20261005113407'
 WHERE resolved_at IS NULL AND source IN ('fn_tournament_payout_sweep', 'fn_tournament_payout_sweep_truncated') AND created_at < '2026-09-02';

-- O. FREE BUY BOARD ---------------------------------------------------------
DO $o$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tournaments t
              WHERE t.free_buy
                AND t.name IN ('Morning Free Buy (NLH)', 'Midday Free Buy (NLH)', 'Afternoon Free Buy (NLH)',
                               'Prime Time Free Buy (NLH)', 'Midnight Free Buy (NLH)')
                AND t.start_time > now() - interval '24 hours'
                AND (extract(hour FROM t.start_time AT TIME ZONE 'America/Chicago') NOT IN (0, 8, 12, 16, 20)
                     OR extract(minute FROM t.start_time AT TIME ZONE 'America/Chicago') <> 0)) THEN
    RAISE EXCEPTION 'O: a board event is off its slot';
  END IF;
END $o$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-05: the watch selected free_buy = true, which every freeroll carries, and audited the $100, Coffee Break, Early Bird and DSS freerolls against the five-slot board. The board''s own events are all on their slot hour. The engine now reads the board by name (FREE_BUY_BOARD_NAMES), same pull request as this migration. migration 20261005113407'
 WHERE resolved_at IS NULL AND source = 'TournamentRecurring.freeBuyAudit' AND created_at < '2026-09-12';

-- AFTER ---------------------------------------------------------------------
DO $post$
DECLARE v_open int; v_list text;
BEGIN
  SELECT count(*), string_agg(DISTINCT source, ', ') INTO v_open, v_list
    FROM public.financial_alerts
   WHERE resolved_at IS NULL AND created_at < '2026-10-05 07:00+00'
     AND source NOT IN ('union_accounting_scheduler', 'weekly_club_accounting');
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'still open from before today: % (%)', v_open, v_list;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_drift_incidents WHERE resolved_at IS NULL AND detected_at < '2026-10-05 11:40+00') THEN
    RAISE EXCEPTION 'a drift incident from before this file is still open';
  END IF;
END $post$;

COMMIT;
