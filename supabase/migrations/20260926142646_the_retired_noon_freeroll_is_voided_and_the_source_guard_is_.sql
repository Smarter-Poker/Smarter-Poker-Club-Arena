-- 20260926142646_the_retired_noon_freeroll_is_voided_and_the_source_guard_is_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  THE RETIRED NOON FREEROLL IS VOIDED, AND THE SOURCE GUARD IS RESTORED
-- ===========================================================================
--
-- The second of two transactions of the reviewed void (header of
-- 20260926131948 for the events, the ruling, the facts and the proof).
-- 20260926131948 created the door, opened f06_source_guard's void clause and
-- voided 615783bf. This one voids 5a387a75 ($100 Freeroll 12:00 PM, 351
-- entrants, every one a horse): 100.00 back to the main union bank, 29.70 of
-- recorded-but-unpaid prizes void, RexSr's elimination recorded, chairs and
-- tables released, escrow closed at zero, a verified cancellation receipt.
-- Then it restores f06_source_guard byte for byte to its live body
-- (be484837), so no bypass outlives the void, and proves both events.
--
-- The settlement lane is taken only when it is free (try-locks, never
-- queueing): up to 20 s for G, then at most 3 s for the hand-settlement
-- barrier, and the void's statement is capped at 20 s once both are held
-- (a third of it is the 351 registrations' terminal stamp). A lane that never
-- frees, or a slower void, refuses the whole transaction with nothing written.
--
-- @live-proof: (SELECT status FROM public.tournaments WHERE id = '5a387a75-754a-416e-8fee-b85b15fc2702') = 'CANCELLED'
-- @live-proof: (SELECT count(*) FROM smarter_private.f06_retired_event_voids WHERE completed_at IS NOT NULL) = 2

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_source_guard()'::regprocedure
       AND md5(p.prosrc) = '77a6d6505ecb318845d280176881e0f0'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'PREIMAGE: f06_source_guard does not carry the void clause of 20260926131948';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('smarter_private.f06_void_retired_mixed_custody_event(uuid,text)')
       AND md5(p.prosrc) = '1d8fe29089e20bb6dedd54fe00b46818') THEN
    RAISE EXCEPTION 'PREIMAGE: the void door is not the definition of 20260926131948';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM smarter_private.f06_retired_event_voids
                  WHERE tournament_id = '615783bf-15e3-40b7-9368-75f21b6ac53b' AND completed_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM smarter_private.f06_retired_event_voids
                 WHERE tournament_id = '5a387a75-754a-416e-8fee-b85b15fc2702')
     OR NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = '5a387a75-754a-416e-8fee-b85b15fc2702' AND status = 'RUNNING') THEN
    RAISE EXCEPTION 'PREIMAGE: 615783bf must be voided and 5a387a75 still RUNNING and unclaimed';
  END IF;
END
$pre$;

SET LOCAL statement_timeout = '25s';
DO $lane$
BEGIN
  FOR i IN 1..400 LOOP
    EXIT WHEN pg_try_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    IF i = 400 THEN
      RAISE EXCEPTION 'F06_VOID_SETTLEMENT_LANE_NEVER_FREE' USING ERRCODE = '55P03';
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
END
$lane$;
SET LOCAL statement_timeout = '20s';

DO $void$
DECLARE r jsonb;
BEGIN
  FOR i IN 1..60 LOOP
    EXIT WHEN pg_try_advisory_xact_lock(hashtextextended('ca:hand-settlement-barrier:v1', 0));
    IF i = 60 THEN
      RAISE EXCEPTION 'F06_VOID_SETTLEMENT_BARRIER_NEVER_FREE' USING ERRCODE = '55P03';
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := smarter_private.f06_void_retired_mixed_custody_event('5a387a75-754a-416e-8fee-b85b15fc2702',
    'Reviewed void (Dan, 2026-09-26): retired mixed-custody event pinned to dead engine 778075b4 that no custody design can resume; every entrant a horse; every dollar returned to its source');
  RAISE NOTICE '5a387a75 voided: %', r->'reviewed_void';
END
$void$;
SET LOCAL statement_timeout = '10s';

