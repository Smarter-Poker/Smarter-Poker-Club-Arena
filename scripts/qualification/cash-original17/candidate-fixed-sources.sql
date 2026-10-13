CREATE FUNCTION smarter_private.cash_original17_fixed_sources_match() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,smarter_private AS $body$
 SELECT smarter_private.original_hand_correction_sources_match() IS TRUE
 AND (SELECT count(*)=1 FROM supabase_migrations.schema_migrations WHERE version='20261013034406' AND cardinality(statements)=1 AND octet_length(statements[1])=12030 AND md5(statements[1])='c1d50ddeeb497dda34c5ef4481672396')
 AND NOT EXISTS(SELECT FROM(VALUES
 ('public.fn_poker_diamond_jackpot_allocate(uuid,bigint)','f6e42d6de56f5074f47403621fd46110','{postgres=X/postgres}'),
 ('public.fn_poker_diamond_jackpot_withdraw(uuid,uuid)','8ef3becaf9451c61696746ce57dee1e0','{postgres=X/postgres}'),
 ('public.fn_poker_diamond_jackpot_drop(uuid,bigint,bigint,jsonb)','7f7942a5318b29b53293dc7355d85f68','{postgres=X/postgres}'),
 ('public.fn_poker_diamond_jackpot_bank(uuid,text)','16efb5d2bb9b95406b4307cffedfc77f','{postgres=X/postgres,service_role=X/postgres}'),
 ('public.fn_poker_diamond_jackpot_accept_hand()','0db3d6146f5e1118c570ded9bfb5261f','{postgres=X/postgres}'),
 ('public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)','42026f4929fe2adc0aae9bfd307c516f','{postgres=X/postgres}')
 )v(signature,full_md5,acl) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(v.signature)
 WHERE p.oid IS NULL OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM v.full_md5
 OR pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres' OR p.prosecdef IS DISTINCT FROM true
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] OR p.proacl::text IS DISTINCT FROM v.acl)
 AND (SELECT count(*)=1 AND bool_and((t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))='d520254027350e60b03aad1f1a73747a') IS TRUE) FROM pg_trigger t WHERE t.tgrelid='public.hand_atomic_commits'::regclass AND t.tgname='poker_diamond_jackpot_accept_hand' AND NOT t.tgisinternal)
$body$;
