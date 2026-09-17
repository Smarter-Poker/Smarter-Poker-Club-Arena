BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='2s';
SELECT jsonb_build_object('captured_at',clock_timestamp(),'database',current_database(),'server_version_num',current_setting('server_version_num'),'functions',(
 SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'definition_md5',md5(pg_get_functiondef(p.oid)),'prosrc_md5',md5(p.prosrc),'owner',pg_get_userbyid(p.proowner),'language',l.lanname,'security_definer',p.prosecdef,'volatility',p.provolatile,'parallel',p.proparallel,'strict',p.proisstrict,'leakproof',p.proleakproof,'config',p.proconfig,'acl',p.proacl::text,'result',pg_get_function_result(p.oid),'identity_arguments',pg_get_function_identity_arguments(p.oid),'arguments',pg_get_function_arguments(p.oid),'effective_execute',jsonb_build_object('anon',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),'service_role',has_function_privilege('service_role',p.oid,'EXECUTE')),'acl_entries',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.privilege_type) FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner)))a)) ORDER BY p.oid::regprocedure::text)
 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
 WHERE p.oid IN(to_regprocedure('public.fn_apply_rakeback_player_stats_batch(jsonb)'),to_regprocedure('public.apply_rakeback_player_stats(uuid,uuid,uuid,integer,numeric)'))
)) AS catalog;
ROLLBACK;

