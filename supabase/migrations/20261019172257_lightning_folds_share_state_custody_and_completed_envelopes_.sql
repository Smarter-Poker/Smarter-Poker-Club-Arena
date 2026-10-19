-- 20261019172257_lightning_folds_share_state_custody_and_completed_envelopes_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- Folders retain shared state custody, then lock only their own participant.
-- Settlement/abandonment still take an incompatible instance lock.
SET LOCAL lock_timeout='3s';
DO $patch$
DECLARE src text;
BEGIN
 SELECT pg_get_functiondef('public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)'::regprocedure) INTO src;
 IF md5(src)<>'a4345d60b121deaf6405437268bb0cab' THEN RAISE EXCEPTION 'Lightning fold preimage changed'; END IF;
 src:=replace(src,'WHERE li.id = h.lightning_instance_id FOR UPDATE;',
   'WHERE li.id = h.lightning_instance_id FOR SHARE;');
 EXECUTE src;
 SELECT pg_get_functiondef('public.fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure) INTO src;
 IF md5(src)<>'24a8270d08af6a1f54a7ed57154ec625' THEN RAISE EXCEPTION 'financial alert lifecycle preimage changed'; END IF;
 src:=replace(src,
   $old$AND a.source = 'ServerTableEngine.post_commit_obligations_pending'$old$,
   $new$AND a.source IN ('ServerTableEngine.post_commit_obligations_pending',
                        'LightningHandHost.post_commit_obligations_pending')
       AND (a.source <> 'LightningHandHost.post_commit_obligations_pending' OR (
         c.table_id::text = a.context->>'table_id'
         AND to_jsonb(c.hand_number) = a.context->'hand_number'
         AND c.post_commit_request_hash ~ '^[0-9a-f]{64}$'
         AND c.post_commit_payload_hash ~ '^[0-9a-f]{64}$'
         AND c.post_commit_result->'ok' = 'true'::jsonb
         AND c.post_commit_result->>'hand_id' = c.hand_id::text
         AND c.post_commit_result->'hand_number' = to_jsonb(c.hand_number)))$new$);
 EXECUTE src;
END $patch$;

COMMIT;
-- @live-proof: (SELECT position('WHERE li.id = h.lightning_instance_id FOR SHARE;' IN pg_get_functiondef('public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)'::regprocedure))>0)
-- @live-proof: (SELECT position('LightningHandHost.post_commit_obligations_pending' IN pg_get_functiondef('public.fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure))>0)
