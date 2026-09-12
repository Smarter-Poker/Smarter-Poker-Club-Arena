-- Proposal: trusted default-branch verifier only; not installed.
-- MCP executor must own one atomic transaction. No business function invocation.
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
CREATE FUNCTION public.fn_ci_money_trigger_recovery(p_versions text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $body$
BEGIN
 IF p_versions IS NULL OR cardinality(p_versions)>64 OR EXISTS(SELECT 1 FROM unnest(p_versions) v WHERE v IS NULL OR v !~ '^[0-9]{14}$') THEN
 RAISE EXCEPTION 'invalid recovery versions' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('version',1,'observed_at',statement_timestamp(),
 'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('version',h.version,'name',h.name,'statementCount',cardinality(h.statements),'sha256',encode(sha256(convert_to(array_to_string(h.statements,''),'UTF8')),'hex'))) FROM supabase_migrations.schema_migrations h WHERE h.version=ANY(p_versions)),'[]'::jsonb),
 'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('table',c.relname,'trigger',t.tgname,'enabled',t.tgenabled,'definitionSha256',encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex'),'functionSha256',encode(sha256(convert_to(pg_get_functiondef(t.tgfoid),'UTF8')),'hex'))) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname IN('table_seats','club_members','club_wallets','union_wallets','wallets','chip_ledger','tournaments','tournament_players','ca_settlements')),'[]'::jsonb),
 'declarations',COALESCE((SELECT jsonb_agg(jsonb_build_object('table',r.table_name,'trigger',r.trigger_name,'note',r.note)) FROM public.ca_declared_money_triggers r WHERE r.table_name IN('table_seats','club_members','club_wallets','union_wallets','wallets','chip_ledger','tournaments','tournament_players','ca_settlements')),'[]'::jsonb));
END $body$;
ALTER FUNCTION public.fn_ci_money_trigger_recovery(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ci_money_trigger_recovery(text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ci_money_trigger_recovery(text[]) TO service_role;
DO $acl$ BEGIN
 IF (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ci_money_trigger_recovery(text[])'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
 OR has_function_privilege('anon','public.fn_ci_money_trigger_recovery(text[])','EXECUTE')
 OR has_function_privilege('authenticated','public.fn_ci_money_trigger_recovery(text[])','EXECUTE') THEN RAISE EXCEPTION 'unexpected recovery helper authority'; END IF;
END $acl$;
