-- 20261002023035_a_mixed_admission_accepts_the_dispatch_its_disposed_original.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- CLAUDE.md 10.9 / 10.11 / 10.12: the reasoning is in this header. This file
-- changes ONE comparison in public.fn_f06_admit_mixed_manager_custody. It
-- schedules nothing, retries nothing, writes no row and moves no chip.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS AND LOG LINES (2026-10-02)
--
-- MTT 3414f268 "DSS Thursday $100 PLO4 Freeroll" (12 playing, 2 tables) and
-- SNG a59d7bbb "PLO4 Heads-Up 5 Turbo" (2 playing) have dealt nothing since
-- 23:15Z on 2026-10-01. At 23:15:36 / 23:15:39 the retiring manager prepared
-- mixed custody transfers d7812b54 and 011c1b2e while one original hand on
-- each event was IN DISPATCH: permit c6acd1b6 (table 29b907f4, hand 19918183)
-- and permit cbdcb98a (table 4afd01bb, hand 19918290). The snapshot recorded
-- each in canonical_proof.hand_dispatch ({"xid":...,"permit_id":...}) and,
-- because a dispatch row exists, gave the original no witness, so each
-- transfer lists one pending_original_table.
--
-- Both hands then finished: both permits are now 'accepted' with their
-- committed hand (post-commit complete), and their f06_hand_dispatch rows are
-- gone. That is the original's positive terminal disposition, the one legal
-- change before admission. But the admission compares the whole snapshot
-- minus only originals / original_evidence / pending_original_tables, and
-- hand_dispatch is part of it. The original's own dispatch row disappearing
-- makes it DISTINCT for ever, so every successor admission is refused:
--
--   postgres: F06_MIXED_CANONICAL_CHANGED (every ~5 min since 23:56Z)
--   engine:   [GameServer.Tournament_resume_failed_for_t] Error:
--             f06_mixed_successor_custody_unproven (mixedF06Custody.js:122)
--
-- While the dispatch row existed the same admission refused
-- F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED (pending non-empty), so a transfer
-- captured with an original in dispatch could never be admitted at all. The
-- unadmitted transfers also hold the engine's F06 preparation barrier
-- (f06_preparation_stuck), so the 00:55Z and 01:55Z maintenance breaks were
-- not certified and engine releases are blocked.
--
-- Read-only, every other snapshot key of both transfers (operations, members,
-- attempts, move_receipts, move_dispatch, prepared_cancellations, tables,
-- seats, registrations, presence, no_start_continuations, engine_lifecycles)
-- equals the live rows exactly; only hand_dispatch differs, and only by the
-- originals' own rows.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- hand_dispatch joins the keys the whole-snapshot comparison leaves out, and
-- is compared on its own WITHOUT the rows whose permit_id is one of this
-- transfer's bound originals (local_proof.engines[].permit.binding.permit_id).
-- Every other dispatch row is compared exactly as before. An original's
-- dispatch row is not lost: the snapshot still gives an original with a
-- dispatch row no witness, so it stays in pending_original_tables and the
-- admission still refuses F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED until the
-- original is terminal. Every other key is compared exactly as before.
--
-- Same signature, owner (postgres), ACL
-- {postgres=X/postgres,service_role=X/postgres}, SECURITY DEFINER, volatility
-- and search_path. Restoring the one comparison reproduces the pre-image body
-- digest exactly (asserted below).
--
-- RELEASE CONTRACT. fn_f06_admit_mixed_manager_custody is one of the functions
-- in fn_f06_mixed_custody_contract. MIXED_CUSTODY_CONTRACT in
-- server/scripts/engine-release-database-proof.py and
-- tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json carry
-- the post-image digests below, and the shared-hand lane installs this file on
-- its historical clone after 20261001151056 before comparing the catalogue.
--
-- Pinned by tests/a-mixed-admission-accepts-the-dispatch-its-disposed-original-left-behind.law.test.ts.
--
-- @live-proof: (SELECT md5(prosrc)='70ec2492f10256458996947f4e7be51f' AND md5(pg_get_functiondef(oid))='1468813b11c2d5f8560e3a4e29bc3a91' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $admit_dispatch_preimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb)'::regprocedure
       AND md5(p.prosrc) = 'aeaabb44975b8d138ed447687b0aea22'
       AND md5(pg_get_functiondef(p.oid)) = '3b047e7502c62bff570cd6253e85a741'
       AND pg_get_userbyid(p.proowner) = 'postgres' AND p.prosecdef AND p.provolatile = 'v'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']) THEN
    RAISE EXCEPTION 'F06_ADMIT_DISPATCH_PREIMAGE_DRIFT: public.fn_f06_admit_mixed_manager_custody';
  END IF;
END
$admit_dispatch_preimage$;

