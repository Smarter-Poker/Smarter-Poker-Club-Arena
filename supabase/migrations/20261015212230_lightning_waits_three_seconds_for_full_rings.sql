-- 20261015212230_lightning_waits_three_seconds_for_full_rings.sql
-- Dan chose a three-second maximum on 2026-10-15. Fresh idle players wait
-- for full rings; the oldest legal idle player releases thin-pool sizing at
-- the deadline. No queue, blind, session, stack or money row is changed.
-- SQL m1 and its engine port must ship together and be A/A calibrated anew.
-- @live-proof: (SELECT pg_get_functiondef('public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure) LIKE '%fn_lightning_formation_sizes%' AND public.fn_lightning_formation_sizes(2,2,6,6,'2026-10-15 12:00:00+00','2026-10-15 12:00:02.999+00') = ARRAY[]::integer[] AND public.fn_lightning_formation_sizes(2,2,6,6,'2026-10-15 12:00:00+00','2026-10-15 12:00:03+00') = ARRAY[2] AND public.fn_lightning_formation_sizes(8,2,6,6,'2026-10-15 12:00:00+00','2026-10-15 12:00:00+00') = ARRAY[6])
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE FUNCTION public.fn_lightning_formation_sizes(
  p_legal integer, p_min integer, p_target integer, p_max integer,
  p_oldest_idle timestamptz, p_now timestamptz
) RETURNS integer[] LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_max integer := LEAST(GREATEST(coalesce(nullif(p_max,0),2),2),9);
  v_min integer := LEAST(GREATEST(coalesce(nullif(p_min,0),2),2),v_max);
  v_target integer := LEAST(GREATEST(coalesce(nullif(p_target,0),v_max),v_min),v_max);
BEGIN
  IF p_now - p_oldest_idle >= interval '3 seconds' THEN
    RETURN public.fn_lightning_group_sizes(p_legal,v_min,v_target,v_max);
  END IF;
  RETURN ARRAY(SELECT v_target FROM generate_series(1,GREATEST(coalesce(p_legal,0),0)/v_target));
END $fn$;
REVOKE ALL ON FUNCTION public.fn_lightning_formation_sizes(integer,integer,integer,integer,timestamptz,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_formation_sizes(integer,integer,integer,integer,timestamptz,timestamptz) TO authenticated, service_role;

-- Patch only the two P1 sizing calls. Refuse an unexpected source instead of
-- replacing the installed plan with an older copy of all its other rules.
DO $patch$
DECLARE
  v_oid regprocedure := 'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure;
  v_src text; v_old text; v_new text; v_array text;
BEGIN
  SELECT pg_get_functiondef(v_oid) INTO v_src;
  FOREACH v_array IN ARRAY ARRAY['v_seatable','v_next'] LOOP
    v_old := format('public.fn_lightning_group_sizes(cardinality(%s), v_min, v_target, v_max)',v_array);
    v_new := format('public.fn_lightning_formation_sizes(cardinality(%1$s), v_min, v_target, v_max, (SELECT min((v_info -> q.pid::text ->> ''idle_since'')::timestamptz) FROM unnest(%1$s) q(pid)), v_now)',v_array);
    IF (length(v_src)-length(replace(v_src,v_old,'')))/length(v_old) <> 1 THEN
      RAISE EXCEPTION 'Lightning fullness source mismatch for %',v_array;
    END IF;
    v_src := replace(v_src,v_old,v_new);
  END LOOP;
  EXECUTE v_src;
END $patch$;
COMMIT;
