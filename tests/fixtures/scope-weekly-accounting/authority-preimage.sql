CREATE FUNCTION public.fn_accounting_tournament_week_quality(p_club_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE event record;scope_union uuid;actual_union uuid;related boolean;unknown_scope boolean;
 proof jsonb;active_ids uuid[];refunded_ids uuid[];checked int:=0;issue_count bigint;reason text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501';END IF;
 IF p_club_id IS NULL OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from>=p_to
 THEN RAISE EXCEPTION 'invalid_accounting_tournament_week' USING ERRCODE='22023';END IF;
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023';END IF;
 FOR event IN
  WITH candidates AS (
   SELECT tournament_id FROM public.accounting_tournament_fee_recognitions WHERE recognized_at>=p_from AND recognized_at<p_to
   UNION SELECT tournament_id FROM public.tournament_rake_settlements WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_terminal_settlements WHERE COALESCE(settled_at,completed_at)>=p_from AND COALESCE(settled_at,completed_at)<p_to
   UNION SELECT tournament_id FROM public.tournament_cancellation_receipts WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_satellite_settlements WHERE settled_at>=p_from AND settled_at<p_to
  )
  SELECT c.tournament_id,r.recognized_at,r.status,r.net_rake,r.union_id,r.bank_club_id,r.source_fingerprint,
   b.settled_at AS bank_at,b.amount AS bank_amount,b.union_id AS bank_union,b.club_id AS fee_bank_club
   FROM candidates c LEFT JOIN public.accounting_tournament_fee_recognitions r USING(tournament_id)
    LEFT JOIN public.tournament_rake_settlements b USING(tournament_id) ORDER BY c.tournament_id
 LOOP
  IF COALESCE(event.bank_at,event.recognized_at) IS NOT NULL
   AND NOT(COALESCE(event.bank_at,event.recognized_at)>=p_from AND COALESCE(event.bank_at,event.recognized_at)<p_to)
   AND (event.recognized_at IS NULL OR NOT(event.recognized_at>=p_from AND event.recognized_at<p_to)) THEN CONTINUE;END IF;
  actual_union:=COALESCE(event.union_id,event.bank_union,(SELECT min(s.union_id::text)::uuid
   FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
   HAVING count(DISTINCT COALESCE(s.union_id::text,'private'))=1));
  -- Current union membership only widens conflict detection. It never sets
  -- a payable source's historical coordinator or a player's payer.
  related:=COALESCE(actual_union=scope_union,false) OR COALESCE(event.bank_club_id=p_club_id,false)
   OR COALESCE(event.fee_bank_club=p_club_id,false)
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
      AND (s.club_id=p_club_id OR (scope_union IS NOT NULL AND s.coordinator_union_id=scope_union)))
   OR EXISTS(SELECT 1 FROM public.tournament_refund_entitlements e WHERE e.tournament_id=event.tournament_id AND e.refund_wallet_club_id=p_club_id);
  -- A private legacy event with unproved coordinator history cannot be silently
  -- assigned to today's standalone/union scope. The affected week stays open.
  unknown_scope:=actual_union IS NULL AND (event.status IS NULL OR event.status='banked_accrual_deferred')
   AND (COALESCE(event.net_rake,event.bank_amount,0)>0
    OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount<>0))
   AND (NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount>0)
    OR EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
     WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount>0
      AND (b.status IS DISTINCT FROM 'captured' OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
       OR r.rake_amount IS DISTINCT FROM(SELECT sum(s.rake_credit) FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id)))
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
     AND (NOT(s.contract ? 'coordinator_union_id') OR s.contract->'membership'->>'history_id' IS NULL
      OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text)));
  IF NOT related AND NOT unknown_scope THEN CONTINUE;END IF;
  checked:=checked+1;
  IF event.status IS NULL THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_terminal_recognition_missing','tournament_id',event.tournament_id,'unknown_scope',unknown_scope);
  END IF;
  IF event.status='banked_accrual_deferred' THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_deferred','tournament_id',event.tournament_id,'unknown_scope',unknown_scope);
  END IF;
  -- An eventual normal/satellite terminal receipt may follow a banked fee in
  -- another week. Only original fee-bank/recognition time chooses its liability.
  IF event.bank_at IS NOT NULL AND (event.bank_at IS DISTINCT FROM event.recognized_at
    OR event.bank_amount IS DISTINCT FROM event.net_rake OR event.bank_union IS DISTINCT FROM event.union_id) THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_bank_disagrees','tournament_id',event.tournament_id);
  END IF;
  BEGIN proof:=public.fn_accounting_tournament_fee_net_plan(event.tournament_id);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '55000' THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_net_source_evidence_invalid','detail',SQLERRM,'tournament_id',event.tournament_id);
  END;
  IF proof->>'status' IS DISTINCT FROM 'proven' OR proof->>'source_fingerprint' IS DISTINCT FROM event.source_fingerprint
    OR (proof->>'net_fee')::numeric IS DISTINCT FROM event.net_rake OR NULLIF(proof->>'union_id','')::uuid IS DISTINCT FROM event.union_id
    OR (event.status='recognized') IS DISTINCT FROM(event.net_rake>0)
    OR (event.status='cancelled') IS DISTINCT FROM(event.net_rake=0) THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_disagrees_with_sources','tournament_id',event.tournament_id);
  END IF;
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO active_ids FROM jsonb_array_elements_text(proof->'active_source_ids');
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO refunded_ids FROM jsonb_array_elements_text(proof->'refunded_source_ids');
  SELECT count(*) INTO issue_count FROM public.accounting_tournament_fee_sources s
   LEFT JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id
   WHERE s.tournament_id=event.tournament_id AND (rs.source_id IS NULL OR rs.tournament_id IS DISTINCT FROM s.tournament_id
    OR rs.recognized_at IS DISTINCT FROM event.recognized_at
    OR NOT(s.id=ANY(active_ids||refunded_ids))
    OR rs.disposition IS DISTINCT FROM CASE WHEN s.id=ANY(active_ids) THEN 'earned' ELSE 'refunded' END
    OR rs.rake_credit IS DISTINCT FROM CASE WHEN s.id=ANY(active_ids) THEN s.rake_credit ELSE 0 END
    OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text
    OR (s.contract->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit
    OR (s.contract->>'terms_at')::timestamptz IS DISTINCT FROM s.charged_at OR s.charged_at>event.recognized_at
    OR NULLIF(s.contract->>'union_id','')::uuid IS DISTINCT FROM s.union_id
    OR NULLIF(s.contract->>'coordinator_union_id','')::uuid IS DISTINCT FROM s.coordinator_union_id);
  IF issue_count>0 OR EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources rs
   LEFT JOIN public.accounting_tournament_fee_sources s ON s.id=rs.source_id
   WHERE rs.tournament_id=event.tournament_id AND (s.id IS NULL OR s.tournament_id IS DISTINCT FROM event.tournament_id))
   OR (SELECT COALESCE(sum(rake_credit),0) FROM public.accounting_tournament_recognized_sources WHERE tournament_id=event.tournament_id AND disposition='earned') IS DISTINCT FROM event.net_rake THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognized_source_receipts_incomplete','tournament_id',event.tournament_id);
  END IF;
 END LOOP;
 RETURN jsonb_build_object('status','ready','checked',checked);
