-- R3 retains the original close deadline instead of starting another90seconds.
-- Only the batch stop changes; every financial/deferred/postlude guard remains.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $owner$
DECLARE original text;patched text;before_meta jsonb;after_meta jsonb;
 needle constant text:='v_stop:=clock_timestamp()+interval ''90 seconds'';';
 replacement constant text:='v_stop:=CASE WHEN v_batched THEN LEAST(clock_timestamp()+interval ''90 seconds'',NULLIF(current_setting(''app.weekly_accounting_scope_deadline'',true),'''')::timestamptz) ELSE clock_timestamp()+interval ''90 seconds'' END;';
BEGIN
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'rakeback_deadline_install_frozen';END IF;
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO original,before_meta FROM pg_proc p
 WHERE p.oid='public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure;
 IF md5(original) IS DISTINCT FROM 'b07dc0dc2bdfa00973b4613e0cfb83d5'
 OR length(original)-length(replace(original,needle,''))<>length(needle)
 THEN RAISE EXCEPTION 'rakeback_deadline_owner_preimage_changed';END IF;
 patched:=replace(original,needle,replacement);
 EXECUTE patched;
 SELECT to_jsonb(p)-'prosrc' INTO after_meta FROM pg_proc p
 WHERE p.oid='public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure;
 IF after_meta IS DISTINCT FROM before_meta
 OR md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM md5(patched)
 THEN RAISE EXCEPTION 'rakeback_deadline_owner_postimage_changed';END IF;
END $owner$;
COMMIT;
