-- A prize paid from the Promo Wallet is still a game prize. Labeling it
-- as a generic promo transfer invoked settlement invoice delivery, which
-- cannot represent a member prize at a union host. Keep the funding helper,
-- its promo-first split, reservations, ledger, and payout amount unchanged.
BEGIN;
DO $do$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.chip_ledger'::regclass
 AND conname='chip_ledger_category_check' AND pg_get_constraintdef(oid) LIKE '%''crossing_prize''%'
 AND pg_get_constraintdef(oid) LIKE '%''mines_prize''%') THEN RAISE EXCEPTION 'Install the game prize categories first'; END IF;
END $do$;
DO $do$
DECLARE v_def text; v_after text;
 v_old constant text := $old$fn_diamond_game_pay_chips('promo',r.host_id$old$;
 v_new constant text := $new$fn_diamond_game_pay_chips(r.game||'_prize',r.host_id$new$;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO STRICT v_def FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_choice_act';
 IF md5(v_def)<>'a8c0c652b305217fd8b749f607733fea' OR strpos(v_def,v_old)=0 THEN RAISE EXCEPTION 'fn_choice_act changed; review before changing the prize category'; END IF;
 EXECUTE replace(v_def,v_old,v_new);
 SELECT pg_get_functiondef(p.oid) INTO STRICT v_after FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_choice_act';
 IF replace(v_after,v_new,v_old) IS DISTINCT FROM v_def THEN RAISE EXCEPTION 'Unrelated fn_choice_act behavior changed'; END IF;
END $do$;
DO $do$
DECLARE v_def text; v_after text;
 v_old constant text := $old$fn_diamond_game_pay_chips('promo',adm.o_host$old$;
 v_new constant text := $new$fn_diamond_game_pay_chips('plinko_prize',adm.o_host$new$;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO STRICT v_def FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_plinko_bonus_run';
 IF md5(v_def)<>'db0a9fc80e15e6da7ce233d0be90635c' OR strpos(v_def,v_old)=0 THEN RAISE EXCEPTION 'fn_plinko_bonus_run changed; review before changing the prize category'; END IF;
 EXECUTE replace(v_def,v_old,v_new);
 SELECT pg_get_functiondef(p.oid) INTO STRICT v_after FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_plinko_bonus_run';
 IF replace(v_after,v_new,v_old) IS DISTINCT FROM v_def THEN RAISE EXCEPTION 'Unrelated fn_plinko_bonus_run behavior changed'; END IF;
END $do$;
NOTIFY pgrst, 'reload schema';
COMMIT;
