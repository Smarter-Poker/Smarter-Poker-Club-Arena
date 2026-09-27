-- 20260927163949_an_admitted_transfer_survives_its_dead_process
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-27 16:39:49 UTC.
--
-- ===========================================================================
--  AN ADMITTED MIXED CUSTODY TRANSFER SURVIVES THE DEATH OF ITS PROCESS
-- ===========================================================================
--
-- WHAT WAS BROKEN (read from rows and /health, 2026-09-27 16:31 UTC)
--
-- The 2026-09-26 09:33 UTC lease collapse left 118 RUNNING events behind an
-- uncompleted mixed custody transfer, in two disjoint classes. 73 were never
-- admitted (the stranded-original void door, 20260927145449, owns those).
-- THIS migration is for the other 45: each transfer WAS admitted, at 09:34 by
-- engine cd5892e8 instance 1-2fe24354 (44) or 1-00e3989e (1), and never
-- completed. That process lived until ~13:55 and then died with the event.
-- None of the 45 has dealt a hand since 09:33 on 09-26.
--
--   * 44 events still carry the dead process's lease (heartbeat 13:55/14:06
--     on 09-26). The engine asks for the transfer's successor generation, the
--     same generation the dead lease holds, and claim_tournament_lease_v2
--     takes a stale lease only for a DIFFERENT generation. So it answers
--     granted=false, the engine records owned_elsewhere and stands down.
--     /health: tournamentLease.conflictCount 44, holder 1-2fe24354, age
--     ~95,900 s. The reaper keeps the lease because the transfer is pending
--     (f06_lease_has_pending_custody), correctly.
--   * 1 event has no lease: the claim is granted, and admission refuses
--     F06_MIXED_ADMITTED_PROCESS_CHANGED in f06_mixed_current_admission,
--     because the admission is bound to the dead process's exact lease row.
--
-- A same-generation takeover would be unsafe, not merely refused: every
-- manager fence (the PostgREST pre-request hook, f06_authority) is the lease
-- GENERATION, so two processes sharing one generation cannot be told apart.
-- The takeover must take a FRESH generation, and the admitted custody must be
-- handed to it.
--
-- Separately, 24 of the 45 could not have completed even while the process
-- lived (09:34-13:55; GameServer retains the admitted process on a failed
-- completion). A rolled-back probe of fn_f06_complete_mixed_manager_custody as
-- the admitted generation, over all 44 events with a lease: 20 complete, 23
-- F06_MIXED_PRESENCE_ORIGINAL_UNPROVEN, 1 F06_MIXED_PRESENCE_ARRIVAL_UNPROVEN.
-- Every one of those 24 is a player who had already busted before the
-- transfer was prepared: the origin engine's disconnect FSM still held a
-- state for them (30 keys) or its roster still named a chair that had since
-- emptied (1 key), their registration holds 0 chips and no chair of theirs in
-- the event is live or holds a chip. Presence (time bank, disconnect state)
-- governs a SEATED player; there is no chair to carry it to.
--
-- WHAT THIS CHANGES
--
-- 1. smarter_private.f06_manager_custody_readmissions, append-only (the same
--    immutability triggers as the transfer, admission and completion tables).
--    One row per generation that takes over an ADMITTED, UNCOMPLETED transfer
--    from a dead admitted generation. PRIMARY KEY (transfer_id, generation),
--    UNIQUE (transfer_id, prior_generation): the chain is linear.
--
-- 2. public.fn_f06_readmit_mixed_manager_custody(t, g, transfer, expected), a
--    NEW door beside fn_f06_admit_mixed_manager_custody, which is untouched.
--    It admits exactly: the caller holds the event's live protocol-2 lease
--    with generation g (f06_authority, twice, around the event lane); the
--    transfer row equals the caller's immutable copy; the transfer HAS an
--    admission; it has NO completion; g is not the origin, the successor, the
--    admitted generation or any earlier readmitted generation. It records the
--    chain head it replaces and that head's lease identity. It never
--    re-derives terminal proof: the admission's own terminal_proof is carried
--    unchanged, and completion still proves every operation from rows.
--    Why the head is provably dead: the lease row now carries g, which
--    claim_tournament_lease_v2 grants only over an absent lease or one stale
--    beyond its 30-second window, taking FOR UPDATE, which waits for every
--    in-flight manager transaction of the old generation (they hold FOR KEY
--    SHARE). From then on the old generation fails every fence.
--    Refusals, by name: F06_MIXED_SUCCESSOR_CHANGED (the transfer differs),
--    F06_MIXED_READMISSION_UNADMITTED (never admitted: only its successor may
--    admit it), F06_MIXED_ALREADY_COMPLETE, F06_MIXED_READMISSION_GENERATION_REUSED,
--    F06_MIXED_ADMITTED_PROCESS_CHANGED (a replay from another process).
--
-- 3. smarter_private.f06_mixed_current_admission accepts the original
--    admission (unchanged rule) OR the readmission of exactly this generation,
--    each bound to the exact current lease row.
--
-- 4. public.fn_f06_find_mixed_manager_custody additionally returns
--    'admission': {generation: the chain head, live: whether the event's lease
--    is that generation with a heartbeat inside 30 s}. The receipt is
--    unchanged. The engine uses live=false to ask for a fresh generation and
--    readmit instead of claiming the successor (engine release, same PR).
--
-- 5. smarter_private.f06_mixed_adopt_presence: a presence key whose player
--    HOLDS NOTHING (a registration in this event with 0 chips, and no chair
--    of theirs in the event that is live or holds a chip) is recorded on the
--    completion receipt as 'discarded': 'holds_nothing' and not carried,
--    instead of refusing ORIGINAL_UNPROVEN / ARRIVAL_UNPROVEN. That is the
--    same "holds nothing" rule the abandoned-generation door applies to a
--    bust whose elimination is pending. Anything else refuses exactly as
--    before, including two roster entries for one player, a player with a
--    live chair and no arrival receipt, or a missing registration.
--
-- No chip, registration, seat, ledger row or wallet is written by this
-- migration or by any door it changes. No trigger, constraint or
-- immutability guard is relaxed; nothing is deleted.
-- fn_f06_admit_mixed_manager_custody and fn_f06_complete_mixed_manager_custody
-- are byte-identical before and after (asserted below).
--
-- PROOF (production rows, one rolled-back DO block, 2026-09-27): the new
-- bodies installed as pg_temp helpers, a fresh generation taking each dead
-- lease inside the transaction, readmission then completion for all 45; and
-- the negative cases. Results in
-- docs/changelog/2026-09-27-an-admitted-transfer-survives-its-dead-process.md.
--
-- Law: tests/an-admitted-transfer-survives-its-dead-process.law.test.ts
--
-- @live-proof: (SELECT to_regclass('smarter_private.f06_manager_custody_readmissions') IS NOT NULL)
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_readmit_mixed_manager_custody(uuid,uuid,uuid,jsonb)'::regprocedure) = '348efe032d97156c1183def5f24f1aaf'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_mixed_current_admission(uuid,uuid,uuid)'::regprocedure) = '6b30ff37cb81ca84d31a97f16b8c87db'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_find_mixed_manager_custody(uuid)'::regprocedure) = 'b6bf7747d57f7d1c2af5a7b15a630102'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_mixed_adopt_presence(uuid,jsonb)'::regprocedure) = '4237ab63b924137b5329c399d472f59e'