END $function$;
CREATE OR REPLACE FUNCTION public.fn_resolve_accounting_routing_scope(p_scope_kind text,p_scope_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS TABLE(union_id uuid,standalone_club_id uuid,club_ids uuid[],scope_key text,lock_key text,routing_context text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
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
END $function$;
CREATE FUNCTION public.fn_accounting_week_clubs(p_union_id uuid,p_club_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(club_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to)
  OR p_to<=p_from THEN RAISE EXCEPTION 'invalid_accounting_scope' USING ERRCODE='22023'; END IF;
 IF p_club_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.is_union IS NOT TRUE) THEN
   RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT p_club_id;
 ELSE
  RETURN QUERY SELECT x.id FROM (
   SELECT uc.club_id id FROM public.union_clubs uc WHERE uc.union_id=p_union_id
   UNION SELECT s.club_id FROM public.accounting_cash_rake_sources s
    WHERE s.coordinator_union_id=p_union_id AND s.earned_at>=p_from AND s.earned_at<p_to
   UNION SELECT c.club_id FROM public.accounting_rakeback_period_calculations c
    WHERE c.coordinator_union_id=p_union_id AND c.period_start=(p_from AT TIME ZONE 'America/Los_Angeles')::date
     AND c.period_end=(p_to AT TIME ZONE 'America/Los_Angeles')::date-1
  )x WHERE x.id<>p_union_id ORDER BY x.id;
 END IF;
END $function$;
