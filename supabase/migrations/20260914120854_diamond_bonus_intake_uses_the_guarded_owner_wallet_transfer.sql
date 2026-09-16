-- Bonus batches and choice games use the same private, ledgered owner transfer
-- as legacy Plinko and Crash. The profile guard previously named only the
-- legacy public wrappers, so a real authenticated batch reached the owner
-- credit and was refused. Admit the shared internal transfer; retain every
-- other guard byte and its private ACL. No balance or permission is changed.
BEGIN;
DO $do$
DECLARE v_def text; v_after text;
 v_old constant text := $old$     OR v_stack ~ 'function (public[.])?fn_crash_start[(]'$old$;
 v_new constant text := $new$     OR v_stack ~ 'function (public[.])?fn_crash_start[(]'
     OR v_stack ~ 'function (public[.])?fn_diamond_game_take_bet[(]'$new$;
BEGIN
 SELECT pg_get_functiondef('public.fn_diamond_game_take_bet(uuid,integer,boolean,text,text,text,jsonb,uuid,text)'::regprocedure) INTO v_def;
 IF md5(v_def) <> '76f173360d844f0a351f36ee4a074a97' THEN RAISE EXCEPTION 'Diamond intake transfer changed; review before extending its wallet guard'; END IF;
 IF has_function_privilege('authenticated','public.fn_diamond_game_take_bet(uuid,integer,boolean,text,text,text,jsonb,uuid,text)','EXECUTE')
 OR has_function_privilege('anon','public.fn_diamond_game_take_bet(uuid,integer,boolean,text,text,text,jsonb,uuid,text)','EXECUTE') THEN
  RAISE EXCEPTION 'The owner transfer must remain private';
 END IF;
 SELECT pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure) INTO v_def;
 IF md5(v_def) <> '84cc516bec5b18ddcd88335cd79dacd5' OR strpos(v_def,v_old)=0 OR strpos(v_def,'fn_diamond_game_take_bet')>0 THEN
  RAISE EXCEPTION 'Profile wallet guard changed; review before applying the exact extension';
 END IF;
 EXECUTE replace(v_def,v_old,v_new);
 SELECT pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure) INTO v_after;
 IF replace(v_after,v_new,v_old) IS DISTINCT FROM v_def THEN RAISE EXCEPTION 'Unrelated wallet guard text changed'; END IF;
 IF 'fn_guard_profile_privileged_columns'=ANY(public.fn_ca_guard_watchlist()) THEN
  PERFORM public.fn_ca_declare_guard_redefinition('fn_guard_profile_privileged_columns','migration diamond_bonus_intake_uses_the_guarded_owner_wallet_transfer');
 END IF;
END $do$;
NOTIFY pgrst, 'reload schema';
COMMIT;
