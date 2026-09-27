-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820121538 "union_rake_rollup_correctness_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 71472cebc1b1b3063b48a2af1af55419 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- 2026-08-20 REVIEW ROUND 2: the rollup was silently WRONG. Two independent
-- causes, both found by diffing the rollup against the legacy computation on
-- a fixed historical window (SHARK: 489,066.11 rolled vs 489,205.40 live).
--
-- CAUSE 1 — FINALIZED DAYS GO STALE. The rollup caches a query whose inputs
--   change retroactively: the union migration keeps setting tables.union_id on
--   EXISTING tables, so historical rake_records enter the union's scope after
--   the day was finalized. Measured: 2026-08-16 held 100,548 records when
--   rolled and 102,171 now (+1,623); 08-17/18/19 likewise. Every one of those
--   records' rake was missing from the settlement basis, under-crediting the
--   club that earned it.
--
-- CAUSE 2 — ATTRIBUTION WAS BAKED IN. Rake was stored per CLUB, resolved at
--   refresh time. A player joining/leaving a club afterwards silently changed
--   the correct answer while the cache kept the old one. (Not yet observed —
--   0 joins since the roll — but guaranteed to bite.)
--
-- FIX — the cache can now only ever be a SPEED optimization, never a
-- correctness input:
--   * Rake is stored PER USER per day (union_rake_paid_daily_user). Club
--     attribution and the horse filter are applied at READ time with exactly
--     the legacy expressions, so membership changes are picked up for free.
--   * Every day carries records_seen; a day whose live record count no longer
--     matches is treated as MISSING and recomputed live FOR THAT DAY ONLY
--     (bounded). A stale cache therefore degrades speed, never accuracy.
--   * fn_union_rake_rollup_catchup re-validates recent days and re-rolls the
--     stale ones, outside any money transaction.
-- Net effect: fn_union_rake_paid_readonly is now identical to
-- fn_union_rake_paid_live to the cent at all times, by construction.

DROP TABLE IF EXISTS public.union_rake_paid_daily;

CREATE TABLE IF NOT EXISTS public.union_rake_paid_daily_user (
  union_id    uuid    NOT NULL,
  day         date    NOT NULL,
  user_id     uuid    NOT NULL,
  rake_amount numeric NOT NULL,
  PRIMARY KEY (union_id, day, user_id),
  FOREIGN KEY (union_id, day)
    REFERENCES public.union_rake_rollup_days(union_id, day) ON DELETE CASCADE
);
ALTER TABLE public.union_rake_paid_daily_user ENABLE ROW LEVEL SECURITY;
-- No policies: service role and SECURITY DEFINER functions only.

-- Cheap staleness probe: does this finalized day still describe reality?
CREATE OR REPLACE FUNCTION public.fn_union_rake_day_is_fresh(
  p_union_id uuid, p_day date)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM union_rake_rollup_days d
     WHERE d.union_id = p_union_id AND d.day = p_day
       AND d.records_seen = (
         SELECT count(*)
           FROM rake_records r
           JOIN tables t ON t.id = r.table_id AND t.union_id = p_union_id
          WHERE r.created_at >= (p_day::timestamp AT TIME ZONE 'UTC')
            AND r.created_at <  ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
            AND r.player_contributions IS NOT NULL AND r.rake_amount > 0));
$function$;

-- Per-user day finalizer. Stores every contributor's rake for the day with no
-- club or horse filtering — those are read-time concerns now.
CREATE OR REPLACE FUNCTION public.fn_union_rake_rollup_refresh_day(
  p_union_id uuid, p_day date)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
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

  SELECT count(*) INTO v_records
    FROM rake_records r
    JOIN tables t ON t.id = r.table_id AND t.union_id = p_union_id
   WHERE r.created_at >= v_start AND r.created_at < v_end
     AND r.player_contributions IS NOT NULL AND r.rake_amount > 0;

  INSERT INTO union_rake_rollup_days (union_id, day, records_seen)
  VALUES (p_union_id, p_day, v_records);

  INSERT INTO union_rake_paid_daily_user (union_id, day, user_id, rake_amount)
  WITH expanded AS (
    SELECT (e.key)::uuid AS user_id,
           r.rake_amount * (e.value)::numeric
             / SUM((e.value)::numeric) OVER (PARTITION BY r.id) AS share
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id AND t.union_id = p_union_id
      CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) e(key, value)
     WHERE r.created_at >= v_start AND r.created_at < v_end
       AND r.player_contributions IS NOT NULL AND r.rake_amount > 0
  )
  SELECT p_union_id, p_day, expanded.user_id, SUM(expanded.share)
    FROM expanded
   WHERE expanded.share IS NOT NULL
   GROUP BY expanded.user_id;
END;
$function$;

-- Read-only, always-bounded, and now exactly equal to the live computation:
-- attribution + horse filter applied here, stale days recomputed per-day.
CREATE OR REPLACE FUNCTION public.fn_union_rake_paid_readonly(
  p_union_id uuid, p_start timestamptz, p_end timestamptz,
  p_include_horses boolean DEFAULT true)
