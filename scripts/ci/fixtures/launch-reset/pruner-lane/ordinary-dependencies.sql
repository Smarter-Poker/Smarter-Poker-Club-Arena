SET check_function_bodies=off;
CREATE SCHEMA IF NOT EXISTS smarter_private;
CREATE TABLE public.hand_history_retention_policy(id boolean,horse_retention_days integer,updated_at timestamp with time zone,note text);
CREATE TABLE public.poker_diamond_jackpot_hits(id uuid,arena_id uuid,table_id uuid,hand_number bigint,hand_id uuid,kind text,paid boolean,verdict jsonb,receipt jsonb,created_at timestamp with time zone);
CREATE TABLE public.tournament_knockout_candidates(id uuid,tournament_id uuid,eliminated_user_id uuid,table_id uuid,seat_id uuid,seat_joined_at timestamp with time zone,hand_id uuid,hand_number bigint,stack_before numeric(20,2),stack_after numeric(20,2),state text,rebuy_prompt_until timestamp with time zone,created_at timestamp with time zone,resolved_at timestamp with time zone);
CREATE TABLE smarter_private.hand_submissions(submission_id uuid,table_id uuid,hand_number bigint,instance_id text,lease_generation uuid,request jsonb,request_hash text,retained_at timestamp with time zone);
CREATE OR REPLACE FUNCTION smarter_private.archive_pruned_hand_index(p_hands uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE n integer; v_days integer; v_window interval;
BEGIN
 SELECT greatest(coalesce(horse_retention_days,8),1) INTO v_days
 FROM public.hand_history_retention_policy LIMIT 1;
 IF v_days IS NULL THEN v_days:=8; END IF;
 v_window:=make_interval(days=>v_days);
 IF p_hands IS NULL OR cardinality(p_hands)>250 THEN RAISE EXCEPTION 'HAND_INDEX_ARCHIVE_BATCH_INVALID' USING ERRCODE='22023'; END IF;
 -- Same history boundary that the owning prune locks before any side effects.
 PERFORM 1 FROM public.hand_history WHERE id=ANY(p_hands) ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=ANY(p_hands)
  AND (h.has_human IS DISTINCT FROM FALSE OR h.reported IS TRUE OR h.created_at IS NULL
   OR NOT isfinite(h.created_at) OR h.created_at>=now()-v_window))
 OR EXISTS(SELECT 1 FROM public.ca_hand_player_idx i WHERE i.hand_id=ANY(p_hands)
  AND NOT EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=i.hand_id)) THEN
  RAISE EXCEPTION 'HAND_INDEX_ARCHIVE_RETENTION_BOUNDARY_REQUIRED' USING ERRCODE='55000'; END IF;
 WITH removed AS (
  DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(p_hands) RETURNING user_id,asset,created_at
 ), grouped AS (
  SELECT user_id,asset,count(*)::bigint hands,min(created_at) first_hand_at,max(created_at) last_hand_at
  FROM removed GROUP BY user_id,asset
 ), written AS (
  INSERT INTO smarter_private.hand_index_retention_totals(user_id,asset,hands,first_hand_at,last_hand_at)
  SELECT user_id,asset,hands,first_hand_at,last_hand_at FROM grouped ORDER BY user_id,asset
  ON CONFLICT(user_id,asset) DO UPDATE SET hands=hand_index_retention_totals.hands+EXCLUDED.hands,
   first_hand_at=LEAST(hand_index_retention_totals.first_hand_at,EXCLUDED.first_hand_at),
   last_hand_at=GREATEST(hand_index_retention_totals.last_hand_at,EXCLUDED.last_hand_at)
  RETURNING 1
 ) SELECT coalesce(sum(hands),0)::integer INTO n FROM grouped WHERE (SELECT count(*) FROM written)>=0;
 RETURN n;
