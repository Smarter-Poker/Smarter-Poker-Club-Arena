-- Version reserved by scripts/new-migration.mjs, 20261022061048.
-- THE GAME PAGE COUNTS PLAYERS FOR THE ROWS IT SHOWS (2026-10-22).
-- 20261021202610 added a correlated count(DISTINCT user_id) over
-- ca_club_data_fact to raw_cash, so every cash table in the window was counted
-- before ranking. For KINGS CLUB's default fortnight that made
-- ca_club_game_page_core_20261006 take 33.5 s (ca_club_data_snapshot_v2 ~40 s);
-- Club Data Advanced exhausted its 12 s cold reads and showed "Ledger
-- Unavailable" (post-deploy club-data-deep, runs 39699204267 onward).
-- Players are not a sort or filter key. The count moves to the detail pass for
-- the <= p_limit visible cash rows, exactly as tournaments already do, keeping
-- greatest(window players, seated now). Probed in a rolled-back pg_temp copy:
-- identical rows and filtered_count for recent/fee and the union scope; 1.55 s.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer)'::regprocedure))='f51c7001fe55212c886c1fe15b34113d')
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $visible_players$
DECLARE
 v_sig regprocedure:='public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer)'::regprocedure;
 v_before text:=pg_get_functiondef('public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer)'::regprocedure);
 v_after text;
 a1 text:=E',\n             (SELECT count(DISTINCT z.user_id)::integer FROM public.ca_club_data_fact z WHERE z.club_id=ANY(public.fn_ca_club_data_clubs($1)) AND z.stat_date BETWEEN $2 AND $3 AND z.kind=''CASH'' AND z.game_id=c.table_id AND z.user_id<>''00000000-0000-0000-0000-000000000000''::uuid) players';
 a2 text:='greatest(coalesce(c.players,0),coalesce(f.seated,0))::integer players';
 b2 text:='coalesce(f.seated,0)::integer seated';
 a3 text:='CASE WHEN v.kind=''CASH'' THEN c.players ELSE COALESCE(tp.players,0)::integer END players';
 b3 text:='CASE WHEN v.kind=''CASH'' THEN greatest(COALESCE(cp.players,0),COALESCE(c.seated,0))::integer ELSE COALESCE(tp.players,0)::integer END players';
 a4 text:=E'        ) tp ON true\n    )';
 b4 text:=E'        ) tp ON true\n        LEFT JOIN LATERAL (\n          SELECT count(DISTINCT z.user_id)::integer players\n            FROM public.ca_club_data_fact z\n           WHERE v.kind=''CASH'' AND z.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND z.stat_date BETWEEN $2 AND $3\n             AND z.kind=''CASH'' AND z.game_id=v.id::uuid AND z.user_id<>''00000000-0000-0000-0000-000000000000''::uuid\n        ) cp ON true\n    )';
 v_acl text:=(SELECT proacl::text FROM pg_proc WHERE oid='public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer)'::regprocedure);
BEGIN
 IF md5(v_before) IS DISTINCT FROM 'f984aeca82629ed65207592aab028d2c' THEN
  RAISE EXCEPTION 'CLUB_GAME_PAGE_PREIMAGE_CHANGED'; END IF;
 IF (length(v_before)-length(replace(v_before,a1,'')))/length(a1)<>1
  OR (length(v_before)-length(replace(v_before,a2,'')))/length(a2)<>1
  OR (length(v_before)-length(replace(v_before,a3,'')))/length(a3)<>1
  OR (length(v_before)-length(replace(v_before,a4,'')))/length(a4)<>1 THEN
  RAISE EXCEPTION 'CLUB_GAME_PAGE_ANCHORS_CHANGED'; END IF;
 v_after:=replace(replace(replace(replace(v_before,a1,''),a2,b2),a3,b3),a4,b4);
 EXECUTE v_after;
 IF md5(pg_get_functiondef(v_sig)) IS DISTINCT FROM 'f51c7001fe55212c886c1fe15b34113d' THEN
  RAISE EXCEPTION 'CLUB_GAME_PAGE_POSTIMAGE_CHANGED'; END IF;
 IF (SELECT proacl::text FROM pg_proc WHERE oid=v_sig) IS DISTINCT FROM v_acl THEN
  RAISE EXCEPTION 'CLUB_GAME_PAGE_ACL_CHANGED'; END IF;
END $visible_players$;
COMMIT;
