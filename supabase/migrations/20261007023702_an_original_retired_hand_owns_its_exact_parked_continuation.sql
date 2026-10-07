-- A parked table retains its original financial obligation. The original
-- transaction's private recovery receipt may revive only its exact preimages;
-- begun/manifested movement and every unrelated writer stay excluded.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $pre$ BEGIN
 IF md5(pg_get_functiondef('smarter_private.f06_source_guard()'::regprocedure)) IS DISTINCT FROM '082cf45040f08f8ea533e0c21d7cd4e3'
 OR md5(pg_get_functiondef('smarter_private.restore_retired_original_tournament_hand(uuid,text,uuid)'::regprocedure)) IS DISTINCT FROM 'a529e0bd2972a5b87eff0afa5fce7988'
 THEN RAISE EXCEPTION 'RETAINED_ORIGINAL_F06_PREIMAGE_CHANGED' USING ERRCODE='55000'; END IF;
END $pre$;
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
 -- THE EVENT'S OWN TERMINAL SETTLEMENT IS NOT EXCLUDED BY A PARK THAT CAN NEVER
 -- BEGIN (2026-09-28). A park the balancer requested and never began (no
 -- manifest, admission, member, attempt, close, cleanup or abort) keeps
 -- excluding every ordinary writer while its event runs: that is the window
 -- between request and begin this guard exists for. The one writer it must
 -- not exclude is the event's own terminal settlement, which holds the finish
 -- lane and this event's seat-exit authority: the event leaves RUNNING in the
 -- same transaction, so the park can never begin and nothing it protects can
 -- be raced. bfcfaf17 sat decided for ten days behind exactly that.
 bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations o WHERE o.source_table_id IN(src,dst) AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')
  AND NOT (o.state='park_requested' AND o.tournament_id=t AND o.manifest IS NULL
   AND o.close_receipt IS NULL AND o.cleanup_kind IS NULL AND o.abort_receipt_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id)
   AND current_setting('app.tournament_seat_exit_operation',true)='terminal_finish'
   AND EXISTS(SELECT 1 FROM public.tournament_seat_exit_authorizations x
    WHERE x.tournament_id=t AND x.operation='terminal_finish'
     AND x.token::text=current_setting('app.tournament_seat_exit_token',true))));
 IF NOT bound THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;

 -- An exact private retained-original receipt belongs to this transaction,
 -- before its native hand dispatch. It revives held custody only; it cannot
 -- begin a move, rewrite a manifest, fund a new chair or reopen an identity.
 IF TG_OP='UPDATE' AND src=dst AND auth.role() IS NOT DISTINCT FROM 'service_role'
 AND NOT public.fn_platform_frozen()
 AND EXISTS (
  SELECT 1 FROM smarter_private.retirement_original_hand_restorations r
  JOIN smarter_private.retirement_original_hand_qualification c USING(submission_id)
  JOIN smarter_private.hand_submissions s USING(submission_id)
  JOIN public.engine_tournament_leases l ON l.tournament_id=c.tournament_id
  JOIN smarter_private.f06_hand_permits h ON h.table_id=c.table_id AND h.hand_number=c.hand_number
  CROSS JOIN LATERAL jsonb_array_elements(c.expected->'rows') e
  WHERE r.transaction_id=txid_current() AND c.tournament_id=t AND c.table_id=src
   AND r.request_hash=c.request_hash AND s.request_hash=c.request_hash
   AND r.qualification_hash=md5(c.expected::text)
   AND r.original_generation=s.lease_generation AND h.generation=s.lease_generation
   AND r.successor_generation=l.lease_generation AND r.instance_id=l.instance_id
   AND r.successor_generation<>r.original_generation AND l.protocol_version=2
   AND l.heartbeat_at>=clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds())
   AND h.state='reserved' AND h.tournament_id=t
   AND r.restored_players=jsonb_array_length(c.expected->'rows')
   AND (e->>'user_id')::uuid=u
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.request->'p_stacks') x WHERE x=e->'stack')
   AND ((TG_TABLE_NAME='tournament_players'
     AND oldj @> (e->'roster')
     AND oldj->>'id'=e#>>'{roster,id}' AND oldj->>'status'='eliminated'
     AND (oldj->>'chips')::numeric=(e#>>'{stack,stack_before}')::numeric
     AND newj=oldj||jsonb_build_object('status','playing','eliminated_at',NULL))
    OR (TG_TABLE_NAME='table_seats'
     AND oldj @> (e->'seat') AND oldj->>'id'=e#>>'{seat,id}'
     AND oldj->>'left_at' IS NOT NULL AND oldj->>'status'='left'
     AND (oldj->>'stack')::numeric=(e#>>'{stack,stack_before}')::numeric
     AND newj=oldj||jsonb_build_object('left_at',NULL,'status','active')))
   AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o
     WHERE o.source_table_id=src AND o.state NOT IN('acknowledged','withdrawn_before_manifest')
      AND (o.tournament_id IS DISTINCT FROM t OR o.state<>'park_requested'
       OR o.lifecycle IS DISTINCT FROM h.lifecycle OR o.manifest IS NOT NULL
       OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL OR o.abort_receipt_id IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id)
       OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)
       OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id)))
 ) THEN RETURN NEW; END IF;

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
END $function$
;
ALTER FUNCTION smarter_private.f06_source_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_source_guard() FROM PUBLIC,anon,authenticated,service_role;
DO $post$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_source_guard()'::regprocedure
 AND md5(pg_get_functiondef(oid))='7dcdbb47269833c9fa0fe6cb8568dee9' AND md5(prosrc)='4643e1c834e283e6fa6f716e6bac7ef6'
 AND proowner='postgres'::regrole AND prosecdef AND provolatile='v'
 AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'] AND proacl::text='{postgres=X/postgres}')
 THEN RAISE EXCEPTION 'RETAINED_ORIGINAL_F06_POSTIMAGE_CHANGED' USING ERRCODE='55000';END IF;
END $post$;
-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='7dcdbb47269833c9fa0fe6cb8568dee9' AND md5(prosrc)='4643e1c834e283e6fa6f716e6bac7ef6' AND proowner='postgres'::regrole AND prosecdef AND provolatile='v' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'] AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_source_guard()'::regprocedure)
COMMIT;
