-- Native qualification fixture ONLY. Never a production migration.
DO $native$BEGIN IF (inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet AND NOT(inet_server_addr()IS NULL AND current_database()='original_source_refs' AND current_setting('port')='55931')) OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN RAISE EXCEPTION 'original_treasury_fixture_requires_isolated_loopback_PG17';END IF;END$native$;
SET timezone='UTC';CREATE SCHEMA IF NOT EXISTS smarter_private;
DO $baseline$BEGIN IF to_regprocedure('public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)')IS NULL THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.fn_horse_seat_from_treasury(p_table_id uuid, p_user_id uuid, p_seat_number integer, p_amount numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public'', ''pg_temp''
 SET statement_timeout TO ''30s''
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  v_request := jsonb_build_object(
    ''door'', ''fn_horse_seat_from_treasury'',
    ''table_id'', p_table_id,
    ''user_id'', p_user_id,
    ''seat_number'', p_seat_number,
    ''amount'', p_amount
  );
  v_response := public.fn_claim_entry_purchase_receipt(
    ''horse_funding'', p_op_id::text, v_request
  );
  IF NOT COALESCE((v_response->>''claimed'')::boolean, false) THEN
    RETURN v_response->''response'';
  END IF;

  IF p_op_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.chip_ledger l
     WHERE l.idempotency_key = ''horse_fund:'' || p_op_id::text
  ) THEN
    RAISE EXCEPTION
      ''IDEMPOTENCY_RECEIPT_UNBOUND: this historical horse key has no exact response receipt''
      USING ERRCODE = ''55000'';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    PERFORM public.fn_release_entry_purchase_claim(
      ''horse_funding'', p_op_id::text, v_request
    );
    RETURN jsonb_build_object(
      ''success'', false,
      ''deferred'', true,
      ''error'', ''PLATFORM_FROZEN: scheduled maintenance has deferred this horse seat''
    );
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  v_response := public.fn_horse_seat_from_treasury_before_maintenance_gate(
    p_table_id, p_user_id, p_seat_number, p_amount, p_op_id
  );
  IF NOT COALESCE((v_response->>''success'')::boolean, false) THEN
    PERFORM public.fn_release_entry_purchase_claim(
      ''horse_funding'', p_op_id::text, v_request
    );
    RETURN v_response;
  END IF;
  RETURN public.fn_record_entry_purchase_receipt(
    ''horse_funding'', p_op_id::text, v_request, v_response
  );
END;
$function$
';ELSIF md5(pg_get_functiondef(to_regprocedure('public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)')))IS DISTINCT FROM '4a7cee2cfecdf7a36446c169f754ccd0' THEN RAISE EXCEPTION 'original_treasury_baseline_source_collision:public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)';END IF;END$baseline$;
DO $baseline$BEGIN IF to_regprocedure('public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid)')IS NULL THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.fn_cash_record_original_funding(p_kind text, p_key text, p_user uuid, p_table uuid, p_ledger uuid, p_wallet uuid, p_club uuid, p_amount numeric, p_after numeric, p_pending uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public'', ''pg_temp''
AS $function$
DECLARE s public.table_seats%ROWTYPE; l public.chip_ledger%ROWTYPE;
 c public.clubs%ROWTYPE; v_id uuid;
BEGIN
 SELECT * INTO STRICT l FROM public.chip_ledger WHERE id=p_ledger;
 SELECT * INTO STRICT s FROM public.table_seats WHERE table_id=p_table AND user_id=p_user AND left_at IS NULL FOR SHARE;
 SELECT * INTO STRICT c FROM public.clubs WHERE id=p_club;
 IF s.occupancy_id IS NULL OR s.joined_at IS NULL
  OR c.asset IS DISTINCT FROM ''chips'' OR l.club_id IS DISTINCT FROM p_club
  OR l.amount IS DISTINCT FROM p_amount OR l.to_type IS DISTINCT FROM ''table_stack''
  OR l.to_entity_id IS DISTINCT FROM p_table OR l.category IS DISTINCT FROM p_kind
  OR l.from_type IS DISTINCT FROM (CASE WHEN p_kind=''horse_funding'' THEN ''club_treasury'' ELSE ''player_wallet'' END)
  OR l.from_entity_id IS DISTINCT FROM (CASE WHEN p_kind=''horse_funding'' THEN p_club ELSE p_user END)
 THEN RAISE EXCEPTION ''Original cash funding debit identity mismatch'' USING ERRCODE=''23514''; END IF;
 IF p_kind<>''horse_funding'' AND NOT EXISTS(SELECT 1 FROM public.wallet_transactions w
  WHERE w.id=p_wallet AND w.user_id=p_user AND w.table_id=p_table AND w.type=''debit''
    AND w.category=p_kind AND w.amount=p_amount AND w.balance_after=p_after) THEN
  RAISE EXCEPTION ''Original cash funding wallet journal mismatch'' USING ERRCODE=''23514'';
 END IF;
 INSERT INTO public.cash_participant_funding_receipts(operation_kind,operation_key,user_id,table_id,
  seat_id,occupancy_id,seat_joined_at,source_ledger_id,wallet_transaction_id,account_type,
  account_entity_id,funding_club_id,funding_union_id,asset,amount,balance_before,balance_after,pending_addon_id)
 VALUES(p_kind,p_key,p_user,p_table,s.id,s.occupancy_id,s.joined_at,l.id,p_wallet,l.from_type,
  l.from_entity_id,p_club,c.union_id,c.asset,p_amount,p_after+p_amount,p_after,p_pending) RETURNING id INTO v_id;
 RETURN v_id;
END $function$
';ELSIF md5(pg_get_functiondef(to_regprocedure('public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid)')))IS DISTINCT FROM '7ee6659572a38ef014952b4559f6167a' THEN RAISE EXCEPTION 'original_treasury_baseline_source_collision:public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid)';END IF;END$baseline$;
DO $baseline$BEGIN IF to_regprocedure('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)')IS NULL THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.fn_cash_original_funding_lineage(p_user uuid, p_table uuid, p_seat uuid, p_occupancy uuid, p_join timestamp with time zone, p_at timestamp with time zone, p_boundary boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''public'', ''pg_temp''
 SET "TimeZone" TO ''UTC''
AS $function$
DECLARE m public.cash_seat_move_receipts%ROWTYPE; f public.cash_participant_funding_receipts%ROWTYPE;
 l public.chip_ledger%ROWTYPE; a public.cash_funding_application_receipts%ROWTYPE;
 current_table uuid:=p_table; current_occupancy uuid:=p_occupancy;
 seen uuid[]:=ARRAY[]::uuid[]; ids uuid[]:=ARRAY[]::uuid[]; refs jsonb:=''[]''; moves jsonb:=''[]''; issues jsonb:=''[]'';
 cutoff timestamptz:=p_at; cutoff_transaction xid8; move_at timestamptz;
 move_club uuid; n integer; depth integer:=0;
BEGIN
 IF p_user IS NULL OR p_table IS NULL OR p_seat IS NULL OR p_occupancy IS NULL
  OR p_join IS NULL OR NOT isfinite(p_join) OR p_at IS NULL OR NOT isfinite(p_at) THEN
  RETURN jsonb_build_object(''version'',1,''observed_at'',p_at,''funding_receipts'',refs,''moves'',moves,''issues'',jsonb_build_array(''cash_lineage_identity_missing''));
 END IF;
 LOOP
  IF current_occupancy=ANY(seen) OR depth>64 THEN
   issues:=issues||''"cash_move_cycle_or_depth_unproven"''::jsonb; EXIT;
  END IF;
  seen:=array_append(seen,current_occupancy);
  FOR f IN SELECT r.* FROM public.cash_participant_funding_receipts r
   LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE r.occupancy_id=current_occupancy AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.recorded_at) ELSE r.recorded_at END)<p_at
    AND ((CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.recorded_at) ELSE r.recorded_at END)<=cutoff OR r.transaction_id=cutoff_transaction)
   ORDER BY r.recorded_at,r.id LOOP
   IF f.id=ANY(ids) OR f.user_id IS DISTINCT FROM p_user OR f.table_id IS DISTINCT FROM current_table
    OR (depth=0 AND (f.seat_id IS DISTINCT FROM p_seat OR f.seat_joined_at IS DISTINCT FROM p_join))
    OR (move_club IS NOT NULL AND f.funding_club_id IS DISTINCT FROM move_club)
    OR (f.account_type=''player_wallet'' AND f.account_entity_id IS DISTINCT FROM f.user_id)
    OR (f.account_type=''club_treasury'' AND f.account_entity_id IS DISTINCT FROM f.funding_club_id)
    OR f.asset IS DISTINCT FROM ''chips'' OR f.unit_scale<>2 OR NOT isfinite(f.recorded_at)
    OR f.amount<=0 OR f.amount<>round(f.amount,2) OR f.amount::text IN (''NaN'',''Infinity'',''-Infinity'')
    OR f.balance_before-f.balance_after IS DISTINCT FROM f.amount THEN
    issues:=issues||''"cash_lineage_funding_identity_invalid"''::jsonb;
   END IF;
   SELECT * INTO l FROM public.chip_ledger WHERE id=f.source_ledger_id;
   IF NOT FOUND OR l.status IS DISTINCT FROM ''posted'' OR l.club_id IS DISTINCT FROM f.funding_club_id
    OR l.from_type IS DISTINCT FROM f.account_type OR l.from_entity_id IS DISTINCT FROM f.account_entity_id
    OR l.to_type IS DISTINCT FROM ''table_stack'' OR l.to_entity_id IS DISTINCT FROM f.table_id
    OR l.category IS DISTINCT FROM f.operation_kind OR l.amount IS DISTINCT FROM f.amount THEN
    issues:=issues||''"cash_lineage_original_debit_invalid"''::jsonb;
   END IF;
   IF f.pending_addon_id IS NOT NULL AND NOT p_boundary THEN
    SELECT * INTO a FROM public.cash_funding_application_receipts WHERE funding_receipt_id=f.id;
    IF NOT FOUND OR a.original_occupancy_id IS DISTINCT FROM f.occupancy_id
     OR NOT isfinite(a.applied_at) OR a.applied+a.refunded IS DISTINCT FROM f.amount
     OR (a.applied>0 AND a.applied_occupancy_id IS DISTINCT FROM f.occupancy_id) THEN
     issues:=issues||''"pending_funding_application_unproven"''::jsonb;
    END IF;
   END IF;
   ids:=array_append(ids,f.id);
   refs:=refs||jsonb_build_array(jsonb_build_object(''id'',f.id,''account_type'',f.account_type,
    ''account_entity_id'',f.account_entity_id,''funding_club_id'',f.funding_club_id,''funding_union_id'',f.funding_union_id,
    ''pending_addon_id'',f.pending_addon_id));
  END LOOP;
  SELECT count(*) INTO n FROM public.cash_seat_move_receipts r LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE r.destination_occupancy_id=current_occupancy AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.created_at) ELSE r.created_at END)<p_at;
  IF n=0 THEN EXIT; END IF;
  IF n<>1 THEN issues:=issues||''"cash_move_destination_fork"''::jsonb; EXIT; END IF;
  SELECT r.* INTO m FROM public.cash_seat_move_receipts r LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE r.destination_occupancy_id=current_occupancy AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.created_at) ELSE r.created_at END)<p_at;
  SELECT observed_at INTO move_at FROM public.union_pnl_transaction_frames WHERE transaction_id=m.transaction_id;
  IF p_boundary AND (m.transaction_id IS NULL OR move_at IS NULL) THEN
   issues:=issues||''"cash_move_original_transaction_frame_missing"''::jsonb;
  END IF;
  IF m.player_id IS DISTINCT FROM p_user OR m.to_table_id IS DISTINCT FROM current_table
   OR m.source_occupancy_id=ANY(seen) OR m.from_table_id=m.to_table_id
   OR m.club_id IS NULL OR (move_club IS NOT NULL AND m.club_id IS DISTINCT FROM move_club)
   OR m.amount<=0 OR m.amount<>round(m.amount,2) OR m.amount::text IN (''NaN'',''Infinity'',''-Infinity'')
   OR NOT isfinite(m.created_at) OR (CASE WHEN p_boundary THEN COALESCE(move_at,m.created_at) ELSE m.created_at END)>cutoff
   OR (move_at IS NOT NULL AND (NOT isfinite(move_at) OR move_at>=p_at))
   OR jsonb_typeof(m.receipt) IS DISTINCT FROM ''object'' OR m.receipt->>''ok'' IS DISTINCT FROM ''true''
   OR m.receipt->>''move_id'' IS DISTINCT FROM m.move_id::text OR m.receipt->>''player_id'' IS DISTINCT FROM p_user::text
   OR m.receipt->>''from_table_id'' IS DISTINCT FROM m.from_table_id::text
   OR m.receipt->>''to_table_id'' IS DISTINCT FROM m.to_table_id::text
   OR m.receipt->>''source_seat_number'' IS DISTINCT FROM m.from_seat_number::text
   OR m.receipt->>''to_seat_number'' IS DISTINCT FROM m.to_seat_number::text
   OR m.receipt->>''source_occupancy_id'' IS DISTINCT FROM m.source_occupancy_id::text
   OR m.receipt->>''destination_occupancy_id'' IS DISTINCT FROM m.destination_occupancy_id::text
   OR public.fn_pnl_evidence_cents(m.receipt->''stack'') IS DISTINCT FROM m.amount
   OR m.receipt->>''idempotency_key'' IS DISTINCT FROM ''seatmove:''||m.move_id::text
   OR (SELECT count(*) FROM public.cash_seat_move_receipts r LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id WHERE r.source_occupancy_id=m.source_occupancy_id AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.created_at) ELSE r.created_at END)<p_at)<>1 THEN
   issues:=issues||''"cash_move_original_receipt_invalid"''::jsonb; EXIT;
  END IF;
  moves:=moves||jsonb_build_array(to_jsonb(m));
  move_club:=m.club_id; current_table:=m.from_table_id; current_occupancy:=m.source_occupancy_id;
  cutoff:=CASE WHEN p_boundary THEN COALESCE(move_at,m.created_at) ELSE m.created_at END; cutoff_transaction:=m.transaction_id; depth:=depth+1;
 END LOOP;
 -- Every retained source must agree with the exact custody club through all moves.
 IF move_club IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(refs) r WHERE r->>''funding_club_id'' IS DISTINCT FROM move_club::text) THEN
  issues:=issues||''"cash_move_original_funding_club_mismatch"''::jsonb;
 END IF;
 RETURN jsonb_build_object(''version'',1,''observed_at'',p_at,''funding_receipts'',refs,''moves'',moves,''issues'',issues);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
 RETURN jsonb_build_object(''version'',1,''observed_at'',p_at,''funding_receipts'',''[]''::jsonb,''moves'',moves,''issues'',jsonb_build_array(''cash_move_malformed_original_evidence''));
