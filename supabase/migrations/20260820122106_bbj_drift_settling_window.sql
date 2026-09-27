-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820122106 "bbj_drift_settling_window"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d60482e2acac5d78ac87d99374ad22aa of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The BBJ drift alarm was firing on hands that had not finished being written.
--
-- Within one hand, atomic_distribute_rake writes the rake_records row and
-- logBBJCollection then writes the bbj_contributions row. They are sequential,
-- not simultaneous. An audit that runs in the gap sees a booked contribution
-- with nothing received and reports it as drift.
--
-- Observed exactly that: the alarm reported 0.25 chips of drift over a day, and
-- the entire discrepancy was ONE hand, timestamped seconds before the audit ran.
-- Nothing was lost; the second write simply had not landed yet.
--
-- An alarm that cries wolf every hour is worse than no alarm, because people
-- learn to mute it — and this one exists to catch a real class of chip loss.
-- So the joined comparison now ignores rows younger than a settling window.
-- Two minutes is far longer than the gap between the two writes and far shorter
-- than the hourly audit cadence, so a genuine loss is still caught on the very
-- next run.
--
-- The `unlinkable` metric is deliberately NOT settled: a rake row with no
-- hand_id at all can never acquire a counterpart, so waiting proves nothing.
CREATE OR REPLACE FUNCTION public.bbj_drift_since(p_since timestamptz)
 RETURNS TABLE(booked numeric, received numeric, booked_rows bigint, received_rows bigint, unlinkable_rows bigint, unlinkable_chips numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH r AS (
    SELECT hand_id, bbj_contribution
    FROM rake_records
    WHERE created_at >= p_since
      AND bbj_contribution > 0
  ),
  settled AS (
    -- Only hands old enough that BOTH writes have had time to land.
    SELECT hand_id, bbj_contribution
    FROM rake_records
    WHERE created_at >= p_since
      AND created_at < now() - interval '2 minutes'
      AND bbj_contribution > 0
      AND hand_id IS NOT NULL
  ),
  c AS (
    SELECT hand_id, sum(amount) AS amt
    FROM bbj_contributions
    WHERE created_at >= p_since - interval '6 hours'
      AND hand_id IS NOT NULL
    GROUP BY hand_id
  ),
  j AS (
    SELECT s.bbj_contribution AS booked, COALESCE(c.amt, 0) AS received
    FROM settled s
    LEFT JOIN c ON c.hand_id = s.hand_id
  )
  SELECT
    COALESCE(sum(j.booked), 0)::numeric,
    COALESCE(sum(j.received), 0)::numeric,
    count(*)::bigint,
    count(*) FILTER (WHERE j.received > 0)::bigint,
    (SELECT count(*) FROM r WHERE r.hand_id IS NULL)::bigint,
    COALESCE((SELECT sum(r.bbj_contribution) FROM r WHERE r.hand_id IS NULL), 0)::numeric
  FROM j;
$function$;
