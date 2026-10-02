-- 20261002055945_an_add_on_bought_after_a_movement_proof_is_not_a_changed_ros.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- CLAUDE.md 10.9 / 10.11 / 10.12: the reasoning is in this header. This file
-- changes ONE reader, smarter_private.f06_assert_movement. It schedules
-- nothing, retries nothing, writes no row and moves no chip.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS AND LOG LINES (2026-10-02 ~05:55 UTC)
--
-- f8c6f298 (11 playing, level 16) has dealt nothing on table 199a1efc since
-- 04:51 UTC. 199a1efc is the source of park 7ef06537 (park_requested, no
-- manifest); its movement admission (custody 7fb81c0d, generation 4b949b25)
-- took the proof at 04:57:09, during the add-on break. Every begin and every
-- successor re-admission since is refused by f06_assert_movement:
--
--   [Tournament.break_recovery_unresolved] Error:
--     F06 fn_f06_begin_break outcome unproven: F06_MOVEMENT_ROSTER_CHANGED
--   [Tournament.f8c6f298.resume_table_error] Error:
--     f06_movement_admission_unproven [55000]: F06_MOVEMENT_ROSTER_CHANGED
--
-- Measured against the live rows: of the nine roster entries, eight are
-- identical. The ninth, 1c7fc49a, bought the event's add-on after the proof
-- (the add-on period ended at 05:06): seat stack 2755.00 -> 5255.00,
-- registration chips 2755 -> 5255, add_on false -> true. The event's
-- addon_chips is 2500. Nothing else on the seat or registration moved. The
-- proof is immutable, so the assert refused it for ever and nine players sat
-- frozen behind a park that could never begin.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- The roster comparison admits exactly one more shape: the proof's
-- registration says add_on = false, the live one says add_on = true, the
-- event's addon_chips is positive, and subtracting addon_chips from the live
-- seat stack and registration chips (and restoring add_on = false) gives the
-- stored entry exactly, every other column compared as before. The winner
-- comparison admits a move receipt whose stack is the proof stack plus
-- addon_chips only for a member whose registration now says add_on = true
-- and whose proof said false. Any other difference still refuses; the
-- boundary, permits, eliminations and whole-roster counts are unchanged.
-- Stored proofs are not rewritten. The same exact-add-on shape was admitted
-- for the abandoned-generation door by 20260922132318.
--
-- Same signature, owner (postgres), ACL {postgres=X/postgres}, SECURITY
-- DEFINER, volatility and search_path. Restoring the four passages
-- reproduces the pre-image body digest exactly (asserted below).
--
-- PROVED FIRST (read-only, 2026-10-02 06:00 UTC): for break 7ef06537 the
-- installed roster comparison is DISTINCT for 1c7fc49a only, and the
-- add-on-credited comparison is NOT DISTINCT for it.
--
-- RELEASE CONTRACT. f06_assert_movement is one of the functions in
-- fn_f06_mixed_custody_contract. MIXED_CUSTODY_CONTRACT in
-- server/scripts/engine-release-database-proof.py and
-- tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json carry
-- the post-image digests below, and the shared-hand lane installs this file on
-- its historical clone after 20261001151056.
--
-- Pinned by tests/an-add-on-bought-after-a-movement-proof-is-not-a-changed-roster.law.test.ts.

