-- A purchased add-on does not strand a snapshotless abandoned hand.
-- f498902d-cb5f-4ed8-ad4b-8c7b0601823a: five exact +10000 add-ons on
-- two card-bearing hands held all twelve permits of the crashed generation.
-- Chairs and playing registrations already agree. No player balance is written.
-- The saved-snapshot branch already admits this same bounded difference.
-- Preserve all other refusals and the existing event-owned recovery transaction.
-- @live-proof: SELECT md5(prosrc) = '0753a506f9ef7ac48588c7e8ec3f4721' AS installed FROM pg_proc WHERE oid = 'public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'::regprocedure;
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
DO $migration$
DECLARE
 p record; candidate text;
 old_clause constant text := $old$AND (x->>'stack')::numeric = (r->>'stack')::numeric)))) THEN$old$;
 new_clause constant text := $new$AND ((x->>'stack')::numeric = (r->>'stack')::numeric
                                                        -- The same exact purchased add-on proof as the saved-snapshot branch.
                                                        OR (COALESCE(event.addon_chips, 0) > 0
                                                            AND EXISTS (SELECT 1 FROM public.tournament_players tp
                                                                         WHERE tp.id = (r->>'registration_id')::uuid
                                                                           AND tp.add_on IS TRUE)
                                                            AND (r->>'stack')::numeric
                                                                = (x->>'stack')::numeric + event.addon_chips)))))) THEN$new$;
BEGIN
 SELECT prosrc,proowner,proacl,proconfig,prosecdef,pg_get_functiondef(oid) AS definition
 INTO p FROM pg_proc
 WHERE oid='public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'::regprocedure;
 IF md5(p.prosrc) IS DISTINCT FROM 'e7629cf22c6ef6c52ba3490298979d23'
    OR p.proowner IS DISTINCT FROM 'postgres'::regrole
    OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
    OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private']
    OR p.prosecdef IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'ABANDONED_ADDON_PREIMAGE_DRIFT';
 END IF;
 IF length(p.definition)-length(replace(p.definition,old_clause,'')) <> length(old_clause) THEN
   RAISE EXCEPTION 'ABANDONED_ADDON_CLAUSE_DRIFT';
 END IF;
 candidate := replace(p.definition,old_clause,new_clause);
 EXECUTE candidate;
 IF NOT EXISTS(SELECT 1 FROM pg_proc
 WHERE oid='public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'::regprocedure
 AND md5(prosrc)='0753a506f9ef7ac48588c7e8ec3f4721'
 AND proowner=p.proowner AND proacl IS NOT DISTINCT FROM p.proacl
 AND proconfig IS NOT DISTINCT FROM p.proconfig AND prosecdef=p.prosecdef) THEN
   RAISE EXCEPTION 'ABANDONED_ADDON_POSTIMAGE_DRIFT';
 END IF;
END $migration$;
COMMIT;

