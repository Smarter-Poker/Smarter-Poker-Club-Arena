-- 20260930232545_the_rake_rollup_budget_is_its_own_statement_and_its_day_quer.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (2026-09-30, CLAUDE.md 10.11 / 10.12):
--
-- pg_cron job `union-rake-rollup-catchup` (jobid 366, '55 * * * *') failed on
-- every run from 2026-09-29T00:55Z: 54 failures, every one lasting exactly
-- 00:02:00.00x, every one `canceling statement due to statement timeout`
-- inside the INSERT INTO union_rake_paid_daily_user of
-- fn_union_rake_rollup_refresh_day. union_rake_paid_daily_user and
-- union_rake_rollup_days both stopped at day 2026-09-27. Two causes, both fixed
-- here at the line that produced them:
--
-- 1. THE BUDGET NEVER APPLIED. The command raised the timeout with
--    PERFORM set_config('statement_timeout', '600s', true) from INSIDE its DO
--    block. Postgres arms the statement timer when the top-level statement
--    starts; the DO is that statement, so the 600 s never reached it and it ran
--    under the postgres role's statement_timeout=2min (pg_roles.rolconfig).
--    The command now issues SET statement_timeout = '600s'; as its own
--    top-level statement before the DO - the pattern midway-close-once-20260929d
--    uses, which ran 45 minutes under its own top-level SET.
--
-- 2. THE PASS HAD GROWN PAST TWO MINUTES BECAUSE OF ONE PLAN. The cash leg of
--    refresh_day split each hand's rake with
--    SUM(value) OVER (PARTITION BY r.id). To feed that window pre-sorted, the
--    planner chose `Index Scan using rake_records_pkey` with created_at as a
--    FILTER - i.e. it walked every rake record ever written, in id order,
--    to find one day's 46,255. Measured on production (read-only, rolled back):
--      * the whole day query as written ................ > 55 s (cancelled)
--      * the same query, per-hand total from a LATERAL .. 1.1 s (2026-09-28,
--        516 users, 151,868.24 rake)
--      * cash leg alone 0.8 s; tournament leg alone 0.4 s warm, 11.3 s cold;
--        fn_union_rake_stale_days 1.1 s
--    The per-hand total is now a LATERAL SUM over the same jsonb_each_text
--    rows, which needs no ordering, so the created_at index is used. It is the
--    same number: recomputed for 2026-09-27 it reproduced all 500 stored
--    union_rake_paid_daily_user rows exactly (0 differences, 8.8 s cold).
--
-- PER-PASS BOUND. fn_union_rake_rollup_catchup stops STARTING new days once
-- its top-level statement is 240 s old (statement_timestamp()), so a slow
-- day or a cold cache ends the pass cleanly and commits every day already
-- rolled. Each rolled day is recorded in union_rake_rollup_days and
-- fn_union_rake_stale_days resumes from that record on the next hourly run -
-- the pass is restartable from its own record, not all-or-nothing.
--
-- THE TIMEOUT, DERIVED. Worst measured day 11.3 s cold; a pass is at most 8
-- days per union (p_max_days) and 1 union exists today, so ~90 s cold worst
-- case, stopped starting work at 240 s. 600 s leaves the 240 s pass budget
-- plus a full cold day with more than 2x headroom, and is the budget
-- fn_ca_rake_rollup_writer_silent already describes. It is not the measured
-- ceiling.
--
-- NOT A NEW JOB. The existing job's schedule IS the product (a reporting
-- rollup, CLAUDE.md 10.12 "the two things this does NOT ban"). Its schedule is
-- unchanged; only its command and the two functions change. No catch-up,
-- backfill or healer is added. Horses are rolled up exactly as humans
-- (no is_horse anywhere). No settled record is rewritten: the rollup is a
-- derived reporting table the function already deletes and rewrites per day.
--
-- Pinned by tests/the-rake-rollup-budget-is-its-own-statement.law.test.ts.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_rake_rollup_refresh_day(uuid,date)'::regprocedure))
       NOT IN ('7b895fa5f252cd62e345d132114a7598')
  OR md5(pg_get_functiondef('public.fn_union_rake_rollup_catchup(uuid,integer,integer)'::regprocedure))
       NOT IN ('6ec547f639fc656008a1f86cf1f09609')
  OR NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'union-rake-rollup-catchup' AND active
                    AND schedule = '55 * * * *'
                    AND command LIKE '%fn_union_rake_rollup_catchup_all(8)%') THEN
    RAISE EXCEPTION 'union rake rollup predecessor changed underneath this migration';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_union_rake_rollup_refresh_day(p_union_id uuid, p_day date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz := (p_day::timestamp AT TIME ZONE 'UTC');
  v_end   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_records integer;
BEGIN
  IF v_end > now() THEN
    RAISE EXCEPTION 'union rake rollup: day % is not complete (UTC); refusing to finalize', p_day;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('union_rake_rollup:' || p_union_id::text || ':' || p_day::text, 42));

  DELETE FROM union_rake_rollup_days
   WHERE union_id = p_union_id AND day = p_day;  -- cascades to detail

  -- counts BOTH legs, so the freshness test below can detect a cash-only day
  SELECT (SELECT count(*)
            FROM rake_records r
            JOIN tables t ON t.id = r.table_id AND t.union_id = p_union_id
           WHERE r.created_at >= v_start AND r.created_at < v_end
             AND r.player_contributions IS NOT NULL AND r.rake_amount > 0)
       + (SELECT count(*)
            FROM rake_records r
           WHERE r.is_tournament
             AND r.created_at >= v_start AND r.created_at < v_end
             AND r.rake_amount <> 0
             AND (r.club_id = p_union_id
                  OR EXISTS (SELECT 1 FROM union_clubs uc
                              WHERE uc.union_id = p_union_id AND uc.club_id = r.club_id)))
    INTO v_records;

  INSERT INTO union_rake_rollup_days (union_id, day, records_seen)
  VALUES (p_union_id, p_day, v_records);

  INSERT INTO union_rake_paid_daily_user (union_id, day, user_id, rake_amount)
  WITH expanded AS (
    /* ONE DAY, NOT EVERY RAKE RECORD (2026-09-30). The hand's total comes
       from a LATERAL SUM over the same contribution rows. It used to be
       a window partitioned by the rake record id, and to feed it in id order
       the planner walked rake_records_pkey across the whole table with
       created_at as a filter: > 55 s for one day, and the hourly job died at
       its 2-minute limit for 54 runs. Same number, no ordering, 1.1 s. */
    SELECT (e.key)::uuid AS user_id,
           r.rake_amount * (e.value)::numeric / NULLIF(hand.total, 0) AS share
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id AND t.union_id = p_union_id
      CROSS JOIN LATERAL (SELECT SUM((x.value)::numeric) AS total
                            FROM jsonb_each_text(r.player_contributions) x) hand
      CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) e(key, value)
     WHERE r.created_at >= v_start AND r.created_at < v_end
       AND r.player_contributions IS NOT NULL AND r.rake_amount > 0
  ),
  all_legs AS (
    SELECT expanded.user_id, expanded.share FROM expanded WHERE expanded.share IS NOT NULL
    UNION ALL
    SELECT u.user_id, u.rake_amount
      FROM fn_union_tournament_rake_by_user(p_union_id, v_start, v_end) u
  )
  ,
  per_user AS (
    SELECT all_legs.user_id, SUM(all_legs.share) AS exact
      FROM all_legs GROUP BY all_legs.user_id
  ),
  /* WHOLE CENTS, AND THE DAY STILL ADDS UP (2026-09-09). A share is a
     quotient and carries twenty decimal places; the table takes two. Each
     user is rounded and the rounding residue is given to the largest share,
     so no user holds a fraction of a cent and the day's total is still the
     rake that was taken. */
  ranked AS (
    SELECT pu.user_id, pu.exact, round(pu.exact, 2) AS cents,
           row_number() OVER (ORDER BY pu.exact DESC, pu.user_id) AS rn
      FROM per_user pu
  ),
  day_total AS (
    SELECT round(sum(exact), 2) AS exact_total, sum(cents) AS cents_total FROM ranked
  )
  SELECT p_union_id, p_day, k.user_id,
         k.cents + CASE WHEN k.rn = 1 THEN (t.exact_total - t.cents_total) ELSE 0 END
    FROM ranked k CROSS JOIN day_total t;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_rake_rollup_catchup(p_union_id uuid, p_max_days integer DEFAULT 3, p_lookback_days integer DEFAULT 4)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  d date;
  v_stale date[];
  v_done text[] := '{}';
  v_failed text[] := '{}';
  v_rolled int := 0;
  v_out_of_budget boolean := false;
