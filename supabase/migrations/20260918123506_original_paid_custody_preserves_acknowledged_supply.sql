-- Original paid custody preserves the distinct existing felt acknowledgement.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
DO $preimage$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_resume_original_paid_tournament_entry(uuid,jsonb)'::regprocedure AND md5(pg_get_functiondef(oid))='20d43d50e8301979dd7b99b72ad36710' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'ORIGINAL_PAID_ACK_PREIMAGE_CHANGED: %','fn_ca_resume_original_paid_tournament_entry(uuid,jsonb)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)'::regprocedure AND md5(pg_get_functiondef(oid))='0fe132756ddf22122c91aa0d7fd323cd' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'ORIGINAL_PAID_ACK_PREIMAGE_CHANGED: %','fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_guard_mtt_admission_contract()'::regprocedure AND md5(pg_get_functiondef(oid))='98363a25bad4495a4b32e7cd99354c37' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'ORIGINAL_PAID_ACK_PREIMAGE_CHANGED: %','fn_ca_guard_mtt_admission_contract()'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_tournament_chip_supply(uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='c29dfa4a0ebef95fddeb8a0982ef07e1' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'ORIGINAL_PAID_ACK_PREIMAGE_CHANGED: %','fn_ca_tournament_chip_supply(uuid)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_tournament_felt_may_not_exceed_supply()'::regprocedure AND md5(pg_get_functiondef(oid))='af7e8bee512e4fe9e7e383bdd73390fd' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'ORIGINAL_PAID_ACK_PREIMAGE_CHANGED: %','fn_ca_tournament_felt_may_not_exceed_supply()'; END IF;
IF (SELECT count(*) FROM pg_trigger WHERE tgfoid='public.fn_ca_tournament_felt_may_not_exceed_supply()'::regprocedure)<>1 OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE tgrelid='public.table_seats'::regclass AND tgname='zzzzzz_tournament_felt_may_not_exceed_supply' AND tgfoid='public.fn_ca_tournament_felt_may_not_exceed_supply()'::regprocedure AND tgenabled='O' AND tgtype=21 AND tgdeferrable AND tginitdeferred AND tgqual IS NULL AND length(tgargs)=0 AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=t.tgrelid AND a.attnum=ANY(t.tgattr))=ARRAY['stack','left_at']) THEN RAISE EXCEPTION 'ORIGINAL_PAID_ACK_PREIMAGE_CHANGED: deferred attachment'; END IF;
END $preimage$;
CREATE OR REPLACE FUNCTION public.fn_ca_resume_original_paid_tournament_entry(p_receipt_id uuid,p_expected jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE
 t uuid:=(p_expected->>'tournament_id')::uuid;
 u uuid:=(p_expected->>'user_id')::uuid;
 tab uuid:=(p_expected->>'destination_table_id')::uuid;
 chair integer:=(p_expected->>'destination_seat_number')::integer;
 g uuid:=(p_expected->>'generation')::uuid;
 c public.tournament_knockout_candidates;
 tp public.tournament_players;
 tour public.tournaments;
 ent public.tournament_refund_entitlements;
 led public.chip_ledger;
 wallet public.wallet_transactions;
 lease public.engine_tournament_leases;
 h public.hand_atomic_commits;
 prior public.tournament_paid_stack_custody_receipts;
 actual jsonb; others jsonb; others_after jsonb; supply numeric; live numeric;
 acknowledged_supply numeric; acknowledgement jsonb;
 original_seat jsonb; gate jsonb; v_assignment jsonb; v_purchase_key text; paid_at timestamptz; v_rows integer;
 grant_chips numeric; money_before jsonb; money_after jsonb; resolved timestamptz;
BEGIN
 IF p_receipt_id IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
 OR t IS NULL OR u IS NULL OR tab IS NULL OR g IS NULL OR chair IS NULL
 OR chair NOT BETWEEN 1 AND 10 THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_IDENTITY_REQUIRED' USING ERRCODE='22023'; END IF;
 IF public.fn_platform_frozen() THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ca:original-paid-stack:'||p_receipt_id::text,0));
 SELECT * INTO prior FROM public.tournament_paid_stack_custody_receipts WHERE id=p_receipt_id;
 IF FOUND THEN
  IF prior.expected IS DISTINCT FROM p_expected OR prior.state IS DISTINCT FROM 'seated' THEN
   RAISE EXCEPTION 'ORIGINAL_PAID_CHANGED_REPLAY' USING ERRCODE='22023'; END IF;
  RETURN prior.assignment||jsonb_build_object('receipt_id',prior.id,'replayed',true);
 END IF;

 -- The existing seat owner supplies G/T, entry-maintenance, admission, player,
 -- launch and tournament order. Never wait on a lease after holding that lane:
 -- protocol-2 requests can own the lease first and be waiting on T.
 gate:=public.fn_ca_lock_tournament_seat_acquisition(t,tab,u);
 IF gate->>'ok' IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_SEAT_ROOT_REFUSED: %',gate USING ERRCODE='55000'; END IF;
 SELECT * INTO lease FROM public.engine_tournament_leases WHERE tournament_id=t FOR UPDATE NOWAIT;
 IF NOT FOUND OR lease.lease_generation IS DISTINCT FROM g OR lease.protocol_version IS DISTINCT FROM 2
 OR lease.instance_id IS DISTINCT FROM p_expected->>'instance_id'
 OR lease.engine_version IS DISTINCT FROM p_expected->>'engine_version' THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_LEASE_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM id FROM public.tournament_players WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM id FROM public.tables WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM s.id FROM public.table_seats s JOIN public.tables b ON b.id=s.table_id
 WHERE b.tournament_id=t ORDER BY s.id FOR UPDATE OF s;
 SELECT * INTO tour FROM public.tournaments WHERE id=t;
 SELECT * INTO tp FROM public.tournament_players WHERE tournament_id=t AND user_id=u;
 SELECT * INTO c FROM public.tournament_knockout_candidates
 WHERE id=(p_expected->>'candidate_id')::uuid FOR UPDATE;
 SELECT * INTO ent FROM public.tournament_refund_entitlements
 WHERE id=(p_expected->>'entitlement_id')::uuid;
 SELECT * INTO led FROM public.chip_ledger WHERE id=ent.source_ledger_id;
 SELECT * INTO wallet FROM public.wallet_transactions
 WHERE id=(p_expected->>'wallet_transaction_id')::uuid;
 SELECT * INTO h FROM public.hand_atomic_commits
 WHERE hand_id=c.hand_id AND table_id=c.table_id AND hand_number=c.hand_number;
 v_purchase_key:='tourney:'||t::text||':rebuy:'||u::text||':#0';
 grant_chips:=tour.rebuy_chips;
 SELECT to_jsonb(s) INTO original_seat FROM public.table_seats s WHERE s.id=c.seat_id;

 -- This is one original legacy, non-bounty MTT entry. The current paid writer
 -- cannot create this shape; its purchase, candidate and chair commit together.
 IF tour.status IS DISTINCT FROM 'RUNNING' OR tour.format_contract IS DISTINCT FROM 'mtt-v1'
 OR tour.tournament_type IS DISTINCT FROM 'MTT' OR COALESCE(tour.is_bounty,false)
 OR COALESCE(tour.is_pko,false) OR COALESCE(tour.is_mystery_bounty,false)
 OR NOT COALESCE(tour.entry_contract_locked,false)
 OR NOT COALESCE(tour.prize_pool_finalized,false)
 OR tp.id IS NULL OR tp.status IS DISTINCT FROM 'playing' OR tp.position IS NOT NULL
 OR COALESCE(tp.prize,0)<>0 OR tp.table_id IS NOT NULL OR tp.seat_number IS NOT NULL
 OR tp.terminal_closed_at IS NOT NULL OR tp.rebuys IS DISTINCT FROM 1
 OR tp.add_on IS DISTINCT FROM false OR tp.chips::numeric IS DISTINCT FROM grant_chips
 OR grant_chips IS NULL OR grant_chips<=0 OR grant_chips<>trunc(grant_chips) OR grant_chips>=2147483648
 OR c.id IS NULL OR c.tournament_id IS DISTINCT FROM t OR c.eliminated_user_id IS DISTINCT FROM u
 OR c.state IS DISTINCT FROM 'pending' OR c.resolved_at IS NOT NULL OR c.stack_after IS DISTINCT FROM 0
 OR (SELECT count(*) FROM public.tournament_knockout_candidates WHERE tournament_id=t AND eliminated_user_id=u)<>1
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=t AND status='playing')<>2
 OR EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables b ON b.id=s.table_id
           WHERE b.tournament_id=t AND s.user_id=u AND s.left_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.tournament_paid_stack_custody_receipts r
           WHERE r.candidate_id=c.id OR r.entitlement_id=ent.id OR r.source_ledger_id=led.id)
 OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.entitlement_id=ent.id)
 THEN RAISE EXCEPTION 'ORIGINAL_PAID_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;

 -- Both independent accepted journals establish the exact old zero. Durable
 -- settlement keys also exclude later play after horse hand-history pruning.
 IF h.hand_id IS NULL OR h.stack_result->>'success' IS DISTINCT FROM 'true'
 OR h.stack_result->>'table_id' IS DISTINCT FROM c.table_id::text
 OR h.stack_result->>'hand_number' IS DISTINCT FROM c.hand_number::text
 OR (h.stack_result->'written'->>u::text)::numeric IS DISTINCT FROM 0
 OR c.created_at>h.committed_at
 OR c.seat_joined_at IS NULL OR c.seat_id IS NULL OR c.stack_before<=0
 OR original_seat IS NULL OR original_seat->>'table_id' IS DISTINCT FROM c.table_id::text
 OR (original_seat->>'joined_at')::timestamptz<c.seat_joined_at
 OR (original_seat->>'left_at') IS NULL
 OR (original_seat->>'stack')::numeric IS DISTINCT FROM 0
 OR h.post_commit_completed_at IS NULL OR h.post_commit_result->>'ok' IS DISTINCT FROM 'true'
 OR (SELECT count(*) FROM public.settlement_idempotency_keys k WHERE k.table_id=h.table_id
     AND k.hand_id::text=h.stack_result->>'hand_id' AND k.status='succeeded'
     AND k.completed_at IS NOT NULL AND k.result IS NOT DISTINCT FROM h.stack_result)<>1
 OR EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k JOIN public.tables b ON b.id=k.table_id
     WHERE b.tournament_id=t AND k.result->'written' ? u::text
       AND (COALESCE(k.result->>'hand_number','') !~ '^[0-9]+$'
         OR (k.result->>'hand_number')::bigint>c.hand_number))
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits k JOIN public.tables b ON b.id=k.table_id
     WHERE b.tournament_id=t AND k.stack_result->'written' ? u::text AND k.hand_number>c.hand_number)
 THEN RAISE EXCEPTION 'ORIGINAL_PAID_ACCEPTED_HISTORY_CHANGED' USING ERRCODE='55000'; END IF;
 paid_at:=led.created_at;
 IF ent.id IS NULL OR ent.tournament_id IS DISTINCT FROM t OR ent.user_id IS DISTINCT FROM u
 OR ent.entitlement_kind IS DISTINCT FROM 'wallet_charge' OR ent.charge_category IS DISTINCT FROM 'rebuy'
 OR ent.evidence_kind IS DISTINCT FROM 'cutover_wallet_charge' OR ent.escrow_bucket IS DISTINCT FROM 'wallet_gross'
 OR ent.gross IS NULL OR ent.gross<=0 OR ent.gross>='Infinity' OR ent.gross<>round(ent.gross,2)
 OR ent.gross IS DISTINCT FROM ent.refund_prize+ent.refund_fee+ent.refund_bounty
 OR ent.refund_bounty IS DISTINCT FROM 0
 OR (SELECT count(*) FROM public.tournament_refund_entitlements e WHERE e.tournament_id=t AND e.user_id=u)<>1
 OR led.id IS NULL OR led.status IS DISTINCT FROM 'posted' OR led.category IS DISTINCT FROM 'rebuy'
 OR led.from_type IS DISTINCT FROM 'player_wallet' OR led.from_entity_id IS DISTINCT FROM u
 OR led.to_type IS DISTINCT FROM 'prize_liability' OR led.to_entity_id IS DISTINCT FROM t
 OR led.tournament_id IS DISTINCT FROM t OR led.club_id IS DISTINCT FROM ent.refund_wallet_club_id
 OR tp.club_id IS DISTINCT FROM ent.refund_wallet_club_id OR led.amount IS DISTINCT FROM ent.gross
 OR led.row_hash IS NULL OR led.chain_seq IS NULL OR led.created_at IS DISTINCT FROM ent.created_at
 OR paid_at IS NULL OR paid_at<=GREATEST(c.created_at,h.committed_at,h.post_commit_completed_at)
 OR wallet.id IS NULL OR wallet.user_id IS DISTINCT FROM u OR wallet.related_entity_id IS DISTINCT FROM t
 OR wallet.type IS DISTINCT FROM 'debit' OR wallet.category IS DISTINCT FROM 'rebuy'
 OR wallet.wallet_type IS DISTINCT FROM 'PLAYER' OR wallet.amount IS DISTINCT FROM ent.gross
 OR wallet.created_at IS DISTINCT FROM paid_at OR COALESCE(wallet.description,'') NOT LIKE 'Tournament rebuy:%'
 OR (SELECT count(*) FROM public.wallet_transactions w WHERE w.user_id=u AND w.related_entity_id=t
     AND w.type='debit' AND w.category='rebuy' AND w.created_at=paid_at AND w.amount=ent.gross)<>1
 OR NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency i WHERE i.key=v_purchase_key AND i.user_id=u
     AND i.amount=0 AND i.created_at=paid_at)
 OR EXISTS(SELECT 1 FROM public.wallet_transactions w WHERE w.user_id=u AND w.related_entity_id=t AND w.type='credit')
 THEN RAISE EXCEPTION 'ORIGINAL_PAID_FUNDING_CHANGED' USING ERRCODE='55000'; END IF;

 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=t AND state='reserved')
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE tournament_id=t AND state NOT IN ('acknowledged','withdrawn_before_manifest'))
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots s JOIN public.tables b ON b.id=s.table_id
           WHERE b.tournament_id=t AND NOT s.is_complete)
 OR EXISTS(SELECT 1 FROM public.table_seats WHERE id=c.seat_id AND user_id=u
           AND joined_at=c.seat_joined_at AND (left_at IS NULL OR stack<>0))
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=tab AND tournament_id=t AND NOT COALESCE(is_deleted,false)
               AND lower(status) IN ('waiting','running','active'))
 THEN RAISE EXCEPTION 'ORIGINAL_PAID_ACTIVE_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id),sum(s.stack) INTO others,live
 FROM public.table_seats s JOIN public.tables b ON b.id=s.table_id WHERE b.tournament_id=t AND s.left_at IS NULL;
 IF jsonb_array_length(others) IS DISTINCT FROM 1 OR live IS NULL OR live<=0
 OR others->0->>'table_id' IS DISTINCT FROM tab::text
 OR others->0->>'user_id' IS NOT DISTINCT FROM u::text
 OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=t AND p.status='playing' AND p.user_id<>u
   AND (p.chips::numeric IS DISTINCT FROM live OR p.table_id IS DISTINCT FROM tab OR p.seat_number IS DISTINCT FROM (others->0->>'seat_number')::integer)) THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_SURVIVOR_CHANGED' USING ERRCODE='55000'; END IF;
 -- Funded scoring supply is the unchanged assignment owner's raw roster cap.
 -- A prior felt acknowledgement is separate evidence, never another purchase.
 SELECT (count(*)*COALESCE(tour.starting_chips,0))
       +(COALESCE(sum(p.rebuys),0)*COALESCE(tour.rebuy_chips,0))
       +(count(*) FILTER (WHERE p.add_on)*COALESCE(tour.addon_chips,0))
 INTO supply FROM public.tournament_players p WHERE p.tournament_id=t;
 SELECT to_jsonb(a) INTO acknowledgement
 FROM public.tournament_felt_supply_acknowledgements a WHERE a.tournament_id=t FOR UPDATE NOWAIT;
 acknowledged_supply:=public.fn_ca_tournament_chip_supply(t);
 IF acknowledged_supply IS NULL OR acknowledged_supply::text IN ('NaN','Infinity','-Infinity')
 OR acknowledged_supply IS DISTINCT FROM supply+COALESCE((acknowledgement->>'chips')::numeric,0) THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_SUPPLY_PROOF_CHANGED' USING ERRCODE='55000'; END IF;
 actual:=jsonb_build_object('tournament_id',t,'user_id',u,'destination_table_id',tab,
  'destination_seat_number',chair,'generation',g,'instance_id',lease.instance_id,'engine_version',lease.engine_version,
  'candidate_id',c.id,'entitlement_id',ent.id,'wallet_transaction_id',wallet.id,
  'candidate',to_jsonb(c),'original_seat',original_seat,'player',to_jsonb(tp),'entitlement',to_jsonb(ent),'ledger',to_jsonb(led),
  'wallet',to_jsonb(wallet),'live_seats',others,'funded_supply',supply,'grant_chips',grant_chips,
  'acknowledged_supply',acknowledged_supply,'supply_acknowledgement',acknowledgement,
  'scoring_excess',live+grant_chips-supply);
 IF actual IS DISTINCT FROM p_expected THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_EXPECTED_CHANGED' USING ERRCODE='55000'; END IF;
 IF public.fn_platform_frozen() THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 -- No ledger, wallet, escrow, rake, prize, counter or monetary-baseline writes.
 money_before:=jsonb_build_object('tournament',to_jsonb(tour),'player_rebuys',tp.rebuys,'player_chips',tp.chips,
   'entitlement',to_jsonb(ent),'ledger',to_jsonb(led),'wallet',to_jsonb(wallet));
 INSERT INTO public.tournament_paid_stack_custody_receipts(id,tournament_id,user_id,candidate_id,entitlement_id,
 source_ledger_id,source_wallet_id,destination_table_id,destination_seat_number,grant_chips,
 live_chips_before,funded_supply,scoring_excess,expected,state)
 VALUES(p_receipt_id,t,u,c.id,ent.id,led.id,wallet.id,tab,chair,grant_chips,live,supply,live+grant_chips-supply,actual,'reserved');
 resolved:=clock_timestamp();
 UPDATE public.tournament_knockout_candidates SET state='rebought',resolved_at=resolved WHERE id=c.id AND state='pending';
 GET DIAGNOSTICS v_rows=ROW_COUNT;
 IF v_rows<>1 THEN RAISE EXCEPTION 'ORIGINAL_PAID_CANDIDATE_CHANGED' USING ERRCODE='40001'; END IF;
 UPDATE public.tournament_players SET rebuy_prompt_until=NULL WHERE id=tp.id AND chips=tp.chips AND status='playing';
 v_assignment:=public.fn_ca_assign_tournament_player_seat_locked(t,u,tab,chair);
 IF v_assignment->>'ok' IS DISTINCT FROM 'true' OR (v_assignment->>'stack')::numeric IS DISTINCT FROM grant_chips THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_ASSIGNMENT_REFUSED: %',v_assignment USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) INTO others_after FROM public.table_seats s JOIN public.tables b ON b.id=s.table_id
 WHERE b.tournament_id=t AND s.left_at IS NULL AND s.user_id<>u;
 SELECT jsonb_build_object('tournament',to_jsonb(a),'player_rebuys',p.rebuys,'player_chips',p.chips,
 'entitlement',to_jsonb(e),'ledger',to_jsonb(l),'wallet',to_jsonb(w)) INTO money_after
 FROM public.tournaments a JOIN public.tournament_players p ON p.tournament_id=a.id AND p.user_id=u
 JOIN public.tournament_refund_entitlements e ON e.id=ent.id JOIN public.chip_ledger l ON l.id=led.id
 JOIN public.wallet_transactions w ON w.id=wallet.id WHERE a.id=t;
 IF others_after IS DISTINCT FROM others OR money_after IS DISTINCT FROM money_before
 OR public.fn_ca_tournament_chip_supply(t) IS DISTINCT FROM acknowledged_supply
 OR (SELECT to_jsonb(a) FROM public.tournament_felt_supply_acknowledgements a WHERE a.tournament_id=t) IS DISTINCT FROM acknowledgement
 OR public.fn_ca_tournament_felt_total(t) IS DISTINCT FROM live+grant_chips THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_FINAL_VECTOR_CHANGED' USING ERRCODE='55000'; END IF;
 v_assignment:=v_assignment||jsonb_build_object('receipt_id',p_receipt_id,'original_entitlement_id',ent.id,
 'original_ledger_id',led.id,'scoring_excess',live+grant_chips-supply,'occupancy_id',
 (SELECT occupancy_id FROM public.table_seats WHERE id=(v_assignment->>'seat_id')::uuid));
 UPDATE public.tournament_paid_stack_custody_receipts SET state='seated',assignment=v_assignment,completed_at=clock_timestamp()
 WHERE id=p_receipt_id AND state='reserved';
 PERFORM public.fn_emit_tournament_manager_wake(t,'rebuy');
 RETURN v_assignment;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_resume_original_paid_tournament_entry(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_was numeric;
  v_now numeric;
  v_delta numeric;
  v_felt numeric;
  v_supply numeric;
BEGIN
  -- What this row contributes to the felt. A vacated seat contributes nothing,
  -- whatever its stack still says - that stale figure is the whole defect.
  v_now := CASE WHEN NEW.left_at IS NULL THEN COALESCE(NEW.stack,0) ELSE 0 END;
  v_was := CASE WHEN TG_OP = 'INSERT' THEN 0
                WHEN OLD.left_at IS NULL THEN COALESCE(OLD.stack,0)
                ELSE 0 END;
  v_delta := v_now - v_was;

  -- Only growth is judged. A seat exit, a losing bet and a no-op never refuse:
  -- a guard that can refuse a seat exit strands a player mid-hand.
  IF v_delta <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb WHERE tb.id = NEW.table_id;
  IF v_tournament_id IS NULL THEN
    RETURN NULL;                      -- a cash seat; supply is not the meter
  END IF;

  -- DEFERRED, so this is the committed end state of the whole transaction:
  -- every seat of a settled hand, or the vacate and the re-seat of a move.
  v_felt   := public.fn_ca_tournament_felt_total(v_tournament_id);
  v_supply := public.fn_ca_tournament_chip_supply(v_tournament_id);

  -- Tolerate history, refuse growth: only the write that CARRIES the felt over
  -- the line is refused. An event already over stays playable.
  IF v_felt > v_supply AND (v_felt - v_delta) <= v_supply
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_paid_stack_custody_receipts r
       JOIN public.table_seats s ON s.id=NEW.id
       WHERE r.transaction_id=pg_current_xact_id() AND r.state='seated'
         AND r.tournament_id=v_tournament_id AND r.user_id=NEW.user_id
         AND r.destination_table_id=NEW.table_id AND r.destination_seat_number=NEW.seat_number
         AND r.assignment->>'seat_id'=NEW.id::text
         AND r.assignment->>'occupancy_id'=NEW.occupancy_id::text
         AND s.user_id=NEW.user_id AND s.table_id=NEW.table_id AND s.seat_number=NEW.seat_number
         AND s.occupancy_id=NEW.occupancy_id AND s.left_at IS NULL AND s.stack=r.grant_chips
         AND v_was=0 AND v_now=r.grant_chips AND v_delta=r.grant_chips
         AND r.live_chips_before+r.grant_chips=v_felt
         AND (r.expected->>'acknowledged_supply')::numeric=v_supply
         AND r.expected->'supply_acknowledgement' IS NOT DISTINCT FROM
           (SELECT to_jsonb(a) FROM public.tournament_felt_supply_acknowledgements a WHERE a.tournament_id=v_tournament_id)
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_FELT_WOULD_EXCEED_SUPPLY: seat % (table %, seat %) adds % chips, '
      'leaving % on the felt of tournament % against % ever bought in',
      NEW.id, NEW.table_id, NEW.seat_number, v_delta, v_felt,
      v_tournament_id, v_supply
      USING ERRCODE = '55000',
            HINT = 'A vacated seat''s stack is a stale snapshot, not chips. '
                   'Fund a seat from the felt the player is leaving, or record '
                   'the creation in tournament_felt_supply_acknowledgements.';
  END IF;

  RETURN NULL;
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() FROM PUBLIC;
DO $postimage$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_resume_original_paid_tournament_entry(uuid,jsonb)'::regprocedure AND md5(prosrc)='0215bdca0377cdb01269b9a96d47380f' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_tournament_felt_may_not_exceed_supply()'::regprocedure AND md5(pg_get_functiondef(oid))='bcdc829c9f3f1a6b2f6ee44ad6122403' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'ORIGINAL_PAID_ACK_POSTIMAGE_CHANGED'; END IF; END $postimage$;
COMMIT;
