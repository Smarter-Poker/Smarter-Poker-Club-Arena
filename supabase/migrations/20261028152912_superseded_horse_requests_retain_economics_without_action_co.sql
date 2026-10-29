-- @live-proof: (SELECT to_regprocedure('smarter_private.compact_superseded_horse_actions(uuid[])') IS NOT NULL AND position('superseded_horse_action_certificates' IN pg_get_functiondef('smarter_private.assert_retained_hand_submission(jsonb)'::regprocedure))>0)
-- Only the action-array copy of an eight-day-old, receipted, never-accepted
-- horse cash request may retire. Every financial DTO field, original identity,
-- request digest and disposal stays unchanged. No hand/accounting row deletion,
-- scheduler, hot-table rewrite or retention-policy change. The original resume
-- excludes disposal receipts; explicit fences below also refuse direct replay
-- of both the original and compacted envelopes before monetary code can run.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='30s';
DO $preimage$
DECLARE sig text; expected text;
BEGIN
 IF to_regclass('smarter_private.superseded_horse_action_certificates') IS NOT NULL THEN
  RAISE EXCEPTION 'SUPERSEDED_ACTION_RETENTION_ALREADY_INSTALLED' USING ERRCODE='55000'; END IF;
 FOR sig,expected IN SELECT * FROM (VALUES
 ('smarter_private.hand_submission_immutable()','6f296df045f0b2d885cec1509932c118'),
 ('smarter_private.assert_retained_hand_submission(jsonb)','6a3ab631fdab87ae9bcd353907de80b6'),
 ('public.fn_ca_commit_hand_submission(uuid,text,uuid)','3862a54ed5cdcc85baca967aa3878878'),
 ('smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)','6a80a96fcf4f13f8cd734f35169f16d7'),
 ('public.fn_ca_dispose_superseded_hand_submissions(uuid,uuid,text,integer)','49cdcb82f78a26a875c5abf7e17381a0'),
 ('smarter_private.original_inventory_source_ref_md5(jsonb)','81fba77f13564999931e8a7a47cbd609'),
 ('smarter_private.original_hand_correction_sources_match()','b235c4e928096546f3cae16732a1bb34')) q(sig,expected)
 LOOP
  IF (SELECT p.proowner='postgres'::regrole AND p.proacl::text=CASE
   WHEN sig LIKE 'public.%' THEN '{postgres=X/postgres,service_role=X/postgres}'
   ELSE '{postgres=X/postgres}' END FROM pg_proc p WHERE oid=sig::regprocedure) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'SUPERSEDED_ACTION_PREIMAGE_AUTHORITY_CHANGED: %',sig USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef(sig::regprocedure)) IS DISTINCT FROM expected THEN
   RAISE EXCEPTION 'SUPERSEDED_ACTION_PREIMAGE_CHANGED: %',sig USING ERRCODE='55000'; END IF;
 END LOOP;
END $preimage$;