BEGIN
  -- ONE scan for the whole window. This used to call
  -- fn_union_rake_day_is_fresh once per day to pick the stale days and then
  -- AGAIN once per day to count what was left -- about 20 separate full-day
  -- counts over rake_records for the old 10-day lookback, each joining ~100k
  -- rows to tables. That reliably exceeded the 8s statement timeout, so the
  -- catch-up aborted on every settler cycle and the rollup was only ever kept
  -- current by its lazy readers.
  v_stale := ARRAY(
    SELECT s FROM fn_union_rake_stale_days(p_union_id, v_today - p_lookback_days, v_today) s
  );

  FOREACH d IN ARRAY v_stale LOOP
    EXIT WHEN v_rolled >= GREATEST(p_max_days, 0);
    -- PER-PASS BOUND (2026-09-30). Stop STARTING days 240 s into the
    -- top-level statement, so the pass ends and commits what it rolled
    -- instead of being cancelled and rolling everything back. The days left
    -- are still stale in union_rake_rollup_days and the next run resumes
    -- from them.
    IF clock_timestamp() - statement_timestamp() > interval '240 seconds' THEN
      v_out_of_budget := true;
      EXIT;
    END IF;
    BEGIN
      PERFORM fn_union_rake_rollup_refresh_day(p_union_id, d);
      v_done := v_done || d::text;
      v_rolled := v_rolled + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed || (d::text || ':' || SQLERRM);
      v_rolled := v_rolled + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'union_id', p_union_id,
    'rolled', to_jsonb(v_done),
    'failed', to_jsonb(v_failed),
    'out_of_budget', v_out_of_budget,
    -- Everything we did not get to this cycle. Derived from the single scan
    -- above rather than re-counting, so reporting cannot itself time out.
    'stale_remaining', GREATEST(COALESCE(array_length(v_stale, 1), 0) - v_rolled, 0));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_union_rake_rollup_refresh_day(uuid,date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_union_rake_rollup_catchup(uuid,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_rake_rollup_refresh_day(uuid,date) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_rake_rollup_catchup(uuid,integer,integer) TO service_role;

-- The budget is its OWN top-level statement, before the DO. Never inside it.
SELECT cron.alter_job(
  job_id  := (SELECT jobid FROM cron.job WHERE jobname = 'union-rake-rollup-catchup'),
  command := $cmd$SET statement_timeout = '600s';
DO $body$
BEGIN
  IF pg_try_advisory_xact_lock(hashtext('union-rake-rollup-catchup')) THEN
    PERFORM public.fn_union_rake_rollup_catchup_all(8);
  ELSE
    RAISE NOTICE 'skipped: union-rake-rollup-catchup already running';
  END IF;
END
$body$;$cmd$);

DO $postflight$
DECLARE v_cmd text;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'union-rake-rollup-catchup';
  IF v_cmd NOT LIKE 'SET statement_timeout = ''600s'';%'
  OR v_cmd LIKE '%set_config(''statement_timeout''%'
  OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'union-rake-rollup-catchup'
                  AND active AND schedule = '55 * * * *')
  OR pg_get_functiondef('public.fn_union_rake_rollup_refresh_day(uuid,date)'::regprocedure)
       LIKE '%OVER (PARTITION BY r.id)%'
  OR NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid IN ('public.fn_union_rake_rollup_refresh_day(uuid,date)'::regprocedure,
                                'public.fn_union_rake_rollup_catchup(uuid,integer,integer)'::regprocedure)
                    AND pg_get_userbyid(proowner) = 'postgres' AND prosecdef
                    AND proconfig = ARRAY['search_path=public']
                    AND proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
                 HAVING count(*) = 2) THEN
    RAISE EXCEPTION 'union rake rollup postimage mismatch';
  END IF;
END
$postflight$;

COMMIT;
