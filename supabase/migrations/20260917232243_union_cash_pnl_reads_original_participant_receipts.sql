-- Prospective accepted-hand P&L evidence. Requires the original funding producer.
-- A complete hand is not a complete accounting week or payment authorization.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure))
   IS DISTINCT FROM 'dbfd6a81a39c1c552efccfde3049aa4c'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
  RAISE EXCEPTION 'cash_pnl_reader_predecessor_changed';
 END IF;
 IF to_regclass('public.cash_hand_provenance_receipts') IS NULL
  OR to_regclass('public.cash_hand_participant_manifests') IS NULL
  OR to_regclass('public.cash_participant_funding_receipts') IS NULL
  OR to_regclass('public.cash_funding_application_receipts') IS NULL THEN
  RAISE EXCEPTION 'original_cash_funding_producer_missing';
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_pnl_cash_hand_evidence(p_table_id uuid,p_hand_number bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.hand_atomic_commits%ROWTYPE; v_live_atomic jsonb; p public.cash_hand_provenance_receipts%ROWTYPE;
 m public.cash_hand_participant_manifests%ROWTYPE; f public.cash_participant_funding_receipts%ROWTYPE;
 l public.chip_ledger%ROWTYPE; app public.cash_funding_application_receipts%ROWTYPE;
 x jsonb; y jsonb; submitted jsonb; original jsonb; ref jsonb; v_request jsonb; v_stack_hand uuid; v_people jsonb:='[]';
 v_issues jsonb:='[]'; v_seen uuid[]:=ARRAY[]::uuid[]; v_funding_seen uuid[];
 v_user uuid; v_club uuid; v_account jsonb; v_funding_account jsonb;
 v_before numeric; v_after numeric; v_delta numeric:=0; v_rake numeric; v_bbj numeric; v_inflow numeric;
 v_initial integer; v_owned boolean; v_population boolean:=false;
BEGIN
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','basis_certified',false,
  'all_players_included',false,'reason','original_cash_provenance_missing'); END IF;
 IF jsonb_typeof(p.atomic_receipt) IS DISTINCT FROM 'object'
  OR p.atomic_receipt->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.atomic_receipt->>'hand_number' IS DISTINCT FROM p_hand_number::text THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','retained_atomic_receipt_missing'); END IF;
 SELECT * INTO a FROM jsonb_populate_record(NULL::public.hand_atomic_commits,p.atomic_receipt);
 SELECT to_jsonb(live) INTO v_live_atomic FROM public.hand_atomic_commits live
  WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF FOUND AND v_live_atomic IS DISTINCT FROM p.atomic_receipt THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','live_atomic_receipt_conflicts_with_original'); END IF;
 v_request:=a.stack_result->'request';
 IF a.committed_at IS NULL OR NOT isfinite(a.committed_at)
  OR a.stack_result->'success' IS DISTINCT FROM 'true'::jsonb
  OR a.stack_result->>'mode' IS DISTINCT FROM 'delta'
  OR jsonb_typeof(v_request->'stacks') IS DISTINCT FROM 'array'
  OR NOT a.stack_result ? 'tournament_id' OR a.stack_result->'tournament_id' IS DISTINCT FROM 'null'::jsonb THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','accepted_cash_delta_request_missing');
 END IF;
 IF p.version<>1 OR p.hand_id IS DISTINCT FROM a.hand_id OR p.payload_hash IS DISTINCT FROM a.payload_hash
  OR p.accepted_at IS NULL OR NOT isfinite(p.accepted_at) OR p.accepted_at<a.committed_at
  OR jsonb_typeof(p.accepted_request) IS DISTINCT FROM 'object'
  OR p.accepted_request->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.accepted_request->>'hand_number' IS DISTINCT FROM p_hand_number::text
  OR encode(extensions.digest(convert_to(p.accepted_request::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.payload_hash
  OR jsonb_typeof(p.accepted_request->'stacks') IS DISTINCT FROM 'array'
  OR p.manifest_id IS NULL OR jsonb_typeof(p.participants) IS DISTINCT FROM 'array'
  OR jsonb_typeof(p.issues) IS DISTINCT FROM 'array' THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','accepted_cash_provenance_link_missing');
 END IF;
 SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=p.manifest_id;
 IF NOT FOUND OR m.table_id IS DISTINCT FROM p_table_id OR m.hand_number IS DISTINCT FROM p_hand_number
  OR m.captured_at IS NULL OR NOT isfinite(m.captured_at) OR m.captured_at>p.accepted_at
  OR m.game_scope IS DISTINCT FROM p.game_scope OR jsonb_typeof(m.participants) IS DISTINCT FROM 'array'
  OR jsonb_array_length(m.participants)<>jsonb_array_length(p.participants)
  OR jsonb_array_length(p.participants)<>jsonb_array_length(v_request->'stacks')
  OR jsonb_array_length(p.participants)<>jsonb_array_length(p.accepted_request->'stacks')
  OR (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(v_request->'stacks'))<>jsonb_array_length(p.participants)
  OR (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(p.accepted_request->'stacks'))<>jsonb_array_length(p.participants)
  OR (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(m.participants))<>jsonb_array_length(p.participants)
  OR jsonb_array_length(p.participants)<2 OR jsonb_array_length(p.participants)>10
  OR p.all_players_included IS DISTINCT FROM true THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','original_cash_population_link_missing');
 END IF;
 v_stack_hand:=(a.stack_result->>'hand_id')::uuid;
 IF p.stack_claim->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.stack_claim->>'hand_id' IS DISTINCT FROM v_stack_hand::text
  OR p.stack_claim->>'status' IS DISTINCT FROM 'succeeded'
  OR (p.stack_claim->>'completed_at') IS NULL OR p.stack_claim->'result' IS DISTINCT FROM a.stack_result
  OR p.stack_settlement->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.stack_settlement->>'hand_id' IS DISTINCT FROM v_stack_hand::text
  OR p.stack_settlement->>'settlement_type' IS DISTINCT FROM 'hand_stacks'
  OR p.stack_settlement->>'state' IS DISTINCT FROM 'final'
  OR EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k WHERE k.table_id=p_table_id AND k.hand_id=v_stack_hand
    AND (k.status IS DISTINCT FROM 'succeeded' OR k.result IS DISTINCT FROM a.stack_result OR k.completed_at IS NULL))
  OR EXISTS(SELECT 1 FROM public.ca_settlements c WHERE c.table_id=p_table_id AND c.hand_id=v_stack_hand
    AND c.settlement_type='hand_stacks' AND c.state IS DISTINCT FROM 'final') THEN
  v_issues:=v_issues||'"accepted_stack_receipt_link_missing"'::jsonb;
 END IF;
 IF p.status IS DISTINCT FROM 'captured' OR p.funding_provenance_complete IS DISTINCT FROM true
  OR m.funding_provenance_complete IS DISTINCT FROM true OR p.issues<>'[]'::jsonb OR m.issues<>'[]'::jsonb THEN
  v_issues:=v_issues||'"original_cash_funding_incomplete"'::jsonb||p.issues;
 END IF;
 IF jsonb_typeof(p.game_scope) IS DISTINCT FROM 'object'
  OR NOT p.game_scope ?& ARRAY['host_club_id','game_union_id','is_private','tournament_id','asset','unit_scale']
  OR p.game_scope->>'asset' IS DISTINCT FROM 'chips' OR p.game_scope->'unit_scale' IS DISTINCT FROM '2'::jsonb
  OR p.game_scope->'tournament_id' IS DISTINCT FROM 'null'::jsonb
  OR jsonb_typeof(p.game_scope->'is_private') IS DISTINCT FROM 'boolean'
  OR (p.game_scope->'is_private'='true'::jsonb AND p.game_scope->'game_union_id' IS DISTINCT FROM 'null'::jsonb)
  OR (p.game_scope->'is_private'='false'::jsonb AND (p.game_scope->>'game_union_id') IS NULL) THEN
  v_issues:=v_issues||'"historical_game_asset_and_union_receipt_invalid"'::jsonb;
 END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p.participants) LOOP
  v_user:=(x->>'user_id')::uuid;
  SELECT value INTO y FROM jsonb_array_elements(v_request->'stacks') WHERE value->>'user_id'=x->>'user_id';
  SELECT value INTO submitted FROM jsonb_array_elements(p.accepted_request->'stacks') WHERE value->>'user_id'=x->>'user_id';
  SELECT value INTO original FROM jsonb_array_elements(m.participants) WHERE value->>'user_id'=x->>'user_id';
  v_before:=public.fn_pnl_evidence_cents(x->'stack_before'); v_after:=public.fn_pnl_evidence_cents(x->'stack_after');
  IF v_user IS NULL OR v_user=ANY(v_seen) OR y IS NULL OR original IS NULL
   OR submitted IS NULL OR original IS DISTINCT FROM (x-'stack_after'-'poker_delta')
   OR v_before IS NULL OR v_after IS NULL OR v_before<0 OR v_after<0
   OR public.fn_pnl_evidence_cents(x->'poker_delta') IS DISTINCT FROM v_after-v_before
   OR public.fn_pnl_evidence_cents(y->'stack_before') IS DISTINCT FROM v_before
   OR public.fn_pnl_evidence_cents(y->'stack') IS DISTINCT FROM v_after
   OR y->>'seat_id' IS DISTINCT FROM x->>'seat_id'
   OR public.fn_pnl_evidence_cents(submitted->'stack_before') IS DISTINCT FROM v_before
   OR public.fn_pnl_evidence_cents(submitted->'stack') IS DISTINCT FROM v_after
   OR submitted->>'seat_id' IS DISTINCT FROM x->>'seat_id'
   OR submitted->>'occupancy_id' IS DISTINCT FROM x->>'occupancy_id'
   OR (submitted->>'seat_joined_at')::timestamptz IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz
   OR (y->>'seat_joined_at')::timestamptz IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz
   OR submitted->>'funding_manifest_id' IS DISTINCT FROM p.manifest_id::text THEN
   RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
    'reason','original_cash_participant_mismatch');
  END IF;
  v_seen:=array_append(v_seen,v_user); v_delta:=v_delta+v_after-v_before;
  v_owned:=true; v_initial:=0; v_club:=NULL; v_account:=NULL; v_funding_seen:=ARRAY[]::uuid[];
  IF jsonb_typeof(x->'funding_receipts') IS DISTINCT FROM 'array' OR x->'funding_receipts'='[]'::jsonb THEN
   v_owned:=false;
  ELSE
   FOR ref IN SELECT value FROM jsonb_array_elements(x->'funding_receipts') LOOP
    SELECT * INTO f FROM public.cash_participant_funding_receipts WHERE id=(ref->>'id')::uuid;
    IF NOT FOUND THEN v_owned:=false; CONTINUE; END IF;
    IF f.id=ANY(v_funding_seen) THEN v_owned:=false; END IF;
    v_funding_seen:=array_append(v_funding_seen,f.id);
    v_funding_account:=jsonb_build_array(f.account_type,f.account_entity_id,f.funding_club_id);
    IF v_account IS NULL THEN v_account:=v_funding_account; v_club:=f.funding_club_id;
    ELSIF v_account IS DISTINCT FROM v_funding_account THEN v_owned:=false; END IF;
    IF f.operation_kind='buyin' THEN v_initial:=v_initial+1; END IF;
    IF f.user_id IS DISTINCT FROM v_user OR f.table_id IS DISTINCT FROM p_table_id
     OR f.seat_id::text IS DISTINCT FROM x->>'seat_id' OR f.occupancy_id::text IS DISTINCT FROM x->>'occupancy_id'
     OR f.seat_joined_at IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz
     OR f.recorded_at>m.captured_at OR NOT isfinite(f.recorded_at) OR f.asset<>'chips' OR f.unit_scale<>2
     OR f.account_type IS DISTINCT FROM ref->>'account_type'
     OR f.account_entity_id::text IS DISTINCT FROM ref->>'account_entity_id'
     OR f.funding_club_id::text IS DISTINCT FROM ref->>'funding_club_id'
     OR f.funding_union_id::text IS DISTINCT FROM ref->>'funding_union_id'
     OR f.pending_addon_id::text IS DISTINCT FROM ref->>'pending_addon_id'
     OR f.amount<=0 OR f.amount<>round(f.amount,2) OR f.amount::text IN ('NaN','Infinity','-Infinity')
     OR f.balance_before-f.balance_after IS DISTINCT FROM f.amount THEN v_owned:=false; END IF;
    SELECT * INTO l FROM public.chip_ledger WHERE id=f.source_ledger_id;
    IF NOT FOUND OR l.status IS DISTINCT FROM 'posted' OR l.club_id IS DISTINCT FROM f.funding_club_id
     OR l.from_type IS DISTINCT FROM f.account_type OR l.from_entity_id IS DISTINCT FROM f.account_entity_id
     OR l.to_type IS DISTINCT FROM 'table_stack' OR l.to_entity_id IS DISTINCT FROM p_table_id
     OR l.category IS DISTINCT FROM f.operation_kind OR l.amount IS DISTINCT FROM f.amount THEN v_owned:=false; END IF;
    IF f.pending_addon_id IS NOT NULL THEN
     SELECT * INTO app FROM public.cash_funding_application_receipts WHERE pending_addon_id=f.pending_addon_id;
     IF NOT FOUND OR app.funding_receipt_id IS DISTINCT FROM f.id OR app.original_occupancy_id IS DISTINCT FROM f.occupancy_id
      OR app.applied_at>m.captured_at OR NOT isfinite(app.applied_at) OR app.applied+app.refunded IS DISTINCT FROM f.amount
      OR (app.applied>0 AND app.applied_occupancy_id IS DISTINCT FROM f.occupancy_id) THEN v_owned:=false; END IF;
    END IF;
   END LOOP;
  END IF;
  IF v_initial<>1 THEN v_owned:=false; END IF;
  IF NOT v_owned THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','participant_earning_ownership_receipt_invalid','user_id',v_user)); END IF;
  v_people:=v_people||jsonb_build_array(jsonb_build_object('user_id',v_user,'is_horse',x->'is_horse',
   'observed_stack_delta',v_after-v_before,'earning_club_id',CASE WHEN v_owned THEN v_club ELSE NULL END,
   'ownership_certified',v_owned,'ownership_scope','original_chip_funding_club','funding_receipt_ids',to_jsonb(v_funding_seen)));
 END LOOP;
 v_population:=true;
 v_rake:=public.fn_pnl_evidence_cents(v_request->'rake'); v_bbj:=public.fn_pnl_evidence_cents(v_request->'bbj');
 v_inflow:=public.fn_pnl_evidence_cents(v_request->'inflow');
 IF v_request->'rake'='null'::jsonb THEN v_rake:=0; END IF;
 IF v_request->'bbj'='null'::jsonb THEN v_bbj:=0; END IF;
 IF v_request->'inflow'='null'::jsonb THEN v_inflow:=0; END IF;
 IF v_rake IS NULL OR v_bbj IS NULL OR v_inflow IS NULL OR v_rake<0 OR v_bbj<0
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->'rake','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM v_rake
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->'bbj','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM v_bbj
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->'inflow','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM v_inflow
  OR v_rake IS DISTINCT FROM p.rake OR v_bbj IS DISTINCT FROM p.bbj OR v_inflow IS DISTINCT FROM p.signed_external_net THEN
  v_issues:=v_issues||'"hand_conservation_inputs_missing"'::jsonb;
 ELSIF v_delta+v_rake+v_bbj<>v_inflow THEN v_issues:=v_issues||'"hand_delta_conservation_mismatch"'::jsonb;
 END IF;
 -- Signed insurance/external movements conserve but need their own bank linkage.
 IF v_inflow<>0 THEN v_issues:=v_issues||'"external_bank_receipt_not_certified"'::jsonb; END IF;
 RETURN jsonb_build_object('status',CASE WHEN v_issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,
  'basis_certified',v_issues='[]'::jsonb,'scope','single_accepted_cash_hand','payment_authorized',false,
  'hand_id',a.hand_id,'table_id',p_table_id,'hand_number',p_hand_number,'observed_commit_at',a.committed_at,
  'observed_delta_total',v_delta,'participants',v_people,'issues',v_issues,'game_scope',p.game_scope,
  'current_seats_used',false,'current_membership_used',false,'all_players_included',v_population);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
 RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,'reason','malformed_original_cash_evidence');
END $$;
COMMIT;
