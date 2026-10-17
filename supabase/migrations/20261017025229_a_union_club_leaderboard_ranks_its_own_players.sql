-- 20261017025229_a_union_club_leaderboard_ranks_its_own_players
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 02:52:29 UTC.
--
-- WHAT WAS WRONG
--
-- Shark Club's (and every union member club's) leaderboard showed "No
-- Rankings Yet For This Period" for Today, This Week and This Month while
-- All Time listed 510 players. fn_club_leaderboard_period_v2 ranks deltas of
-- public.player_stats (hands_dealt, total_winnings, total_losses,
-- tournaments_won, total_rake, sum_big_blind) for rows WHERE club_id =
-- p_club_id. The cash-hand projection
-- (fn_project_hand_side_effects_after_post_commit_20260908, projection 2)
-- folds hands_dealt / total_winnings / sum_big_blind into the row of the
-- TABLE's club, and a union's shared tables belong to the union root
-- (Midway Union fade0000-...). So a Shark player's cash play since the union
-- began sharing tables accrues on their Midway-root row, and their Shark row
-- stopped moving: on production 2026-10-17 Shark's 587 rows hold
-- hands_dealt 4,300,198 and total_winnings 53,949,447.22, identical in every
-- daily snapshot back to 2026-10-09, while the Midway root's rows moved from
-- 17,141,204 to 20,655,676 hands since 2026-10-10. hands_played and
-- total_rake on the Shark rows still grow because a different writer
-- (rakeback / refresh) attributes them per member club - which is why a
-- writer looked alive on some columns and dead on others. No writer is
-- stopped: the standalone club 2a1132b9-... is frozen only because it dealt
-- no hand in eight days, and the standalone club e14bc9f7-... ranks normally.
-- The gap is attribution, in the reader.
--
-- WHAT THIS CHANGES
--
-- Only fn_club_leaderboard_period_v2, and only for OPEN periods (daily,
-- weekly, monthly) of a club that belongs to a union (union_clubs row). Such
-- a club now ranks its own players - the Players page's home attribution:
-- the club each player joined first within the union - on their deltas
-- summed across the union's physical scope (the union root and every member
-- club), each scope club against its own baseline snapshot (latest on or
-- before the period start, else its first) and its own previous-day snapshot
-- for rank change. All Time, standalone clubs and the union root itself
-- (which has no union_clubs row) are byte-for-byte the previous query.
--
-- NO MONEY MOVES. Leaderboard prizes settle through fn_settle_due_leaderboards
-- -> fn_leaderboard_complete_round_basis over leaderboard_capture_counters;
-- neither reads this function, and closed rounds are displayed by
-- fn_club_leaderboard_by_dates from that same complete-capture basis, which
-- this migration does not touch. This function is a display and rank reader
-- (its only SQL caller is fn_user_rank_period). Shark Club, Club JAQK and the
-- Midway root have no club_leaderboard_settings row, no reward program
-- version and no leaderboard_payouts row on 2026-10-17.
--
-- PROOF (production, the new body compiled into pg_temp inside a rolled-back
-- transaction, compared to the live function with EXCEPT ALL both ways,
-- 2026-10-17 02:52 UTC):
--   Shark   daily 0 -> 428 ranked, weekly 0 -> 500, monthly 0 -> 509,
--           all_time 510 -> 510 (0 differing rows)
--   JAQK    daily 0 -> 1, weekly 0 -> 3, monthly 0 -> 4, all_time 511 -> 511 (0)
--   Midway root and standalone e14bc9f7: every period 0 differing rows
--
-- PRODUCTION PREIMAGE md5 e3f493cf57895d1ad32932497ea00b45
--
-- @live-proof: md5(pg_get_functiondef('public.fn_club_leaderboard_period_v2(uuid,text,text,integer,integer)'::regprocedure)) = '9c7467edd1c92389dc846a396492cafb'

BEGIN;

SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '0';

DO $union_club_leaderboard$
DECLARE
  v_sig constant regprocedure := 'public.fn_club_leaderboard_period_v2(uuid,text,text,integer,integer)'::regprocedure;
  v_def text;
  v_new_def text;
  v_owner name;
  v_definer boolean;
  v_volatility "char";
  v_config text;
  v_acl text;
  v_o1 constant text := $o1$  v_is_all_time boolean := p_period = 'all_time';
