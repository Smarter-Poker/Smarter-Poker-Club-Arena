-- F06 MIXED CUSTODY PRESENCE: refuse the one unproven player, never the whole event.
--
-- 20260918232558 introduced smarter_private.f06_mixed_adopt_presence. There,
-- presence came from custody->'durable_presence', the engine_presence_parked row
-- written by the same park that wrote the bank-custody roster, so the two sets
-- had the same domain and requiring a roster entry for every presence key was
-- free.
--
-- 20260919032212 added the 'stopped_capture' path: presence may now be the
-- engine's own pre-disposal snapshot, whose 'disconnect_states' is the table's
-- WHOLE FSM presence map. That map is a strict superset of the roster - the
-- roster is only the seated occupancies the drain took custody of, each proven
-- (user, occupancy, seat_number) against table_seats at prepare time
-- (F06_STOPPED_BANK_ORIGINAL_CHANGED). The roster requirement was carried over
-- unchanged, so a single disconnect state left behind by a player who had
-- already moved tables or busted made F06_MIXED_PRESENCE_ORIGINAL_UNPROVEN
-- unsatisfiable and stranded the entire event permanently.
--
-- Live evidence at the time of this migration: 35 RUNNING events blocked, 42
-- unmatched presence users across them. NONE held a time bank, and NONE still
-- held a seat at the source table (25 had moved to another table in the same
-- event, 17 were eliminated). Every one was a stale FSM entry for a seat its
-- player no longer occupied.
--
-- The property the check protects is that presence is never attached to a seat
-- whose lineage back to the drained original occupancy cannot be proved. That is
-- kept exactly. What changes is the blast radius of a failure to prove it: an
-- unprovable presence fact now refuses THAT PLAYER and adopts nothing for them,
-- instead of refusing the event. The refusal is recorded in the returned
-- presence receipts, which are stored on the completion row as evidence.
--
-- The narrowed refusal applies only when the player is provably not in custody
-- at that table: no roster entry, no time bank, and no live seat. Everything
-- else still raises as before - a duplicate roster entry, a null occupancy, a
-- time bank without a roster entry (already unreachable: f06_mixed_bank_proof
-- rejects that with F06_MIXED_BANK_OCCUPANCY_UNPROVEN), and now also a player
-- who still holds a live seat at the table but is missing from the roster,
-- which is a genuine custody inconsistency and is newly guarded here.
--
-- Chips are untouched by this function. No time bank is adopted, altered or
-- dropped for any player who has one: a skipped player has no bank by
-- construction. The historical-loss path keeps its independent destination
-- guard (F06_HISTORICAL_LOSS_DESTINATION_CUSTODY_MISSING), and the narrowed
-- refusal is applied there too rather than leaving the same permanent-stranding
-- trap armed for historical events.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';

DO $guard$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_proc
    WHERE oid = to_regprocedure('smarter_private.f06_mixed_adopt_presence(uuid,jsonb)')
      AND md5(pg_get_functiondef(oid)) = '879346c3116cf1cb70953323e3d31cec'
      AND md5(prosrc) = '009ddd1a79f92c4a64ad4b3adfe08107'
      AND pg_get_userbyid(proowner) = 'postgres'
      AND prosecdef
      AND proacl::text = '{postgres=X/postgres}'
      AND proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
  ) THEN RAISE EXCEPTION 'F06_MIXED_PRESENCE_DEPENDENCY_DRIFT'; END IF;

  -- Relied on below: every time-bank key already carries a matching roster
  -- entry, so a skipped player can never be one who holds a bank.
  IF NOT EXISTS(
    SELECT 1 FROM pg_proc
    WHERE oid = to_regprocedure('smarter_private.f06_mixed_bank_proof(uuid,jsonb)')
      AND prosrc LIKE '%F06_MIXED_BANK_OCCUPANCY_UNPROVEN%'
  ) THEN RAISE EXCEPTION 'F06_MIXED_BANK_OCCUPANCY_GUARD_MISSING'; END IF;
END $guard$;

