\set ON_ERROR_STOP on
-- The club settlement floor is the union floor's rule, applied to club scope.
--
-- Proved here against the exact INSTALLED coordinator this migration rewrote:
--   * the club floor rounds identically to union_floors, including the
--     mid-week case, so the two scopes can never silently disagree;
--   * a club with no floor is left exactly as it was, so no existing club
--     changes behaviour;
--   * the floor is bound at all three discovery sites and nowhere else, and
--     the head-of-line EXIT rule from 20260907164234 is still present twice;
--   * the coordinator's privacy (owner and ACL) survived the rewrite;
--   * a deferred obligation reconciles to the real pending rows it counts, and
--     recording it leaves those rows pending and untouched.
-- The club scope's discovery BEHAVIOUR - a below-floor period not re-entering,
-- a later period being reached, and the EXIT still firing above the floor - is
-- proved in tests/fixtures/club-settlement-floor-behaviour against the shared
-- run journal, which this captured schema predates.
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';

-- The union's own rounding, recomputed here from union_floors' literal CASE.
CREATE FUNCTION fixture.union_rule(p timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN fn_union_week_start(p)<p
   THEN fn_union_week_start(fn_union_week_start(p)+interval '8 days')
   ELSE fn_union_week_start(p) END $$;

SELECT fixture.assert(fn_club_settlement_floor_week(f.club_id)=fixture.union_rule(f.earliest_period_start),
 'the club floor rounds by exactly the rule union_floors applies to the union floor: '||f.club_id::text)
  FROM club_settlement_floor f;
SELECT fixture.assert(fn_club_settlement_floor_week(fixture.u(151))='2026-09-07 07:00Z'::timestamptz,
 'a floor set on a week boundary keeps that week');
SELECT fixture.assert(fn_club_settlement_floor_week(fixture.u(152))='2026-09-14 07:00Z'::timestamptz,
 'a floor set mid-week rounds FORWARD to the next whole week, never back into a week it half covers');
SELECT fixture.assert(fn_club_settlement_floor_week(fixture.u(999)) IS NULL,
 'a club with no floor stays unbounded, so GREATEST leaves every existing club unchanged');
SELECT fixture.assert(GREATEST('2026-08-31 07:00Z'::timestamptz,fn_club_settlement_floor_week(fixture.u(999)))
   ='2026-08-31 07:00Z'::timestamptz,
 'GREATEST with a NULL floor returns the discovered week itself, which is the no-op this change relies on');

-- The rewrite touched the three discovery sites and nothing else.
SELECT fixture.assert((SELECT (length(d)-length(replace(d,'fn_club_settlement_floor_week','')))
     /length('fn_club_settlement_floor_week')=3
   FROM (SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) d) q),
 'the floor is consulted at exactly the three club discovery sites');
SELECT fixture.assert((SELECT (length(d)-length(replace(d,$x$IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT$x$,'')))
     /length($x$IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT$x$)=2
   FROM (SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) d) q),
 'the head-of-line EXIT rule from 20260907164234 is still present in both week loops');
SELECT fixture.assert((SELECT position('AND (v_union.earliest_period_start IS NULL OR q.period_start>=v_first)' IN d)>0
   FROM (SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) d) q),
 'the union scope keeps the floor predicate it already had: this change did not touch it');
-- CREATE OR REPLACE from the function's own definition preserves its settings;
-- the search_path VALUE is whatever the host carries, so what is pinned here is
-- that it is still set, still SECURITY DEFINER, still owned by postgres and
-- still private. The migration's own readback pins the exact production ACL.
SELECT fixture.assert((SELECT p.proacl::text='{postgres=X/postgres}' AND p.prosecdef
     AND pg_get_userbyid(p.proowner)='postgres'
     AND p.proconfig::text LIKE '%search_path=%'
   FROM pg_proc p WHERE p.oid='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure),
 'the rewritten coordinator keeps its owner, SECURITY DEFINER, a pinned search_path and its private ACL');
SELECT fixture.assert((SELECT p.proacl IS NULL OR p.proacl::text='{postgres=X/postgres}'
   FROM pg_proc p WHERE p.oid='public.fn_club_settlement_floor_week(uuid)'::regprocedure),
 'the floor reader is private: no API role can execute it');

-- The obligation is what the rows say, and the rows are left alone.
SELECT fixture.assert((SELECT o.pending_periods=2 AND o.pending_amount=17.25
   FROM accounting_deferred_obligations o WHERE o.scope_id=fixture.u(151)),
 'the deferred obligation holds the count and amount the real pending rows actually have');
SELECT fixture.assert((SELECT o.pending_periods=(SELECT count(*) FROM rakeback_periods rp
     WHERE rp.status='pending' AND rp.club_id=o.scope_id
       AND fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles')=o.period_start)
   AND o.pending_amount=(SELECT sum(rp.rakeback_amount)::numeric(20,2) FROM rakeback_periods rp
     WHERE rp.status='pending' AND rp.club_id=o.scope_id
       AND fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles')=o.period_start)
   FROM accounting_deferred_obligations o WHERE o.scope_id=fixture.u(151)),
 'the deferred obligation reconciles to a fresh recount of the real rows');
SELECT fixture.assert((SELECT count(*)=3 AND bool_and(status='pending')
   FROM rakeback_periods rp WHERE rp.club_id=fixture.u(151)),
 'recording an obligation leaves every source rakeback row pending and untouched');
SELECT fixture.assert((SELECT count(*)=0 FROM accounting_deferred_obligations o
   WHERE o.pending_periods<=0 OR o.pending_amount<0 OR btrim(o.reason)=''),
 'an obligation cannot be recorded with no rows, a negative amount or no reason');
