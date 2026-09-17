BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='2s';
WITH names(name) AS (VALUES ('fn_agent_wallet_send_phase2_core_20260831'),('fn_agent_wallet_claim_back'),('fn_caller_is_engine'),('fn_is_club_admin_uid'),('fn_is_platform_admin'),('fn_club_bank_role'),('fn_club_cashier_can_transact'),('fn_generate_credit_invoice'))
SELECT jsonb_build_object(
 'captured_at',clock_timestamp()::text,'transaction_read_only',current_setting('transaction_read_only'),
 'transaction_isolation',current_setting('transaction_isolation'),'statement_timeout',current_setting('statement_timeout'),'lock_timeout',current_setting('lock_timeout'),
 'missing_names',(SELECT jsonb_agg(n.name ORDER BY n.name) FROM names n WHERE NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=n.name AND p.prokind='f')),
 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'arguments',pg_get_function_arguments(p.oid),
  'result',pg_get_function_result(p.oid),'owner',pg_get_userbyid(p.proowner),'language',l.lanname,'security_definer',p.prosecdef,
  'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'config',p.proconfig,'acl',p.proacl,
  'definition',pg_get_functiondef(p.oid),'definition_md5',md5(pg_get_functiondef(p.oid)),'body_md5',md5(p.prosrc),
  'effective_execute',(SELECT jsonb_object_agg(api,has_function_privilege(api,p.oid,'EXECUTE')) FROM unnest(ARRAY['anon','authenticated','service_role'])api))
  ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.pronamespace='public'::regnamespace AND p.prokind='f' AND p.proname IN(SELECT name FROM names))
) AS catalog;
ROLLBACK;
