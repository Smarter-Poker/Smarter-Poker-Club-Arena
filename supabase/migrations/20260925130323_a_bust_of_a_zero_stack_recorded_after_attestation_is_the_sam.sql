-- 20260925130323_a_bust_of_a_zero_stack_recorded_after_attestation_is_the_sam.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- smarter_private.f06_retired_origin_transfer(uuid,uuid,jsonb,jsonb) is the
-- guard the mixed-custody prepare RPC runs for a retired original manager
-- (20260919024642): before the successor may take custody it requires the
-- live canonical snapshot (f06_mixed_custody_snapshot, registrations =
-- to_jsonb(public.tournament_players) rows) to equal, whole row for whole row,
-- the canonical_proof the original owner attested at retirement. That
-- attestation is immutable; it was captured when the original manager stopped.
--
-- The 8825 legacy checkpoint's Afternoon tournament 615783bf-15e3-40b7-9368-
-- 75f21b6ac53b refuses every release with
--     F06_RETIRED_CANONICAL_CHANGED: registrations
-- Read-only comparison of the stored and live rows (2026-09-25 13:00Z): 195
-- rows attested, 195 rows live, exactly ONE row differs, registration
-- e18a7d98-7f05-4304-aa56-583abf8614af (user 62ec986d..., seat 3 at table
-- 9f30d335...). Attested: status='playing', position=null, eliminated_at=null,
-- elimination_sequence=null. Live: status='eliminated', position=12,
-- eliminated_at='2026-09-18T22:12:05.712905+00:00', elimination_sequence=
-- 151476. Every other field is identical on both sides, including chips=0,
-- chip_count=0, prize=0.00 and the zero bounty fields. Noon 5a387a75 has zero
-- differences. The stack was already zero when the attestation was taken; the
-- engine recorded the bust of that zero stack afterwards. No chip, prize or
-- seat moved. It is the same registration.
--
-- This migration changes ONLY the 'registrations' comparison in the transfer
-- guard. The seven other keys (operations, members, attempts, move_receipts,
-- seats, hand_dispatch, move_dispatch) keep the strict sorted whole-row
-- equality, verbatim. For registrations: the array lengths must be equal, and
-- after removing the rows that are identical on both sides (EXCEPT ALL, so
-- multiplicity counts), every remaining stored row must be status='playing'
-- with chips=0 and chip_count=0, every remaining live row must be
-- status='eliminated' with chips=0, chip_count=0, a positive integer position
-- and a non-null eliminated_at, and with status, position, eliminated_at and
-- elimination_sequence removed from both the remaining multisets must be
-- equal. A row with chips>0, a prize, a different seat, table or user, a row
-- added or removed, a bust that carries no position or no eliminated_at, or
-- the reverse transition (an attested eliminated row that is playing live)
-- still refuses with the same F06_RETIRED_CANONICAL_CHANGED: registrations.
-- The F06_RETIRED_TERMINAL_RECEIPT_REQUIRED check compares stored against
-- stored and is not touched.
--
-- THE TEXT IS THE INSTALLED TEXT. The CREATE OR REPLACE below is the byte-exact
-- statement from 20260919024642 (body md5 62d8d93f836f4edb633900f7da4ddc85,
-- definition md5 c59a8710299a46b798facb7b5298ce2d as production reports them),
-- extracted programmatically, with exactly that one comparison block replaced.
-- Same header: SECURITY DEFINER, search_path=pg_catalog,public,smarter_private,
-- VOLATILE, owner postgres, ACL {postgres=X/postgres}; CREATE OR REPLACE
-- preserves owner and ACL, and both DO blocks refuse if any of them is not what
-- production holds. The post-image proves that only the block moved: putting
-- the strict block back into the installed text must reproduce the pre-image
-- body digest exactly.
--
-- POST-IMAGE (computed on PostgreSQL 17.11 from the same text; the pre-image
-- digests reproduced there byte for byte before these were taken):
--     body md5        ce9c8da18aa4b596b62cc436fd22348d
--     definition md5  61bd389d3c261ee6422a9e2336c58e89
--
-- The publisher's MIXED_CUSTODY_CONTRACT (server/scripts/engine-release-
-- database-proof.py) and tests/fixtures/legacy-engine-checkpoint/
-- mixed-custody-contract.json pin this function's digests in the 29-function
-- catalogue; both were regenerated from the native shared-hand-lane
-- qualification, which installs this migration on its clone after
-- 20260924225647 and proves the zero-stack bust is admitted while chips>0, an
-- added or removed registration and a late-changed move still refuse. INSTALL
-- THIS MIGRATION BEFORE THE RELEASE'S CONTRACT CHECK: a publisher carrying the
-- new catalogue refuses a database still holding the old digest, and vice versa.
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

