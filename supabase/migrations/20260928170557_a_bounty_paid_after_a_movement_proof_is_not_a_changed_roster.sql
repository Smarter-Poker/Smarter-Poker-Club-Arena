-- 20260928170557_a_bounty_paid_after_a_movement_proof_is_not_a_changed_roster.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- CLAUDE.md 10.9 / 10.11 / 10.12: the reasoning is in this header. This file
-- changes ONE reader, smarter_private.f06_assert_movement. It schedules
-- nothing, retries nothing, writes no row and moves no chip.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS AND LOG LINES (2026-09-28)
--
-- 0733bfe8 "Sunday Funday High Roller PKO" has dealt nothing since 07:47 UTC:
-- two players, 9e5abf96 alone on table 60da314a and 7ffbf0aa alone on
-- 85ec8062. 60da314a is the park of break 528777f8 (park_requested, no
-- manifest), whose movement admission 6cd72e76 (generation 91032504) holds
-- the proof. Every successor re-admission carries that proof and is refused
-- by smarter_private.f06_assert_movement (69 times in 20 minutes):
--
--   [Tournament.table_engine_readmission_failed] Error:
--     f06_movement_admission_unproven [55000]: F06_MOVEMENT_ROSTER_CHANGED
--
-- The proof was captured at 07:54:43.326753. The proven hand (16451614,
-- committed 07:25:10.52) busted 8268d71c (BigReid, current_bounty 89.69) to
-- 9e5abf96. That PKO bounty was paid at 07:54:43.388863 - 62 ms AFTER the
-- proof - by chip_ledger 'bounty' 44.84 prize_liability -> player_wallet,
-- which also moved the registrations' bounty columns:
--
--   9e5abf96  current_bounty 601.58 -> 646.43, bounty_winnings 566.56 ->
--             611.40, bounties_collected 12 -> 13
--   8268d71c  current_bounty 89.69 -> 0
--
-- The assert compares the WHOLE registration row (to_jsonb) with the stored
-- copy, so those four bounty columns alone make the roster and elimination
-- comparisons false for ever. Measured against the live rows: seat rows
-- identical, stacks identical (1,760,286 and 0), status, table, seat number,
-- eliminated_at and every other registration column identical. No chip moved
-- on the felt; the bounty is paid from prize liability to the wallet and is
-- not movement evidence.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- In the roster comparison and the elimination comparison only, both sides'
-- registration objects drop exactly these four columns before comparing:
--   current_bounty, bounty_winnings, bounties_collected, mystery_bounty_value
-- Every seat column, every other registration column (chips, status,
-- table_id, seat_number, eliminated_at, rebuys, add_on, prize, position,
-- elimination_sequence, ...), every winner receipt, the boundary, the permits
-- and the whole-roster counts are compared exactly as before. A missing seat
-- or registration still refuses (jsonb_set of NULL is NULL, which is
-- distinct from the stored entry). Stored proofs are not rewritten.
--
-- Same signature, owner (postgres), ACL {postgres=X/postgres}, SECURITY
-- DEFINER, volatility and search_path. Restoring the two comparisons
-- reproduces the pre-image body digest exactly (asserted below).
--
-- PROVED FIRST (read-only, 2026-09-28 17:04 UTC): for admission 6cd72e76 the
-- installed comparisons are DISTINCT for the roster entry and the eliminated
-- entry, and the new comparisons are NOT DISTINCT for both.
--
-- RELEASE CONTRACT. f06_assert_movement is one of the functions in
-- fn_f06_mixed_custody_contract. MIXED_CUSTODY_CONTRACT in
-- server/scripts/engine-release-database-proof.py and
-- tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json carry
-- the post-image digests below, and the shared-hand lane installs this file on
-- its historical clone after 20260926043127 before comparing the catalogue.
--
-- Pinned by tests/a-bounty-paid-after-a-movement-proof-is-not-a-changed-roster.law.test.ts.
--
-- @live-proof: (SELECT md5(prosrc)='bbab37373518b7dcc520ae2bf3e5d1b5' AND md5(pg_get_functiondef(oid))='ad99e13122447e117d9769d28019cb7f' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_assert_movement(uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $movement_bounty_preimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'smarter_private.f06_assert_movement(uuid)'::regprocedure
       AND md5(prosrc) = '0cbea76808f835945a63f91f03e7d91c'
       AND md5(pg_get_functiondef(oid)) = '611ab479ccb52d5211145e8ffc0ec912'
       AND pg_get_userbyid(proowner) = 'postgres' AND prosecdef AND provolatile = 'v'
       AND proacl::text = '{postgres=X/postgres}'
       AND proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']) THEN
    RAISE EXCEPTION 'F06_MOVEMENT_BOUNTY_PREIMAGE_DRIFT: smarter_private.f06_assert_movement';
  END IF;
END
$movement_bounty_preimage$;

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
 IF jsonb_set(actual,'{registration}',(actual->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) THEN RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(a.proof->'eliminated') LOOP
 SELECT jsonb_build_object('seat',to_jsonb(s),'registration',to_jsonb(p),'accepted',r->'accepted') INTO actual
 FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=a.tournament_id AND p.user_id=s.user_id
 WHERE s.id=(r#>>'{seat,id}')::uuid AND s.table_id=a.table_id;
 IF jsonb_set(actual,'{registration}',(actual->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) THEN RAISE EXCEPTION 'F06_MOVEMENT_ELIMINATION_CHANGED' USING ERRCODE='55000'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.table_seats WHERE table_id=a.table_id AND left_at IS NULL)<>remaining
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=a.tournament_id AND table_id=a.table_id AND status IN ('playing','registered'))<>remaining THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' USING ERRCODE='55000'; END IF;
END $movement_proof$;
REVOKE ALL ON FUNCTION smarter_private.f06_assert_movement(uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $movement_bounty_postimage$
DECLARE
  body text;
BEGIN
  SELECT prosrc INTO body FROM pg_proc
   WHERE oid = 'smarter_private.f06_assert_movement(uuid)'::regprocedure
     AND md5(prosrc) = 'bbab37373518b7dcc520ae2bf3e5d1b5'
     AND md5(pg_get_functiondef(oid)) = 'ad99e13122447e117d9769d28019cb7f'
     AND pg_get_userbyid(proowner) = 'postgres' AND prosecdef AND provolatile = 'v'
     AND proacl::text = '{postgres=X/postgres}'
     AND proconfig = ARRAY['search_path=pg_catalog, public, smarter_private'];
  IF body IS NULL THEN
    RAISE EXCEPTION 'F06_MOVEMENT_BOUNTY_POSTIMAGE: smarter_private.f06_assert_movement';
  END IF;
  -- Only the two comparisons changed: restoring them yields the pre-image.
  IF md5(replace(replace(body,
       $r$ IF jsonb_set(actual,'{registration}',(actual->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) THEN RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;$r$,
       $r$ IF actual IS DISTINCT FROM r THEN RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;$r$),
       $r$ IF jsonb_set(actual,'{registration}',(actual->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) THEN RAISE EXCEPTION 'F06_MOVEMENT_ELIMINATION_CHANGED' USING ERRCODE='55000'; END IF;$r$,
       $r$ IF actual IS DISTINCT FROM r THEN RAISE EXCEPTION 'F06_MOVEMENT_ELIMINATION_CHANGED' USING ERRCODE='55000'; END IF;$r$)) <> '0cbea76808f835945a63f91f03e7d91c' THEN
    RAISE EXCEPTION 'F06_MOVEMENT_BOUNTY_POSTIMAGE: more than the two comparisons changed';
  END IF;
END
$movement_bounty_postimage$;

COMMIT;
