-- Reserved by scripts/new-migration.mjs (the reserved version is unchanged).
-- rake_attributions.agent_id references agents(id) ON DELETE SET NULL but had
-- no index, so deleting any agents row scanned all ~9.2M attribution rows and
-- hit the statement timeout (post-deploy agent boundary run 39699204267:
-- DELETE /rest/v1/agents HTTP 500, 57014). The partial index covers exactly
-- the rows the foreign-key action can touch; every live row is currently NULL,
-- so it is tiny. No rows, grants, policies, triggers or financial rules change.
-- Supported concurrent preamble: never lock live rake attribution inserts.
-- @live-proof: (SELECT i.indisvalid AND i.indisready AND i.indislive FROM pg_index i WHERE i.indexrelid=to_regclass('public.idx_rake_attributions_agent_id_fk'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rake_attributions_agent_id_fk
 ON public.rake_attributions (agent_id) WHERE agent_id IS NOT NULL;
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$
DECLARE ix record;
BEGIN
 SELECT i.*, c.relowner, am.amname, pg_get_indexdef(i.indexrelid) AS def INTO ix
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.idx_rake_attributions_agent_id_fk');
 IF NOT FOUND THEN RAISE EXCEPTION 'rake_attribution_agent_index_missing'; END IF;
 IF ix.indrelid<>'public.rake_attributions'::regclass OR ix.relowner<>'postgres'::regrole
 OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive OR ix.indisunique
 OR ix.amname<>'btree'
 OR ix.def IS DISTINCT FROM 'CREATE INDEX idx_rake_attributions_agent_id_fk ON public.rake_attributions USING btree (agent_id) WHERE (agent_id IS NOT NULL)'
 THEN RAISE EXCEPTION 'rake_attribution_agent_index_shape_changed'; END IF;
END $guard$;
COMMIT;