END $function$
';ELSIF md5(pg_get_functiondef(to_regprocedure('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)')))IS DISTINCT FROM 'bb74ae7693dc40b812fce685cfc3c294' THEN RAISE EXCEPTION 'original_treasury_baseline_source_collision:public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)';END IF;END$baseline$;
DO $baseline$BEGIN IF to_regprocedure('public.fn_pnl_cash_hand_evidence(uuid,bigint)')IS NULL THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.fn_pnl_cash_hand_evidence(p_table_id uuid, p_hand_number bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''public'', ''pg_temp''
AS $function$
DECLARE v_posthand_original jsonb; a public.hand_atomic_commits%ROWTYPE; v_live_atomic jsonb; p public.cash_hand_provenance_receipts%ROWTYPE;
 m public.cash_hand_participant_manifests%ROWTYPE; f public.cash_participant_funding_receipts%ROWTYPE;
 l public.chip_ledger%ROWTYPE; app public.cash_funding_application_receipts%ROWTYPE;
 v_lineage jsonb; v_lineage_at timestamptz; x jsonb; y jsonb; submitted jsonb; original jsonb; ref jsonb; v_request jsonb; v_stack_hand uuid; v_people jsonb:=''[]'';
 v_issues jsonb:=''[]''; v_seen uuid[]:=ARRAY[]::uuid[]; v_funding_seen uuid[];
 v_user uuid; v_club uuid; v_account jsonb; v_funding_account jsonb;
 v_before numeric; v_after numeric; v_delta numeric:=0; v_rake numeric; v_bbj numeric; v_inflow numeric;
 v_initial integer; v_owned boolean; v_population boolean:=false;
BEGIN
 v_posthand_original:=smarter_private.posthand_escrow_certified_evidence(p_table_id,p_hand_number);
 IF v_posthand_original IS NOT NULL THEN RETURN v_posthand_original;END IF;
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF NOT FOUND THEN RETURN jsonb_build_object(''status'',''blocked'',''basis_certified'',false,
  ''all_players_included'',false,''reason'',''original_cash_provenance_missing''); END IF;
 IF jsonb_typeof(p.atomic_receipt) IS DISTINCT FROM ''object''
  OR p.atomic_receipt->>''table_id'' IS DISTINCT FROM p_table_id::text
  OR p.atomic_receipt->>''hand_number'' IS DISTINCT FROM p_hand_number::text THEN
  RETURN jsonb_build_object(''status'',''blocked'',''basis_certified'',false,''all_players_included'',false,
   ''reason'',''retained_atomic_receipt_missing''); END IF;
 SELECT * INTO a FROM jsonb_populate_record(NULL::public.hand_atomic_commits,p.atomic_receipt);
 SELECT to_jsonb(live) INTO v_live_atomic FROM public.hand_atomic_commits live
  WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF FOUND AND NOT smarter_private.horse_cash_retained_atomic_matches(p_table_id,p_hand_number,p.atomic_receipt,v_live_atomic,p.accepted_request) THEN
  RETURN jsonb_build_object(''status'',''blocked'',''basis_certified'',false,''all_players_included'',false,
   ''reason'',''live_atomic_receipt_conflicts_with_original''); END IF;
 v_request:=a.stack_result->''request'';
 IF a.committed_at IS NULL OR NOT isfinite(a.committed_at)
  OR a.stack_result->''success'' IS DISTINCT FROM ''true''::jsonb
  OR a.stack_result->>''mode'' IS DISTINCT FROM ''delta''
  OR jsonb_typeof(v_request->''stacks'') IS DISTINCT FROM ''array''
  OR NOT a.stack_result ? ''tournament_id'' OR a.stack_result->''tournament_id'' IS DISTINCT FROM ''null''::jsonb THEN
  RETURN jsonb_build_object(''status'',''blocked'',''basis_certified'',false,''all_players_included'',false,
   ''reason'',''accepted_cash_delta_request_missing'');
 END IF;
 IF p.version<>1 OR p.hand_id IS DISTINCT FROM a.hand_id OR p.payload_hash IS DISTINCT FROM a.payload_hash
  OR p.accepted_at IS NULL OR NOT isfinite(p.accepted_at) OR p.accepted_at<a.committed_at
  OR jsonb_typeof(p.accepted_request) IS DISTINCT FROM ''object''
  OR p.accepted_request->>''table_id'' IS DISTINCT FROM p_table_id::text
  OR p.accepted_request->>''hand_number'' IS DISTINCT FROM p_hand_number::text
  OR NOT smarter_private.horse_cash_retained_request_matches(p_table_id,p_hand_number,a.payload_hash,p.accepted_request)
  OR jsonb_typeof(p.accepted_request->''stacks'') IS DISTINCT FROM ''array''
  OR p.manifest_id IS NULL OR jsonb_typeof(p.participants) IS DISTINCT FROM ''array''
  OR jsonb_typeof(p.issues) IS DISTINCT FROM ''array'' THEN
  RETURN jsonb_build_object(''status'',''blocked'',''basis_certified'',false,''all_players_included'',false,
   ''reason'',''accepted_cash_provenance_link_missing'');
 END IF;
 SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=p.manifest_id;
 IF NOT FOUND OR m.table_id IS DISTINCT FROM p_table_id OR m.hand_number IS DISTINCT FROM p_hand_number
  OR m.captured_at IS NULL OR NOT isfinite(m.captured_at) OR m.captured_at>p.accepted_at
  OR m.game_scope IS DISTINCT FROM p.game_scope OR jsonb_typeof(m.participants) IS DISTINCT FROM ''array''
  OR jsonb_array_length(m.participants)<>jsonb_array_length(p.participants)
  OR jsonb_array_length(p.participants)<>jsonb_array_length(v_request->''stacks'')
  OR jsonb_array_length(p.participants)<>jsonb_array_length(p.accepted_request->''stacks'')
  OR (SELECT count(DISTINCT value->>''user_id'') FROM jsonb_array_elements(v_request->''stacks''))<>jsonb_array_length(p.participants)
  OR (SELECT count(DISTINCT value->>''user_id'') FROM jsonb_array_elements(p.accepted_request->''stacks''))<>jsonb_array_length(p.participants)
  OR (SELECT count(DISTINCT value->>''user_id'') FROM jsonb_array_elements(m.participants))<>jsonb_array_length(p.participants)
  OR jsonb_array_length(p.participants)<2 OR jsonb_array_length(p.participants)>10
  OR p.all_players_included IS DISTINCT FROM true THEN
  RETURN jsonb_build_object(''status'',''blocked'',''basis_certified'',false,''all_players_included'',false,
   ''reason'',''original_cash_population_link_missing'');
 END IF;
 v_stack_hand:=(a.stack_result->>''hand_id'')::uuid;
 IF p.stack_claim->>''table_id'' IS DISTINCT FROM p_table_id::text
  OR p.stack_claim->>''hand_id'' IS DISTINCT FROM v_stack_hand::text
  OR p.stack_claim->>''status'' IS DISTINCT FROM ''succeeded''
  OR (p.stack_claim->>''completed_at'') IS NULL OR p.stack_claim->''result'' IS DISTINCT FROM a.stack_result
  OR p.stack_settlement->>''table_id'' IS DISTINCT FROM p_table_id::text
  OR p.stack_settlement->>''hand_id'' IS DISTINCT FROM v_stack_hand::text
  OR p.stack_settlement->>''settlement_type'' IS DISTINCT FROM ''hand_stacks''
  OR p.stack_settlement->>''state'' IS DISTINCT FROM ''final''
  OR EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k WHERE k.table_id=p_table_id AND k.hand_id=v_stack_hand
    AND (k.status IS DISTINCT FROM ''succeeded'' OR smarter_private.horse_settlement_original_result(k.table_id,k.hand_id,k.result) IS DISTINCT FROM a.stack_result OR k.completed_at IS NULL))
  OR EXISTS(SELECT 1 FROM public.ca_settlements c WHERE c.table_id=p_table_id AND c.hand_id=v_stack_hand
    AND c.settlement_type=''hand_stacks'' AND c.state IS DISTINCT FROM ''final'') THEN
  v_issues:=v_issues||''"accepted_stack_receipt_link_missing"''::jsonb;
 END IF;
 IF p.status IS DISTINCT FROM ''captured'' OR p.funding_provenance_complete IS DISTINCT FROM true
  OR m.funding_provenance_complete IS DISTINCT FROM true OR p.issues<>''[]''::jsonb OR m.issues<>''[]''::jsonb THEN
  v_issues:=v_issues||''"original_cash_funding_incomplete"''::jsonb||p.issues;
 END IF;
 IF jsonb_typeof(p.game_scope) IS DISTINCT FROM ''object''
  OR NOT p.game_scope ?& ARRAY[''host_club_id'',''game_union_id'',''is_private'',''tournament_id'',''asset'',''unit_scale'']
  OR p.game_scope->>''asset'' IS DISTINCT FROM ''chips'' OR p.game_scope->''unit_scale'' IS DISTINCT FROM ''2''::jsonb
  OR p.game_scope->''tournament_id'' IS DISTINCT FROM ''null''::jsonb
  OR jsonb_typeof(p.game_scope->''is_private'') IS DISTINCT FROM ''boolean''
  OR (p.game_scope->''is_private''=''true''::jsonb AND p.game_scope->''game_union_id'' IS DISTINCT FROM ''null''::jsonb)
  OR (p.game_scope->''is_private''=''false''::jsonb AND (p.game_scope->>''game_union_id'') IS NULL) THEN
  v_issues:=v_issues||''"historical_game_asset_and_union_receipt_invalid"''::jsonb;
 END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p.participants) LOOP
  v_user:=(x->>''user_id'')::uuid;
  SELECT value INTO y FROM jsonb_array_elements(v_request->''stacks'') WHERE value->>''user_id''=x->>''user_id'';
  SELECT value INTO submitted FROM jsonb_array_elements(p.accepted_request->''stacks'') WHERE value->>''user_id''=x->>''user_id'';
  SELECT value INTO original FROM jsonb_array_elements(m.participants) WHERE value->>''user_id''=x->>''user_id'';
  v_before:=public.fn_pnl_evidence_cents(x->''stack_before''); v_after:=public.fn_pnl_evidence_cents(x->''stack_after'');
  IF v_user IS NULL OR v_user=ANY(v_seen) OR y IS NULL OR original IS NULL
   OR submitted IS NULL OR original IS DISTINCT FROM (x-''stack_after''-''poker_delta'')
   OR v_before IS NULL OR v_after IS NULL OR v_before<0 OR v_after<0
   OR public.fn_pnl_evidence_cents(x->''poker_delta'') IS DISTINCT FROM v_after-v_before
   OR public.fn_pnl_evidence_cents(y->''stack_before'') IS DISTINCT FROM v_before
   OR public.fn_pnl_evidence_cents(y->''stack'') IS DISTINCT FROM v_after
   OR y->>''seat_id'' IS DISTINCT FROM x->>''seat_id''
   OR public.fn_pnl_evidence_cents(submitted->''stack_before'') IS DISTINCT FROM v_before
   OR public.fn_pnl_evidence_cents(submitted->''stack'') IS DISTINCT FROM v_after
   OR submitted->>''seat_id'' IS DISTINCT FROM x->>''seat_id''
   OR submitted->>''occupancy_id'' IS DISTINCT FROM x->>''occupancy_id''
   OR (submitted->>''seat_joined_at'')::timestamptz IS DISTINCT FROM (x->>''seat_joined_at'')::timestamptz
   OR (y->>''seat_joined_at'')::timestamptz IS DISTINCT FROM (x->>''seat_joined_at'')::timestamptz
   OR submitted->>''funding_manifest_id'' IS DISTINCT FROM p.manifest_id::text THEN
   RETURN jsonb_build_object(''status'',''blocked'',''basis_certified'',false,''all_players_included'',false,
    ''reason'',''original_cash_participant_mismatch'');
  END IF;
  v_seen:=array_append(v_seen,v_user); v_delta:=v_delta+v_after-v_before;
  v_owned:=true; v_initial:=0; v_club:=NULL; v_account:=NULL; v_funding_seen:=ARRAY[]::uuid[];
  v_lineage:=NULL;
  IF x ? ''funding_lineage'' THEN
   v_lineage_at:=(x#>>''{funding_lineage,observed_at}'')::timestamptz;
   IF v_lineage_at IS NULL OR NOT isfinite(v_lineage_at) OR v_lineage_at>m.captured_at THEN v_owned:=false; END IF;
   v_lineage:=public.fn_cash_original_funding_lineage(v_user,p_table_id,(x->>''seat_id'')::uuid,
    (x->>''occupancy_id'')::uuid,(x->>''seat_joined_at'')::timestamptz,v_lineage_at,false);
   IF v_lineage IS DISTINCT FROM x->''funding_lineage'' OR v_lineage->''issues''<>''[]''::jsonb
    OR v_lineage->''funding_receipts'' IS DISTINCT FROM x->''funding_receipts'' THEN v_owned:=false; END IF;
  END IF;
  IF jsonb_typeof(x->''funding_receipts'') IS DISTINCT FROM ''array''  OR x->''funding_receipts''=''[]''::jsonb THEN
   v_owned:=false;
  ELSE
   FOR ref IN SELECT value FROM jsonb_array_elements(x->''funding_receipts'') LOOP
    SELECT * INTO f FROM public.cash_participant_funding_receipts WHERE id=(ref->>''id'')::uuid;
    IF NOT FOUND THEN v_owned:=false; CONTINUE; END IF;
    IF f.id=ANY(v_funding_seen) THEN v_owned:=false; END IF;
    v_funding_seen:=array_append(v_funding_seen,f.id);
    v_funding_account:=jsonb_build_array(f.funding_club_id,f.funding_union_id,f.asset);
    IF v_account IS NULL THEN v_account:=v_funding_account; v_club:=f.funding_club_id;
    ELSIF v_account IS DISTINCT FROM v_funding_account THEN v_owned:=false; END IF;
    IF f.operation_kind=''buyin'' THEN v_initial:=v_initial+1; END IF;
    IF f.user_id IS DISTINCT FROM v_user OR (v_lineage IS NULL AND (f.table_id IS DISTINCT FROM p_table_id
     OR f.seat_id::text IS DISTINCT FROM x->>''seat_id'' OR f.occupancy_id::text IS DISTINCT FROM x->>''occupancy_id''
     OR f.seat_joined_at IS DISTINCT FROM (x->>''seat_joined_at'')::timestamptz))
     OR f.recorded_at>m.captured_at OR NOT isfinite(f.recorded_at) OR f.asset<>''chips'' OR f.unit_scale<>2
     OR f.account_type IS DISTINCT FROM ref->>''account_type''
     OR f.account_entity_id::text IS DISTINCT FROM ref->>''account_entity_id''
     OR f.funding_club_id::text IS DISTINCT FROM ref->>''funding_club_id''
     OR f.funding_union_id::text IS DISTINCT FROM ref->>''funding_union_id''
     OR f.pending_addon_id::text IS DISTINCT FROM ref->>''pending_addon_id''
     OR f.amount<=0 OR f.amount<>round(f.amount,2) OR f.amount::text IN (''NaN'',''Infinity'',''-Infinity'')
     OR f.balance_before-f.balance_after IS DISTINCT FROM f.amount THEN v_owned:=false; END IF;
    SELECT * INTO l FROM public.chip_ledger WHERE id=f.source_ledger_id;
    IF NOT FOUND OR l.status IS DISTINCT FROM ''posted'' OR l.club_id IS DISTINCT FROM f.funding_club_id
     OR l.from_type IS DISTINCT FROM f.account_type OR l.from_entity_id IS DISTINCT FROM f.account_entity_id
     OR l.to_type IS DISTINCT FROM ''table_stack'' OR l.to_entity_id IS DISTINCT FROM f.table_id
     OR l.category IS DISTINCT FROM f.operation_kind OR l.amount IS DISTINCT FROM f.amount THEN v_owned:=false; END IF;
    IF f.pending_addon_id IS NOT NULL THEN
     SELECT * INTO app FROM public.cash_funding_application_receipts WHERE pending_addon_id=f.pending_addon_id;
     IF NOT FOUND OR app.funding_receipt_id IS DISTINCT FROM f.id OR app.original_occupancy_id IS DISTINCT FROM f.occupancy_id
      OR NOT isfinite(app.applied_at) OR app.applied+app.refunded IS DISTINCT FROM f.amount
      OR (app.applied>0 AND app.applied_occupancy_id IS DISTINCT FROM f.occupancy_id) THEN v_owned:=false; END IF;
    END IF;
   END LOOP;
  END IF;
  IF v_initial<>1 THEN v_owned:=false; END IF;
  IF NOT v_owned THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object(''reason'',''participant_earning_ownership_receipt_invalid'',''user_id'',v_user)); END IF;
  v_people:=v_people||jsonb_build_array(jsonb_build_object(''user_id'',v_user,''is_horse'',x->''is_horse'',
   ''observed_stack_delta'',v_after-v_before,''earning_club_id'',CASE WHEN v_owned THEN v_club ELSE NULL END,
   ''ownership_certified'',v_owned,''ownership_scope'',''original_chip_funding_club'',''funding_receipt_ids'',to_jsonb(v_funding_seen)));
 END LOOP;
 v_population:=true;
 v_rake:=public.fn_pnl_evidence_cents(v_request->''rake''); v_bbj:=public.fn_pnl_evidence_cents(v_request->''bbj'');
 v_inflow:=public.fn_pnl_evidence_cents(v_request->''inflow'');
 IF v_request->''rake''=''null''::jsonb THEN v_rake:=0; END IF;
 IF v_request->''bbj''=''null''::jsonb THEN v_bbj:=0; END IF;
 IF v_request->''inflow''=''null''::jsonb THEN v_inflow:=0; END IF;
 IF v_rake IS NULL OR v_bbj IS NULL OR v_inflow IS NULL OR v_rake<0 OR v_bbj<0
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->''rake'',''null''::jsonb),''0''::jsonb)) IS DISTINCT FROM v_rake
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->''bbj'',''null''::jsonb),''0''::jsonb)) IS DISTINCT FROM v_bbj
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->''inflow'',''null''::jsonb),''0''::jsonb)) IS DISTINCT FROM v_inflow
  OR v_rake IS DISTINCT FROM p.rake OR v_bbj IS DISTINCT FROM p.bbj OR v_inflow IS DISTINCT FROM p.signed_external_net THEN
  v_issues:=v_issues||''"hand_conservation_inputs_missing"''::jsonb;
 ELSIF v_delta+v_rake+v_bbj<>v_inflow THEN v_issues:=v_issues||''"hand_delta_conservation_mismatch"''::jsonb;
 END IF;
 -- Signed insurance/external movements conserve but need their own bank linkage.
 IF v_inflow<>0 THEN v_issues:=v_issues||''"external_bank_receipt_not_certified"''::jsonb; END IF;
 RETURN jsonb_build_object(''status'',CASE WHEN v_issues=''[]''::jsonb THEN ''ready'' ELSE ''blocked'' END,
  ''basis_certified'',v_issues=''[]''::jsonb,''scope'',''single_accepted_cash_hand'',''payment_authorized'',false,
  ''hand_id'',a.hand_id,''table_id'',p_table_id,''hand_number'',p_hand_number,''observed_commit_at'',a.committed_at,
  ''observed_delta_total'',v_delta,''participants'',v_people,''issues'',v_issues,''game_scope'',p.game_scope,
  ''current_seats_used'',false,''current_membership_used'',false,''all_players_included'',v_population);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
 RETURN jsonb_build_object(''status'',''blocked'',''basis_certified'',false,''all_players_included'',false,''reason'',''malformed_original_cash_evidence'');
