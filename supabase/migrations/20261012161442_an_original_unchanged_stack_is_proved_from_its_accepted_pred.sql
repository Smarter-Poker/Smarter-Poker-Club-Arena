-- Explicit original unchanged-stack proof. Existing late-credit proof remains
-- unchanged and still requires a nonempty direct-addon suffix. No money moves,
-- original outcomes/memberships/seats are never rewritten, and no sweep exists.
-- This adds a separately identified proof and one per-hand immutable certificate
-- writer. Current signed request, atomic stack claim, original ownership/scope,
-- conservation, accepted predecessor and zero intervening inputs must all agree.
-- Installation pins source dependencies, preserved consumer and constraint.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_pnl_prove_original_unchanged_stack(uuid,bigint)'::regprocedure))='d206687c92bd2e66c94bde8bcb63dbb9' AND md5(pg_get_functiondef('public.fn_union_pnl_resolve_original_unchanged_stack(uuid,bigint,text)'::regprocedure))='ffdd9ff72d8ce00ebb217b1e1a6b8b92' AND md5(pg_get_functiondef('public.fn_union_pnl_prove_late_seat_credit(uuid,bigint)'::regprocedure))='d3f0d6d189f378cab4446e2573792721' AND md5(pg_get_functiondef('public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)'::regprocedure))='7e443fd75f3b1ece7cd0713a6b8fc0a5')
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
DO $pre$ BEGIN
 IF md5(pg_get_functiondef('public.fn_union_pnl_prove_late_seat_credit(uuid,bigint)'::regprocedure)) IS DISTINCT FROM 'd3f0d6d189f378cab4446e2573792721'
 OR md5(pg_get_functiondef('public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)'::regprocedure)) IS DISTINCT FROM '7e443fd75f3b1ece7cd0713a6b8fc0a5'
 OR md5(pg_get_functiondef('public.fn_pnl_evidence_cents(jsonb)'::regprocedure)) IS DISTINCT FROM '8d712bd799c3dfa691f2d8d9ff5101e8'
 OR md5(pg_get_functiondef('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM 'bb74ae7693dc40b812fce685cfc3c294'
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.union_pnl_cash_outcome_resolutions'::regclass AND conname='union_pnl_cash_outcome_resolutions_resolution_kind_check' AND md5(pg_get_constraintdef(oid))='51cb9926233107b662e43cf5c91e7ed8')
 OR to_regprocedure('public.fn_union_pnl_prove_original_unchanged_stack(uuid,bigint)') IS NOT NULL
 OR to_regprocedure('public.fn_union_pnl_resolve_original_unchanged_stack(uuid,bigint,text)') IS NOT NULL
 THEN RAISE EXCEPTION 'original unchanged-stack source preimage differs or already installed' USING ERRCODE='55000';END IF;
END $pre$;
ALTER TABLE public.union_pnl_cash_outcome_resolutions
 DROP CONSTRAINT union_pnl_cash_outcome_resolutions_resolution_kind_check,
 ADD CONSTRAINT union_pnl_cash_outcome_resolutions_resolution_kind_check
 CHECK(resolution_kind IN ('late_seat_credit_after_roster_snapshot','original_stack_unchanged_since_accepted_predecessor'));
CREATE FUNCTION public.fn_union_pnl_prove_original_unchanged_stack(p_table_id uuid, p_hand_number bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET TimeZone TO 'UTC'
AS $function$
DECLARE
 o public.union_pnl_cash_outcomes%ROWTYPE; p public.cash_hand_provenance_receipts%ROWTYPE;
 m public.cash_hand_participant_manifests%ROWTYPE; x jsonb; hp jsonb; r record;
 v_issue_users uuid[]; v_user uuid; v_occ uuid; v_seat uuid; v_join timestamptz; v_before numeric; v_after numeric;
 prev_hn bigint; prev_at timestamptz; prev_after numeric; nxt_hn bigint; nxt_at timestamptz; nxt_before numeric;
 v_ids uuid[]; v_amts numeric[]; v_kinds text[]; v_split integer; v_prefix numeric; v_late numeric; v_late_total numeric;
 v_extra numeric; v_matched boolean; v_people jsonb; v_result jsonb; prev_receipt public.cash_hand_provenance_receipts%ROWTYPE;
BEGIN
 IF p_table_id IS NULL OR p_hand_number IS NULL THEN RAISE EXCEPTION 'invalid_outcome_identity' USING ERRCODE='22023'; END IF;
 BEGIN
 -- CORE BEGIN (the dry run executes exactly this text)
 v_result:=NULL; v_people:='[]'; v_issue_users:=ARRAY[]::uuid[]; v_late_total:=0;
 SELECT * INTO o FROM public.union_pnl_cash_outcomes WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF NOT FOUND THEN RAISE EXCEPTION 'unchanged_stack_refused:outcome_missing'; END IF;
 IF o.evidence->>'status' IS DISTINCT FROM 'blocked' OR o.evidence ? 'reason'
  OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb
  OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope
  OR o.evidence->>'hand_id' IS DISTINCT FROM o.hand_id::text
  OR jsonb_typeof(o.evidence->'issues') IS DISTINCT FROM 'array'
  OR jsonb_typeof(o.evidence->'participants') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'unchanged_stack_refused:outcome_not_a_blocked_complete_population'; END IF;
 -- Every other defect keeps the hand blocked: only the unproven starting stack is resolvable.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(o.evidence->'issues') e(v)
   WHERE NOT (e.v='"original_cash_funding_incomplete"'::jsonb
    OR (jsonb_typeof(e.v)='object' AND e.v->>'reason'='original_seat_or_starting_stack_unproven' AND (e.v->>'user_id') IS NOT NULL)))
  OR (SELECT count(*) FROM jsonb_array_elements(o.evidence->'issues') e(v) WHERE e.v='"original_cash_funding_incomplete"'::jsonb)<>1 THEN
  RAISE EXCEPTION 'unchanged_stack_refused:outcome_has_other_evidence_defects'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(o.evidence->'participants') e(v)
   WHERE e.v->'ownership_certified' IS DISTINCT FROM 'true'::jsonb OR (e.v->>'earning_club_id') IS NULL) THEN
  RAISE EXCEPTION 'unchanged_stack_refused:earning_ownership_not_certified'; END IF;
 SELECT array_agg(DISTINCT (e.v->>'user_id')::uuid) INTO v_issue_users FROM jsonb_array_elements(o.evidence->'issues') e(v) WHERE jsonb_typeof(e.v)='object';
 IF COALESCE(cardinality(v_issue_users),0)=0 THEN RAISE EXCEPTION 'unchanged_stack_refused:no_unproven_stack'; END IF;
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF NOT FOUND OR p.hand_id IS DISTINCT FROM o.hand_id OR p.payload_hash IS DISTINCT FROM o.payload_hash
  OR p.status IS DISTINCT FROM 'uncertified' OR p.funding_provenance_complete IS DISTINCT FROM false
  OR p.all_players_included IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'unchanged_stack_refused:provenance_identity_mismatch'; END IF;
 SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=p.manifest_id;
 IF NOT FOUND OR m.table_id IS DISTINCT FROM p_table_id OR m.hand_number IS DISTINCT FROM p_hand_number
  OR m.captured_at IS NULL OR m.issues IS DISTINCT FROM p.issues OR jsonb_typeof(m.issues) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'unchanged_stack_refused:manifest_identity_mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(m.issues) e(v) WHERE e.v->>'reason' IS DISTINCT FROM 'original_seat_or_starting_stack_unproven')
  OR (SELECT array_agg(DISTINCT (e.v->>'user_id')::uuid ORDER BY (e.v->>'user_id')::uuid) FROM jsonb_array_elements(m.issues) e(v))
     IS DISTINCT FROM (SELECT array_agg(u ORDER BY u) FROM unnest(v_issue_users) u) THEN
  RAISE EXCEPTION 'unchanged_stack_refused:manifest_defects_are_not_only_the_starting_stack'; END IF;
 -- The complete original signed population still decides this hand's money.
 -- Proving one retired chair never forgives another participant's defect.
 IF p.game_scope IS DISTINCT FROM o.game_scope OR m.game_scope IS DISTINCT FROM o.game_scope
  OR o.game_scope->>'asset' IS DISTINCT FROM 'chips' OR o.game_scope->'unit_scale' IS DISTINCT FROM '2'::jsonb
  OR o.game_scope->'tournament_id' IS DISTINCT FROM 'null'::jsonb
  OR NOT o.game_scope ?& ARRAY['host_club_id','game_union_id','asset','unit_scale','is_private','tournament_id']
  OR o.game_scope->>'host_club_id' IS NULL OR jsonb_typeof(o.game_scope->'is_private') IS DISTINCT FROM 'boolean'
  OR (o.game_scope->'is_private'='false'::jsonb AND o.game_scope->>'game_union_id' IS NULL)
  OR p.accepted_at IS NULL OR NOT isfinite(p.accepted_at) OR p.accepted_at<m.captured_at OR NOT isfinite(m.captured_at)
  OR p.accepted_request->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.accepted_request->>'hand_number' IS DISTINCT FROM p_hand_number::text
  OR encode(extensions.digest(convert_to(p.accepted_request::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM p.payload_hash
  OR p.atomic_receipt->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.atomic_receipt->>'hand_number' IS DISTINCT FROM p_hand_number::text
  OR p.atomic_receipt->>'hand_id' IS DISTINCT FROM o.hand_id::text
  OR p.atomic_receipt->>'payload_hash' IS DISTINCT FROM o.payload_hash
  OR p.atomic_receipt->'stack_result'->'success' IS DISTINCT FROM 'true'::jsonb
  OR p.atomic_receipt->'stack_result'->>'mode' IS DISTINCT FROM 'delta'
  OR p.atomic_receipt->'stack_result'->'conservation_checked' IS DISTINCT FROM 'true'::jsonb
  OR coalesce((p.atomic_receipt#>>'{stack_result,request,rake}')::numeric,0) IS DISTINCT FROM p.rake
  OR coalesce((p.atomic_receipt#>>'{stack_result,request,bbj}')::numeric,0) IS DISTINCT FROM p.bbj
  OR coalesce((p.atomic_receipt#>>'{stack_result,request,inflow}')::numeric,0) IS DISTINCT FROM p.signed_external_net
  OR p.stack_claim->>'hand_id' IS NULL
  OR p.stack_claim->>'status' IS DISTINCT FROM 'succeeded'
  OR p.stack_claim->'result' IS DISTINCT FROM p.atomic_receipt->'stack_result'
  OR p.stack_settlement->>'state' IS DISTINCT FROM 'final'
  OR p.stack_claim->>'hand_id' IS DISTINCT FROM p.atomic_receipt->'stack_result'->>'hand_id'
  OR p.stack_settlement->>'hand_id' IS DISTINCT FROM p.stack_claim->>'hand_id'
  OR jsonb_typeof(p.accepted_request->'stacks') IS DISTINCT FROM 'array'
  OR jsonb_typeof(p.atomic_receipt#>'{stack_result,request,stacks}') IS DISTINCT FROM 'array'
  OR jsonb_typeof(p.participants) IS DISTINCT FROM 'array'
  OR jsonb_typeof(m.participants) IS DISTINCT FROM 'array'
  OR jsonb_array_length(p.participants)<2 OR jsonb_array_length(p.participants)>10
  OR jsonb_array_length(m.participants)<>jsonb_array_length(p.participants)
  OR jsonb_array_length(o.evidence->'participants')<>jsonb_array_length(p.participants)
  OR jsonb_array_length(p.accepted_request->'stacks')<>jsonb_array_length(p.participants)
  OR jsonb_array_length(p.atomic_receipt#>'{stack_result,request,stacks}')<>jsonb_array_length(p.participants)
  OR (SELECT count(DISTINCT z.v->>'user_id') FROM jsonb_array_elements(p.participants)z(v))<>jsonb_array_length(p.participants) THEN
  RAISE EXCEPTION 'unchanged_stack_refused:original_signed_population_unproven'; END IF;
 FOR r IN SELECT z.v part FROM jsonb_array_elements(p.participants)z(v) LOOP
  IF r.part->>'stack_before' IS NULL OR r.part->>'stack_after' IS NULL
   OR (r.part->>'stack_before')::numeric<0 OR (r.part->>'stack_after')::numeric<0
   OR r.part->>'stack_before' IN ('NaN','Infinity','-Infinity') OR r.part->>'stack_after' IN ('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'unchanged_stack_refused:invalid_original_stack'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(m.participants)q(v)
       WHERE q.v->>'user_id'=r.part->>'user_id' AND q.v->>'occupancy_id'=r.part->>'occupancy_id'
        AND q.v->>'seat_id'=r.part->>'seat_id'
        AND (q.v->>'seat_joined_at')::timestamptz=(r.part->>'seat_joined_at')::timestamptz
        AND (q.v->>'stack_before')::numeric=(r.part->>'stack_before')::numeric
        AND q.v->'funding_lineage'=r.part->'funding_lineage')<>1
   OR (SELECT count(*) FROM jsonb_array_elements(p.accepted_request->'stacks')q(v)
       WHERE q.v->>'user_id'=r.part->>'user_id' AND q.v->>'occupancy_id'=r.part->>'occupancy_id'
        AND q.v->>'seat_id'=r.part->>'seat_id'
        AND (q.v->>'seat_joined_at')::timestamptz=(r.part->>'seat_joined_at')::timestamptz
        AND (q.v->>'stack_before')::numeric=(r.part->>'stack_before')::numeric
        AND (q.v->>'stack')::numeric=(r.part->>'stack_after')::numeric)<>1
   OR (SELECT count(*) FROM jsonb_array_elements(p.atomic_receipt#>'{stack_result,request,stacks}')q(v)
       WHERE q.v->>'user_id'=r.part->>'user_id' AND q.v->>'seat_id'=r.part->>'seat_id'
        AND (q.v->>'seat_joined_at')::timestamptz=(r.part->>'seat_joined_at')::timestamptz
        AND (q.v->>'stack_before')::numeric=(r.part->>'stack_before')::numeric
        AND (q.v->>'stack')::numeric=(r.part->>'stack_after')::numeric)<>1
   OR public.fn_cash_original_funding_lineage((r.part->>'user_id')::uuid,p_table_id,(r.part->>'seat_id')::uuid,(r.part->>'occupancy_id')::uuid,
       (r.part->>'seat_joined_at')::timestamptz,(r.part#>>'{funding_lineage,observed_at}')::timestamptz,false) IS DISTINCT FROM r.part->'funding_lineage'
   OR r.part#>'{funding_lineage,issues}' IS DISTINCT FROM '[]'::jsonb
   OR (SELECT count(*) FROM jsonb_array_elements(r.part#>'{funding_lineage,funding_receipts}')ref(v))=0
   OR (SELECT count(DISTINCT (f.funding_club_id,f.funding_union_id,f.asset)) FROM jsonb_array_elements(r.part#>'{funding_lineage,funding_receipts}')ref(v) JOIN public.cash_participant_funding_receipts f ON f.id=(ref.v->>'id')::uuid)<>1
   OR (SELECT count(*) FROM jsonb_array_elements(r.part#>'{funding_lineage,funding_receipts}')ref(v) JOIN public.cash_participant_funding_receipts f ON f.id=(ref.v->>'id')::uuid WHERE f.operation_kind='buyin')<>1
   OR (SELECT count(*) FROM jsonb_array_elements(o.evidence->'participants')q(v)
       WHERE q.v->>'user_id'=r.part->>'user_id' AND q.v->'ownership_certified'='true'::jsonb
        AND q.v->>'ownership_scope'='original_chip_funding_club'
        AND q.v->>'earning_club_id'=(SELECT min(f.funding_club_id::text) FROM jsonb_array_elements(r.part#>'{funding_lineage,funding_receipts}')ref(v) JOIN public.cash_participant_funding_receipts f ON f.id=(ref.v->>'id')::uuid)
        AND (q.v->>'observed_stack_delta')::numeric=(r.part->>'stack_after')::numeric-(r.part->>'stack_before')::numeric)<>1 THEN
   RAISE EXCEPTION 'unchanged_stack_refused:original_player_or_delta_disagrees'; END IF;
 END LOOP;
 IF p.signed_external_net IS DISTINCT FROM 0 OR p.rake IS NULL OR p.bbj IS NULL OR p.rake<0 OR p.bbj<0
  OR (o.evidence->>'accepted_rake')::numeric IS DISTINCT FROM p.rake
  OR (SELECT sum((z.v->>'stack_after')::numeric-(z.v->>'stack_before')::numeric) FROM jsonb_array_elements(p.participants)z(v))+p.rake+p.bbj IS DISTINCT FROM p.signed_external_net
  OR coalesce((p.accepted_request->>'rake')::numeric,0) IS DISTINCT FROM p.rake
  OR coalesce((p.accepted_request->>'bbj')::numeric,0) IS DISTINCT FROM p.bbj
  OR coalesce((p.accepted_request->>'inflow')::numeric,0) IS DISTINCT FROM p.signed_external_net THEN
  RAISE EXCEPTION 'unchanged_stack_refused:original_conservation_disagrees'; END IF;
 FOREACH v_user IN ARRAY v_issue_users LOOP
  SELECT e.v INTO x FROM jsonb_array_elements(m.participants) e(v) WHERE e.v->>'user_id'=v_user::text;
  SELECT e.v INTO hp FROM jsonb_array_elements(p.participants) e(v) WHERE e.v->>'user_id'=v_user::text;
  v_occ:=(x->>'occupancy_id')::uuid; v_seat:=(x->>'seat_id')::uuid; v_join:=(x->>'seat_joined_at')::timestamptz;
  v_before:=(x->>'stack_before')::numeric; v_after:=(hp->>'stack_after')::numeric;
  IF x IS NULL OR hp IS NULL OR v_occ IS NULL OR v_seat IS NULL OR v_join IS NULL OR v_before IS NULL OR v_after IS NULL
   OR hp->>'occupancy_id' IS DISTINCT FROM v_occ::text OR (hp->>'stack_before')::numeric IS DISTINCT FROM v_before THEN
   RAISE EXCEPTION 'unchanged_stack_refused:participant_identity_missing'; END IF;
  -- The seat generation is the one its own funding receipts were recorded
  -- against (each receipt is written from the live seat row); the table_seats
  -- row itself is not retained after the player leaves.
  IF NOT EXISTS(SELECT 1 FROM public.cash_participant_funding_receipts f WHERE f.occupancy_id=v_occ)
   OR EXISTS(SELECT 1 FROM public.cash_participant_funding_receipts f WHERE f.occupancy_id=v_occ
    AND (f.seat_id IS DISTINCT FROM v_seat OR f.seat_joined_at IS DISTINCT FROM v_join
     OR f.user_id IS DISTINCT FROM v_user OR f.table_id IS DISTINCT FROM p_table_id)) THEN
   RAISE EXCEPTION 'unchanged_stack_refused:seat_identity_unproven'; END IF;
  -- The stack this occupancy carried out of its previous accepted hand.
  prev_hn:=NULL; prev_at:=NULL; prev_after:=0;
  SELECT pr.hand_number,pr.accepted_at,(pp.v->>'stack_after')::numeric INTO prev_hn,prev_at,prev_after
   FROM public.cash_hand_provenance_receipts pr CROSS JOIN LATERAL jsonb_array_elements(pr.participants) pp(v)
   WHERE pr.table_id=p_table_id AND pr.hand_number<p_hand_number AND pp.v->>'occupancy_id'=v_occ::text
   ORDER BY pr.hand_number DESC LIMIT 1;
  IF prev_hn IS NULL THEN prev_after:=0;
  ELSE
   IF prev_at IS NULL OR NOT isfinite(prev_at) OR prev_at>m.captured_at OR prev_after IS NULL OR prev_after<0 THEN RAISE EXCEPTION 'unchanged_stack_refused:previous_hand_unusable'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.union_pnl_cash_outcomes po WHERE po.table_id=p_table_id AND po.hand_number=prev_hn
     AND po.evidence->'all_players_included' IS NOT DISTINCT FROM 'true'::jsonb AND po.evidence->'game_scope' IS NOT DISTINCT FROM po.game_scope
     AND ((po.evidence->>'status' IS NOT DISTINCT FROM 'ready' AND po.evidence->'basis_certified' IS NOT DISTINCT FROM 'true'::jsonb)
      OR /*R*/EXISTS(SELECT 1 FROM public.union_pnl_cash_outcome_resolutions rr WHERE rr.table_id=po.table_id AND rr.hand_number=po.hand_number
       AND rr.hand_id=po.hand_id AND rr.outcome_payload_hash=po.payload_hash AND rr.outcome_evidence_md5=md5(po.evidence::text))/*R*/)) THEN
    RAISE EXCEPTION 'unchanged_stack_refused:previous_hand_not_accepted'; END IF;
  END IF;
  -- This is a separate proof class. A real late credit still uses its own
  -- existing nonempty suffix proof. No zero-valued synthetic receipt exists.
  IF prev_hn IS NULL OR prev_after IS DISTINCT FROM v_before THEN
   RAISE EXCEPTION 'unchanged_stack_refused:no_equal_accepted_predecessor'; END IF;
  SELECT * INTO STRICT prev_receipt FROM public.cash_hand_provenance_receipts
   WHERE table_id=p_table_id AND hand_number=prev_hn;
  IF prev_receipt.game_scope IS DISTINCT FROM o.game_scope
   OR prev_receipt.atomic_receipt->>'table_id' IS DISTINCT FROM p_table_id::text
   OR prev_receipt.atomic_receipt->>'hand_number' IS DISTINCT FROM prev_hn::text
   OR prev_receipt.accepted_request->>'table_id' IS DISTINCT FROM p_table_id::text
   OR prev_receipt.accepted_request->>'hand_number' IS DISTINCT FROM prev_hn::text
   OR NOT EXISTS(SELECT 1 FROM public.union_pnl_cash_outcomes po WHERE po.table_id=p_table_id AND po.hand_number=prev_hn
      AND po.hand_id=prev_receipt.hand_id AND po.payload_hash=prev_receipt.payload_hash AND po.game_scope=prev_receipt.game_scope)
   OR encode(extensions.digest(convert_to(prev_receipt.accepted_request::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM prev_receipt.payload_hash
   OR prev_receipt.atomic_receipt->>'hand_id' IS DISTINCT FROM prev_receipt.hand_id::text
   OR prev_receipt.atomic_receipt->>'payload_hash' IS DISTINCT FROM prev_receipt.payload_hash
   OR prev_receipt.atomic_receipt->'stack_result'->'success' IS DISTINCT FROM 'true'::jsonb
   OR prev_receipt.atomic_receipt->'stack_result'->'conservation_checked' IS DISTINCT FROM 'true'::jsonb
   OR prev_receipt.atomic_receipt->'stack_result'->>'mode' IS DISTINCT FROM 'delta'
   OR prev_receipt.stack_claim->>'status' IS DISTINCT FROM 'succeeded'
   OR prev_receipt.stack_claim->'result' IS DISTINCT FROM prev_receipt.atomic_receipt->'stack_result'
   OR prev_receipt.stack_settlement->>'state' IS DISTINCT FROM 'final'
   OR (SELECT count(*) FROM jsonb_array_elements(prev_receipt.accepted_request->'stacks') s(v)
       WHERE s.v->>'user_id'=v_user::text AND s.v->>'occupancy_id'=v_occ::text AND s.v->>'seat_id'=v_seat::text
        AND (s.v->>'seat_joined_at')::timestamptz=v_join AND (s.v->>'stack')::numeric=v_before)<>1
   OR (SELECT count(*) FROM jsonb_array_elements(prev_receipt.atomic_receipt#>'{stack_result,request,stacks}') s(v)
       WHERE s.v->>'user_id'=v_user::text AND s.v->>'seat_id'=v_seat::text
        AND (s.v->>'seat_joined_at')::timestamptz=v_join
        AND (s.v->>'stack')::numeric=v_before)<>1 THEN
   RAISE EXCEPTION 'unchanged_stack_refused:predecessor_signed_stack_unproven'; END IF;
  IF EXISTS(SELECT 1 FROM public.cash_participant_funding_receipts f
    WHERE f.occupancy_id=v_occ AND f.recorded_at>prev_at AND f.recorded_at<=m.captured_at)
   OR EXISTS(SELECT 1 FROM public.cash_participant_funding_receipts f JOIN public.cash_funding_application_receipts a ON a.funding_receipt_id=f.id
    WHERE f.occupancy_id=v_occ AND a.applied>0 AND a.applied_at>prev_at AND a.applied_at<=m.captured_at)
   OR EXISTS(SELECT 1 FROM public.cash_seat_move_receipts mv
    WHERE (mv.source_occupancy_id=v_occ OR mv.destination_occupancy_id=v_occ)
      AND mv.created_at>prev_at AND mv.created_at<=m.captured_at) THEN
   RAISE EXCEPTION 'unchanged_stack_refused:intervening_original_input'; END IF;
  -- Reprove the affected occupancy's original funding owner at its captured
  -- lineage instant. This reader never uses current club memberships.
  IF public.fn_cash_original_funding_lineage(v_user,p_table_id,v_seat,v_occ,v_join,
      (x#>>'{funding_lineage,observed_at}')::timestamptz,false) IS DISTINCT FROM x->'funding_lineage'
   OR x#>'{funding_lineage,issues}' IS DISTINCT FROM '[]'::jsonb THEN
   RAISE EXCEPTION 'unchanged_stack_refused:original_funding_lineage_disagrees'; END IF;
  v_people:=v_people||jsonb_build_array(jsonb_build_object('user_id',v_user,'occupancy_id',v_occ,
   'seat_id',v_seat,'seat_joined_at',v_join,'dealt_stack_before',v_before,'stack_after',v_after,
   'previous_hand',jsonb_build_object('hand_number',prev_hn,'hand_id',prev_receipt.hand_id,
     'payload_hash',prev_receipt.payload_hash,'accepted_at',prev_at,'stack_after',prev_after),
   'intervening_funding_receipts',0,'current_membership_used',false));
 END LOOP;
 v_result:=jsonb_build_object('status','proven','resolution_kind','original_stack_unchanged_since_accepted_predecessor',
  'table_id',p_table_id,'hand_number',p_hand_number,'hand_id',o.hand_id,'outcome_payload_hash',o.payload_hash,
  'outcome_evidence_md5',md5(o.evidence::text),'manifest_id',m.id,'manifest_captured_at',m.captured_at,
  'late_total',0,'participants',v_people,'current_seats_used',false,'current_membership_used',false);
 EXCEPTION
  WHEN raise_exception THEN
   IF SQLERRM LIKE 'unchanged\_stack\_refused:%' THEN
    RETURN jsonb_build_object('status','refused','reason',substr(SQLERRM,25),'table_id',p_table_id,'hand_number',p_hand_number);
   END IF;
   RAISE;
  WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR invalid_datetime_format THEN
   RETURN jsonb_build_object('status','refused','reason','malformed_original_evidence','table_id',p_table_id,'hand_number',p_hand_number);
 END;
 RETURN v_result;
END $function$;
CREATE FUNCTION public.fn_union_pnl_resolve_original_unchanged_stack(p_table_id uuid,p_hand_number bigint,p_reason text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE v_proof jsonb; v_prior public.union_pnl_cash_outcome_resolutions%ROWTYPE;
BEGIN
 IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number<1 THEN RAISE EXCEPTION 'invalid_outcome_identity' USING ERRCODE='22023'; END IF;
 IF p_reason IS NULL OR length(btrim(p_reason))<20 THEN RAISE EXCEPTION 'resolution_reason_required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('union_pnl_cash_outcome_resolution:'||p_table_id::text||':'||p_hand_number::text,0));
 SELECT * INTO v_prior FROM public.union_pnl_cash_outcome_resolutions WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.union_pnl_cash_outcomes o WHERE o.table_id=p_table_id AND o.hand_number=p_hand_number
     AND o.hand_id=v_prior.hand_id AND o.payload_hash=v_prior.outcome_payload_hash AND md5(o.evidence::text)=v_prior.outcome_evidence_md5)
   OR v_prior.resolution_kind IS DISTINCT FROM 'original_stack_unchanged_since_accepted_predecessor' THEN
   RETURN jsonb_build_object('status','refused','reason','existing_resolution_differs'); END IF;
  RETURN jsonb_build_object('status','already_resolved','table_id',p_table_id,'hand_number',p_hand_number,'resolved_at',v_prior.resolved_at);
 END IF;
 v_proof:=public.fn_union_pnl_prove_original_unchanged_stack(p_table_id,p_hand_number);
 IF v_proof->>'status' IS DISTINCT FROM 'proven' THEN RETURN v_proof; END IF;
 INSERT INTO public.union_pnl_cash_outcome_resolutions(table_id,hand_number,hand_id,outcome_payload_hash,outcome_evidence_md5,resolution_kind,proof,reason)
 VALUES(p_table_id,p_hand_number,(v_proof->>'hand_id')::uuid,v_proof->>'outcome_payload_hash',v_proof->>'outcome_evidence_md5',v_proof->>'resolution_kind',v_proof,btrim(p_reason));
 RETURN v_proof||jsonb_build_object('status','resolved');
END $function$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_prove_original_unchanged_stack(uuid,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_union_pnl_resolve_original_unchanged_stack(uuid,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_prove_original_unchanged_stack(uuid,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_resolve_original_unchanged_stack(uuid,bigint,text) TO service_role;

DO $post$ BEGIN
 IF md5(pg_get_functiondef('public.fn_union_pnl_prove_original_unchanged_stack(uuid,bigint)'::regprocedure)) IS DISTINCT FROM 'd206687c92bd2e66c94bde8bcb63dbb9'
 OR md5(pg_get_functiondef('public.fn_union_pnl_resolve_original_unchanged_stack(uuid,bigint,text)'::regprocedure)) IS DISTINCT FROM 'ffdd9ff72d8ce00ebb217b1e1a6b8b92'
 OR md5(pg_get_functiondef('public.fn_union_pnl_prove_late_seat_credit(uuid,bigint)'::regprocedure)) IS DISTINCT FROM 'd3f0d6d189f378cab4446e2573792721'
 OR md5(pg_get_functiondef('public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)'::regprocedure)) IS DISTINCT FROM '7e443fd75f3b1ece7cd0713a6b8fc0a5'
 THEN RAISE EXCEPTION 'original unchanged-stack postimage or preserved contract differs' USING ERRCODE='55000';END IF;
END $post$;
COMMIT;
