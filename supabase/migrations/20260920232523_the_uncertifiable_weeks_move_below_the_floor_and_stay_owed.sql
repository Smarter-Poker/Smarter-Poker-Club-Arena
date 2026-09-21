-- 20260920232523_the_uncertifiable_weeks_move_below_the_floor_and_stay_owed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20260920232503 gave standalone clubs a settlement floor and taught the
-- coordinator's club discovery to respect it. This is the DATA half: the
-- owner's two decisions, recorded where the design says they belong.
--
-- The weeks 2026-09-07 07:00Z and 2026-09-14 07:00Z can never certify on the
-- v3 original-P&L basis. `union_pnl_weekly_capture.captured_at` is 2026-09-18
-- 00:41:12.316033Z and write-once, and `fn_union_pnl_evidence_report` blocks
-- any week whose start is at or before it; `accounting_cash_accrual_cutover`
-- starts 2026-09-17 18:24:04.643251Z and the club guards require the period to
-- start at or after it. So both floors advance to 2026-09-21 07:00Z, and the
-- first week either scope can settle is 2026-09-21 07:00Z -> 2026-09-28
-- 07:00Z, due 2026-09-28 09:00Z (04:00 America/Chicago).
--
-- The rakeback those two weeks leave behind is NOT written off. It is counted
-- from the real pending `rakeback_periods` rows, here, at a recorded
-- observation time, and recorded in `accounting_deferred_obligations` as still
-- owed. Those source rows are not paid, not cancelled, not deleted and not
-- altered: they stay `status='pending'` and await the separate one-off payment
-- the owner authorises later. No balance is invented; if the counted rows do
-- not match what is recorded, or if the closed week of 2026-09-07 has moved
-- since this file was written, this migration refuses and changes nothing.
--
-- The two `failed` run rows for 2026-09-07 -> 2026-09-14 are preserved
-- history. They are read here and never deleted, rewritten or re-statused.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT earliest_period_start FROM public.union_settlement_floor WHERE union_id='fade0000-0000-0000-0000-000000000001')=timestamptz '2026-09-21T07:00:00Z' AND (SELECT earliest_period_start FROM public.club_settlement_floor WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3')=timestamptz '2026-09-21T07:00:00Z' AND (SELECT count(*) FROM public.accounting_deferred_obligations)>0

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

-- The state this change is built on. Read, never moved.
DO $installed_preconditions$
DECLARE v_floor timestamptz;
BEGIN
 IF to_regclass('public.club_settlement_floor') IS NULL
   OR to_regclass('public.accounting_deferred_obligations') IS NULL
   OR to_regprocedure('public.fn_club_settlement_floor_week(uuid)') IS NULL THEN
  RAISE EXCEPTION 'club_floor_structure_absent' USING ERRCODE='55000';
 END IF;
 IF (SELECT (length(d)-length(replace(d,'fn_club_settlement_floor_week','')))/length('fn_club_settlement_floor_week')
      FROM (SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) d) q)<>3 THEN
  RAISE EXCEPTION 'club_discovery_does_not_respect_the_floor' USING ERRCODE='55000';
 END IF;

 -- The two settled fences that make these weeks uncertifiable.
 IF (SELECT captured_at FROM public.union_pnl_weekly_capture)
      IS DISTINCT FROM timestamptz '2026-09-18T00:41:12.316033Z' THEN
  RAISE EXCEPTION 'original_capture_moved' USING ERRCODE='55000';
 END IF;
 IF (SELECT starts_at FROM public.accounting_cash_accrual_cutover)
      IS DISTINCT FROM timestamptz '2026-09-17T18:24:04.643251Z' THEN
  RAISE EXCEPTION 'accrual_cutover_moved' USING ERRCODE='55000';
 END IF;

 -- The floor this migration advances must still be the one Dan set on 09-02.
 IF (SELECT count(*) FROM public.union_settlement_floor)<>1 THEN
  RAISE EXCEPTION 'unexpected_union_floor_population' USING ERRCODE='55000';
 END IF;
 SELECT earliest_period_start INTO v_floor FROM public.union_settlement_floor
  WHERE union_id='fade0000-0000-0000-0000-000000000001'::uuid;
 IF v_floor IS DISTINCT FROM timestamptz '2026-09-07T00:00:00Z' THEN
  RAISE EXCEPTION 'union_floor_already_moved' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM public.club_settlement_floor) THEN
  RAISE EXCEPTION 'club_floor_already_populated' USING ERRCODE='55000';
 END IF;

 -- Both permanently uncertifiable weeks must still be recorded as failed.
 IF (SELECT count(*) FROM public.union_accounting_runs q
      WHERE q.period_start=timestamptz '2026-09-07T07:00:00Z'
        AND q.period_end=timestamptz '2026-09-14T07:00:00Z'
        AND q.status='failed')<>2 THEN
  RAISE EXCEPTION 'expected_two_failed_historical_runs' USING ERRCODE='55000';
 END IF;
