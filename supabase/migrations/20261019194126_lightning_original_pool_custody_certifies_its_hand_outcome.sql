-- Original audit: 19,224 Lightning hands have no physical dealt manifest;
-- 11,144 charged 491.65 rake; cohort BBJ is 121.71. Pool-custody receipts are
-- retained, but the generic seat reader cannot prove the original roster.
-- Fix the original settlement transition, retaining a proof before commit.
-- Explicit old-hand qualification uses the same exact native proof and hash.
-- No wallet, fee, stack, sealed outcome, source, schedule or payout is rewritten.
-- @live-proof: md5(pg_get_functiondef('public.fn_lightning_original_pnl_proof(uuid,bigint)'::regprocedure))='c8ca7384306de10f52c8bf806b9a1db3' AND md5(pg_get_functiondef('public.fn_lightning_record_original_pnl(uuid,bigint,text)'::regprocedure))='242ac2f838bfbaea08c96abd2e5cf9c4' AND md5(pg_get_functiondef('public.fn_lightning_original_pnl_at_settlement()'::regprocedure))='46eb82fe15d6740591d2674b4ea190eb' AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.lightning_hand'::regclass AND tgname='lightning_original_pnl_at_settlement' AND tgfoid='public.fn_lightning_original_pnl_at_settlement()'::regprocedure AND tgdeferrable AND tginitdeferred AND tgenabled='O')

BEGIN;

SET LOCAL lock_timeout='2s';
-- A Lightning participant owns a pool reservation, not the synthetic host
-- chair. The normal accepted-hand manifest therefore cannot certify it.
-- Retain the original blocked observation; link an independently verified,
-- card-free native pool receipt through the existing weekly PNL reader.
DO $pre$
BEGIN
 IF to_regprocedure('public.fn_lightning_original_pnl_proof(uuid,bigint)') IS NOT NULL THEN
  RAISE EXCEPTION 'lightning_original_pnl_already_installed' USING ERRCODE='55000'; END IF;
 IF md5(pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure))
  IS DISTINCT FROM '0670ed75762f05e7ad3346a1c95e84dc' THEN
  RAISE EXCEPTION 'lightning_original_pnl_settlement_preimage_changed' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.union_pnl_cash_outcome_link_resolutions'::regclass
   AND conname='union_pnl_cash_outcome_link_resolutions_roster_source_check'
   AND pg_get_constraintdef(oid)=$old$CHECK ((roster_source = ANY (ARRAY['manifest'::text, 'seat_inventory'::text])))$old$) THEN
  RAISE EXCEPTION 'lightning_original_pnl_link_contract_changed' USING ERRCODE='55000'; END IF;
END $pre$;
ALTER TABLE public.union_pnl_cash_outcome_link_resolutions
 DROP CONSTRAINT union_pnl_cash_outcome_link_resolutions_roster_source_check,
 ADD CONSTRAINT union_pnl_cash_outcome_link_resolutions_roster_source_check
 CHECK(roster_source IN('manifest','seat_inventory','lightning_pool'));

