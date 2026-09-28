-- 20260928041447_the_last_stranded_transfers_of_the_0926_collapse_complete.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  THE LAST STRANDED TRANSFERS OF THE 09-26 COLLAPSE COMPLETE
-- ===========================================================================
--
-- Read from production 2026-09-28 03:57 to 04:20 UTC. Of the events frozen by
-- the 2026-09-26 09:33 UTC lease collapse, two are still held by a mixed
-- custody transfer that no door can finish. Both refusals are a rule that is
-- right in general and wrong for one exact shape:
--
--   21f9013b "Sunday Deep Stack Satellite $25" (MTT, 5 playing). Transfer
--   68929fc8 was ADMITTED at 09:35:55 on 09-26; the live engine (41b91390,
--   1-1cf7188d) holds its successor lease 0b4f0551 with a fresh heartbeat.
--   fn_f06_complete_mixed_manager_custody, probed as that successor in one
--   rolled-back DO block, refuses F06_MIXED_PRESENCE_ARRIVAL_UNPROVEN from
--   smarter_private.f06_mixed_adopt_presence. The one key it cannot place is
--   2430ef3a (draw888): on the transfer's roster at table 9f8d95a5, occupancy
--   403a9780, whose chair left at 09:32:36.857 with stack 0 - the bust of hand
--   14775893, committed 50 ms earlier. Registration: playing, chips 0, no live
--   chair anywhere in the event, knockout candidate 20ca583b 'pending'. There
--   is no arrival because there was never a move: the player busted.
--
--   a3a95a1b "DSS Friday $5.50 NLH Turbo 9 PM CT" (MTT, 21 players, no lease).
--   Transfer a3967f17 was never admitted. Its three originals are two
--   RESERVED hands (tables 936292a3 hand 14777068, e3bfb74b hand 14776704) and
--   one hand the origin generation ACCEPTED after the transfer was prepared
--   (1e64fd86 hand 14775996, committed 09:33:26, the bust of 619d99fd). The
--   admission refuses F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED (pending
--   originals 936292a3, e3bfb74b: probed). The door written for exactly this
--   (fn_f06_void_stranded_mixed_original, 20260927145449) refuses
--   F06_STRANDED_ORIGINALS_CHANGED, because it demands that the reserved set
--   EQUAL the originals, and one original has already settled by itself. The
--   snapshot the successor's admission reads treats that accepted original as
--   terminal already (accepted, with its exact committed hand as witness), so
--   the only thing missing is the void of the two reserved hands. Once that
--   exists the admission will reach the same presence adoption as 21f9013b
--   and meet the same shape: 619d99fd, roster player, chair emptied at the
--   bust, 0 chips, no live chair.
--
-- WHAT THIS CHANGES
--
-- 1. smarter_private.f06_mixed_adopt_presence. A roster player whose original
--    chair is gone, who has NO arrival receipt, and who HOLDS NOTHING in the
--    event (registration at 0 chips; no chair of theirs in the event is live
--    or holds a chip) is refused on the receipt, alone: 'adopted' false,
--    'refused' 'f06_mixed_presence_holds_nothing', with the bank and presence
--    that were not carried named beside it. Presence (time bank, disconnect
--    state) governs a seated player; this one has no chair to carry it to.
--    It is the same "holds nothing" rule the abandoned-generation door and the
--    stranded void already apply to a bust whose elimination is pending, and
--    the same one-player refusal 20260928000415 introduced. Everything else
--    refuses exactly as before: two roster entries, a missing occupancy, a
--    player with any chip or any live chair and no arrival receipt.
--
-- 2. public.fn_f06_void_stranded_mixed_original. The reserved set must be a
--    SUBSET of the transfer's originals, and every original that is not
--    reserved must be accepted by the origin generation with its committed
--    hand (hand_atomic_commits joined to hand_history, post-commit completed,
--    the exact witness f06_mixed_custody_snapshot reads). Only the reserved
--    hands are voided; the function's own post-image now asserts the abort
--    receipt for exactly those. Every other clause is unchanged: one open,
--    never-admitted transfer; no holder but its successor; no open break; the
--    preflop snapshot, roster, stacks and cards re-proved; credit 0.
--
-- 3. The one event the void was written for and could not reach, a3a95a1b, is
--    voided through that door here, exactly once (the receipt is keyed by the
--    transfer; a replay returns the stored outcome). No chip, registration,
--    ledger row or wallet is written: the door asserts that every chair and
--    registration of the event is byte-identical before and after.
--
-- Nobody is paid and nothing is taken back. The two busts stay pending and are
-- recorded by the manager's own elimination sweep once the event deals again.
--
-- PROVEN FIRST, ROLLED BACK (CLAUDE.md 11.5): both new bodies installed as
-- pg_temp helpers in one psql transaction ending in RAISE EXCEPTION; the live
-- completion body re-pointed at the temporary presence helper and run as
-- 21f9013b's live successor; the new void run for a3a95a1b followed by the
-- mixed custody snapshot and the new presence adoption. Results in
-- docs/changelog/2026-09-28-the-last-stranded-transfers-of-the-0926-collapse-complete.md.
--
-- Law: tests/the-last-stranded-transfers-of-the-0926-collapse-complete.law.test.ts
--
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_mixed_adopt_presence(uuid,jsonb)'::regprocedure) = 'e6a9689efa793b4665c5d819ccf2c403'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_void_stranded_mixed_original(uuid)'::regprocedure) = '92466252b142a745157d2ba69c1aa35b'

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_mixed_adopt_presence(uuid,jsonb)'::regprocedure
       AND md5(p.prosrc) = '358cdd737ec6dcaeb27fdfa52de48b55'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'PREIMAGE: f06_mixed_adopt_presence is not the 20260928000415 definition read 2026-09-28';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_f06_void_stranded_mixed_original(uuid)'::regprocedure
       AND md5(p.prosrc) = '618d61ed59a8aef999767c802469949f'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'PREIMAGE: fn_f06_void_stranded_mixed_original is not the 20260927145449 definition read 2026-09-28';
  END IF;
  -- The readers these two write for, as probed.
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb)'::regprocedure) <> '5422e7f73fdbdd34bf73d46e514e844e'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb)'::regprocedure) <> 'aeaabb44975b8d138ed447687b0aea22'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_complete_mixed_manager_custody(uuid,uuid,uuid,jsonb)'::regprocedure) <> '43aa14703d4d8f37a95f7adf6c6ed5c1'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_mixed_current_admission(uuid,uuid,uuid)'::regprocedure) <> '0d43159f7518f27aa381b3e905508d84' THEN
    RAISE EXCEPTION 'PREIMAGE: the mixed custody snapshot, admission, completion or current admission is not the definition probed 2026-09-28';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION smarter_private.f06_mixed_adopt_presence(t uuid, local_proof jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
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
 -- A roster player whose chair has emptied with no arrival anywhere, and who
 -- HOLDS NOTHING in this event (registration at 0 chips, no chair of theirs
 -- live or holding a chip), busted in the last hand the origin committed and
 -- was never moved: presence governs a seated player and there is no chair
 -- to carry it to. Refuse that one player on the receipt, never the event.
 IF n=0 AND EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=t AND tp.user_id=user_key::uuid AND tp.chips=0)
  AND NOT EXISTS(SELECT 1 FROM public.table_seats b JOIN public.tables bt ON bt.id=b.table_id
   WHERE bt.tournament_id=t AND b.user_id=user_key::uuid AND (b.left_at IS NULL OR b.stack IS DISTINCT FROM 0)) THEN
  receipts:=receipts||jsonb_build_array(jsonb_build_object('user_id',user_key,'source_table',engine->>'table_id',
   'source_occupancy',original_stay,'adopted',false,'refused','f06_mixed_presence_holds_nothing',
   'bank',banks->user_key,'presence',fsm->user_key));
  CONTINUE;
 END IF;
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
END $function$;

