-- 20260921155216_the_mixed_custody_prepare_accepts_the_legacy_checkpoint_rese.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)
-- is the custody RPC the 8825 legacy checkpoint calls, twice per tournament,
-- from legacy-engine-checkpoint-guard.mjs (its mixed_custody stage: one
-- observation with p_expected NULL, then the commit with the observed
-- canonical). In its release_checkpoint branch the installed body refuses,
-- F06_MIXED_FROZEN_CHECKPOINT_UNPROVEN, unless at the instant of EVERY call
--
--     break_ends_at - clock_timestamp() >= interval '285 seconds'
--
-- The engine's break countdown is 300,000 ms. The release transaction admits
-- the legacy checkpoint only while >= 285,000 ms remain (its entry slack), so
-- the sequence starts with at most 15 s already spent; run 35615604946 measured
-- 15.2 s of countdown detection, rollback proof and helper preamble before the
-- first table was touched. A predicate that demands the full 285 s at each RPC
-- instant, after the entry slack has been consumed, cannot be satisfied: the
-- database side of the 8825 profile refused structurally, every time.
--
-- Commit 5cf1486c moved the process side to a figure that fits and wrote the
-- derivation into engine-release-transaction.sh; the reconciliation with
-- PR #5026 (the deferral) re-derived it from what the transaction ACTUALLY
-- pays after the admission, entry included:
--
--     285 s entry threshold          (MIN_BREAK_REMAINING_MS, unchanged)
--   -  40 s checkpoint budget         (~15 s measured entry: countdown
--                                      detection, rollback proof, helper
--                                      preamble, intent write and guard boot;
--                                      + 20 s bounded work + 5 s cleanup)
--   = 245 s  LEGACY_MIN_BREAK_REMAINING_MS = reserveMs in the guard
--
-- 245,000 - 135,000 ms rollback reserve = 110,000 ms of candidate proof,
-- against 51-112 s measured in sealed runs: a proof at the top of that range
-- now rolls back inside the untouched reserve instead of sealing. The 135 s
-- rollback reserve is not touched here or there; the strict 285,000 ms entry
-- check, every ordinary release, the certificate's readiness predicates and
-- the one-shot rule all keep their figures. (The first cut of this file
-- carried 260 s, budgeting only the publisher's 25 s and leaving the ~15 s
-- entry to fit inside the 15 s the break has above 285 s; never installed.)
--
-- This migration moves the ONE remaining 285-second pin, the one in the
-- database, to the same 245 seconds. It is the only interval literal in the
-- function; nothing else in the body moves, and the post-image proves it:
-- putting '285 seconds' back into the installed text must reproduce the
-- pre-image digest exactly. Every other function that carries the predicate
-- (20260918232558, 20260919024642, 20260919032212) is an earlier version of
-- this same function, already replaced in production by 20260919033536; no
-- other function in the release path pins 285 s on the database side.
--
-- THE TEXT IS THE INSTALLED TEXT. The CREATE OR REPLACE below is the byte-exact
-- statement from 20260919033536 (body md5 3f78b42bcc2455701322b172ab7d42ff,
-- definition md5 ca0446a62e08d49c2d318072cf465176 as production reports them),
-- extracted programmatically, with exactly that one literal changed. Same
-- header: SECURITY DEFINER, search_path=pg_catalog,public,smarter_private,
-- VOLATILE, owner postgres, ACL {postgres=X/postgres,service_role=X/postgres};
-- CREATE OR REPLACE preserves owner and ACL, and both DO blocks refuse if any
-- of them is not what production holds.
--
-- POST-IMAGE (computed on PostgreSQL 17.11 from the same text; the pre-image
-- digests reproduced there byte for byte before these were taken):
--     body md5        30ad38da71405fdc960599802310e662
--     definition md5  4f20f5a2f6d7249578931bc877869981
--
-- The publisher's MIXED_CUSTODY_CONTRACT (server/scripts/engine-release-
-- database-proof.py) and tests/fixtures/legacy-engine-checkpoint/
-- mixed-custody-contract.json pin this function's digests in the 29-function
-- catalogue; both were regenerated from the native shared-hand-lane
-- qualification, which installs this migration on its clone after
-- 20260921040823 and proves 244 s is refused and 245 s admitted. INSTALL THIS
-- MIGRATION BEFORE THE RELEASE'S CONTRACT CHECK: a publisher carrying the new
-- catalogue refuses a database still holding the old digest, and vice versa.
--
-- Apply outside the hourly break window (:50-:03 UTC, CLAUDE.md section 2
-- rule 8). One statement of DDL, one transaction, one schema-cache reload.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $reserve_preimage$
DECLARE target oid := to_regprocedure('public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)');
BEGIN
 -- PRE-IMAGE. The live identity of the one function this migration edits, as
 -- production reports it: body md5, definition md5, owner, ACL, proconfig,
 -- security mode and volatility. Anything else is refused untouched.
 IF current_user <> 'postgres' OR target IS NULL THEN
  RAISE EXCEPTION 'F06_LEGACY_RESERVE_PREIMAGE_CHANGED: function absent' USING ERRCODE='55000';
 END IF;
 IF md5((SELECT prosrc FROM pg_proc WHERE oid=target)) IS DISTINCT FROM '3f78b42bcc2455701322b172ab7d42ff'
 OR md5(pg_get_functiondef(target)) IS DISTINCT FROM 'ca0446a62e08d49c2d318072cf465176' THEN
  RAISE EXCEPTION 'F06_LEGACY_RESERVE_PREIMAGE_CHANGED: body % definition %',
   md5((SELECT prosrc FROM pg_proc WHERE oid=target)), md5(pg_get_functiondef(target)) USING ERRCODE='55000';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=target
      AND proowner='postgres'::regrole AND prosecdef AND provolatile='v'
      AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
      AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']::text[]) THEN
  RAISE EXCEPTION 'F06_LEGACY_RESERVE_PREIMAGE_CHANGED: definer identity' USING ERRCODE='55000';
 END IF;
 -- The literal this migration moves is present exactly once, and the figure
 -- it moves to is not already there.
 IF (SELECT (length(prosrc)-length(replace(prosrc,'interval ''285 seconds''','')))/22 FROM pg_proc WHERE oid=target) <> 1
 OR EXISTS (SELECT 1 FROM pg_proc WHERE oid=target AND prosrc LIKE '%245 seconds%') THEN
  RAISE EXCEPTION 'F06_LEGACY_RESERVE_PREIMAGE_CHANGED: reserve literal' USING ERRCODE='55000';
 END IF;