END $installed_preconditions$;

UPDATE public.union_settlement_floor
   SET earliest_period_start = timestamptz '2026-09-21T07:00:00Z',
       reason = 'Dan 2026-09-20: the v3 original-P&L basis cannot reach back. union_pnl_weekly_capture.captured_at is 2026-09-18 00:41:12.316033Z and write-once, and accounting_cash_accrual_cutover starts 2026-09-17 18:24:04.643251Z, so the weeks of 2026-09-07 and 2026-09-14 can never certify: their runs refused with union_pnl_basis_uncertified / week_precedes_complete_original_capture. The floor therefore moves from 2026-09-07 to 2026-09-21, and the first week that settles is 2026-09-21 07:00Z -> 2026-09-28 07:00Z, due 2026-09-28 09:00Z. The two skipped weeks are NOT written off: their pending rakeback is recorded in accounting_deferred_obligations and stays owed, for a separate one-off payment Dan authorises later. The earlier decision of 2026-09-02 - the weeks of 08-17, 08-24 and 08-31 deliberately never settled, because the old basis credited the union-as-a-club and zero to the member clubs - still stands.'
 WHERE union_id = 'fade0000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.club_settlement_floor (club_id,earliest_period_start,reason)
VALUES ('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, timestamptz '2026-09-21T07:00:00Z',
 'Dan 2026-09-20: the same decision as the union floor, for standalone club scope. This club''s week of 2026-09-07 refused with historical_week_before_observed_source_cutover and can never certify, because accounting_cash_accrual_cutover starts 2026-09-17 18:24:04.643251Z. Its first certifiable week is 2026-09-21 07:00Z -> 2026-09-28 07:00Z, due 2026-09-28 09:00Z. The pending rakeback of the skipped weeks stays pending and is recorded in accounting_deferred_obligations as still owed.');

-- Count what is actually there, right now, and record it with that time.
INSERT INTO public.accounting_deferred_obligations
  (scope_kind,scope_id,period_start,period_end,pending_periods,pending_amount,observed_at,reason)
