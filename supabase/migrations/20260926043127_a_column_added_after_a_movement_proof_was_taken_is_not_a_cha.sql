-- 20260926043127_a_column_added_after_a_movement_proof_was_taken_is_not_a_cha
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- CLAUDE.md 10.12: this file changes one reader. It schedules nothing, retries
-- nothing, writes no row and moves no chip.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- A parked tournament table (a table break's source, excluded from dealing)
-- is re-admitted after an engine restart through fn_f06_admit_parked_movement.
-- The successor carries the ORIGINAL movement proof, the immutable
-- smarter_private.f06_movement_admissions.proof captured when the park was
-- first admitted, and smarter_private.f06_assert_movement re-proves it against
-- the live rows. The same assert guards every seat move out of the table
-- (f06_movement_transition_guard) and drained manager custody.
--
-- Two of its checks compare a whole sealed row to the stored copy:
--
--   to_jsonb(hand_atomic_commits row) = proof->'atomic'
--   to_jsonb(hand_history row)        = proof->'history'
--
-- to_jsonb carries every COLUMN of the table. Migration 20260924034010 (kill
-- pot table settings) ran
--
--   ALTER TABLE public.hand_history ADD COLUMN kill_pot jsonb NULL
--
-- so every hand_history row now has a "kill_pot": null key that no proof
-- captured before 2026-09-24 contains. For every such proof the comparison is
-- false for ever, the assert raises F06_MOVEMENT_BOUNDARY_CHANGED, the engine
-- logs f06_movement_admission_unproven every fifteen seconds, and nothing can
-- move the table's players. The table stays parked, and its event stays RUNNING
-- and deals nothing.
--
-- MEASURED 2026-09-26 04:10-04:40 UTC, read-only against production:
--
--   parked sources of RUNNING events whose     78 on open tables; 40 of them
--   current custody holds a movement proof     (12 events, proofs taken
--                                              2026-09-18 and 2026-09-22) fail
--   Postgres log, one hour                     F06_MOVEMENT_BOUNDARY_CHANGED
--                                              raised 5,365 times, all from
--                                              f06_assert_movement line 24
--   those 40 proofs against the live rows      exactly ONE key differs on the
--                                              history row, kill_pot, absent
--                                              from the proof, null live, on
--                                              all 40; the atomic row, the
--                                              permits, the snapshots, every
--                                              later hand check, every roster
--                                              seat and registration, every
--                                              winner receipt, every
--                                              elimination and the whole-roster
--                                              counts are identical
--   hand_history.kill_pot                      null on all 2,238,919 rows
--   the 38 proofs taken after the column       pass unchanged
--
-- So every chip is exactly where each proof says it is: the remaining seats
-- and registrations are byte-identical to the proof, and each player already
-- moved is named by an intact winner receipt at its proven stack.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- One function, the same signature, owner, ACL, SECURITY DEFINER, volatility
-- and search_path. In those two comparisons only, the live row is compared
-- after dropping each key that is ABSENT from the stored proof AND whose live
-- value is JSON null:
--
--   (SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c
--     WHERE a.proof->'history' ? c.key OR c.value<>'null'::jsonb)
--   = a.proof->'history'
--
-- Why that is exactly what the proof needs. to_jsonb emits every column,
-- nulls included, so a key absent from a stored proof is a column that did
-- not exist when the proof was taken. Null in it now means nothing has been
-- recorded there for this hand. Every fact the proof sealed must still be
-- present with its identical value.
--
-- Still refused, exactly as before:
--   - any proven column whose value changed, or that became null;
--   - any proven column that is gone;
--   - an added column holding ANY non-null value, including false, 0 or {}
--     (a column added with a non-null default refuses, because a default
--     cannot be told apart from a written value);
--   - every other check in the function, byte for byte.
--
-- The post-image proves that putting the two strict comparisons back
-- reproduces the pre-image body digest exactly, so nothing else moved.
--
-- NOT TOUCHED: fn_f06_admit_parked_movement, f06_movement_prior (a new proof
-- is still taken from the whole live row), f06_movement_permits, every roster,
-- stack, winner, elimination and custody check, the stored proofs, the
-- operations and every lease.
--
-- ACL. This is a postgres-only private helper ({postgres=X/postgres}), and
-- CREATE OR REPLACE keeps it. The REVOKE below names service_role explicitly
-- so that no default privilege can widen it. The post-image asserts the exact
-- ACL. Granting service_role here would widen a private function and break the
-- pinned mixed-custody contract.
--
-- RELEASE CONTRACT. f06_assert_movement is one of the 29 functions in
-- fn_f06_mixed_custody_contract. MIXED_CUSTODY_CONTRACT in
-- server/scripts/engine-release-database-proof.py and
-- tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json carry
-- the post-image digests below, and the shared-hand lane installs this file on
-- its historical clone before comparing the catalogue.
--
-- @live-proof: (SELECT md5(prosrc)='0cbea76808f835945a63f91f03e7d91c' AND md5(pg_get_functiondef(oid))='611ab479ccb52d5211145e8ffc0ec912' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_assert_movement(uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $movement_proof_preimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'smarter_private.f06_assert_movement(uuid)'::regprocedure
       AND md5(prosrc) = '1bc767e267e5b90534c601c39f2790a0'
       AND md5(pg_get_functiondef(oid)) = '7f10809c0e6ce2819c97c2ab53b95fba'
       AND pg_get_userbyid(proowner) = 'postgres' AND prosecdef AND provolatile = 'v'
       AND proacl::text = '{postgres=X/postgres}'
       AND proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']) THEN
    RAISE EXCEPTION 'F06_MOVEMENT_PROOF_PREIMAGE_DRIFT: smarter_private.f06_assert_movement';
  END IF;
END
$movement_proof_preimage$;

CREATE OR REPLACE FUNCTION smarter_private.f06_assert_movement(p_break uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $movement_proof$
DECLARE a smarter_private.f06_movement_admissions; o smarter_private.f06_operations;
 r jsonb; actual jsonb; winner jsonb; movement public.tournament_seat_move_receipts; remaining integer:=0; mixed_generation uuid;
 g uuid:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
BEGIN
 mixed_generation:=smarter_private.f06_mixed_movement_generation(p_break);
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions WHERE break_id=p_break) THEN RETURN; END IF;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break;
 SELECT * INTO a FROM smarter_private.f06_movement_admissions WHERE break_id=p_break AND custody_id=o.custody_id;
 IF NOT FOUND OR o.custody_generation IS DISTINCT FROM a.lease_generation OR o.revision IS DISTINCT FROM a.revision
 OR o.lifecycle IS DISTINCT FROM a.lifecycle OR o.source_table_id IS DISTINCT FROM a.table_id
 OR o.tournament_id IS DISTINCT FROM a.tournament_id OR (g IS DISTINCT FROM a.lease_generation AND g IS DISTINCT FROM mixed_generation)
 OR o.state NOT IN ('park_requested','begun','close_confirmed') THEN
 RAISE EXCEPTION 'F06_MOVEMENT_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_authority(a.tournament_id,COALESCE(mixed_generation,a.lease_generation),false);
 IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=a.table_id AND tournament_id=a.tournament_id AND f06_lifecycle=a.lifecycle)
 OR smarter_private.f06_movement_permits(a.tournament_id,a.table_id,(a.proof#>>'{atomic,hand_number}')::bigint) IS DISTINCT FROM a.proof->'permits'
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=a.table_id AND NOT is_complete)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=a.table_id AND hand_number>(a.proof#>>'{atomic,hand_number}')::bigint)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=a.table_id AND hand_number>(a.proof#>>'{atomic,hand_number}')::bigint)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=a.table_id AND (hand_number>(a.proof#>>'{atomic,hand_number}')::bigint OR committed_at>(a.proof#>>'{atomic,committed_at}')::timestamptz))
 OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits x WHERE hand_id=(a.proof#>>'{atomic,hand_id}')::uuid AND (SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c WHERE a.proof->'atomic' ? c.key OR c.value<>'null'::jsonb)=a.proof->'atomic')
 OR NOT EXISTS(SELECT 1 FROM public.hand_history x WHERE id=(a.proof#>>'{history,id}')::uuid AND (SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c WHERE a.proof->'history' ? c.key OR c.value<>'null'::jsonb)=a.proof->'history') THEN
 RAISE EXCEPTION 'F06_MOVEMENT_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(a.proof->'roster') LOOP
 SELECT d.receipt INTO winner FROM smarter_private.f06_attempts d JOIN public.tournament_seat_move_receipts m ON m.request_id=d.request_id
 WHERE d.break_id=p_break AND d.user_id=(r#>>'{seat,user_id}')::uuid AND d.state='winner';
 IF FOUND THEN
 SELECT * INTO movement FROM public.tournament_seat_move_receipts WHERE request_id=(winner->>'request_id')::uuid;
 IF NOT FOUND OR winner-'source_occupancy_id'-'source_lifecycle'-'break_id' IS DISTINCT FROM to_jsonb(movement)
 OR (winner->>'source_table_id')::uuid IS DISTINCT FROM a.table_id OR (winner->>'source_seat_id')::uuid IS DISTINCT FROM (r#>>'{seat,id}')::uuid
 OR (winner->>'source_occupancy_id')::uuid IS DISTINCT FROM (r#>>'{seat,occupancy_id}')::uuid
 OR (winner->>'stack')::numeric IS DISTINCT FROM (r#>>'{seat,stack}')::numeric OR (winner->>'break_id')::uuid IS DISTINCT FROM p_break
 OR (winner->>'source_lifecycle')::bigint IS DISTINCT FROM a.lifecycle THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WINNER_CHANGED' USING ERRCODE='55000'; END IF;
 ELSE
 remaining:=remaining+1;
 SELECT jsonb_build_object('seat',to_jsonb(s),'registration',to_jsonb(p)) INTO actual
 FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=a.tournament_id AND p.user_id=s.user_id
 WHERE s.id=(r#>>'{seat,id}')::uuid AND s.table_id=a.table_id AND s.left_at IS NULL;
 IF actual IS DISTINCT FROM r THEN RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(a.proof->'eliminated') LOOP
 SELECT jsonb_build_object('seat',to_jsonb(s),'registration',to_jsonb(p),'accepted',r->'accepted') INTO actual
 FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=a.tournament_id AND p.user_id=s.user_id
 WHERE s.id=(r#>>'{seat,id}')::uuid AND s.table_id=a.table_id;
 IF actual IS DISTINCT FROM r THEN RAISE EXCEPTION 'F06_MOVEMENT_ELIMINATION_CHANGED' USING ERRCODE='55000'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.table_seats WHERE table_id=a.table_id AND left_at IS NULL)<>remaining
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=a.tournament_id AND table_id=a.table_id AND status IN ('playing','registered'))<>remaining THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' USING ERRCODE='55000'; END IF;
END $movement_proof$;
REVOKE ALL ON FUNCTION smarter_private.f06_assert_movement(uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $movement_proof_postimage$
DECLARE
  body text;
BEGIN
  SELECT prosrc INTO body FROM pg_proc
   WHERE oid = 'smarter_private.f06_assert_movement(uuid)'::regprocedure
     AND md5(prosrc) = '0cbea76808f835945a63f91f03e7d91c'
     AND md5(pg_get_functiondef(oid)) = '611ab479ccb52d5211145e8ffc0ec912'
     AND pg_get_userbyid(proowner) = 'postgres' AND prosecdef AND provolatile = 'v'
     AND proacl::text = '{postgres=X/postgres}'
     AND proconfig = ARRAY['search_path=pg_catalog, public, smarter_private'];
  IF body IS NULL THEN
    RAISE EXCEPTION 'F06_MOVEMENT_PROOF_POSTIMAGE: smarter_private.f06_assert_movement';
  END IF;
  -- Only the two comparisons changed: restoring them yields the pre-image.
  IF md5(replace(replace(body,
       $r$(SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c WHERE a.proof->'atomic' ? c.key OR c.value<>'null'::jsonb)=a.proof->'atomic'$r$,
       $r$to_jsonb(x)=a.proof->'atomic'$r$),
       $r$(SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c WHERE a.proof->'history' ? c.key OR c.value<>'null'::jsonb)=a.proof->'history'$r$,
       $r$to_jsonb(x)=a.proof->'history'$r$)) <> '1bc767e267e5b90534c601c39f2790a0' THEN
    RAISE EXCEPTION 'F06_MOVEMENT_PROOF_POSTIMAGE: more than the two comparisons changed';
  END IF;
END
$movement_proof_postimage$;

COMMIT;
