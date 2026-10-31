-- 20261031202949_a_retired_club_opens_no_empty_accounting_week.sql
--
-- WHY: 20261031184340 retired the Lightning Internal Pilot (owner, 2026-10-31:
-- "REMOVE THE LIGHTNING INTERNAL PILOT, AND ANY AND ALL TRACES OF IT"). It is the
-- first retired club with weekly accounting history, and the weekly scheduler
-- would keep closing it forever:
--
--  - standalone_work carries every standalone club forward from its last
--    complete run, so the pilot (last close: week ending 2026-10-26 07:00 UTC)
--    is due again on Monday 2026-11-02, and every Monday after.
--  - fn_accounting_week_clubs(NULL, pilot, week) returns the pilot, so the close
--    reaches fn_mark_scope_accounting_settled, which INSERTs a settlement_periods
--    row for it. settlement_periods carries the retirement guard, so the insert
--    raises CLUB_RETIRED and that scope fails every tick. It cannot hold the
--    other scopes back (a failing visit is ordered last and is its own
--    subtransaction), but it would fail every week, forever, for a club that
--    no longer exists.
--
-- CHANGE: in the scheduler's eligible-club selection, a RETIRED club is no longer
-- due once its books are finished: no run of its is incomplete, and nothing has
-- been earned (cash rake source or tournament fee source) at or after the end of
-- its last complete close. A retired club that still has an unfinished run, or
-- earnings after its last close (a club retired mid-week), stays due exactly as
-- before, so nothing owed is ever skipped. Active clubs are untouched: the first
-- condition is lifecycle_status = 'retired'. Both reads use existing indexes
-- ((club_id, earned_at) and (club_id, recorded_at) INCLUDE (charged_at)).
--
-- Measured 2026-10-31 20:30 UTC: the pilot has no incomplete run and no cash or
-- tournament source on or after 2026-10-26 07:00 UTC, so it drops out; the other
-- two retired clubs have no accounting history at all.
--
-- The function is patched in place from its live definition on one exact anchor
-- that must occur once, and its owner, grants, security and settings must be
-- unchanged afterwards; anything else refuses the transaction. The patched body
-- was compiled as a pg_temp function against production first.
--
-- @live-proof: position('A RETIRED CLUB OPENS NO EMPTY WEEK' IN pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) > 0

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $install$
DECLARE
 v_target constant regprocedure := 'public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 v_def text;
 v_patched text;
 v_before jsonb;
 v_after jsonb;
 v_anchor constant text := E'FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id\n           WHERE c.is_union IS NOT TRUE AND GREATEST(';
 v_replacement constant text := E'FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id\n           WHERE c.is_union IS NOT TRUE\n            -- A RETIRED CLUB OPENS NO EMPTY WEEK (20261031): once its last close is\n            -- complete and nothing has been earned since, its books are finished.\n            -- The retirement guard refuses a new settlement period for it anyway.\n            AND NOT (c.lifecycle_status=''retired''\n              AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs rq WHERE rq.standalone_club_id=c.id AND rq.status<>''complete'')\n              AND NOT EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources rs WHERE rs.club_id=c.id\n                AND rs.earned_at>=COALESCE((SELECT max(rq.period_end) FROM public.union_accounting_runs rq WHERE rq.standalone_club_id=c.id AND rq.status=''complete''),''-infinity''::timestamptz))\n              AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources ts WHERE ts.club_id=c.id\n                AND ts.charged_at>=COALESCE((SELECT max(rq.period_end) FROM public.union_accounting_runs rq WHERE rq.standalone_club_id=c.id AND rq.status=''complete''),''-infinity''::timestamptz)))\n            AND GREATEST(';
BEGIN
 SELECT pg_get_functiondef(p.oid),
        jsonb_build_object('owner', p.proowner, 'acl', p.proacl, 'secdef', p.prosecdef, 'cfg', p.proconfig, 'vol', p.provolatile)
   INTO v_def, v_before FROM pg_proc p WHERE p.oid = v_target;
 IF position('A RETIRED CLUB OPENS NO EMPTY WEEK' IN v_def) > 0 THEN
  RAISE EXCEPTION 'RETIRED_WEEK_RULE_ALREADY_INSTALLED' USING ERRCODE = '55000';
 END IF;
 IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
  RAISE EXCEPTION 'RETIRED_WEEK_RULE_ANCHOR_CHANGED' USING ERRCODE = '55000';
 END IF;
 v_patched := replace(v_def, v_anchor, v_replacement);
 EXECUTE v_patched;
 SELECT jsonb_build_object('owner', p.proowner, 'acl', p.proacl, 'secdef', p.prosecdef, 'cfg', p.proconfig, 'vol', p.provolatile)
   INTO v_after FROM pg_proc p WHERE p.oid = v_target;
 IF v_after IS DISTINCT FROM v_before THEN
  RAISE EXCEPTION 'RETIRED_WEEK_RULE_METADATA_CHANGED % %', v_before, v_after;
 END IF;
 IF pg_get_functiondef(v_target) <> v_patched THEN
  RAISE EXCEPTION 'RETIRED_WEEK_RULE_NOT_INSTALLED_AS_WRITTEN';
 END IF;
END $install$;

COMMIT;
