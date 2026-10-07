BEGIN;
CREATE TEMP TABLE anonymous_completed_expected(payload jsonb);
INSERT INTO anonymous_completed_expected SELECT cash_retirement_native.prepare_completed_shape(5)||cash_retirement_native.prepare_completed_shape(7)||cash_retirement_native.prepare_completed_shape(8);
DO $restitution$
DECLARE
 expected jsonb := (SELECT payload FROM anonymous_completed_expected);
 item jsonb;fr jsonb;move jsonb;src smarter_private.hand_submissions;
 native_commit public.hand_atomic_commits;manifest public.cash_hand_participant_manifests;
 inventory public.union_pnl_inventory_events;seat public.table_seats;
 funding public.cash_participant_funding_receipts;uid uuid;club uuid;tid uuid;v_amount numeric;
 restore_key text;late_key text;delta numeric;result jsonb;ledger uuid;
 wallet_before jsonb := '{}';chairs_before jsonb := '{}';native_before jsonb := '{}';
BEGIN
 IF jsonb_array_length(expected)<>4
 OR (SELECT sum((x->>'base')::numeric) FROM jsonb_array_elements(expected)x)<>575
 OR (SELECT count(DISTINCT x->>'occupancy') FROM jsonb_array_elements(expected)x)<>4
 OR md5(pg_get_functiondef('public.fn_ca_restore_erased_seat_credit(text,uuid,uuid,numeric,uuid,text)'::regprocedure))
 IS DISTINCT FROM '6307d1d0ae4f208de54dd5a0e13985d5'
 OR has_function_privilege('anon','public.fn_ca_restore_erased_seat_credit(text,uuid,uuid,numeric,uuid,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.fn_ca_restore_erased_seat_credit(text,uuid,uuid,numeric,uuid,text)','EXECUTE')
 OR md5(pg_get_functiondef('public.fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text)'::regprocedure)) IS DISTINCT FROM '2e60c4b66468b51061018a9058e9a395'
 OR md5(pg_get_functiondef('public.atomic_seat_cashout_locked(uuid,uuid,integer,text)'::regprocedure)) IS DISTINCT FROM 'e1b0b9702e75378ecac634c3a879502e'
 OR md5(pg_get_functiondef('public.player_leave_table(uuid,uuid)'::regprocedure)) IS DISTINCT FROM 'cbab2d426b0ec091b5b09f3e76eec640'
 OR public.fn_platform_frozen() THEN RAISE EXCEPTION 'COMPLETED_RETIRED_CASH_SOURCE_CHANGED' USING ERRCODE='55000';END IF;
 -- Lock exact funding wallets in a stable order. No foreign chair is written.
 PERFORM 1 FROM public.club_members m JOIN(
 SELECT DISTINCT (x->>'user')::uuid uid,(x->>'funding_club')::uuid club
 FROM jsonb_array_elements(expected)x)t ON t.uid=m.user_id AND t.club=m.club_id
 ORDER BY m.club_id,m.user_id FOR UPDATE OF m;
 -- All immutable witnesses and zero-return predicates precede the first credit.
 FOR item IN SELECT value FROM jsonb_array_elements(expected) ORDER BY value->>'occupancy' LOOP
  uid:=(item->>'user')::uuid;club:=(item->>'funding_club')::uuid;tid:=(item->>'table')::uuid;v_amount:=(item->>'base')::numeric;
  restore_key:='retired_completed_cash_base:'||(item->>'occupancy');
  SELECT * INTO src FROM smarter_private.hand_submissions WHERE submission_id=(item->>'submission')::uuid FOR KEY SHARE;
  SELECT * INTO native_commit FROM public.hand_atomic_commits WHERE table_id=tid AND hand_number=(item->>'hand')::bigint FOR KEY SHARE;
  SELECT * INTO manifest FROM public.cash_hand_participant_manifests WHERE id=(item#>>'{stack,funding_manifest_id}')::uuid;
  SELECT * INTO seat FROM public.table_seats WHERE id=(item->>'seat')::uuid;
  delta:=(item#>>'{stack,stack}')::numeric-(item#>>'{stack,stack_before}')::numeric;
  late_key:='late_seat_settle:'||(item#>>'{hashes,hand_id}')||':'||uid::text;
  IF v_amount<=0 OR (item#>>'{stack,stack_before}')::numeric IS DISTINCT FROM v_amount
  OR src.submission_id IS NULL OR src.request_hash IS DISTINCT FROM item#>>'{hashes,request_hash}'
  OR (src.table_id,src.hand_number) IS DISTINCT FROM(tid,(item->>'hand')::bigint)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(src.request->'p_stacks')x WHERE x=item->'stack')
  OR native_commit.table_id IS NULL OR native_commit.post_commit_completed_at IS NULL OR native_commit.post_commit_result->>'ok' IS DISTINCT FROM 'true'
  OR native_commit.stack_result->>'success' IS DISTINCT FROM 'true' OR native_commit.stack_result->>'conservation_checked' IS DISTINCT FROM 'true'
  OR md5(native_commit.stack_result::text) IS DISTINCT FROM item#>>'{hashes,stack_md5}'
  OR md5(native_commit.post_commit_result::text) IS DISTINCT FROM item#>>'{hashes,post_md5}'
  OR native_commit.payload_hash IS DISTINCT FROM item#>>'{hashes,payload_hash}'
  OR manifest.id IS NULL OR manifest.funding_provenance_complete IS DISTINCT FROM (item->>'manifest_complete')::boolean
  OR manifest.issues IS DISTINCT FROM item->'manifest_issues'
  OR (manifest.table_id,manifest.hand_number) IS DISTINCT FROM(tid,(item->>'hand')::bigint)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(manifest.participants)x WHERE x=item->'manifest_participant')
  OR item#>'{manifest_participant,funding_lineage,issues}' IS DISTINCT FROM '[]'::jsonb
  OR jsonb_array_length(item#>'{manifest_participant,funding_receipts}')=0
  OR NOT EXISTS(SELECT 1 FROM smarter_private.patterned_identity_retirements r WHERE r.old_id=uid AND r.retired_at IS NOT NULL)
  OR NOT EXISTS(SELECT 1 FROM public.club_members m WHERE m.user_id=uid AND m.club_id=club AND m.is_active AND m.status='approved' AND m.departed_at IS NULL)
  THEN RAISE EXCEPTION 'COMPLETED_RETIRED_CASH_IMMUTABLE_NATIVE_OR_FUNDING_CHANGED: %',uid USING ERRCODE='55000';END IF;
  -- The two incomplete whole-hand manifests are kept exactly as recorded.
  -- This restitution proves each original participant independently from the
  -- immutable funding lineage, accepted native before-stack and erased/held row.
  IF (item->>'retained_seat')::boolean THEN
   IF seat.id IS NULL OR NOT(to_jsonb(seat) @> (item->'inventory_before'))
   THEN RAISE EXCEPTION 'COMPLETED_RETIRED_CASH_RETAINED_ORIGINAL_CHANGED' USING ERRCODE='55000';END IF;
  ELSE
   SELECT * INTO inventory FROM public.union_pnl_inventory_events WHERE event_id=(item->>'inventory_event_id')::bigint;
   IF inventory.event_id IS NULL OR inventory.source_name IS DISTINCT FROM 'table_seats'
   OR inventory.row_id IS DISTINCT FROM(item->>'seat')::uuid OR inventory.operation NOT IN('DELETE','UPDATE')
   OR NOT(inventory.before_row @> (item->'inventory_before'))
   OR (seat.id IS NOT NULL AND seat.occupancy_id=(item->>'occupancy')::uuid)
   THEN RAISE EXCEPTION 'COMPLETED_RETIRED_CASH_ERASURE_CHANGED' USING ERRCODE='55000';END IF;
  END IF;
  IF (item#>>'{inventory_before,left_at}')::timestamptz NOT BETWEEN '2026-10-06 15:33:00Z' AND '2026-10-06 15:33:10Z'
  OR (item#>>'{inventory_before,stack}')::numeric IS DISTINCT FROM v_amount
  OR item#>>'{inventory_before,occupancy_id}' IS DISTINCT FROM item->>'occupancy'
  OR item#>>'{inventory_before,user_id}' IS DISTINCT FROM uid::text
  OR item#>>'{inventory_before,table_id}' IS DISTINCT FROM tid::text
  OR item#>>'{inventory_before,joined_at}' IS DISTINCT FROM item#>>'{stack,seat_joined_at}'
  THEN RAISE EXCEPTION 'COMPLETED_RETIRED_CASH_ORIGINAL_BASE_CHANGED' USING ERRCODE='55000';END IF;
  IF delta=0 THEN
   IF item->'departed' IS DISTINCT FROM 'null'::jsonb OR item->'key' IS DISTINCT FROM 'null'::jsonb OR item->'ledger' IS DISTINCT FROM 'null'::jsonb
   OR native_commit.stack_result->'written' ? uid::text
   OR EXISTS(SELECT 1 FROM public.wallet_credit_idempotency w WHERE w.key=late_key)
   OR EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key=late_key)
   THEN RAISE EXCEPTION 'COMPLETED_RETIRED_CASH_ZERO_DELTA_CHANGED' USING ERRCODE='55000';END IF;
  ELSE
   IF jsonb_array_length(item->'departed')<>1 OR (item#>>'{departed,0,delta}')::numeric IS DISTINCT FROM delta
   OR item#>>'{departed,0,club_id}' IS DISTINCT FROM club::text OR item#>>'{departed,0,user_id}' IS DISTINCT FROM uid::text
   OR NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency w WHERE w.key=late_key AND w.user_id=uid AND w.amount=delta)
   OR (SELECT count(*) FROM public.chip_ledger l WHERE l.idempotency_key=late_key)<>1
   OR NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=(item#>>'{ledger,0,id}')::uuid
    AND l.idempotency_key=late_key AND l.amount=abs(delta) AND l.club_id=club AND l.category='settlement'
    AND CASE WHEN delta>0 THEN l.from_type='table_stack' AND l.from_entity_id=tid AND l.to_type='player_wallet' AND l.to_entity_id=uid
    ELSE l.from_type='player_wallet' AND l.from_entity_id=uid AND l.to_type='table_stack' AND l.to_entity_id=tid END)
   THEN RAISE EXCEPTION 'COMPLETED_RETIRED_CASH_ALREADY_SETTLED_DELTA_CHANGED' USING ERRCODE='55000';END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.seat_cashout_receipts r WHERE r.occupancy_id=(item->>'occupancy')::uuid)
  OR EXISTS(SELECT 1 FROM public.table_cashout_history r WHERE r.user_id=uid AND r.table_id=tid AND r.cashed_out_at>=(item#>>'{stack,seat_joined_at}')::timestamptz)
  OR EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.to_type='player_wallet' AND l.to_entity_id=uid AND(l.table_id=tid OR l.from_entity_id=tid)
   AND l.created_at>=(item#>>'{stack,seat_joined_at}')::timestamptz AND l.idempotency_key IS DISTINCT FROM late_key)
  OR EXISTS(SELECT 1 FROM public.wallet_credit_idempotency w WHERE w.key=restore_key)
  OR EXISTS(SELECT 1 FROM public.ca_mint_ledger l WHERE l.op_id=restore_key)
  THEN RAISE EXCEPTION 'COMPLETED_RETIRED_CASH_BASE_ALREADY_RETURNED_OR_KEY_COLLISION' USING ERRCODE='55000';END IF;
  FOR fr IN SELECT value FROM jsonb_array_elements(item#>'{manifest_participant,funding_receipts}') LOOP
   SELECT * INTO funding FROM public.cash_participant_funding_receipts WHERE id=(fr->>'id')::uuid;
   IF funding.id IS NULL OR funding.user_id IS DISTINCT FROM uid OR funding.account_entity_id IS DISTINCT FROM uid
   OR funding.account_type IS DISTINCT FROM 'player_wallet' OR funding.funding_club_id IS DISTINCT FROM club OR funding.asset IS DISTINCT FROM 'chips' OR funding.amount<=0
   OR NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=funding.source_ledger_id AND l.from_type='player_wallet' AND l.from_entity_id=uid AND l.club_id=club AND l.amount=funding.amount)
   OR NOT EXISTS(SELECT 1 FROM public.wallet_transactions w WHERE w.id=funding.wallet_transaction_id AND w.user_id=uid AND w.amount=funding.amount AND w.type='debit')
   THEN RAISE EXCEPTION 'COMPLETED_RETIRED_CASH_FUNDING_DEBIT_CHANGED' USING ERRCODE='55000';END IF;
  END LOOP;
  FOR move IN SELECT value FROM jsonb_array_elements(item#>'{manifest_participant,funding_lineage,moves}') LOOP
   IF NOT EXISTS(SELECT 1 FROM public.cash_seat_move_receipts r WHERE r.move_id=(move->>'move_id')::uuid AND to_jsonb(r) @> move AND r.player_id=uid AND r.club_id=club)
   THEN RAISE EXCEPTION 'COMPLETED_RETIRED_CASH_FUNDING_MOVE_CHANGED' USING ERRCODE='55000';END IF;
  END LOOP;
  wallet_before:=wallet_before||jsonb_build_object(club::text||':'||uid::text,(SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=uid));
  chairs_before:=chairs_before||jsonb_build_object(item->>'seat',to_jsonb(seat));
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(expected) ORDER BY value->>'occupancy' LOOP
  uid:=(item->>'user')::uuid;club:=(item->>'funding_club')::uuid;tid:=(item->>'table')::uuid;v_amount:=(item->>'base')::numeric;
  restore_key:='retired_completed_cash_base:'||(item->>'occupancy');
  result:=public.fn_ca_restore_erased_seat_credit(restore_key,uid,club,v_amount,tid,
   'Current restitution of original cash base excluded by patterned-account retirement; original hand already completed '||(item->>'submission')||'; delta and fees preserved');
  ledger:=(result->>'chip_ledger_id')::uuid;
  IF result->>'restored' IS DISTINCT FROM 'true' OR result->>'key' IS DISTINCT FROM restore_key
  OR (result->>'user_id')::uuid IS DISTINCT FROM uid OR (result->>'club_id')::uuid IS DISTINCT FROM club OR(result->>'amount')::numeric IS DISTINCT FROM v_amount
  OR NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=ledger AND l.idempotency_key=restore_key AND l.category='refund'
   AND l.from_type='issuance_reserve' AND l.to_type='player_wallet' AND l.to_entity_id=uid AND l.club_id=club AND l.amount=v_amount)
  OR NOT EXISTS(SELECT 1 FROM public.ca_mint_ledger l WHERE l.op_id=restore_key AND l.action='mint' AND l.asset='chips' AND l.holder_type='player' AND l.holder_id=uid AND l.amount=v_amount AND l.chip_ledger_id=ledger)
  OR NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency w WHERE w.key=restore_key AND w.user_id=uid AND w.amount=v_amount)
  THEN RAISE EXCEPTION 'COMPLETED_RETIRED_CASH_RESTITUTION_INCOHERENT' USING ERRCODE='55000';END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(expected) LOOP
  SELECT * INTO seat FROM public.table_seats WHERE id=(item->>'seat')::uuid;
  IF COALESCE(to_jsonb(seat),'null'::jsonb) IS DISTINCT FROM chairs_before->(item->>'seat') THEN
   RAISE EXCEPTION 'COMPLETED_RETIRED_CASH_FOREIGN_OR_RETAINED_CHAIR_CHANGED' USING ERRCODE='55000';END IF;
  SELECT * INTO native_commit FROM public.hand_atomic_commits WHERE table_id=(item->>'table')::uuid AND hand_number=(item->>'hand')::bigint;
  IF md5(native_commit.stack_result::text) IS DISTINCT FROM item#>>'{hashes,stack_md5}'
  OR md5(native_commit.post_commit_result::text) IS DISTINCT FROM item#>>'{hashes,post_md5}'
  THEN RAISE EXCEPTION 'COMPLETED_RETIRED_CASH_ORIGINAL_HAND_REWRITTEN' USING ERRCODE='55000';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_each(wallet_before)b WHERE(
  SELECT chip_balance FROM public.club_members WHERE club_id=split_part(b.key,':',1)::uuid AND user_id=split_part(b.key,':',2)::uuid)
  IS DISTINCT FROM b.value::numeric+(SELECT sum((x->>'base')::numeric) FROM jsonb_array_elements(expected)x WHERE x->>'funding_club'=split_part(b.key,':',1) AND x->>'user'=split_part(b.key,':',2)))
 THEN RAISE EXCEPTION 'COMPLETED_RETIRED_CASH_WALLET_DELTA_INCOHERENT' USING ERRCODE='55000';END IF;
 RAISE NOTICE 'COMPLETED_RETIRED_CASH_BASE_23_RETURNED_9404_73';
END $restitution$;
ROLLBACK;