CREATE TABLE smarter_private.superseded_horse_action_certificates(
 submission_id uuid PRIMARY KEY, table_id uuid NOT NULL, hand_number bigint NOT NULL,
 receipt_id uuid NOT NULL, original_request_sha256 text NOT NULL CHECK(original_request_sha256~'^[a-f0-9]{64}$'),
 compact_request_sha256 text NOT NULL CHECK(compact_request_sha256~'^[a-f0-9]{64}$'),
 original_actions_sha256 text NOT NULL CHECK(original_actions_sha256~'^[a-f0-9]{64}$'),
 disposal_sha256 text NOT NULL CHECK(disposal_sha256~'^[a-f0-9]{64}$'),
 immutable_identity_sha256 text NOT NULL CHECK(immutable_identity_sha256~'^[a-f0-9]{64}$'),
 economic_sha256 text NOT NULL CHECK(economic_sha256~'^[a-f0-9]{64}$'),
 compacted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(table_id,hand_number)
);
ALTER TABLE smarter_private.superseded_horse_action_certificates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.superseded_horse_action_certificates FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.superseded_horse_actions_eligible(p_submission uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE s smarter_private.hand_submissions; d smarter_private.hand_submission_disposals;
BEGIN
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=p_submission;
 IF NOT FOUND OR s.retained_at IS NULL OR NOT isfinite(s.retained_at) OR s.retained_at>=statement_timestamp()-interval '8 days'
 OR (SELECT horse_retention_days FROM public.hand_history_retention_policy LIMIT 1) IS DISTINCT FROM 8
 OR s.request#>'{p_hand_row,has_human}' IS DISTINCT FROM 'false'::jsonb
 OR s.request#>'{p_hand_row,tournament_id}' IS DISTINCT FROM 'null'::jsonb
 OR s.request#>>'{p_hand_row,reported}'='true'
 OR jsonb_typeof(s.request#>'{p_hand_row,actions}') IS DISTINCT FROM 'array'
 OR encode(extensions.digest(convert_to(s.request::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM s.request_hash
 OR jsonb_typeof(s.request#>'{p_hand_row,players}') IS DISTINCT FROM 'array'
 OR NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=s.table_id AND t.tournament_id IS NULL)
 THEN RETURN false; END IF;
 -- Validate array shapes in the preceding statement before evaluating lengths.
 IF jsonb_array_length(s.request#>'{p_hand_row,actions}')=0
 OR jsonb_array_length(s.request#>'{p_hand_row,players}') NOT BETWEEN 1 AND 10
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.request#>'{p_hand_row,players}') actor
   LEFT JOIN public.profiles player ON player.id=(CASE WHEN pg_input_is_valid(actor->>'userId','uuid') THEN (actor->>'userId')::uuid END)
   WHERE player.id IS NULL OR player.is_horse IS DISTINCT FROM true)
 THEN RETURN false; END IF;
 -- A tiny raw array cannot repay even the bounded certificate allowance.
 -- Actual compressed net savings are checked after the transition, inside a
 -- per-row subtransaction, using a fresh stored-value point read.
 IF pg_column_size(s.request#>'{p_hand_row,actions}')<=4096 THEN RETURN false; END IF;
 SELECT * INTO d FROM smarter_private.hand_submission_disposals
 WHERE table_id=s.table_id AND hand_number=s.hand_number AND submission_id=s.submission_id;
 IF NOT FOUND OR d.expected->>'kind' NOT IN('superseded_retained_submission','superseded_by_later_commit')
 OR d.expected->>'kind' IS NULL OR d.witness_hand_number IS NULL OR d.receipt_id IS NULL OR d.witness_hand_number<=s.hand_number
 OR d.expected->>'table_id' IS DISTINCT FROM s.table_id::text
 OR d.expected->>'submission_id' IS DISTINCT FROM s.submission_id::text
 OR d.expected->>'hand_number' IS DISTINCT FROM s.hand_number::text
 OR d.expected->>'dealer_generation' IS DISTINCT FROM s.lease_generation::text
 OR d.expected->>'request_hash' IS DISTINCT FROM s.request_hash
 OR d.expected->>'witness_hand_number' IS DISTINCT FROM d.witness_hand_number::text
 OR d.expected->'tournament_id' IS DISTINCT FROM 'null'::jsonb
 OR d.expected->>'retained_at' IS NULL OR d.expected->>'disposed_at' IS NULL
 OR NOT pg_input_is_valid(d.expected->>'retained_at','timestamptz')
 OR NOT pg_input_is_valid(d.expected->>'disposed_at','timestamptz')
 OR (d.expected->>'retained_at')::timestamptz IS DISTINCT FROM s.retained_at
 OR NOT isfinite((d.expected->>'disposed_at')::timestamptz)
 OR (d.expected->>'disposed_at')::timestamptz<s.retained_at
 OR (d.expected->>'disposed_at')::timestamptz>clock_timestamp()
 THEN RETURN false; END IF;
 -- Only original unaccepted cash requests. A certificate never substitutes
 -- for any accepted hand, source-correction owner, outstanding claim or custody.
 IF EXISTS(SELECT 1 FROM public.hand_history h WHERE h.table_id=s.table_id AND h.hand_number=s.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs h WHERE h.submission_id=s.submission_id)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch h WHERE h.submission_id=s.submission_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.table_id=s.table_id AND h.hand_number=s.hand_number)
 OR EXISTS(SELECT 1 FROM public.engine_table_leases l WHERE l.table_id=s.table_id AND l.lease_generation=s.lease_generation)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=s.submission_id)
 OR EXISTS(SELECT 1 FROM public.bbj_payouts b WHERE b.table_id=s.table_id AND b.hand_number=s.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_source_corrections c WHERE c.submission_id=s.submission_id)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_correction_claims c WHERE c.submission_id=s.submission_id)
 OR EXISTS(SELECT 1 FROM smarter_private.retired_cash_hand_qualification c WHERE c.submission_id=s.submission_id)
 OR EXISTS(SELECT 1 FROM smarter_private.retired_cash_hand_custody c WHERE c.submission_id=s.submission_id)
 OR EXISTS(SELECT 1 FROM smarter_private.retirement_original_hand_qualification c WHERE c.submission_id=s.submission_id)
 OR EXISTS(SELECT 1 FROM smarter_private.superseded_horse_action_certificates c WHERE c.submission_id=s.submission_id)
 THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.superseded_horse_actions_eligible(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.superseded_horse_action_certificate_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE s smarter_private.hand_submissions; d smarter_private.hand_submission_disposals; economic jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SUPERSEDED_ACTION_CERTIFICATE_IMMUTABLE' USING ERRCODE='55000'; END IF;
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=NEW.submission_id;
 SELECT * INTO d FROM smarter_private.hand_submission_disposals WHERE table_id=s.table_id AND hand_number=s.hand_number AND submission_id=s.submission_id;
 economic:=jsonb_build_object('submission_id',s.submission_id,'request_hash',s.request_hash,'table_id',s.table_id,
 'hand_number',s.hand_number,'lease_generation',s.lease_generation,'stacks',s.request->'p_stacks','started_at',s.request#>>'{p_hand_row,started_at}');
 IF smarter_private.superseded_horse_actions_eligible(s.submission_id) IS DISTINCT FROM true
 OR (NEW.table_id,NEW.hand_number,NEW.receipt_id) IS DISTINCT FROM(s.table_id,s.hand_number,d.receipt_id)
 OR NEW.original_request_sha256 IS DISTINCT FROM s.request_hash
 OR NEW.compact_request_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to((s.request#-'{p_hand_row,actions}')::text,'UTF8'),'sha256'),'hex')
 OR NEW.original_actions_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to((s.request#>'{p_hand_row,actions}')::text,'UTF8'),'sha256'),'hex')
 OR NEW.disposal_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to(to_jsonb(d)::text,'UTF8'),'sha256'),'hex')
 OR NEW.immutable_identity_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to((to_jsonb(s)-'request')::text,'UTF8'),'sha256'),'hex')
 OR NEW.economic_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to(economic::text,'UTF8'),'sha256'),'hex')
 THEN RAISE EXCEPTION 'SUPERSEDED_ACTION_CERTIFICATE_UNPROVEN' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.superseded_horse_action_certificate_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER superseded_horse_action_certificate_guard BEFORE INSERT OR UPDATE OR DELETE ON smarter_private.superseded_horse_action_certificates
FOR EACH ROW EXECUTE FUNCTION smarter_private.superseded_horse_action_certificate_guard();
CREATE TRIGGER superseded_horse_action_certificate_no_truncate BEFORE TRUNCATE ON smarter_private.superseded_horse_action_certificates
FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.superseded_horse_action_certificate_guard();

CREATE FUNCTION smarter_private.compact_superseded_horse_actions(p_submissions uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET lock_timeout='100ms' AS $function$
DECLARE s smarter_private.hand_submissions; d smarter_private.hand_submission_disposals; n integer:=0;
 economic jsonb; old_bytes integer; after_bytes integer; certificate_bytes integer;
 deadline timestamptz:=clock_timestamp()+interval '1 second';
BEGIN
 IF p_submissions IS NULL OR cardinality(p_submissions)>100 OR array_position(p_submissions,NULL) IS NOT NULL THEN
 RAISE EXCEPTION 'SUPERSEDED_ACTION_BATCH_INVALID' USING ERRCODE='22023'; END IF;
 -- No broad scan or scheduler. The operator supplies at most100 actual IDs;
 -- original disposal doors supply only their own newly receipted IDs.
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR NOT pg_try_advisory_xact_lock_shared(530090,1) THEN RETURN 0; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RETURN 0; END IF;
 FOR s IN SELECT * FROM smarter_private.hand_submissions WHERE submission_id=ANY(p_submissions) ORDER BY submission_id FOR UPDATE SKIP LOCKED LOOP
  EXIT WHEN clock_timestamp()>=deadline;
  IF smarter_private.superseded_horse_actions_eligible(s.submission_id) IS DISTINCT FROM true THEN CONTINUE; END IF;
  SELECT * INTO STRICT d FROM smarter_private.hand_submission_disposals WHERE table_id=s.table_id AND hand_number=s.hand_number AND submission_id=s.submission_id;
  economic:=jsonb_build_object('submission_id',s.submission_id,'request_hash',s.request_hash,'table_id',s.table_id,
   'hand_number',s.hand_number,'lease_generation',s.lease_generation,'stacks',s.request->'p_stacks','started_at',s.request#>>'{p_hand_row,started_at}');
  SELECT pg_column_size(request) INTO old_bytes FROM smarter_private.hand_submissions WHERE submission_id=s.submission_id;
  BEGIN
  INSERT INTO smarter_private.superseded_horse_action_certificates(submission_id,table_id,hand_number,receipt_id,original_request_sha256,
   compact_request_sha256,original_actions_sha256,disposal_sha256,immutable_identity_sha256,economic_sha256)
  VALUES(s.submission_id,s.table_id,s.hand_number,d.receipt_id,s.request_hash,
   encode(extensions.digest(convert_to((s.request#-'{p_hand_row,actions}')::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to((s.request#>'{p_hand_row,actions}')::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to(to_jsonb(d)::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to((to_jsonb(s)-'request')::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to(economic::text,'UTF8'),'sha256'),'hex'));
  UPDATE smarter_private.hand_submissions SET request=request#-'{p_hand_row,actions}' WHERE submission_id=s.submission_id;
  -- RETURNING can expose a pre-TOAST slot. Read the actual stored replacement
  -- in the next statement, then charge the exact certificate tuple plus4KiB
  -- for tuple/index/page slack. The initial empty relation allocation is fixed
  -- migration overhead, measured separately in native qualification.
  SELECT pg_column_size(request) INTO after_bytes FROM smarter_private.hand_submissions WHERE submission_id=s.submission_id;
  SELECT pg_column_size(c) INTO certificate_bytes FROM smarter_private.superseded_horse_action_certificates c WHERE submission_id=s.submission_id;
  IF old_bytes-after_bytes<=certificate_bytes+4096 THEN
   RAISE EXCEPTION 'SUPERSEDED_ACTION_NO_NET_STORAGE_BENEFIT' USING ERRCODE='P5501'; END IF;
  n:=n+1;
  EXCEPTION WHEN SQLSTATE 'P5501' THEN
   -- Only this measured cost refusal rolls back its certificate and payload.
   -- All unrelated errors propagate to the original owning transaction.
   NULL;
  END;
 END LOOP;
 RETURN n;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.compact_superseded_horse_actions(uuid[]) FROM PUBLIC,anon,authenticated,service_role;

DO $patch$
DECLARE sig text; anchor text; replacement text; source text; metadata jsonb; actual jsonb;
BEGIN
 FOR sig,anchor,replacement IN SELECT * FROM (VALUES
 ('smarter_private.hand_submission_immutable()',
 $a$ IF TG_OP='UPDATE' AND TG_TABLE_SCHEMA='smarter_private' AND TG_TABLE_NAME='hand_submissions' THEN$a$,
 $b$ IF TG_OP='UPDATE' AND TG_TABLE_SCHEMA='smarter_private' AND TG_TABLE_NAME='hand_submissions' THEN
  IF NEW.request IS NOT DISTINCT FROM (OLD.request#-'{p_hand_row,actions}')
  AND OLD.request#>'{p_hand_row,actions}' IS NOT NULL
  AND (to_jsonb(NEW)-'request') IS NOT DISTINCT FROM(to_jsonb(OLD)-'request')
  AND EXISTS(SELECT 1 FROM smarter_private.superseded_horse_action_certificates c
   WHERE c.submission_id=OLD.submission_id AND c.table_id=OLD.table_id AND c.hand_number=OLD.hand_number
    AND c.original_request_sha256=OLD.request_hash
    AND c.original_request_sha256=encode(extensions.digest(convert_to(OLD.request::text,'UTF8'),'sha256'),'hex')
    AND c.compact_request_sha256=encode(extensions.digest(convert_to(NEW.request::text,'UTF8'),'sha256'),'hex')
    AND c.immutable_identity_sha256=encode(extensions.digest(convert_to((to_jsonb(OLD)-'request')::text,'UTF8'),'sha256'),'hex'))
  THEN RETURN NEW; END IF;$b$),
 ('smarter_private.assert_retained_hand_submission(jsonb)',
 $a$ IF NOT FOUND OR s.request IS NOT DISTINCT FROM p_request THEN RETURN; END IF;$a$,
 $b$ IF FOUND AND s.request#>'{p_hand_row,actions}' IS NULL
 AND EXISTS(SELECT 1 FROM smarter_private.superseded_horse_action_certificates c WHERE c.submission_id=s.submission_id) THEN
 RAISE EXCEPTION 'HAND_SUBMISSION_ACTIONS_RETIRED' USING ERRCODE='55000'; END IF;
 IF NOT FOUND OR s.request IS NOT DISTINCT FROM p_request THEN RETURN; END IF;$b$),
 ('public.fn_ca_commit_hand_submission(uuid,text,uuid)',
 $a$ q:=s.request;$a$,
 $b$ IF s.request#>'{p_hand_row,actions}' IS NULL AND EXISTS(SELECT 1 FROM smarter_private.superseded_horse_action_certificates c WHERE c.submission_id=s.submission_id) THEN
 RAISE EXCEPTION 'HAND_SUBMISSION_ACTIONS_RETIRED' USING ERRCODE='55000'; END IF;
 q:=s.request;$b$),
 ('smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)',
 $a$  RETURN v_disposed;$a$,
 $b$  PERFORM smarter_private.compact_superseded_horse_actions(ARRAY(SELECT submission_id FROM smarter_private.hand_submission_disposals WHERE receipt_id=v_receipt ORDER BY submission_id LIMIT 5));
  RETURN v_disposed;$b$),
 ('public.fn_ca_dispose_superseded_hand_submissions(uuid,uuid,text,integer)',
 $a$  RETURN jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'table_id', p_table_id,
    'tournament_id', v_tour,$a$,
 $b$  PERFORM smarter_private.compact_superseded_horse_actions(ARRAY(SELECT submission_id FROM smarter_private.hand_submission_disposals WHERE receipt_id=p_receipt_id ORDER BY submission_id LIMIT 5));
  RETURN jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'table_id', p_table_id,
    'tournament_id', v_tour,$b$)
 )q(sig,anchor,replacement)
 LOOP
  SELECT pg_get_functiondef(p.oid),jsonb_build_object('owner',p.proowner,'acl',p.proacl,'config',p.proconfig,'secdef',p.prosecdef,'volatility',p.provolatile) INTO source,metadata FROM pg_proc p WHERE oid=sig::regprocedure;
  IF (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'SUPERSEDED_ACTION_ANCHOR_CHANGED: %',sig; END IF;
  EXECUTE replace(source,anchor,replacement);
  SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,'config',p.proconfig,'secdef',p.prosecdef,'volatility',p.provolatile) INTO actual FROM pg_proc p WHERE oid=sig::regprocedure;
  IF metadata IS DISTINCT FROM actual THEN RAISE EXCEPTION 'SUPERSEDED_ACTION_AUTHORITY_CHANGED: %',sig; END IF;
 END LOOP;
END $patch$;
-- This installed matcher pins the assertion and disposal helper. Advance only
-- those two exact qualified sources; all other24 pins remain byte-equivalent
-- JSON values. Existing unrelated source drift stays refused, never certified.
DO $pins$
DECLARE source text; old_text text; old_pins jsonb; item jsonb;
 result jsonb:='[]'; sig text; expected text; metadata jsonb; actual jsonb;
 changed integer:=0;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'secdef',prosecdef,'volatility',provolatile)
 INTO source,metadata FROM pg_proc WHERE oid='smarter_private.original_hand_correction_sources_match()'::regprocedure;
 old_text:=split_part(source,'$sourcepins$',2); old_pins:=old_text::jsonb;
 IF jsonb_array_length(old_pins)<>26 THEN RAISE EXCEPTION 'SUPERSEDED_ACTION_SOURCE_PIN_COUNT_CHANGED'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(old_pins) LOOP
  sig:=item->>'signature';
  expected:=CASE sig WHEN 'smarter_private.assert_retained_hand_submission(jsonb)' THEN '6a3ab631fdab87ae9bcd353907de80b6'
   WHEN 'smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)' THEN '6a80a96fcf4f13f8cd734f35169f16d7' END;
  IF expected IS NOT NULL THEN
   IF item->>'full_md5' IS DISTINCT FROM expected THEN RAISE EXCEPTION 'SUPERSEDED_ACTION_SOURCE_PIN_PREIMAGE_CHANGED: %',sig; END IF;
   item:=item||jsonb_build_object('full_md5',md5(pg_get_functiondef(sig::regprocedure)),
    'body_md5',(SELECT md5(prosrc) FROM pg_proc WHERE oid=sig::regprocedure)); changed:=changed+1;
  END IF;
  result:=result||jsonb_build_array(item);
 END LOOP;
 IF changed<>2 THEN RAISE EXCEPTION 'SUPERSEDED_ACTION_SOURCE_PIN_COUNT_CHANGED'; END IF;
 EXECUTE replace(source,'$sourcepins$'||old_text||'$sourcepins$','$sourcepins$'||result::text||'$sourcepins$');
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'secdef',prosecdef,'volatility',provolatile)
 INTO actual FROM pg_proc WHERE oid='smarter_private.original_hand_correction_sources_match()'::regprocedure;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'SUPERSEDED_ACTION_SOURCE_MATCHER_AUTHORITY_CHANGED'; END IF;
 -- Before patches the old matcher matched these exact two preimages. After
 -- patching only their pins, each conjunction has the identical truth value.
 -- Do not assert global true: other installed sources may already have drifted.
END $pins$;
COMMIT;