-- The guard goes back exactly as it was: no bypass outlives this migration.
CREATE OR REPLACE FUNCTION smarter_private.f06_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE src uuid;dst uuid;u uuid;t uuid;oldj jsonb;newj jsonb;bound boolean;moving boolean;
BEGIN
 oldj:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 newj:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
 src:=(oldj->>'table_id')::uuid;dst:=(newj->>'table_id')::uuid;u:=COALESCE((newj->>'user_id')::uuid,(oldj->>'user_id')::uuid);
 SELECT tournament_id INTO t FROM public.tables WHERE id=COALESCE(src,dst);
 IF t IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 -- Payload-only writes preserve source custody. They need to exclude a
 -- canonical move/begin, not other accepted hands in this tournament. The
 -- outer hand RPC already holds T shared; promoting it to exclusive here
 -- makes ordinary concurrent hands refuse each other even with no F06 move.
 IF TG_OP='UPDATE' AND (
  (TG_TABLE_NAME='table_seats'
   AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
   AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number'))
  OR (TG_TABLE_NAME='tournament_players'
   AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status'))
 ) THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
 END IF;
 -- Canonical admission authorities already hold T exclusive. A direct row
 -- writer may try it, but cannot wait while holding a row needed by begin.
 -- Closing the exact already-zero generation cannot move funded custody.
 -- Share G/T with other tables' hands, while still excluding every canonical
 -- begin/move/terminal authority, which owns T or G exclusively. Do not
 -- return here: PARK_REQUESTED still needs the original hand receipt and
 -- BEGUN still needs the original move receipt below.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='table_seats'
  AND oldj->>'left_at' IS NULL AND newj->>'left_at' IS NOT NULL
  AND newj->>'status'='left'
  AND oldj->'stack'='0'::jsonb AND newj->'stack'='0'::jsonb
  AND oldj->>'user_id' IS NOT NULL
  AND (src,oldj->>'id',oldj->>'user_id',oldj->>'seat_number',oldj->>'joined_at',oldj->>'club_id')
      IS NOT DISTINCT FROM
      (dst,newj->>'id',newj->>'user_id',newj->>'seat_number',newj->>'joined_at',newj->>'club_id') THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
 ELSE
  PERFORM smarter_private.f06_try_lane(t);
 END IF;
 bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id IN(src,dst) AND state NOT IN ('acknowledged','withdrawn_before_manifest'));
 IF NOT bound THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;

 -- A validated elimination is neither a hand dispatch nor a seat move. The
 -- private core authorizes exactly one row image immediately before its CAS;
 -- this BEFORE trigger consumes it, so later writes cannot reuse it. Existing
 -- lane acquisition above still serializes the source/manifest transition.
 IF TG_OP='UPDATE' AND src=dst AND oldj->>'user_id'=newj->>'user_id'
 AND ((TG_TABLE_NAME='tournament_players' AND oldj->>'status'='playing'
       AND newj->>'status'='eliminated' AND oldj->'chips'='0'::jsonb
       AND newj->'chips'='0'::jsonb)
   OR (TG_TABLE_NAME='table_seats' AND oldj->>'left_at' IS NULL
       AND newj->>'left_at' IS NOT NULL AND oldj->'stack'='0'::jsonb
       AND newj->'stack'='0'::jsonb))
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o
   WHERE o.source_table_id=src
     AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')
     AND (o.state<>'park_requested' OR o.manifest IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id)
       OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
       OR to_jsonb(o)->>'abort_receipt_id' IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)
       OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id))) THEN
   DELETE FROM smarter_private.f06_elimination_dispatch d
   USING public.tournament_knockout_candidates c
   WHERE d.xid=txid_current() AND d.relation_name=TG_TABLE_NAME
     AND d.row_id=(oldj->>'id')::uuid AND d.candidate_id=c.id
     AND d.old_record=oldj AND d.new_record=newj
     AND c.tournament_id=t AND c.table_id=src AND c.eliminated_user_id=u
     AND c.state='pending' AND c.stack_after=0
     AND (TG_TABLE_NAME='tournament_players' AND oldj->>'tournament_id'=t::text
       OR TG_TABLE_NAME='table_seats' AND c.seat_id=(oldj->>'id')::uuid
         AND c.seat_joined_at=(oldj->>'joined_at')::timestamptz);
   IF FOUND THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='table_seats' THEN
 -- Existing accepted final-hand stack updates can drain PARK_REQUESTED. Once
 -- BEGUN, only the one guarded move may vacate/change original custody.
 IF TG_OP='UPDATE' AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
 AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number') THEN
 RETURN NEW; END IF;
 ELSE
 IF TG_OP='UPDATE' AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status') THEN RETURN NEW; END IF;
 END IF;
 moving:=EXISTS(SELECT 1 FROM smarter_private.f06_dispatch d JOIN smarter_private.f06_attempts a USING(request_id)
 JOIN smarter_private.f06_operations o ON o.break_id=a.break_id WHERE d.xid=txid_current() AND a.user_id=u AND o.source_table_id=src
 AND (TG_TABLE_NAME='table_seats' AND TG_OP='UPDATE' AND src=dst AND newj->>'left_at' IS NOT NULL
 OR TG_TABLE_NAME='tournament_players' AND TG_OP='UPDATE' AND dst=a.destination_table_id AND (newj->>'seat_number')::integer=a.destination_seat_number));
 IF NOT moving AND EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) JOIN smarter_private.f06_operations o ON o.source_table_id=h.table_id WHERE d.xid=txid_current() AND h.table_id=src AND o.state='park_requested') THEN moving:=true; END IF;
 IF NOT moving THEN RAISE EXCEPTION 'F06_SOURCE_EXCLUDED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;