DO $regbust_preimage$
DECLARE target oid := to_regprocedure('smarter_private.f06_retired_origin_transfer(uuid,uuid,jsonb,jsonb)');
 old_block text := $old$ IF (SELECT jsonb_agg(x ORDER BY x::text) FROM jsonb_array_elements(canonical->key) x) IS DISTINCT FROM
 (SELECT jsonb_agg(x ORDER BY x::text) FROM jsonb_array_elements(prior.canonical_proof->key) x) THEN
 RAISE EXCEPTION 'F06_RETIRED_CANONICAL_CHANGED: %',key; END IF;$old$;
 new_block text := $new$ IF key='registrations' THEN
 -- A bust of a zero stack recorded after attestation is the same registration.
 -- Rows that differ pair only when the stored row is playing with chips=0 and
 -- chip_count=0, the live row is eliminated with a positive integer position
 -- and an eliminated_at, and every other field is identical; a row added,
 -- removed, or changed in any other way still refuses.
 IF (SELECT count(*) FROM jsonb_array_elements(canonical->key)) IS DISTINCT FROM (SELECT count(*) FROM jsonb_array_elements(prior.canonical_proof->key))
 OR (SELECT jsonb_agg(z.n ORDER BY z.n::text) FROM (SELECT x FROM jsonb_array_elements(prior.canonical_proof->key) x EXCEPT ALL SELECT x FROM jsonb_array_elements(canonical->key) x) s(x)
 CROSS JOIN LATERAL (SELECT CASE WHEN s.x->>'status'='playing' AND jsonb_typeof(s.x->'chips')='number' AND (s.x->>'chips')::numeric=0
 AND jsonb_typeof(s.x->'chip_count')='number' AND (s.x->>'chip_count')::numeric=0
 THEN s.x-ARRAY['status','position','eliminated_at','elimination_sequence'] ELSE s.x END) z(n)) IS DISTINCT FROM
 (SELECT jsonb_agg(z.n ORDER BY z.n::text) FROM (SELECT x FROM jsonb_array_elements(canonical->key) x EXCEPT ALL SELECT x FROM jsonb_array_elements(prior.canonical_proof->key) x) l(x)
 CROSS JOIN LATERAL (SELECT CASE WHEN l.x->>'status'='eliminated' AND jsonb_typeof(l.x->'chips')='number' AND (l.x->>'chips')::numeric=0
 AND jsonb_typeof(l.x->'chip_count')='number' AND (l.x->>'chip_count')::numeric=0
 AND jsonb_typeof(l.x->'position')='number' AND (l.x->>'position')::numeric>0 AND (l.x->>'position')::numeric=trunc((l.x->>'position')::numeric)
 AND jsonb_typeof(l.x->'eliminated_at')='string'
 THEN l.x-ARRAY['status','position','eliminated_at','elimination_sequence'] ELSE l.x END) z(n)) THEN
 RAISE EXCEPTION 'F06_RETIRED_CANONICAL_CHANGED: %',key; END IF;
 ELSIF (SELECT jsonb_agg(x ORDER BY x::text) FROM jsonb_array_elements(canonical->key) x) IS DISTINCT FROM
 (SELECT jsonb_agg(x ORDER BY x::text) FROM jsonb_array_elements(prior.canonical_proof->key) x) THEN
 RAISE EXCEPTION 'F06_RETIRED_CANONICAL_CHANGED: %',key; END IF;$new$;
