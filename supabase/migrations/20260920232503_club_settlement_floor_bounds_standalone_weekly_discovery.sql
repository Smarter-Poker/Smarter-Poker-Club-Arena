-- 20260920232503_club_settlement_floor_bounds_standalone_weekly_discovery.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The weekly accounting coordinator has been head-of-line blocked since
-- 2026-09-14. `union_accounting_runs` holds two `failed` rows for the Pacific
-- week 2026-09-07 07:00Z -> 2026-09-14 07:00Z: union
-- fade0000-0000-0000-0000-000000000001 (weekly_accounting_calculation_incomplete
-- -> union_pnl_basis_uncertified / week_precedes_complete_original_capture) and
-- standalone club 2a1132b9-5ba2-42e6-9f01-30a7fcffebe3
-- (historical_week_before_observed_source_cutover). Both refusals are correct
-- and permanent: `union_pnl_weekly_capture.captured_at` is 2026-09-18
-- 00:41:12.316033Z and write-once, and `accounting_cash_accrual_cutover`
-- starts 2026-09-17 18:24:04.643251Z, so neither week can ever certify on the
-- v3 basis. `fn_process_weekly_accounting_scope` ends both of its week loops
-- with `IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT`, the
-- money-safety rule shipped in 20260907164234 after 441,230.51 moved wrongly.
-- That rule is correct and is NOT touched here. What is wrong is that the
-- discovery cursor keeps re-offering a week that can never pass, so the EXIT
-- fires for ever and every later week is unreachable.
--
-- Measured read-only against production before this file was written:
--
--   * UNION discovery ALREADY respects `union_settlement_floor`. The scheduler
--     `union_work` CTE and the exact-scope loop both filter run rows with
--     `AND (earliest_period_start IS NULL OR q.period_start>=v_first)`, so a
--     run row below the floor cannot re-enter the cursor. Simulated read-only
--     on production: with today's floor (2026-09-07 00:00Z) the union cursor is
--     2026-09-07 07:00Z; with the floor at 2026-09-21 07:00Z it is
--     2026-09-21 07:00Z. For the union the fix is DATA, as that design
--     intended, and NO source change is needed. None is made here.
--   * STANDALONE-CLUB discovery has no floor concept at all. Its
--     `standalone_work` / `pending_scope` CTEs carry no floor predicate, and
--     two of their terms pull 2026-09-07 07:00Z back on every tick: the
--     `failed` run row (`status<>'complete'`) and the club's own pending
--     `rakeback_periods` row in that week. A club floor row alone would change
--     nothing. So the source must learn the club floor, and that is the only
--     source change in this migration.
--
-- This migration therefore:
--   1. adds `public.club_settlement_floor` - the same shape, the same rounding
--      and the same operator-movable DATA-with-its-reason as
--      `union_settlement_floor`, extended to standalone-club scope;
--   2. adds `public.fn_club_settlement_floor_week(uuid)`, applying the union's
--      exact floor-rounding rule to a club and returning NULL for a club with
--      no floor, so GREATEST() leaves every floorless club exactly as it is;
--   3. bounds the two club discovery sites by that floor, using the estate's
--      established `pg_get_functiondef` + single-occurrence-needle + EXECUTE
--      replace pattern (see 20260917234315), so no other line of the 300-line
--      coordinator can move by accident; and
--   4. adds `public.accounting_deferred_obligations`, where rakeback a floor
--      leaves permanently unsettled is recorded as still owed, counted from
--      real pending rows at a recorded observation time.
--
-- The accompanying migration 20260920232523 moves the floors and records the
-- obligation. Nothing here creates a cron job, watcher, reconciler or repair
-- loop, adds a second payer, relaxes the EXIT rule, adds a run status, deletes
-- or rewrites run history, or touches `union_pnl_weekly_capture`.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

