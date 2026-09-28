-- 20260928044311_the_terminal_finish_is_not_excluded_by_a_park_that_can_never.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  THE TERMINAL FINISH IS NOT EXCLUDED BY A PARK THAT CAN NEVER BEGIN
-- ===========================================================================
--
-- bfcfaf17 "DSS Thursday $5.50 NLH Turbo" was decided at 2026-09-18 05:17 UTC
-- (heads-up won; winner f9e96cd6 holds all 168,000 chips on table 0cfc4303,
-- the event's last open table) and is still RUNNING. The engine logs "is
-- decided (1 playing) - recovering the winner" every ~20 s. Read 2026-09-28
-- 04:15 UTC in a rolled-back probe: fn_complete_tournament_terminal refuses
-- F06_SOURCE_EXCLUDED, raised by the BEFORE trigger a00_f06_source_roster
-- (smarter_private.f06_source_guard, line 97) on fn_settle_tournament_places'
-- own winner flip (UPDATE tournament_players SET status='winner'). The table
-- holds f06_operations break 544dc515: state park_requested, manifest NULL,
-- no admission, member, attempt, close, cleanup or abort; revision 2, custody
-- claimed by the live lease generation 84e15465. The balancer requested that
-- park 22 s before the final hand; the hand ended the event, so the park can
-- never begin. The winner (40.02 of the 63.00 pool) has never been paid.
--
-- WHY NOT UNBIND EVERY BARE PARK (PR #5474): every live park_requested row has
-- no manifest (27 of 27 in the last two days, newest minutes old): the manifest
-- is written at begin. Unbinding the bare shape for every writer would re-admit
-- all ordinary seat and registration writes to a source table between the
-- balancer's request and its begin, which is the window this guard exists for.
--
-- WHAT CHANGES: f06_source_guard's `bound` test does not count a bare
-- pre-manifest park of THIS event while the writer is this event's own
-- terminal settlement: app.tournament_seat_exit_operation = 'terminal_finish'
-- and a live terminal_finish authorization row for this tournament carrying
-- the transaction's token (fn_complete_tournament_terminal opens both, under
-- the finish lane, before fn_complete_tournament_terminal_pre_seat_guard).
-- Every other writer, every other operation state, a park with any begin
-- evidence, and a terminal authority for another event are excluded exactly as
-- before. Nothing else in the body changes.
--
-- The payout is not written here. Once installed, the engine's own decided
-- recovery calls fn_complete_tournament_terminal, which pays through
-- tournament_terminal_settlements (idempotent: it reads its own receipt first),
-- exactly once.
--
-- Proof: scripts/dev/probe-f06-terminal-finish-bare-park-pg16.sh (throwaway
-- PostgreSQL 16 cluster, the exact production pre-image be484837): red before,
-- green under the event's terminal authority, still refused without it, with
-- another event's authority, with a 'move' authority, and with a member bound
-- to the park. Law: tests/the-terminal-finish-is-not-excluded-by-a-park-that-can-never-begin.law.test.ts
--
-- Builds on PR #5474 (its fixture and probe harness); narrows its predicate to
-- the terminal settlement.
--
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_source_guard()'::regprocedure) = '6af3955d0fce49b522b4ba3707a60891'

BEGIN;
SET LOCAL lock_timeout = '2s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_source_guard()'::regprocedure
       AND md5(p.prosrc) = 'be484837a5103b3c0ac78a1d6d5d0bf2'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'PREIMAGE: f06_source_guard is not the definition read 2026-09-28';
  END IF;
  IF to_regclass('public.tournament_seat_exit_authorizations') IS NULL THEN
    RAISE EXCEPTION 'PREIMAGE: tournament_seat_exit_authorizations is missing';
  END IF;
END
$pre$;

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

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_source_guard()'::regprocedure
       AND md5(p.prosrc) = '6af3955d0fce49b522b4ba3707a60891'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: f06_source_guard is not the reviewed definition with its owner, grants and settings';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgfoid = 'smarter_private.f06_source_guard()'::regprocedure AND NOT tgisinternal) <> 2 THEN
    RAISE EXCEPTION 'POSTIMAGE: f06_source_guard is not the trigger of exactly table_seats and tournament_players';
  END IF;
END
$post$;

COMMIT;