END $function$
;
CREATE OR REPLACE FUNCTION smarter_private.compact_horse_cash_play_contents(p_hands uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE k smarter_private.horse_settlement_key_certificates; p public.cash_hand_provenance_receipts;
 m public.cash_hand_participant_manifests; a public.hand_atomic_commits; h public.hand_history;
 request_after jsonb; atomic_after jsonb; evidence jsonb; n integer:=0; live_present boolean; retained_boundary text;
BEGIN
 IF p_hands IS NULL OR cardinality(p_hands)>250 THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_BATCH_INVALID' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT * FROM smarter_private.horse_settlement_key_certificates WHERE history_hand_id=ANY(p_hands) ORDER BY table_id,hand_number LOOP
  IF k.settled_at>=now()-interval '8 days' OR NOT isfinite(k.settled_at)
  OR EXISTS(SELECT 1 FROM smarter_private.horse_cash_payload_certificates c WHERE c.table_id=k.table_id AND c.hand_number=k.hand_number)
  OR EXISTS(SELECT 1 FROM smarter_private.horse_cash_postprune_certificates c WHERE c.table_id=k.table_id AND c.hand_number=k.hand_number) THEN CONTINUE; END IF;
  SELECT * INTO h FROM public.hand_history WHERE id=k.history_hand_id AND table_id=k.table_id AND hand_number=k.hand_number FOR UPDATE;
  live_present:=FOUND;
  IF live_present THEN
  IF h.has_human IS DISTINCT FROM FALSE OR h.reported IS TRUE OR h.tournament_id IS NOT NULL
  OR h.created_at IS NULL OR NOT isfinite(h.created_at) OR h.created_at>=now()-interval '8 days'
  OR EXISTS(SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=h.id)
  OR EXISTS(SELECT 1 FROM public.bbj_payouts b WHERE b.table_id=h.table_id AND b.hand_number=h.hand_number)
  OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates t WHERE t.hand_id=h.id AND t.state='pending') THEN CONTINUE; END IF;
  SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=k.table_id AND hand_number=k.hand_number AND hand_id=k.history_hand_id FOR UPDATE;
  -- This transition belongs before original history deletion. Legacy certificates
  -- without the live completed boundary do not invent later qualification.
  IF NOT FOUND OR a.post_commit_completed_at IS DISTINCT FROM k.settled_at OR a.post_commit_result->>'ok' IS DISTINCT FROM 'true'
  OR smarter_private.f06_hand_cards_unresolved(k.table_id,k.hand_number)
  OR smarter_private.f06_movement_boundary_retained(k.table_id,k.hand_number) THEN CONTINUE; END IF;
  ELSE
   IF EXISTS(SELECT 1 FROM public.hand_atomic_commits original WHERE original.table_id=k.table_id AND original.hand_number=k.hand_number) THEN CONTINUE; END IF;
  END IF;
  SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=k.table_id AND hand_number=k.hand_number FOR UPDATE;
  IF NOT FOUND OR p.hand_id IS DISTINCT FROM k.history_hand_id OR p.manifest_id IS DISTINCT FROM k.manifest_id
  OR p.status IS DISTINCT FROM 'captured' OR p.funding_provenance_complete IS NOT TRUE OR p.all_players_included IS NOT TRUE
  OR p.accepted_request#>'{hand_row,has_human}' IS DISTINCT FROM 'false'::jsonb
  OR p.accepted_request#>'{hand_row,tournament_id}' IS DISTINCT FROM 'null'::jsonb
  OR encode(extensions.digest(convert_to(p.accepted_request::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM p.payload_hash
  OR (live_present AND p.atomic_receipt->'stack_result' IS DISTINCT FROM a.stack_result) THEN CONTINUE; END IF;
  SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=p.manifest_id AND table_id=k.table_id AND hand_number=k.hand_number;
  IF NOT FOUND OR m.funding_provenance_complete IS NOT TRUE OR m.issues IS DISTINCT FROM '[]'::jsonb
  OR jsonb_typeof(m.participants) IS DISTINCT FROM 'array' OR jsonb_array_length(m.participants) NOT BETWEEN 2 AND 10
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.participants) x WHERE x->'is_horse' IS DISTINCT FROM 'true'::jsonb) THEN CONTINUE; END IF;
  -- Original blocked accounting/link evidence stays whole for its authoritative
  -- repair consumer. Do not convert a fresh direct reader into a historical seal.
  IF NOT EXISTS(SELECT 1 FROM public.union_pnl_cash_outcomes o WHERE o.table_id=k.table_id AND o.hand_number=k.hand_number
   AND o.hand_id=p.hand_id AND o.payload_hash=p.payload_hash AND o.game_scope=p.game_scope
   AND o.evidence->>'status'='ready' AND o.evidence->'basis_certified'='true'::jsonb AND o.evidence->'all_players_included'='true'::jsonb)
  THEN CONTINUE; END IF;
  evidence:=public.fn_pnl_cash_hand_evidence(k.table_id,k.hand_number);
  IF evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
  OR evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb
  OR encode(extensions.digest(convert_to(evidence::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM k.accounting_evidence_sha256 THEN CONTINUE; END IF;
  -- An erased raw request must leave the exact accepted derived basis.
  IF NOT EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis b
   WHERE b.hand_id=p.hand_id AND b.table_id=p.table_id AND b.hand_number=p.hand_number
   AND b.original_stats_sha256=encode(extensions.digest(convert_to(COALESCE(p.accepted_request#>'{hand_row,_accepted_post_commit_facts,stats_facts}','null'::jsonb)::text,'UTF8'),'sha256'),'hex')
   AND b.compact_stats IS NOT DISTINCT FROM smarter_private.horse_compact_stats_basis(p.accepted_request#>'{hand_row,_accepted_post_commit_facts,stats_facts}')
   AND (p.atomic_receipt#>'{post_commit_payload,accepted_hand_facts,stats_facts}' IS NULL OR COALESCE(p.atomic_receipt#>'{post_commit_payload,accepted_hand_facts,stats_facts}','null'::jsonb) IS NOT DISTINCT FROM COALESCE(p.accepted_request#>'{hand_row,_accepted_post_commit_facts,stats_facts}','null'::jsonb))) THEN CONTINUE; END IF;
  IF NOT live_present THEN
   retained_boundary:=smarter_private.horse_cash_retained_boundary_digest(k.table_id,k.hand_number);
   IF retained_boundary IS NULL THEN CONTINUE; END IF;
  END IF;
  request_after:=smarter_private.horse_cash_compact_request(p.accepted_request);
  atomic_after:=smarter_private.horse_cash_compact_atomic(p.atomic_receipt);
  IF request_after IS NOT DISTINCT FROM p.accepted_request AND atomic_after IS NOT DISTINCT FROM p.atomic_receipt THEN CONTINUE; END IF;
  IF live_present THEN
  INSERT INTO smarter_private.horse_cash_payload_certificates(table_id,hand_number,hand_id,manifest_id,original_request_sha256,original_atomic_sha256,
   compact_request_sha256,compact_atomic_sha256,immutable_financial_sha256,live_atomic_sha256,accounting_evidence_sha256,accepted_at,settled_at)
  VALUES(p.table_id,p.hand_number,p.hand_id,p.manifest_id,p.payload_hash,
   encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to(request_after::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to(atomic_after::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to(to_jsonb(a)::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to(evidence::text,'UTF8'),'sha256'),'hex'),p.accepted_at,k.settled_at);
  ELSE
   INSERT INTO smarter_private.horse_cash_postprune_certificates(table_id,hand_number,hand_id,manifest_id,original_request_sha256,
    original_atomic_sha256,compact_request_sha256,compact_atomic_sha256,immutable_financial_sha256,accounting_evidence_sha256,
    original_boundary_sha256,accepted_at,settled_at)
   VALUES(p.table_id,p.hand_number,p.hand_id,p.manifest_id,p.payload_hash,
    encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to(request_after::text,'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to(atomic_after::text,'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex'),
    k.accounting_evidence_sha256,retained_boundary,p.accepted_at,k.settled_at);
  END IF;
  UPDATE public.cash_hand_provenance_receipts SET accepted_request=request_after,atomic_receipt=atomic_after WHERE table_id=p.table_id AND hand_number=p.hand_number;
  n:=n+1;
 END LOOP;
 RETURN n;
END $function$
;
CREATE OR REPLACE FUNCTION smarter_private.compact_horse_settlement_keys(p_hands uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE h public.hand_history; a public.hand_atomic_commits; p public.cash_hand_provenance_receipts;
 m public.cash_hand_participant_manifests; k public.settlement_idempotency_keys;
 evidence jsonb; stack_hand uuid; count_compacted integer:=0;
BEGIN
 IF p_hands IS NULL OR cardinality(p_hands)>250 THEN
  RAISE EXCEPTION 'HORSE_SETTLEMENT_COMPACTION_BATCH_INVALID' USING ERRCODE='22023'; END IF;
 FOR h IN SELECT * FROM public.hand_history WHERE id=ANY(p_hands) ORDER BY table_id,hand_number FOR UPDATE LOOP
  -- Cash only. Exactly eight elapsed days for both original history and final
  -- obligations; original manifest classification, never current profiles.
  IF h.table_id IS NULL OR h.tournament_id IS NOT NULL OR h.has_human IS DISTINCT FROM FALSE OR h.reported IS TRUE
  OR h.created_at IS NULL OR NOT isfinite(h.created_at) OR h.created_at>=now()-interval '8 days'
  OR EXISTS(SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=h.id)
  OR EXISTS(SELECT 1 FROM public.bbj_payouts b WHERE b.table_id=h.table_id AND b.hand_number=h.hand_number)
  OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates t WHERE t.hand_id=h.id AND t.state='pending')
  OR smarter_private.f06_hand_cards_unresolved(h.table_id,h.hand_number::bigint)
  OR smarter_private.f06_movement_boundary_retained(h.table_id,h.hand_number::bigint) THEN CONTINUE; END IF;
  SELECT * INTO a FROM public.hand_atomic_commits WHERE hand_id=h.id AND table_id=h.table_id AND hand_number=h.hand_number FOR UPDATE;
  IF NOT FOUND OR a.post_commit_completed_at IS NULL OR NOT isfinite(a.post_commit_completed_at) OR a.post_commit_completed_at>=now()-interval '8 days'
  OR a.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR a.stack_result->>'success' IS DISTINCT FROM 'true'
  OR a.stack_result->>'conservation_checked' IS DISTINCT FROM 'true'
  OR jsonb_typeof(a.stack_result->'request') IS DISTINCT FROM 'object'
  OR NOT pg_input_is_valid(a.stack_result->>'hand_id','uuid') THEN CONTINUE; END IF;
  stack_hand:=(a.stack_result->>'hand_id')::uuid;
  IF EXISTS(SELECT 1 FROM smarter_private.horse_settlement_key_certificates c WHERE c.table_id=h.table_id AND c.stack_hand_id=stack_hand) THEN CONTINUE; END IF;
  SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=h.table_id AND hand_number=h.hand_number;
  IF NOT FOUND OR p.hand_id IS DISTINCT FROM h.id OR p.payload_hash IS DISTINCT FROM a.payload_hash
  OR p.atomic_receipt->'stack_result' IS DISTINCT FROM a.stack_result
  OR p.status IS DISTINCT FROM 'captured' OR p.funding_provenance_complete IS NOT TRUE OR p.all_players_included IS NOT TRUE
  OR p.issues IS DISTINCT FROM '[]'::jsonb THEN CONTINUE; END IF;
  SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=p.manifest_id AND table_id=h.table_id AND hand_number=h.hand_number;
  IF NOT FOUND OR m.funding_provenance_complete IS NOT TRUE OR m.issues IS DISTINCT FROM '[]'::jsonb
  OR jsonb_typeof(m.participants) IS DISTINCT FROM 'array' OR jsonb_array_length(m.participants) NOT BETWEEN 2 AND 10
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.participants) x WHERE x->'is_horse' IS DISTINCT FROM 'true'::jsonb)
  OR jsonb_typeof(h.players) IS DISTINCT FROM 'array'
  OR jsonb_array_length(h.players) IS DISTINCT FROM jsonb_array_length(m.participants)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(h.players) x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.participants) y WHERE y->>'user_id'=x->>'userId'))
  THEN CONTINUE; END IF;
  SELECT * INTO k FROM public.settlement_idempotency_keys WHERE table_id=h.table_id AND hand_id=stack_hand FOR UPDATE;
  IF NOT FOUND OR k.status IS DISTINCT FROM 'succeeded' OR k.completed_at IS NULL OR k.error IS NOT NULL
  OR k.result IS DISTINCT FROM a.stack_result OR NOT k.result ? 'request' THEN CONTINUE; END IF;
  evidence:=public.fn_pnl_cash_hand_evidence(h.table_id,h.hand_number::bigint);
  IF evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
  OR evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb THEN CONTINUE; END IF;
  INSERT INTO smarter_private.horse_settlement_key_certificates(table_id,stack_hand_id,hand_number,history_hand_id,manifest_id,
   original_result_sha256,original_request_sha256,compact_result,accounting_evidence_sha256,settled_at)
  VALUES(h.table_id,stack_hand,h.hand_number,h.id,m.id,
   encode(extensions.digest(convert_to(k.result::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to((k.result->'request')::text,'UTF8'),'sha256'),'hex'),k.result-'request',
   encode(extensions.digest(convert_to(evidence::text,'UTF8'),'sha256'),'hex'),a.post_commit_completed_at);
  UPDATE public.settlement_idempotency_keys SET result=result-'request' WHERE table_id=h.table_id AND hand_id=stack_hand;
  count_compacted:=count_compacted+1;
 END LOOP;
 RETURN count_compacted;
END $function$
;
CREATE OR REPLACE FUNCTION smarter_private.f06_hand_cards_unresolved(p_table_id uuid, p_hand_number bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
  -- The one unresolved test, shared with public.sp_prune_hand_state_snapshots:
  -- an exact (table_id, hand_number) whose F06 permit is still 'reserved'.
  -- 'accepted', 'never_started' and 'aborted_unsettled' are the other three
  -- states admitted by f06_hand_permits_state_check, and each is written
  -- together with the evidence_id of the receipt that resolved the hand, so a
  -- permit leaves 'reserved' exactly when its disposition has been decided.
  -- Reads permit state only; never card data.
  SELECT EXISTS (
    SELECT 1 FROM smarter_private.f06_hand_permits p
     WHERE p.table_id = p_table_id AND p.hand_number = p_hand_number
       AND p.state = 'reserved');
$function$
;
CREATE OR REPLACE FUNCTION smarter_private.f06_movement_boundary_retained(p_table_id uuid, p_hand_number bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.tables tb
      LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
     WHERE tb.id = p_table_id
       AND tb.tournament_id IS NOT NULL
       AND NOT COALESCE(tb.is_deleted, false)
       AND lower(COALESCE(tb.status, '')) <> 'closed'
       AND upper(COALESCE(t.status::text, '')) NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
       AND p_hand_number = (
         SELECT max(a.hand_number) FROM public.hand_atomic_commits a
          WHERE a.table_id = p_table_id)
  );
$function$
;
CREATE OR REPLACE FUNCTION smarter_private.hand_submission_retention_disposal(p_hand_ids uuid[], p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE v_rows integer := 0;
BEGIN
  IF p_hand_ids IS NULL OR cardinality(p_hand_ids) = 0 THEN RETURN 0; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 40 THEN
    RAISE EXCEPTION 'HAND_DISPOSAL_IDENTITY_REQUIRED' USING ERRCODE = '22023';
  END IF;

  INSERT INTO smarter_private.hand_submission_disposals
    (table_id, hand_number, submission_id, receipt_id, witness_hand_number, reason, expected)
  SELECT s.table_id, s.hand_number, s.submission_id,
         md5('hand:disposal:retention:' || s.submission_id::text)::uuid,
         s.hand_number, p_reason,
         jsonb_build_object(
           'kind', 'retention_pruned_settled_hand',
           'table_id', s.table_id, 'hand_number', s.hand_number,
           'submission_id', s.submission_id, 'retained_at', s.retained_at,
           'dealer_generation', s.lease_generation, 'request_hash', s.request_hash,
           'pruned_hand_id', hh.id, 'hand_created_at', hh.created_at,
           'settled', EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                               WHERE a.table_id = s.table_id AND a.hand_number = s.hand_number),
           'settlement_completed_at', (SELECT a.post_commit_completed_at FROM public.hand_atomic_commits a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number AND a.hand_id=s.submission_id),
           'settlement_completed', EXISTS (SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number AND a.hand_id=s.submission_id AND a.post_commit_completed_at IS NOT NULL AND a.post_commit_result->>'ok'='true'),
           'disposed_at', clock_timestamp())
    FROM public.hand_history hh
    JOIN smarter_private.hand_submissions s
      ON s.table_id = hh.table_id AND s.hand_number = hh.hand_number
   WHERE hh.id = ANY (p_hand_ids)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_disposals dd
                      WHERE dd.table_id = s.table_id AND dd.hand_number = s.hand_number)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM smarter_private.compact_settled_horse_requests(p_hand_ids);
  RETURN v_rows;
END
$function$
;
CREATE OR REPLACE FUNCTION smarter_private.horse_cash_retention_accounting_ready(p_table uuid, p_number bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE p public.cash_hand_provenance_receipts; m public.cash_hand_participant_manifests;
 k public.settlement_idempotency_keys; sealed smarter_private.horse_settlement_key_certificates; evidence jsonb;
BEGIN
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table AND hand_number=p_number;
 -- Only a verified tournament owner or the explicit unattached fixture may
 -- have no cash receipt. A missing cash/unknown owner stays original evidence.
 IF NOT FOUND THEN RETURN p_table IS NULL OR EXISTS(SELECT 1 FROM public.tables t WHERE t.id=p_table AND t.tournament_id IS NOT NULL); END IF;
 IF p.status IS DISTINCT FROM 'captured' OR p.funding_provenance_complete IS NOT TRUE
 OR p.all_players_included IS NOT TRUE OR p.issues IS DISTINCT FROM '[]'::jsonb
 OR p.accepted_request#>'{hand_row,has_human}' IS DISTINCT FROM 'false'::jsonb
 OR p.accepted_request#>'{hand_row,tournament_id}' IS DISTINCT FROM 'null'::jsonb
 OR NOT smarter_private.horse_cash_retained_request_matches(p_table,p_number,p.payload_hash,p.accepted_request)
 OR smarter_private.f06_hand_cards_unresolved(p_table,p_number)
 OR smarter_private.f06_movement_boundary_retained(p_table,p_number)
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=p.hand_id AND (h.has_human IS DISTINCT FROM false OR h.reported IS true))
 OR EXISTS(SELECT 1 FROM public.bbj_payouts b WHERE b.table_id=p_table AND b.hand_number=p_number)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=p.hand_id)
 OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates t WHERE t.hand_id=p.hand_id AND t.state='pending')
 THEN RETURN false; END IF;
 SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=p.manifest_id AND table_id=p_table AND hand_number=p_number;
 IF NOT FOUND OR m.funding_provenance_complete IS NOT TRUE OR m.issues IS DISTINCT FROM '[]'::jsonb
 OR jsonb_typeof(m.participants) IS DISTINCT FROM 'array' OR jsonb_array_length(m.participants) NOT BETWEEN 2 AND 10
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.participants) x WHERE x->'is_horse' IS DISTINCT FROM 'true'::jsonb)
 OR NOT EXISTS(SELECT 1 FROM public.union_pnl_cash_outcomes o WHERE o.table_id=p_table AND o.hand_number=p_number
  AND (o.hand_id,o.payload_hash,o.game_scope) IS NOT DISTINCT FROM (p.hand_id,p.payload_hash,p.game_scope)
  AND o.evidence->>'status'='ready' AND o.evidence->'basis_certified'='true'::jsonb AND o.evidence->'all_players_included'='true'::jsonb)
 OR NOT pg_input_is_valid(p.atomic_receipt#>>'{stack_result,hand_id}','uuid') THEN RETURN false; END IF;
 SELECT * INTO k FROM public.settlement_idempotency_keys WHERE table_id=p_table AND hand_id=(p.atomic_receipt#>>'{stack_result,hand_id}')::uuid;
 IF NOT FOUND OR k.status IS DISTINCT FROM 'succeeded' OR k.error IS NOT NULL OR k.completed_at IS NULL
 OR NOT isfinite(k.completed_at) THEN RETURN false; END IF;
 SELECT * INTO sealed FROM smarter_private.horse_settlement_key_certificates WHERE table_id=p_table AND stack_hand_id=k.hand_id;
 IF FOUND THEN
  IF (sealed.history_hand_id,sealed.hand_number,sealed.manifest_id) IS DISTINCT FROM (p.hand_id,p_number,p.manifest_id)
  OR encode(extensions.digest(convert_to((p.atomic_receipt->'stack_result')::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM sealed.original_result_sha256
  OR encode(extensions.digest(convert_to(smarter_private.horse_settlement_original_result(p_table,k.hand_id,k.result)::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM sealed.original_result_sha256
  THEN RETURN false; END IF;
 ELSE
  IF k.result IS DISTINCT FROM p.atomic_receipt->'stack_result' OR NOT k.result ? 'request' THEN RETURN false; END IF;
 END IF;
 evidence:=public.fn_pnl_cash_hand_evidence(p_table,p_number);
 IF evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
 OR evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb
 OR (sealed.table_id IS NOT NULL AND encode(extensions.digest(convert_to(evidence::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM sealed.accounting_evidence_sha256)
 THEN RETURN false; END IF;
 RETURN true;
END $function$
;
