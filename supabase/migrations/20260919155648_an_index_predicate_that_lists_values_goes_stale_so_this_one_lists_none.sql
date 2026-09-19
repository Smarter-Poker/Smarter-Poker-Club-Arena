-- 20260919155648_an_index_predicate_that_lists_values_goes_stale_so_this_one_lists_none
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-19 15:56:48 UTC.
-- Applied to production as schema_migrations version 20260919154718.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHY THE MIGRATION BEFORE THIS ONE WAS NOT THE FIX
--
-- 20260919154808 widened idx_tournament_payouts_satellite_target's predicate
-- from `source = 'satellite_seat'` to `source IN ('satellite_seat',
-- 'satellite_ticket')`, because on 2026-09-12 the query it serves was widened
-- the same way and the index was not. A partial index whose predicate does not
-- cover the query's cannot be used at all, so the seat_income term read all
-- 161,772 rows of tournament_payouts per tournament, and three money
-- conservation jobs produced no verdict for seven days.
--
-- Widening the copy fixes today. It leaves the NEXT widening free to do the
-- identical thing, silently, and nothing in this estate would notice for
-- another week. The predicate is a copy of a value list that lives in a
-- function body, and a copy of a fact goes stale; that is the defect, not the
-- particular value that was missing from it.
--
-- So the predicate goes away. An index with no value list has no list to fall
-- behind. Cost: the index covers 161,772 rows instead of 2,770, a few MB on a
-- 176 MB table, against a failure that cost seven days of silence on three
-- money checks.
--
-- WHAT IS VERIFIED HERE, and why the third probe is the important one
--
-- Two probes would only show that today's query works. The third asks for a
-- source value NOBODY HAS INVENTED YET ('satellite_something_new'). It reaches
-- the index too, which is the structural proof that this cannot recur: there
-- is no list to fall behind, so no future widening can disable it.
--
-- MEASURED. The exact workload the three dead jobs run, 200 tournaments:
-- over 120,000 ms and timing out before; 207 ms after. The hourly job then ran
-- clean for the first time since 2026-09-12: scanned 6,376, flagged 0,
-- auto_resolved 140, worst_abs_delta 0, duration_ms 7,095.
--
-- @live-proof: (SELECT indpred IS NULL FROM pg_index WHERE indexrelid = 'public.idx_tournament_payouts_satellite_target'::regclass)
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '180s';

-- Widening the predicate to match today's query fixes today's query. It leaves
-- the next widening free to break it again, silently, exactly as 2026-09-12
-- did. So the predicate goes away: an index with no value list has no list to
-- fall behind.
DROP INDEX IF EXISTS public.idx_tournament_payouts_satellite_target;

CREATE INDEX idx_tournament_payouts_satellite_target
  ON public.tournament_payouts ((metadata->>'satellite_target_id'))
  INCLUDE (amount);

COMMENT ON INDEX public.idx_tournament_payouts_satellite_target IS
  'Serves fn_tournament_conservation_delta''s seat_income lookup by satellite target. DELIBERATELY NOT PARTIAL. It used to read WHERE source = ''satellite_seat''; on 2026-09-12 the query became source IN (''satellite_seat'',''satellite_ticket'') and the planner could no longer use the index at all, so the term read all 161,772 rows per tournament and three money-conservation jobs produced no verdict for seven days. A predicate that repeats a value list is a copy that goes stale. Do not add one back.';

DO $verify$
DECLARE
  v_plan text := '';
  r      record;
  v_t0   timestamptz;
  v_ms   numeric;
  v_n    integer;
  v_pred text;
BEGIN
  SELECT pg_get_expr(i.indpred, i.indrelid) INTO v_pred
    FROM pg_index i WHERE i.indexrelid = 'public.idx_tournament_payouts_satellite_target'::regclass;
  IF v_pred IS NOT NULL THEN
    RAISE EXCEPTION 'failed: the index still carries a predicate (%), which is the thing that went stale', v_pred;
  END IF;

  -- Every source list the term has ever asked for must reach the index now,
  -- including one nobody has invented yet.
  FOREACH v_plan IN ARRAY ARRAY[
    $q1$EXPLAIN SELECT sum(amount) FROM public.tournament_payouts WHERE source IN ('satellite_seat','satellite_ticket') AND metadata->>'satellite_target_id' = '00000000-0000-0000-0000-000000000000'$q1$,
    $q2$EXPLAIN SELECT sum(amount) FROM public.tournament_payouts WHERE source IN ('satellite_seat','satellite_ticket','satellite_something_new') AND metadata->>'satellite_target_id' = '00000000-0000-0000-0000-000000000000'$q2$,
    $q3$EXPLAIN SELECT sum(amount) FROM public.tournament_payouts WHERE metadata->>'satellite_target_id' = '00000000-0000-0000-0000-000000000000'$q3$
  ] LOOP
    DECLARE v_out text := '';
    BEGIN
      FOR r IN EXECUTE v_plan LOOP
        v_out := v_out || r."QUERY PLAN" || E'\n';
      END LOOP;
      IF position('Seq Scan on tournament_payouts' in v_out) > 0 THEN
        RAISE EXCEPTION 'failed: % still reads the whole table: %', v_plan, v_out;
      END IF;
      IF position('idx_tournament_payouts_satellite_target' in v_out) = 0 THEN
        RAISE EXCEPTION 'failed: % does not reach the index: %', v_plan, v_out;
      END IF;
    END;
  END LOOP;

  -- And the workload the three dead jobs run: 200 tournaments, 120s budget.
  v_t0 := clock_timestamp();
  SELECT count(*) INTO v_n FROM (
    SELECT public.fn_tournament_conservation_delta(t.id)
      FROM public.tournaments t
     WHERE t.ended_at IS NOT NULL
     ORDER BY t.ended_at DESC
     LIMIT 200) s;
  v_ms := extract(epoch from clock_timestamp() - v_t0) * 1000;
  RAISE NOTICE 'conservation delta over % tournaments took % ms', v_n, round(v_ms);
  IF v_ms > 30000 THEN
    RAISE EXCEPTION 'failed: % ms for 200 tournaments will not fit the 120s job budget', round(v_ms);
  END IF;
END
$verify$;

COMMIT;
