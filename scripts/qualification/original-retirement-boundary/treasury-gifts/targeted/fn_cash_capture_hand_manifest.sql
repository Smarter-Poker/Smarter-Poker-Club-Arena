CREATE OR REPLACE FUNCTION public.fn_cash_capture_hand_manifest(p_table_id uuid, p_hand_number bigint, p_participants jsonb, p_instance_id text, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t public.tables%ROWTYPE; h public.clubs%ROWTYPE; s public.table_seats%ROWTYPE;
 prior public.cash_hand_participant_manifests%ROWTYPE;
 x jsonb; v_users uuid[]:=ARRAY[]::uuid[]; v_occupancies uuid[]:=ARRAY[]::uuid[];
 v_roster jsonb:='[]'; v_request jsonb; v_scope jsonb; v_issues jsonb:='[]';
 v_lineage jsonb; v_funding jsonb; v_initial integer; v_accounts integer; v_id uuid; v_user uuid;
 v_seat uuid; v_occupancy uuid; v_join timestamptz; v_before numeric; v_complete boolean:=true;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'Engine authority required' USING ERRCODE='42501'; END IF;
 IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number<1000000
 OR jsonb_typeof(p_participants) IS DISTINCT FROM 'array' OR jsonb_array_length(p_participants)<2
 OR jsonb_array_length(p_participants)>10 OR p_instance_id IS NULL OR p_lease_generation IS NULL THEN
  RAISE EXCEPTION 'Invalid original cash manifest' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.engine_table_leases l WHERE l.table_id=p_table_id
  AND l.instance_id=p_instance_id AND l.lease_generation=p_lease_generation AND l.protocol_version=2
  AND l.heartbeat_at>=clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original cash manifest lease stale' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(value ORDER BY value->>'user_id') INTO v_request FROM jsonb_array_elements(p_participants);
 SELECT * INTO prior FROM public.cash_hand_participant_manifests WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF FOUND THEN
  IF prior.request IS DISTINCT FROM v_request OR prior.lease_instance_id IS DISTINCT FROM p_instance_id
   OR prior.lease_generation IS DISTINCT FROM p_lease_generation THEN
   RAISE EXCEPTION 'Original cash manifest identity reused' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('version',1,'manifest_id',prior.id,'funding_provenance_complete',prior.funding_provenance_complete,'issues',prior.issues);
 END IF;
 SELECT * INTO STRICT t FROM public.tables WHERE id=p_table_id FOR SHARE;
 IF t.tournament_id IS NOT NULL THEN RAISE EXCEPTION 'Tournament chips are not cash provenance' USING ERRCODE='22023'; END IF;
 SELECT * INTO h FROM public.clubs WHERE id=t.club_id;
 v_scope:=jsonb_build_object('host_club_id',t.club_id,'game_union_id',CASE WHEN t.is_private THEN NULL ELSE t.union_id END,
  'is_private',t.is_private,'tournament_id',t.tournament_id,'asset',h.asset,'unit_scale',2);
 IF h.id IS NULL OR h.asset IS DISTINCT FROM 'chips' OR t.is_private IS NULL
  OR (NOT t.is_private AND t.union_id IS NULL) THEN
  v_issues:=v_issues||'"game_asset_or_union_scope_unproven"'::jsonb; v_complete:=false; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(v_request) LOOP
  v_user:=(x->>'user_id')::uuid; v_seat:=(x->>'seat_id')::uuid;
  v_occupancy:=(x->>'occupancy_id')::uuid; v_join:=(x->>'seat_joined_at')::timestamptz;
  v_before:=(x->>'stack_before')::numeric;
  IF v_user IS NULL OR v_seat IS NULL OR v_occupancy IS NULL OR v_join IS NULL
   OR NOT isfinite(v_join) OR v_user=ANY(v_users) OR v_occupancy=ANY(v_occupancies)
   OR jsonb_typeof(x->'is_horse') IS DISTINCT FROM 'boolean' OR jsonb_typeof(x->'stack_before') IS DISTINCT FROM 'number'
   OR v_before IS NULL OR v_before<0 OR v_before<>round(v_before,2)
   OR v_before::text IN ('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'Invalid or duplicate cash participant' USING ERRCODE='22023'; END IF;
  v_users:=array_append(v_users,v_user); v_occupancies:=array_append(v_occupancies,v_occupancy);
  SELECT * INTO s FROM public.table_seats WHERE id=v_seat AND table_id=p_table_id AND user_id=v_user
   AND occupancy_id=v_occupancy AND joined_at=v_join AND left_at IS NULL FOR SHARE;
  IF NOT FOUND OR s.stack IS DISTINCT FROM v_before THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_seat_or_starting_stack_unproven','user_id',v_user));
   v_complete:=false;
  END IF;
  v_lineage:=public.fn_cash_original_funding_lineage(v_user,p_table_id,v_seat,v_occupancy,v_join,clock_timestamp(),false);
  v_funding:=v_lineage->'funding_receipts';
  SELECT count(*) FILTER(WHERE f.operation_kind='buyin'),count(DISTINCT (f.funding_club_id,f.funding_union_id,f.asset))
   INTO v_initial,v_accounts FROM jsonb_array_elements(v_funding) ref
   JOIN public.cash_participant_funding_receipts f ON f.id=(ref->>'id')::uuid;
  IF v_lineage->'issues'<>'[]'::jsonb THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_cash_move_lineage_unproven','user_id',v_user,'details',v_lineage->'issues'));
   v_complete:=false;
  END IF;
  IF v_initial<>1 OR v_accounts<>1 THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason',CASE WHEN v_initial<>1 THEN 'original_admission_funding_missing' ELSE 'mixed_funding_account_ownership_unproven' END,'user_id',v_user));
   v_complete:=false;
  END IF;
  IF EXISTS(SELECT 1 FROM public.cash_participant_funding_receipts f
    LEFT JOIN public.cash_funding_application_receipts a ON a.funding_receipt_id=f.id
    WHERE f.id IN(SELECT (ref->>'id')::uuid FROM jsonb_array_elements(v_funding) ref) AND f.pending_addon_id IS NOT NULL
     AND (a.pending_addon_id IS NULL OR (a.applied>0 AND a.applied_occupancy_id IS DISTINCT FROM f.occupancy_id))) THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','pending_funding_application_unproven','user_id',v_user));
   v_complete:=false;
  END IF;
  v_roster:=v_roster||jsonb_build_array(jsonb_build_object('user_id',v_user,'seat_id',v_seat,
   'seat_joined_at',x->>'seat_joined_at','occupancy_id',v_occupancy,'stack_before',v_before,
   'is_horse',(x->>'is_horse')::boolean,'funding_receipts',v_funding,'funding_lineage',v_lineage));
 END LOOP;
 INSERT INTO public.cash_hand_participant_manifests(table_id,hand_number,lease_instance_id,lease_generation,
  request,game_scope,participants,issues,funding_provenance_complete)
 VALUES(p_table_id,p_hand_number,p_instance_id,p_lease_generation,v_request,v_scope,v_roster,v_issues,v_complete)
 RETURNING id INTO v_id;
 RETURN jsonb_build_object('version',1,'manifest_id',v_id,'funding_provenance_complete',v_complete,'issues',v_issues);
END $function$