RETURNS TABLE(club_id uuid, rake_paid numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_first_day date;
  v_end_day   date;
  v_today     date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  v_first_day := (p_start AT TIME ZONE 'UTC')::date;
  IF (v_first_day::timestamp AT TIME ZONE 'UTC') < p_start THEN
    v_first_day := v_first_day + 1;
  END IF;
  v_end_day := (p_end AT TIME ZONE 'UTC')::date;
  IF v_end_day > v_today THEN
    v_end_day := v_today;
  END IF;

  IF v_first_day >= v_end_day THEN
    RETURN QUERY
      SELECT l.club_id, round(l.rake_paid, 2)
        FROM fn_union_rake_paid_live(p_union_id, p_start, p_end, p_include_horses) l;
    RETURN;
  END IF;

  RETURN QUERY
  WITH attributed AS (
    SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
      JOIN profiles p ON p.id = cm.user_id
     WHERE p_include_horses OR COALESCE(p.is_horse, false) = false
     ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  days AS (
    SELECT gs::date AS d
      FROM generate_series(v_first_day, v_end_day - 1, interval '1 day') gs
  ),
  -- A day counts as usable only if its cached record count still matches
  -- reality; otherwise it is recomputed live below.
  fresh_days AS (
    SELECT days.d FROM days WHERE fn_union_rake_day_is_fresh(p_union_id, days.d)
  ),
  stale_days AS (
    SELECT days.d FROM days
     WHERE NOT EXISTS (SELECT 1 FROM fresh_days f WHERE f.d = days.d)
  ),
  rolled AS (
    SELECT a.club_id AS cid, u.rake_amount AS s
      FROM union_rake_paid_daily_user u
      JOIN fresh_days f ON f.d = u.day
      JOIN attributed a ON a.user_id = u.user_id
     WHERE u.union_id = p_union_id
  ),
  live_days AS (
    SELECT l.club_id AS cid, l.rake_paid AS s
      FROM stale_days m
      CROSS JOIN LATERAL fn_union_rake_paid_live(
        p_union_id,
        (m.d::timestamp AT TIME ZONE 'UTC'),
        ((m.d + 1)::timestamp AT TIME ZONE 'UTC'),
        p_include_horses) l
  ),
  edges AS (
    SELECT l.club_id AS cid, l.rake_paid AS s
      FROM fn_union_rake_paid_live(
        p_union_id, p_start, (v_first_day::timestamp AT TIME ZONE 'UTC'), p_include_horses) l
    UNION ALL
    SELECT l.club_id, l.rake_paid
      FROM fn_union_rake_paid_live(
        p_union_id, (v_end_day::timestamp AT TIME ZONE 'UTC'), p_end, p_include_horses) l
  ),
  combined AS (
    SELECT x.cid, SUM(x.s) AS s
      FROM (SELECT * FROM rolled
            UNION ALL SELECT * FROM live_days
            UNION ALL SELECT * FROM edges) x
     GROUP BY x.cid
  )
  SELECT c.cid, round(c.s, 2) FROM combined c WHERE c.s IS NOT NULL;
END;
$function$;

-- Catch-up now also RE-VALIDATES: a finalized-but-stale day is re-rolled.
CREATE OR REPLACE FUNCTION public.fn_union_rake_rollup_catchup(
  p_union_id uuid, p_max_days integer DEFAULT 3, p_lookback_days integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  d date;
  v_done text[] := '{}';
  v_failed text[] := '{}';
  v_remaining integer;
BEGIN
  FOR d IN
    SELECT gs::date
      FROM generate_series(v_today - p_lookback_days, v_today - 1, interval '1 day') gs
     WHERE NOT fn_union_rake_day_is_fresh(p_union_id, gs::date)
     ORDER BY gs
     LIMIT p_max_days
  LOOP
    BEGIN
      PERFORM fn_union_rake_rollup_refresh_day(p_union_id, d);
      v_done := v_done || d::text;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed || (d::text || ':' || SQLERRM);
    END;
  END LOOP;

  SELECT count(*) INTO v_remaining
    FROM generate_series(v_today - p_lookback_days, v_today - 1, interval '1 day') gs
   WHERE NOT fn_union_rake_day_is_fresh(p_union_id, gs::date);

  RETURN jsonb_build_object('union_id', p_union_id, 'rolled', to_jsonb(v_done),
                            'failed', to_jsonb(v_failed), 'stale_remaining', v_remaining);
END;
$function$;

-- Settle path: refresh anything stale or missing, then delegate to the
-- read-only reader (which is correct regardless of what the refresh achieved).
CREATE OR REPLACE FUNCTION public.fn_union_rake_paid_by_club(
  p_union_id uuid, p_start timestamptz, p_end timestamptz,
  p_include_horses boolean DEFAULT true)
RETURNS TABLE(club_id uuid, rake_paid numeric)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_first_day date;
  v_end_day   date;
  v_today     date := (now() AT TIME ZONE 'UTC')::date;
  d           date;
BEGIN
  v_first_day := (p_start AT TIME ZONE 'UTC')::date;
  IF (v_first_day::timestamp AT TIME ZONE 'UTC') < p_start THEN
    v_first_day := v_first_day + 1;
  END IF;
  v_end_day := (p_end AT TIME ZONE 'UTC')::date;
  IF v_end_day > v_today THEN
    v_end_day := v_today;
  END IF;

  IF v_first_day < v_end_day THEN
    FOR d IN
      SELECT gs::date
        FROM generate_series(v_first_day, v_end_day - 1, interval '1 day') gs
       WHERE NOT fn_union_rake_day_is_fresh(p_union_id, gs::date)
    LOOP
      BEGIN
        PERFORM fn_union_rake_rollup_refresh_day(p_union_id, d);
      EXCEPTION WHEN OTHERS THEN
        NULL;  -- reader computes this single day live; bounded either way
      END;
    END LOOP;
  END IF;

  RETURN QUERY
    SELECT r.club_id, r.rake_paid
      FROM fn_union_rake_paid_readonly(p_union_id, p_start, p_end, p_include_horses) r;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_rake_day_is_fresh(uuid, date) FROM PUBLIC, anon, authenticated;