END $function$
';ELSIF md5(pg_get_functiondef(to_regprocedure('public.fn_pnl_cash_hand_evidence(uuid,bigint)')))IS DISTINCT FROM '865391e842ed009b45ec7727efe7e85b' THEN RAISE EXCEPTION 'original_treasury_baseline_source_collision:public.fn_pnl_cash_hand_evidence(uuid,bigint)';END IF;END$baseline$;
DO $baseline$BEGIN IF to_regprocedure('public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)')IS NULL THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.fn_cash_capture_hand_manifest(p_table_id uuid, p_hand_number bigint, p_participants jsonb, p_instance_id text, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public'', ''pg_temp''
AS $function$
DECLARE t public.tables%ROWTYPE; h public.clubs%ROWTYPE; s public.table_seats%ROWTYPE;
 prior public.cash_hand_participant_manifests%ROWTYPE;
 x jsonb; v_users uuid[]:=ARRAY[]::uuid[]; v_occupancies uuid[]:=ARRAY[]::uuid[];
 v_roster jsonb:=''[]''; v_request jsonb; v_scope jsonb; v_issues jsonb:=''[]'';
 v_lineage jsonb; v_funding jsonb; v_initial integer; v_accounts integer; v_id uuid; v_user uuid;
 v_seat uuid; v_occupancy uuid; v_join timestamptz; v_before numeric; v_complete boolean:=true;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION ''Engine authority required'' USING ERRCODE=''42501''; END IF;
 IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number<1000000
 OR jsonb_typeof(p_participants) IS DISTINCT FROM ''array'' OR jsonb_array_length(p_participants)<2
 OR jsonb_array_length(p_participants)>10 OR p_instance_id IS NULL OR p_lease_generation IS NULL THEN
  RAISE EXCEPTION ''Invalid original cash manifest'' USING ERRCODE=''22023''; END IF;
 PERFORM 1 FROM public.engine_table_leases l WHERE l.table_id=p_table_id
  AND l.instance_id=p_instance_id AND l.lease_generation=p_lease_generation AND l.protocol_version=2
  AND l.heartbeat_at>=clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION ''Original cash manifest lease stale'' USING ERRCODE=''55000''; END IF;
 SELECT jsonb_agg(value ORDER BY value->>''user_id'') INTO v_request FROM jsonb_array_elements(p_participants);
 SELECT * INTO prior FROM public.cash_hand_participant_manifests WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF FOUND THEN
  IF prior.request IS DISTINCT FROM v_request OR prior.lease_instance_id IS DISTINCT FROM p_instance_id
   OR prior.lease_generation IS DISTINCT FROM p_lease_generation THEN
   RAISE EXCEPTION ''Original cash manifest identity reused'' USING ERRCODE=''22023''; END IF;
  RETURN jsonb_build_object(''version'',1,''manifest_id'',prior.id,''funding_provenance_complete'',prior.funding_provenance_complete,''issues'',prior.issues);
 END IF;
 SELECT * INTO STRICT t FROM public.tables WHERE id=p_table_id FOR SHARE;
 IF t.tournament_id IS NOT NULL THEN RAISE EXCEPTION ''Tournament chips are not cash provenance'' USING ERRCODE=''22023''; END IF;
 SELECT * INTO h FROM public.clubs WHERE id=t.club_id;
 v_scope:=jsonb_build_object(''host_club_id'',t.club_id,''game_union_id'',CASE WHEN t.is_private THEN NULL ELSE t.union_id END,
  ''is_private'',t.is_private,''tournament_id'',t.tournament_id,''asset'',h.asset,''unit_scale'',2);
 IF h.id IS NULL OR h.asset IS DISTINCT FROM ''chips'' OR t.is_private IS NULL
  OR (NOT t.is_private AND t.union_id IS NULL) THEN
  v_issues:=v_issues||''"game_asset_or_union_scope_unproven"''::jsonb; v_complete:=false; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(v_request) LOOP
  v_user:=(x->>''user_id'')::uuid; v_seat:=(x->>''seat_id'')::uuid;
  v_occupancy:=(x->>''occupancy_id'')::uuid; v_join:=(x->>''seat_joined_at'')::timestamptz;
  v_before:=(x->>''stack_before'')::numeric;
  IF v_user IS NULL OR v_seat IS NULL OR v_occupancy IS NULL OR v_join IS NULL
   OR NOT isfinite(v_join) OR v_user=ANY(v_users) OR v_occupancy=ANY(v_occupancies)
   OR jsonb_typeof(x->''is_horse'') IS DISTINCT FROM ''boolean'' OR jsonb_typeof(x->''stack_before'') IS DISTINCT FROM ''number''
   OR v_before IS NULL OR v_before<0 OR v_before<>round(v_before,2)
   OR v_before::text IN (''NaN'',''Infinity'',''-Infinity'') THEN
   RAISE EXCEPTION ''Invalid or duplicate cash participant'' USING ERRCODE=''22023''; END IF;
  v_users:=array_append(v_users,v_user); v_occupancies:=array_append(v_occupancies,v_occupancy);
  SELECT * INTO s FROM public.table_seats WHERE id=v_seat AND table_id=p_table_id AND user_id=v_user
   AND occupancy_id=v_occupancy AND joined_at=v_join AND left_at IS NULL FOR SHARE;
  IF NOT FOUND OR s.stack IS DISTINCT FROM v_before THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object(''reason'',''original_seat_or_starting_stack_unproven'',''user_id'',v_user));
   v_complete:=false;
  END IF;
  v_lineage:=public.fn_cash_original_funding_lineage(v_user,p_table_id,v_seat,v_occupancy,v_join,clock_timestamp(),false);
  v_funding:=v_lineage->''funding_receipts'';
  SELECT count(*) FILTER(WHERE f.operation_kind=''buyin''),count(DISTINCT (f.funding_club_id,f.funding_union_id,f.asset))
   INTO v_initial,v_accounts FROM jsonb_array_elements(v_funding) ref
   JOIN public.cash_participant_funding_receipts f ON f.id=(ref->>''id'')::uuid;
  IF v_lineage->''issues''<>''[]''::jsonb THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object(''reason'',''original_cash_move_lineage_unproven'',''user_id'',v_user,''details'',v_lineage->''issues''));
   v_complete:=false;
  END IF;
  IF v_initial<>1 OR v_accounts<>1 THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object(''reason'',CASE WHEN v_initial<>1 THEN ''original_admission_funding_missing'' ELSE ''mixed_funding_account_ownership_unproven'' END,''user_id'',v_user));
   v_complete:=false;
  END IF;
  IF EXISTS(SELECT 1 FROM public.cash_participant_funding_receipts f
    LEFT JOIN public.cash_funding_application_receipts a ON a.funding_receipt_id=f.id
    WHERE f.id IN(SELECT (ref->>''id'')::uuid FROM jsonb_array_elements(v_funding) ref) AND f.pending_addon_id IS NOT NULL
     AND (a.pending_addon_id IS NULL OR (a.applied>0 AND a.applied_occupancy_id IS DISTINCT FROM f.occupancy_id))) THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object(''reason'',''pending_funding_application_unproven'',''user_id'',v_user));
   v_complete:=false;
  END IF;
  v_roster:=v_roster||jsonb_build_array(jsonb_build_object(''user_id'',v_user,''seat_id'',v_seat,
   ''seat_joined_at'',x->>''seat_joined_at'',''occupancy_id'',v_occupancy,''stack_before'',v_before,
   ''is_horse'',(x->>''is_horse'')::boolean,''funding_receipts'',v_funding,''funding_lineage'',v_lineage));
 END LOOP;
 INSERT INTO public.cash_hand_participant_manifests(table_id,hand_number,lease_instance_id,lease_generation,
  request,game_scope,participants,issues,funding_provenance_complete)
 VALUES(p_table_id,p_hand_number,p_instance_id,p_lease_generation,v_request,v_scope,v_roster,v_issues,v_complete)
 RETURNING id INTO v_id;
 RETURN jsonb_build_object(''version'',1,''manifest_id'',v_id,''funding_provenance_complete'',v_complete,''issues'',v_issues);