BEGIN;
SET LOCAL lock_timeout = '2s';

DO $pre$
BEGIN
  IF to_regclass('smarter_private.f06_manager_custody_readmissions') IS NOT NULL
     OR to_regprocedure('public.fn_f06_readmit_mixed_manager_custody(uuid,uuid,uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREIMAGE: the readmission door already exists';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_mixed_current_admission(uuid,uuid,uuid)'::regprocedure) <> 'dc612333e6fc9bb08bf70ffa8562ce1a'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_mixed_adopt_presence(uuid,jsonb)'::regprocedure) <> '009ddd1a79f92c4a64ad4b3adfe08107'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_find_mixed_manager_custody(uuid)'::regprocedure) <> 'd140c71041b6fa7c7fe5bcec1e621fb4'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb)'::regprocedure) <> 'aeaabb44975b8d138ed447687b0aea22'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_complete_mixed_manager_custody(uuid,uuid,uuid,jsonb)'::regprocedure) <> '43aa14703d4d8f37a95f7adf6c6ed5c1'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_authority(uuid,uuid,boolean)'::regprocedure) <> '939908ee892773e79e04fc73241c3f75'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_try_lane(uuid)'::regprocedure) <> 'e2926a0246837b974c7237872ec42aa5'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_manager_transfer_immutable()'::regprocedure) <> '0daf117b8c81a351771c5fa802d22c62' THEN
    RAISE EXCEPTION 'PREIMAGE: an F06 mixed custody function differs from the one this migration was written against';
  END IF;