-- @live-proof: (SELECT md5(prosrc)='a0e369a33e735ba728b72228a3134b01' AND md5(pg_get_functiondef(oid))='e3355bb05eecda8aed293f155f1ddfef' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_assert_movement(uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $addon_assert_preimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('smarter_private.f06_assert_movement(uuid)')
       AND md5(p.prosrc) = 'df656e0490a6a8f570f409916fc2f643'
       AND md5(pg_get_functiondef(p.oid)) = '6fd0cf3d598211408d165117fd8c32fe'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
       AND p.prosecdef AND p.provolatile = 'v'
       AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')) THEN
    RAISE EXCEPTION 'F06_MOVEMENT_ADDON_PREIMAGE_DRIFT: smarter_private.f06_assert_movement(uuid)';
  END IF;
END
$addon_assert_preimage$;

CREATE OR REPLACE FUNCTION smarter_private.f06_assert_movement(p_break uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $movement_proof$
DECLARE a smarter_private.f06_movement_admissions; o smarter_private.f06_operations;
 r jsonb; actual jsonb; winner jsonb; movement public.tournament_seat_move_receipts; remaining integer:=0; mixed_generation uuid;
 g uuid:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
 -- An add-on the player bought while the park waited (2026-10-02): its chips
 -- are the event's addon_chips, and its registration says add_on.
 addon numeric:=0; credited jsonb; strip text[]:='{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}';
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
 -- A never-dealt park's proof (f06_movement_never_dealt_prior) names no hand:
 -- its boundary holds while nothing of any hand exists on the table.
 IF a.proof->'first_hand'='true'::jsonb THEN
 IF a.proof->'atomic' IS DISTINCT FROM 'null'::jsonb OR a.proof->'history' IS DISTINCT FROM 'null'::jsonb
 OR a.proof->'permits' IS DISTINCT FROM '[]'::jsonb
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=a.table_id AND tournament_id=a.tournament_id AND f06_lifecycle=a.lifecycle)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=a.table_id) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=a.table_id AND tournament_id=a.tournament_id AND f06_lifecycle=a.lifecycle)
 OR smarter_private.f06_movement_permits(a.tournament_id,a.table_id,(a.proof#>>'{atomic,hand_number}')::bigint) IS DISTINCT FROM a.proof->'permits'
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=a.table_id AND NOT is_complete)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=a.table_id AND hand_number>(a.proof#>>'{atomic,hand_number}')::bigint)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=a.table_id AND hand_number>(a.proof#>>'{atomic,hand_number}')::bigint)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=a.table_id AND (hand_number>(a.proof#>>'{atomic,hand_number}')::bigint OR committed_at>(a.proof#>>'{atomic,committed_at}')::timestamptz))
 OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits x WHERE hand_id=(a.proof#>>'{atomic,hand_id}')::uuid AND (SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c WHERE a.proof->'atomic' ? c.key OR c.value<>'null'::jsonb)=a.proof->'atomic')
 OR NOT EXISTS(SELECT 1 FROM public.hand_history x WHERE id=(a.proof#>>'{history,id}')::uuid AND (SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c WHERE a.proof->'history' ? c.key OR c.value<>'null'::jsonb)=a.proof->'history') THEN
 RAISE EXCEPTION 'F06_MOVEMENT_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 SELECT COALESCE(t.addon_chips,0) INTO addon FROM public.tournaments t WHERE t.id=a.tournament_id;
 addon:=COALESCE(addon,0);
 FOR r IN SELECT value FROM jsonb_array_elements(a.proof->'roster') LOOP
 SELECT d.receipt INTO winner FROM smarter_private.f06_attempts d JOIN public.tournament_seat_move_receipts m ON m.request_id=d.request_id
 WHERE d.break_id=p_break AND d.user_id=(r#>>'{seat,user_id}')::uuid AND d.state='winner';
 IF FOUND THEN
 SELECT * INTO movement FROM public.tournament_seat_move_receipts WHERE request_id=(winner->>'request_id')::uuid;
 IF NOT FOUND OR winner-'source_occupancy_id'-'source_lifecycle'-'break_id' IS DISTINCT FROM to_jsonb(movement)
 OR (winner->>'source_table_id')::uuid IS DISTINCT FROM a.table_id OR (winner->>'source_seat_id')::uuid IS DISTINCT FROM (r#>>'{seat,id}')::uuid
 OR (winner->>'source_occupancy_id')::uuid IS DISTINCT FROM (r#>>'{seat,occupancy_id}')::uuid
 OR ((winner->>'stack')::numeric IS DISTINCT FROM (r#>>'{seat,stack}')::numeric
 AND NOT (addon>0 AND r#>'{registration,add_on}'='false'::jsonb
 AND (winner->>'stack')::numeric=(r#>>'{seat,stack}')::numeric+addon
 AND EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=a.tournament_id AND p.user_id=(r#>>'{seat,user_id}')::uuid AND p.add_on IS TRUE)))
 OR (winner->>'break_id')::uuid IS DISTINCT FROM p_break
 OR (winner->>'source_lifecycle')::bigint IS DISTINCT FROM a.lifecycle THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WINNER_CHANGED' USING ERRCODE='55000'; END IF;
 ELSE
 remaining:=remaining+1;
 SELECT jsonb_build_object('seat',to_jsonb(s),'registration',to_jsonb(p)) INTO actual
 FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=a.tournament_id AND p.user_id=s.user_id
 WHERE s.id=(r#>>'{seat,id}')::uuid AND s.table_id=a.table_id AND s.left_at IS NULL;
 credited:=CASE WHEN addon>0 AND r#>'{registration,add_on}'='false'::jsonb AND actual#>'{registration,add_on}'='true'::jsonb
 THEN jsonb_set(jsonb_set(jsonb_set(actual,'{seat,stack}',to_jsonb((actual#>>'{seat,stack}')::numeric-addon)),
 '{registration,chips}',to_jsonb((actual#>>'{registration,chips}')::numeric-addon)),'{registration,add_on}','false'::jsonb) END;
 IF jsonb_set(actual,'{registration}',(actual->'registration')-strip) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-strip)
 AND (credited IS NULL OR jsonb_set(credited,'{registration}',(credited->'registration')-strip) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-strip)) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
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

DO $addon_assert_postimage$
DECLARE body text;
BEGIN
  SELECT p.prosrc INTO body FROM pg_proc p
   WHERE p.oid = 'smarter_private.f06_assert_movement(uuid)'::regprocedure
     AND md5(p.prosrc) = 'a0e369a33e735ba728b72228a3134b01'
     AND md5(pg_get_functiondef(p.oid)) = 'e3355bb05eecda8aed293f155f1ddfef'
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND p.proacl::text = '{postgres=X/postgres}'
     AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
     AND p.prosecdef AND p.provolatile = 'v';
  IF body IS NULL THEN
    RAISE EXCEPTION 'F06_MOVEMENT_ADDON_POSTIMAGE_DRIFT: smarter_private.f06_assert_movement(uuid)';
  END IF;
  -- Only the four stated passages changed: restoring them reproduces the
  -- pre-image byte for byte.
  IF md5(replace(replace(replace(replace(body,
       $r$ -- An add-on the player bought while the park waited (2026-10-02): its chips
 -- are the event's addon_chips, and its registration says add_on.
 addon numeric:=0; credited jsonb; strip text[]:='{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}';
$r$, ''),
       $r$ SELECT COALESCE(t.addon_chips,0) INTO addon FROM public.tournaments t WHERE t.id=a.tournament_id;
 addon:=COALESCE(addon,0);
$r$, ''),
       $r$ OR ((winner->>'stack')::numeric IS DISTINCT FROM (r#>>'{seat,stack}')::numeric
 AND NOT (addon>0 AND r#>'{registration,add_on}'='false'::jsonb
 AND (winner->>'stack')::numeric=(r#>>'{seat,stack}')::numeric+addon
 AND EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=a.tournament_id AND p.user_id=(r#>>'{seat,user_id}')::uuid AND p.add_on IS TRUE)))
 OR (winner->>'break_id')::uuid IS DISTINCT FROM p_break
$r$, $r$ OR (winner->>'stack')::numeric IS DISTINCT FROM (r#>>'{seat,stack}')::numeric OR (winner->>'break_id')::uuid IS DISTINCT FROM p_break
$r$),
       $r$ credited:=CASE WHEN addon>0 AND r#>'{registration,add_on}'='false'::jsonb AND actual#>'{registration,add_on}'='true'::jsonb
 THEN jsonb_set(jsonb_set(jsonb_set(actual,'{seat,stack}',to_jsonb((actual#>>'{seat,stack}')::numeric-addon)),
 '{registration,chips}',to_jsonb((actual#>>'{registration,chips}')::numeric-addon)),'{registration,add_on}','false'::jsonb) END;
 IF jsonb_set(actual,'{registration}',(actual->'registration')-strip) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-strip)
 AND (credited IS NULL OR jsonb_set(credited,'{registration}',(credited->'registration')-strip) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-strip)) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
$r$, $r$ IF jsonb_set(actual,'{registration}',(actual->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) THEN RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
$r$)) <> 'df656e0490a6a8f570f409916fc2f643' THEN
    RAISE EXCEPTION 'F06_MOVEMENT_ADDON_POSTIMAGE_DRIFT: more than the stated passages of f06_assert_movement changed';
  END IF;
END
$addon_assert_postimage$;

COMMIT;
