WITH expected(signature,body_md5,config,roles) AS (VALUES
 ('smarter_private.fn_smarter_data_api_pre_request()','d21a055b448febe83c1637371b150100',ARRAY['search_path=pg_catalog, pg_temp'],ARRAY['anon','authenticated','postgres','service_role']),
 ('public.fn_assert_tournament_manager_write_scope(uuid)','06bb10766a750b370a0ecb26dbdbdbe1',ARRAY['search_path=public, pg_temp'],ARRAY['postgres']),
 ('public.fn_mystery_bounty_reveal(uuid,uuid,boolean)','5578ec53c8a531eeba47d448ae9af1b1',ARRAY['search_path=public, pg_temp'],ARRAY['authenticated','postgres','service_role']),
 ('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)','d1b5100c2b9f92bec5fd1680b0b4f230',ARRAY['search_path=public, pg_temp'],ARRAY['postgres','service_role']),
 ('public.heartbeat_tournament_leases_v4(text,jsonb,integer)','5e6c99545e07c21efcb50e5cb3441c14',ARRAY['search_path=public, pg_temp'],ARRAY['postgres','service_role'])
), actual AS (
 SELECT e.*,p.oid IS NOT NULL present,md5(p.prosrc) actual_body_md5,pg_get_userbyid(p.proowner) owner,
   p.prosecdef,p.proconfig,p.provolatile,l.lanname,
   (SELECT array_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END
       ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
     FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.privilege_type='EXECUTE') actual_roles,
   NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
     WHERE a.grantor<>p.proowner OR a.is_grantable) exact_grant_options
 FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
 LEFT JOIN pg_language l ON l.oid=p.prolang
), checks AS (
 SELECT *,COALESCE(present AND actual_body_md5=body_md5 AND owner='postgres'
   AND prosecdef AND proconfig=config AND provolatile='v' AND lanname='plpgsql'
   AND actual_roles=roles AND exact_grant_options,false) ok FROM actual
)
SELECT jsonb_build_object(
 'all_function_checks_pass',(SELECT bool_and(ok) FROM checks),
 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',signature,'ok',ok,'body_md5',actual_body_md5,'owner',owner,'config',proconfig,'execute_roles',actual_roles)) FROM checks),
 'private_hook_binding',(SELECT substr(setting,length('pgrst.db_pre_request=')+1) FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole CROSS JOIN LATERAL unnest(s.setconfig) setting WHERE r.rolname='authenticator' AND s.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database())) AND setting LIKE 'pgrst.db_pre_request=%' ORDER BY (s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())) DESC LIMIT 1),
 'private_schema_acl_fingerprint',(SELECT md5(COALESCE(nspacl::text,'')) FROM pg_namespace WHERE nspname='smarter_private'),
 'authenticator_settings_fingerprint',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.setdatabase,s.setrole)::text,'[]')) FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname='authenticator'),
 'public_hook_absent',to_regprocedure('public.fn_smarter_data_api_pre_request()') IS NULL,
 'deal_activation_absent',NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.tournament_obligations') AND tgname='require_exact_final_deal_proposal' AND NOT tgisinternal)
) AS manager_hook_admission_postflight;