CREATE OR REPLACE FUNCTION smarter_private.f06_mixed_adopt_presence(t uuid, local_proof jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE bank_proof jsonb; historical boolean; engine jsonb; custody jsonb; durable jsonb; banks jsonb; fsm jsonb; user_key text; original_stay uuid;
 target public.table_seats; bank jsonb; presence jsonb; targets jsonb:='{}'; item jsonb; table_key text;
 hand bigint; at_time timestamptz:=clock_timestamp(); receipt jsonb; receipts jsonb:='[]'; n integer;
BEGIN
 FOR item IN SELECT jsonb_build_object('source',e,'proof',smarter_private.f06_mixed_bank_proof(t,e)) FROM jsonb_array_elements(local_proof->'engines') e UNION ALL SELECT value FROM jsonb_array_elements(smarter_private.f06_historical_loss_pending(t,local_proof,true)) LOOP
 engine:=item->'source';
 bank_proof:=item->'proof';
 durable:=bank_proof->'presence'; custody:=engine->'bank_custody';
 historical:=bank_proof ? 'historical_loss';
 IF historical THEN
 -- Only this new normal session uses a completion timestamp. The original raw
 -- custody remains in the immutable transfer; it is never labelled preserved.
 custody:=jsonb_set(custody,'{roster}',bank_proof->'source_roster');
 durable:=jsonb_set(durable,'{parked_at}',to_jsonb(at_time));
 END IF;
 banks:=COALESCE(durable#>'{time_bank_snapshot,players}','{}'::jsonb);
 fsm:=COALESCE(durable->'disconnect_states','{}'::jsonb);
 FOR user_key IN SELECT key FROM jsonb_object_keys(banks||fsm) AS keys(key) ORDER BY key LOOP
 SELECT count(*),min((r->>1)::text)::uuid INTO n,original_stay FROM jsonb_array_elements(custody->'roster') r WHERE r->>0=user_key;
 -- A stopped-capture snapshot carries the table's whole FSM presence map, a
 -- superset of the roster. A disconnect state whose player holds no roster
 -- entry, no time bank and no live seat here is not custody: it is a stale
 -- entry for a seat that player no longer occupies. Refuse that one player,
 -- adopt nothing for them, and record the refusal. The event is not stranded.
 IF n=0 AND NOT (banks ? user_key)
 AND NOT EXISTS(SELECT 1 FROM public.table_seats seat WHERE seat.table_id=(engine->>'table_id')::uuid
 AND seat.user_id=user_key::uuid AND seat.left_at IS NULL) THEN
 receipts:=receipts||jsonb_build_array(jsonb_build_object('user_id',user_key,'source_table',engine->>'table_id',
 'adopted',false,'refused','f06_mixed_presence_original_unproven'));
 CONTINUE;
 END IF;
 IF n<>1 OR original_stay IS NULL THEN RAISE EXCEPTION 'F06_MIXED_PRESENCE_ORIGINAL_UNPROVEN'; END IF;
 SELECT count(*) INTO n FROM public.table_seats seat WHERE seat.table_id=(engine->>'table_id')::uuid
 AND seat.user_id=user_key::uuid AND seat.occupancy_id=original_stay AND seat.left_at IS NULL;
 receipt:=NULL;
 IF n=1 THEN
 SELECT * INTO target FROM public.table_seats seat WHERE seat.table_id=(engine->>'table_id')::uuid AND seat.user_id=user_key::uuid AND seat.occupancy_id=original_stay AND seat.left_at IS NULL;
 ELSE
 SELECT count(*) INTO n FROM public.tournament_seat_move_receipts m JOIN smarter_private.f06_attempts a ON a.request_id=m.request_id AND a.state='winner' AND a.receipt-ARRAY['source_occupancy_id','source_lifecycle','break_id']=to_jsonb(m) JOIN public.table_seats seat ON seat.id=m.destination_seat_id
 AND seat.table_id=m.destination_table_id AND seat.user_id=m.user_id AND seat.seat_number=m.destination_seat_number
 AND seat.joined_at=m.moved_at AND seat.left_at IS NULL
 WHERE m.tournament_id=t AND m.user_id=user_key::uuid AND m.source_table_id=(engine->>'table_id')::uuid AND (a.receipt->>'source_occupancy_id')::uuid=original_stay;
 IF n<>1 THEN RAISE EXCEPTION 'F06_MIXED_PRESENCE_ARRIVAL_UNPROVEN'; END IF;
 SELECT to_jsonb(m) INTO receipt FROM public.tournament_seat_move_receipts m JOIN smarter_private.f06_attempts a ON a.request_id=m.request_id AND a.state='winner' AND a.receipt-ARRAY['source_occupancy_id','source_lifecycle','break_id']=to_jsonb(m) JOIN public.table_seats seat ON seat.id=m.destination_seat_id
 AND seat.table_id=m.destination_table_id AND seat.user_id=m.user_id AND seat.seat_number=m.destination_seat_number
 AND seat.joined_at=m.moved_at AND seat.left_at IS NULL
 WHERE m.tournament_id=t AND m.user_id=user_key::uuid AND m.source_table_id=(engine->>'table_id')::uuid AND (a.receipt->>'source_occupancy_id')::uuid=original_stay;
 SELECT * INTO target FROM public.table_seats WHERE id=(receipt->>'destination_seat_id')::uuid;
 END IF;
 IF target.occupancy_id IS NULL THEN RAISE EXCEPTION 'F06_MIXED_PRESENCE_DESTINATION_UNPROVEN'; END IF;
 bank:=banks->user_key; presence:=fsm->user_key; table_key:=target.table_id::text;
 IF bank IS NOT NULL THEN bank:=jsonb_set(bank,'{occupancyId}',to_jsonb(target.occupancy_id)); END IF;
 item:=COALESCE(targets->table_key,jsonb_build_object('banks','{}'::jsonb,'presence','{}'::jsonb));
 IF historical THEN
 item:=item||jsonb_build_object('initializationKind','historical_loss_normal_session_v1',
 'originalReceiptId',engine#>>'{bank_custody,historical_loss,receipt_id}');
 END IF;
 -- Retain the oldest contributing native timestamp. Banks have no age expiry;
 -- disconnect presence does. Transfer must not renew its original freshness.
 IF durable->>'parked_at' IS NULL OR NOT isfinite((durable->>'parked_at')::timestamptz) THEN RAISE EXCEPTION 'F06_MIXED_PRESENCE_TIME_UNPROVEN'; END IF;
 item:=jsonb_set(item,'{parked_at}',to_jsonb(LEAST((item->>'parked_at')::timestamptz,(durable->>'parked_at')::timestamptz)));
 IF item#>ARRAY['banks',user_key] IS NOT NULL AND item#>ARRAY['banks',user_key] IS DISTINCT FROM bank
 OR item#>ARRAY['presence',user_key] IS NOT NULL AND item#>ARRAY['presence',user_key] IS DISTINCT FROM presence
 THEN RAISE EXCEPTION 'F06_MIXED_PRESENCE_CONFLICT'; END IF;
 IF bank IS NOT NULL THEN item:=jsonb_set(item,ARRAY['banks',user_key],bank); END IF;
 IF presence IS NOT NULL THEN item:=jsonb_set(item,ARRAY['presence',user_key],presence); END IF;
 targets:=jsonb_set(targets,ARRAY[table_key],item);
 receipts:=receipts||jsonb_build_array(jsonb_build_object('user_id',user_key,'source_table',engine->>'table_id',
 'source_occupancy',original_stay,'destination_table',target.table_id,'destination_occupancy',target.occupancy_id,'move_receipt',receipt,'bank',bank,'presence',presence)||CASE WHEN historical THEN jsonb_build_object('historical_loss',bank_proof->'historical_loss') ELSE '{}'::jsonb END);
 END LOOP;
 END LOOP;
 FOR table_key,item IN SELECT * FROM jsonb_each(targets) ORDER BY key LOOP
 IF item->>'initializationKind'='historical_loss_normal_session_v1' AND EXISTS(
 SELECT 1 FROM public.table_seats seat WHERE seat.table_id=table_key::uuid AND seat.left_at IS NULL AND seat.stack>0
 AND (item#>ARRAY['banks',seat.user_id::text] IS NULL OR item#>>ARRAY['banks',seat.user_id::text,'occupancyId'] IS DISTINCT FROM seat.occupancy_id::text))
 THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_DESTINATION_CUSTODY_MISSING'; END IF;
 SELECT COALESCE(max(hand_number),0) INTO hand FROM public.hand_history WHERE table_id=table_key::uuid;
 INSERT INTO public.engine_presence_parked(table_id,disconnect_states,parked_at,engine_instance,time_bank_snapshot)
 VALUES(table_key::uuid,item->'presence',(item->>'parked_at')::timestamptz,'f06_mixed_custody',jsonb_build_object('version',1,'parkedAt',item->'parked_at','handNumber',hand,'players',item->'banks')||CASE WHEN item ? 'initializationKind' THEN jsonb_build_object('initializationKind',item->>'initializationKind','originalReceiptId',item->>'originalReceiptId') ELSE '{}'::jsonb END)
 ON CONFLICT(table_id) DO UPDATE SET disconnect_states=EXCLUDED.disconnect_states,parked_at=EXCLUDED.parked_at,
 engine_instance=EXCLUDED.engine_instance,time_bank_snapshot=EXCLUDED.time_bank_snapshot;
 END LOOP;
 RETURN receipts;
END $$;

REVOKE ALL ON FUNCTION smarter_private.f06_mixed_adopt_presence(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
