CREATE OR REPLACE FUNCTION public.fn_mark_scope_accounting_settled(p_scope_kind text, p_scope_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE u_id uuid;c_id uuid;clubs uuid[];period public.settlement_periods%ROWTYPE;n int;club uuid;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_scope_kind IS NULL OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL
  OR p_from IS NULL OR p_to IS NULL OR p_from IS DISTINCT FROM public.fn_union_week_start(p_from)
  OR p_to IS DISTINCT FROM public.fn_union_week_start(p_from+interval '8 days') THEN
  RAISE EXCEPTION 'invalid_accounting_settled_scope' USING ERRCODE='22023'; END IF;
 u_id:=CASE WHEN p_scope_kind='union' THEN p_scope_id END;c_id:=CASE WHEN p_scope_kind='club' THEN p_scope_id END;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_scope_kind||'-accounting:'||p_scope_id::text||':'||extract(epoch FROM p_from)::text||':'||extract(epoch FROM p_to)::text,0));
 SELECT COALESCE(array_agg(w.club_id),ARRAY[]::uuid[]) INTO clubs FROM public.fn_accounting_week_clubs(u_id,c_id,p_from,p_to)w;
 -- EVERY PERIOD THE WEEK OPENED IS SETTLED WITH IT (2026-10-03). The square-up
 -- issuer opens a period for the union's own club row (clubs.id = union id),
 -- which fn_accounting_week_clubs leaves out, so nothing ever settled it.
 IF u_id IS NOT NULL THEN
  SELECT clubs||COALESCE(array_agg(DISTINCT sp.club_id),ARRAY[]::uuid[]) INTO clubs
    FROM public.settlement_periods sp
   WHERE sp.union_id=u_id AND sp.start_at=p_from AND sp.end_at=p_to
     AND sp.club_id IS NOT NULL AND NOT (sp.club_id=ANY(clubs));
  clubs:=array_append(clubs,NULL::uuid);
 END IF;
 FOREACH club IN ARRAY clubs LOOP
  SELECT count(*) INTO n FROM public.settlement_periods sp WHERE sp.club_id IS NOT DISTINCT FROM club
    AND sp.union_id IS NOT DISTINCT FROM u_id AND sp.start_at=p_from AND sp.end_at=p_to;
  IF n>1 THEN RAISE EXCEPTION 'accounting_week_has_duplicate_periods' USING ERRCODE='55000'; END IF;
  SELECT * INTO period FROM public.settlement_periods sp WHERE sp.club_id IS NOT DISTINCT FROM club
    AND sp.union_id IS NOT DISTINCT FROM u_id AND sp.start_at=p_from AND sp.end_at=p_to FOR UPDATE;
  IF NOT FOUND THEN
   INSERT INTO public.settlement_periods(club_id,union_id,period_number,year,start_at,end_at,status,settled_at,settled_by)
    VALUES(club,u_id,extract(week FROM p_from AT TIME ZONE 'America/Los_Angeles')::int,
     extract(isoyear FROM p_from AT TIME ZONE 'America/Los_Angeles')::int,p_from,p_to,'settled',now(),auth.uid());
  ELSIF period.status IS NULL OR period.status NOT IN('open','processing','settled','closed') THEN
   RAISE EXCEPTION 'accounting_week_period_state_requires_reconciliation' USING ERRCODE='55000';
  ELSIF period.status NOT IN('settled','closed') THEN
   UPDATE public.settlement_periods SET status='settled',settled_at=now(),settled_by=auth.uid(),updated_at=now() WHERE id=period.id;
  END IF;
 END LOOP;
END $function$
