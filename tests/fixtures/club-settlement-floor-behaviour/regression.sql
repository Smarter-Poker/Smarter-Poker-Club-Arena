\set ON_ERROR_STOP on
-- The club settlement floor, proved by running the installed coordinator.
--
-- tests/fixtures/club-settlement-floor proves the floor's ARITHMETIC and the
-- shape of the rewrite. This file proves the BEHAVIOUR that the stall was
-- about, on the same cluster, against the same installed definitions, with
-- 20260920232503 applied here by its own production preimage guard:
--
--   (a) a standalone-club period BELOW the club floor does not re-enter
--       discovery, while a club with no floor is left exactly as it was;
--   (b) the later certifiable period IS reached once the older uncertifiable
--       one is below the floor - for standalone-club AND for union scope;
--   (c) the head-of-line EXIT from 20260907164234 still fires for a genuine
--       transient failure ABOVE the floor, so a later week is NOT worked;
--   (d) accounting_deferred_obligations matches the real pending
--       rakeback_periods rows for the deferred weeks, and those rows stay owed.
--
-- BOUNDARY, stated rather than papered over: the floor is bound at three
-- discovery sites. Site 3 - the exact-scope club cursor - is what decides WHICH
-- week is worked, and it is exercised end to end below. Sites 1 and 2 are the
-- scheduler's eligibility window and its per-week due check; they only decide
-- whether a club is visited at all, and a scheduler-wide call on this cluster
-- raises closed_original_book_barrier_required for an unrelated union fixture
-- that shares it. Their clamp is therefore asserted here as the exact
-- arithmetic the installed definition performs, and structurally (the floor
-- bound at exactly three sites) in the sibling fixture.
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';
SET test.clock='2026-09-21T09:20:00Z';

CREATE TEMP TABLE floor_before AS
 SELECT scope_kind,scope_id,period_start,period_end,status,attempts,started_at,finished_at,result
   FROM union_accounting_runs
  WHERE scope_id IN(fixture.u(160),fixture.u(161),fixture.u(162),fixture.u(163),fixture.u(164));

-- The stall itself: every one of these scopes is offered its 2026-08-31 week.
SELECT fixture.assert((SELECT count(*)=5 FROM floor_before WHERE period_start='2026-08-31 07:00Z' AND status='failed'),
 'precondition: all five scopes start head-of-line blocked on the 2026-08-31 week');
SELECT fixture.assert('2026-09-14 07:00Z'::timestamptz<fn_union_week_start(public.test_clock())
   AND public.test_clock()>=fn_union_accounting_run_at('2026-09-21 07:00Z'::timestamptz),
 'precondition: at the fixture clock the 2026-09-14 -> 2026-09-21 week is inside the window and past its due time');

-- One call per scope. Exactly one: attempts are evidence.
SELECT public.fn_process_weekly_accounting_scope(NULL,fixture.u(161)) IS NOT NULL AS ran_161 \gset
SELECT public.fn_process_weekly_accounting_scope(NULL,fixture.u(162)) IS NOT NULL AS ran_162 \gset
SELECT public.fn_process_weekly_accounting_scope(NULL,fixture.u(163)) IS NOT NULL AS ran_163 \gset
SELECT public.fn_process_weekly_accounting_scope(fixture.u(160),NULL) IS NOT NULL AS ran_160 \gset

-- (a) BELOW THE FLOOR: the week that can never certify is not re-entered.
SELECT fixture.assert((SELECT count(*)=1 FROM union_accounting_runs q JOIN floor_before b USING(scope_kind,scope_id,period_start,period_end)
   WHERE q.scope_id=fixture.u(161) AND q.period_start='2026-08-31 07:00Z'
     AND (q.status,q.attempts,q.started_at,q.finished_at,q.result) IS NOT DISTINCT FROM (b.status,b.attempts,b.started_at,b.finished_at,b.result)),
 '(a) the below-floor 2026-08-31 club week was not attempted again: status, attempts, timestamps and result are untouched');
SELECT fixture.assert((SELECT count(*)=0 FROM union_accounting_runs q
   WHERE q.scope_id=fixture.u(161) AND q.period_start<fn_club_settlement_floor_week(fixture.u(161))
     AND q.period_start<>'2026-08-31 07:00Z'),
 '(a) no run row below the club floor was created at all');
SELECT fixture.assert((SELECT count(*)=2 AND bool_and(rp.status='pending') FROM rakeback_periods rp
   WHERE rp.club_id=fixture.u(161)),
 '(a) the real pending rows in the deferred week are still pending: the floor defers, it does not pay or cancel');
-- The negative control. Without a floor the old behaviour must be untouched.
SELECT fixture.assert((SELECT q.attempts>b.attempts FROM union_accounting_runs q JOIN floor_before b USING(scope_kind,scope_id,period_start,period_end)
   WHERE q.scope_id=fixture.u(162) AND q.period_start='2026-08-31 07:00Z'),
 '(a) a club with NO floor still re-enters its oldest outstanding week: this change is not a blanket suppression');
-- Scheduler eligibility window, sites 1 and 2, as the installed definition computes it.
SELECT fixture.assert('2026-08-31 07:00Z'::timestamptz<fn_union_week_start(public.test_clock())
   AND NOT(GREATEST('2026-08-31 07:00Z'::timestamptz,fn_club_settlement_floor_week(fixture.u(164)))<fn_union_week_start(public.test_clock())),
 '(a) the scheduler eligibility window clamps a club whose floor is the current week edge, where the unclamped week would qualify');