END $function$
';ELSIF md5(pg_get_functiondef(to_regprocedure('public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)')))IS DISTINCT FROM 'c2f77a64af658e91c4cf0e8d6ade6ee2' THEN RAISE EXCEPTION 'original_treasury_baseline_source_collision:public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)';END IF;END$baseline$;
DO $baseline$BEGIN IF to_regprocedure('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)')IS NULL THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.fn_cash_earning_club(p_hand_id uuid, p_table_id uuid, p_player_id uuid, p_source_club uuid, p_union_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE started timestamptz;clubs uuid[];chair uuid[];paid uuid[];
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION ''service_role_required'' USING ERRCODE=''42501''; END IF;
 IF p_hand_id IS NULL OR p_table_id IS NULL OR p_player_id IS NULL OR p_source_club IS NULL THEN
  RAISE EXCEPTION ''cash_earning_identity_missing'' USING ERRCODE=''23514''; END IF;
 SELECT h.started_at INTO started FROM public.hand_history h WHERE h.id=p_hand_id AND h.table_id=p_table_id;
 -- Original off-chair custody exists only in the accepted native hand''s
 -- transaction. Never derive ownership from today''s replacement chair.
 IF started IS NOT NULL AND isfinite(started) AND started<=transaction_timestamp() THEN
  SELECT array_agg(DISTINCT r.funding_club_id) INTO clubs
  FROM smarter_private.retired_cash_hand_custody r
  JOIN smarter_private.retired_cash_hand_qualification q USING(submission_id)
  JOIN smarter_private.hand_submissions s USING(submission_id)
  JOIN smarter_private.hand_submission_handoffs h USING(submission_id)
  JOIN public.hand_atomic_commits a ON a.hand_id=r.submission_id
   AND a.table_id=r.table_id AND a.hand_number=r.hand_number
  WHERE r.submission_id=p_hand_id AND r.table_id=p_table_id AND r.user_id=p_player_id
   AND r.state=''consumed'' AND r.transaction_id=txid_current()
   AND h.transaction_id=r.transaction_id AND h.request_hash=r.request_hash
   AND s.request_hash=r.request_hash AND q.request_hash=r.request_hash
   AND r.accepted_time_bank=r.original_time_bank AND r.settlement_id IS NOT NULL
   AND (q.table_id,q.hand_number)=(r.table_id,r.hand_number)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.expected->''participants'') e
    WHERE (e#>>''{stack,user_id}'')::uuid=r.user_id
     AND (e#>>''{stack,seat_id}'')::uuid=r.seat_id
     AND (e#>>''{stack,occupancy_id}'')::uuid=r.occupancy_id
     AND (e#>>''{stack,seat_joined_at}'')::timestamptz=r.seat_joined_at
     AND (e#>>''{stack,stack_before}'')::numeric=r.stack_before
     AND (e#>>''{stack,stack}'')::numeric=r.stack_after
     AND (e->>''funding_club_id'')::uuid=r.funding_club_id);
  IF cardinality(clubs)=1 AND clubs[1] IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN clubs[1]; END IF;
 END IF;
 -- Funding must exist by the persisted actual hand start. The logical formed_at
 -- supplied by the engine can precede the transaction that opens its slot.
 -- A pooled Lightning hand is funded by its original pool/cash session,
 -- not a physical chair at the synthetic host table. Anchor seats can be
 -- elsewhere or already gone by settlement; their session is retained.
 IF EXISTS(SELECT 1 FROM public.lightning_hand h
   WHERE h.hand_history_id=p_hand_id AND h.host_table_id=p_table_id) THEN
  IF started IS NULL OR NOT isfinite(started) OR started>transaction_timestamp() THEN
   RAISE EXCEPTION ''cash_hand_start_not_recorded'' USING ERRCODE=''23514''; END IF;
  -- The earning club is the club whose wallet funded the anchor chair, as
  -- for every Classic chair. cash_player_session.club_id is the TABLE''s club,
  -- which on a union-hosted game is the union itself, not the funding club.
  SELECT array_agg(DISTINCT s.club_id) FILTER (WHERE s.club_id IS NOT NULL),
         array_agg(DISTINCT r.funding_club_id) FILTER (WHERE r.funding_club_id IS NOT NULL),
         array_agg(DISTINCT cs.club_id)
    INTO chair, paid, clubs
   FROM public.lightning_hand h
   JOIN public.lightning_hand_player hp ON hp.hand_id=h.hand_id
    AND hp.player_id=p_player_id AND hp.cluster_id=h.cluster_id AND hp.cluster_epoch=h.cluster_epoch
   JOIN public.lightning_pool_slot sl ON sl.id=hp.pool_slot_id AND sl.player_id=hp.player_id
    AND sl.cluster_id=h.cluster_id AND sl.cluster_epoch=h.cluster_epoch
   JOIN public.lightning_pool_session ps ON ps.id=sl.pool_session_id AND ps.player_id=hp.player_id
    AND ps.cluster_id=h.cluster_id AND ps.cluster_epoch=h.cluster_epoch
   JOIN public.cash_player_session cs ON cs.id=ps.cash_player_session_id AND cs.player_id=hp.player_id
   LEFT JOIN public.table_seats s ON s.id=ps.anchor_seat_id AND s.user_id=hp.player_id
    AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started)
   -- A chair row can be gone by settlement; its buy-in receipt is immutable.
   LEFT JOIN LATERAL (
    SELECT f.funding_club_id FROM public.cash_participant_funding_receipts f
     WHERE f.operation_kind=''buyin'' AND f.table_id=cs.table_id AND f.account_entity_id=hp.player_id
      AND f.user_id=hp.player_id AND f.seat_id=ps.anchor_seat_id
      AND f.seat_joined_at<=ps.entered_at AND f.recorded_at<=started
     ORDER BY f.seat_joined_at DESC, f.recorded_at DESC, f.id DESC LIMIT 1) r ON true
   WHERE h.hand_history_id=p_hand_id AND h.host_table_id=p_table_id
    AND h.formed_at<=started AND ps.entered_at<=started AND sl.opened_at<=started
    AND cs.opened_at<=started
    AND (ps.exited_at IS NULL OR ps.exited_at>started)
    AND (sl.closed_at IS NULL OR sl.closed_at>started)
    AND (cs.closed_at IS NULL OR cs.closed_at>started);
  IF cardinality(chair)=1
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=chair[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN chair[1]; END IF;
  IF chair IS NULL AND cardinality(paid)=1
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=paid[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN paid[1]; END IF;
  -- No unambiguous funding chair: the original session reader, unchanged.
  IF cardinality(clubs)=1 AND clubs[1] IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN clubs[1]; END IF;
  IF p_union_id IS NOT NULL THEN
   RAISE EXCEPTION ''cash_earning_seat_provenance_missing_or_ambiguous'' USING ERRCODE=''23514''; END IF;
  RETURN NULL;
 END IF;
 IF p_union_id IS NULL THEN
  -- Private games may admit a seat funded by another club. Preserve the
  -- actual club at the hand''s start; the host only identifies the bank route.
  -- This reader runs before banking an already accepted hand. Unknown seat
  -- evidence must therefore stay NULL, not abort its bank obligation or invent
  -- host ownership. The existing source worker durably refuses that NULL or
  -- an unsupported cross-club liability after the exact bank receipt exists.
  IF started IS NULL OR NOT isfinite(started) OR started>transaction_timestamp() THEN RETURN NULL; END IF;
  SELECT array_agg(DISTINCT s.club_id) INTO clubs FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.user_id=p_player_id
    AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started);
  -- An overlapping unknown-club seat also makes the evidence ambiguous.
  IF cardinality(clubs) IS DISTINCT FROM 1 OR clubs[1] IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1] AND c.is_union IS NOT TRUE)
  THEN RETURN NULL; END IF;
  RETURN clubs[1];
 END IF;
 -- Preserve the existing shared-union validation and failure contract.
 IF started IS NULL OR started>transaction_timestamp() THEN RAISE EXCEPTION ''cash_hand_start_not_recorded'' USING ERRCODE=''23514''; END IF;
 SELECT array_agg(DISTINCT s.club_id) INTO clubs FROM public.table_seats s
  WHERE s.table_id=p_table_id AND s.user_id=p_player_id AND s.club_id IS NOT NULL
   AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started);
 IF cardinality(clubs) IS DISTINCT FROM 1
  OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
   AND (c.is_union IS NOT TRUE OR c.id=p_union_id OR c.union_id=p_union_id))
 THEN RAISE EXCEPTION ''cash_earning_seat_provenance_missing_or_ambiguous'' USING ERRCODE=''23514''; END IF;
 RETURN clubs[1];
END $function$
';ELSIF md5(pg_get_functiondef(to_regprocedure('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)')))IS DISTINCT FROM 'b1c21e14021e0e2e7bba28048dcec90e' THEN RAISE EXCEPTION 'original_treasury_baseline_source_collision:public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)';END IF;END$baseline$;
DO $baseline$BEGIN IF to_regprocedure('public.fn_ca_cash_seat_club(uuid,uuid)')IS NULL THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.fn_ca_cash_seat_club(p_table uuid, p_user uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
  SELECT COALESCE(
    (SELECT s.club_id FROM public.table_seats s
      WHERE s.table_id = p_table AND s.user_id = p_user AND s.left_at IS NULL
        AND s.club_id IS NOT NULL LIMIT 1),
    (SELECT x.funding_club_id FROM public.cash_participant_funding_receipts x
      WHERE x.operation_kind = ''buyin'' AND x.table_id = p_table AND x.account_entity_id = p_user
      ORDER BY x.seat_joined_at DESC NULLS LAST LIMIT 1));
$function$
';ELSIF md5(pg_get_functiondef(to_regprocedure('public.fn_ca_cash_seat_club(uuid,uuid)')))IS DISTINCT FROM 'b2a3de2d916158c859ea41cad150d653' THEN RAISE EXCEPTION 'original_treasury_baseline_source_collision:public.fn_ca_cash_seat_club(uuid,uuid)';END IF;END$baseline$;
DO $baseline$BEGIN IF to_regprocedure('public.fn_union_pnl_boundary(uuid,timestamptz)')IS NULL THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.fn_union_pnl_boundary(p_union_id uuid, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public'', ''pg_temp''
AS $function$
DECLARE inv jsonb; holdings jsonb:=''[]''; issues jsonb:=''[]''; s jsonb; t jsonb; f record; tr record;
 lineage jsonb; owned uuid; owners int; initial int; value numeric; entries int; first_op text;
 nonchips boolean; changed boolean; returned numeric; res_club uuid; res_amount numeric; v_proj boolean;
 seat_rows int; seat_value numeric; seat_club uuid; seat_credits int; original_receivables jsonb;
BEGIN
 inv:=public.fn_union_pnl_inventory_as_of_admitted(p_at);
 IF inv->>''status'' IS DISTINCT FROM ''observed'' THEN RETURN jsonb_build_object(''status'',''blocked'',''inventory'',inv,''holdings'',holdings); END IF;
 FOR s IN SELECT x->''row'' FROM jsonb_array_elements(COALESCE(inv#>''{population,table_seats}'',''[]'')) x
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>''{population,tables}'',''[]'')) y
   WHERE y#>>''{row,id}''=x#>>''{row,table_id}'' AND y#>>''{row,union_id}''=p_union_id::text) LOOP
  lineage:=public.fn_cash_original_funding_lineage((s->>''user_id'')::uuid,(s->>''table_id'')::uuid,
   (s->>''id'')::uuid,(s->>''occupancy_id'')::uuid,(s->>''joined_at'')::timestamptz,p_at,true);
  SELECT count(*) FILTER(WHERE r.operation_kind=''buyin''),count(DISTINCT (r.funding_club_id,r.funding_union_id,r.asset)),min(r.funding_club_id::text)::uuid
   INTO initial,owners,owned FROM jsonb_array_elements(lineage->''funding_receipts'') ref
   JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>''id'')::uuid;
  value:=public.fn_pnl_evidence_cents(s->''stack'');
  IF lineage->''issues''<>''[]''::jsonb OR initial<>1 OR owners<>1 OR owned IS NULL OR value IS NULL OR value<0 THEN
   issues:=issues||jsonb_build_array(jsonb_build_object(''reason'',''cash_boundary_original_funding_missing_or_ambiguous'',''seat_id'',s->''id''));
  ELSE
   holdings:=holdings||jsonb_build_array(jsonb_build_object(''club_id'',owned,''user_id'',s->''user_id'',''amount'',value,''kind'',''cash_stack'',''source_id'',s->''id''));
  END IF;
 END LOOP;
 -- Money awaiting the original add-on application is still held for its
 -- original funding account. It must not appear as a poker loss at midnight.
 FOR f IN
  SELECT r.*,r.amount-CASE WHEN COALESCE(af.observed_at,a.applied_at)<p_at THEN a.applied+a.refunded ELSE 0 END AS held
  FROM public.cash_participant_funding_receipts r
  LEFT JOIN public.cash_funding_application_receipts a ON a.funding_receipt_id=r.id
  LEFT JOIN public.union_pnl_transaction_frames rf ON rf.transaction_id=r.transaction_id
  LEFT JOIN public.union_pnl_transaction_frames af ON af.transaction_id=a.transaction_id
  WHERE r.pending_addon_id IS NOT NULL AND COALESCE(rf.observed_at,r.recorded_at)<p_at
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>''{population,tables}'',''[]'')) y
    WHERE y#>>''{row,id}''=r.table_id::text AND y#>>''{row,union_id}''=p_union_id::text)
 LOOP
  IF f.held<0 OR f.funding_club_id IS NULL THEN
   issues:=issues||jsonb_build_array(jsonb_build_object(''reason'',''pending_funding_boundary_invalid'',''source_id'',f.id));
  ELSIF f.held>0 THEN
   holdings:=holdings||jsonb_build_array(jsonb_build_object(''club_id'',f.funding_club_id,''user_id'',f.user_id,''amount'',f.held,''kind'',''pending_cash_funding'',''source_id'',f.id));
  END IF;
 END LOOP;
 -- Preserve the established realized-settlement rule: original gross entry
 -- less money already returned is deferred while a tournament remains open.
 -- This is not market value, ICM, or a new allocation of the prize pool.
 -- First inventory operations come from union_pnl_inventory_touches once its
 -- backfill is complete (20260929044303), else from the wide events.
 v_proj:=public.fn_union_pnl_projection_ready(''inventory_touches'');
 FOR t IN SELECT x->''row'' FROM jsonb_array_elements(COALESCE(inv#>''{population,tournaments}'',''[]'')) x
  WHERE x#>>''{row,union_id}''=p_union_id::text LOOP
  first_op:=public.fn_union_pnl_first_inventory_operation(''tournaments'',(t->>''id'')::uuid,v_proj);
  -- A tournament captured as the baseline (it existed before the original
  -- inventory capture) is read only when every registration of its original
  -- population carries a valid opening resolution for this boundary
  -- (union_pnl_opening_registration_resolutions: its entry re-proved from the
  -- posted chip ledger, bound to these exact population rows). Otherwise it is
  -- refused exactly as before.
  IF first_op IS DISTINCT FROM ''INSERT'' AND (first_op IS DISTINCT FROM ''baseline'' OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>''{population,tournament_players}'',''[]'')) y(x)
    WHERE y.x#>>''{row,tournament_id}''=t->>''id''
     AND public.fn_union_pnl_first_inventory_operation(''tournament_players'',(y.x#>>''{row,id}'')::uuid,v_proj) IS DISTINCT FROM ''INSERT''
     AND NOT EXISTS(SELECT 1 FROM public.fn_union_pnl_opening_registration_resolution(p_union_id,p_at,t,y.x->''row'')))) THEN
   issues:=issues||jsonb_build_array(jsonb_build_object(''reason'',''open_tournament_precedes_original_population'',''tournament_id'',t->''id'')); CONTINUE;
  END IF;
  -- One set-based read per open tournament (it was four queries per seat,
  -- two of them full scans of every tournament credit): the same original
  -- entry, instrument, owner-change and returned-credit facts, per
  -- registration, in the population''s order.
  FOR s,entries,owners,owned,value,nonchips,changed,returned,res_club,res_amount IN
   WITH players AS MATERIALIZED (
    SELECT y.x->''row'' s,y.o ord,(y.x#>>''{row,id}'')::uuid registration_id,(y.x#>>''{row,user_id}'')::uuid user_id
    FROM jsonb_array_elements(COALESCE(inv#>''{population,tournament_players}'',''[]'')) WITH ORDINALITY y(x,o)
    WHERE y.x#>>''{row,tournament_id}''=t->>''id''
   ), credits AS MATERIALIZED (
    -- fn_union_pnl_tournament_returns(t,NULL,NULL,p_at): every credit of this
    -- tournament observed before the boundary; the registration filter that
    -- function applied per call is applied per player below.
    SELECT c.user_id,c.credited_club_id,c.amount,c.entry_receipt_ids,true same_tournament
    FROM public.tournament_accounting_credit_receipts c
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
    WHERE c.tournament_id=(t->>''id'')::uuid AND b.observed_at<p_at
    UNION ALL
    SELECT r2.user_id,r2.source_wallet_club_id,r2.amount_paid_now,ARRAY[r.id],false
    FROM public.tournament_refund_tranches r2
    JOIN public.tournament_participant_funding_receipts r ON r.entitlement_id=r2.entitlement_id
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r2.transaction_id
    WHERE r2.tournament_id=(t->>''id'')::uuid AND b.observed_at<p_at
     AND NOT EXISTS(SELECT 1 FROM public.tournament_accounting_credit_receipts c WHERE c.ledger_id=r2.credit_ledger_id)
   ) SELECT p.s,e.entries,e.owners,e.owned,e.value,
    EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.tournament_id=(t->>''id'')::uuid AND r.registration_id=p.registration_id AND r.asset<>''chips''),
    k.changed,k.returned,rr.owning_club_id,rr.deferred_amount
   FROM players p
   CROSS JOIN LATERAL (SELECT count(*) entries,count(DISTINCT public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot)) owners,
     min(public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot)::text)::uuid owned,sum(r.amount) value
    FROM public.tournament_participant_funding_receipts r
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
    WHERE r.tournament_id=(t->>''id'')::uuid AND r.registration_id=p.registration_id AND b.observed_at<p_at AND r.asset=''chips'') e
   CROSS JOIN LATERAL (SELECT COALESCE(bool_or(c.credited_club_id<>e.owned),false) changed,sum(c.amount) returned
    FROM credits c WHERE c.user_id=p.user_id
     AND EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r
      WHERE r.registration_id=p.registration_id AND r.id=ANY(c.entry_receipt_ids)
       AND (NOT c.same_tournament OR r.tournament_id=(t->>''id'')::uuid))) k
   LEFT JOIN LATERAL (SELECT q.owning_club_id,q.deferred_amount
    FROM public.fn_union_pnl_opening_registration_resolution(p_union_id,p_at,t,p.s) q WHERE first_op=''baseline'') rr ON true
   ORDER BY p.ord
  LOOP
   -- In a baseline tournament a resolved registration is carried at its
   -- re-proved original entry less its returns before the boundary.
   IF res_club IS NOT NULL THEN
    holdings:=holdings||jsonb_build_array(jsonb_build_object(''club_id'',res_club,''user_id'',s->''user_id'',''amount'',res_amount,
     ''kind'',''deferred_tournament_result'',''source_id'',s->''id'',''basis'',''opening_registration_resolution''));
    CONTINUE;
   END IF;
   -- A satellite-won seat (20261007001000) has no entry receipt: it was
   -- never charged to a wallet. It is held at the value its one funding row
   -- moved into this prize liability, for the club that funded the seat.
   IF entries=0 AND NOT nonchips AND s->>''source_satellite_id'' IS NOT NULL THEN
    SELECT count(*),sum(l.amount) INTO seat_rows,seat_value FROM public.chip_ledger l
     WHERE l.status=''posted'' AND l.row_hash IS NOT NULL AND l.created_at<p_at
      AND l.to_type=''prize_liability'' AND l.to_entity_id=(t->>''id'')::uuid
      AND l.metadata->>''registration_id''=s->>''id'' AND l.metadata->>''user_id''=s->>''user_id''
      AND ((l.category=''tournament_buyin'' AND l.from_type=''prize_liability'' AND l.from_entity_id=(s->>''source_satellite_id'')::uuid
        AND l.metadata->>''kind''=''satellite_seat_pool_transfer'')
       OR (l.category=''ticket_redeem'' AND l.from_type=''escrow'' AND l.metadata->>''kind''=''tournament_entry_ticket_admission''
        AND l.metadata->>''source_satellite_id''=s->>''source_satellite_id''));
    seat_club:=public.fn_union_pnl_satellite_seat_owner((s->>''id'')::uuid,(t->>''id'')::uuid);
    SELECT (SELECT count(*) FROM public.tournament_accounting_credit_receipts c
      JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
      WHERE c.tournament_id=(t->>''id'')::uuid AND c.user_id::text=s->>''user_id'' AND b.observed_at<p_at)
     +(SELECT count(*) FROM public.tournament_refund_tranches r2
      JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r2.transaction_id
      WHERE r2.tournament_id=(t->>''id'')::uuid AND r2.user_id::text=s->>''user_id'' AND b.observed_at<p_at)
     INTO seat_credits;
    IF seat_rows=1 AND seat_value>0 AND seat_club IS NOT NULL AND seat_credits=0 THEN
     holdings:=holdings||jsonb_build_array(jsonb_build_object(''club_id'',seat_club,''user_id'',s->''user_id'',''amount'',seat_value,
      ''kind'',''deferred_tournament_result'',''source_id'',s->''id'',''basis'',''satellite_seat''));
     CONTINUE;
    END IF;
   END IF;
   IF entries=0 OR owners<>1 OR owned IS NULL OR nonchips THEN
    issues:=issues||jsonb_build_array(jsonb_build_object(''reason'',''open_tournament_original_instrument_or_earning_club_missing'',''registration_id'',s->''id'')); CONTINUE;
   END IF;
   IF changed THEN
    issues:=issues||jsonb_build_array(jsonb_build_object(''reason'',''open_tournament_credit_owner_changed'',''registration_id'',s->''id'')); CONTINUE;
   END IF;
   value:=value-COALESCE(returned,0);
   holdings:=holdings||jsonb_build_array(jsonb_build_object(''club_id'',owned,''user_id'',s->''user_id'',''amount'',value,''kind'',''deferred_tournament_result'',''source_id'',s->''id''));
  END LOOP;
 END LOOP;
 IF p_union_id=''fade0000-0000-0000-0000-000000000001''::uuid AND p_at>=''2026-10-12 07:00:00Z''::timestamptz THEN
  original_receivables:=smarter_private.original_erased_cash_receivables(p_union_id,p_at);
  IF original_receivables->>''status'' IS DISTINCT FROM ''ready'' THEN
   issues:=issues||jsonb_build_array(jsonb_build_object(''reason'',''original_erased_receivable_unproven'',''evidence'',original_receivables));
  ELSE
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(holdings) existing JOIN jsonb_array_elements(original_receivables->''holdings'') owed
    ON existing->>''source_id''=owed->>''source_id'') THEN
    issues:=issues||jsonb_build_array(jsonb_build_object(''reason'',''original_erased_receivable_double_count_refused''));
   ELSE holdings:=holdings||(original_receivables->''holdings'');END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object(''status'',CASE WHEN issues=''[]''::jsonb THEN ''ready'' ELSE ''blocked'' END,''boundary'',p_at,
  ''inventory'',inv,''holdings'',holdings,''issues'',issues,''tournament_basis'',''original_realized_settlement_deferred_while_open'');
