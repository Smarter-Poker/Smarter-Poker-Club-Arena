-- The Diamond Arena has no chip wallet. The Oct 2 canonical-wallet trigger
-- attempted to insert club_wallets for every new club, including the system-owned
-- Diamond arena. Its native no-chip-money guard correctly refused construction.
-- Reproduced in the owned isolated acceptance catalog; the complete transaction
-- rolled back. Skip only Diamond club insertion in the original trigger owner.
-- The chip-club INSERT/ON CONFLICT path, owner, security and ACL stay unchanged.
-- No existing club/wallet/financial row is altered and every Diamond guard stays on.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_create_canonical_club_wallet()'::regprocedure)) = '7fa333e3b33038828af885b88382905c')
-- @live-proof: (SELECT pg_get_userbyid(proowner) = 'postgres' AND prosecdef AND proconfig = ARRAY['search_path=public, pg_temp'] AND proacl::text = '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_create_canonical_club_wallet()'::regprocedure)
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
DO $m$
DECLARE
 v_oid oid := 'public.fn_create_canonical_club_wallet()'::regprocedure;
 v_before text; v_after text; v_metadata jsonb; v_guards jsonb;
 v_old text := E'BEGIN\n  INSERT INTO public.club_wallets(club_id) VALUES(NEW.id)';
 v_new text := E'BEGIN\n  IF NEW.asset = ''diamonds'' THEN RETURN NEW; END IF;\n  INSERT INTO public.club_wallets(club_id) VALUES(NEW.id)';
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'definer',prosecdef,'config',proconfig,'acl',proacl)
 INTO STRICT v_before,v_metadata FROM pg_proc WHERE oid=v_oid;
 IF md5(v_before)<>'3d5c7f2002a00b8802e124213b53efaf' THEN RAISE EXCEPTION 'canonical wallet source preimage changed'; END IF;
 IF (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'canonical wallet insertion anchor changed';END IF;
 SELECT jsonb_object_agg(proname,md5(pg_get_functiondef(oid))) INTO v_guards FROM pg_proc WHERE proname IN('fn_poker_reject_diamond_chip_money','fn_poker_guard_arena_structure','fn_club_owner_has_a_player_wallet');
 v_after:=replace(v_before,v_old,v_new);EXECUTE v_after;
 IF replace(pg_get_functiondef(v_oid),v_new,v_old) IS DISTINCT FROM v_before OR md5(pg_get_functiondef(v_oid))<>'7fa333e3b33038828af885b88382905c' THEN RAISE EXCEPTION 'canonical wallet source postimage changed';END IF;
 IF (SELECT jsonb_build_object('owner',proowner,'definer',prosecdef,'config',proconfig,'acl',proacl) FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM v_metadata THEN RAISE EXCEPTION 'canonical wallet authority changed';END IF;
 IF (SELECT jsonb_object_agg(proname,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE proname IN('fn_poker_reject_diamond_chip_money','fn_poker_guard_arena_structure','fn_club_owner_has_a_player_wallet')) IS DISTINCT FROM v_guards THEN RAISE EXCEPTION 'Diamond guard changed';END IF;
END $m$;
COMMIT;
