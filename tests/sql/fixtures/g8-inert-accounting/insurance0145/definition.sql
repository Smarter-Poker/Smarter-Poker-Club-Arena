-- INERT, OWNER-ONLY SOURCE. No active caller; never returns accepted authority.
-- Successor to sealed0141, using the finite0184 source correction contract.
-- j is the REDUCED application journal; q retains original RAW saved records.
-- Neither argument independently proves original source custody. In particular,
-- ApplicationOriginal contains no table club, winners/wonAmt or pinned maxSeats.
-- This function must not be installed or wired as a financial authority.
CREATE FUNCTION smarter_private.insurance_projection_0144(j jsonb,q jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path TO pg_catalog
AS $function$
DECLARE
 a jsonb; seats jsonb; records jsonb; s jsonb; r jsonb; p jsonb; d jsonb; item jsonb;
 expected jsonb := '[]'; projection jsonb := '[]'; selected jsonb;
 canonical_dealt_times jsonb := '{}'; normalized_record jsonb;
 roles text[]; role text; key text; n bigint; delta numeric; wanted numeric;
 total numeric := 0; subtotal numeric; premium numeric; credit numeric;
 ordinary numeric; redirect numeric; before_value numeric; raw_value numeric;
 journal_premium numeric; journal_payout numeric; saved_kind text;
 limit_cents constant numeric := 9007199254740991;
 -- ApplicationCapture's proposed envelope; not a qualified catalog maxSeats.
 proposed_max_seats constant integer := 10;
 uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
 is_admission boolean; stamp text; parts text[]; month_days integer[];
 yr integer; mo integer; dy integer; hr integer; mi integer; sec integer;
 offset_minutes integer; micros integer; utc_stamp timestamp without time zone;
 canonical_stamp text;
BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR jsonb_typeof(q) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'IP0144_OBJECT_REQUIRED';
 END IF;
 IF octet_length(q::text)>262144 OR octet_length(j::text)>65536 THEN
  RAISE EXCEPTION 'IP0144_PROPOSED_SIZE_BOUND';
 END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(q))<>12
   OR NOT(q ?& ARRAY['p_table_id','p_hand_number','p_stacks','p_rake','p_bbj','p_ref','p_inflow','p_hand_row','p_units','p_instance_id','p_lease_generation','p_post_commit_obligations'])
   OR q->'p_ref' IS DISTINCT FROM 'null'::jsonb THEN
  RAISE EXCEPTION 'IP0144_ORIGINAL_Q_NULL_REF_REQUIRED';
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
  RAISE EXCEPTION 'IP0144_CAPTURE_SHAPE';
 END IF;
 IF jsonb_array_length(seats) NOT BETWEEN 2 AND proposed_max_seats
  OR jsonb_array_length(a->'participants')<>jsonb_array_length(seats)
  OR jsonb_array_length(j->'records')>proposed_max_seats
  OR jsonb_array_length(records)<>jsonb_array_length(j->'records')
  OR jsonb_array_length(j->'stages')>256 THEN
  RAISE EXCEPTION 'IP0144_CARDINALITY';
 END IF;
 -- Compare COMPLETE saved arrays, including metadata and original order.
 -- Equal arrays still do not prove that either is the original captured q.
 IF records IS DISTINCT FROM q->'p_hand_row'->'_accepted_post_commit_facts'->'insurance' THEN
  RAISE EXCEPTION 'IP0144_SAVED_RECORDS_DIFFER';
 END IF;

 -- Validate both mapped domains before any identity join. Admission UUIDs
 -- must already have the decoder's lowercase canonical spelling; no lease
 -- UUID version restriction is invented for a seat, user, club or occupancy.
 FOR item,is_admission IN
  SELECT value,true FROM jsonb_array_elements(a->'participants')
  UNION ALL SELECT value,false FROM jsonb_array_elements(seats)
 LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'IP0144_ID_DOMAIN';
  END IF;
  FOREACH key IN ARRAY (CASE WHEN is_admission
    THEN ARRAY['userId','seatId','occupancyId','clubId']
    ELSE ARRAY['user_id','seat_id','occupancy_id'] END) LOOP
   IF jsonb_typeof(item->key) IS DISTINCT FROM 'string' OR item->>key !~ uuid_pattern THEN
    RAISE EXCEPTION 'IP0144_ID_DOMAIN';
   END IF;
  END LOOP;
  key:=CASE WHEN is_admission THEN 'seatNumber' ELSE 'seat_number' END;
  IF jsonb_typeof(item->key) IS DISTINCT FROM 'number' THEN
   RAISE EXCEPTION 'IP0144_CHAIR_DOMAIN';
  END IF;
  raw_value:=(item->>key)::numeric;
  IF raw_value<>trunc(raw_value) OR raw_value<1 OR raw_value>proposed_max_seats THEN
   RAISE EXCEPTION 'IP0144_CHAIR_DOMAIN';
  END IF;
  key:=CASE WHEN is_admission THEN 'seatJoinedAt' ELSE 'seat_joined_at' END;
  IF jsonb_typeof(item->key) IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION 'IP0144_TIMESTAMP_DOMAIN';
  END IF;
  stamp:=item->>key;
  IF is_admission AND stamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' THEN
   RAISE EXCEPTION 'IP0144_TIMESTAMP_DOMAIN';
  END IF;
  parts:=regexp_match(stamp,'^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?(Z|[+-][0-9]{2}:[0-9]{2})$');
  IF parts IS NULL THEN RAISE EXCEPTION 'IP0144_TIMESTAMP_DOMAIN'; END IF;
  yr:=parts[1]::integer; mo:=parts[2]::integer; dy:=parts[3]::integer;
  hr:=parts[4]::integer; mi:=parts[5]::integer; sec:=parts[6]::integer;
  month_days:=ARRAY[31,CASE WHEN yr%4=0 AND (yr%100<>0 OR yr%400=0) THEN 29 ELSE 28 END,31,30,31,30,31,31,30,31,30,31];
  IF yr<1 OR mo NOT BETWEEN 1 AND 12 OR dy<1 OR dy>month_days[mo]
   OR hr>23 OR mi>59 OR sec>59 THEN
   RAISE EXCEPTION 'IP0144_TIMESTAMP_DOMAIN';
  END IF;
  offset_minutes:=0;
  IF parts[8]<>'Z' THEN
   IF substring(parts[8] FROM 2 FOR 2)::integer>15
    OR substring(parts[8] FROM 5 FOR 2)::integer>59 OR parts[8]='-00:00' THEN
    RAISE EXCEPTION 'IP0144_TIMESTAMP_DOMAIN';
   END IF;
   offset_minutes:=(substring(parts[8] FROM 2 FOR 2)::integer*60
     +substring(parts[8] FROM 5 FOR 2)::integer)
     *CASE WHEN left(parts[8],1)='+' THEN 1 ELSE -1 END;
  END IF;
  micros:=rpad(COALESCE(parts[7],''),6,'0')::integer;
  -- No permissive timestamptz parser, Date truncation or session time zone.
  utc_stamp:=make_timestamp(yr,mo,dy,hr,mi,sec)
    +micros*interval '1 microsecond'-offset_minutes*interval '1 minute';
  IF utc_stamp<timestamp '0001-01-01 00:00:00'
   OR utc_stamp>=timestamp '10000-01-01 00:00:00' THEN
   RAISE EXCEPTION 'IP0144_TIMESTAMP_DOMAIN';
  END IF;
  canonical_stamp:=to_char(utc_stamp,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  IF is_admission THEN
   IF stamp<>canonical_stamp THEN RAISE EXCEPTION 'IP0144_TIMESTAMP_DOMAIN'; END IF;
  ELSE
   canonical_dealt_times:=canonical_dealt_times||jsonb_build_object(item->>'user_id',canonical_stamp);
  END IF;
 END LOOP;
 FOREACH key IN ARRAY ARRAY['userId','seatId','occupancyId','seatNumber'] LOOP
  IF (SELECT count(DISTINCT value->key) FROM jsonb_array_elements(a->'participants'))<>jsonb_array_length(seats) THEN
   RAISE EXCEPTION 'IP0144_DUPLICATE_OR_MISSING_ID';
  END IF;
 END LOOP;
 FOREACH key IN ARRAY ARRAY['user_id','seat_id','occupancy_id','seat_number'] LOOP
  IF (SELECT count(DISTINCT value->key) FROM jsonb_array_elements(seats))<>jsonb_array_length(seats) THEN
   RAISE EXCEPTION 'IP0144_DUPLICATE_OR_MISSING_ID';
  END IF;
 END LOOP;
 FOR p IN SELECT value FROM jsonb_array_elements(a->'participants') LOOP
  SELECT value INTO d FROM jsonb_array_elements(seats) WHERE value->>'user_id'=p->>'userId';
  IF d IS NULL OR p->'seatId' IS DISTINCT FROM d->'seat_id'
   OR p->'occupancyId' IS DISTINCT FROM d->'occupancy_id'
   OR p->'seatNumber' IS DISTINCT FROM d->'seat_number'
   OR p->'seatJoinedAt' IS DISTINCT FROM canonical_dealt_times->(d->>'user_id') THEN
   RAISE EXCEPTION 'IP0144_ADMISSION_DEALT_BIJECTION';
  END IF;
 END LOOP;

 -- Raw q metadata is mandatory despite the historical processor's defaults.
 -- Reject raw negatives/range BEFORE reproducing the writer's cent rounding.
 FOR d IN SELECT value FROM jsonb_array_elements(records) LOOP
  IF jsonb_typeof(d) IS DISTINCT FROM 'object'
   OR jsonb_typeof(d->'club_id') IS DISTINCT FROM 'string'
   OR d->>'club_id' !~ uuid_pattern
   OR jsonb_typeof(d->'equity_percent') IS DISTINCT FROM 'number'
   OR jsonb_typeof(d->'insured_amount') IS DISTINCT FROM 'number'
   OR jsonb_typeof(d->'player_won') IS DISTINCT FROM 'boolean' THEN
   RAISE EXCEPTION 'IP0144_SAVED_RECORD_METADATA';
  END IF;
  IF jsonb_typeof(d->'player_id') IS DISTINCT FROM 'string' OR d->>'player_id' !~ uuid_pattern THEN
   RAISE EXCEPTION 'IP0144_ID_DOMAIN';
  END IF;
  FOREACH key IN ARRAY ARRAY['premium','payout','insured_amount','equity_percent'] LOOP
   IF jsonb_typeof(d->key) IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'IP0144_RAW_AMOUNT_DOMAIN';
   END IF;
   raw_value:=(d->>key)::numeric;
   IF raw_value<0 OR raw_value*100>limit_cents
    OR round(raw_value,2)*100>limit_cents
    OR (key='equity_percent' AND raw_value>100) THEN
    RAISE EXCEPTION 'IP0144_RAW_AMOUNT_DOMAIN';
   END IF;
  END LOOP;
  IF d ? 'kind' AND d->'kind'<>'null'::jsonb AND jsonb_typeof(d->'kind') IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION 'IP0144_SAVED_KIND_MISMATCH';
  END IF;
  saved_kind:=COALESCE(NULLIF(d->>'kind',''),'insurance');
  IF saved_kind NOT IN ('insurance','ev_cashout') THEN
   RAISE EXCEPTION 'IP0144_SAVED_KIND_MISMATCH';
  END IF;
  SELECT value INTO p FROM jsonb_array_elements(a->'participants') WHERE value->>'userId'=d->>'player_id';
  IF p IS NULL OR d->'club_id' IS DISTINCT FROM p->'clubId' THEN
   RAISE EXCEPTION 'IP0144_CLUB_ASSOCIATION';
  END IF;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(j->'records') LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object'
   OR jsonb_typeof(r->'playerId') IS DISTINCT FROM 'string' OR r->>'playerId' !~ uuid_pattern
   OR jsonb_typeof(r->'kind') IS DISTINCT FROM 'string'
   OR r->>'kind' NOT IN ('ordinary','insurance','ev_cashout')
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(seats) x WHERE x->>'user_id'=r->>'playerId') THEN
   RAISE EXCEPTION 'IP0144_RECORD_PROFILE';
  END IF;
  FOREACH key IN ARRAY ARRAY['premium','payout'] LOOP
   IF jsonb_typeof(r->key) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'IP0144_JOURNAL_INTENT'; END IF;
   raw_value:=(r->>key)::numeric*100;
   IF raw_value<0 OR raw_value>limit_cents OR trunc(raw_value)<>raw_value THEN
    RAISE EXCEPTION 'IP0144_JOURNAL_INTENT';
   END IF;
  END LOOP;
 END LOOP;
 IF (SELECT count(DISTINCT x->>'playerId') FROM jsonb_array_elements(j->'records') x)<>jsonb_array_length(records)
  OR (SELECT count(DISTINCT x->>'player_id') FROM jsonb_array_elements(records) x)<>jsonb_array_length(records) THEN
  RAISE EXCEPTION 'IP0144_DUPLICATE_OR_MISSING_ID';
 END IF;

 -- Preserve ORIGINAL global order; grouping must never manufacture order.
 FOR r IN SELECT value FROM jsonb_array_elements(j->'records') WITH ORDINALITY ORDER BY ordinality LOOP
  SELECT value INTO d FROM jsonb_array_elements(records) WHERE value->>'player_id'=r->>'playerId';
  IF d IS NULL OR (r->>'kind'='ordinary' AND d->>'kind' IS NOT NULL)
   OR (r->>'kind'<>'ordinary' AND d->>'kind' IS DISTINCT FROM r->>'kind') THEN
   -- ordinary is ONLY the reduced journal's null/undefined default, never a
   -- newly accepted raw writer kind or a synonym for explicit insurance.
   RAISE EXCEPTION 'IP0144_SAVED_KIND_MISMATCH';
  END IF;
  roles:=CASE WHEN r->>'kind'='ev_cashout' THEN ARRAY['payout','ev_redirect','ordinary_premium'] ELSE ARRAY['payout','ordinary_premium'] END;
  FOREACH role IN ARRAY roles LOOP
   expected:=expected||jsonb_build_array(jsonb_build_object('userId',r->>'playerId','kind',role));
  END LOOP;
 END LOOP;
 IF jsonb_array_length(j->'stages')<>jsonb_array_length(expected) THEN
  RAISE EXCEPTION 'IP0144_GLOBAL_ROSTER_OR_NONINSURANCE';
 END IF;
 FOR s,n IN SELECT value,ordinality FROM jsonb_array_elements(j->'stages') WITH ORDINALITY ORDER BY ordinality LOOP
  IF s->'ordinal' IS DISTINCT FROM to_jsonb(n-1)
   OR s->'userId' IS DISTINCT FROM expected->(n::integer-1)->'userId'
   OR s->'kind' IS DISTINCT FROM expected->(n::integer-1)->'kind' THEN
   RAISE EXCEPTION 'IP0144_GLOBAL_ORDER';
  END IF;
  FOREACH key IN ARRAY ARRAY['before','after','debit','credit','intended'] LOOP
   IF jsonb_typeof(s->key) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'IP0144_MISSING_CENTS'; END IF;
   IF (s->>key)::numeric<0 OR (s->>key)::numeric>limit_cents OR trunc((s->>key)::numeric)<>(s->>key)::numeric THEN
    RAISE EXCEPTION 'IP0144_CENTS_DOMAIN';
   END IF;
  END LOOP;
  delta:=(s->>'after')::numeric-(s->>'before')::numeric;
  IF (s->>'debit')::numeric<>greatest(0,-delta)
   OR (s->>'credit')::numeric<>greatest(0,delta)
   OR s->>'disposition' IS NULL OR s->>'disposition' NOT IN ('applied','observed_noop')
   OR (s->>'disposition'='observed_noop') IS DISTINCT FROM (delta=0) THEN
   RAISE EXCEPTION 'IP0144_STAGE_COMPONENT';
  END IF;
  wanted:=CASE WHEN s->>'kind'='payout' THEN (s->>'intended')::numeric
    ELSE -least((s->>'before')::numeric,(s->>'intended')::numeric) END;
  IF delta<>wanted THEN RAISE EXCEPTION 'IP0144_STAGE_INTENT'; END IF;
  SELECT value INTO r FROM jsonb_array_elements(j->'records') WHERE value->>'playerId'=s->>'userId';
  IF (s->>'kind'='payout' AND (s->>'intended')::numeric<>(r->>'payout')::numeric*100)
   OR (s->>'kind'='ordinary_premium' AND (s->>'intended')::numeric<>(r->>'premium')::numeric*100) THEN
   RAISE EXCEPTION 'IP0144_JOURNAL_INTENT';
  END IF;
  -- EV intent is original wonAmt, NOT saved bank premium or journal premium.
  -- Its source is unavailable in these two arguments; leave that gap explicit.
  total:=total+delta;
  IF abs(total)>limit_cents THEN RAISE EXCEPTION 'IP0144_GLOBAL_INTERMEDIATE_RANGE'; END IF;
 END LOOP;
 FOR p IN SELECT value FROM jsonb_array_elements(a->'participants') WITH ORDINALITY ORDER BY ordinality LOOP
  subtotal:=0;credit:=0;ordinary:=0;redirect:=0;before_value:=NULL;selected:='[]';
  FOR s IN SELECT value FROM jsonb_array_elements(j->'stages') WITH ORDINALITY
    WHERE value->>'userId'=p->>'userId' ORDER BY ordinality LOOP
   IF before_value IS NOT NULL AND before_value<>(s->>'before')::numeric THEN RAISE EXCEPTION 'IP0144_PLAYER_CHAIN'; END IF;
   before_value:=(s->>'after')::numeric;
   subtotal:=subtotal+(s->>'credit')::numeric-(s->>'debit')::numeric;
   IF abs(subtotal)>limit_cents THEN RAISE EXCEPTION 'IP0144_PLAYER_INTERMEDIATE_RANGE'; END IF;
   IF s->>'kind'='payout' THEN credit:=(s->>'credit')::numeric;
   ELSIF s->>'kind'='ev_redirect' THEN redirect:=(s->>'debit')::numeric;
   ELSE ordinary:=(s->>'debit')::numeric; END IF;
   selected:=selected||jsonb_build_array(jsonb_build_object('local_ordinal',jsonb_array_length(selected)+1,'original_stage',s));
  END LOOP;
  normalized_record:=NULL;
  SELECT value INTO r FROM jsonb_array_elements(records) WHERE value->>'player_id'=p->>'userId';
  IF r IS NOT NULL THEN
   SELECT (value->>'premium')::numeric*100,(value->>'payout')::numeric*100
     INTO journal_premium,journal_payout FROM jsonb_array_elements(j->'records') WHERE value->>'playerId'=p->>'userId';
   saved_kind:=COALESCE(NULLIF(r->>'kind',''),'insurance');
   premium:=round((r->>'premium')::numeric,2)*100;
   -- Ordinary saved premium derives from original settlement premium, not
   -- the clamped debit. Require BOTH that intent relation and the actual
   -- bank component; lowering q premium to a smaller debit cannot pass.
   -- Raw q may retain extra fractional digits; normalized equality here
   -- does not certify that it was the actual original settlement record.
   IF credit<>round((r->>'payout')::numeric,2)*100 OR credit<>journal_payout
    OR (saved_kind='ev_cashout' AND (journal_premium<>0 OR ordinary<>0 OR redirect<>premium))
    OR (saved_kind='insurance' AND (redirect<>0 OR ordinary<>premium OR premium<>journal_premium)) THEN
    RAISE EXCEPTION 'IP0144_APPLIED_RECORD_COMPONENT';
   END IF;
   normalized_record:=r||jsonb_build_object('premium',round((r->>'premium')::numeric,2),
     'payout',round((r->>'payout')::numeric,2),'insured_amount',round((r->>'insured_amount')::numeric,2),
     'equity_percent',round((r->>'equity_percent')::numeric,2),'kind',saved_kind);
  ELSIF jsonb_array_length(selected)>0 THEN RAISE EXCEPTION 'IP0144_SAVED_PLAYER_MISSING'; END IF;
  projection:=projection||jsonb_build_array(jsonb_build_object('original_participant',p,'stages',selected,
    'saved_insurance_record',r,'writer_normalized_record',normalized_record,'insurance_delta',subtotal));
 END LOOP;
 RETURN jsonb_build_object('status','source_authority_unqualified','accepted',false,
  'global_stages',j->'stages','admission_participants',a->'participants','dealt_participants',seats,
  'per_player',projection,'saved_insurance_records',records,'original_q',q,'insurance_delta',total,
  'gaps',jsonb_build_array('canonical_custody_binding_unqualified','cash_provider_epoch_unqualified',
    'current_wrapper_processor_unqualified','original_table_club_source_unavailable',
    'original_ev_won_amount_source_unavailable','original_full_record_origin_unqualified',
    'seat_capacity_catalog_unqualified','storage_and_composed_hand_limits_unqualified'));
END;
$function$;
ALTER FUNCTION smarter_private.insurance_projection_0144(jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.insurance_projection_0144(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,authenticator;