SELECT CASE WHEN c.is_union IS TRUE THEN 'union' ELSE 'club' END,
       rp.club_id,
       public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles'),
       public.fn_union_week_start(public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles')+interval '8 days'),
       count(*),
       sum(rp.rakeback_amount)::numeric(20,2),
       clock_timestamp(),
       'Deferred by the settlement floor move of 2026-09-20: this week can never certify on the v3 original-P&L basis, so the weekly close will not settle its rakeback. The rakeback_periods rows counted here remain status=pending and untouched; this row records that the amount is still owed and awaits a separate one-off payment Dan authorises.'
  FROM public.rakeback_periods rp
  JOIN public.clubs c ON c.id = rp.club_id
 WHERE rp.status = 'pending'
   AND public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles')
       IN (timestamptz '2026-09-07T07:00:00Z', timestamptz '2026-09-14T07:00:00Z')
 GROUP BY 1,2,3,4;

-- The recorded numbers must be the numbers that are there.
DO $recorded_truthfully$
DECLARE r record; live_rows bigint; live_amount numeric;
BEGIN
 IF (SELECT count(*) FROM public.accounting_deferred_obligations)=0 THEN
  RAISE EXCEPTION 'no_deferred_obligation_recorded' USING ERRCODE='55000';
 END IF;
 FOR r IN SELECT * FROM public.accounting_deferred_obligations LOOP
  SELECT count(*),COALESCE(sum(rp.rakeback_amount),0)::numeric(20,2) INTO live_rows,live_amount
    FROM public.rakeback_periods rp
   WHERE rp.status='pending' AND rp.club_id=r.scope_id
     AND public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles')=r.period_start;
  IF live_rows<>r.pending_periods OR live_amount IS DISTINCT FROM r.pending_amount THEN
   RAISE EXCEPTION 'deferred_obligation_does_not_match_its_rows:%/%',r.scope_id,r.period_start USING ERRCODE='55000';
  END IF;
 END LOOP;

 -- 2026-09-07 07:00Z -> 2026-09-14 07:00Z is a closed Pacific week. Its pending
 -- rakeback cannot legitimately have moved since this file was written.
 SELECT sum(pending_periods),sum(pending_amount) INTO live_rows,live_amount
   FROM public.accounting_deferred_obligations WHERE period_start=timestamptz '2026-09-07T07:00:00Z';
 IF live_rows<>583 OR live_amount IS DISTINCT FROM 117192.35 THEN
  RAISE EXCEPTION 'week_2026_09_07_pending_rakeback_changed:%/%',live_rows,live_amount USING ERRCODE='55000';
 END IF;

 -- Nothing at or above the new floor may be deferred by this change.
 IF EXISTS (SELECT 1 FROM public.rakeback_periods rp WHERE rp.status='pending'
   AND public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles')
       >= timestamptz '2026-09-21T07:00:00Z') THEN
  RAISE EXCEPTION 'pending_rakeback_exists_at_or_above_the_new_floor' USING ERRCODE='55000';
 END IF;
END $recorded_truthfully$;

-- Read the result back inside the same transaction: the floors hold the new
-- weeks, the club cursor now clears both uncertifiable weeks, and the
-- preserved failed history is still exactly where it was.
DO $readback$
DECLARE v_cursor timestamptz; v_to timestamptz;
BEGIN
 v_to := public.fn_union_week_start(now());
 IF (SELECT earliest_period_start FROM public.union_settlement_floor
      WHERE union_id='fade0000-0000-0000-0000-000000000001'::uuid)
    IS DISTINCT FROM timestamptz '2026-09-21T07:00:00Z' THEN
  RAISE EXCEPTION 'union_floor_readback_failed' USING ERRCODE='55000'; END IF;
 IF public.fn_club_settlement_floor_week('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
    IS DISTINCT FROM timestamptz '2026-09-21T07:00:00Z' THEN
  RAISE EXCEPTION 'club_floor_readback_failed' USING ERRCODE='55000'; END IF;

 -- The exact-scope club cursor, evaluated the way the coordinator evaluates it.
 WITH pending_scope AS (
   SELECT s.club_id,min(public.fn_union_week_start(s.earned_at)) AS first_week
    FROM public.accounting_payable_earning_sources s
    WHERE s.coordinator_union_id IS NULL AND s.earned_at<v_to GROUP BY s.club_id
   UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
    WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
   UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
    WHERE q.standalone_club_id IS NOT NULL AND q.status='complete' AND q.period_end<v_to
     AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs later
       WHERE later.standalone_club_id=q.standalone_club_id AND later.period_end>q.period_end)
   UNION ALL SELECT rp.club_id,min(public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles'))
    FROM public.rakeback_periods rp WHERE rp.status='pending' AND rp.period_end<(v_to AT TIME ZONE 'America/Los_Angeles')::date
     AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=rp.club_id) GROUP BY rp.club_id
   UNION ALL SELECT a.club_id,public.fn_union_prev_week_start(now()) FROM public.agents a
    WHERE NOT COALESCE(a.is_prepaid,false) AND a.credit_used>0
     AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=a.club_id)
 ) SELECT GREATEST(min(x.first_week),public.fn_club_settlement_floor_week(x.club_id)) INTO v_cursor
     FROM pending_scope x JOIN public.clubs c ON c.id=x.club_id
    WHERE c.is_union IS NOT TRUE AND x.club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid
    GROUP BY x.club_id;
 IF v_cursor IS DISTINCT FROM timestamptz '2026-09-21T07:00:00Z' THEN
  RAISE EXCEPTION 'club_cursor_did_not_clear_the_uncertifiable_weeks:%',v_cursor USING ERRCODE='55000'; END IF;

 -- Preserved history: both failed rows still present, still failed, with their
 -- results intact. This migration reads them and changes nothing about them.
 IF (SELECT count(*) FROM public.union_accounting_runs q
      WHERE q.period_start=timestamptz '2026-09-07T07:00:00Z'
        AND q.period_end=timestamptz '2026-09-14T07:00:00Z'
        AND q.status='failed'
        AND q.result->>'error'='weekly_accounting_calculation_incomplete')<>2 THEN
  RAISE EXCEPTION 'failed_history_not_preserved' USING ERRCODE='55000'; END IF;
END $readback$;

COMMIT;