SELECT fixture.assert(fn_union_accounting_run_at(fn_union_week_start(GREATEST('2026-08-31 07:00Z'::timestamptz,
     fn_club_settlement_floor_week(fixture.u(161)))+interval '8 days'))
   =fn_union_accounting_run_at('2026-09-14 07:00Z'::timestamptz),
 '(a) the scheduler due check follows the clamped week, not the buried one');

-- (b) THE LATER WEEK IS REACHED. Club scope reaches it AND certifies it.
SELECT fixture.assert((SELECT q.status='complete' AND q.result->>'success'='true' AND q.result->>'accounting_version'='3'
   FROM union_accounting_runs q WHERE q.scope_id=fixture.u(161)
    AND q.period_start='2026-09-07 07:00Z' AND q.period_end='2026-09-14 07:00Z'),
 '(b) club scope: the first week above the floor was reached and completed on the v3 basis');
SELECT fixture.assert((SELECT count(*)=1 FROM union_accounting_runs q WHERE q.scope_id=fixture.u(161)
    AND q.period_start='2026-09-14 07:00Z' AND q.period_end='2026-09-21 07:00Z'),
 '(b) club scope: the loop carried on past the completed week to the next due one');
SELECT fixture.assert((SELECT count(*)=1 FROM union_accounting_runs q JOIN floor_before b USING(scope_kind,scope_id,period_start,period_end)
   WHERE q.scope_id=fixture.u(160) AND q.period_start='2026-08-31 07:00Z'
     AND (q.status,q.attempts,q.result) IS NOT DISTINCT FROM (b.status,b.attempts,b.result)),
 '(b) union scope: the below-floor week stayed untouched');
SELECT fixture.assert((SELECT count(*)=1 FROM union_accounting_runs q WHERE q.scope_id=fixture.u(160)
    AND q.scope_kind='union' AND q.period_start='2026-09-07 07:00Z' AND q.period_end='2026-09-14 07:00Z'),
 '(b) union scope: the first week above the floor was reached');

-- (c) THE MONEY-SAFETY RULE IS INTACT ABOVE THE FLOOR.
SELECT fixture.assert((SELECT q.status='failed' AND q.result->>'error'='weekly_accounting_calculation_incomplete'
    AND q.result->>'detail' LIKE '%legacy_or_paid_period_requires_reconciliation%'
   FROM union_accounting_runs q WHERE q.scope_id=fixture.u(163)
    AND q.period_start='2026-09-07 07:00Z' AND q.period_end='2026-09-14 07:00Z'),
 '(c) the first week above the floor failed for a real, resolvable reason from the installed preparation');
SELECT fixture.assert((SELECT count(*)=0 FROM union_accounting_runs q WHERE q.scope_id=fixture.u(163)
    AND q.period_start>'2026-09-07 07:00Z'),
 '(c) the head-of-line EXIT fired: the next due week was NOT worked after that failure');
SELECT fixture.assert((SELECT count(*)=1 FROM union_accounting_runs q WHERE q.scope_id=fixture.u(161)
    AND q.period_start='2026-09-14 07:00Z'),
 '(c) and that is the EXIT, not the window: the same week IS worked for the club whose earlier week succeeded');
SELECT fixture.assert((SELECT (length(d)-length(replace(d,$x$IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT$x$,'')))
     /length($x$IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT$x$)=2
   FROM (SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) d) q),
 '(c) both week loops still carry the exact EXIT rule shipped in 20260907164234');

-- (d) WHAT THE FLOOR DEFERS IS STILL OWED, AND THE NUMBER IS THE ROWS.
SELECT fixture.assert((SELECT o.pending_periods=(SELECT count(*) FROM rakeback_periods rp
     WHERE rp.status='pending' AND rp.club_id=o.scope_id
       AND fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles')=o.period_start)
   AND o.pending_amount=(SELECT sum(rp.rakeback_amount)::numeric(20,2) FROM rakeback_periods rp
     WHERE rp.status='pending' AND rp.club_id=o.scope_id
       AND fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles')=o.period_start)
   FROM accounting_deferred_obligations o WHERE o.scope_id=fixture.u(161)),
 '(d) the obligation still reconciles to a fresh recount of the real pending rows AFTER the coordinator ran');
SELECT fixture.assert((SELECT o.pending_periods=2 AND o.pending_amount=17.25 AND o.scope_kind='club'
   FROM accounting_deferred_obligations o WHERE o.scope_id=fixture.u(161)),
 '(d) the obligation holds the exact count and amount those rows actually have');
SELECT fixture.assert((SELECT bool_and(fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles')
     <fn_club_settlement_floor_week(rp.club_id))
   FROM rakeback_periods rp WHERE rp.club_id=fixture.u(161) AND rp.status='pending'),
 '(d) every row the obligation counts really is below the floor that deferred it');
SELECT fixture.assert((SELECT count(*)=0 FROM accounting_deferred_obligations o
   WHERE o.pending_periods<=0 OR o.pending_amount<0 OR btrim(o.reason)='' OR o.period_end<=o.period_start),
 '(d) an obligation cannot be recorded with no rows, a negative amount, no reason or a backwards week');