END $reserve_preimage$;

CREATE OR REPLACE FUNCTION public.fn_f06_prepare_mixed_manager_custody(p_transfer_id uuid,p_tournament_id uuid,
 p_origin_generation uuid,p_successor_generation uuid,p_local jsonb,p_expected jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE retired_origin boolean:=false; l public.engine_tournament_leases; canonical jsonb; receipt jsonb; prior smarter_private.f06_manager_custody_transfers; checkpoint jsonb; maintenance jsonb; leader jsonb; instant timestamptz:=clock_timestamp();
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'service' THEN RAISE EXCEPTION 'F06_MIXED_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_transfer_id IS NULL OR p_tournament_id IS NULL OR p_origin_generation IS NULL OR p_successor_generation IS NULL
 OR p_origin_generation=p_successor_generation THEN RAISE EXCEPTION 'F06_MIXED_IDENTITY_REQUIRED'; END IF;
 -- Take the existing entry/maintenance lock before any lease row. The
 -- checkpoint is an assertion against locked authority, never a bypass GUC.
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN RAISE EXCEPTION 'F06_RETRY_MAINTENANCE_LANE' USING ERRCODE='40001'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR p_local ? 'release_checkpoint' THEN
 checkpoint:=p_local->'release_checkpoint';
 SELECT to_jsonb(b) INTO maintenance FROM public.engine_maintenance_break b WHERE to_jsonb(b)->'id'='true'::jsonb FOR SHARE;
 SELECT to_jsonb(e) INTO leader FROM public.engine_leader e WHERE id=true FOR SHARE;
 IF maintenance IS NULL OR leader IS NULL OR public.fn_platform_frozen() IS DISTINCT FROM true
 OR checkpoint IS NULL OR checkpoint->>'kind' IS DISTINCT FROM 'legacy_engine_checkpoint_8825_v1'
 OR checkpoint->>'source' IS DISTINCT FROM '8825af51817f379c4261658ca29ecc9d8d81932d'
 OR checkpoint->>'instance_id' IS DISTINCT FROM '1-3846b8bb'
 OR checkpoint->>'container_id' IS DISTINCT FROM 'c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66'
 OR checkpoint->>'process_id' IS DISTINCT FROM '1'
 OR COALESCE(checkpoint->>'run_id','') !~ '^[1-9][0-9]*(-[1-9][0-9]*)?$' OR COALESCE(checkpoint->>'control_sha','') !~ '^[0-9a-f]{40}$'
 OR checkpoint->>'phase' IS DISTINCT FROM 'counting_down'
 OR maintenance->>'phase' IS DISTINCT FROM checkpoint->>'phase'
 OR maintenance->>'declared_by' IS DISTINCT FROM '8825af51'
 OR (maintenance->>'ownership_token')::uuid IS DISTINCT FROM (checkpoint->>'ownership_token')::uuid
 OR (checkpoint->>'ownership_token')::uuid IS NULL
 OR (maintenance->>'announced_at')::timestamptz IS DISTINCT FROM (checkpoint->>'announced_at')::timestamptz
 OR (maintenance->>'break_started_at')::timestamptz IS DISTINCT FROM (checkpoint->>'break_started_at')::timestamptz
 OR (maintenance->>'break_ends_at')::timestamptz IS DISTINCT FROM (checkpoint->>'break_ends_at')::timestamptz
 OR maintenance->>'reason' IS DISTINCT FROM checkpoint->>'reason'
 OR (maintenance->>'announced_at')::timestamptz IS NULL
 OR (maintenance->>'break_started_at')::timestamptz IS NULL
 OR (maintenance->>'break_ends_at')::timestamptz IS NULL
 OR NOT isfinite((maintenance->>'announced_at')::timestamptz)
 OR NOT isfinite((maintenance->>'break_started_at')::timestamptz)
 OR NOT isfinite((maintenance->>'break_ends_at')::timestamptz)
 OR NOT (instant>=(maintenance->>'break_started_at')::timestamptz AND (maintenance->>'break_ends_at')::timestamptz-instant>=interval '245 seconds')
 OR leader->>'instance_id' IS DISTINCT FROM checkpoint->>'instance_id'
 OR leader->>'engine_version' IS DISTINCT FROM '8825af51'
 OR (leader->>'heartbeat_at')::timestamptz IS NULL
 OR NOT isfinite((leader->>'heartbeat_at')::timestamptz)
 OR NOT (instant-(leader->>'heartbeat_at')::timestamptz BETWEEN interval '-30 seconds' AND interval '60 seconds')
 THEN RAISE EXCEPTION 'F06_MIXED_FROZEN_CHECKPOINT_UNPROVEN' USING ERRCODE='55000'; END IF;
 END IF;
 PERFORM smarter_private.f06_retired_origin_lock(p_tournament_id);
 SELECT * INTO l FROM public.engine_tournament_leases WHERE tournament_id=p_tournament_id FOR UPDATE;
 IF NOT FOUND AND checkpoint IS NOT NULL AND EXISTS(SELECT 1 FROM smarter_private.f06_retired_manager_origins WHERE tournament_id=p_tournament_id AND origin_generation=p_origin_generation) THEN retired_origin:=true;
 ELSE
 IF NOT FOUND OR l.protocol_version<>2 OR l.lease_generation IS DISTINCT FROM p_origin_generation
 OR l.heartbeat_at IS NULL OR NOT isfinite(l.heartbeat_at)
 OR l.heartbeat_at>=clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN RAISE EXCEPTION 'F06_MIXED_OLD_LEASE_CHANGED'; END IF;
 IF checkpoint IS NOT NULL AND (l.instance_id IS DISTINCT FROM checkpoint->>'instance_id' OR l.engine_version IS DISTINCT FROM left(checkpoint->>'source',8)) THEN RAISE EXCEPTION 'F06_MIXED_OLD_PROCESS_CHANGED'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_local->'engines') e WHERE e#>'{bank_custody,stopped_capture}' IS NOT NULL) THEN
 IF retired_origin OR p_local#>>'{stopped_bank_owner,instance_id}' IS DISTINCT FROM l.instance_id
 OR p_local#>>'{stopped_bank_owner,version}' IS DISTINCT FROM l.engine_version
 THEN RAISE EXCEPTION 'F06_STOPPED_BANK_OWNER_CHANGED'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_local->'engines') e WHERE e#>'{bank_custody,historical_loss}' IS NOT NULL) AND (NOT retired_origin OR checkpoint IS NULL) THEN
 RAISE EXCEPTION 'F06_HISTORICAL_LOSS_RETIRED_CHECKPOINT_REQUIRED'; END IF;
 canonical:=smarter_private.f06_mixed_custody_snapshot(p_tournament_id,p_origin_generation,p_local);
 IF retired_origin THEN PERFORM smarter_private.f06_retired_origin_transfer(p_tournament_id,p_origin_generation,p_local,canonical); END IF;
 SELECT * INTO prior FROM smarter_private.f06_manager_custody_transfers WHERE tournament_id=p_tournament_id AND origin_generation=p_origin_generation;
 IF FOUND AND (prior.transfer_id,prior.successor_generation,prior.local_proof,prior.canonical_proof) IS DISTINCT FROM
 (p_transfer_id,p_successor_generation,p_local,canonical) THEN RAISE EXCEPTION 'F06_MIXED_TRANSFER_CHANGED'; END IF;
 IF p_expected IS NOT NULL THEN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_local->'engines') e WHERE e->>'lifecycle' IS NULL) THEN RAISE EXCEPTION 'F06_MIXED_PHYSICAL_LIFECYCLE_CHANGED'; END IF;
 IF p_expected IS DISTINCT FROM canonical THEN RAISE EXCEPTION 'F06_MIXED_CANONICAL_CHANGED'; END IF;
 IF prior.transfer_id IS NULL THEN
 INSERT INTO smarter_private.f06_manager_custody_transfers(transfer_id,tournament_id,origin_generation,successor_generation,local_proof,canonical_proof)
 VALUES(p_transfer_id,p_tournament_id,p_origin_generation,p_successor_generation,p_local,canonical) RETURNING * INTO prior;
 END IF;
 receipt:=to_jsonb(prior);
 END IF;
 RETURN jsonb_build_object('ok',true,'transfer_id',p_transfer_id,'tournament_id',p_tournament_id,
 'origin_generation',p_origin_generation,'successor_generation',p_successor_generation,'local',p_local,'canonical',canonical,'receipt',receipt);