END
$pre$;

CREATE TABLE smarter_private.f06_manager_custody_readmissions (
  transfer_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  generation uuid NOT NULL,
  prior_generation uuid NOT NULL,
  prior_lease_identity jsonb NOT NULL,
  lease_identity jsonb NOT NULL,
  terminal_proof jsonb NOT NULL,
  readmitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (transfer_id, generation),
  UNIQUE (transfer_id, prior_generation),
  CHECK (generation <> prior_generation)
);
CREATE TRIGGER immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_manager_custody_readmissions
  FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_manager_transfer_immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON smarter_private.f06_manager_custody_readmissions
  FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.f06_manager_transfer_immutable();
ALTER TABLE smarter_private.f06_manager_custody_readmissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.f06_manager_custody_readmissions FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_f06_readmit_mixed_manager_custody(p_tournament_id uuid, p_lease_generation uuid, p_transfer_id uuid, p_expected jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE prior smarter_private.f06_manager_custody_transfers; a smarter_private.f06_manager_custody_admissions;
 r smarter_private.f06_manager_custody_readmissions; head_g uuid; head_identity jsonb; l jsonb;
BEGIN
 PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation);
 PERFORM smarter_private.f06_try_lane(p_tournament_id);
 PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation,false);
 SELECT * INTO prior FROM smarter_private.f06_manager_custody_transfers WHERE transfer_id=p_transfer_id FOR SHARE;
 IF NOT FOUND OR prior.tournament_id IS DISTINCT FROM p_tournament_id OR to_jsonb(prior) IS DISTINCT FROM p_expected
 THEN RAISE EXCEPTION 'F06_MIXED_SUCCESSOR_CHANGED'; END IF;
 -- Only an ADMITTED transfer changes hands here. A transfer nobody admitted is
 -- admitted by its own successor through fn_f06_admit_mixed_manager_custody.
 SELECT * INTO a FROM smarter_private.f06_manager_custody_admissions WHERE transfer_id=p_transfer_id FOR SHARE;
 IF NOT FOUND OR a.tournament_id IS DISTINCT FROM p_tournament_id THEN RAISE EXCEPTION 'F06_MIXED_READMISSION_UNADMITTED'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions WHERE transfer_id=p_transfer_id)
 THEN RAISE EXCEPTION 'F06_MIXED_ALREADY_COMPLETE'; END IF;
 IF p_lease_generation IN (prior.origin_generation,prior.successor_generation,a.generation)
 THEN RAISE EXCEPTION 'F06_MIXED_READMISSION_GENERATION_REUSED'; END IF;
 SELECT * INTO r FROM smarter_private.f06_manager_custody_readmissions WHERE transfer_id=p_transfer_id AND generation=p_lease_generation FOR SHARE;
 IF FOUND THEN
  -- A replay by the process that readmitted: bound to its exact lease row.
  PERFORM smarter_private.f06_mixed_current_admission(p_tournament_id,p_lease_generation,p_transfer_id);
 ELSE
  IF EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_readmissions WHERE transfer_id=p_transfer_id AND prior_generation=p_lease_generation)
  THEN RAISE EXCEPTION 'F06_MIXED_READMISSION_GENERATION_REUSED'; END IF;
  -- The chain head is the one generation no later readmission replaced.
  SELECT x.generation,x.lease_identity INTO head_g,head_identity FROM smarter_private.f06_manager_custody_readmissions x
   WHERE x.transfer_id=p_transfer_id AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_readmissions y
    WHERE y.transfer_id=p_transfer_id AND y.prior_generation=x.generation);
  IF NOT FOUND THEN head_g:=a.generation; head_identity:=a.lease_identity; END IF;
  -- The head is fenced: the lease row carries this generation (f06_authority
  -- above), which the claim grants only over an absent lease or one stale
  -- beyond its window, after every in-flight transaction of the head ended.
  SELECT to_jsonb(e)-'heartbeat_at' INTO l FROM public.engine_tournament_leases e WHERE tournament_id=p_tournament_id;
  IF l IS NULL OR (l->>'lease_generation')::uuid IS DISTINCT FROM p_lease_generation OR head_g=p_lease_generation
  THEN RAISE EXCEPTION 'F06_LEASE_FENCED' USING ERRCODE='42501'; END IF;
  INSERT INTO smarter_private.f06_manager_custody_readmissions(transfer_id,tournament_id,generation,prior_generation,prior_lease_identity,lease_identity,terminal_proof)
  VALUES(p_transfer_id,p_tournament_id,p_lease_generation,head_g,head_identity,l,a.terminal_proof) RETURNING * INTO r;
 END IF;
 RETURN jsonb_build_object('ok',true,'custody_only',true,'readmitted',true,'transfer_id',p_transfer_id,'tournament_id',p_tournament_id,
  'lease_generation',p_lease_generation,'receipt',to_jsonb(prior),'admission',to_jsonb(r));
