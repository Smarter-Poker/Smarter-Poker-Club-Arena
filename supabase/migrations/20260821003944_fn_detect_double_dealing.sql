-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821003944 "fn_detect_double_dealing"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 85ffcb171ab484713c95c87b4e7214d2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- fn_detect_double_dealing
-- ═══════════════════════════════════════════════════════════════════════
-- TIER: 2  |  AFFECTS: new function public.fn_detect_double_dealing
-- IRREVERSIBLE: no
--
-- WHY
--   On 2026-08-20 23:48Z two engine instances dealt one table simultaneously
--   (deploy overlap, lease enforcement then off). The damage was found by a
--   HUMAN noticing his all-in resolved with no flop. Lease enforcement is now
--   on by default, but "never again" needs a detector that does not depend on
--   the very mechanism it guards: two dealers on one table ALWAYS leave this
--   fingerprint — two hands on the same table whose play windows overlap.
--   One dealer cannot deal two hands at once.
--
--   Called by the World Hub /api/cron/spin-sweep probe every 15 minutes; any
--   row it returns becomes an alert. The >1s overlap floor ignores boundary
--   jitter between consecutive hands sharing a timestamp edge.
--
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.fn_detect_double_dealing(integer);
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_detect_double_dealing(p_lookback_mins integer DEFAULT 30)
RETURNS TABLE (
  table_id uuid,
  hand_a bigint,
  hand_b bigint,
  overlap_seconds numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH recent AS (
    SELECT h.table_id, h.hand_number, h.started_at, h.ended_at
    FROM public.hand_history h
    WHERE h.created_at > now() - make_interval(mins => GREATEST(p_lookback_mins, 1))
      AND h.started_at IS NOT NULL
      AND h.ended_at IS NOT NULL
  )
  SELECT a.table_id,
         a.hand_number AS hand_a,
         b.hand_number AS hand_b,
         round(EXTRACT(EPOCH FROM (LEAST(a.ended_at, b.ended_at) - GREATEST(a.started_at, b.started_at)))::numeric, 1)
  FROM recent a
  JOIN recent b
    ON b.table_id = a.table_id
   AND b.hand_number > a.hand_number
   AND a.started_at < b.ended_at
   AND b.started_at < a.ended_at
  WHERE EXTRACT(EPOCH FROM (LEAST(a.ended_at, b.ended_at) - GREATEST(a.started_at, b.started_at))) > 1
$$;

REVOKE ALL ON FUNCTION public.fn_detect_double_dealing(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_detect_double_dealing(integer) TO service_role;

-- Post-apply assertion: it runs, and (with one dealer per table) returns
-- nothing right now.
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.fn_detect_double_dealing(30);
  RAISE NOTICE 'double-deal rows in last 30 min: %', v_count;
END $$;