END $function$
';ELSIF md5(pg_get_functiondef(to_regprocedure('public.fn_union_pnl_boundary(uuid,timestamptz)')))IS DISTINCT FROM 'f3fc54538eb2c19a049c79ce77bfb705' THEN RAISE EXCEPTION 'original_treasury_baseline_source_collision:public.fn_union_pnl_boundary(uuid,timestamptz)';END IF;END$baseline$;
DO $baseline$BEGIN IF to_regprocedure('smarter_private.original_inventory_basis_generation()')IS NULL THEN EXECUTE 'CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''pg_catalog'', ''public'', ''smarter_private''
 SET "TimeZone" TO ''UTC''
AS $function$
DECLARE r jsonb; receipt jsonb; c record; proofs text;source_hash text;source_count bigint;discharges jsonb:=''[]'';
BEGIN
 IF (SELECT count(*) FROM smarter_private.original_inventory_restoration_cases) IS DISTINCT FROM 245::bigint
 OR (SELECT count(*) FROM smarter_private.original_inventory_restoration_certificates WHERE boundary=''2026-10-12 07:00:00Z'') IS DISTINCT FROM 245::bigint
 OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RETURN NULL;END IF;
 -- Deduplicate shared original authorities; no 4x family source scan.
 FOR r IN SELECT DISTINCT x FROM smarter_private.original_inventory_restoration_cases k CROSS JOIN LATERAL jsonb_array_elements(k.source_refs)x LOOP
 IF r->>''md5'' IS NULL OR smarter_private.original_inventory_source_ref_md5(r) IS DISTINCT FROM r->>''md5'' THEN RETURN NULL;END IF;
 END LOOP;
 FOR c IN SELECT * FROM smarter_private.original_inventory_restoration_cases WHERE family=''erased_cash_receivable'' ORDER BY event_id LOOP
 receipt:=smarter_private.original_erased_cash_base_discharge_receipt(c.event_id,md5((c.original_witness-''original_table_scope''-''original_manifest_scope'')::text));
 IF receipt->>''status'' NOT IN(''pending'',''discharged'') OR receipt->>''status'' IS NULL THEN RETURN NULL;END IF;
 discharges:=discharges||jsonb_build_array(jsonb_build_object(''event_id'',c.event_id,''receipt'',receipt));
 END LOOP;
 SELECT md5(string_agg(event_id::text||'':''||witness_md5||'':''||proof_md5,''|'' ORDER BY event_id)) INTO proofs
 FROM smarter_private.original_inventory_restoration_certificates WHERE boundary=''2026-10-12 07:00:00Z'';
 SELECT count(to_regprocedure(signature)),md5(string_agg(signature||'':''||md5(pg_get_functiondef(to_regprocedure(signature))),''|'' ORDER BY signature)) INTO source_count,source_hash FROM(VALUES (''public.fn_union_pnl_boundary(uuid,timestamptz)''),(''public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)''),(''public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)''),(''smarter_private.original_inventory_basis_generation()''),(''smarter_private.original_inventory_proof_sources_match()''))s(signature);
 IF source_count IS DISTINCT FROM 5::bigint OR source_hash IS NULL OR proofs IS NULL THEN RETURN NULL;END IF;
 RETURN ''original-inventory-245-v1:''||md5(source_hash||''|''||proofs||''|''||discharges::text);
END $function$
';ELSIF md5(pg_get_functiondef(to_regprocedure('smarter_private.original_inventory_basis_generation()')))IS DISTINCT FROM 'dbf5a3a18da9339ba60083cb2d3aea4c' THEN RAISE EXCEPTION 'original_treasury_baseline_source_collision:smarter_private.original_inventory_basis_generation()';END IF;END$baseline$;