-- Exact live predecessors, captured read-only. Refuse concurrent source, owner
-- or ACL drift before any DDL.
DO $installed_preconditions$
DECLARE expected record; actual record;
BEGIN
 -- The function this migration rewrites, bound byte for byte with its owner
 -- and its ACL. If the coordinator has moved, this migration refuses rather
 -- than rewriting a definition it has not read.
 SELECT md5(pg_get_functiondef(p.oid)) AS definition_md5,p.proacl::text AS acl,
   pg_get_userbyid(p.proowner) AS owner_name INTO actual
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_process_weekly_accounting_scope(uuid,uuid)');
 IF NOT FOUND OR actual.definition_md5 IS DISTINCT FROM '384ffb4671d04335e490b37b505bb11e'
   OR actual.acl IS DISTINCT FROM '{postgres=X/postgres}' OR actual.owner_name IS DISTINCT FROM 'postgres' THEN
  RAISE EXCEPTION 'weekly_coordinator_preimage_drift' USING ERRCODE='55000';
 END IF;

 -- The week arithmetic fn_club_settlement_floor_week copies from union_floors.
 -- If any of these changed, the club floor would round differently from the
 -- union floor and the two scopes would silently disagree.
 FOR expected IN SELECT * FROM (VALUES
  ('fn_union_week_start(timestamp with time zone)','103f192a228084dad0e4268c36c82c4b'),
  ('fn_union_prev_week_start(timestamp with time zone)','538130fb95504d2854a9c6e8b75214cc'),
  ('fn_union_accounting_run_at(timestamp with time zone)','85e9f0ab83b1655a90af953c0d547117')
 ) AS v(signature,definition_md5)
 LOOP
  SELECT md5(pg_get_functiondef(p.oid)) AS definition_md5 INTO actual
  FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||expected.signature);
  IF NOT FOUND OR actual.definition_md5 IS DISTINCT FROM expected.definition_md5 THEN
   RAISE EXCEPTION 'weekly_calendar_preimage_drift:%',expected.signature USING ERRCODE='55000';
  END IF;
 END LOOP;
END $installed_preconditions$;

-- The club floor: same shape, same guard semantics and the same
-- operator-movable DATA as `union_settlement_floor`, for standalone-club scope.
CREATE TABLE public.club_settlement_floor (
  club_id uuid NOT NULL,
  earliest_period_start timestamptz NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT club_settlement_floor_pkey PRIMARY KEY (club_id),
  CONSTRAINT club_settlement_floor_club_id_fkey FOREIGN KEY (club_id)
    REFERENCES public.clubs(id) ON DELETE CASCADE,
  CONSTRAINT club_settlement_floor_reason_present CHECK (btrim(reason) <> ''),
  CONSTRAINT club_settlement_floor_finite CHECK (isfinite(earliest_period_start))
);
ALTER TABLE public.club_settlement_floor OWNER TO postgres;
ALTER TABLE public.club_settlement_floor ENABLE ROW LEVEL SECURITY;
GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.club_settlement_floor TO anon,authenticated;
GRANT ALL ON TABLE public.club_settlement_floor TO service_role;
COMMENT ON TABLE public.club_settlement_floor IS
 'Earliest period a standalone club may ever settle. The union equivalent is union_settlement_floor; this is the same concept for club scope. It is DATA an operator moves, and the reason travels with it in the reason column. A period below the floor is HISTORY, not outstanding work: fn_process_weekly_accounting_scope will not let it re-enter the discovery cursor. A club with no row here is unbounded, exactly as before.';

