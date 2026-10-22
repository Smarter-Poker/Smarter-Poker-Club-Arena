-- 20261022010024_removing_an_agent_never_scans_rake_attributions.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- rake_attributions.agent_id references agents(id) ON DELETE SET NULL, and no
-- index leads with agent_id. Deleting ANY agent row therefore runs
-- UPDATE rake_attributions SET agent_id = NULL WHERE agent_id = $1 as a
-- sequential scan of the whole table (9.2M rows, 6.7 GB on 2026-10-22). Under
-- the 8s service_role statement timeout that delete is cancelled every time:
-- measured 2026-10-22 00:47:26Z, when the post-deploy isolated E2E identity
-- could not remove its own temporary agent row, so the agent boundary
-- certificate, the template staff fixture and the account deletion proof all
-- failed after it. The same delete path serves a club removing an agent.
--
-- pg_stats reports agent_id null_frac = 1, so a partial index on the non-null
-- rows is nearly empty, and the planner uses it for the strict equality the
-- foreign key action issues. Built CONCURRENTLY so live rake inserts are never
-- blocked. No rows, functions, permissions, timeouts or attribution rules change.
-- The maintained installer builds this preamble concurrently, verifies VALID,
-- then executes and records the exact guarded transaction below.
-- @live-proof: (SELECT i.indisvalid AND i.indisready AND i.indislive AND pg_get_expr(i.indpred,i.indrelid)='(agent_id IS NOT NULL)' FROM pg_index i WHERE i.indexrelid=to_regclass('public.idx_rake_attributions_agent_id'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rake_attributions_agent_id ON public.rake_attributions USING btree (agent_id) WHERE agent_id IS NOT NULL;
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $guard$
DECLARE ix record;
BEGIN
 SELECT i.*,c.relowner,am.amname INTO ix
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.idx_rake_attributions_agent_id');
 IF NOT FOUND THEN RAISE EXCEPTION 'rake_attributions_agent_index_missing'; END IF;
 IF ix.indrelid<>'public.rake_attributions'::regclass
 OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
 OR ix.indisunique OR ix.amname<>'btree'
 OR ix.indnkeyatts<>1 OR ix.indnatts<>1
 OR ix.indkey[0]<>(SELECT attnum FROM pg_attribute WHERE attrelid='public.rake_attributions'::regclass AND attname='agent_id')
 OR pg_get_expr(ix.indpred,ix.indrelid) IS DISTINCT FROM '(agent_id IS NOT NULL)'
 THEN RAISE EXCEPTION 'rake_attributions_agent_index_invalid_or_changed'; END IF;
END $guard$;
COMMIT;