SET CONSTRAINTS ALL IMMEDIATE;

DO $post$
DECLARE t uuid; v_in numeric; v_out numeric;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_source_guard()'::regprocedure
       AND md5(p.prosrc) = 'be484837a5103b3c0ac78a1d6d5d0bf2'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: f06_source_guard was not restored to its pre-image';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_void_retired_mixed_custody_event(uuid,text)'::regprocedure
       AND md5(p.prosrc) = '1d8fe29089e20bb6dedd54fe00b46818'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private","statement_timeout=20s","lock_timeout=5s"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: the void door is not the reviewed definition with its owner, grants and settings';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'smarter_private.f06_retired_event_voids'::regclass)
     OR has_table_privilege('anon', 'smarter_private.f06_retired_event_voids', 'SELECT')
     OR has_table_privilege('authenticated', 'smarter_private.f06_retired_event_voids', 'SELECT')
     OR has_table_privilege('service_role', 'smarter_private.f06_retired_event_voids', 'SELECT') THEN
    RAISE EXCEPTION 'POSTIMAGE: the void receipts are not private';
  END IF;
  FOREACH t IN ARRAY ARRAY['5a387a75-754a-416e-8fee-b85b15fc2702'::uuid, '615783bf-15e3-40b7-9368-75f21b6ac53b'::uuid] LOOP
    PERFORM public.fn_ca_tournament_cancellation_receipt(t, NULL);
    IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = t AND status = 'CANCELLED' AND prize_pool = 0)
       OR NOT EXISTS (SELECT 1 FROM smarter_private.f06_retired_event_voids v
                       WHERE v.tournament_id = t AND v.completed_at IS NOT NULL)
       OR NOT EXISTS (SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id = t
                       AND e.closed_at IS NOT NULL AND e.prize_balance = 0 AND e.bounty_balance = 0
                       AND e.fee_balance = 0 AND e.overlay_in = 0)
       OR EXISTS (SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id = t)
       OR EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = t
                   AND (status <> 'eliminated' OR chips <> 0 OR prize <> 0))
       OR EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
                   WHERE tb.tournament_id = t AND s.left_at IS NULL) THEN
      RAISE EXCEPTION 'POSTIMAGE: % is not cleanly terminal', t;
    END IF;
    -- CONSERVATION: every chip into the event's prize liability came out.
    SELECT COALESCE(sum(amount) FILTER (WHERE to_type = 'prize_liability' AND to_entity_id = t), 0),
           COALESCE(sum(amount) FILTER (WHERE from_type = 'prize_liability' AND from_entity_id = t), 0)
      INTO v_in, v_out FROM public.chip_ledger WHERE tournament_id = t;
    IF v_in <> v_out OR v_in = 0 THEN
      RAISE EXCEPTION 'POSTIMAGE: % prize liability does not balance: in % out %', t, v_in, v_out;
    END IF;
    -- The overlay went back to the same store and entity, same amount, once.
    IF (SELECT count(*) FROM public.chip_ledger o JOIN public.chip_ledger r
          ON r.tournament_id = t AND r.category = 'reversal'
         AND r.idempotency_key = 'tourney:' || t::text || ':void:overlay-return'
         AND r.from_type = 'prize_liability' AND r.from_entity_id = t
         AND r.to_type = o.from_type AND r.to_entity_id = o.from_entity_id AND r.amount = o.amount
         WHERE o.tournament_id = t AND o.category = 'overlay') <> 1 THEN
      RAISE EXCEPTION 'POSTIMAGE: % overlay did not return to its source exactly once', t;
    END IF;
    -- Every wallet got back exactly what it paid.
    IF EXISTS (
      SELECT 1 FROM (
        SELECT from_entity_id AS u, sum(amount) AS paid FROM public.chip_ledger
         WHERE tournament_id = t AND category = 'addon' AND from_type = 'player_wallet' GROUP BY 1) c
      FULL JOIN (
        SELECT to_entity_id AS u, sum(amount) AS back FROM public.chip_ledger
         WHERE tournament_id = t AND category = 'refund' AND to_type = 'player_wallet' GROUP BY 1) r
        USING (u)
       WHERE c.paid IS DISTINCT FROM r.back) THEN
      RAISE EXCEPTION 'POSTIMAGE: % add-ons and refunds do not match wallet by wallet', t;
    END IF;
  END LOOP;
END
$post$;

COMMIT;
