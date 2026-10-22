-- 20261022061936_club_data_export_counts_cash_players_in_one_grouped_pass.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20261021202610 gave every cash table a correlated
-- count(DISTINCT user_id) over ca_club_data_fact. That table's only index is
-- (club_id, stat_date, game_id, user_id), so each per-table probe re-scans the
-- club's whole window: 1,433 tables in KINGS CLUB's 14-day window cost about
-- 30 s. #7686 moves the page core's count to its visible rows. The three
-- helpers behind the Club Data games CSV export (fn_ca_club_games ->
-- fn_ca_club_games_unsearched / fn_ca_club_games_searched, and
-- fn_ca_club_game_rows -> fn_ca_club_game_rows_filtered) still carry the same
-- correlated count: measured 2026-10-22, rows_filtered 28.6 s and
-- unsearched 51.2 s for that window.
--
-- Each helper now counts cash players ONCE per window in a grouped
-- cash_players CTE and joins it by game_id. Same rows, same filter, same
-- distinct-user rule (the sentinel user excluded): a pg_temp copy of
-- rows_filtered returned a byte-identical result for a closed 14-day window,
-- and its read fell from 28.6 s to 1.3 s. No money, permission, owner or
-- grant changes; CREATE OR REPLACE keeps every ACL.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $grouped_players$
DECLARE
 old_sub text := $k$(SELECT count(DISTINCT z.user_id)::integer FROM public.ca_club_data_fact z WHERE z.club_id=ANY(public.fn_ca_club_data_clubs($1)) AND z.stat_date BETWEEN $2 AND $3 AND z.kind='CASH' AND z.game_id=c.table_id AND z.user_id<>'00000000-0000-0000-0000-000000000000'::uuid) players FROM public.club_table_daily c$k$;
 new_sub text := $k$coalesce(max(cp.players),0)::integer players FROM public.club_table_daily c LEFT JOIN cash_players cp ON cp.game_id=c.table_id$k$;
 cte text := $k$cash_players AS MATERIALIZED (SELECT z.game_id,count(DISTINCT z.user_id)::integer players FROM public.ca_club_data_fact z WHERE z.club_id=ANY(public.fn_ca_club_data_clubs($1)) AND z.stat_date BETWEEN $2 AND $3 AND z.kind='CASH' AND z.user_id<>'00000000-0000-0000-0000-000000000000'::uuid GROUP BY z.game_id), $k$;
 item record;
 v_def text;
 v_acl text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
   ('public.fn_ca_club_games_searched(uuid,date,date,text,text,text)','ef010527ebfdd1f8e887c226f7ae2f34','WITH felt AS MATERIALIZED ('),
   ('public.fn_ca_club_games_unsearched(uuid,date,date,text,text)','6f1cfc64fa0ec875b3e5f88eed9f9187','WITH felt AS MATERIALIZED ('),
   ('public.fn_ca_club_game_rows_filtered(uuid,date,date,text,text,text,integer)','6327991a39cbc315c517d4c80340b053','WITH cash AS (')
 ) v(sig,hash,anchor) LOOP
  v_def := pg_get_functiondef(item.sig::regprocedure);
  IF md5(v_def) IS DISTINCT FROM item.hash THEN
   RAISE EXCEPTION 'CLUB_DATA_GROUPED_PLAYERS_PREIMAGE_CHANGED: %', item.sig;
  END IF;
  IF (length(v_def)-length(replace(v_def,old_sub,'')))/length(old_sub) <> 1
     OR (length(v_def)-length(replace(v_def,item.anchor,'')))/length(item.anchor) <> 1
     OR position('cash_players' IN v_def) > 0 THEN
   RAISE EXCEPTION 'CLUB_DATA_GROUPED_PLAYERS_ANCHORS_CHANGED: %', item.sig;
  END IF;
  SELECT coalesce(array_to_string(proacl,','),'') INTO v_acl FROM pg_proc WHERE oid=item.sig::regprocedure;
  EXECUTE replace(replace(v_def,old_sub,new_sub),item.anchor,replace(item.anchor,'WITH ','WITH '||cte));
  v_def := pg_get_functiondef(item.sig::regprocedure);
  IF position(old_sub IN v_def) > 0
     OR (length(v_def)-length(replace(v_def,'LEFT JOIN cash_players cp','')))/length('LEFT JOIN cash_players cp') <> 1
     OR (SELECT coalesce(array_to_string(proacl,','),'') FROM pg_proc WHERE oid=item.sig::regprocedure) IS DISTINCT FROM v_acl THEN
   RAISE EXCEPTION 'CLUB_DATA_GROUPED_PLAYERS_POSTIMAGE_CHANGED: %', item.sig;
  END IF;
 END LOOP;
END $grouped_players$;
COMMIT;
