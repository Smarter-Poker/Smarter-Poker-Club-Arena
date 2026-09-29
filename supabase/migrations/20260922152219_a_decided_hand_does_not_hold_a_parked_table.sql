-- 20260922152219_a_decided_hand_does_not_hold_a_parked_table
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-22 15:22:19 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- CLAUDE.md 10.12: this file changes one reader. It schedules nothing, retries
-- nothing, writes no row and moves no chip.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- A tournament hand is authorised by one smarter_private.f06_hand_permits row.
-- The table admits exactly four states (f06_hand_permits_state_check):
--
--   reserved            the hand is in the air; nothing is decided yet
--   accepted            the hand committed; its sealed atomic commit is the
--                       evidence
--   never_started       the hand was decided NOT to count before any card
--   aborted_unsettled   the hand was decided NOT to count; its receipt row
--                       names it (F06_ABORT_RECEIPT_REQUIRED)
--
-- A permit leaves 'reserved' only through a receipt-bearing door and can never
-- change again (f06_immutable_identity: F06_HAND_IDENTITY_IMMUTABLE). For the
-- two "did not count" states nothing of the hand can ever be written later:
-- f06_hand_dispatch_guard raises F06_HAND_PERMIT_FENCED for them and
-- f06_aborted_hand_guard refuses their history. So the durable seat stacks are
-- exactly what the last committed hand left, which is the thing a table break
-- needs to know before it moves anybody.
--
-- smarter_private.f06_movement_permits is the reader every parked-table
-- movement proof calls (f06_movement_prior, and through it
-- fn_f06_admit_parked_movement and fn_f06_assert_drained_manager_custody). It
-- refused unless EVERY permit the table ever held was 'accepted'. It had no
-- notion of the other two decided states, although the protocol's own doors
-- write them: fn_f06_cancel_prepared_hand, fn_f06_finish_hand('never_started'),
-- fn_f06_abort_unsettled_hand, fn_f06_abort_unsettled_generation,
-- fn_f06_abort_successor_unsettled_hand, fn_f06_abort_mixed_unsettled_generation,
-- fn_f06_abort_retained_mtt_hands and fn_f06_abort_abandoned_generation. And the
-- assert's own expected-proof branch already accepts both as terminal
-- evidence. Two readers of one table, two definitions of "decided".
--
-- The consequence is permanent. Once a table has held one decided non-accepted
-- permit, F06_MOVEMENT_UNRESOLVED_HAND_CUSTODY refuses every movement proof for
-- that table for ever. The moment the balancer asks to break it, the park
-- excludes it from dealing (fn_f06_hand_number_state: source_excluded) and
-- nothing can ever move its players: the table stops dealing while the event
-- stays RUNNING. That is the "tables that stop dealing" half of the MTT stall.
--
-- MEASURED 2026-09-22, read-only:
--
--   permits by state          accepted 707,859 / reserved 328 /
--                             aborted_unsettled 525 on 498 tables /
--                             never_started 298 on 292 tables
--   open parks on RUNNING     park_requested 85 across 25 events and begun 5
--   events whose source       across 5 events; oldest requested 2026-09-18
--   holds a decided           05:17 UTC, newest 14:51 UTC (still being created)
--   non-accepted permit
--   engine log                "f06_movement_admission_unproven" about 5,600 an
--                             hour since 13:23 UTC: every one of those tables
--                             retried every ~15 s and never dealt
--   Postgres log 13:50-14:50  F06_MOVEMENT_UNRESOLVED_HAND_CUSTODY raised 3,397
--                             times inside fn_f06_assert_drained_manager_custody
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- One function, the same signature, owner, ACL, SECURITY DEFINER and
-- search_path. A permit is resolved for movement when it is DECIDED:
--
--   accepted            exactly as before: same tournament, the table's current
--                       lifecycle, at or below the boundary, with its exact
--                       sealed atomic commit;
--   never_started /     same tournament, the table's current lifecycle, a
--   aborted_unsettled   non-null evidence_id (the receipt that decided it), and
--                       still visibly nothing of that hand on the table: no
--                       atomic commit, no hand_history row and no private hand
--                       state at its (table_id, hand_number). It may lie above
--                       the boundary, because it is the hand that never
--                       happened.
--
-- 'reserved' still refuses. A dispatched permit still refuses. The returned
-- permit list is unchanged, so every stored movement proof still compares
-- equal (f06_assert_movement).
--
-- NOT TOUCHED: every roster, stack, seal, elimination and custody check in
-- f06_movement_prior and f06_assert_movement; every door that decides a
-- permit; the permit, operation and receipt tables; any lease.
--
-- The installer refuses unless the function it replaces is byte-for-byte the
-- definition this reasoning was written against, and unless the state check,
-- the immutability trigger and the dispatch fence it relies on are the
-- installed ones.
--
-- @live-proof: (SELECT prosrc LIKE '%WHEN h.state IN (''never_started'',''aborted_unsettled'') THEN%' FROM pg_proc WHERE oid = 'smarter_private.f06_movement_permits(uuid,uuid,bigint)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $decided_hand_preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'smarter_private.f06_movement_permits(uuid,uuid,bigint)'::regprocedure
       AND md5(pg_get_functiondef(oid)) = '2ddcf96913de8e87b858c1c207f57ed0'
       AND pg_get_userbyid(proowner) = 'postgres' AND prosecdef
       AND proacl::text = '{postgres=X/postgres}'
       AND proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']) THEN
    RAISE EXCEPTION 'F06_DECIDED_HAND_OWNER_DRIFT: f06_movement_permits';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'smarter_private.f06_hand_permits'::regclass
       AND conname = 'f06_hand_permits_state_check' AND convalidated
       AND pg_get_constraintdef(oid) = 'CHECK ((state = ANY (ARRAY[''reserved''::text, ''accepted''::text, ''never_started''::text, ''aborted_unsettled''::text])))') THEN
    RAISE EXCEPTION 'F06_DECIDED_HAND_STATES_DRIFT';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'smarter_private.f06_hand_permits'::regclass
       AND tgname = 'f06_hand_permits_immutable' AND tgenabled = 'O' AND NOT tgisinternal
       AND pg_get_triggerdef(oid) = 'CREATE TRIGGER f06_hand_permits_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity()') THEN
    RAISE EXCEPTION 'F06_DECIDED_HAND_IMMUTABILITY_DRIFT';
  END IF;
  IF position('F06_HAND_IDENTITY_IMMUTABLE' IN
       pg_get_functiondef('smarter_private.f06_immutable_identity()'::regprocedure)) = 0
     OR position('F06_ABORT_RECEIPT_REQUIRED' IN
       pg_get_functiondef('smarter_private.f06_immutable_identity()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'F06_DECIDED_HAND_IMMUTABILITY_DRIFT';
  END IF;
  IF position('F06_HAND_PERMIT_FENCED' IN
       pg_get_functiondef('smarter_private.f06_hand_dispatch_guard(uuid,bigint)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'F06_DECIDED_HAND_DISPATCH_FENCE_DRIFT';
  END IF;
END
$decided_hand_preflight$;

CREATE OR REPLACE FUNCTION smarter_private.f06_movement_permits(p_tournament uuid,p_table uuid,p_boundary bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE result jsonb;
BEGIN
 -- Every permit this table ever held must be DECIDED before its players move.
 -- accepted: its exact sealed commit, at or below the boundary. never_started
 -- and aborted_unsettled: decided not to count by a receipt, immutable, fenced
 -- from dispatch and history, and still visibly nothing of the hand on this
 -- table. 'reserved' is undecided and refuses; so does any dispatch.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h
 LEFT JOIN public.hand_atomic_commits a ON a.hand_id=h.evidence_id AND a.table_id=h.table_id AND a.hand_number=h.hand_number
 WHERE h.table_id=p_table AND (h.tournament_id IS DISTINCT FROM p_tournament
 OR NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=p_table AND t.f06_lifecycle=h.lifecycle)
 OR CASE
 WHEN h.state='accepted' THEN
 h.hand_number>p_boundary OR a.hand_id IS NULL OR a.post_commit_completed_at IS NULL
 OR NOT isfinite(a.post_commit_completed_at) OR a.post_commit_completed_at<a.committed_at
 OR a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR a.post_commit_result->>'hand_id' IS DISTINCT FROM a.hand_id::text
 OR (a.post_commit_result->>'hand_number')::bigint IS DISTINCT FROM a.hand_number
 WHEN h.state IN ('never_started','aborted_unsettled') THEN
 h.evidence_id IS NULL
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history x WHERE x.table_id=h.table_id AND x.hand_number=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state p WHERE p.table_id=h.table_id AND p.hand_number=h.hand_number)
 ELSE true END))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) WHERE h.table_id=p_table) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_UNRESOLVED_HAND_CUSTODY' USING ERRCODE='55000'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.hand_number,h.permit_id),'[]'::jsonb) INTO result
 FROM smarter_private.f06_hand_permits h WHERE h.table_id=p_table;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_movement_permits(uuid,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;

DO $decided_hand_readback$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'smarter_private.f06_movement_permits(uuid,uuid,bigint)'::regprocedure
       AND pg_get_userbyid(proowner) = 'postgres' AND prosecdef
       AND proacl::text = '{postgres=X/postgres}'
       AND proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
       AND position('never_started' IN prosrc) > 0) THEN
    RAISE EXCEPTION 'F06_DECIDED_HAND_READBACK';
  END IF;
END
$decided_hand_readback$;

COMMIT;
