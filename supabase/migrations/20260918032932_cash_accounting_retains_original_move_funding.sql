-- Original buy-ins remained on source occupancies after legitimate cash moves.
-- Follow the retained original movement receipts without making a new debit,
-- changing beneficiaries, inferring current membership or rewriting history.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preconditions$
BEGIN
 IF md5(pg_get_functiondef('public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure)) IS DISTINCT FROM 'a3cc644b2cf4ad57093c1f8e45368e36' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'original_cash_move_prerequisite_changed:fn_pnl_cash_hand_evidence(uuid,bigint)'; END IF;
 IF md5(pg_get_functiondef('public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)'::regprocedure)) IS DISTINCT FROM '7f979a159c2c09679499f5dbe30bf0df' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'original_cash_move_prerequisite_changed:fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_boundary(uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '05f3383abb0bf41ad9fcdbec30be1fcb' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_union_pnl_boundary(uuid,timestamp with time zone)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_union_pnl_boundary(uuid,timestamp with time zone)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'original_cash_move_prerequisite_changed:fn_union_pnl_boundary(uuid,timestamp with time zone)'; END IF;
END $preconditions$;

-- The original movement journal carries custody, never a second buy-in.
-- Legacy movement rows retain NULL transaction identity; no backfill is implied.
ALTER TABLE public.cash_seat_move_receipts ADD COLUMN transaction_id xid8;
ALTER TABLE public.cash_seat_move_receipts ALTER COLUMN transaction_id SET DEFAULT pg_current_xact_id();
CREATE TRIGGER original_union_pnl_frame BEFORE INSERT ON public.cash_seat_move_receipts
 FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_receipt_frame();
CREATE TRIGGER cash_move_receipt_immutable BEFORE UPDATE OR DELETE ON public.cash_seat_move_receipts
 FOR EACH ROW EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_move_receipt_no_truncate BEFORE TRUNCATE ON public.cash_seat_move_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE INDEX cash_move_receipt_original_occupancy ON public.cash_seat_move_receipts(source_occupancy_id);

CREATE FUNCTION public.fn_cash_original_funding_lineage(
 p_user uuid,p_table uuid,p_seat uuid,p_occupancy uuid,p_join timestamptz,p_at timestamptz,p_boundary boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET timezone='UTC' AS $$
DECLARE m public.cash_seat_move_receipts%ROWTYPE; f public.cash_participant_funding_receipts%ROWTYPE;
 l public.chip_ledger%ROWTYPE; a public.cash_funding_application_receipts%ROWTYPE;
 current_table uuid:=p_table; current_occupancy uuid:=p_occupancy;
 seen uuid[]:=ARRAY[]::uuid[]; ids uuid[]:=ARRAY[]::uuid[]; refs jsonb:='[]'; moves jsonb:='[]'; issues jsonb:='[]';
 cutoff timestamptz:=p_at; cutoff_transaction xid8; move_at timestamptz;
 move_club uuid; n integer; depth integer:=0;
BEGIN
 IF p_user IS NULL OR p_table IS NULL OR p_seat IS NULL OR p_occupancy IS NULL
  OR p_join IS NULL OR NOT isfinite(p_join) OR p_at IS NULL OR NOT isfinite(p_at) THEN
  RETURN jsonb_build_object('version',1,'observed_at',p_at,'funding_receipts',refs,'moves',moves,'issues',jsonb_build_array('cash_lineage_identity_missing'));
 END IF;
 LOOP
  IF current_occupancy=ANY(seen) OR depth>64 THEN
   issues:=issues||'"cash_move_cycle_or_depth_unproven"'::jsonb; EXIT;
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
    OR (f.account_type='player_wallet' AND f.account_entity_id IS DISTINCT FROM f.user_id)
    OR (f.account_type='club_treasury' AND f.account_entity_id IS DISTINCT FROM f.funding_club_id)
    OR f.asset IS DISTINCT FROM 'chips' OR f.unit_scale<>2 OR NOT isfinite(f.recorded_at)
    OR f.amount<=0 OR f.amount<>round(f.amount,2) OR f.amount::text IN ('NaN','Infinity','-Infinity')
    OR f.balance_before-f.balance_after IS DISTINCT FROM f.amount THEN
    issues:=issues||'"cash_lineage_funding_identity_invalid"'::jsonb;
   END IF;
   SELECT * INTO l FROM public.chip_ledger WHERE id=f.source_ledger_id;
   IF NOT FOUND OR l.status IS DISTINCT FROM 'posted' OR l.club_id IS DISTINCT FROM f.funding_club_id
    OR l.from_type IS DISTINCT FROM f.account_type OR l.from_entity_id IS DISTINCT FROM f.account_entity_id
    OR l.to_type IS DISTINCT FROM 'table_stack' OR l.to_entity_id IS DISTINCT FROM f.table_id
    OR l.category IS DISTINCT FROM f.operation_kind OR l.amount IS DISTINCT FROM f.amount THEN
    issues:=issues||'"cash_lineage_original_debit_invalid"'::jsonb;
   END IF;
   IF f.pending_addon_id IS NOT NULL AND NOT p_boundary THEN
    SELECT * INTO a FROM public.cash_funding_application_receipts WHERE funding_receipt_id=f.id;
    IF NOT FOUND OR a.original_occupancy_id IS DISTINCT FROM f.occupancy_id
     OR a.applied_at>p_at OR NOT isfinite(a.applied_at) OR a.applied+a.refunded IS DISTINCT FROM f.amount
     OR (a.applied>0 AND a.applied_occupancy_id IS DISTINCT FROM f.occupancy_id) THEN
     issues:=issues||'"pending_funding_application_unproven"'::jsonb;
    END IF;
   END IF;
   ids:=array_append(ids,f.id);
   refs:=refs||jsonb_build_array(jsonb_build_object('id',f.id,'account_type',f.account_type,
    'account_entity_id',f.account_entity_id,'funding_club_id',f.funding_club_id,'funding_union_id',f.funding_union_id,
    'pending_addon_id',f.pending_addon_id));
  END LOOP;
  SELECT count(*) INTO n FROM public.cash_seat_move_receipts r LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE r.destination_occupancy_id=current_occupancy AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.created_at) ELSE r.created_at END)<p_at;
  IF n=0 THEN EXIT; END IF;
  IF n<>1 THEN issues:=issues||'"cash_move_destination_fork"'::jsonb; EXIT; END IF;
  SELECT r.* INTO m FROM public.cash_seat_move_receipts r LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE r.destination_occupancy_id=current_occupancy AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.created_at) ELSE r.created_at END)<p_at;
  SELECT observed_at INTO move_at FROM public.union_pnl_transaction_frames WHERE transaction_id=m.transaction_id;
  IF p_boundary AND (m.transaction_id IS NULL OR move_at IS NULL) THEN
   issues:=issues||'"cash_move_original_transaction_frame_missing"'::jsonb;
  END IF;
  IF m.player_id IS DISTINCT FROM p_user OR m.to_table_id IS DISTINCT FROM current_table
   OR m.source_occupancy_id=ANY(seen) OR m.from_table_id=m.to_table_id
   OR m.club_id IS NULL OR (move_club IS NOT NULL AND m.club_id IS DISTINCT FROM move_club)
   OR m.amount<=0 OR m.amount<>round(m.amount,2) OR m.amount::text IN ('NaN','Infinity','-Infinity')
   OR NOT isfinite(m.created_at) OR (CASE WHEN p_boundary THEN COALESCE(move_at,m.created_at) ELSE m.created_at END)>cutoff
   OR (move_at IS NOT NULL AND (NOT isfinite(move_at) OR move_at>=p_at))
   OR jsonb_typeof(m.receipt) IS DISTINCT FROM 'object' OR m.receipt->>'ok' IS DISTINCT FROM 'true'
   OR m.receipt->>'move_id' IS DISTINCT FROM m.move_id::text OR m.receipt->>'player_id' IS DISTINCT FROM p_user::text
   OR m.receipt->>'from_table_id' IS DISTINCT FROM m.from_table_id::text
   OR m.receipt->>'to_table_id' IS DISTINCT FROM m.to_table_id::text
   OR m.receipt->>'source_seat_number' IS DISTINCT FROM m.from_seat_number::text
   OR m.receipt->>'to_seat_number' IS DISTINCT FROM m.to_seat_number::text
   OR m.receipt->>'source_occupancy_id' IS DISTINCT FROM m.source_occupancy_id::text
   OR m.receipt->>'destination_occupancy_id' IS DISTINCT FROM m.destination_occupancy_id::text
   OR public.fn_pnl_evidence_cents(m.receipt->'stack') IS DISTINCT FROM m.amount
   OR m.receipt->>'idempotency_key' IS DISTINCT FROM 'seatmove:'||m.move_id::text
   OR (SELECT count(*) FROM public.cash_seat_move_receipts r LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id WHERE r.source_occupancy_id=m.source_occupancy_id AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.created_at) ELSE r.created_at END)<p_at)<>1 THEN
   issues:=issues||'"cash_move_original_receipt_invalid"'::jsonb; EXIT;
  END IF;
  moves:=moves||jsonb_build_array(to_jsonb(m));
  move_club:=m.club_id; current_table:=m.from_table_id; current_occupancy:=m.source_occupancy_id;
  cutoff:=CASE WHEN p_boundary THEN COALESCE(move_at,m.created_at) ELSE m.created_at END; cutoff_transaction:=m.transaction_id; depth:=depth+1;
 END LOOP;
 -- Every retained source must agree with the exact custody club through all moves.
 IF move_club IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(refs) r WHERE r->>'funding_club_id' IS DISTINCT FROM move_club::text) THEN
  issues:=issues||'"cash_move_original_funding_club_mismatch"'::jsonb;
 END IF;
 RETURN jsonb_build_object('version',1,'observed_at',p_at,'funding_receipts',refs,'moves',moves,'issues',issues);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
 RETURN jsonb_build_object('version',1,'observed_at',p_at,'funding_receipts','[]'::jsonb,'moves',moves,'issues',jsonb_build_array('cash_move_malformed_original_evidence'));
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_pnl_cash_hand_evidence(p_table_id uuid, p_hand_number bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE a public.hand_atomic_commits%ROWTYPE; v_live_atomic jsonb; p public.cash_hand_provenance_receipts%ROWTYPE;
 m public.cash_hand_participant_manifests%ROWTYPE; f public.cash_participant_funding_receipts%ROWTYPE;
 l public.chip_ledger%ROWTYPE; app public.cash_funding_application_receipts%ROWTYPE;
 v_lineage jsonb; v_lineage_at timestamptz; x jsonb; y jsonb; submitted jsonb; original jsonb; ref jsonb; v_request jsonb; v_stack_hand uuid; v_people jsonb:='[]';
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
 IF FOUND AND NOT public.fn_cash_atomic_original_matches(p.atomic_receipt,v_live_atomic,p.accepted_request) THEN
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
  v_lineage:=NULL;
  IF x ? 'funding_lineage' THEN
   v_lineage_at:=(x#>>'{funding_lineage,observed_at}')::timestamptz;
   IF v_lineage_at IS NULL OR NOT isfinite(v_lineage_at) OR v_lineage_at>m.captured_at THEN v_owned:=false; END IF;
   v_lineage:=public.fn_cash_original_funding_lineage(v_user,p_table_id,(x->>'seat_id')::uuid,
    (x->>'occupancy_id')::uuid,(x->>'seat_joined_at')::timestamptz,v_lineage_at,false);
   IF v_lineage IS DISTINCT FROM x->'funding_lineage' OR v_lineage->'issues'<>'[]'::jsonb
    OR v_lineage->'funding_receipts' IS DISTINCT FROM x->'funding_receipts' THEN v_owned:=false; END IF;
  END IF;
  IF jsonb_typeof(x->'funding_receipts') IS DISTINCT FROM 'array'  OR x->'funding_receipts'='[]'::jsonb THEN
   v_owned:=false;
  ELSE
   FOR ref IN SELECT value FROM jsonb_array_elements(x->'funding_receipts') LOOP
    SELECT * INTO f FROM public.cash_participant_funding_receipts WHERE id=(ref->>'id')::uuid;
    IF NOT FOUND THEN v_owned:=false; CONTINUE; END IF;
    IF f.id=ANY(v_funding_seen) THEN v_owned:=false; END IF;
    v_funding_seen:=array_append(v_funding_seen,f.id);
    v_funding_account:=jsonb_build_array(f.funding_club_id,f.funding_union_id,f.asset);
    IF v_account IS NULL THEN v_account:=v_funding_account; v_club:=f.funding_club_id;
    ELSIF v_account IS DISTINCT FROM v_funding_account THEN v_owned:=false; END IF;
    IF f.operation_kind='buyin' THEN v_initial:=v_initial+1; END IF;
    IF f.user_id IS DISTINCT FROM v_user OR (v_lineage IS NULL AND (f.table_id IS DISTINCT FROM p_table_id
     OR f.seat_id::text IS DISTINCT FROM x->>'seat_id' OR f.occupancy_id::text IS DISTINCT FROM x->>'occupancy_id'
     OR f.seat_joined_at IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz))
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
     OR l.to_type IS DISTINCT FROM 'table_stack' OR l.to_entity_id IS DISTINCT FROM f.table_id
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
END $function$
;

REVOKE ALL ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) TO service_role;

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
;

REVOKE ALL ON FUNCTION public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_boundary(p_union_id uuid, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE inv jsonb; holdings jsonb:='[]'; issues jsonb:='[]'; s jsonb; t jsonb; f record; tr record;
 lineage jsonb; owned uuid; owners int; initial int; value numeric; entries int; first_op text;
BEGIN
 inv:=public.fn_union_pnl_inventory_as_of(p_at);
 IF inv->>'status' IS DISTINCT FROM 'observed' THEN RETURN jsonb_build_object('status','blocked','inventory',inv,'holdings',holdings); END IF;
 FOR s IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,table_seats}','[]')) x
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tables}','[]')) y
   WHERE y#>>'{row,id}'=x#>>'{row,table_id}' AND y#>>'{row,union_id}'=p_union_id::text) LOOP
  lineage:=public.fn_cash_original_funding_lineage((s->>'user_id')::uuid,(s->>'table_id')::uuid,
   (s->>'id')::uuid,(s->>'occupancy_id')::uuid,(s->>'joined_at')::timestamptz,p_at,true);
  SELECT count(*) FILTER(WHERE r.operation_kind='buyin'),count(DISTINCT (r.funding_club_id,r.funding_union_id,r.asset)),min(r.funding_club_id::text)::uuid
   INTO initial,owners,owned FROM jsonb_array_elements(lineage->'funding_receipts') ref
   JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid;
  value:=public.fn_pnl_evidence_cents(s->'stack');
  IF lineage->'issues'<>'[]'::jsonb OR initial<>1 OR owners<>1 OR owned IS NULL OR value IS NULL OR value<0 THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','cash_boundary_original_funding_missing_or_ambiguous','seat_id',s->'id'));
  ELSE
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',owned,'user_id',s->'user_id','amount',value,'kind','cash_stack','source_id',s->'id'));
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
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tables}','[]')) y
    WHERE y#>>'{row,id}'=r.table_id::text AND y#>>'{row,union_id}'=p_union_id::text)
 LOOP
  IF f.held<0 OR f.funding_club_id IS NULL THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','pending_funding_boundary_invalid','source_id',f.id));
  ELSIF f.held>0 THEN
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',f.funding_club_id,'user_id',f.user_id,'amount',f.held,'kind','pending_cash_funding','source_id',f.id));
  END IF;
 END LOOP;
 -- Preserve the established realized-settlement rule: original gross entry
 -- less money already returned is deferred while a tournament remains open.
 -- This is not market value, ICM, or a new allocation of the prize pool.
 FOR t IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,tournaments}','[]')) x
  WHERE x#>>'{row,union_id}'=p_union_id::text LOOP
  SELECT operation INTO first_op FROM public.union_pnl_inventory_events WHERE source_name='tournaments' AND row_id=(t->>'id')::uuid ORDER BY event_id LIMIT 1;
  IF first_op IS DISTINCT FROM 'INSERT' THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_precedes_original_population','tournament_id',t->'id')); CONTINUE;
  END IF;
  FOR s IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,tournament_players}','[]')) x
   WHERE x#>>'{row,tournament_id}'=t->>'id' LOOP
   SELECT count(*),count(DISTINCT public.fn_union_pnl_tournament_entry_club(r)),min(public.fn_union_pnl_tournament_entry_club(r)::text)::uuid,
    sum(amount) INTO entries,owners,owned,value
   FROM public.tournament_participant_funding_receipts r
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE r.tournament_id=(t->>'id')::uuid AND registration_id=(s->>'id')::uuid AND b.observed_at<p_at AND asset='chips';
   IF entries=0 OR owners<>1 OR owned IS NULL OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.tournament_id=(t->>'id')::uuid AND registration_id=(s->>'id')::uuid AND asset<>'chips') THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_original_instrument_or_earning_club_missing','registration_id',s->'id')); CONTINUE;
   END IF;
   IF EXISTS(SELECT 1 FROM public.fn_union_pnl_tournament_returns((t->>'id')::uuid,(s->>'id')::uuid,NULL,p_at) c
     JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
     WHERE c.tournament_id=(t->>'id')::uuid AND c.user_id=(s->>'user_id')::uuid AND b.observed_at<p_at
      AND EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r
       WHERE r.registration_id=(s->>'id')::uuid AND r.id=ANY(c.entry_receipt_ids)) AND c.credited_club_id<>owned) THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_credit_owner_changed','registration_id',s->'id')); CONTINUE;
   END IF;
   SELECT value-COALESCE(sum(c.amount),0) INTO value FROM public.fn_union_pnl_tournament_returns((t->>'id')::uuid,(s->>'id')::uuid,NULL,p_at) c
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
    WHERE c.tournament_id=(t->>'id')::uuid AND c.user_id=(s->>'user_id')::uuid AND b.observed_at<p_at
      AND EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r
       WHERE r.registration_id=(s->>'id')::uuid AND r.id=ANY(c.entry_receipt_ids));
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',owned,'user_id',s->'user_id','amount',value,'kind','deferred_tournament_result','source_id',s->'id'));
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('status',CASE WHEN issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,'boundary',p_at,
  'inventory',inv,'holdings',holdings,'issues',issues,'tournament_basis','original_realized_settlement_deferred_while_open');
END $function$
;

REVOKE ALL ON FUNCTION public.fn_union_pnl_boundary(uuid,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
