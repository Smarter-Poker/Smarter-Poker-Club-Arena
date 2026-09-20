-- Exact parent coordinator scope and period-marking draft bodies.
CREATE OR REPLACE FUNCTION public.fn_accounting_week_clubs(p_union_id uuid,p_club_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(club_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_to<=p_from
 THEN RAISE EXCEPTION 'invalid_accounting_scope' USING ERRCODE='22023'; END IF;
 IF p_club_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.is_union IS NOT TRUE) THEN
   RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT p_club_id;
 ELSE
  RETURN QUERY WITH initial AS (
   SELECT DISTINCT ON(h.entity_key) h.after_terms FROM public.accounting_agreement_history h
    WHERE h.entity_type='union_clubs' AND h.observed_at<=p_from ORDER BY h.entity_key,h.observed_at DESC,h.id DESC
  ), members_during_week AS (
   SELECT after_terms FROM initial UNION ALL SELECT h.after_terms FROM public.accounting_agreement_history h
    WHERE h.entity_type='union_clubs' AND h.observed_at>p_from AND h.observed_at<p_to
  ) SELECT x.id FROM (
   SELECT (m.after_terms->>'club_id')::uuid AS id FROM members_during_week m WHERE m.after_terms->>'union_id'=p_union_id::text
   UNION SELECT s.club_id FROM public.accounting_payable_earning_sources s
    WHERE s.coordinator_union_id=p_union_id AND s.earned_at>=p_from AND s.earned_at<p_to
   UNION SELECT c.club_id FROM public.accounting_rakeback_period_calculations c
    WHERE c.coordinator_union_id=p_union_id AND c.period_start=(p_from AT TIME ZONE 'America/Los_Angeles')::date
     AND c.period_end=(p_to AT TIME ZONE 'America/Los_Angeles')::date-1
   UNION SELECT sp.club_id FROM public.settlement_periods sp WHERE sp.union_id=p_union_id AND sp.start_at=p_from AND sp.end_at=p_to
  )x WHERE x.id IS NOT NULL AND x.id<>p_union_id ORDER BY x.id;
 END IF;
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_mark_scope_accounting_settled(p_scope_kind text,p_scope_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
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
 IF u_id IS NOT NULL THEN clubs:=array_append(clubs,NULL::uuid); END IF;
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
  ELSIF period.status IS NULL OR period.status NOT IN('open','closing','settled','closed') THEN
   RAISE EXCEPTION 'accounting_week_period_state_requires_reconciliation' USING ERRCODE='55000';
  ELSIF period.status<>'settled' THEN
   UPDATE public.settlement_periods SET status='settled',settled_at=now(),settled_by=auth.uid(),updated_at=now() WHERE id=period.id;
  END IF;
 END LOOP;
END $function$;
REVOKE ALL ON FUNCTION public.fn_mark_scope_accounting_settled(text,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
