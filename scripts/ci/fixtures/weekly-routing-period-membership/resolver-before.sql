CREATE OR REPLACE FUNCTION public.fn_resolve_accounting_routing_scope(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS TABLE(union_id uuid, standalone_club_id uuid, club_ids uuid[], scope_key text, lock_key text, routing_context text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 IF p_scope_kind IS NULL OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL
  OR (p_scope_kind='union' AND NOT EXISTS(SELECT 1 FROM public.unions u WHERE u.id=p_scope_id))
  OR (p_scope_kind='club' AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_scope_id))
 THEN RAISE EXCEPTION 'invalid_accounting_routing_scope' USING ERRCODE='22023';END IF;
 union_id:=CASE WHEN p_scope_kind='union' THEN p_scope_id END;
 standalone_club_id:=CASE WHEN p_scope_kind='club' THEN p_scope_id END;
 -- Preserve union keys and the established coordinator lock exactly. Club keys
 -- have an explicit prefix so even identical UUID values can never collide.
 scope_key:=CASE WHEN p_scope_kind='union' THEN p_scope_id::text ELSE 'club:'||p_scope_id::text END;
 lock_key:=CASE WHEN p_scope_kind='union' THEN 'union-accounting:' ELSE 'club-accounting:' END||p_scope_id::text||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 routing_context:=scope_key||':'||p_period_start::text||':'||p_period_end::text;
 -- Acquire before reading source-club membership: a waiting close must see all
 -- earning sources committed by the previous lock holder. Accrual shares this key.
 PERFORM pg_advisory_xact_lock(hashtextextended(lock_key,0));
 IF p_scope_kind='union' THEN
  club_ids:=ARRAY(SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=p_scope_id UNION
   SELECT rs.club_id FROM public.accounting_payable_earning_sources rs WHERE rs.coordinator_union_id=p_scope_id
    AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end ORDER BY club_id);
 ELSE club_ids:=ARRAY[p_scope_id];END IF;
 RETURN NEXT;
END $function$
