-- 20260927201810_f06_source_guard_unbinds_bare_park_requests.sql
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-27 20:18:10 UTC.
--
-- ===========================================================================
--  A BARE PARK REQUEST IS NOT A MOVE IN FLIGHT
-- ===========================================================================
--
-- Production Alerts board (Smarter-Poker/Smarter-Poker-Club-Arena#5070):
-- tournament bfcfaf17-2879-4e58-b8e1-1c749ceb3b2f ("DSS Thursday $5.50 NLH
-- Turbo") reached heads-up-then-won at 2026-09-18 05:17 UTC and has sat
-- RUNNING for nine days since: `financial_alerts` recorded two proven,
-- retry-eligible `Tournament.atomic_finish_refused` rows for it on
-- 2026-09-26 (reasons "other" then "timeout"), and its winner (squeeze777,
-- f9e96cd6-c8b8-4ddc-aea8-a6a81155158a, 168000 chips, owed 40.02 of the
-- 63.00 pool at the 63.52% first-place share) has never been paid.
--
-- ROOT CAUSE, proved live in a rolled-back probe (CLAUDE.md 11.5): calling
-- fn_complete_tournament_terminal(...,'places') for this tournament fails
-- inside fn_settle_tournament_places's own UPDATE of tournament_players (the
-- winner-status flip), raised by the BEFORE trigger smarter_private
-- .f06_source_guard() as F06_SOURCE_EXCLUDED. The guard's `bound` check --
-- "does this table still have a live F06 operation that must exclude
-- ordinary writers" -- reads:
--
--   bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations
--                  WHERE source_table_id IN(src,dst)
--                    AND state NOT IN ('acknowledged','withdrawn_before_manifest'));
--
-- which counts ANY non-terminal-state row as binding. But the function's own
-- elimination-dispatch fast path, a few lines further down, already knows a
-- bare `park_requested` row -- no manifest, no row in f06_movement_admissions,
-- no close_receipt, no cleanup_kind, no abort_receipt_id, no f06_members, no
-- f06_attempts -- is NOT a move in flight; it is a planned move whose table
-- concluded before the move could manifest. That fast path excludes exactly
-- this shape from its own "is this genuinely bound" test. `bound` never got
-- the same nuance, so a table left holding one of these skeleton rows is
-- excluded from every ordinary write forever, including its own tournament's
-- terminal settlement.
--
-- This tournament's f06_operations row (break_id 544dc515-bbbf-4337-8622-
-- e177139bc09a, table 0cfc4303-76ae-4a5e-81ef-2be82cf5d8f0) is exactly that
-- shape: state='park_requested', manifest NULL, close_receipt NULL,
-- cleanup_kind NULL, abort_receipt_id NULL, created_at 2026-09-18 05:17:26 --
-- 25 seconds after this table's last real elimination (05:17:25) -- with zero
-- matching rows in f06_movement_admissions, f06_members or f06_attempts,
-- confirmed by direct query before this migration was written. It is not the
-- only one: at the time of writing, 7 tables across the platform carry a
-- bare, unbound park_requested operation this way, the newest created
-- 2026-09-27 20:14 UTC -- this keeps happening, it is not a one-off.
--
-- FIX: give `bound` the identical "genuinely bound" predicate the
-- elimination-dispatch fast path already trusts. Nothing else in the
-- function changes. A table with a real move in flight (a manifest, an
-- admission, a member, an attempt, or any close/cleanup/abort evidence)
-- is excluded exactly as before; a table holding only a skeleton
-- park_requested row is not.
--
-- This migration does not settle bfcfaf17's payout. Once installed, the
-- tournament's own in-process retry (or an authorized direct call to the
-- receipted, idempotent fn_complete_tournament_terminal) completes it
-- through the normal path -- no wallet row is hand-written here, and the
-- fix must be reviewed and live before that call is made for real.
--
-- HARDENING (CLAUDE.md 10.11/10.12):
--  1. Cause fixed at the root: this migration, in the guard itself.
--  2. Damage: not yet settled (see above) -- this migration only unblocks
--     the existing settlement path; it commits no money.
--  3. Regression test: the executable proof is
--     scripts/dev/probe-f06-source-guard-unbinds-bare-park-request-pg16.sh --
--     builds an isolated PostgreSQL from the exact production preimage of
--     f06_source_guard (fixture pinned by md5), reproduces
--     F06_SOURCE_EXCLUDED against a bare park_requested row on the preimage,
--     applies this migration unchanged, and proves the same write now
--     succeeds while a genuinely bound operation (a row with a manifest)
--     still correctly refuses it, and that the operations row itself is
--     never mutated. server/src/tournament/F06GuardUnbindsBareParkRequest
--     .guard.test.ts pins the migration text that proof depends on.
--  4. CI: job in .github/workflows/f06-guard-unbinds-bare-park-request.yml
--     runs both on any PR touching this migration or f06_source_guard.
--
-- Preimage/postimage md5 of smarter_private.f06_source_guard: this
-- migration was written directly against the live function definition
-- (queried via the Supabase MCP), not a stale local copy.
--
-- @live-proof: (SELECT count(*) FROM smarter_private.f06_operations o WHERE o.source_table_id IN ('5999aa30-05a4-49e9-9820-fc69a9b67566','0cfc4303-76ae-4a5e-81ef-2be82cf5d8f0') AND o.state NOT IN ('acknowledged','withdrawn_before_manifest') AND (o.state<>'park_requested' OR o.manifest IS NOT NULL OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL OR to_jsonb(o)->>'abort_receipt_id' IS NOT NULL OR EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id) OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id) OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id))) = 0

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10s';

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
    RAISE EXCEPTION 'PREIMAGE: f06_source_guard is not the live body this migration was written against';
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
 -- A bare park_requested with no manifest, admission, member or attempt
 -- bound to it is not a canonical move in flight; it is a planned move
 -- whose table concluded (or generation moved on) before it manifested.
 -- The elimination-dispatch fast path below already treats exactly this
 -- shape as unbound (CLAUDE.md 10.11: fixed at the root, 2026-09-27,
 -- after nine days stuck on tournament bfcfaf17-2879-4e58-b8e1-1c749ceb3b2f).
 -- This is the general case: use the identical predicate here too, so an
 -- abandoned park request cannot block any other canonical write forever.
 bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations o
   WHERE o.source_table_id IN(src,dst)
     AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')
     AND (o.state<>'park_requested' OR o.manifest IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id)
       OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
       OR to_jsonb(o)->>'abort_receipt_id' IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)
       OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id)));
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
       AND md5(p.prosrc) = 'caf6acb7a30fbd6044c4262520e134ac'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: f06_source_guard was not replaced with the reviewed body';
  END IF;
  -- The specific bare park_requested row this migration was written for no
  -- longer counts as bound under the new predicate (checked by direct
  -- re-evaluation of the identical predicate now embedded in the guard).
  IF EXISTS (
    SELECT 1 FROM smarter_private.f06_operations o
     WHERE o.break_id = '544dc515-bbbf-4337-8622-e177139bc09a'
       AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')
       AND (o.state<>'park_requested' OR o.manifest IS NOT NULL
         OR EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id)
         OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
         OR to_jsonb(o)->>'abort_receipt_id' IS NOT NULL
         OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)
         OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id))
  ) THEN
    RAISE EXCEPTION 'POSTIMAGE: the known bare park_requested row still evaluates as bound';
  END IF;
  -- This migration writes no money and touches no player-facing row: the
  -- f06_operations row itself is untouched (still park_requested), only the
  -- guard's reading of it changes.
  IF EXISTS (
    SELECT 1 FROM smarter_private.f06_operations
     WHERE break_id = '544dc515-bbbf-4337-8622-e177139bc09a' AND state <> 'park_requested'
  ) THEN
    RAISE EXCEPTION 'POSTIMAGE: the known row was mutated; this migration must not touch data';
  END IF;
END
$post$;

COMMIT;