CREATE OR REPLACE FUNCTION public.fn_f06_admit_mixed_manager_custody(p_tournament_id uuid, p_lease_generation uuid, p_transfer_id uuid, p_expected jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE prior smarter_private.f06_manager_custody_transfers; canonical jsonb; a smarter_private.f06_manager_custody_admissions; l jsonb;
BEGIN
 PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation);
 PERFORM smarter_private.f06_try_lane(p_tournament_id);
 PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation,false);
 SELECT * INTO prior FROM smarter_private.f06_manager_custody_transfers WHERE transfer_id=p_transfer_id FOR SHARE;
 IF NOT FOUND OR prior.tournament_id IS DISTINCT FROM p_tournament_id OR prior.successor_generation IS DISTINCT FROM p_lease_generation
 OR to_jsonb(prior) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_MIXED_SUCCESSOR_CHANGED'; END IF;
 SELECT * INTO a FROM smarter_private.f06_manager_custody_admissions WHERE transfer_id=p_transfer_id;
 IF FOUND THEN
 PERFORM smarter_private.f06_mixed_current_admission(p_tournament_id,p_lease_generation,p_transfer_id);
 ELSE
 canonical:=smarter_private.f06_mixed_custody_snapshot(p_tournament_id,prior.origin_generation,prior.local_proof);
 -- The only legal change before admission is an original's positive terminal
 -- disposition. The original bindings and all operation/seat vectors stay exact.
 IF canonical-ARRAY['originals','original_evidence','pending_original_tables','hand_dispatch'] IS DISTINCT FROM
 prior.canonical_proof-ARRAY['originals','original_evidence','pending_original_tables','hand_dispatch']
 OR (SELECT COALESCE(jsonb_agg(d ORDER BY n),'[]') FROM jsonb_array_elements(canonical->'hand_dispatch') WITH ORDINALITY x(d,n) WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prior.local_proof->'engines') e WHERE e#>>'{permit,binding,permit_id}'=d->>'permit_id')) IS DISTINCT FROM
 (SELECT COALESCE(jsonb_agg(d ORDER BY n),'[]') FROM jsonb_array_elements(prior.canonical_proof->'hand_dispatch') WITH ORDINALITY x(d,n) WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prior.local_proof->'engines') e WHERE e#>>'{permit,binding,permit_id}'=d->>'permit_id')) THEN RAISE EXCEPTION 'F06_MIXED_CANONICAL_CHANGED'; END IF;
 IF canonical->'pending_original_tables' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED'; END IF;
 SELECT to_jsonb(e)-'heartbeat_at' INTO l FROM public.engine_tournament_leases e WHERE tournament_id=p_tournament_id;
 INSERT INTO smarter_private.f06_manager_custody_admissions(transfer_id,tournament_id,generation,lease_identity,terminal_proof)
 VALUES(p_transfer_id,p_tournament_id,p_lease_generation,l,canonical->'original_evidence') RETURNING * INTO a;
 END IF;
 RETURN jsonb_build_object('ok',true,'custody_only',true,'transfer_id',p_transfer_id,'tournament_id',p_tournament_id,
 'lease_generation',p_lease_generation,'receipt',to_jsonb(prior),'admission',to_jsonb(a));
END $function$;

REVOKE ALL ON FUNCTION public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb) TO service_role;

DO $admit_dispatch_postimage$
DECLARE
  body text;
BEGIN
  SELECT p.prosrc INTO body FROM pg_proc p
   WHERE p.oid = 'public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb)'::regprocedure
     AND md5(p.prosrc) = '70ec2492f10256458996947f4e7be51f'
     AND md5(pg_get_functiondef(p.oid)) = '1468813b11c2d5f8560e3a4e29bc3a91'
     AND pg_get_userbyid(p.proowner) = 'postgres' AND p.prosecdef AND p.provolatile = 'v'
     AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
     AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private'];
  IF body IS NULL THEN
    RAISE EXCEPTION 'F06_ADMIT_DISPATCH_POSTIMAGE: public.fn_f06_admit_mixed_manager_custody';
  END IF;
  -- Only the one comparison changed: restoring it yields the pre-image.
  IF md5(replace(body,
       $r$ IF canonical-ARRAY['originals','original_evidence','pending_original_tables','hand_dispatch'] IS DISTINCT FROM
 prior.canonical_proof-ARRAY['originals','original_evidence','pending_original_tables','hand_dispatch']
 OR (SELECT COALESCE(jsonb_agg(d ORDER BY n),'[]') FROM jsonb_array_elements(canonical->'hand_dispatch') WITH ORDINALITY x(d,n) WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prior.local_proof->'engines') e WHERE e#>>'{permit,binding,permit_id}'=d->>'permit_id')) IS DISTINCT FROM
 (SELECT COALESCE(jsonb_agg(d ORDER BY n),'[]') FROM jsonb_array_elements(prior.canonical_proof->'hand_dispatch') WITH ORDINALITY x(d,n) WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prior.local_proof->'engines') e WHERE e#>>'{permit,binding,permit_id}'=d->>'permit_id')) THEN RAISE EXCEPTION 'F06_MIXED_CANONICAL_CHANGED'; END IF;$r$,
       $r$ IF canonical-ARRAY['originals','original_evidence','pending_original_tables'] IS DISTINCT FROM
 prior.canonical_proof-ARRAY['originals','original_evidence','pending_original_tables'] THEN RAISE EXCEPTION 'F06_MIXED_CANONICAL_CHANGED'; END IF;$r$)) <> 'aeaabb44975b8d138ed447687b0aea22' THEN
    RAISE EXCEPTION 'F06_ADMIT_DISPATCH_POSTIMAGE: more than the one comparison changed';
  END IF;
END
$admit_dispatch_postimage$;

COMMIT;