-- The union's exact floor-rounding rule, applied to a club. NULL for a club
-- with no floor, so GREATEST() leaves every floorless club unchanged.
CREATE OR REPLACE FUNCTION public.fn_club_settlement_floor_week(p_club_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $fn$
  SELECT CASE
    WHEN public.fn_union_week_start(f.earliest_period_start) < f.earliest_period_start
      THEN public.fn_union_week_start(public.fn_union_week_start(f.earliest_period_start)+interval '8 days')
    ELSE public.fn_union_week_start(f.earliest_period_start)
  END
  FROM public.club_settlement_floor f
  WHERE f.club_id = p_club_id
$fn$;
ALTER FUNCTION public.fn_club_settlement_floor_week(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_club_settlement_floor_week(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.fn_club_settlement_floor_week(uuid) IS
 'First week a standalone club may settle, rounded by the same rule union_floors applies to union_settlement_floor. NULL when the club has no floor.';

-- What a floor leaves permanently unsettled, and therefore still owed.
CREATE TABLE public.accounting_deferred_obligations (
  scope_kind text NOT NULL,
  scope_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  pending_periods integer NOT NULL,
  pending_amount numeric(20,2) NOT NULL,
  observed_at timestamptz NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_deferred_obligations_pkey
    PRIMARY KEY (scope_kind,scope_id,period_start,period_end),
  CONSTRAINT accounting_deferred_obligations_scope_kind
    CHECK (scope_kind IN ('union','club')),
  CONSTRAINT accounting_deferred_obligations_week
    CHECK (period_end > period_start),
  CONSTRAINT accounting_deferred_obligations_counted
    CHECK (pending_periods > 0 AND pending_amount >= 0),
  CONSTRAINT accounting_deferred_obligations_reason_present
    CHECK (btrim(reason) <> '')
);
ALTER TABLE public.accounting_deferred_obligations OWNER TO postgres;
ALTER TABLE public.accounting_deferred_obligations ENABLE ROW LEVEL SECURITY;
GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.accounting_deferred_obligations TO anon,authenticated;
GRANT ALL ON TABLE public.accounting_deferred_obligations TO service_role;
COMMENT ON TABLE public.accounting_deferred_obligations IS
 'Rakeback a settlement floor leaves permanently unsettled on the v3 basis, and therefore still owed. Counted from the real pending rakeback_periods rows at observed_at; never an invented balance. Recording an obligation here does not pay, cancel or alter those rows - they stay pending until an explicitly authorised one-off payment settles them.';

-- Teach the two club discovery sites the floor, by the estate's established
-- exact-needle successor pattern. Each needle must occur exactly once in the
-- live definition, so a coordinator that has moved refuses instead of being
-- rewritten blind. The union sites are untouched: they already carry the floor.
DO $bound_discovery$
DECLARE source text; needle text; replacement text; exit_rule text;
BEGIN
 source:=pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure);

 -- Scheduler eligibility, club branch: is this club's oldest outstanding week
 -- still in the past? Clamp it to the floor first.
 needle:=$n$c.is_union IS NOT TRUE AND w.first_week<v_to$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'club_eligibility_window_location_changed' USING ERRCODE='55000'; END IF;
 replacement:=$r$c.is_union IS NOT TRUE AND GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))<v_to$r$;
 source:=replace(source,needle,replacement);

 -- Same branch, the per-week due check: the due date follows the clamped week.
 needle:=$n$public.fn_union_week_start(w.first_week+interval '8 days')) GROUP BY w.club_id$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'club_eligibility_due_location_changed' USING ERRCODE='55000'; END IF;
 replacement:=$r$public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days')) GROUP BY w.club_id$r$;
 source:=replace(source,needle,replacement);

 -- The exact-scope club cursor itself: the week its WHILE loop starts from.
 -- GREATEST ignores NULL, so a club with no floor keeps min() exactly.
 needle:=$n$SELECT x.club_id AS id,min(x.first_week) AS first_week FROM pending_scope x$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'club_discovery_cursor_location_changed' USING ERRCODE='55000'; END IF;
 replacement:=$r$SELECT x.club_id AS id,GREATEST(min(x.first_week),public.fn_club_settlement_floor_week(x.club_id)) AS first_week FROM pending_scope x$r$;
 source:=replace(source,needle,replacement);

 -- The money-safety rule stays exactly as shipped: two loops, two EXITs.
 exit_rule:=$n$IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT$n$;
 IF (length(source)-length(replace(source,exit_rule,'')))/length(exit_rule)<>2 THEN
  RAISE EXCEPTION 'head_of_line_exit_rule_changed' USING ERRCODE='55000'; END IF;

 EXECUTE source;
END $bound_discovery$;
-- The coordinator remains private to the existing authorized weekly entry.
REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Read the source change back inside the same transaction.
DO $readback$
BEGIN
 IF public.fn_club_settlement_floor_week('00000000-0000-0000-0000-000000000000'::uuid) IS NOT NULL THEN
  RAISE EXCEPTION 'floorless_club_must_stay_unbounded' USING ERRCODE='55000'; END IF;
 IF (SELECT (length(d)-length(replace(d,'fn_club_settlement_floor_week','')))/length('fn_club_settlement_floor_week')
      FROM (SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) d) q)<>3 THEN
  RAISE EXCEPTION 'club_floor_not_bound_at_all_three_sites' USING ERRCODE='55000'; END IF;
 IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)
      IS DISTINCT FROM '{postgres=X/postgres}' THEN
  RAISE EXCEPTION 'coordinator_acl_changed' USING ERRCODE='55000'; END IF;
END $readback$;

COMMIT;