CREATE OR REPLACE FUNCTION public.fn_f06_void_stranded_mixed_original(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE
  t uuid := p_tournament_id;
  xfer smarter_private.f06_manager_custody_transfers;
  event public.tournaments;
  h smarter_private.f06_hand_permits;
  snap public.hand_state_snapshots;
  b jsonb;
  reserved_ids uuid[];
  original_ids uuid[];
  tab_ids uuid[];
  users uuid[];
  u uuid;
  n integer;
  roster jsonb;
  hands jsonb := '[]'::jsonb;
  item jsonb;
  actual jsonb;
  v_receipt uuid;
  v_snap_ids uuid[] := ARRAY[]::uuid[];
  v_before jsonb;
  v_after jsonb;
  v_busts jsonb;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'F06_STRANDED_IDENTITY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: stranded mixed void refused' USING ERRCODE = '55000';
  END IF;

  -- The event's own lane, taken only when it is free (never queued).
  PERFORM smarter_private.f06_try_lane(t);

  -- Exactly one custody transfer is still open, and its successor was never
  -- admitted: nobody but the dead origin ever held the hands it reserved.
  SELECT c.* INTO xfer FROM smarter_private.f06_manager_custody_transfers c
   WHERE c.tournament_id = t
     AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_completions d
                      WHERE d.transfer_id = c.transfer_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'F06_STRANDED_TRANSFER_REQUIRED' USING ERRCODE = '55000';
  END IF;
  v_receipt := md5('f06:stranded-mixed-original:' || xfer.transfer_id::text)::uuid;
  IF EXISTS (SELECT 1 FROM smarter_private.f06_mixed_aborts WHERE receipt_id = v_receipt) THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'receipt_id', v_receipt,
                              'tournament_id', t, 'credit', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_admissions a
              WHERE a.transfer_id = xfer.transfer_id) THEN
    RAISE EXCEPTION 'F06_STRANDED_TRANSFER_ADMITTED' USING ERRCODE = '55000';
  END IF;
  IF smarter_private.f06_generation_aborted(t, xfer.origin_generation)
     OR smarter_private.f06_generation_aborted(t, xfer.successor_generation) THEN
    RAISE EXCEPTION 'F06_STRANDED_GENERATION_DISPOSED' USING ERRCODE = '55000';
  END IF;
  -- Nobody but the never-admitted successor may hold the event. The engine
  -- claims the successor generation and is refused admission until this
  -- receipt exists, so that holder has built nothing and can act on nothing
  -- (every F06 write needs the lane this transaction holds). Any other holder
  -- is retried, never raced.
  IF EXISTS (SELECT 1 FROM public.engine_tournament_leases
              WHERE tournament_id = t
                AND lease_generation IS DISTINCT FROM xfer.successor_generation) THEN
    RAISE EXCEPTION 'F06_STRANDED_EVENT_OWNED' USING ERRCODE = '40001';
  END IF;

  -- The reserved set is exactly the transfer's original hands.
  SELECT array_agg(permit_id ORDER BY permit_id) INTO reserved_ids
    FROM smarter_private.f06_hand_permits WHERE tournament_id = t AND state = 'reserved';
  SELECT array_agg((e#>>'{permit,binding,permit_id}')::uuid ORDER BY (e#>>'{permit,binding,permit_id}')::uuid)
    INTO original_ids
    FROM jsonb_array_elements(xfer.local_proof->'engines') e
   WHERE e->'permit' IS DISTINCT FROM 'null'::jsonb;
  -- Every reserved hand is one of the transfer's originals. An original that
  -- is not reserved any more reached its own positive terminal disposition
  -- after the transfer was prepared (the one legal change before admission):
  -- it was accepted by the origin generation, with the exact committed hand
  -- the successor's snapshot reads as its witness. Only the reserved hands
  -- are voided; the committed one is left exactly as it settled.
  IF reserved_ids IS NULL OR original_ids IS NULL OR NOT (reserved_ids <@ original_ids)
     OR (SELECT count(*) FROM smarter_private.f06_hand_permits o
          WHERE o.permit_id = ANY (original_ids)) <> cardinality(original_ids)
     OR EXISTS (
          SELECT 1 FROM smarter_private.f06_hand_permits o
           WHERE o.permit_id = ANY (original_ids) AND NOT (o.permit_id = ANY (reserved_ids))
             AND NOT (o.state = 'accepted' AND o.tournament_id = t
                      AND o.generation = xfer.origin_generation
                      AND EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                                    JOIN public.hand_history hh ON hh.id = a.hand_id
                                     AND hh.table_id = a.table_id AND hh.hand_number = a.hand_number
                                   WHERE a.hand_id = o.evidence_id AND a.table_id = o.table_id
                                     AND a.hand_number = o.hand_number
                                     AND a.post_commit_completed_at IS NOT NULL))) THEN
    RAISE EXCEPTION 'F06_STRANDED_ORIGINALS_CHANGED' USING ERRCODE = '55000';
  END IF;
  FOREACH u IN ARRAY reserved_ids LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:' || u::text, 0)) THEN
      RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE = '40001';
    END IF;
  END LOOP;
  SELECT array_agg(DISTINCT table_id ORDER BY table_id) INTO tab_ids
    FROM smarter_private.f06_hand_permits WHERE permit_id = ANY (reserved_ids);
  SELECT array_agg(DISTINCT user_id ORDER BY user_id) INTO users
    FROM public.table_seats WHERE table_id = ANY (tab_ids) AND left_at IS NULL;
  IF users IS NOT NULL THEN
    FOREACH u IN ARRAY users LOOP
      IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:' || u::text, 0)) THEN
        RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE = '40001';
      END IF;
    END LOOP;
  END IF;

  SELECT * INTO event FROM public.tournaments WHERE id = t FOR UPDATE;
  PERFORM 1 FROM public.tournament_players WHERE tournament_id = t ORDER BY user_id FOR UPDATE;
  PERFORM 1 FROM public.tables WHERE tournament_id = t ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.table_seats WHERE table_id = ANY (tab_ids) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM smarter_private.f06_hand_permits
   WHERE permit_id = ANY (reserved_ids) ORDER BY permit_id FOR UPDATE;
  PERFORM 1 FROM smarter_private.f06_operations WHERE tournament_id = t ORDER BY break_id FOR UPDATE;

  IF event.id IS NULL OR event.status IS DISTINCT FROM 'RUNNING'
     OR event.format_contract IS NULL
     OR event.format_contract NOT IN ('mtt-v1', 'mtt-v2', 'spin-v1', 'sng-v1') THEN
    RAISE EXCEPTION 'F06_STRANDED_EVENT_NOT_RUNNING' USING ERRCODE = '55000';
  END IF;
  -- No table break of any origin is open: nothing but the hands is in the air.
  IF EXISTS (SELECT 1 FROM smarter_private.f06_operations
              WHERE tournament_id = t AND state NOT IN ('acknowledged', 'withdrawn_before_manifest')) THEN
    RAISE EXCEPTION 'F06_STRANDED_PARK_OPEN' USING ERRCODE = '55000';
  END IF;

  -- Every chip and registration of the affected tables, before.
  SELECT jsonb_build_object(
           'seats', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'user_id', s.user_id,
                              'stack', s.stack, 'left_at', s.left_at) ORDER BY s.id), '[]'::jsonb)
                       FROM public.table_seats s WHERE s.table_id = ANY (tab_ids)),
           'registrations', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'status', p.status,
                              'chips', p.chips, 'table_id', p.table_id, 'seat_number', p.seat_number) ORDER BY p.id), '[]'::jsonb)
                       FROM public.tournament_players p WHERE p.tournament_id = t))
    INTO v_before;

  FOR h IN SELECT * FROM smarter_private.f06_hand_permits
            WHERE permit_id = ANY (reserved_ids) ORDER BY permit_id LOOP
    SELECT e#>'{permit,binding}' INTO b FROM jsonb_array_elements(xfer.local_proof->'engines') e
     WHERE e#>>'{permit,binding,permit_id}' = h.permit_id::text;
    IF h.generation IS DISTINCT FROM xfer.origin_generation OR h.evidence_id IS NOT NULL
       OR b->>'tournament_id' IS DISTINCT FROM t::text
       OR b->>'table_id' IS DISTINCT FROM h.table_id::text
       OR b->>'hand_number' IS DISTINCT FROM h.hand_number::text
       OR b->>'lifecycle' IS DISTINCT FROM h.lifecycle::text
       OR b->>'custody_id' IS DISTINCT FROM h.custody_id::text
       OR b->>'lease_generation' IS DISTINCT FROM h.generation::text
       OR NOT EXISTS (SELECT 1 FROM public.tables tb
                       WHERE tb.id = h.table_id AND tb.tournament_id = t
                         AND NOT COALESCE(tb.is_deleted, false)
                         AND lower(COALESCE(tb.status, '')) IN ('waiting', 'running')
                         AND tb.f06_lifecycle = h.lifecycle)
       OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits q
                   WHERE q.table_id = h.table_id AND q.hand_number > h.hand_number) THEN
      RAISE EXCEPTION 'F06_STRANDED_PERMIT_CHANGED' USING ERRCODE = '55000';
    END IF;
    -- The hand never reached the platform: no commit, history, private state,
    -- dispatch, submission, disposition or recorded action.
    IF EXISTS (SELECT 1 FROM public.hand_atomic_commits c
                WHERE c.table_id = h.table_id AND c.hand_number >= h.hand_number)
       OR EXISTS (SELECT 1 FROM public.hand_history hh
                   WHERE hh.table_id = h.table_id AND hh.hand_number >= h.hand_number)
       OR EXISTS (SELECT 1 FROM public.hand_private_state hp
                   WHERE hp.table_id = h.table_id AND hp.hand_number >= h.hand_number)
       OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_dispatch d WHERE d.permit_id = h.permit_id) THEN
      RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM smarter_private.hand_submissions s
                WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number)
       OR EXISTS (SELECT 1 FROM smarter_private.hand_submission_dispositions d
                   WHERE d.table_id = h.table_id AND d.hand_number = h.hand_number)
       OR EXISTS (SELECT 1 FROM public.hand_discards z
                   WHERE z.table_id = h.table_id AND z.hand_number = h.hand_number) THEN
      RAISE EXCEPTION 'F06_STRANDED_HAND_HAS_A_SUBMISSION' USING ERRCODE = '55000';
    END IF;

    -- Every live chair is one playing registration holding the same chips,
    -- and every playing registration at this table has its live chair.
    SELECT jsonb_agg(jsonb_build_object(
             'seat_id', s.id, 'occupancy_id', s.occupancy_id, 'user_id', s.user_id,
             'seat_number', s.seat_number, 'stack', s.stack,
             'registration_id', tp.id, 'chips', tp.chips) ORDER BY s.user_id)
      INTO roster
      FROM public.table_seats s
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = t AND tp.user_id = s.user_id AND tp.table_id = s.table_id
       AND tp.seat_number = s.seat_number AND tp.status = 'playing'
     WHERE s.table_id = h.table_id AND s.left_at IS NULL;
    IF roster IS NULL
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                   WHERE r->>'registration_id' IS NULL OR r->>'stack' IS NULL
                      OR (r->>'stack')::numeric < 0
                      OR (r->>'stack')::numeric IS DISTINCT FROM (r->>'chips')::numeric)
       OR EXISTS (SELECT 1 FROM public.tournament_players tp
                   WHERE tp.tournament_id = t AND tp.table_id = h.table_id AND tp.status = 'playing'
                     AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                                      WHERE s.table_id = h.table_id AND s.user_id = tp.user_id
                                        AND s.seat_number = tp.seat_number AND s.left_at IS NULL)
                     -- A bust whose elimination is still pending holds nothing
                     -- (the abandoned-generation door's ruling of 2026-09-26):
                     -- zero chips, and no chair it ever had in the event is
                     -- live or holds a chip. It was not dealt into this hand
                     -- either: the snapshot must name exactly the live chairs.
                     AND NOT (tp.chips = 0
                              AND NOT EXISTS (SELECT 1 FROM public.table_seats bs
                                                JOIN public.tables bt ON bt.id = bs.table_id
                                               WHERE bt.tournament_id = t AND bs.user_id = tp.user_id
                                                 AND (bs.left_at IS NULL OR bs.stack IS DISTINCT FROM 0)))) THEN
      RAISE EXCEPTION 'F06_STRANDED_ROSTER_CHANGED' USING ERRCODE = '55000';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'registration_id', tp.id, 'user_id', tp.user_id,
             'seat_number', tp.seat_number, 'chips', tp.chips) ORDER BY tp.user_id), '[]'::jsonb)
      INTO v_busts
      FROM public.tournament_players tp
     WHERE tp.tournament_id = t AND tp.table_id = h.table_id AND tp.status = 'playing'
       AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                        WHERE s.table_id = h.table_id AND s.user_id = tp.user_id
                          AND s.seat_number = tp.seat_number AND s.left_at IS NULL);

    -- One open preflop snapshot, and every chair still holds exactly what it
    -- held before the deal: its snapshot stack plus everything it put in. No
    -- blind, ante or bet of this hand ever left a durable chair.
    SELECT count(*) INTO n FROM public.hand_state_snapshots s
     WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number;
    IF n <> 1 THEN
      RAISE EXCEPTION 'F06_STRANDED_SNAPSHOT_REQUIRED' USING ERRCODE = '55000';
    END IF;
    SELECT * INTO snap FROM public.hand_state_snapshots s
     WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number FOR UPDATE;
    IF snap.is_complete IS DISTINCT FROM false
       OR snap.stage IS DISTINCT FROM 'preflop'
       OR snap.state_json->>'stage' IS DISTINCT FROM 'preflop'
       OR jsonb_typeof(snap.state_json->'players') IS DISTINCT FROM 'array'
       OR jsonb_array_length(snap.state_json->'players') NOT BETWEEN 2 AND 10
       OR jsonb_array_length(snap.state_json->'players') <> jsonb_array_length(roster)
       OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(snap.state_json->'players') x)
            IS DISTINCT FROM jsonb_array_length(snap.state_json->'players')::bigint
       OR NOT COALESCE(pg_input_is_valid(snap.state_json->>'pot', 'numeric'), false)
       OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x
             WHERE NOT (CASE
               WHEN COALESCE(pg_input_is_valid(x->>'user_id', 'uuid'), false)
                AND COALESCE(pg_input_is_valid(x->>'seat', 'integer'), false)
                AND COALESCE(pg_input_is_valid(x->>'stack', 'numeric'), false)
                AND COALESCE(pg_input_is_valid(x->>'totalInvested', 'numeric'), false)
                AND COALESCE(pg_input_is_valid(COALESCE(x->>'deadInvested', '0'), 'numeric'), false)
               THEN
                 (x->>'stack')::numeric >= 0
                 AND (x->>'totalInvested')::numeric >= 0
                 AND COALESCE((x->>'deadInvested')::numeric, 0) BETWEEN 0 AND (x->>'totalInvested')::numeric
                 AND (x->>'stack')::numeric::text NOT IN ('NaN', 'Infinity', '-Infinity')
                 AND (x->>'totalInvested')::numeric::text NOT IN ('NaN', 'Infinity', '-Infinity')
                 AND EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                              WHERE r->>'user_id' = x->>'user_id'
                                AND (r->>'seat_number')::integer = (x->>'seat')::integer
                                AND (r->>'stack')::numeric
                                      = (x->>'stack')::numeric + (x->>'totalInvested')::numeric)
               ELSE false END))
       OR (snap.state_json->>'pot')::numeric IS DISTINCT FROM
            (SELECT sum((x->>'totalInvested')::numeric)
               FROM jsonb_array_elements(snap.state_json->'players') x) THEN
      RAISE EXCEPTION 'F06_ABORT_SAVED_STACKS_CHANGED' USING ERRCODE = '55000';
    END IF;
    -- Every hole card went to a live chair of this table.
    IF EXISTS (SELECT 1 FROM public.table_hole_cards c
                WHERE c.table_id = h.table_id AND c.hand_number = h.hand_number
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                                   WHERE r->>'user_id' = c.user_id::text)) THEN
      RAISE EXCEPTION 'F06_STRANDED_CARDS_CHANGED' USING ERRCODE = '55000';
    END IF;

    hands := hands || jsonb_build_array(jsonb_build_object(
      'permit', to_jsonb(h), 'ruling', 'misdeal_voided', 'shape', 'stranded_mixed_original',
      'snapshot_id', snap.id, 'snapshot_hash', md5(to_jsonb(snap)::text),
      'snapshot_created_at', snap.created_at, 'pot_returned_to_chairs', snap.state_json->'pot',
      'hole_cards', (SELECT count(*) FROM public.table_hole_cards c
                      WHERE c.table_id = h.table_id AND c.hand_number = h.hand_number),
      'binding', b, 'roster', roster, 'busts_pending_elimination', v_busts, 'break_id', NULL));
    v_snap_ids := v_snap_ids || snap.id;
  END LOOP;

  actual := jsonb_build_object(
    'kind', 'stranded_mixed_original', 'tournament_id', t, 'format_contract', event.format_contract,
    'transfer_id', xfer.transfer_id, 'origin_generation', xfer.origin_generation,
    'successor_generation', xfer.successor_generation, 'transfer_created_at', xfer.created_at,
    'hands', hands, 'credit', 0,
    'reason', 'The origin generation reserved and dealt these hands and died before any reached a commit; its successor can only be admitted once each has a terminal disposition, and only the origin could give one. Every chair already holds its pre-deal stack, so the hands are misdeals and nothing moves.');
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: stranded mixed void refused' USING ERRCODE = '55000';
  END IF;

  -- The receipt the mixed custody snapshot reads as the original's terminal
  -- disposition. Only the ORIGIN generation is disposed; the successor stays
  -- claimable, and is admitted by the engine exactly as designed.
  INSERT INTO smarter_private.f06_mixed_aborts (receipt_id, tournament_id, expected)
  VALUES (v_receipt, t, actual);
  INSERT INTO smarter_private.f06_mixed_abort_generations (tournament_id, generation, receipt_id)
  VALUES (t, xfer.origin_generation, v_receipt);
  FOR item IN SELECT value FROM jsonb_array_elements(hands) LOOP
    INSERT INTO smarter_private.f06_mixed_abort_hands
      (permit_id, receipt_id, tournament_id, generation, table_id, hand_number,
       snapshot_id, break_id, prior_hand_id, prior_abort_receipt_id, expected)
    VALUES ((item->'permit'->>'permit_id')::uuid, v_receipt, t, xfer.origin_generation,
            (item->'permit'->>'table_id')::uuid, (item->'permit'->>'hand_number')::bigint,
            (item->>'snapshot_id')::uuid, NULL, NULL, NULL, item);
  END LOOP;
  UPDATE smarter_private.f06_hand_permits SET state = 'aborted_unsettled', evidence_id = v_receipt
   WHERE permit_id = ANY (reserved_ids) AND state = 'reserved';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> cardinality(reserved_ids) THEN
    RAISE EXCEPTION 'F06_STRANDED_PERMIT_CLAIM_LOST' USING ERRCODE = '40001';
  END IF;
  UPDATE public.hand_state_snapshots SET is_complete = true
   WHERE id = ANY (v_snap_ids) AND NOT is_complete;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> cardinality(v_snap_ids) THEN
    RAISE EXCEPTION 'F06_STRANDED_SNAPSHOT_CLAIM_LOST' USING ERRCODE = '40001';
  END IF;

  -- After: nothing reserved, the origin disposed and the successor not, every
  -- original carries the evidence the successor's admission reads, and not
  -- one chip or registration moved.
  SELECT jsonb_build_object(
           'seats', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'user_id', s.user_id,
                              'stack', s.stack, 'left_at', s.left_at) ORDER BY s.id), '[]'::jsonb)
                       FROM public.table_seats s WHERE s.table_id = ANY (tab_ids)),
           'registrations', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'status', p.status,
                              'chips', p.chips, 'table_id', p.table_id, 'seat_number', p.seat_number) ORDER BY p.id), '[]'::jsonb)
                       FROM public.tournament_players p WHERE p.tournament_id = t))
    INTO v_after;
  IF v_after IS DISTINCT FROM v_before
     OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id = t AND state = 'reserved')
     OR NOT smarter_private.f06_generation_aborted(t, xfer.origin_generation)
     OR smarter_private.f06_generation_aborted(t, xfer.successor_generation)
     OR EXISTS (
          SELECT 1 FROM smarter_private.f06_hand_permits o
           WHERE o.permit_id = ANY (reserved_ids)
             AND NOT EXISTS (
               SELECT 1 FROM smarter_private.f06_mixed_abort_hands a
                 JOIN smarter_private.f06_mixed_aborts c USING (receipt_id, tournament_id)
                WHERE (a.permit_id, a.receipt_id, a.tournament_id, a.generation, a.table_id, a.hand_number)
                      = (o.permit_id, o.evidence_id, o.tournament_id, o.generation, o.table_id, o.hand_number)
                  AND o.state = 'aborted_unsettled' AND c.outcome = 'aborted_unsettled'
                  AND a.expected->'permit' = (to_jsonb(o) || jsonb_build_object('state', 'reserved', 'evidence_id', NULL)))) THEN
    RAISE EXCEPTION 'F06_STRANDED_POSTIMAGE_CHANGED' USING ERRCODE = '55000';
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', 'aborted_unsettled', 'receipt_id', v_receipt,
    'tournament_id', t, 'transfer_id', xfer.transfer_id, 'origin_generation', xfer.origin_generation,
    'successor_generation', xfer.successor_generation, 'hands_voided', cardinality(reserved_ids),
    'credit', 0);