BEGIN
 -- PRE-IMAGE. The live identity of the one function this migration edits, as
 -- production reports it: body md5, definition md5, owner, ACL, proconfig,
 -- security mode and volatility. Anything else is refused untouched.
 IF current_user <> 'postgres' OR target IS NULL THEN
  RAISE EXCEPTION 'F06_REGISTRATION_BUST_PREIMAGE_CHANGED: function absent' USING ERRCODE='55000';
 END IF;
 IF md5((SELECT prosrc FROM pg_proc WHERE oid=target)) IS DISTINCT FROM '62d8d93f836f4edb633900f7da4ddc85'
 OR md5(pg_get_functiondef(target)) IS DISTINCT FROM 'c59a8710299a46b798facb7b5298ce2d' THEN
  RAISE EXCEPTION 'F06_REGISTRATION_BUST_PREIMAGE_CHANGED: body % definition %',
   md5((SELECT prosrc FROM pg_proc WHERE oid=target)), md5(pg_get_functiondef(target)) USING ERRCODE='55000';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=target
      AND proowner='postgres'::regrole AND prosecdef AND provolatile='v'
      AND proacl::text='{postgres=X/postgres}'
      AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']::text[]) THEN
  RAISE EXCEPTION 'F06_REGISTRATION_BUST_PREIMAGE_CHANGED: definer identity' USING ERRCODE='55000';
 END IF;
 -- The strict whole-row comparison this migration relaxes for registrations is
 -- present exactly once, and the relaxed block is not already there.
 IF (SELECT (length(prosrc)-length(replace(prosrc,old_block,'')))/length(old_block) FROM pg_proc WHERE oid=target) <> 1
 OR EXISTS (SELECT 1 FROM pg_proc WHERE oid=target AND position(new_block IN prosrc)>0) THEN
  RAISE EXCEPTION 'F06_REGISTRATION_BUST_PREIMAGE_CHANGED: comparison block' USING ERRCODE='55000';
 END IF;
END $regbust_preimage$;

