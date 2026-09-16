-- INERT, OWNER-ONLY SOURCE. No active caller; never returns accepted authority.
CREATE FUNCTION smarter_private.insurance_projection_0141(j jsonb,q jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path TO pg_catalog
AS $function$
DECLARE
 a jsonb; seats jsonb; records jsonb; s jsonb; r jsonb; p jsonb; d jsonb;
 expected jsonb := '[]'; projection jsonb := '[]'; selected jsonb;
 roles text[]; role text; key text; n bigint; delta numeric;
 total numeric := 0; subtotal numeric; premium numeric; credit numeric;
 ordinary numeric; redirect numeric; before_value numeric;
 limit_cents constant numeric := 9007199254740991;
BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR jsonb_typeof(q) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'IP0141_OBJECT_REQUIRED';
 END IF;
 IF octet_length(q::text)>262144 OR octet_length(j::text)>65536 THEN
  RAISE EXCEPTION 'IP0141_PROPOSED_SIZE_BOUND';
 END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(q))<>12
   OR NOT(q ?& ARRAY['p_table_id','p_hand_number','p_stacks','p_rake','p_bbj','p_ref','p_inflow','p_hand_row','p_units','p_instance_id','p_lease_generation'])
   OR q->'p_ref' IS DISTINCT FROM 'null'::jsonb THEN
  RAISE EXCEPTION 'IP0141_ORIGINAL_Q_NULL_REF_REQUIRED';
 END IF;
 a:=j->'original'->'cashAssociation'->'originalAdmission';
 seats:=j->'original'->'seats';
 records:=q->'p_post_commit_obligations'->'insurance';
 IF jsonb_typeof(a) IS DISTINCT FROM 'object'
  OR jsonb_typeof(a->'participants') IS DISTINCT FROM 'array'
  OR jsonb_typeof(seats) IS DISTINCT FROM 'array'
  OR jsonb_typeof(j->'records') IS DISTINCT FROM 'array'
  OR jsonb_typeof(j->'stages') IS DISTINCT FROM 'array'
  OR jsonb_typeof(records) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'IP0141_CAPTURE_SHAPE';
 END IF;
 IF jsonb_array_length(seats) NOT BETWEEN 2 AND 10
  OR jsonb_array_length(a->'participants')<>jsonb_array_length(seats)
  OR jsonb_array_length(j->'records')>10 OR jsonb_array_length(records)<>jsonb_array_length(j->'records')
  OR jsonb_array_length(j->'stages')>256 THEN
  RAISE EXCEPTION 'IP0141_CARDINALITY';
 END IF;
 IF records IS DISTINCT FROM q->'p_hand_row'->'_accepted_post_commit_facts'->'insurance' THEN
  RAISE EXCEPTION 'IP0141_SAVED_RECORDS_DIFFER';
 END IF;
 -- Canonical producer fields must be retained; string comparison is not
 -- canonical admission proof. This helper never supplies that missing proof.
 IF (SELECT count(DISTINCT x->>'userId') FROM jsonb_array_elements(a->'participants') x)<>jsonb_array_length(seats)
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(seats) x)<>jsonb_array_length(seats)
 OR (SELECT count(DISTINCT x->>'playerId') FROM jsonb_array_elements(j->'records') x)<>jsonb_array_length(records)
 OR (SELECT count(DISTINCT x->>'player_id') FROM jsonb_array_elements(records) x)<>jsonb_array_length(records) THEN
  RAISE EXCEPTION 'IP0141_DUPLICATE_OR_MISSING_ID';
 END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(a->'participants') LOOP
  SELECT value INTO d FROM jsonb_array_elements(seats) WHERE value->>'user_id'=p->>'userId';
  IF d IS NULL OR p->>'seatId' IS NULL OR p->>'occupancyId' IS NULL OR p->>'seatJoinedAt' IS NULL
   OR p->'seatId' IS DISTINCT FROM d->'seat_id' OR p->'occupancyId' IS DISTINCT FROM d->'occupancy_id'
   OR p->'seatJoinedAt' IS DISTINCT FROM d->'seat_joined_at' OR p->'seatNumber' IS DISTINCT FROM d->'seat_number' THEN
   RAISE EXCEPTION 'IP0141_ADMISSION_DEALT_BIJECTION';
  END IF;
 END LOOP;
 -- Expected GLOBAL sequence comes from retained original settlement order.
 FOR r IN SELECT value FROM jsonb_array_elements(j->'records') LOOP
  IF r->>'kind' IS NULL OR r->>'kind' NOT IN ('ordinary','insurance','ev_cashout')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(seats) x WHERE x->>'user_id'=r->>'playerId') THEN
   RAISE EXCEPTION 'IP0141_RECORD_PROFILE';
  END IF;
  SELECT value INTO d FROM jsonb_array_elements(records) WHERE value->>'player_id'=r->>'playerId';
  IF d IS NULL OR d->>'kind' IS DISTINCT FROM CASE WHEN r->>'kind'='ordinary' THEN 'insurance' ELSE r->>'kind' END THEN
   RAISE EXCEPTION 'IP0141_SAVED_KIND_MISMATCH';
  END IF;
  roles:=CASE WHEN r->>'kind'='ev_cashout' THEN ARRAY['payout','ev_redirect','ordinary_premium'] ELSE ARRAY['payout','ordinary_premium'] END;
  FOREACH role IN ARRAY roles LOOP
   expected:=expected||jsonb_build_array(jsonb_build_object('userId',r->>'playerId','kind',role));
  END LOOP;
 END LOOP;
 IF jsonb_array_length(j->'stages')<>jsonb_array_length(expected) THEN
  RAISE EXCEPTION 'IP0141_GLOBAL_ROSTER_OR_NONINSURANCE';
 END IF;
 FOR s,n IN SELECT value,ordinality FROM jsonb_array_elements(j->'stages') WITH ORDINALITY LOOP
  IF s->'ordinal' IS DISTINCT FROM to_jsonb(n-1)
   OR s->'userId' IS DISTINCT FROM expected->(n::integer-1)->'userId'
   OR s->'kind' IS DISTINCT FROM expected->(n::integer-1)->'kind' THEN
   RAISE EXCEPTION 'IP0141_GLOBAL_ORDER';
  END IF;
  FOREACH key IN ARRAY ARRAY['before','after','debit','credit','intended'] LOOP
   IF jsonb_typeof(s->key) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'IP0141_MISSING_CENTS'; END IF;
   IF (s->>key)::numeric<0 OR (s->>key)::numeric>limit_cents OR trunc((s->>key)::numeric)<>(s->>key)::numeric THEN
    RAISE EXCEPTION 'IP0141_CENTS_DOMAIN';
   END IF;
  END LOOP;
  delta:=(s->>'after')::numeric-(s->>'before')::numeric;
  IF delta<>(s->>'credit')::numeric-(s->>'debit')::numeric
   OR (s->>'kind'='payout' AND (s->>'debit')::numeric<>0)
   OR (s->>'kind'<>'payout' AND (s->>'credit')::numeric<>0)
   OR s->>'disposition' IS NULL OR s->>'disposition' NOT IN ('applied','observed_noop')
   OR (s->>'disposition'='observed_noop') IS DISTINCT FROM ((s->>'credit')::numeric=0 AND (s->>'debit')::numeric=0) THEN
   RAISE EXCEPTION 'IP0141_STAGE_COMPONENT';
  END IF;
  total:=total+delta;
  IF abs(total)>limit_cents THEN RAISE EXCEPTION 'IP0141_GLOBAL_INTERMEDIATE_RANGE'; END IF;
 END LOOP;
 FOR p IN SELECT value FROM jsonb_array_elements(a->'participants') LOOP
  subtotal:=0;credit:=0;ordinary:=0;redirect:=0;before_value:=NULL;selected:='[]';
  FOR s IN SELECT value FROM jsonb_array_elements(j->'stages') WHERE value->>'userId'=p->>'userId' LOOP
   IF before_value IS NOT NULL AND before_value<>(s->>'before')::numeric THEN RAISE EXCEPTION 'IP0141_PLAYER_CHAIN'; END IF;
   before_value:=(s->>'after')::numeric;
   subtotal:=subtotal+(s->>'credit')::numeric-(s->>'debit')::numeric;
   IF abs(subtotal)>limit_cents THEN RAISE EXCEPTION 'IP0141_PLAYER_INTERMEDIATE_RANGE'; END IF;
   IF s->>'kind'='payout' THEN credit:=(s->>'credit')::numeric;
   ELSIF s->>'kind'='ev_redirect' THEN redirect:=(s->>'debit')::numeric;
   ELSE ordinary:=(s->>'debit')::numeric; END IF;
   selected:=selected||jsonb_build_array(jsonb_build_object('local_ordinal',jsonb_array_length(selected)+1,'original_stage',s));
  END LOOP;
  SELECT value INTO r FROM jsonb_array_elements(records) WHERE value->>'player_id'=p->>'userId';
  IF r IS NOT NULL THEN
   IF jsonb_typeof(r->'premium') IS DISTINCT FROM 'number' OR jsonb_typeof(r->'payout') IS DISTINCT FROM 'number'
    OR r->>'kind' IS NULL OR r->>'kind' NOT IN ('insurance','ev_cashout') THEN RAISE EXCEPTION 'IP0141_NORMALIZED_RECORD'; END IF;
   premium:=round((r->>'premium')::numeric,2)*100;
   IF premium<0 OR premium>limit_cents OR (r->>'payout')::numeric<0
    OR credit<>round((r->>'payout')::numeric,2)*100
    OR (r->>'kind'='ev_cashout' AND (ordinary<>0 OR redirect<>premium))
    OR (r->>'kind'='insurance' AND (redirect<>0 OR ordinary<>premium)) THEN RAISE EXCEPTION 'IP0141_APPLIED_RECORD_COMPONENT'; END IF;
  ELSIF jsonb_array_length(selected)>0 THEN RAISE EXCEPTION 'IP0141_SAVED_PLAYER_MISSING'; END IF;
  projection:=projection||jsonb_build_array(jsonb_build_object('original_participant',p,'stages',selected,'insurance_delta',subtotal));
 END LOOP;
 RETURN jsonb_build_object('status','source_authority_unqualified','accepted',false,
  'global_stages',j->'stages','admission_participants',a->'participants','dealt_participants',seats,
  'per_player',projection,'saved_insurance_records',records,'insurance_delta',total,
  'gaps',jsonb_build_array('canonical_custody_binding_unqualified','cash_provider_epoch_unqualified','current_wrapper_processor_unqualified'));
END
$function$;
ALTER FUNCTION smarter_private.insurance_projection_0141(jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.insurance_projection_0141(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,authenticator;