END
$function$;

DO $post_fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_mixed_adopt_presence(uuid,jsonb)'::regprocedure
       AND md5(p.prosrc) = 'e6a9689efa793b4665c5d819ccf2c403'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: f06_mixed_adopt_presence is not the reviewed definition with its owner, grants and settings';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_f06_void_stranded_mixed_original(uuid)'::regprocedure
       AND md5(p.prosrc) = '92466252b142a745157d2ba69c1aa35b'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_f06_void_stranded_mixed_original is not the reviewed definition with its owner, grants and settings';
  END IF;
  IF has_function_privilege('anon', 'public.fn_f06_void_stranded_mixed_original(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_f06_void_stranded_mixed_original(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.fn_f06_void_stranded_mixed_original(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTIMAGE: the stranded void is callable by a role other than its owner';
  END IF;
END
$post_fn$;

-- The one event the void could not reach. Settled once: the receipt is keyed
-- by the transfer and a replay returns it. A transfer that has since been
-- completed by another door, or an event that is no longer RUNNING, is not
-- this migration's to decide and is reported, not forced. Anything else that
-- refuses aborts the whole migration, so the functions and the settlement land
-- together or not at all.
DO $void$
DECLARE
  t constant uuid := 'a3a95a1b-ad40-40f8-ba44-188f17e72402';
  xfer smarter_private.f06_manager_custody_transfers;
  r jsonb;
  v_chips_before numeric;
  v_chips_after numeric;
  v_ledger_before bigint;
  v_ledger_after bigint;
BEGIN
  SELECT * INTO xfer FROM smarter_private.f06_manager_custody_transfers WHERE tournament_id = t;
  IF xfer.transfer_id IS NULL OR xfer.transfer_id::text NOT LIKE 'a3967f17-%' THEN
    RAISE EXCEPTION 'a3a95a1b: the transfer is not the one read 2026-09-28 (a3967f17)';
  END IF;
  IF EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_completions WHERE transfer_id = xfer.transfer_id)
     OR (SELECT status FROM public.tournaments WHERE id = t) IS DISTINCT FROM 'RUNNING' THEN
    RAISE NOTICE 'a3a95a1b: transfer already completed or event no longer RUNNING; nothing to void';
    RETURN;
  END IF;
  SELECT COALESCE(sum(s.stack), 0) INTO v_chips_before
    FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = t AND s.left_at IS NULL;
  SELECT count(*) INTO v_ledger_before FROM public.chip_ledger WHERE tournament_id = t;

  r := public.fn_f06_void_stranded_mixed_original(t);
  IF COALESCE((r->>'ok')::boolean, false) IS NOT TRUE OR (r->>'credit')::numeric <> 0 THEN
    RAISE EXCEPTION 'a3a95a1b: unexpected void result %', r;
  END IF;

  SELECT COALESCE(sum(s.stack), 0) INTO v_chips_after
    FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = t AND s.left_at IS NULL;
  SELECT count(*) INTO v_ledger_after FROM public.chip_ledger WHERE tournament_id = t;
  IF v_chips_after IS DISTINCT FROM v_chips_before OR v_ledger_after IS DISTINCT FROM v_ledger_before
     OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id = t AND state = 'reserved')
     OR NOT smarter_private.f06_generation_aborted(t, xfer.origin_generation)
     OR smarter_private.f06_generation_aborted(t, xfer.successor_generation)
     OR (SELECT count(*) FROM smarter_private.f06_mixed_aborts a
          WHERE a.tournament_id = t AND a.expected->>'kind' = 'stranded_mixed_original') <> 1
     OR smarter_private.f06_mixed_custody_snapshot(t, xfer.origin_generation, xfer.local_proof)->'pending_original_tables'
          IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'POSTIMAGE: a3a95a1b is not admissible after its void: %', r;
  END IF;
  RAISE NOTICE 'a3a95a1b voided: %', r;
END
$void$;

COMMIT;
