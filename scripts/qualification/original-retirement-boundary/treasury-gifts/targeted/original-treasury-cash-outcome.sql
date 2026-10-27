CREATE FUNCTION smarter_private.original_treasury_cash_outcome_evidence(p_outcome jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $outcome$
DECLARE old jsonb:=p_outcome->'evidence';fresh jsonb;part jsonb;original jsonb;giftusers uuid[]:=ARRAY[]::uuid[];n bigint;p public.cash_hand_provenance_receipts%ROWTYPE;
BEGIN
 p_outcome:=jsonb_set(p_outcome,'{recognized_at}',to_jsonb((p_outcome->>'recognized_at')::timestamptz));
 SELECT count(*) INTO n FROM public.union_pnl_cash_outcomes o WHERE o.table_id=(p_outcome->>'table_id')::uuid
  AND o.hand_number=(p_outcome->>'hand_number')::bigint AND to_jsonb(o)=p_outcome;
 IF n<>1 OR old->>'status' IS DISTINCT FROM 'blocked' OR old->'basis_certified' IS DISTINCT FROM 'false'::jsonb
  OR old->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR old->'game_scope' IS DISTINCT FROM p_outcome->'game_scope'
  OR old->>'hand_id' IS DISTINCT FROM p_outcome->>'hand_id' OR old->>'table_id' IS DISTINCT FROM p_outcome->>'table_id'
  OR old->>'hand_number' IS DISTINCT FROM p_outcome->>'hand_number' OR jsonb_typeof(old->'participants') IS DISTINCT FROM 'array'
  OR jsonb_typeof(old->'issues') IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 SELECT * INTO STRICT p FROM public.cash_hand_provenance_receipts WHERE table_id=(p_outcome->>'table_id')::uuid AND hand_number=(p_outcome->>'hand_number')::bigint;
 IF p.hand_id::text IS DISTINCT FROM p_outcome->>'hand_id' OR p.payload_hash IS DISTINCT FROM p_outcome->>'payload_hash'
  OR (old->>'accepted_rake')::numeric IS DISTINCT FROM p.rake OR (old->>'accepted_bbj')::numeric IS DISTINCT FROM p.bbj
  OR (old->>'accepted_external_net')::numeric IS DISTINCT FROM p.signed_external_net THEN RETURN NULL;END IF;
 fresh:=public.fn_pnl_cash_hand_evidence(p.table_id,p.hand_number);
 IF fresh->>'status' IS DISTINCT FROM 'ready' OR fresh->'basis_certified' IS DISTINCT FROM 'true'::jsonb
  OR fresh->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR fresh->'payment_authorized' IS DISTINCT FROM 'false'::jsonb
  OR fresh->'game_scope' IS DISTINCT FROM p_outcome->'game_scope' OR fresh->'hand_id' IS DISTINCT FROM old->'hand_id'
  OR fresh->'observed_delta_total' IS DISTINCT FROM old->'observed_delta_total'
  OR (fresh->>'observed_commit_at')::timestamptz IS DISTINCT FROM (old->>'observed_commit_at')::timestamptz
  OR fresh->'current_seats_used' IS DISTINCT FROM 'false'::jsonb OR fresh->'current_membership_used' IS DISTINCT FROM 'false'::jsonb
  OR jsonb_array_length(fresh->'participants')<>jsonb_array_length(old->'participants') THEN RETURN NULL;END IF;
 FOR part IN SELECT value FROM jsonb_array_elements(fresh->'participants') LOOP
  SELECT count(*),jsonb_agg(v)->0 INTO n,original FROM jsonb_array_elements(old->'participants') v WHERE v->>'user_id'=part->>'user_id';
  IF n<>1 THEN RETURN NULL;END IF;
  IF part#>>'{original_treasury_gift,status}'='proven' THEN
   IF original->'ownership_certified' IS DISTINCT FROM 'false'::jsonb OR original->'earning_club_id' IS DISTINCT FROM 'null'::jsonb
    OR original-ARRAY['ownership_certified','earning_club_id'] IS DISTINCT FROM part-ARRAY['ownership_certified','earning_club_id','original_treasury_gift'] THEN RETURN NULL;END IF;
   giftusers:=array_append(giftusers,(part->>'user_id')::uuid);
  ELSIF original IS DISTINCT FROM part THEN RETURN NULL;END IF;
 END LOOP;
 IF cardinality(giftusers)=0 OR (SELECT count(*)FROM jsonb_array_elements(old->'issues')i WHERE i='"original_cash_funding_incomplete"'::jsonb)<>1
  OR EXISTS(SELECT FROM jsonb_array_elements(old->'issues')i WHERE i<>'"original_cash_funding_incomplete"'::jsonb AND NOT EXISTS(
   SELECT FROM unnest(giftusers)u CROSS JOIN(VALUES('original_admission_funding_missing'),('participant_earning_ownership_receipt_invalid'))reason(v)
   WHERE i=jsonb_build_object('reason',reason.v,'user_id',u)))
  OR EXISTS(SELECT FROM unnest(giftusers)u CROSS JOIN(VALUES('original_admission_funding_missing'),('participant_earning_ownership_receipt_invalid'))reason(v)
   WHERE (SELECT count(*)FROM jsonb_array_elements(old->'issues')i WHERE i=jsonb_build_object('reason',reason.v,'user_id',u))<>1) THEN RETURN NULL;END IF;
 RETURN old||fresh||jsonb_build_object('original_treasury_outcome_proof',jsonb_build_object('original_outcome_md5',md5(p_outcome::text),'original_evidence_md5',md5(old::text),'original_payload_hash',p.payload_hash,'gift_users',to_jsonb(giftusers)));
EXCEPTION WHEN no_data_found OR invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $outcome$;
REVOKE ALL ON FUNCTION smarter_private.original_treasury_cash_outcome_evidence(jsonb) FROM PUBLIC,anon,authenticated,service_role;
