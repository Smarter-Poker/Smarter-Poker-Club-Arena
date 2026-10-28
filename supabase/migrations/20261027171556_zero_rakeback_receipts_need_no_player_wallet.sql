-- @live-proof: md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))='b07dc0dc2bdfa00973b4613e0cfb83d5'
-- A zero entitlement still closes its certified period, without needing a wallet.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $owner$
DECLARE original text;patched text;before_meta jsonb;after_meta jsonb;
 needle constant text:='SELECT club_id,user_id,sum(owed) FROM pg_temp._routed_player_todo GROUP BY club_id,user_id;';
BEGIN
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'zero_rakeback_wallet_install_frozen';END IF;
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO original,before_meta FROM pg_proc p
 WHERE p.oid='public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure;
 IF md5(original) IS DISTINCT FROM '38e8a0bf0b309b973391107e3bd934d0'
 OR length(original)-length(replace(original,needle,''))<>length(needle)
 THEN RAISE EXCEPTION 'zero_rakeback_wallet_owner_preimage_changed';END IF;
 patched:=replace(original,needle,'SELECT club_id,user_id,sum(owed) FROM pg_temp._routed_player_todo WHERE owed>0 GROUP BY club_id,user_id;');
 EXECUTE patched;
 SELECT to_jsonb(p)-'prosrc' INTO after_meta FROM pg_proc p
 WHERE p.oid='public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure;
 IF after_meta IS DISTINCT FROM before_meta
 OR md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM 'b07dc0dc2bdfa00973b4613e0cfb83d5'
 THEN RAISE EXCEPTION 'zero_rakeback_wallet_owner_postimage_changed';END IF;
END $owner$;
COMMIT;