BEGIN
$o1$;
  v_n1 constant text := $n1$  v_is_all_time boolean := p_period = 'all_time';
  v_union uuid;
BEGIN
$n1$;
  v_o2 constant text := $o2$  RETURN QUERY
  WITH cur AS (
$o2$;
  v_n2 constant text := $n2$  -- A union member's open-period play is projected under the union's shared
  -- tables, not under the member club (2026-10-17). Rank the club's own
  -- players (the Players page's home attribution) on their play across the
  -- union's physical scope. All Time keeps the club's own rows.
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc
   WHERE uc.club_id = p_club_id LIMIT 1;

  RETURN QUERY
  WITH att_club AS MATERIALIZED (
    SELECT a.user_id FROM (
      SELECT DISTINCT ON(cm.user_id) cm.user_id,cm.club_id
        FROM public.club_members cm JOIN public.union_clubs uc
          ON uc.club_id=cm.club_id AND uc.union_id=v_union
       WHERE v_union IS NOT NULL AND NOT v_is_all_time
       ORDER BY cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id) a
     WHERE a.club_id=p_club_id
  ), union_scope AS MATERIALIZED (
    SELECT hc.club_id,
           COALESCE(
             (SELECT max(s.snapshot_date) FROM public.player_stats_snapshots s
               WHERE s.club_id = hc.club_id AND s.snapshot_date <= v_period_start),
             (SELECT min(s.snapshot_date) FROM public.player_stats_snapshots s
               WHERE s.club_id = hc.club_id)) AS baseline,
           (SELECT max(s.snapshot_date) FROM public.player_stats_snapshots s
             WHERE s.club_id = hc.club_id
               AND s.snapshot_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 1) AS prev_end
      FROM (
        SELECT v_union AS club_id WHERE v_union IS NOT NULL AND NOT v_is_all_time
        UNION
        SELECT uc.club_id FROM public.union_clubs uc
         WHERE v_union IS NOT NULL AND NOT v_is_all_time AND uc.union_id = v_union
      ) hc
  ), union_rows AS (
    SELECT ps.user_id AS uid,
           GREATEST(ps.hands_dealt-COALESCE(b.hands_dealt,0),0)::numeric AS d_hands,
           (ps.total_winnings-COALESCE(b.total_winnings,0)) AS d_win,
           (ps.total_losses-COALESCE(b.total_losses,0)) AS d_loss,
           GREATEST(ps.tournaments_won-COALESCE(b.tournaments_won,0),0)::numeric AS d_twon,
           GREATEST(ps.total_rake-COALESCE(b.total_rake,0),0) AS d_rake,
           GREATEST(ps.sum_big_blind-COALESCE(b.sum_big_blind,0),0) AS d_bb,
           (CASE WHEN pe.user_id IS NULL OR sc.prev_end <= sc.baseline THEN NULL ELSE GREATEST(pe.hands_dealt-COALESCE(pv.hands_dealt,0),0)::numeric END) AS p_hands,
           (CASE WHEN pe.user_id IS NULL OR sc.prev_end <= sc.baseline THEN NULL ELSE (pe.total_winnings-COALESCE(pv.total_winnings,0)) END) AS p_win,
           (CASE WHEN pe.user_id IS NULL OR sc.prev_end <= sc.baseline THEN NULL ELSE (pe.total_losses-COALESCE(pv.total_losses,0)) END) AS p_loss,
           (CASE WHEN pe.user_id IS NULL OR sc.prev_end <= sc.baseline THEN NULL ELSE GREATEST(pe.tournaments_won-COALESCE(pv.tournaments_won,0),0)::numeric END) AS p_twon,
           (CASE WHEN pe.user_id IS NULL OR sc.prev_end <= sc.baseline THEN NULL ELSE GREATEST(pe.sum_big_blind-COALESCE(pv.sum_big_blind,0),0) END) AS p_bb
      FROM union_scope sc
      JOIN public.player_stats ps ON ps.club_id = sc.club_id
      JOIN att_club a ON a.user_id = ps.user_id
      LEFT JOIN public.player_stats_snapshots b
        ON b.user_id=ps.user_id AND b.club_id=ps.club_id AND b.snapshot_date=sc.baseline
      LEFT JOIN public.player_stats_snapshots pe
        ON pe.user_id=ps.user_id AND pe.club_id=ps.club_id AND pe.snapshot_date=sc.prev_end
      LEFT JOIN public.player_stats_snapshots pv
        ON pv.user_id=ps.user_id AND pv.club_id=ps.club_id AND pv.snapshot_date=sc.baseline
  ), cur AS (
    SELECT u.uid,
           sum(u.d_hands) AS d_hands, sum(u.d_win) AS d_win, sum(u.d_loss) AS d_loss,
           sum(u.d_twon) AS d_twon, sum(u.d_rake) AS d_rake, sum(u.d_bb) AS d_bb,
           sum(u.p_hands) AS p_hands, sum(u.p_win) AS p_win, sum(u.p_loss) AS p_loss,
           sum(u.p_twon) AS p_twon, sum(u.p_bb) AS p_bb
      FROM union_rows u
     GROUP BY u.uid
    UNION ALL
$n2$;
  v_o3 constant text := $o3$     WHERE ps.club_id = p_club_id
  ),
$o3$;
  v_n3 constant text := $n3$     WHERE ps.club_id = p_club_id
       AND (v_union IS NULL OR v_is_all_time)
  ),
$n3$;
BEGIN
  SELECT pg_get_functiondef(p.oid), r.rolname, p.prosecdef, p.provolatile, p.proconfig::text, p.proacl::text
    INTO v_def, v_owner, v_definer, v_volatility, v_config, v_acl
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = v_sig;
  IF v_def IS NULL OR md5(v_def) IS DISTINCT FROM 'e3f493cf57895d1ad32932497ea00b45'
     OR v_owner IS DISTINCT FROM 'postgres' OR v_definer IS DISTINCT FROM true
     OR v_volatility IS DISTINCT FROM 's'::"char"
     OR v_config IS DISTINCT FROM '{"search_path=public, pg_temp"}'
     OR v_acl IS DISTINCT FROM '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_CLUB_LEADERBOARD_PREIMAGE: moved (md5 %, owner %, definer %, volatility %, config %, acl %)',
      md5(v_def), v_owner, v_definer, v_volatility, v_config, v_acl;
  END IF;
  IF (length(v_def) - length(replace(v_def, v_o1, ''))) / length(v_o1) <> 1
     OR (length(v_def) - length(replace(v_def, v_o2, ''))) / length(v_o2) <> 1
     OR (length(v_def) - length(replace(v_def, v_o3, ''))) / length(v_o3) <> 1 THEN
    RAISE EXCEPTION 'UNION_CLUB_LEADERBOARD_PREIMAGE: an anchor is not present exactly once';
  END IF;

  v_new_def := replace(replace(replace(v_def, v_o1, v_n1), v_o2, v_n2), v_o3, v_n3);
  IF md5(v_new_def) IS DISTINCT FROM '9c7467edd1c92389dc846a396492cafb' THEN
    RAISE EXCEPTION 'UNION_CLUB_LEADERBOARD_REWRITE: unexpected definition %', md5(v_new_def);
  END IF;

  EXECUTE v_new_def;

  SELECT pg_get_functiondef(p.oid), r.rolname, p.prosecdef, p.provolatile, p.proconfig::text, p.proacl::text
    INTO v_def, v_owner, v_definer, v_volatility, v_config, v_acl
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = v_sig;
  IF md5(v_def) IS DISTINCT FROM '9c7467edd1c92389dc846a396492cafb'
     OR v_owner IS DISTINCT FROM 'postgres' OR v_definer IS DISTINCT FROM true
     OR v_volatility IS DISTINCT FROM 's'::"char"
     OR v_config IS DISTINCT FROM '{"search_path=public, pg_temp"}'
     OR v_acl IS DISTINCT FROM '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     OR position('AND (v_union IS NULL OR v_is_all_time)' IN v_def) = 0
     OR position('WHERE v_union IS NOT NULL AND NOT v_is_all_time' IN v_def) = 0
     OR position($d$dp.status = 'deleted'$d$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'UNION_CLUB_LEADERBOARD_POSTIMAGE: definition or security contract moved (md5 %)', md5(v_def);
  END IF;
END
$union_club_leaderboard$;

COMMIT;
