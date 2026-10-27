CREATE OR REPLACE FUNCTION public.fn_ca_launch_accounting_cutoff(p_kind text, p_id uuid) RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $function$ SELECT cutoff_at FROM public.ca_launch_accounting_boundaries WHERE scope_kind=p_kind AND scope_id=p_id AND undone_at IS NULL $function$;
CREATE OR REPLACE FUNCTION public.fn_ca_launch_accounting_accepts(p_club_id uuid, p_earned_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT CASE WHEN b.cutoff IS NULL THEN true ELSE p_earned_at IS NOT NULL AND isfinite(p_earned_at) AND p_earned_at>=b.cutoff END
 FROM (SELECT public.fn_ca_launch_accounting_cutoff('club',p_club_id) cutoff)b
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_club_rake_daily_user_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record;
BEGIN
  -- An UPDATE or DELETE recomputes the affected keys exactly rather than
  -- subtracting a delta: it is rare, and a recompute cannot drift.
  FOR r IN
    SELECT DISTINCT club_id, day, user_id FROM (
      SELECT o.club_id, (o.created_at AT TIME ZONE 'UTC')::date AS day, o.player_id AS user_id
        FROM old_rows o WHERE o.club_id IS NOT NULL AND o.player_id IS NOT NULL
      UNION
      SELECT n.club_id, (n.created_at AT TIME ZONE 'UTC')::date, n.player_id
        FROM new_rows n WHERE n.club_id IS NOT NULL AND n.player_id IS NOT NULL
    ) k
  LOOP
    PERFORM public.fn_ca_club_rake_daily_user_rebuild_day(r.club_id, r.day, r.user_id);
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ca_club_rake_daily_user change rollup failed: %', SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_user_rebuild_day(p_club_id uuid, p_day date, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_rows bigint := 0;
BEGIN
  IF p_club_id IS NULL OR p_day IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM public.ca_club_rake_daily_user d
   WHERE d.club_id = p_club_id AND d.day = p_day
     AND (p_user_id IS NULL OR d.user_id = p_user_id);

  INSERT INTO public.ca_club_rake_daily_user (club_id, day, user_id, rake_cents, hands, updated_at)
  SELECT ra.club_id,
         p_day,
         ra.player_id,
         SUM(round(ra.rake_amount * 100))::bigint,
         count(*)::bigint,
         now()
    FROM public.rake_attributions ra
   WHERE ra.club_id = p_club_id
     AND ra.created_at >= p_day::timestamptz
     AND ra.created_at <  (p_day + 1)::timestamptz
     AND ra.player_id IS NOT NULL
     AND ra.rake_amount > 0
     AND public.fn_ca_launch_accounting_accepts(ra.club_id,(SELECT rr.created_at FROM public.rake_records rr WHERE rr.id=ra.rake_record_id))
     AND (p_user_id IS NULL OR ra.player_id = p_user_id)
   GROUP BY 1, 3;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$

