-- Version reserved by scripts/new-migration.mjs, 20261021221536.
-- Restore the existing invoker count after clubs adopted column-level privacy.
-- The count needs only id, union_id and asset. Do not read protected finances,
-- widen grants, change RLS, bypass the established RPC or alter player counting.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.get_club_players_playing(text)'::regprocedure))='7c6c3eb4ea92dc4473747b67a2acd963')
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $arena_public_columns$
DECLARE
 v_before text := pg_get_functiondef('public.get_club_players_playing(text)'::regprocedure);
 v_after text;
 v_old text := 'SELECT * INTO v_club FROM public.clubs';
 v_new text := 'SELECT id, union_id, asset INTO v_club.id, v_club.union_id, v_club.asset FROM public.clubs';
BEGIN
 IF md5(v_before) IS DISTINCT FROM '7474b224a9d03eae171abd6dbe5052a6' THEN
  RAISE EXCEPTION 'ARENA_PUBLIC_COLUMNS_PREIMAGE_CHANGED';
 END IF;
 IF (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old) <> 3 THEN
  RAISE EXCEPTION 'ARENA_PUBLIC_COLUMNS_LOOKUP_SET_CHANGED';
 END IF;
 v_after := replace(v_before,v_old,v_new);
 IF replace(v_after,v_new,v_old) IS DISTINCT FROM v_before THEN
  RAISE EXCEPTION 'ARENA_PUBLIC_COLUMNS_REVERSE_CHANGED';
 END IF;
 EXECUTE v_after;
 IF md5(pg_get_functiondef('public.get_club_players_playing(text)'::regprocedure)) IS DISTINCT FROM '7c6c3eb4ea92dc4473747b67a2acd963' THEN
  RAISE EXCEPTION 'ARENA_PUBLIC_COLUMNS_POSTIMAGE_CHANGED';
 END IF;
END $arena_public_columns$;
COMMIT;
