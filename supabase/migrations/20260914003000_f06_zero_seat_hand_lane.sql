-- Closing an exact already-zero tournament seat must not promote T shared.
-- Global/tournament exclusion and all original hand/move receipt guards remain.
-- No player, hand, balance, obligation, permit, or incident data is rewritten.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF md5(pg_get_functiondef('smarter_private.f06_source_guard()'::regprocedure)) NOT IN ('2bfb53c26a9043bcb1cd015dfbebc8b7','d89dc77965f1abea47e366ad6f6a426f')
 OR md5(pg_get_functiondef('smarter_private.f06_try_lane(uuid)'::regprocedure)) <> '78a3a191b9991b0a3a343db39de335aa'
 OR md5(pg_get_functiondef('public.fn_ca_share_settlement_lane_for_table(uuid)'::regprocedure)) <> '409b14ee72ce888d3b26524c52d49a68'
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_source_guard()'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}')
 OR (SELECT count(*) FROM pg_trigger WHERE tgfoid='smarter_private.f06_source_guard()'::regprocedure) <> 2
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='a00_f06_source_seat' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='a00_f06_source_roster' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_roster BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()') THEN
  RAISE EXCEPTION 'F06 zero-seat hand lane predecessor or binding changed; review before installation';
 END IF;
END $preflight$;
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
 bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id IN(src,dst) AND state<>'acknowledged');
 IF NOT bound THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
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

DO $postflight$
BEGIN
 IF md5(pg_get_functiondef('smarter_private.f06_source_guard()'::regprocedure)) <> 'd89dc77965f1abea47e366ad6f6a426f'
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_source_guard()'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN
  RAISE EXCEPTION 'F06 zero-seat hand lane installation did not preserve exact definition and authority';
 END IF;
END $postflight$;
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES
 ('table_seats','a00_f06_source_seat','Reviewed September 14: exact already-zero seat closing shares G/T with accepted hands while excluding canonical begin/move/terminal authorities. Original park-hand and begun-move receipts remain mandatory; positive stacks and changed identities/generations retain exclusive custody. Native financial, rollback and concurrency proofs recorded.'),
 ('tournament_players','a00_f06_source_roster','Reviewed September 13: unchanged table and seat mirrors in an accepted hand keep the shared tournament lane. Identity, status and custody changes retain exclusive lane and receipt checks. Native concurrency, rollback and full financial-path probes passed.')
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;
COMMIT;
