-- 20261019145606_club_data_players_read_the_member_record
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-19 14:56:06 UTC.
--
-- WHAT WAS WRONG
--
-- The Club Data player list (ca_club_player_page -> its core
-- ca_club_player_page_core_20261006, the summary ca_club_player_breakdown and
-- the CSV export ca_club_player_export_start) disagreed with the Member record
-- (ca_club_member_detail) for the same member, club and days. Measured on
-- production 2026-10-19, UTC days 2026-10-13..2026-10-19, every member of the
-- five live clubs:
--
--   club                  active  hands differ  cash net differs  fees differ
--   Club JAQK                519           477               270          515
--   SHARK CLUB               525           474               271          515
--   Deep Stack Society       417           209               214          381
--   Midway Union (root)      262           262               195          105
--   Lightning Pilot           72            72                72           70
--
-- Three causes, all in the readers:
--   * Hands read club_member_daily_stats across the WHOLE union (the union
--     root plus every member club, 20261006012714). That was safe while each
--     union player was listed under one "home" club; since 20261017204111 the
--     list is every member of THIS club, so a player in JAQK and SHARK shows
--     all of their union hands on both pages. JAQK listed 11,029,028 hands; the
--     records file 5,675,876 to JAQK.
--   * Rake read union_rake_paid_daily_user, which is per player across the
--     whole union, and skips the current UTC day. JAQK listed 1,061,331.73;
--     the fees filed to JAQK are 613,351.83 (ca_club_member_fee_totals, which
--     matches the Club Data money facts ca_club_data_fact to within 0.3%).
--   * Cash net read ca_club_player_daily: cash-outs minus buy-ins on the day
--     the wallet moved. The record shows the result of the hands played that
--     day. A session that crosses midnight lands on different days; e.g.
--     member 005428fe on 2026-10-13: +474.45 on the list (bought in 165,
--     cashed out 639.45) against -169.86 won in that day's hands.
--
-- WHAT THIS CHANGES
--
-- In each of the three readers, only the wallet_pnl / rake / hand_clubs /
-- hands CTEs (exact text, md5-guarded):
--   * hands and cash net come from member_record_daily_facts for this club
--     with accounting_cutoff = fn_ca_launch_accounting_cutoff('club', club),
--     exactly as ca_member_record_daily_facts reads them for the record;
--   * rake comes from ca_club_member_fee_totals(club, start, end), the
--     record's own fee source (cash + tournament fees, from the fee counting
--     start 2026-10-12), which is live, so the breakdown's
--     rake_complete_through is now the end of the range;
--   * tournament net still comes from ca_club_player_daily; it already equals
--     the record's tournament money (member 005428fe, 10-13..10-18: -2,582.41
--     both).
-- Both sides use UTC days, so no date rule changes. Columns, sorting, the
-- keyset cursor, paging, search, horse masking, the deleted-account rule and
-- the access check (ca_can_view_whole_club_report) are untouched. Nothing is
-- written to any table; ca_club_player_daily, club_rake_daily_user and
-- union_rake_paid_daily_user (settlement inputs) are not touched.
--
-- Note: windows before a club's member records begin (Deep Stack 2026-10-04,
-- Lightning 2026-10-15) and fees before 2026-10-12 now read as the record
-- reads them.
--
-- @live-proof: position('public.member_record_daily_facts' in pg_get_functiondef('public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)'::regprocedure)) > 0 AND position('public.member_record_daily_facts' in pg_get_functiondef('public.ca_club_player_breakdown(uuid,date,date,integer)'::regprocedure)) > 0 AND position('public.member_record_daily_facts' in pg_get_functiondef('public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure)) > 0
-- @live-proof: position('union_rake_paid_daily_user' in pg_get_functiondef('public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)'::regprocedure)) = 0 AND position('union_rake_paid_daily_user' in pg_get_functiondef('public.ca_club_player_breakdown(uuid,date,date,integer)'::regprocedure)) = 0 AND position('union_rake_paid_daily_user' in pg_get_functiondef('public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure)) = 0
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';

DO $patch$
DECLARE d text; original text;
BEGIN
 SELECT pg_get_functiondef('public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)'::regprocedure) INTO original;
 IF md5(original)<>'c396ea690b937169ed836aeb7d1a0fb4' THEN
   RAISE EXCEPTION 'ca_club_player_page_core_20261006 preimage changed; qualify the current definition';
 END IF;
 d:=original;
 IF (length(d)-length(replace(d,$old$  ), wallet_pnl AS (
    SELECT d.user_id,SUM(d.cash_net) cash_net,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d
     WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.user_id
  ), rake AS (
    SELECT u.user_id,SUM(u.rake_amount) rake
      FROM public.union_rake_paid_daily_user u JOIN att_club a ON a.user_id=u.user_id
     WHERE v_union IS NOT NULL AND u.union_id=v_union AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
    UNION ALL
    SELECT c.user_id,SUM(c.rake_amount)
      FROM public.club_rake_daily_user c JOIN att_club a ON a.user_id=c.user_id
     WHERE v_union IS NULL AND c.club_id=p_club_id AND c.day BETWEEN v_start AND v_end GROUP BY c.user_id
  ), hand_clubs AS MATERIALIZED (
    SELECT p_club_id AS club_id WHERE v_union IS NULL
    UNION
    SELECT v_union WHERE v_union IS NOT NULL
    UNION
    SELECT uc.club_id FROM public.union_clubs uc
     WHERE v_union IS NOT NULL AND uc.union_id=v_union
  ), hands AS MATERIALIZED (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s
     WHERE s.club_id IN (SELECT hc.club_id FROM hand_clubs hc)
       AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
$old$,'')))/length($old$  ), wallet_pnl AS (
    SELECT d.user_id,SUM(d.cash_net) cash_net,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d
     WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.user_id
  ), rake AS (
    SELECT u.user_id,SUM(u.rake_amount) rake
      FROM public.union_rake_paid_daily_user u JOIN att_club a ON a.user_id=u.user_id
     WHERE v_union IS NOT NULL AND u.union_id=v_union AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
    UNION ALL
    SELECT c.user_id,SUM(c.rake_amount)
      FROM public.club_rake_daily_user c JOIN att_club a ON a.user_id=c.user_id
     WHERE v_union IS NULL AND c.club_id=p_club_id AND c.day BETWEEN v_start AND v_end GROUP BY c.user_id
  ), hand_clubs AS MATERIALIZED (
    SELECT p_club_id AS club_id WHERE v_union IS NULL
    UNION
    SELECT v_union WHERE v_union IS NOT NULL
    UNION
    SELECT uc.club_id FROM public.union_clubs uc
     WHERE v_union IS NOT NULL AND uc.union_id=v_union
  ), hands AS MATERIALIZED (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s
     WHERE s.club_id IN (SELECT hc.club_id FROM hand_clubs hc)
       AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
$old$)<>1 THEN
   RAISE EXCEPTION 'ca_club_player_page_core_20261006 source 1 not found exactly once';
 END IF;
 d:=replace(d,$old$  ), wallet_pnl AS (
    SELECT d.user_id,SUM(d.cash_net) cash_net,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d
     WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.user_id
  ), rake AS (
    SELECT u.user_id,SUM(u.rake_amount) rake
      FROM public.union_rake_paid_daily_user u JOIN att_club a ON a.user_id=u.user_id
     WHERE v_union IS NOT NULL AND u.union_id=v_union AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
    UNION ALL
    SELECT c.user_id,SUM(c.rake_amount)
      FROM public.club_rake_daily_user c JOIN att_club a ON a.user_id=c.user_id
     WHERE v_union IS NULL AND c.club_id=p_club_id AND c.day BETWEEN v_start AND v_end GROUP BY c.user_id
  ), hand_clubs AS MATERIALIZED (
    SELECT p_club_id AS club_id WHERE v_union IS NULL
    UNION
    SELECT v_union WHERE v_union IS NOT NULL
    UNION
    SELECT uc.club_id FROM public.union_clubs uc
     WHERE v_union IS NOT NULL AND uc.union_id=v_union
  ), hands AS MATERIALIZED (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s
     WHERE s.club_id IN (SELECT hc.club_id FROM hand_clubs hc)
       AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
$old$,$new$  ), record AS MATERIALIZED (
    -- Hands and cash results exactly as the Member record files them: the
    -- funded club, UTC days, this club's launch accounting cutoff.
    SELECT f.user_id,SUM(f.net) FILTER (WHERE NOT f.is_mtt) cash_net,SUM(f.hands)::bigint hands
      FROM public.member_record_daily_facts f
     WHERE f.club_id=p_club_id
       AND f.accounting_cutoff IS NOT DISTINCT FROM public.fn_ca_launch_accounting_cutoff('club',p_club_id)
       AND f.played_on BETWEEN v_start AND v_end
     GROUP BY f.user_id
  ), tournament_pnl AS (
    SELECT d.user_id,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d
     WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.user_id
  ), wallet_pnl AS (
    SELECT COALESCE(r.user_id,t.user_id) user_id,r.cash_net,t.tournament_net
      FROM record r FULL JOIN tournament_pnl t ON t.user_id=r.user_id
  ), rake AS (
    -- Fees exactly as the Member record counts them: cash and tournament
    -- fees filed to this club, from the fee counting start.
    SELECT t.user_id,t.total_fees rake
      FROM public.ca_club_member_fee_totals(p_club_id,v_start,v_end) t
  ), hands AS (
    SELECT r.user_id,r.hands FROM record r
$new$);
 IF md5(d)<>'495397d214459c3b0b25260791aa5002' THEN RAISE EXCEPTION 'ca_club_player_page_core_20261006 rewrite differs from the reviewed result'; END IF;
 EXECUTE d;
END $patch$;

DO $patch$
DECLARE d text; original text;
BEGIN
 SELECT pg_get_functiondef('public.ca_club_player_breakdown(uuid,date,date,integer)'::regprocedure) INTO original;
 IF md5(original)<>'7e66658450c17664dee186bb65e543f3' THEN
   RAISE EXCEPTION 'ca_club_player_breakdown preimage changed; qualify the current definition';
 END IF;
 d:=original;
 IF (length(d)-length(replace(d,$old$  ), wallet_pnl AS (
    SELECT d.user_id,SUM(d.cash_net) cash_net,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d WHERE d.club_id=p_club_id
       AND d.stat_date BETWEEN v_start AND v_end GROUP BY d.user_id
  ), rake AS (
    SELECT u.user_id,SUM(u.rake_amount) rake FROM public.union_rake_paid_daily_user u
      JOIN att_club a ON a.user_id=u.user_id WHERE v_union IS NOT NULL AND u.union_id=v_union
       AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
    UNION ALL
    SELECT c.user_id,SUM(c.rake_amount) FROM public.club_rake_daily_user c
      JOIN att_club a ON a.user_id=c.user_id WHERE v_union IS NULL AND c.club_id=p_club_id
       AND c.day BETWEEN v_start AND v_end GROUP BY c.user_id
  ), hand_clubs AS MATERIALIZED (
    SELECT p_club_id AS club_id WHERE v_union IS NULL
    UNION
    SELECT v_union WHERE v_union IS NOT NULL
    UNION
    SELECT uc.club_id FROM public.union_clubs uc
     WHERE v_union IS NOT NULL AND uc.union_id=v_union
  ), hands AS MATERIALIZED (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s
     WHERE s.club_id IN (SELECT hc.club_id FROM hand_clubs hc)
       AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
$old$,'')))/length($old$  ), wallet_pnl AS (
    SELECT d.user_id,SUM(d.cash_net) cash_net,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d WHERE d.club_id=p_club_id
       AND d.stat_date BETWEEN v_start AND v_end GROUP BY d.user_id
  ), rake AS (
    SELECT u.user_id,SUM(u.rake_amount) rake FROM public.union_rake_paid_daily_user u
      JOIN att_club a ON a.user_id=u.user_id WHERE v_union IS NOT NULL AND u.union_id=v_union
       AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
    UNION ALL
    SELECT c.user_id,SUM(c.rake_amount) FROM public.club_rake_daily_user c
      JOIN att_club a ON a.user_id=c.user_id WHERE v_union IS NULL AND c.club_id=p_club_id
       AND c.day BETWEEN v_start AND v_end GROUP BY c.user_id
  ), hand_clubs AS MATERIALIZED (
    SELECT p_club_id AS club_id WHERE v_union IS NULL
    UNION
    SELECT v_union WHERE v_union IS NOT NULL
    UNION
    SELECT uc.club_id FROM public.union_clubs uc
     WHERE v_union IS NOT NULL AND uc.union_id=v_union
  ), hands AS MATERIALIZED (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s
     WHERE s.club_id IN (SELECT hc.club_id FROM hand_clubs hc)
       AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
$old$)<>1 THEN
   RAISE EXCEPTION 'ca_club_player_breakdown source 1 not found exactly once';
 END IF;
 d:=replace(d,$old$  ), wallet_pnl AS (
    SELECT d.user_id,SUM(d.cash_net) cash_net,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d WHERE d.club_id=p_club_id
       AND d.stat_date BETWEEN v_start AND v_end GROUP BY d.user_id
  ), rake AS (
    SELECT u.user_id,SUM(u.rake_amount) rake FROM public.union_rake_paid_daily_user u
      JOIN att_club a ON a.user_id=u.user_id WHERE v_union IS NOT NULL AND u.union_id=v_union
       AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
    UNION ALL
    SELECT c.user_id,SUM(c.rake_amount) FROM public.club_rake_daily_user c
      JOIN att_club a ON a.user_id=c.user_id WHERE v_union IS NULL AND c.club_id=p_club_id
       AND c.day BETWEEN v_start AND v_end GROUP BY c.user_id
  ), hand_clubs AS MATERIALIZED (
    SELECT p_club_id AS club_id WHERE v_union IS NULL
    UNION
    SELECT v_union WHERE v_union IS NOT NULL
    UNION
    SELECT uc.club_id FROM public.union_clubs uc
     WHERE v_union IS NOT NULL AND uc.union_id=v_union
  ), hands AS MATERIALIZED (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s
     WHERE s.club_id IN (SELECT hc.club_id FROM hand_clubs hc)
       AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
$old$,$new$  ), record AS MATERIALIZED (
    -- Hands and cash results exactly as the Member record files them: the
    -- funded club, UTC days, this club's launch accounting cutoff.
    SELECT f.user_id,SUM(f.net) FILTER (WHERE NOT f.is_mtt) cash_net,SUM(f.hands)::bigint hands
      FROM public.member_record_daily_facts f
     WHERE f.club_id=p_club_id
       AND f.accounting_cutoff IS NOT DISTINCT FROM public.fn_ca_launch_accounting_cutoff('club',p_club_id)
       AND f.played_on BETWEEN v_start AND v_end
     GROUP BY f.user_id
  ), tournament_pnl AS (
    SELECT d.user_id,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d
     WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.user_id
  ), wallet_pnl AS (
    SELECT COALESCE(r.user_id,t.user_id) user_id,r.cash_net,t.tournament_net
      FROM record r FULL JOIN tournament_pnl t ON t.user_id=r.user_id
  ), rake AS (
    -- Fees exactly as the Member record counts them: cash and tournament
    -- fees filed to this club, from the fee counting start.
    SELECT t.user_id,t.total_fees rake
      FROM public.ca_club_member_fee_totals(p_club_id,v_start,v_end) t
  ), hands AS (
    SELECT r.user_id,r.hands FROM record r
$new$);
 IF (length(d)-length(replace(d,$old$'rake_complete_through',LEAST(v_end,v_today-1),$old$,'')))/length($old$'rake_complete_through',LEAST(v_end,v_today-1),$old$)<>1 THEN
   RAISE EXCEPTION 'ca_club_player_breakdown source 2 not found exactly once';
 END IF;
 d:=replace(d,$old$'rake_complete_through',LEAST(v_end,v_today-1),$old$,$new$'rake_complete_through',v_end,$new$);
 IF md5(d)<>'617b01bce9519650c5bf9982acaa3a2b' THEN RAISE EXCEPTION 'ca_club_player_breakdown rewrite differs from the reviewed result'; END IF;
 EXECUTE d;
END $patch$;

DO $patch$
DECLARE d text; original text;
BEGIN
 SELECT pg_get_functiondef('public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure) INTO original;
 IF md5(original)<>'9a2aeafafc9fd9a527ff2800b5e5d394' THEN
   RAISE EXCEPTION 'ca_club_player_export_start preimage changed; qualify the current definition';
 END IF;
 d:=original;
 IF (length(d)-length(replace(d,$old$  ), wallet_pnl AS (
    SELECT d.user_id,SUM(d.cash_net) cash_net,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d
     WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.user_id
  ), rake AS (
    SELECT u.user_id,SUM(u.rake_amount) rake
      FROM public.union_rake_paid_daily_user u JOIN att_club a ON a.user_id=u.user_id
     WHERE v_union IS NOT NULL AND u.union_id=v_union AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
    UNION ALL
    SELECT c.user_id,SUM(c.rake_amount)
      FROM public.club_rake_daily_user c JOIN att_club a ON a.user_id=c.user_id
     WHERE v_union IS NULL AND c.club_id=p_club_id AND c.day BETWEEN v_start AND v_end GROUP BY c.user_id
  ), hand_clubs AS MATERIALIZED (
    SELECT p_club_id AS club_id WHERE v_union IS NULL
    UNION
    SELECT v_union WHERE v_union IS NOT NULL
    UNION
    SELECT uc.club_id FROM public.union_clubs uc
     WHERE v_union IS NOT NULL AND uc.union_id=v_union
  ), hands AS MATERIALIZED (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s
     WHERE s.club_id IN (SELECT hc.club_id FROM hand_clubs hc)
       AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
$old$,'')))/length($old$  ), wallet_pnl AS (
    SELECT d.user_id,SUM(d.cash_net) cash_net,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d
     WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.user_id
  ), rake AS (
    SELECT u.user_id,SUM(u.rake_amount) rake
      FROM public.union_rake_paid_daily_user u JOIN att_club a ON a.user_id=u.user_id
     WHERE v_union IS NOT NULL AND u.union_id=v_union AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
    UNION ALL
    SELECT c.user_id,SUM(c.rake_amount)
      FROM public.club_rake_daily_user c JOIN att_club a ON a.user_id=c.user_id
     WHERE v_union IS NULL AND c.club_id=p_club_id AND c.day BETWEEN v_start AND v_end GROUP BY c.user_id
  ), hand_clubs AS MATERIALIZED (
    SELECT p_club_id AS club_id WHERE v_union IS NULL
    UNION
    SELECT v_union WHERE v_union IS NOT NULL
    UNION
    SELECT uc.club_id FROM public.union_clubs uc
     WHERE v_union IS NOT NULL AND uc.union_id=v_union
  ), hands AS MATERIALIZED (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s
     WHERE s.club_id IN (SELECT hc.club_id FROM hand_clubs hc)
       AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
$old$)<>1 THEN
   RAISE EXCEPTION 'ca_club_player_export_start source 1 not found exactly once';
 END IF;
 d:=replace(d,$old$  ), wallet_pnl AS (
    SELECT d.user_id,SUM(d.cash_net) cash_net,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d
     WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.user_id
  ), rake AS (
    SELECT u.user_id,SUM(u.rake_amount) rake
      FROM public.union_rake_paid_daily_user u JOIN att_club a ON a.user_id=u.user_id
     WHERE v_union IS NOT NULL AND u.union_id=v_union AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
    UNION ALL
    SELECT c.user_id,SUM(c.rake_amount)
      FROM public.club_rake_daily_user c JOIN att_club a ON a.user_id=c.user_id
     WHERE v_union IS NULL AND c.club_id=p_club_id AND c.day BETWEEN v_start AND v_end GROUP BY c.user_id
  ), hand_clubs AS MATERIALIZED (
    SELECT p_club_id AS club_id WHERE v_union IS NULL
    UNION
    SELECT v_union WHERE v_union IS NOT NULL
    UNION
    SELECT uc.club_id FROM public.union_clubs uc
     WHERE v_union IS NOT NULL AND uc.union_id=v_union
  ), hands AS MATERIALIZED (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s
     WHERE s.club_id IN (SELECT hc.club_id FROM hand_clubs hc)
       AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
$old$,$new$  ), record AS MATERIALIZED (
    -- Hands and cash results exactly as the Member record files them: the
    -- funded club, UTC days, this club's launch accounting cutoff.
    SELECT f.user_id,SUM(f.net) FILTER (WHERE NOT f.is_mtt) cash_net,SUM(f.hands)::bigint hands
      FROM public.member_record_daily_facts f
     WHERE f.club_id=p_club_id
       AND f.accounting_cutoff IS NOT DISTINCT FROM public.fn_ca_launch_accounting_cutoff('club',p_club_id)
       AND f.played_on BETWEEN v_start AND v_end
     GROUP BY f.user_id
  ), tournament_pnl AS (
    SELECT d.user_id,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d
     WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.user_id
  ), wallet_pnl AS (
    SELECT COALESCE(r.user_id,t.user_id) user_id,r.cash_net,t.tournament_net
      FROM record r FULL JOIN tournament_pnl t ON t.user_id=r.user_id
  ), rake AS (
    -- Fees exactly as the Member record counts them: cash and tournament
    -- fees filed to this club, from the fee counting start.
    SELECT t.user_id,t.total_fees rake
      FROM public.ca_club_member_fee_totals(p_club_id,v_start,v_end) t
  ), hands AS (
    SELECT r.user_id,r.hands FROM record r
$new$);
 IF md5(d)<>'49080407d0dcc423ab45fa22f0f39e1b' THEN RAISE EXCEPTION 'ca_club_player_export_start rewrite differs from the reviewed result'; END IF;
 EXECUTE d;
END $patch$;

COMMIT;
