BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='2s';
WITH rels AS(SELECT c.*,n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN('credit_invoices','credit_payments','wallets')),
 roots AS(SELECT p.* FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'
 AND(p.proname IN('fn_ca_post_leg','atomic_deduct_wallet_and_log')
 OR p.oid IN(SELECT tgfoid FROM pg_trigger WHERE tgrelid IN(SELECT oid FROM rels) AND NOT tgisinternal))),
 called_names AS(SELECT DISTINCT lower(m[1]) AS name FROM roots r
 CROSS JOIN LATERAL regexp_matches(r.prosrc,'(?:public\.)?([a-zA-Z_][a-zA-Z_0-9]*)[[:space:]]*\(','g')m),
 candidates AS(SELECT p.* FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'
 AND(p.oid IN(SELECT oid FROM roots) OR p.proname IN(SELECT name FROM called_names))),
 bounded AS(SELECT * FROM candidates ORDER BY oid LIMIT 64)
SELECT jsonb_build_object('captured_at',clock_timestamp()::text,'transaction_isolation',current_setting('transaction_isolation'),
 'transaction_read_only',current_setting('transaction_read_only'),'statement_timeout',current_setting('statement_timeout'),
 'lock_timeout',current_setting('lock_timeout'),'server_version',current_setting('server_version'),
 'function_candidate_count',(SELECT count(*) FROM candidates),'function_limit',64,
 'missing_named_functions',(SELECT jsonb_agg(v.name) FROM(VALUES('fn_ca_post_leg'),('atomic_deduct_wallet_and_log'))v(name)
  WHERE NOT EXISTS(SELECT 1 FROM roots WHERE proname=v.name)),
 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'arguments',pg_get_function_arguments(p.oid),
  'result',pg_get_function_result(p.oid),'owner',pg_get_userbyid(p.proowner),'language',l.lanname,'security_definer',p.prosecdef,
  'strict',p.proisstrict,'leakproof',p.proleakproof,'volatility',p.provolatile,'parallel',p.proparallel,
  'config',p.proconfig,'acl',p.proacl,'definition',pg_get_functiondef(p.oid),'definition_md5',md5(pg_get_functiondef(p.oid)),
  'body_md5',md5(p.prosrc),'is_root',p.oid IN(SELECT oid FROM roots),
  'effective_execute',(SELECT jsonb_object_agg(api,has_function_privilege(api,p.oid,'EXECUTE')) FROM unnest(ARRAY['anon','authenticated','service_role'])api),
  'direct_relation_dependencies',(SELECT jsonb_agg(jsonb_build_object('relation',d.refobjid::regclass::text,'type',d.deptype)
   ORDER BY d.refobjid::regclass::text) FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_class'::regclass)
  ) ORDER BY p.oid::regprocedure::text) FROM bounded p JOIN pg_language l ON l.oid=p.prolang),
 'relations',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'kind',c.relkind,
  'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',c.relacl,'options',c.reloptions,
  'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'ordinal',a.attnum,'type',format_type(a.atttypid,a.atttypmod),
    'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl)
    ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),
    'enabled',t.tgenabled,'type',t.tgtype,'function',t.tgfoid::regprocedure::text,'deferrable',t.tgdeferrable,'initially_deferred',t.tginitdeferred)
    ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.policyname) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname),
  'effective_privileges',(SELECT jsonb_object_agg(api,jsonb_build_object('table',(SELECT jsonb_object_agg(priv,has_table_privilege(api,c.oid,priv))
    FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])priv),
   'any_column',(SELECT jsonb_object_agg(priv,has_any_column_privilege(api,c.oid,priv))
    FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES'])priv))) FROM unnest(ARRAY['anon','authenticated','service_role'])api)
  ) ORDER BY c.relname) FROM rels c),
 'scope','fn_ca_post_leg, atomic_deduct_wallet_and_log, three named relations direct noninternal trigger functions, and one static public-callee layer; dynamic or further indirect callers remain unproven.'
) AS catalog;
ROLLBACK;