CREATE OR REPLACE FUNCTION smarter_private.f06_retired_origin_transfer(t uuid,g uuid,local_proof jsonb,canonical jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE prior smarter_private.f06_retired_manager_origins; item jsonb; pairs jsonb; key text; expected_permit jsonb;
BEGIN
 SELECT * INTO prior FROM smarter_private.f06_retired_manager_origins WHERE tournament_id=t AND origin_generation=g FOR SHARE;
 IF NOT FOUND OR local_proof->>'manager_id' IS DISTINCT FROM prior.physical_proof->>'manager_id'
 OR local_proof#>>'{release_checkpoint,instance_id}' IS DISTINCT FROM prior.physical_proof->>'instance_id'
 OR local_proof#>>'{release_checkpoint,source}' IS DISTINCT FROM prior.physical_proof->>'source'
 OR local_proof#>>'{release_checkpoint,container_id}' IS DISTINCT FROM prior.physical_proof->>'container_id' THEN
 RAISE EXCEPTION 'F06_RETIRED_TRANSFER_OWNER_CHANGED'; END IF;
 SELECT jsonb_object_agg(e->>'table_id',e->'engine_id') INTO pairs FROM jsonb_array_elements(local_proof->'engines') e;
 IF pairs IS DISTINCT FROM smarter_private.f06_retired_origin_cohort(t)->'engines' THEN RAISE EXCEPTION 'F06_RETIRED_WHOLE_OWNER_REQUIRED'; END IF;
 FOREACH key IN ARRAY ARRAY['operations','members','attempts','move_receipts','seats','registrations','hand_dispatch','move_dispatch'] LOOP
 -- Snapshot functions use different stable sorting for registrations only.
 IF key='registrations' THEN
 -- A bust of a zero stack recorded after attestation is the same registration.
 -- Rows that differ pair only when the stored row is playing with chips=0 and
 -- chip_count=0, the live row is eliminated with a positive integer position
 -- and an eliminated_at, and every other field is identical; a row added,
 -- removed, or changed in any other way still refuses.
 IF (SELECT count(*) FROM jsonb_array_elements(canonical->key)) IS DISTINCT FROM (SELECT count(*) FROM jsonb_array_elements(prior.canonical_proof->key))
 OR (SELECT jsonb_agg(z.n ORDER BY z.n::text) FROM (SELECT x FROM jsonb_array_elements(prior.canonical_proof->key) x EXCEPT ALL SELECT x FROM jsonb_array_elements(canonical->key) x) s(x)
 CROSS JOIN LATERAL (SELECT CASE WHEN s.x->>'status'='playing' AND jsonb_typeof(s.x->'chips')='number' AND (s.x->>'chips')::numeric=0
 AND jsonb_typeof(s.x->'chip_count')='number' AND (s.x->>'chip_count')::numeric=0
 THEN s.x-ARRAY['status','position','eliminated_at','elimination_sequence'] ELSE s.x END) z(n)) IS DISTINCT FROM
 (SELECT jsonb_agg(z.n ORDER BY z.n::text) FROM (SELECT x FROM jsonb_array_elements(canonical->key) x EXCEPT ALL SELECT x FROM jsonb_array_elements(prior.canonical_proof->key) x) l(x)
 CROSS JOIN LATERAL (SELECT CASE WHEN l.x->>'status'='eliminated' AND jsonb_typeof(l.x->'chips')='number' AND (l.x->>'chips')::numeric=0
 AND jsonb_typeof(l.x->'chip_count')='number' AND (l.x->>'chip_count')::numeric=0
 AND jsonb_typeof(l.x->'position')='number' AND (l.x->>'position')::numeric>0 AND (l.x->>'position')::numeric=trunc((l.x->>'position')::numeric)
 AND jsonb_typeof(l.x->'eliminated_at')='string'
 THEN l.x-ARRAY['status','position','eliminated_at','elimination_sequence'] ELSE l.x END) z(n)) THEN
 RAISE EXCEPTION 'F06_RETIRED_CANONICAL_CHANGED: %',key; END IF;
 ELSIF (SELECT jsonb_agg(x ORDER BY x::text) FROM jsonb_array_elements(canonical->key) x) IS DISTINCT FROM
 (SELECT jsonb_agg(x ORDER BY x::text) FROM jsonb_array_elements(prior.canonical_proof->key) x) THEN
 RAISE EXCEPTION 'F06_RETIRED_CANONICAL_CHANGED: %',key; END IF;
 END LOOP;
 expected_permit:=prior.canonical_proof#>'{hands,0,permit}';
 IF canonical->'pending_original_tables' IS DISTINCT FROM '[]'::jsonb OR NOT EXISTS
 (SELECT 1 FROM jsonb_array_elements(canonical->'original_evidence') e WHERE e#>'{evidence,receipt,expected}'=
 prior.canonical_proof||jsonb_build_object('retired_origin_id',prior.receipt_id)
 AND e#>>'{permit,permit_id}'=expected_permit->>'permit_id' AND e#>>'{permit,state}'='aborted_unsettled') THEN
 RAISE EXCEPTION 'F06_RETIRED_TERMINAL_RECEIPT_REQUIRED'; END IF;
END $$;

DO $regbust_postimage$
DECLARE target oid := to_regprocedure('smarter_private.f06_retired_origin_transfer(uuid,uuid,jsonb,jsonb)');
 old_block text := $old$ IF (SELECT jsonb_agg(x ORDER BY x::text) FROM jsonb_array_elements(canonical->key) x) IS DISTINCT FROM
 (SELECT jsonb_agg(x ORDER BY x::text) FROM jsonb_array_elements(prior.canonical_proof->key) x) THEN
 RAISE EXCEPTION 'F06_RETIRED_CANONICAL_CHANGED: %',key; END IF;$old$;
 new_block text := $new$ IF key='registrations' THEN
 -- A bust of a zero stack recorded after attestation is the same registration.
 -- Rows that differ pair only when the stored row is playing with chips=0 and
 -- chip_count=0, the live row is eliminated with a positive integer position
 -- and an eliminated_at, and every other field is identical; a row added,
 -- removed, or changed in any other way still refuses.
 IF (SELECT count(*) FROM jsonb_array_elements(canonical->key)) IS DISTINCT FROM (SELECT count(*) FROM jsonb_array_elements(prior.canonical_proof->key))
 OR (SELECT jsonb_agg(z.n ORDER BY z.n::text) FROM (SELECT x FROM jsonb_array_elements(prior.canonical_proof->key) x EXCEPT ALL SELECT x FROM jsonb_array_elements(canonical->key) x) s(x)
 CROSS JOIN LATERAL (SELECT CASE WHEN s.x->>'status'='playing' AND jsonb_typeof(s.x->'chips')='number' AND (s.x->>'chips')::numeric=0
 AND jsonb_typeof(s.x->'chip_count')='number' AND (s.x->>'chip_count')::numeric=0
 THEN s.x-ARRAY['status','position','eliminated_at','elimination_sequence'] ELSE s.x END) z(n)) IS DISTINCT FROM
 (SELECT jsonb_agg(z.n ORDER BY z.n::text) FROM (SELECT x FROM jsonb_array_elements(canonical->key) x EXCEPT ALL SELECT x FROM jsonb_array_elements(prior.canonical_proof->key) x) l(x)
 CROSS JOIN LATERAL (SELECT CASE WHEN l.x->>'status'='eliminated' AND jsonb_typeof(l.x->'chips')='number' AND (l.x->>'chips')::numeric=0
 AND jsonb_typeof(l.x->'chip_count')='number' AND (l.x->>'chip_count')::numeric=0
 AND jsonb_typeof(l.x->'position')='number' AND (l.x->>'position')::numeric>0 AND (l.x->>'position')::numeric=trunc((l.x->>'position')::numeric)
 AND jsonb_typeof(l.x->'eliminated_at')='string'
 THEN l.x-ARRAY['status','position','eliminated_at','elimination_sequence'] ELSE l.x END) z(n)) THEN
 RAISE EXCEPTION 'F06_RETIRED_CANONICAL_CHANGED: %',key; END IF;
 ELSIF (SELECT jsonb_agg(x ORDER BY x::text) FROM jsonb_array_elements(canonical->key) x) IS DISTINCT FROM
 (SELECT jsonb_agg(x ORDER BY x::text) FROM jsonb_array_elements(prior.canonical_proof->key) x) THEN
 RAISE EXCEPTION 'F06_RETIRED_CANONICAL_CHANGED: %',key; END IF;$new$;
BEGIN
 -- POST-IMAGE, read back from the catalog: the new digests, the same
 -- definer identity, and the proof that only the one block moved: putting
 -- the strict block back must reproduce the pre-image body digest exactly.
 IF target IS NULL
 OR md5((SELECT prosrc FROM pg_proc WHERE oid=target)) IS DISTINCT FROM 'ce9c8da18aa4b596b62cc436fd22348d'
 OR md5(pg_get_functiondef(target)) IS DISTINCT FROM '61bd389d3c261ee6422a9e2336c58e89' THEN
  RAISE EXCEPTION 'F06_REGISTRATION_BUST_POSTIMAGE_CHANGED: body % definition %',
   md5((SELECT prosrc FROM pg_proc WHERE oid=target)), md5(pg_get_functiondef(target)) USING ERRCODE='55000';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=target
      AND proowner='postgres'::regrole AND prosecdef AND provolatile='v'
      AND proacl::text='{postgres=X/postgres}'
      AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']::text[]) THEN
  RAISE EXCEPTION 'F06_REGISTRATION_BUST_POSTIMAGE_CHANGED: definer identity' USING ERRCODE='55000';
 END IF;
 IF (SELECT (length(prosrc)-length(replace(prosrc,new_block,'')))/length(new_block) FROM pg_proc WHERE oid=target) <> 1
 OR EXISTS (SELECT 1 FROM pg_proc WHERE oid=target AND position(old_block IN prosrc)>0)
 OR (SELECT md5(replace(prosrc,new_block,old_block)) FROM pg_proc WHERE oid=target) IS DISTINCT FROM '62d8d93f836f4edb633900f7da4ddc85' THEN
  RAISE EXCEPTION 'F06_REGISTRATION_BUST_POSTIMAGE_CHANGED: more than the registrations block moved' USING ERRCODE='55000';
 END IF;
END $regbust_postimage$;

COMMIT;
