-- Tier: 3
-- Author: Stable Admin release-blocker recovery
-- Affects: fn_lightning_match_and_form only; no financial or eligibility owner changes
-- A stale group cannot discard unrelated remaining groups in the same plan.
-- CI 38026920728 S1: 150 legal players, 17 groups, two real
-- insufficient_legal_candidates retries, zero hands, 1542ms/time_budget.
-- The matcher discarded each plan after its first stale group. Continue only
-- this semantic retry through the remaining disjoint groups; each still goes
-- through the unchanged locked formation barrier. Replan after the plan ends.
-- Keep original budget, max_replans, group order, request ordinals, receipts,
-- freeze/refusal behavior, grants and every financial check unchanged.
-- Reserved by scripts/new-migration.mjs. Installed predecessors are immutable.
-- @live-proof: (SELECT NOT p.prosecdef AND p.provolatile = 'v' AND has_function_privilege('service_role',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND position('STALE GROUPS KEEP DISJOINT PROGRESS' in p.prosrc)>0 AND p.prosrc ~ 'IF clock_timestamp\(\) - v_form_started >= v_budget THEN' AND p.prosrc ~ 'public.fn_lightning_form_hand\(' FROM pg_proc p WHERE p.oid='public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $progress$
DECLARE
  sig constant text := 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)';
  old constant text := E'        v_retry := true;\n        EXIT;';
  replacement constant text := E'        v_retry := true;\n        -- STALE GROUPS KEEP DISJOINT PROGRESS. The real barrier revalidates\n        -- every remaining group; no failed group is formed or reordered.\n        IF (v_r ->> ''reason'') = ''insufficient_legal_candidates'' THEN\n          CONTINUE;\n        END IF;\n        EXIT;';
  src text;
  original_acl aclitem[];
  original_owner oid;
BEGIN
  SELECT pg_get_functiondef(oid), proacl, proowner INTO src, original_acl, original_owner
    FROM pg_proc WHERE oid=sig::regprocedure;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=sig::regprocedure AND
      (prosecdef OR provolatile<>'v' OR proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']))
     OR NOT has_function_privilege('service_role',sig,'EXECUTE')
     OR has_function_privilege('authenticated',sig,'EXECUTE')
     OR has_function_privilege('anon',sig,'EXECUTE') THEN
    RAISE EXCEPTION 'Lightning matcher security or grants differ from qualified owner';
  END IF;
  IF position('STALE GROUPS KEEP DISJOINT PROGRESS' in src)>0 THEN
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=sig::regprocedure)<>'8e06bde427b2b38939194c4ebb16c7de'
       OR md5(src)<>'449fdbe1fa82cf75c17129b098e1c5f9' THEN
      RAISE EXCEPTION 'Lightning matcher patched owner drifted';
    END IF;
    RETURN;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=sig::regprocedure)<>'a66e718780e9d873a62ee826411d546a' THEN
    RAISE EXCEPTION 'Lightning matcher preimage differs from qualified owner';
  END IF;
  IF (length(src)-length(replace(src,old,'')))/length(old)<>1 THEN
    RAISE EXCEPTION 'Lightning retry anchor differs from qualified owner';
  END IF;
  EXECUTE replace(src,old,replacement);
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=sig::regprocedure)<>'8e06bde427b2b38939194c4ebb16c7de'
     OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid=sig::regprocedure)<>'449fdbe1fa82cf75c17129b098e1c5f9' THEN
    RAISE EXCEPTION 'Lightning matcher postimage differs from qualification';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=sig::regprocedure AND
      (proacl IS DISTINCT FROM original_acl OR proowner IS DISTINCT FROM original_owner)) THEN
    RAISE EXCEPTION 'Lightning matcher owner or ACL changed';
  END IF;
END $progress$;
COMMIT;

-- Rollback: reserve a NEW migration, then copy the following exact inverse.
-- BEGIN;
-- SET LOCAL lock_timeout='2s';
-- SET LOCAL statement_timeout='30s';
-- DO $rollback$
-- DECLARE sig constant text := 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'; src text; original_acl aclitem[]; original_owner oid;
-- BEGIN
--  SELECT pg_get_functiondef(oid),proacl,proowner INTO src,original_acl,original_owner FROM pg_proc WHERE oid=sig::regprocedure;
--  IF md5(src)<>'449fdbe1fa82cf75c17129b098e1c5f9' OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=sig::regprocedure)<>'8e06bde427b2b38939194c4ebb16c7de' THEN RAISE EXCEPTION 'rollback owner drifted'; END IF;
--  EXECUTE replace(src,E'        v_retry := true;\n        -- STALE GROUPS KEEP DISJOINT PROGRESS. The real barrier revalidates\n        -- every remaining group; no failed group is formed or reordered.\n        IF (v_r ->> ''reason'') = ''insufficient_legal_candidates'' THEN\n          CONTINUE;\n        END IF;\n        EXIT;',E'        v_retry := true;\n        EXIT;');
--  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=sig::regprocedure)<>'a66e718780e9d873a62ee826411d546a' OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid=sig::regprocedure)<>'58a7c2c4a38a07c423ee945a625139b2' OR EXISTS(SELECT 1 FROM pg_proc WHERE oid=sig::regprocedure AND (proacl IS DISTINCT FROM original_acl OR proowner IS DISTINCT FROM original_owner)) THEN RAISE EXCEPTION 'rollback did not restore exact owner'; END IF;
-- END $rollback$;
-- COMMIT;