END $function$;
REVOKE ALL ON FUNCTION public.fn_f06_readmit_mixed_manager_custody(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_readmit_mixed_manager_custody(uuid,uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION smarter_private.f06_mixed_current_admission(t uuid, g uuid, transfer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE a smarter_private.f06_manager_custody_admissions; r smarter_private.f06_manager_custody_readmissions; l jsonb;
BEGIN
 PERFORM smarter_private.f06_authority(t,g);
 SELECT to_jsonb(e)-'heartbeat_at' INTO l FROM public.engine_tournament_leases e WHERE tournament_id=t;
 SELECT * INTO a FROM smarter_private.f06_manager_custody_admissions WHERE transfer_id=transfer FOR SHARE;
 IF NOT FOUND OR a.tournament_id IS DISTINCT FROM t THEN RAISE EXCEPTION 'F06_MIXED_ADMITTED_PROCESS_CHANGED'; END IF;
 IF a.generation=g THEN
  IF a.lease_identity IS DISTINCT FROM l THEN RAISE EXCEPTION 'F06_MIXED_ADMITTED_PROCESS_CHANGED'; END IF;
  RETURN to_jsonb(a);
 END IF;
 -- A generation that took the admitted custody over from a dead process.
 SELECT * INTO r FROM smarter_private.f06_manager_custody_readmissions WHERE transfer_id=transfer AND generation=g FOR SHARE;
 IF NOT FOUND OR r.tournament_id IS DISTINCT FROM t OR r.lease_identity IS DISTINCT FROM l THEN
 RAISE EXCEPTION 'F06_MIXED_ADMITTED_PROCESS_CHANGED'; END IF;
 RETURN to_jsonb(r);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_f06_find_mixed_manager_custody(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE receipt smarter_private.f06_manager_custody_transfers; head_g uuid; admission jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR p_tournament_id IS NULL THEN RAISE EXCEPTION 'F06_MIXED_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM smarter_private.f06_manager_custody_transfers WHERE tournament_id=p_tournament_id AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions c WHERE c.transfer_id=f06_manager_custody_transfers.transfer_id))>1 THEN
 RAISE EXCEPTION 'F06_MIXED_TRANSFER_SELECTION_UNPROVEN'; END IF;
 SELECT * INTO receipt FROM smarter_private.f06_manager_custody_transfers WHERE tournament_id=p_tournament_id AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions c WHERE c.transfer_id=f06_manager_custody_transfers.transfer_id);
 IF NOT FOUND THEN
  RETURN jsonb_build_object('ok',true,'tournament_id',p_tournament_id,'receipt',NULL,'admission',NULL);
 END IF;
 -- Who holds the admitted custody now: the last readmitted generation, else
 -- the admitted one. live = the event's lease is that generation, fresh.
 SELECT x.generation INTO head_g FROM smarter_private.f06_manager_custody_readmissions x
  WHERE x.transfer_id=receipt.transfer_id AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_readmissions y
   WHERE y.transfer_id=receipt.transfer_id AND y.prior_generation=x.generation);
 IF head_g IS NULL THEN SELECT a.generation INTO head_g FROM smarter_private.f06_manager_custody_admissions a WHERE a.transfer_id=receipt.transfer_id; END IF;
 IF head_g IS NOT NULL THEN
  admission:=jsonb_build_object('generation',head_g,'live',EXISTS(SELECT 1 FROM public.engine_tournament_leases l
   WHERE l.tournament_id=p_tournament_id AND l.protocol_version=2 AND l.lease_generation=head_g
   AND l.heartbeat_at>=clock_timestamp()-interval '30 seconds'));
 END IF;
 RETURN jsonb_build_object('ok',true,'tournament_id',p_tournament_id,'receipt',to_jsonb(receipt),'admission',admission);
END $function$;

CREATE OR REPLACE FUNCTION smarter_private.f06_mixed_adopt_presence(t uuid, local_proof jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE bank_proof jsonb; historical boolean; engine jsonb; custody jsonb; durable jsonb; banks jsonb; fsm jsonb; user_key text; original_stay uuid;
 target public.table_seats; bank jsonb; presence jsonb; targets jsonb:='{}'; item jsonb; table_key text;
 hand bigint; at_time timestamptz:=clock_timestamp(); receipt jsonb; receipts jsonb:='[]'; n integer; holds_nothing boolean;
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
 -- A PLAYER WHO HOLDS NOTHING HAS NO PRESENCE TO CARRY (2026-09-27): their
 -- registration in this event holds 0 chips and no chair of theirs in the
 -- event is live or holds a chip. Presence governs a seated player; this one
 -- has no chair to carry it to. Named on the receipt, never carried.
 holds_nothing:=EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=t AND tp.user_id=user_key::uuid AND tp.chips=0)
  AND NOT EXISTS(SELECT 1 FROM public.table_seats b JOIN public.tables bt ON bt.id=b.table_id
   WHERE bt.tournament_id=t AND b.user_id=user_key::uuid AND (b.left_at IS NULL OR b.stack IS DISTINCT FROM 0));
 SELECT count(*),min((r->>1)::text)::uuid INTO n,original_stay FROM jsonb_array_elements(custody->'roster') r WHERE r->>0=user_key;
 IF n=0 AND holds_nothing THEN
 receipts:=receipts||jsonb_build_array(jsonb_build_object('user_id',user_key,'source_table',engine->>'table_id',
 'source_occupancy',NULL,'discarded','holds_nothing','bank',banks->user_key,'presence',fsm->user_key));
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
 IF n=0 AND holds_nothing THEN
 receipts:=receipts||jsonb_build_array(jsonb_build_object('user_id',user_key,'source_table',engine->>'table_id',
 'source_occupancy',original_stay,'discarded','holds_nothing','bank',banks->user_key,'presence',fsm->user_key));
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

DO $post$
BEGIN
  IF to_regclass('smarter_private.f06_manager_custody_readmissions') IS NULL
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'smarter_private.f06_manager_custody_readmissions'::regclass AND NOT tgisinternal) <> 2
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'smarter_private.f06_manager_custody_readmissions'::regclass)
     OR has_table_privilege('service_role', 'smarter_private.f06_manager_custody_readmissions', 'INSERT')
     OR NOT has_function_privilege('service_role', 'public.fn_f06_readmit_mixed_manager_custody(uuid,uuid,uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_f06_readmit_mixed_manager_custody(uuid,uuid,uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_f06_readmit_mixed_manager_custody(uuid,uuid,uuid,jsonb)', 'EXECUTE')
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb)'::regprocedure) <> 'aeaabb44975b8d138ed447687b0aea22'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_complete_mixed_manager_custody(uuid,uuid,uuid,jsonb)'::regprocedure) <> '43aa14703d4d8f37a95f7adf6c6ed5c1'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_readmit_mixed_manager_custody(uuid,uuid,uuid,jsonb)'::regprocedure) <> '348efe032d97156c1183def5f24f1aaf'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_mixed_current_admission(uuid,uuid,uuid)'::regprocedure) <> '6b30ff37cb81ca84d31a97f16b8c87db'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_find_mixed_manager_custody(uuid)'::regprocedure) <> 'b6bf7747d57f7d1c2af5a7b15a630102'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_mixed_adopt_presence(uuid,jsonb)'::regprocedure) <> '4237ab63b924137b5329c399d472f59e'
     OR EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_readmissions) THEN
    RAISE EXCEPTION 'POSTIMAGE: the readmission door is not exactly as written';
  END IF;
END
$post$;

COMMIT;