CREATE FUNCTION public.fn_lightning_original_pnl_proof(p_table uuid,p_number bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC' AS $function$
DECLARE h public.lightning_hand; o public.union_pnl_cash_outcomes;
 p public.cash_hand_provenance_receipts; a public.hand_atomic_commits;
 started timestamptz; tr jsonb; scope jsonb; asset text; person record;
 n integer:=0; delta numeric:=0; before_stack numeric; after_stack numeric;
 people jsonb:='[]'; receipts jsonb:='[]'; proof jsonb; signed_stacks jsonb;
BEGIN
 SELECT * INTO h FROM public.lightning_hand WHERE hand_number=p_number AND host_table_id=p_table;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','refused','reason','original_lightning_hand_missing'); END IF;
 SELECT * INTO o FROM public.union_pnl_cash_outcomes WHERE table_id=p_table AND hand_number=p_number;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','refused','reason','original_cash_outcome_missing'); END IF;
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table AND hand_number=p_number;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','refused','reason','original_cash_provenance_missing'); END IF;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=p_table AND hand_number=p_number;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','refused','reason','original_atomic_hand_missing'); END IF;
 SELECT started_at INTO started FROM public.hand_history WHERE id=h.hand_history_id AND table_id=p_table AND hand_number=p_number;
 IF started IS NULL OR NOT isfinite(started) OR NOT isfinite(h.formed_at) OR h.formed_at>started OR h.settled_at IS NULL OR NOT isfinite(h.settled_at)
  OR h.player_count<2 OR h.player_count>10
  OR (h.hand_history_id,p.hand_id,a.hand_id) IS DISTINCT FROM (o.hand_id,o.hand_id,o.hand_id)
  OR (p.payload_hash,a.payload_hash,h.settle_receipt->>'commit_hash') IS DISTINCT FROM (o.payload_hash,o.payload_hash,o.payload_hash)
  OR p.transaction_id IS DISTINCT FROM o.transaction_id
  OR p.status IS DISTINCT FROM 'uncertified' OR p.manifest_id IS NOT NULL
  OR p.issues IS DISTINCT FROM '["original_dealt_manifest_missing"]'::jsonb
  OR p.signed_external_net IS DISTINCT FROM 0::numeric
  OR h.settle_receipt->'ok' IS DISTINCT FROM 'true'::jsonb
  OR h.settle_receipt->>'hand_id' IS DISTINCT FROM h.hand_id::text
  OR h.settle_receipt->>'hand_history_id' IS DISTINCT FROM o.hand_id::text
  OR h.settle_receipt->>'host_table_id' IS DISTINCT FROM p_table::text
  OR h.settle_receipt->>'hand_number' IS DISTINCT FROM p_number::text
  OR h.settle_receipt->>'request_id' IS DISTINCT FROM h.settle_request_id::text
  OR h.settle_receipt->>'request_hash' IS DISTINCT FROM h.settle_request_hash
  OR h.settle_receipt->>'receipt_hash' IS DISTINCT FROM encode(sha256(convert_to((h.settle_receipt-'receipt_hash')::text,'UTF8')),'hex')
  OR h.settle_receipt->>'post_commit_payload_hash' IS DISTINCT FROM a.post_commit_payload_hash
  OR a.post_commit_payload IS NULL
  OR (a.post_commit_completed_at IS NOT NULL AND a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb)
  OR p.atomic_receipt->'stack_result' IS DISTINCT FROM a.stack_result
  OR p.atomic_receipt->>'payload_hash' IS DISTINCT FROM o.payload_hash
  OR a.stack_result->'success' IS DISTINCT FROM 'true'::jsonb
  OR a.stack_result->'conservation_checked' IS DISTINCT FROM 'true'::jsonb
  OR a.stack_result->>'mode' IS DISTINCT FROM 'delta'
  OR a.stack_result->'request'->'stacks' IS DISTINCT FROM p.accepted_request->'stacks'
  OR NOT public.fn_cash_signed_retained_request_matches(p_table,p_number,o.payload_hash,p.accepted_request)
 THEN RETURN jsonb_build_object('status','refused','reason','original_lightning_identity_or_signature_disagrees'); END IF;
 -- Scope is the retained original table observation, never today's table.
 SELECT e.after_row INTO tr FROM public.union_pnl_inventory_events e
  WHERE e.source_name='tables' AND e.row_id=p_table AND e.observed_at<=started
  ORDER BY e.event_id DESC LIMIT 1;
 SELECT c.asset INTO asset FROM public.clubs c WHERE c.id=(tr->>'club_id')::uuid;
 scope:=jsonb_build_object('host_club_id',tr->'club_id','game_union_id',
  CASE WHEN tr->'is_private'='true'::jsonb THEN 'null'::jsonb ELSE tr->'union_id' END,
  'is_private',tr->'is_private','tournament_id',tr->'tournament_id','asset',asset,'unit_scale',2);
 IF tr IS NULL OR asset IS DISTINCT FROM 'chips' OR tr->'tournament_id' IS DISTINCT FROM 'null'::jsonb
  OR jsonb_typeof(tr->'is_private') IS DISTINCT FROM 'boolean'
  OR (tr->'is_private'='false'::jsonb AND tr->>'union_id' IS NULL)
 THEN RETURN jsonb_build_object('status','refused','reason','original_lightning_game_scope_unproven'); END IF;
 signed_stacks:=a.stack_result#>'{request,stacks}';
 IF jsonb_typeof(signed_stacks) IS DISTINCT FROM 'array'
  OR jsonb_array_length(signed_stacks)<>h.player_count
  OR (SELECT count(*) FROM jsonb_object_keys(h.settle_receipt->'deltas'))<>h.player_count
 THEN RETURN jsonb_build_object('status','refused','reason','original_lightning_roster_incomplete'); END IF;
 FOR person IN
  SELECT hp.*,sl.pool_session_id,sl.opened_at slot_opened,sl.closed_at slot_closed,
   ps.cash_player_session_id,ps.entered_at,ps.exited_at,ps.anchor_seat_id,
   cs.club_id,cs.opened_at cash_opened,cs.closed_at cash_closed,
   (SELECT count(*) FROM jsonb_array_elements(signed_stacks) s WHERE s->>'user_id'=hp.player_id::text) signed_count,
   (SELECT s FROM jsonb_array_elements(signed_stacks) s WHERE s->>'user_id'=hp.player_id::text LIMIT 1) signed_stack
  FROM public.lightning_hand_player hp
  LEFT JOIN public.lightning_pool_slot sl ON sl.id=hp.pool_slot_id AND sl.player_id=hp.player_id
   AND sl.cluster_id=h.cluster_id AND sl.cluster_epoch=h.cluster_epoch
  LEFT JOIN public.lightning_pool_session ps ON ps.id=sl.pool_session_id AND ps.player_id=hp.player_id
   AND ps.cluster_id=h.cluster_id AND ps.cluster_epoch=h.cluster_epoch
  LEFT JOIN public.cash_player_session cs ON cs.id=ps.cash_player_session_id AND cs.player_id=hp.player_id
  WHERE hp.hand_id=h.hand_id ORDER BY hp.seat
 LOOP
  before_stack:=public.fn_pnl_evidence_cents(person.signed_stack->'stack_before');
  after_stack:=public.fn_pnl_evidence_cents(person.signed_stack->'stack');
  IF (person.cluster_id=h.cluster_id AND person.cluster_epoch=h.cluster_epoch
   AND person.club_id IS NOT NULL AND person.signed_count=1
   AND isfinite(person.cash_opened) AND person.cash_opened<=started AND (person.cash_closed IS NULL OR (isfinite(person.cash_closed) AND person.cash_closed>started))
   AND isfinite(person.entered_at) AND person.entered_at<=started AND (person.exited_at IS NULL OR (isfinite(person.exited_at) AND person.exited_at>started))
   AND isfinite(person.slot_opened) AND person.slot_opened<=started AND (person.slot_closed IS NULL OR (isfinite(person.slot_closed) AND person.slot_closed>started))
   AND before_stack>=0 AND after_stack>=0 AND before_stack=person.stack_before AND after_stack=person.stack_after
   AND person.net_result=after_stack-before_stack
   AND person.signed_stack->>'seat_id'=person.anchor_seat_id::text
   AND (h.settle_receipt->'deltas'->>person.player_id::text)::numeric=person.net_result
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=person.club_id
    AND (c.is_union IS NOT TRUE OR c.id=(scope->>'game_union_id')::uuid OR c.union_id=(scope->>'game_union_id')::uuid))) IS NOT TRUE
  THEN RETURN jsonb_build_object('status','refused','reason','original_lightning_pool_custody_disagrees','user_id',person.player_id); END IF;
  n:=n+1; delta:=delta+person.net_result;
  people:=people||jsonb_build_array(jsonb_build_object('user_id',person.player_id,
   'observed_stack_delta',person.net_result,'earning_club_id',person.club_id,
   'ownership_certified',true,'ownership_scope','original_lightning_pool_session',
   'funding_receipt_ids','[]'::jsonb,'original_funding_session_ids',jsonb_build_array(person.cash_player_session_id),
   'pool_slot_id',person.pool_slot_id,'pool_session_id',person.pool_session_id));
 END LOOP;
 IF n<>h.player_count OR p.rake IS NULL OR p.bbj IS NULL OR p.rake<0 OR p.bbj<0
  OR p.rake IS DISTINCT FROM public.fn_pnl_evidence_cents(h.settle_receipt->'rake')
  OR p.bbj IS DISTINCT FROM public.fn_pnl_evidence_cents(h.settle_receipt->'bbj')
  OR p.rake IS DISTINCT FROM public.fn_pnl_evidence_cents(a.stack_result#>'{request,rake}')
  OR p.bbj IS DISTINCT FROM public.fn_pnl_evidence_cents(a.stack_result#>'{request,bbj}')
  OR delta+p.rake+p.bbj<>0
 THEN RETURN jsonb_build_object('status','refused','reason','original_lightning_conservation_disagrees'); END IF;
 proof:=jsonb_build_object('status','ready','basis_certified',true,'scope','single_accepted_cash_hand',
  'payment_authorized',false,'hand_id',o.hand_id,'table_id',p_table,'hand_number',p_number,
  'observed_commit_at',o.recognized_at,'observed_delta_total',delta,'participants',people,'issues','[]'::jsonb,
  'game_scope',scope,'current_seats_used',false,'current_membership_used',false,'all_players_included',true,
  'accepted_rake',p.rake,'accepted_bbj',p.bbj,'accepted_external_net',0,'provenance_link','resolved');
 RETURN jsonb_build_object('status','proven','resolution_kind','cash_outcome_provenance_link',
  'original_custody_kind','lightning_pool_session','table_id',p_table,'hand_number',p_number,'hand_id',o.hand_id,
  'outcome_payload_hash',o.payload_hash,'outcome_evidence_md5',md5(o.evidence::text),
  'roster_source','lightning_pool','manifest_id',NULL,'game_scope',scope,'evidence',proof,
  'lightning_hand_id',h.hand_id,'settle_receipt_hash',h.settle_receipt->>'receipt_hash');
END $function$;
REVOKE ALL ON FUNCTION public.fn_lightning_original_pnl_proof(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_lightning_record_original_pnl(p_table uuid,p_number bigint,p_expected_proof_md5 text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $function$
DECLARE proof jsonb; existing public.union_pnl_cash_outcome_link_resolutions; o public.union_pnl_cash_outcomes;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('lightning-original-pnl:'||p_table::text||':'||p_number::text,0));
 SELECT * INTO o FROM public.union_pnl_cash_outcomes WHERE table_id=p_table AND hand_number=p_number;
 SELECT * INTO existing FROM public.union_pnl_cash_outcome_link_resolutions WHERE table_id=p_table AND hand_number=p_number;
 IF FOUND THEN
  IF existing.roster_source IS DISTINCT FROM 'lightning_pool' OR existing.hand_id IS DISTINCT FROM o.hand_id
   OR existing.outcome_payload_hash IS DISTINCT FROM o.payload_hash OR existing.outcome_evidence_md5 IS DISTINCT FROM md5(o.evidence::text)
   OR existing.proof_md5 IS DISTINCT FROM md5(existing.proof::text)
   OR (p_expected_proof_md5 IS NOT NULL AND p_expected_proof_md5 IS DISTINCT FROM existing.proof_md5)
  THEN RAISE EXCEPTION 'lightning_original_pnl_replay_conflicts' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('status','already_recorded','hand_id',o.hand_id,'proof_md5',existing.proof_md5);
 END IF;
 IF p_expected_proof_md5 IS NULL AND o.transaction_id IS DISTINCT FROM pg_current_xact_id() THEN
  RAISE EXCEPTION 'lightning_original_pnl_historical_proof_required' USING ERRCODE='55000'; END IF;
 proof:=public.fn_lightning_original_pnl_proof(p_table,p_number);
 IF proof->>'status' IS DISTINCT FROM 'proven' OR proof#>>'{evidence,status}' IS DISTINCT FROM 'ready'
  OR (p_expected_proof_md5 IS NOT NULL AND p_expected_proof_md5 IS DISTINCT FROM md5(proof::text)) THEN
  RAISE EXCEPTION 'lightning_original_pnl_proof_refused' USING ERRCODE='55000',DETAIL=proof::text; END IF;
 INSERT INTO public.union_pnl_cash_outcome_link_resolutions(table_id,hand_number,hand_id,outcome_payload_hash,outcome_evidence_md5,
  roster_source,manifest_id,game_scope,evidence,proof,proof_md5,reason)
 VALUES(p_table,p_number,o.hand_id,o.payload_hash,md5(o.evidence::text),'lightning_pool',NULL,
  proof->'game_scope',proof->'evidence',proof,md5(proof::text),
  'Original Lightning pool custody, signed native stack result and exact settlement receipt independently verified');
 RETURN jsonb_build_object('status','recorded','hand_id',o.hand_id,'proof_md5',md5(proof::text));
END $function$;
REVOKE ALL ON FUNCTION public.fn_lightning_record_original_pnl(uuid,bigint,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_lightning_original_pnl_at_settlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $function$
BEGIN
 -- Queued after the physical accepted-hand observation in the SAME original
 -- transaction. Any refused proof rolls the hand, fees and receipt back.
 -- No watcher, replay pipeline, global lock or extra payment is introduced.
 PERFORM public.fn_lightning_record_original_pnl(NEW.host_table_id,NEW.hand_number,NULL);
 RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.fn_lightning_original_pnl_at_settlement() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER lightning_original_pnl_at_settlement
 AFTER UPDATE ON public.lightning_hand DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN(OLD.settled_at IS NULL AND NEW.settled_at IS NOT NULL)
 EXECUTE FUNCTION public.fn_lightning_original_pnl_at_settlement();

COMMIT;