END $$;

DO $reserve_postimage$
DECLARE target oid := to_regprocedure('public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)');
BEGIN
 -- POST-IMAGE, read back from the catalog: the new digests, the same
 -- definer identity, and the proof that only the one literal moved.
 IF target IS NULL
 OR md5((SELECT prosrc FROM pg_proc WHERE oid=target)) IS DISTINCT FROM '30ad38da71405fdc960599802310e662'
 OR md5(pg_get_functiondef(target)) IS DISTINCT FROM '4f20f5a2f6d7249578931bc877869981' THEN
  RAISE EXCEPTION 'F06_LEGACY_RESERVE_POSTIMAGE_CHANGED: body % definition %',
   md5((SELECT prosrc FROM pg_proc WHERE oid=target)), md5(pg_get_functiondef(target)) USING ERRCODE='55000';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=target
      AND proowner='postgres'::regrole AND prosecdef AND provolatile='v'
      AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
      AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']::text[]) THEN
  RAISE EXCEPTION 'F06_LEGACY_RESERVE_POSTIMAGE_CHANGED: definer identity' USING ERRCODE='55000';
 END IF;
 IF (SELECT (length(prosrc)-length(replace(prosrc,'interval ''245 seconds''','')))/22 FROM pg_proc WHERE oid=target) <> 1
 OR EXISTS (SELECT 1 FROM pg_proc WHERE oid=target AND prosrc LIKE '%285%')
 OR (SELECT md5(replace(prosrc,'interval ''245 seconds''','interval ''285 seconds''')) FROM pg_proc WHERE oid=target)
    IS DISTINCT FROM '3f78b42bcc2455701322b172ab7d42ff' THEN
  RAISE EXCEPTION 'F06_LEGACY_RESERVE_POSTIMAGE_CHANGED: more than the reserve literal moved' USING ERRCODE='55000';
 END IF;
END $reserve_postimage$;

COMMIT;
