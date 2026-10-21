-- Club Data: exact MTT classification and authorized union-wide scope.
-- Read-only reporting definitions; no balances, prizes, fees or ledger rows change.
-- UTC net money flow is credits minus entries, plus cash still on the felt.
-- The union identity includes each member club once plus its direct account.
-- @live-proof: position('fn_ca_club_data_clubs' IN pg_get_functiondef('public.ca_club_data_screen(uuid,date,date,text,text,text,integer)'::regprocedure))>0
-- @live-proof: position('v_mtt_win' IN pg_get_functiondef('public.ca_club_data_screen(uuid,date,date,text,text,text,integer)'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='45s';
DO $guard$ DECLARE expected record; actual text; BEGIN
 IF to_regprocedure('public.fn_ca_club_data_clubs(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Club Data correction already installed'; END IF;
 IF md5(pg_get_functiondef('public.ca_club_data_screen(uuid,date,date,text,text,text,integer)'::regprocedure))<>'4d5395ef6cf7af32da37b18ab7fb41b1' THEN RAISE EXCEPTION 'Club Data screen preimage changed'; END IF;
 FOR expected IN SELECT * FROM (VALUES ('fn_ca_club_data_scope','7022f13a854fbaa7684b93cf6aae1868'),('ca_club_data_screen','4d5395ef6cf7af32da37b18ab7fb41b1'),('fn_ca_club_cash_felt','7c16aa54bad4612afbe7bdd7d5b82e43'),('fn_ca_club_games','76d0b8f01e9a3b1f0956c8eb293633c2'),('fn_ca_club_games_searched','ed86cc8ecf0ab2c32755a65c8f797af7'),('fn_ca_club_games_unsearched','94c2b97d6df043ada9337fd25a0d39be'),('fn_ca_club_game_rows_filtered','353bc956a6ec2c8ab70a7fa67e1ce835'),('fn_ca_club_game_rows','97180802749f9963f8e973f740e84bb1'),('fn_ca_club_game_summary_filtered','01d7d260c52226978da9cb9c56db0cf2'),('fn_ca_club_game_summary','82a77e6208196fbfd33acb1dd149cd96'),('ca_club_game_page_core_20261006','aeef4d24b6e39308350217029ba01415'),('ca_club_data_snapshot','4c94b72310edd7fd63de7329a5b87239'),('ca_club_player_breakdown','617b01bce9519650c5bf9982acaa3a2b'),('ca_club_player_page_core_20261006','495397d214459c3b0b25260791aa5002')) v(name,hash) LOOP
  SELECT md5(pg_get_functiondef(p.oid)) INTO actual FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=expected.name;
  IF actual IS DISTINCT FROM expected.hash THEN RAISE EXCEPTION 'Reporting preimage changed: %',expected.name; END IF;
 END LOOP;
 IF current_user NOT IN ('postgres','supabase_admin') THEN
   RAISE EXCEPTION 'club data migration requires the maintained installer';
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_data_clubs(p_club_id uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $function$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM public.unions u WHERE u.id=p_club_id)
 THEN ARRAY(SELECT x.id FROM (SELECT p_club_id id UNION SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=p_club_id) x ORDER BY x.id)
 ELSE ARRAY[p_club_id] END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_clubs(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_club_data_hand_count(p_club_id uuid,p_start date,p_end date,p_game text,p_stakes text,p_search text)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $function$
 WITH eligible AS (
  SELECT DISTINCT d.table_id FROM public.club_table_daily d
   JOIN public.tables t ON t.id=d.table_id LEFT JOIN public.profiles pr ON pr.id=t.created_by
  WHERE d.club_id=ANY(public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN p_start AND p_end
    AND (p_game='ALL' OR p_game=CASE WHEN coalesce(t.game_variant,'') ILIKE '%plo%' OR coalesce(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA' WHEN coalesce(t.game_variant,'') ILIKE '%mixed%' OR coalesce(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED' ELSE 'HOLDEM' END)
    AND (p_stakes='ALL' OR p_stakes=CASE WHEN coalesce(t.big_blind,0)<1 THEN 'MICRO' WHEN coalesce(t.big_blind,0)<5 THEN 'SMALL' WHEN coalesce(t.big_blind,0)<25 THEN 'MID' ELSE 'HIGH' END)
    AND (p_search IS NULL OR t.name ILIKE '%'||p_search||'%' OR t.id::text ILIKE '%'||p_search||'%' OR pr.username ILIKE '%'||p_search||'%')
 )
 SELECT CASE WHEN EXISTS(SELECT 1 FROM public.unions WHERE id=p_club_id) THEN
  (SELECT count(*) FROM public.rake_records r JOIN eligible e ON e.table_id=r.table_id
    WHERE r.created_at>=p_start::timestamp AT TIME ZONE 'UTC' AND r.created_at<(p_end+1)::timestamp AT TIME ZONE 'UTC'
      AND r.tournament_id IS NULL AND NOT coalesce(r.is_tournament,false))
 ELSE (SELECT coalesce(sum(d.hands),0)::bigint FROM public.club_table_daily d JOIN eligible e ON e.table_id=d.table_id
   WHERE d.club_id=p_club_id AND d.stat_date BETWEEN p_start AND p_end) END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_hand_count(uuid,date,date,text,text,text) FROM PUBLIC,anon,authenticated,service_role;


-- Union identity is an aggregate only for a union overseer, never an ordinary
-- member-club owner or an agent. Service/installer reads keep their existing role.
CREATE OR REPLACE FUNCTION public.fn_ca_club_data_scope(p_club_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $function$
 SELECT CASE
 WHEN session_user IN ('postgres','supabase_admin') OR coalesce(auth.role(),'')='service_role' THEN 'club'
 WHEN auth.uid() IS NULL THEN NULL
 WHEN EXISTS(SELECT 1 FROM public.unions u WHERE u.id=p_club_id)
   THEN CASE WHEN public.ca_can_oversee_union(p_club_id) THEN 'club' ELSE NULL END
 WHEN EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.owner_id=auth.uid())
   OR EXISTS(SELECT 1 FROM public.profiles pr WHERE pr.id=auth.uid() AND coalesce(pr.is_admin,false)) THEN 'club'
 WHEN EXISTS(SELECT 1 FROM public.club_members cm WHERE cm.club_id=p_club_id AND cm.user_id=auth.uid()
   AND coalesce(cm.status,'active') NOT IN ('banned','suspended') AND cm.role IN ('owner','co_owner','admin')
   AND public.fn_cashier_member_is_active(cm.club_id,cm.user_id)) THEN 'club'
 WHEN EXISTS(SELECT 1 FROM public.club_members cm WHERE cm.club_id=p_club_id AND cm.user_id=auth.uid()
   AND coalesce(cm.status,'active') NOT IN ('banned','suspended') AND cm.role IN ('super_agent','agent','sub_agent')
   AND public.fn_cashier_member_is_active(cm.club_id,cm.user_id)) THEN 'downline'
 ELSE NULL END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_data_screen(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '64MB'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start date := COALESCE(p_start, v_end);
  v_game text := UPPER(COALESCE(NULLIF(p_game, ''), 'ALL'));
  v_stakes text := UPPER(COALESCE(NULLIF(p_stakes, ''), 'ALL'));
  v_q text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_lim int := GREATEST(LEAST(COALESCE(p_limit, 200), 500), 1);
  v_scope text := public.fn_ca_club_data_scope(p_club_id);
  v_attrs boolean;
  v_mtt_win numeric; v_mtt_fee numeric;
  v_users uuid[];
  v_role text;
  v_club_name text;
  v_union uuid;
  v_facts_from date;
  v_sum jsonb;
  v_rows jsonb;
  v_days date[];
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_games bigint; v_cash_fee numeric; v_tour_fee numeric; v_cash_win numeric; v_tour_win numeric;
  v_felt_ids uuid[]; v_felt_amt numeric[]; v_felt_seated int[]; v_felt_sum numeric;
  v_live_t uuid[]; v_cands uuid[]; v_need int; v_day date;
BEGIN
  IF v_scope IS NULL THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;
  IF v_start < v_end - 92 THEN v_start := v_end - 92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  IF v_scope = 'downline' THEN
    v_users := public.fn_ca_club_data_downline(p_club_id, auth.uid());
  END IF;
  -- Tournament attributes for every game only when a filter reads them.
  v_attrs := v_game IN ('MTT', 'SNG') OR v_q IS NOT NULL;
  SELECT c.name INTO v_club_name FROM public.clubs c WHERE c.id = p_club_id;
  SELECT cm.role INTO v_role FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = auth.uid()
   ORDER BY public.fn_club_role_rank(cm.role) DESC LIMIT 1;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id = p_club_id LIMIT 1;
  IF EXISTS(SELECT 1 FROM public.unions u WHERE u.id=p_club_id) THEN v_union:=p_club_id; END IF;
  v_facts_from := public.fn_ca_club_data_facts_from();
  v_days := ARRAY(SELECT gs::date FROM generate_series(v_start, v_end, interval '1 day') gs);

  IF v_game = 'ALL' AND v_stakes = 'ALL' AND v_q IS NULL THEN
    -- THE PLAIN SCREEN (20261017221938). Measured on production at 22:20 UTC,
    -- Club JAQK, 14 days: 3.79 s through the one-query form below, because
    -- the totals grouped 450,000 fact rows into 248,000 games to pick 200 of
    -- them, and the per-game player count was planned as a range scan per
    -- game. Here:
    --   * the totals are one aggregate over the window, never grouped by game;
    --   * the page's rows are chosen from the most recent days first - every
    --     fact's last_at falls on its own stat_date, so a game seen on a later
    --     day outranks every game seen only earlier, and the order is exact;
    --   * only those rows are totalled, counted and described, by exact
    --     (club, day, game) lookups.
    SELECT array_agg(x.table_id), array_agg(x.felt), array_agg(x.seated), COALESCE(SUM(x.felt), 0)
      INTO v_felt_ids, v_felt_amt, v_felt_seated, v_felt_sum
      FROM (
        -- Chips still in front of this club's seated players: part of the
        -- result, not a loss. The seat's own club, as the money was.
        SELECT s.table_id, SUM(s.stack) AS felt, count(*)::int AS seated
          FROM public.table_seats s
          JOIN public.tables t ON t.id = s.table_id AND t.tournament_id IS NULL
         WHERE s.left_at IS NULL AND s.user_id IS NOT NULL
           AND COALESCE(s.status, 'active') <> 'left' AND COALESCE(s.stack, 0) > 0
           AND (s.joined_at AT TIME ZONE 'UTC')::date BETWEEN v_start AND v_end
           AND COALESCE(s.club_id, public.fn_ca_cash_reporting_club(t.union_id, t.club_id, s.user_id)) = ANY (public.fn_ca_club_data_clubs(p_club_id))
           AND (v_users IS NULL OR s.user_id = ANY (v_users))
         GROUP BY s.table_id) x;
    v_felt_ids := COALESCE(v_felt_ids, ARRAY[]::uuid[]);

    SELECT count(DISTINCT d.game_id),
           COALESCE(SUM(d.fee) FILTER (WHERE d.kind = 'CASH'), 0),
           COALESCE(SUM(d.fee) FILTER (WHERE d.kind <> 'CASH'), 0),
           COALESCE(SUM(d.winnings) FILTER (WHERE d.kind = 'CASH'), 0),
           COALESCE(SUM(d.winnings) FILTER (WHERE d.kind <> 'CASH'), 0)
      INTO v_games, v_cash_fee, v_tour_fee, v_cash_win, v_tour_win
      FROM public.ca_club_data_fact d
     WHERE d.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN v_start AND v_end
       AND (v_users IS NULL OR d.user_id = ANY (v_users));
    SELECT coalesce(sum(d.winnings),0),coalesce(sum(d.fee),0) INTO v_mtt_win,v_mtt_fee
      FROM public.ca_club_data_fact d JOIN public.tournaments tr ON tr.id=d.game_id AND tr.tournament_type='MTT'
     WHERE d.club_id=ANY(public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN v_start AND v_end
       AND d.kind='TOURNAMENT' AND (v_users IS NULL OR d.user_id=ANY(v_users));
    -- A seated table with no fact in the window is still a game on the screen.
    v_games := v_games + (SELECT count(*) FROM unnest(v_felt_ids) ft(id)
      WHERE NOT EXISTS (SELECT 1 FROM public.ca_club_data_fact f
                         WHERE f.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND f.stat_date = ANY (v_days) AND f.game_id = ft.id
                           AND (v_users IS NULL OR f.user_id = ANY (v_users))));

    -- Running tournaments this club (or this agent's downline) played in.
    v_live_t := ARRAY(
      SELECT tr.id FROM public.tournaments tr
       WHERE tr.status = 'RUNNING'
         AND EXISTS (SELECT 1 FROM public.ca_club_data_fact f
                      WHERE f.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND f.stat_date = ANY (v_days) AND f.game_id = tr.id
                        AND (v_users IS NULL OR f.user_id = ANY (v_users))));

    -- The page: every live game, then the most recently active, newest day first.
    v_cands := v_felt_ids || v_live_t;
    v_need := v_lim;
    FOR v_day IN SELECT u.d FROM unnest(v_days) u(d) ORDER BY u.d DESC LOOP
      v_cands := v_cands || ARRAY(
        SELECT f.game_id FROM public.ca_club_data_fact f
         WHERE f.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND f.stat_date = v_day
           AND (v_users IS NULL OR f.user_id = ANY (v_users))
           AND NOT (f.game_id = ANY (v_cands))
         GROUP BY f.game_id ORDER BY max(f.last_at) DESC LIMIT v_need);
      v_need := v_lim - (cardinality(v_cands) - cardinality(v_felt_ids) - cardinality(v_live_t));
      EXIT WHEN v_need <= 0;
    END LOOP;

    WITH c AS (
      SELECT f.kind, f.game_id, SUM(f.fee) AS fee, SUM(f.winnings) AS winnings, max(f.last_at) AS activity_at,
             count(DISTINCT f.user_id) FILTER (WHERE f.user_id <> v_zero) AS players
        FROM public.ca_club_data_fact f
       WHERE f.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND f.stat_date = ANY (v_days) AND f.game_id = ANY (v_cands)
         AND (v_users IS NULL OR f.user_id = ANY (v_users))
       GROUP BY f.kind, f.game_id
    ), fe AS (
      SELECT x.table_id, x.felt, x.seated
        FROM unnest(v_felt_ids, COALESCE(v_felt_amt, ARRAY[]::numeric[]), COALESCE(v_felt_seated, ARRAY[]::int[])) AS x(table_id, felt, seated)
    ), rows_ AS (
      SELECT COALESCE(c.kind, 'CASH') AS k, COALESCE(c.game_id, fe.table_id) AS game_id,
             COALESCE(c.fee, 0) AS fee, COALESCE(c.winnings, 0) + COALESCE(fe.felt, 0) AS winnings,
             COALESCE(c.activity_at, now()) AS activity_at,
             (fe.table_id IS NOT NULL OR (c.kind = 'TOURNAMENT' AND c.game_id = ANY (v_live_t))) AS live,
             fe.seated, fe.felt AS on_felt, COALESCE(c.players, 0) AS players
        FROM c FULL JOIN fe ON fe.table_id = c.game_id
    ), top AS (
      SELECT * FROM rows_ ORDER BY live DESC, activity_at DESC NULLS LAST, k, game_id LIMIT v_lim
    ), described AS (
      SELECT CASE WHEN tp.k = 'CASH' THEN 'CASH'
                  WHEN tr.tournament_type = 'SPIN' THEN 'SPIN'
                  WHEN tr.tournament_type = 'SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END AS kind,
             tp.game_id::text AS id,
             CASE WHEN tp.k = 'CASH' THEN COALESCE(t.name, 'Unnamed') ELSE COALESCE(tr.name, 'Tournament') END AS name,
             CASE WHEN tp.k = 'CASH' THEN UPPER(COALESCE(t.game_variant, 'nlh'))
                  ELSE UPPER(COALESCE(tr.variant, tr.game_type, 'nlh')) END AS variant,
             CASE WHEN tp.k = 'CASH' THEN
                    CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                         WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                         ELSE 'HOLDEM' END
                  WHEN tr.tournament_type = 'SPIN' THEN 'SPIN' WHEN tr.tournament_type = 'SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END AS game_class,
             CASE WHEN tp.k <> 'CASH' THEN 'NA'
                  WHEN COALESCE(t.big_blind,0) < 1 THEN 'MICRO'
                  WHEN COALESCE(t.big_blind,0) < 5 THEN 'SMALL'
                  WHEN COALESCE(t.big_blind,0) < 25 THEN 'MID' ELSE 'HIGH' END AS stakes_tier,
             CASE WHEN tp.k = 'CASH' AND COALESCE(t.big_blind,0) > 0 THEN
               trim(trailing '.' from trim(trailing '0' from COALESCE(t.small_blind,0)::text)) || '/' ||
               trim(trailing '.' from trim(trailing '0' from t.big_blind::text)) END AS blinds,
             CASE WHEN tp.k = 'CASH' THEN t.created_at ELSE tr.start_time END AS started_at,
             CASE WHEN tp.k = 'CASH' THEN t.status ELSE tr.status END AS status,
             CASE WHEN tp.k = 'CASH' THEN COALESCE(pr.username, '') ELSE '' END AS creator_name,
             round(tp.fee, 2) AS fee, round(tp.winnings, 2) AS winnings,
             GREATEST(tp.players, COALESCE(tp.seated, 0))::int AS players,
             tp.activity_at, tp.live, tp.seated, round(tp.on_felt, 2) AS on_felt, tp.k
        FROM top tp
        LEFT JOIN public.tables t ON tp.k = 'CASH' AND t.id = tp.game_id
        LEFT JOIN public.profiles pr ON pr.id = t.created_by
        LEFT JOIN public.tournaments tr ON tp.k = 'TOURNAMENT' AND tr.id = tp.game_id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'kind', kind, 'id', id, 'name', name, 'variant', variant,
             'game_class', game_class, 'stakes_tier', stakes_tier, 'blinds', blinds,
             'started_at', started_at, 'activity_at', activity_at, 'status', status,
             'creator_name', NULLIF(creator_name, ''), 'fee', COALESCE(fee, 0),
             'winnings', COALESCE(winnings, 0), 'players', COALESCE(players, 0),
             'live', live, 'seated', seated, 'on_felt', on_felt)
             ORDER BY live DESC, activity_at DESC NULLS LAST, k, id), '[]'::jsonb)
      INTO v_rows FROM described;

    v_sum := jsonb_build_object(
      'games', v_games,
      'total_winnings', round(v_cash_win + v_tour_win + v_felt_sum, 2),
      'mtt_winnings', round(v_mtt_win, 2), 'tournament_winnings', round(v_tour_win,2),
      'cash_winnings', round(v_cash_win + v_felt_sum, 2),
      'fee', round(v_cash_fee + v_tour_fee, 2),
      'cash_fee', round(v_cash_fee, 2),
      'mtt_fee', round(v_mtt_fee, 2), 'tournament_fee', round(v_tour_fee,2),
      'on_felt', round(v_felt_sum, 2),
      'live_games', cardinality(v_felt_ids) + cardinality(v_live_t));

    RETURN jsonb_build_object(
      'range', jsonb_build_object('start', v_start, 'end', v_end, 'days', (v_end - v_start) + 1),
      'filters', jsonb_build_object('game', v_game, 'stakes', v_stakes, 'search', v_q),
      'scope', v_scope, 'reporting_scope', CASE WHEN v_union=p_club_id THEN 'union' ELSE 'club' END, 'reporting_club_count', cardinality(public.fn_ca_club_data_clubs(p_club_id)), 'accounting_basis', 'utc_net_money_flow', 'viewer_role', v_role, 'club_name', v_club_name, 'facts_from', v_facts_from,
      'summary', v_sum, 'rows', v_rows, 'row_count', (v_sum->>'games')::int,
      'union_id', v_union, 'generated_at', now());
  END IF;

  -- A FILTERED SCREEN (a game class, stakes, or a search): every game's
  -- attributes are read, as before; the players are counted for the page's
  -- rows by exact (club, day, game) lookups.

  WITH g AS MATERIALIZED (
    SELECT d.kind, d.game_id, SUM(d.fee) AS fee, SUM(d.winnings) AS winnings, max(d.last_at) AS activity_at
      FROM public.ca_club_data_fact d
     WHERE d.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN v_start AND v_end
       AND (v_users IS NULL OR d.user_id = ANY (v_users))
       AND (v_game = 'ALL'
            OR (v_game IN ('HOLDEM', 'OMAHA', 'MIXED') AND d.kind = 'CASH')
            OR (v_game IN ('MTT', 'SNG') AND d.kind = 'TOURNAMENT'))
       AND (v_stakes = 'ALL' OR d.kind = 'CASH')
     GROUP BY d.kind, d.game_id
  ), felt AS MATERIALIZED (
    -- Chips still in front of this club's seated players: part of the result,
    -- not a loss. The seat's own club, as the money was.
    SELECT s.table_id, SUM(s.stack) AS felt, count(*)::int AS seated
      FROM public.table_seats s
      JOIN public.tables t ON t.id = s.table_id AND t.tournament_id IS NULL
     WHERE s.left_at IS NULL AND s.user_id IS NOT NULL
       AND COALESCE(s.status, 'active') <> 'left' AND COALESCE(s.stack, 0) > 0
       AND (s.joined_at AT TIME ZONE 'UTC')::date BETWEEN v_start AND v_end
       AND COALESCE(s.club_id, public.fn_ca_cash_reporting_club(t.union_id, t.club_id, s.user_id)) = ANY (public.fn_ca_club_data_clubs(p_club_id))
       AND (v_users IS NULL OR s.user_id = ANY (v_users))
       AND v_game IN ('ALL', 'HOLDEM', 'OMAHA', 'MIXED')
     GROUP BY s.table_id
  ), running AS MATERIALIZED (
    SELECT tr.id FROM public.tournaments tr WHERE tr.status = 'RUNNING'
  ), cash AS (
    -- Cash games are few; every one is described.
    SELECT t.id AS game_id, COALESCE(t.name, 'Unnamed') AS name,
           CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                ELSE 'HOLDEM' END AS game_class,
           CASE WHEN COALESCE(t.big_blind,0) < 1 THEN 'MICRO'
                WHEN COALESCE(t.big_blind,0) < 5 THEN 'SMALL'
                WHEN COALESCE(t.big_blind,0) < 25 THEN 'MID' ELSE 'HIGH' END AS stakes_tier,
           COALESCE(pr.username, '') AS creator_name,
           COALESCE(gg.fee, 0) AS fee,
           COALESCE(gg.winnings, 0) + COALESCE(fe.felt, 0) AS winnings,
           COALESCE(gg.activity_at, now()) AS activity_at,
           (fe.felt IS NOT NULL) AS live, fe.seated, fe.felt AS on_felt
      FROM (SELECT * FROM g WHERE g.kind = 'CASH') gg
      FULL JOIN felt fe ON fe.table_id = gg.game_id
      JOIN public.tables t ON t.id = COALESCE(gg.game_id, fe.table_id)
      LEFT JOIN public.profiles pr ON pr.id = t.created_by
  ), tour AS (
    SELECT g.game_id, g.fee, g.winnings, g.activity_at,
           (g.game_id IN (SELECT r.id FROM running r)) AS live
      FROM g WHERE g.kind = 'TOURNAMENT'
  ), tour_described AS (
    -- Read only when a filter needs it: v_attrs is a one-time filter, so the
    -- tournaments join is never executed for the plain screen.
    SELECT tu.*, COALESCE(tr.name, 'Tournament') AS name,
           CASE WHEN tr.tournament_type = 'SPIN' THEN 'SPIN' WHEN tr.tournament_type = 'SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END AS game_class
      FROM tour tu JOIN public.tournaments tr ON tr.id = tu.game_id
     WHERE v_attrs
  ), filtered AS (
    SELECT 'CASH'::text AS k, c.game_id, c.fee, c.winnings, c.activity_at, c.live, c.seated, c.on_felt
      FROM cash c
     WHERE (v_game = 'ALL' OR c.game_class = v_game)
       AND (v_stakes = 'ALL' OR c.stakes_tier = v_stakes)
       AND (v_q IS NULL OR c.name ILIKE '%' || v_q || '%' OR c.game_id::text ILIKE '%' || v_q || '%'
            OR c.creator_name ILIKE '%' || v_q || '%')
    UNION ALL
    SELECT 'TOURNAMENT', tu.game_id, tu.fee, tu.winnings, tu.activity_at, tu.live, NULL::int, NULL::numeric
      FROM tour tu WHERE NOT v_attrs
    UNION ALL
    SELECT 'TOURNAMENT', td.game_id, td.fee, td.winnings, td.activity_at, td.live, NULL::int, NULL::numeric
      FROM tour_described td
     WHERE v_attrs
       AND (v_game = 'ALL' OR td.game_class = v_game)
       AND (v_q IS NULL OR td.name ILIKE '%' || v_q || '%' OR td.game_id::text ILIKE '%' || v_q || '%')
  ), summary AS (
    SELECT jsonb_build_object(
      'games', count(*),
      'total_winnings', round(COALESCE(SUM(winnings), 0), 2),
      'mtt_winnings', round(COALESCE(SUM(winnings) FILTER (WHERE k = 'TOURNAMENT' AND EXISTS(SELECT 1 FROM public.tournaments mt WHERE mt.id=filtered.game_id AND mt.tournament_type='MTT')), 0), 2),
      'cash_winnings', round(COALESCE(SUM(winnings) FILTER (WHERE k = 'CASH'), 0), 2),
      'fee', round(COALESCE(SUM(fee), 0), 2),
      'cash_fee', round(COALESCE(SUM(fee) FILTER (WHERE k = 'CASH'), 0), 2),
      'mtt_fee', round(COALESCE(SUM(fee) FILTER (WHERE k = 'TOURNAMENT' AND EXISTS(SELECT 1 FROM public.tournaments mt WHERE mt.id=filtered.game_id AND mt.tournament_type='MTT')),0),2), 'tournament_fee',round(COALESCE(SUM(fee) FILTER(WHERE k <> 'CASH'),0),2), 'tournament_winnings',round(COALESCE(SUM(winnings) FILTER(WHERE k <> 'CASH'),0),2),
      'on_felt', round(COALESCE(SUM(on_felt), 0), 2),
      'live_games', count(*) FILTER (WHERE live)) AS s
      FROM filtered
  ), top AS MATERIALIZED (
    SELECT * FROM filtered ORDER BY live DESC, activity_at DESC NULLS LAST, k, game_id LIMIT v_lim
  ), pl AS (
    SELECT f.game_id, count(DISTINCT f.user_id) AS n
      FROM public.ca_club_data_fact f
     WHERE f.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND f.stat_date = ANY (v_days)
       AND f.user_id <> '00000000-0000-0000-0000-000000000000'::uuid
       AND (v_users IS NULL OR f.user_id = ANY (v_users))
       AND f.game_id IN (SELECT tp.game_id FROM top tp)
     GROUP BY f.game_id
  ), described AS (
    SELECT CASE WHEN tp.k = 'CASH' THEN 'CASH'
                WHEN tr.tournament_type = 'SPIN' THEN 'SPIN'
                WHEN tr.tournament_type = 'SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END AS kind,
           tp.game_id::text AS id,
           CASE WHEN tp.k = 'CASH' THEN COALESCE(t.name, 'Unnamed') ELSE COALESCE(tr.name, 'Tournament') END AS name,
           CASE WHEN tp.k = 'CASH' THEN UPPER(COALESCE(t.game_variant, 'nlh'))
                ELSE UPPER(COALESCE(tr.variant, tr.game_type, 'nlh')) END AS variant,
           CASE WHEN tp.k = 'CASH' THEN
                  CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                       WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                       ELSE 'HOLDEM' END
                WHEN tr.tournament_type = 'SPIN' THEN 'SPIN' WHEN tr.tournament_type = 'SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END AS game_class,
           CASE WHEN tp.k <> 'CASH' THEN 'NA'
                WHEN COALESCE(t.big_blind,0) < 1 THEN 'MICRO'
                WHEN COALESCE(t.big_blind,0) < 5 THEN 'SMALL'
                WHEN COALESCE(t.big_blind,0) < 25 THEN 'MID' ELSE 'HIGH' END AS stakes_tier,
           CASE WHEN tp.k = 'CASH' AND COALESCE(t.big_blind,0) > 0 THEN
             trim(trailing '.' from trim(trailing '0' from COALESCE(t.small_blind,0)::text)) || '/' ||
             trim(trailing '.' from trim(trailing '0' from t.big_blind::text)) END AS blinds,
           CASE WHEN tp.k = 'CASH' THEN t.created_at ELSE tr.start_time END AS started_at,
           CASE WHEN tp.k = 'CASH' THEN t.status ELSE tr.status END AS status,
           CASE WHEN tp.k = 'CASH' THEN COALESCE(pr.username, '') ELSE '' END AS creator_name,
           round(tp.fee, 2) AS fee, round(tp.winnings, 2) AS winnings,
           GREATEST(COALESCE(pl.n, 0), COALESCE(tp.seated, 0))::int AS players,
           tp.activity_at, tp.live, tp.seated, round(tp.on_felt, 2) AS on_felt, tp.k
      FROM top tp
      LEFT JOIN public.tables t ON tp.k = 'CASH' AND t.id = tp.game_id
      LEFT JOIN public.profiles pr ON pr.id = t.created_by
      LEFT JOIN public.tournaments tr ON tp.k = 'TOURNAMENT' AND tr.id = tp.game_id
      LEFT JOIN pl ON pl.game_id = tp.game_id
  )
  SELECT (SELECT s FROM summary),
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
           'kind', kind, 'id', id, 'name', name, 'variant', variant,
           'game_class', game_class, 'stakes_tier', stakes_tier, 'blinds', blinds,
           'started_at', started_at, 'activity_at', activity_at, 'status', status,
           'creator_name', NULLIF(creator_name, ''), 'fee', COALESCE(fee, 0),
           'winnings', COALESCE(winnings, 0), 'players', COALESCE(players, 0),
           'live', live, 'seated', seated, 'on_felt', on_felt)
           ORDER BY live DESC, activity_at DESC NULLS LAST, k, id) FROM described), '[]'::jsonb)
    INTO v_sum, v_rows;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('start', v_start, 'end', v_end, 'days', (v_end - v_start) + 1),
    'filters', jsonb_build_object('game', v_game, 'stakes', v_stakes, 'search', v_q),
    'scope', v_scope, 'reporting_scope', CASE WHEN v_union=p_club_id THEN 'union' ELSE 'club' END, 'reporting_club_count', cardinality(public.fn_ca_club_data_clubs(p_club_id)), 'accounting_basis', 'utc_net_money_flow',
    'viewer_role', v_role,
    'club_name', v_club_name,
    'facts_from', v_facts_from,
    'summary', v_sum,
    'rows', v_rows,
    'row_count', (v_sum->>'games')::int,
    'union_id', v_union,
    'generated_at', now());
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_cash_felt(p_club_id uuid, p_start date, p_end date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text, p_search text DEFAULT NULL::text)
 RETURNS TABLE(table_id uuid, felt numeric, seated integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH f AS (
    SELECT UPPER(COALESCE(NULLIF(p_game,''),'ALL')) g,
           UPPER(COALESCE(NULLIF(p_stakes,''),'ALL')) s,
           NULLIF(btrim(COALESCE(p_search,'')),'') q
  )
  SELECT s.table_id, SUM(s.stack), COUNT(*)::int
    FROM public.table_seats s
    JOIN public.tables t ON t.id = s.table_id AND t.tournament_id IS NULL
    LEFT JOIN public.profiles pr ON pr.id = t.created_by
    CROSS JOIN f
   WHERE s.left_at IS NULL
     AND s.user_id IS NOT NULL
     AND COALESCE(s.status, 'active') <> 'left'
     AND COALESCE(s.stack, 0) > 0
     AND (s.joined_at AT TIME ZONE 'UTC')::date BETWEEN p_start AND p_end
     AND COALESCE(s.club_id, public.fn_ca_cash_reporting_club(t.union_id, t.club_id, s.user_id)) = ANY (public.fn_ca_club_data_clubs(p_club_id))
     AND public.fn_ca_launch_accounting_accepts(COALESCE(s.club_id, public.fn_ca_cash_reporting_club(t.union_id, t.club_id, s.user_id)), s.joined_at) IS TRUE
     AND (f.g = 'ALL' OR f.g = CASE
           WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
           WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
           ELSE 'HOLDEM' END)
     AND (f.s = 'ALL' OR f.s = CASE
           WHEN COALESCE(t.big_blind,0) < 1 THEN 'MICRO'
           WHEN COALESCE(t.big_blind,0) < 5 THEN 'SMALL'
           WHEN COALESCE(t.big_blind,0) < 25 THEN 'MID' ELSE 'HIGH' END)
     AND (f.q IS NULL OR COALESCE(t.name,'Unnamed') ILIKE '%'||f.q||'%'
          OR t.id::text ILIKE '%'||f.q||'%' OR COALESCE(pr.username,'') ILIKE '%'||f.q||'%')
   GROUP BY s.table_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_games(p_club_id uuid, p_start date, p_end date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text, p_search text DEFAULT NULL::text)
 RETURNS TABLE(kind text, id text, name text, variant text, game_class text, stakes_tier text, small_blind numeric, big_blind numeric, rake_percent numeric, started_at timestamp with time zone, created_by uuid, status text, fee numeric, winnings numeric, hands bigint, players integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NULLIF(btrim(COALESCE(p_search,'')),'') IS NULL THEN
    RETURN QUERY SELECT * FROM public.fn_ca_club_games_unsearched(
      p_club_id,p_start,p_end,p_game,p_stakes
    );
  ELSE
    RETURN QUERY SELECT * FROM public.fn_ca_club_games_searched(
      p_club_id,p_start,p_end,p_game,p_stakes,p_search
    );
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_games_searched(p_club_id uuid, p_start date, p_end date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text, p_search text DEFAULT NULL::text)
 RETURNS TABLE(kind text, id text, name text, variant text, game_class text, stakes_tier text, small_blind numeric, big_blind numeric, rake_percent numeric, started_at timestamp with time zone, created_by uuid, status text, fee numeric, winnings numeric, hands bigint, players integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH felt AS MATERIALIZED (SELECT * FROM public.fn_ca_club_cash_felt($1,$2,$3,$4,$5,$6)), raw_cash AS (
    SELECT c.table_id,SUM(c.rake) fee,SUM(c.net) winnings,SUM(c.hands) hands,
           MAX(c.players) players FROM public.club_table_daily c
     WHERE c.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND c.stat_date BETWEEN p_start AND p_end GROUP BY c.table_id
  ), cash AS (
      SELECT coalesce(c.table_id,f.table_id) table_id,coalesce(c.fee,0) fee,
             coalesce(c.winnings,0)+coalesce(f.felt,0) winnings,CASE WHEN EXISTS(SELECT 1 FROM public.unions u WHERE u.id=$1) THEN public.fn_ca_club_data_hand_count($1,$2,$3,'ALL','ALL',coalesce(c.table_id,f.table_id)::text) ELSE coalesce(c.hands,0)::bigint END hands,
             greatest(coalesce(c.players,0),coalesce(f.seated,0))::integer players
        FROM raw_cash c FULL JOIN felt f ON f.table_id=c.table_id
    ), tournament_facts AS MATERIALIZED (
    SELECT d.tournament_id,SUM(d.fee) fee,SUM(d.winnings) winnings
      FROM public.ca_club_tournament_daily d WHERE d.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id))
       AND d.stat_date BETWEEN p_start AND p_end GROUP BY d.tournament_id
  ), tournament_players AS MATERIALIZED (
    SELECT p.tournament_id,count(DISTINCT p.user_id)::integer players
      FROM public.ca_club_tournament_player_daily p WHERE p.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id))
       AND p.stat_date BETWEEN p_start AND p_end GROUP BY p.tournament_id
  ), all_rows AS (
    SELECT 'CASH'::text kind,t.id::text id,COALESCE(t.name,'Unnamed') name,
      UPPER(COALESCE(t.game_variant,'nlh')) variant,
      CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
           WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
           ELSE 'HOLDEM' END game_class,COALESCE(t.small_blind,0) small_blind,
      COALESCE(t.big_blind,0) big_blind,
      CASE WHEN COALESCE(t.rake_percent,-1)>=0 THEN t.rake_percent END rake_percent,
      t.created_at started_at,t.created_by,t.status,round(c.fee,2) fee,
      round(c.winnings,2) winnings,c.hands::bigint,c.players::integer,
      COALESCE(pr.username,'') creator_username
      FROM cash c JOIN public.tables t ON t.id=c.table_id
      LEFT JOIN public.profiles pr ON pr.id=t.created_by
    UNION ALL
    SELECT CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN'
                WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
      tr.id::text,COALESCE(tr.name,'Tournament'),UPPER(COALESCE(tr.variant,tr.game_type,'nlh')),
      CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN' WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
      0::numeric,0::numeric,NULL::numeric,tr.start_time,NULL::uuid,tr.status,
      round(COALESCE(f.fee,0),2),round(COALESCE(f.winnings,0),2),0::bigint,
      COALESCE(tp.players,0)::integer,''::text
      FROM tournament_facts f JOIN public.tournaments tr ON tr.id=f.tournament_id
      LEFT JOIN tournament_players tp ON tp.tournament_id=f.tournament_id
  ), tagged AS (
    SELECT r.*,CASE WHEN r.game_class IN('MTT','SNG') THEN 'NA'
      WHEN r.big_blind<1 THEN 'MICRO' WHEN r.big_blind<5 THEN 'SMALL'
      WHEN r.big_blind<25 THEN 'MID' ELSE 'HIGH' END stakes_tier FROM all_rows r
  )
  SELECT t.kind,t.id,t.name,t.variant,t.game_class,t.stakes_tier,t.small_blind,
    t.big_blind,t.rake_percent,t.started_at,t.created_by,t.status,t.fee,t.winnings,
    t.hands,t.players FROM tagged t
   WHERE (UPPER(COALESCE(NULLIF(p_game,''),'ALL'))='ALL' OR t.game_class=UPPER(p_game))
     AND (UPPER(COALESCE(NULLIF(p_stakes,''),'ALL'))='ALL' OR t.stakes_tier=UPPER(p_stakes))
     AND (NULLIF(btrim(COALESCE(p_search,'')),'') IS NULL
       OR t.name ILIKE '%'||btrim(p_search)||'%'
       OR t.id ILIKE '%'||btrim(p_search)||'%'
       OR t.creator_username ILIKE '%'||btrim(p_search)||'%');
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_games_unsearched(p_club_id uuid, p_start date, p_end date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text)
 RETURNS TABLE(kind text, id text, name text, variant text, game_class text, stakes_tier text, small_blind numeric, big_blind numeric, rake_percent numeric, started_at timestamp with time zone, created_by uuid, status text, fee numeric, winnings numeric, hands bigint, players integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY EXECUTE $query$
    WITH felt AS MATERIALIZED (SELECT * FROM public.fn_ca_club_cash_felt($1,$2,$3,$4,$5,NULL)), raw_cash AS (
      SELECT c.table_id,SUM(c.rake) fee,SUM(c.net) winnings,SUM(c.hands) hands,
             MAX(c.players) players FROM public.club_table_daily c
       WHERE c.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND c.stat_date BETWEEN $2 AND $3 GROUP BY c.table_id
    ), cash AS (
      SELECT coalesce(c.table_id,f.table_id) table_id,coalesce(c.fee,0) fee,
             coalesce(c.winnings,0)+coalesce(f.felt,0) winnings,CASE WHEN EXISTS(SELECT 1 FROM public.unions u WHERE u.id=$1) THEN public.fn_ca_club_data_hand_count($1,$2,$3,'ALL','ALL',coalesce(c.table_id,f.table_id)::text) ELSE coalesce(c.hands,0)::bigint END hands,
             greatest(coalesce(c.players,0),coalesce(f.seated,0))::integer players
        FROM raw_cash c FULL JOIN felt f ON f.table_id=c.table_id
    ), tournament_facts AS MATERIALIZED (
      SELECT d.tournament_id,SUM(d.fee) fee,SUM(d.winnings) winnings
        FROM public.ca_club_tournament_daily d WHERE d.club_id = ANY (public.fn_ca_club_data_clubs($1))
         AND d.stat_date BETWEEN $2 AND $3 GROUP BY d.tournament_id
    ), tournament_players AS MATERIALIZED (
      SELECT p.tournament_id,count(DISTINCT p.user_id)::integer players
        FROM public.ca_club_tournament_player_daily p WHERE p.club_id = ANY (public.fn_ca_club_data_clubs($1))
         AND p.stat_date BETWEEN $2 AND $3 GROUP BY p.tournament_id
    ), all_rows AS (
      SELECT 'CASH'::text kind,t.id::text id,COALESCE(t.name,'Unnamed') name,
        UPPER(COALESCE(t.game_variant,'nlh')) variant,
        CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
             WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
             ELSE 'HOLDEM' END game_class,COALESCE(t.small_blind,0) small_blind,
        COALESCE(t.big_blind,0) big_blind,
        CASE WHEN COALESCE(t.rake_percent,-1)>=0 THEN t.rake_percent END rake_percent,
        t.created_at started_at,t.created_by,t.status,round(c.fee,2) fee,
        round(c.winnings,2) winnings,c.hands::bigint,c.players::integer
        FROM cash c JOIN public.tables t ON t.id=c.table_id
      UNION ALL
      SELECT CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN'
                  WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
        tr.id::text,COALESCE(tr.name,'Tournament'),UPPER(COALESCE(tr.variant,tr.game_type,'nlh')),
        CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN' WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
        0::numeric,0::numeric,NULL::numeric,tr.start_time,NULL::uuid,tr.status,
        round(COALESCE(f.fee,0),2),round(COALESCE(f.winnings,0),2),0::bigint,
        COALESCE(tp.players,0)::integer
        FROM tournament_facts f JOIN public.tournaments tr ON tr.id=f.tournament_id
        LEFT JOIN tournament_players tp ON tp.tournament_id=f.tournament_id
    ), tagged AS (
      SELECT r.*,CASE WHEN r.game_class IN('MTT','SNG') THEN 'NA'
        WHEN r.big_blind<1 THEN 'MICRO' WHEN r.big_blind<5 THEN 'SMALL'
        WHEN r.big_blind<25 THEN 'MID' ELSE 'HIGH' END stakes_tier FROM all_rows r
    )
    SELECT t.kind,t.id,t.name,t.variant,t.game_class,t.stakes_tier,t.small_blind,
      t.big_blind,t.rake_percent,t.started_at,t.created_by,t.status,t.fee,t.winnings,
      t.hands,t.players FROM tagged t
     WHERE (UPPER(COALESCE(NULLIF($4,''),'ALL'))='ALL' OR t.game_class=UPPER($4))
       AND (UPPER(COALESCE(NULLIF($5,''),'ALL'))='ALL' OR t.stakes_tier=UPPER($5))
  $query$ USING p_club_id,p_start,p_end,p_game,p_stakes;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_game_rows_filtered(p_club_id uuid, p_start date, p_end date, p_game text, p_stakes text, p_search text, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb;
BEGIN
  EXECUTE $query$
    WITH cash AS (
      SELECT c.table_id,SUM(c.rake) fee,SUM(c.net) winnings,SUM(c.hands) hands,
             MAX(c.players)::integer players FROM public.club_table_daily c
       WHERE c.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND c.stat_date BETWEEN $2 AND $3 GROUP BY c.table_id
    ), tournament_facts AS (
      SELECT d.tournament_id,SUM(d.fee) fee,SUM(d.winnings) winnings
        FROM public.ca_club_tournament_daily d WHERE d.club_id = ANY (public.fn_ca_club_data_clubs($1))
         AND d.stat_date BETWEEN $2 AND $3 GROUP BY d.tournament_id
    ), all_rows AS (
      SELECT 'CASH'::text kind,t.id::text id,COALESCE(t.name,'Unnamed') name,
        UPPER(COALESCE(t.game_variant,'nlh')) variant,
        CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
             WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
             ELSE 'HOLDEM' END game_class,
        CASE WHEN COALESCE(t.big_blind,0)<1 THEN 'MICRO'
             WHEN COALESCE(t.big_blind,0)<5 THEN 'SMALL'
             WHEN COALESCE(t.big_blind,0)<25 THEN 'MID' ELSE 'HIGH' END stakes_tier,
        COALESCE(t.small_blind,0) small_blind,COALESCE(t.big_blind,0) big_blind,
        CASE WHEN COALESCE(t.rake_percent,-1)>=0 THEN t.rake_percent END rake_percent,
        t.created_at started_at,t.created_by,t.status,round(c.fee,2) fee,
        round(c.winnings,2) winnings,c.hands::bigint,c.players,
        COALESCE(pr.username,'') creator_name,pr.avatar_url creator_avatar
        FROM cash c JOIN public.tables t ON t.id=c.table_id
        LEFT JOIN public.profiles pr ON pr.id=t.created_by
      UNION ALL
      SELECT CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN'
                  WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
        tr.id::text,COALESCE(tr.name,'Tournament'),UPPER(COALESCE(tr.variant,tr.game_type,'nlh')),
        CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN' WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,'NA',
        0::numeric,0::numeric,NULL::numeric,tr.start_time,NULL::uuid,tr.status,
        round(COALESCE(f.fee,0),2),round(COALESCE(f.winnings,0),2),0::bigint,0::integer,
        ''::text,NULL::text
        FROM tournament_facts f JOIN public.tournaments tr ON tr.id=f.tournament_id
    ), bounded AS MATERIALIZED (
      SELECT * FROM all_rows r
       WHERE (UPPER(COALESCE(NULLIF($4,''),'ALL'))='ALL' OR r.game_class=UPPER($4))
         AND (UPPER(COALESCE(NULLIF($5,''),'ALL'))='ALL' OR r.stakes_tier=UPPER($5))
         AND (NULLIF(btrim(COALESCE($6,'')),'') IS NULL
           OR r.name ILIKE '%'||btrim($6)||'%' OR r.id ILIKE '%'||btrim($6)||'%'
           OR r.creator_name ILIKE '%'||btrim($6)||'%')
       ORDER BY r.started_at DESC NULLS LAST,r.kind DESC,r.id DESC LIMIT $7
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'kind',q.kind,'id',q.id,'name',q.name,'variant',q.variant,
      'game_class',q.game_class,'stakes_tier',q.stakes_tier,
      'blinds',CASE WHEN q.big_blind>0 THEN
        trim(trailing '.' from trim(trailing '0' from q.small_blind::text))||'/'||
        trim(trailing '.' from trim(trailing '0' from q.big_blind::text)) END,
      'rake_percent',q.rake_percent,'started_at',q.started_at,'status',q.status,
      'creator_id',q.created_by,'creator_name',NULLIF(q.creator_name,''),
      'creator_avatar',q.creator_avatar,'fee',q.fee,'winnings',q.winnings,
      'hands',q.hands,'players',CASE WHEN q.kind='CASH' THEN q.players ELSE COALESCE((
        SELECT count(DISTINCT p.user_id)::integer FROM public.ca_club_tournament_player_daily p
         WHERE p.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND p.tournament_id=q.id::uuid
           AND p.stat_date BETWEEN $2 AND $3),0) END)
      ORDER BY q.started_at DESC NULLS LAST,q.kind DESC,q.id DESC),'[]'::jsonb)
      FROM bounded q
  $query$ INTO v_out USING p_club_id,p_start,p_end,p_game,p_stakes,p_search,p_limit;
  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_game_rows(p_club_id uuid, p_start date, p_end date, p_game text, p_stakes text, p_search text, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb;
BEGIN
  IF UPPER(COALESCE(NULLIF(p_game,''),'ALL')) <> 'ALL'
     OR UPPER(COALESCE(NULLIF(p_stakes,''),'ALL')) <> 'ALL'
     OR NULLIF(btrim(COALESCE(p_search,'')),'') IS NOT NULL THEN
    RETURN public.fn_ca_club_game_rows_filtered(
      p_club_id,p_start,p_end,p_game,p_stakes,p_search,p_limit
    );
  END IF;

  EXECUTE $query$
    WITH recent_cash_ids AS MATERIALIZED (
      SELECT tb.id
        FROM public.tables tb
       WHERE EXISTS (
         SELECT 1 FROM public.club_table_daily d
          WHERE d.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND d.table_id=tb.id
            AND d.stat_date BETWEEN $2 AND $3
       )
       ORDER BY tb.created_at DESC NULLS LAST,tb.id DESC
       LIMIT $4
    ), cash AS MATERIALIZED (
      SELECT tb.id,COALESCE(tb.name,'Unnamed') name,
             UPPER(COALESCE(tb.game_variant,'nlh')) variant,
             CASE WHEN COALESCE(tb.game_variant,'') ILIKE '%plo%'
                        OR COALESCE(tb.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                  WHEN COALESCE(tb.game_variant,'') ILIKE '%mixed%'
                        OR COALESCE(tb.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                  ELSE 'HOLDEM' END game_class,
             CASE WHEN COALESCE(tb.big_blind,0)<1 THEN 'MICRO'
                  WHEN COALESCE(tb.big_blind,0)<5 THEN 'SMALL'
                  WHEN COALESCE(tb.big_blind,0)<25 THEN 'MID' ELSE 'HIGH' END stakes_tier,
             COALESCE(tb.small_blind,0) small_blind,
             COALESCE(tb.big_blind,0) big_blind,
             CASE WHEN COALESCE(tb.rake_percent,-1)>=0 THEN tb.rake_percent END rake_percent,
             tb.created_at started_at,tb.created_by,tb.status,
             round(sum(d.rake),2) fee,round(sum(d.net),2) winnings,
             sum(d.hands)::bigint hands,max(d.players)::integer players
        FROM recent_cash_ids r
        JOIN public.tables tb ON tb.id=r.id
        JOIN public.club_table_daily d ON d.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND d.table_id=r.id
          AND d.stat_date BETWEEN $2 AND $3
       GROUP BY tb.id,tb.name,tb.game_variant,tb.game_mode,tb.big_blind,
                tb.small_blind,tb.rake_percent,tb.created_at,tb.created_by,tb.status
    ), recent_tournament_ids AS MATERIALIZED (
      SELECT tr.id
        FROM public.tournaments tr
       WHERE EXISTS (
         SELECT 1 FROM public.ca_club_tournament_daily d
          WHERE d.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND d.tournament_id=tr.id
            AND d.stat_date BETWEEN $2 AND $3
       )
       /* start_time is NOT NULL: DESC is DESC NULLS LAST, and only DESC can walk
          idx_tournaments_start_time backward and stop (2026-10-01) */
       ORDER BY tr.start_time DESC,tr.id DESC
       LIMIT $4
    ), tournament_facts AS MATERIALIZED (
      SELECT r.id,round(sum(d.fee),2) fee,round(sum(d.winnings),2) winnings
        FROM recent_tournament_ids r
        JOIN public.ca_club_tournament_daily d
          ON d.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND d.tournament_id=r.id
         AND d.stat_date BETWEEN $2 AND $3
       GROUP BY r.id
    ), tournament_players AS MATERIALIZED (
      SELECT r.id,count(DISTINCT p.user_id)::integer players
        FROM recent_tournament_ids r
        LEFT JOIN public.ca_club_tournament_player_daily p
          ON p.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND p.tournament_id=r.id
         AND p.stat_date BETWEEN $2 AND $3
       GROUP BY r.id
    ), all_rows AS (
      SELECT 'CASH'::text kind,c.id::text id,c.name,c.variant,c.game_class,
             c.stakes_tier,c.small_blind,c.big_blind,c.rake_percent,c.started_at,
             c.created_by,c.status,c.fee,c.winnings,c.hands,c.players,
             COALESCE(pr.username,'') creator_name,pr.avatar_url creator_avatar
        FROM cash c LEFT JOIN public.profiles pr ON pr.id=c.created_by
      UNION ALL
      SELECT CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN'
                  WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
             tr.id::text,COALESCE(tr.name,'Tournament'),
             UPPER(COALESCE(tr.variant,tr.game_type,'nlh')),
             CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN' WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
             'NA',0::numeric,0::numeric,NULL::numeric,tr.start_time,NULL::uuid,
             tr.status,f.fee,f.winnings,0::bigint,COALESCE(tp.players,0),
             ''::text,NULL::text
        FROM tournament_facts f
        JOIN public.tournaments tr ON tr.id=f.id
        LEFT JOIN tournament_players tp ON tp.id=f.id
    ), bounded AS MATERIALIZED (
      SELECT * FROM all_rows r
       ORDER BY r.started_at DESC NULLS LAST,r.kind DESC,r.id DESC
       LIMIT $4
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'kind',q.kind,'id',q.id,'name',q.name,'variant',q.variant,
      'game_class',q.game_class,'stakes_tier',q.stakes_tier,
      'blinds',CASE WHEN q.big_blind>0 THEN
        trim(trailing '.' from trim(trailing '0' from q.small_blind::text))||'/'||
        trim(trailing '.' from trim(trailing '0' from q.big_blind::text)) END,
      'rake_percent',q.rake_percent,'started_at',q.started_at,'status',q.status,
      'creator_id',q.created_by,'creator_name',NULLIF(q.creator_name,''),
      'creator_avatar',q.creator_avatar,'fee',q.fee,'winnings',q.winnings,
      'hands',q.hands,'players',q.players)
      ORDER BY q.started_at DESC NULLS LAST,q.kind DESC,q.id DESC),'[]'::jsonb)
      FROM bounded q
  $query$ INTO v_out USING p_club_id,p_start,p_end,p_limit;
  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_game_summary_filtered(p_club_id uuid, p_start date, p_end date, p_game text, p_stakes text, p_search text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb;
BEGIN
  EXECUTE $query$
    WITH cash AS (
      SELECT c.table_id,SUM(c.rake) fee,SUM(c.net) winnings,SUM(c.hands) hands
        FROM public.club_table_daily c WHERE c.club_id = ANY (public.fn_ca_club_data_clubs($1))
         AND c.stat_date BETWEEN $2 AND $3 GROUP BY c.table_id
    ), tournament_facts AS (
      SELECT d.tournament_id,SUM(d.fee) fee,SUM(d.winnings) winnings
        FROM public.ca_club_tournament_daily d WHERE d.club_id = ANY (public.fn_ca_club_data_clubs($1))
         AND d.stat_date BETWEEN $2 AND $3 GROUP BY d.tournament_id
    ), all_rows AS (
      SELECT CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%'
                    OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                  WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%'
                    OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                  ELSE 'HOLDEM' END game_class,
             CASE WHEN COALESCE(t.big_blind,0)<1 THEN 'MICRO'
                  WHEN COALESCE(t.big_blind,0)<5 THEN 'SMALL'
                  WHEN COALESCE(t.big_blind,0)<25 THEN 'MID' ELSE 'HIGH' END stakes_tier,
             t.id::text id,COALESCE(t.name,'Unnamed') name,
             COALESCE(pr.username,'') creator_name,c.fee,c.winnings,c.hands::bigint
        FROM cash c JOIN public.tables t ON t.id=c.table_id
        LEFT JOIN public.profiles pr ON pr.id=t.created_by
      UNION ALL
      SELECT CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN' WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,'NA',
             tr.id::text,COALESCE(tr.name,'Tournament'),'',f.fee,f.winnings,0::bigint
        FROM tournament_facts f JOIN public.tournaments tr ON tr.id=f.tournament_id
    ), filtered AS (
      SELECT * FROM all_rows r
       WHERE (UPPER(COALESCE(NULLIF($4,''),'ALL'))='ALL' OR r.game_class=UPPER($4))
         AND (UPPER(COALESCE(NULLIF($5,''),'ALL'))='ALL' OR r.stakes_tier=UPPER($5))
         AND (NULLIF(btrim(COALESCE($6,'')),'') IS NULL
           OR r.name ILIKE '%'||btrim($6)||'%' OR r.id ILIKE '%'||btrim($6)||'%'
           OR r.creator_name ILIKE '%'||btrim($6)||'%')
    )
    SELECT jsonb_build_object(
      'games',count(*),
      'total_winnings',round(COALESCE(SUM(winnings),0),2),
      'mtt_winnings',round(COALESCE(SUM(winnings) FILTER(WHERE game_class='MTT'),0),2),
      'cash_winnings',round(COALESCE(SUM(winnings) FILTER(WHERE game_class NOT IN('MTT','SNG','SPIN')),0),2),
      'fee',round(COALESCE(SUM(fee),0),2),
      'cash_fee',round(COALESCE(SUM(fee) FILTER(WHERE game_class NOT IN('MTT','SNG','SPIN')),0),2),
      'mtt_fee',round(COALESCE(SUM(fee) FILTER(WHERE game_class IN('MTT','SNG','SPIN')),0),2),
      'hands',public.fn_ca_club_data_hand_count($1,$2,$3,$4,$5,$6)) FROM filtered
  $query$ INTO v_out USING p_club_id,p_start,p_end,p_game,p_stakes,p_search;
  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_game_summary(p_club_id uuid, p_start date, p_end date, p_game text, p_stakes text, p_search text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb;
BEGIN
  IF UPPER(COALESCE(NULLIF(p_game,''),'ALL')) <> 'ALL'
     OR UPPER(COALESCE(NULLIF(p_stakes,''),'ALL')) <> 'ALL'
     OR NULLIF(btrim(COALESCE(p_search,'')),'') IS NOT NULL THEN
    RETURN public.fn_ca_club_game_summary_filtered(
      p_club_id,p_start,p_end,p_game,p_stakes,p_search
    );
  END IF;

  SELECT jsonb_build_object(
    'games',COALESCE(c.games,0)+COALESCE(t.games,0),
    'total_winnings',round(COALESCE(c.winnings,0)+COALESCE(t.winnings,0),2),
    'mtt_winnings',round(COALESCE(t.mtt_winnings,0),2),
    'cash_winnings',round(COALESCE(c.winnings,0),2),
    'fee',round(COALESCE(c.fee,0)+COALESCE(t.fee,0),2),
    'cash_fee',round(COALESCE(c.fee,0),2),
    'mtt_fee',round(COALESCE(t.fee,0),2),
    'hands',public.fn_ca_club_data_hand_count(p_club_id,p_start,p_end,p_game,p_stakes,p_search))
    INTO v_out
    FROM (
      SELECT count(DISTINCT d.table_id)::bigint games,
             COALESCE(sum(d.rake),0) fee,COALESCE(sum(d.net),0) winnings,
             COALESCE(sum(d.hands),0)::bigint hands
        FROM public.club_table_daily d
       WHERE d.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN p_start AND p_end
    ) c
    CROSS JOIN (
      SELECT count(DISTINCT d.tournament_id)::bigint games,
             COALESCE(sum(d.fee),0) fee,COALESCE(sum(d.winnings),0) winnings,
             coalesce(sum(d.winnings) FILTER(WHERE EXISTS(SELECT 1 FROM public.tournaments mt WHERE mt.id=d.tournament_id AND mt.tournament_type='MTT')),0) mtt_winnings
        FROM public.ca_club_tournament_daily d
       WHERE d.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN p_start AND p_end
    ) t;
  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_game_page_core_20261006(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'recent'::text, p_cursor jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end,v_today),v_today);
  v_start date := COALESCE(p_start,v_end-13);
  v_game text := UPPER(COALESCE(NULLIF(p_game,''),'ALL'));
  v_stakes text := UPPER(COALESCE(NULLIF(p_stakes,''),'ALL'));
  v_search text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := LOWER(COALESCE(NULLIF(p_sort,''),'recent'));
  v_limit integer := GREATEST(LEAST(COALESCE(p_limit,100),200),1);
  v_out jsonb;
BEGIN
  IF NOT public.ca_can_view_whole_club_report(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501';
  END IF;
  IF v_start < v_end-92 THEN v_start := v_end-92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  IF v_sort NOT IN ('recent','fee','winnings','hands') THEN v_sort := 'recent'; END IF;

  -- EXECUTE forces a plan for this club/window.  Shark Club previously crossed
  -- 20 seconds when PostgreSQL reused a generic parameter plan here.
  --
  -- THE PAGE READS WHAT IT SHOWS (2026-10-07). For Shark Club's 158,820-game
  -- fortnight this read the whole 1.1 GB tournaments heap to rank the games
  -- (143,527 pages), and counted players for every tournament the club ever
  -- had a row for (425,352 index entries, 203,737 heap visits) to show 200 of
  -- them: 2.2 s warm, 27 statement timeouts a day in production. The ranking
  -- now reads only a tournament's id, type and start time (covered by
  -- idx_tournaments_game_page_keys) unless the owner searches by name, and
  -- fee, winnings and players are read for the visible rows alone, by key.
  EXECUTE $query$
    WITH felt AS MATERIALIZED (SELECT * FROM public.fn_ca_club_cash_felt($1,$2,$3,$4,$5,$6)), raw_cash AS (
      SELECT c.table_id,SUM(c.rake) fee,SUM(c.net) winnings,SUM(c.hands)::bigint hands,
             MAX(c.players)::integer players
        FROM public.club_table_daily c
       WHERE c.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND c.stat_date BETWEEN $2 AND $3
       GROUP BY c.table_id
    ), cash AS (
      SELECT coalesce(c.table_id,f.table_id) table_id,coalesce(c.fee,0) fee,
             coalesce(c.winnings,0)+coalesce(f.felt,0) winnings,CASE WHEN EXISTS(SELECT 1 FROM public.unions u WHERE u.id=$1) THEN public.fn_ca_club_data_hand_count($1,$2,$3,'ALL','ALL',coalesce(c.table_id,f.table_id)::text) ELSE coalesce(c.hands,0)::bigint END hands,
             greatest(coalesce(c.players,0),coalesce(f.seated,0))::integer players
        FROM raw_cash c FULL JOIN felt f ON f.table_id=c.table_id
    ), tournament_facts AS MATERIALIZED (
      SELECT d.tournament_id,SUM(d.fee) fee,SUM(d.winnings) winnings
        FROM public.ca_club_tournament_daily d
       WHERE d.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND d.stat_date BETWEEN $2 AND $3
       GROUP BY d.tournament_id
    ), keys AS MATERIALIZED (
      -- The ranking set carries the four sort keys and NOTHING the page does
      -- not filter on. Every other column is presentation, it is needed for at
      -- most $9 rows, and carrying it here is what spilled 42 MB to disk three
      -- times per read.
      SELECT 'CASH'::text kind,t.id::text id,
             CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%'
                        OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                  WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%'
                        OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                  ELSE 'HOLDEM' END game_class,
             CASE WHEN COALESCE(t.big_blind,0)<1 THEN 'MICRO'
                  WHEN COALESCE(t.big_blind,0)<5 THEN 'SMALL'
                  WHEN COALESCE(t.big_blind,0)<25 THEN 'MID' ELSE 'HIGH' END stakes_tier,
             COALESCE(t.name,'Unnamed') name,COALESCE(pr.username,'') creator_name,
             CASE $7 WHEN 'fee' THEN round(c.fee,2)
                     WHEN 'winnings' THEN round(c.winnings,2)
                     WHEN 'hands' THEN c.hands::numeric
                     ELSE extract(epoch FROM COALESCE(t.created_at,'0001-01-01'::timestamptz))::numeric
              END sort_value,
             extract(epoch FROM COALESCE(t.created_at,'0001-01-01'::timestamptz))::numeric sort_time
        FROM cash c JOIN public.tables t ON t.id=c.table_id
        LEFT JOIN public.profiles pr ON pr.id=t.created_by
      UNION ALL
      SELECT CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN'
                  WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
             tr.id::text,
             CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN' WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
             'NA',
             -- The name is read here only to search it. Unsearched, this branch
             -- needs id, type and start time alone (idx_tournaments_game_page_keys).
             CASE WHEN $6 IS NULL THEN NULL::text ELSE COALESCE(tr.name,'Tournament') END,''::text,
             CASE $7 WHEN 'fee' THEN round(COALESCE(f.fee,0),2)
                     WHEN 'winnings' THEN round(COALESCE(f.winnings,0),2)
                     WHEN 'hands' THEN 0::numeric
                     ELSE extract(epoch FROM COALESCE(tr.start_time,'0001-01-01'::timestamptz))::numeric
              END,
             extract(epoch FROM COALESCE(tr.start_time,'0001-01-01'::timestamptz))::numeric
        FROM tournament_facts f JOIN public.tournaments tr ON tr.id=f.tournament_id
    ), filtered AS MATERIALIZED (
      SELECT k.* FROM keys k
       WHERE ($4='ALL' OR k.game_class=$4)
         AND ($5='ALL' OR k.stakes_tier=$5)
         AND ($6 IS NULL OR k.name ILIKE '%'||$6||'%' OR k.id ILIKE '%'||$6||'%'
              OR k.creator_name ILIKE '%'||$6||'%')
    ), page_plus_one AS MATERIALIZED (
      SELECT s.* FROM filtered s
       WHERE $8 IS NULL OR ROW(s.sort_value,s.sort_time,s.kind,s.id) < ROW(
         ($8->>'value')::numeric,($8->>'time')::numeric,$8->>'kind',$8->>'id')
       ORDER BY s.sort_value DESC,s.sort_time DESC,s.kind DESC,s.id DESC
       LIMIT $9+1
    ), visible AS MATERIALIZED (
      SELECT * FROM page_plus_one
       ORDER BY sort_value DESC,sort_time DESC,kind DESC,id DESC LIMIT $9
    ), last_row AS (
      SELECT * FROM visible ORDER BY sort_value ASC,sort_time ASC,kind ASC,id ASC LIMIT 1
    ), detail AS (
      -- Presentation, for the <=$9 rows that survived the LIMIT and no others.
      SELECT v.kind,v.id,CASE WHEN v.kind='CASH' THEN v.name ELSE COALESCE(tr.name,'Tournament') END name,
             v.game_class,v.stakes_tier,v.creator_name,
             v.sort_value,v.sort_time,
             CASE WHEN v.kind='CASH' THEN UPPER(COALESCE(t.game_variant,'nlh'))
                  ELSE UPPER(COALESCE(tr.variant,tr.game_type,'nlh')) END variant,
             CASE WHEN v.kind='CASH' THEN COALESCE(t.small_blind,0) ELSE 0::numeric END small_blind,
             CASE WHEN v.kind='CASH' THEN COALESCE(t.big_blind,0) ELSE 0::numeric END big_blind,
             CASE WHEN v.kind='CASH' AND COALESCE(t.rake_percent,-1)>=0 THEN t.rake_percent END rake_percent,
             CASE WHEN v.kind='CASH' THEN t.created_at ELSE tr.start_time END started_at,
             CASE WHEN v.kind='CASH' THEN t.created_by END created_by,
             CASE WHEN v.kind='CASH' THEN t.status ELSE tr.status END status,
             CASE WHEN v.kind='CASH' THEN round(c.fee,2) ELSE round(COALESCE(f.fee,0),2) END fee,
             CASE WHEN v.kind='CASH' THEN round(c.winnings,2) ELSE round(COALESCE(f.winnings,0),2) END winnings,
             CASE WHEN v.kind='CASH' THEN c.hands ELSE 0::bigint END hands,
             CASE WHEN v.kind='CASH' THEN c.players ELSE COALESCE(tp.players,0)::integer END players,
             CASE WHEN v.kind='CASH' THEN pr.avatar_url END creator_avatar
        FROM visible v
        LEFT JOIN cash c ON v.kind='CASH' AND c.table_id=v.id::uuid
        LEFT JOIN public.tables t ON v.kind='CASH' AND t.id=v.id::uuid
        LEFT JOIN public.profiles pr ON v.kind='CASH' AND pr.id=t.created_by
        LEFT JOIN public.tournaments tr ON v.kind<>'CASH' AND tr.id=v.id::uuid
        -- The same rows tournament_facts summed for a visible tournament, and
        -- its players in the same window, each read through its own
        -- (club_id, tournament_id, ...) key for the <=$9 visible rows only.
        LEFT JOIN LATERAL (
          SELECT SUM(d.fee) fee,SUM(d.winnings) winnings
            FROM public.ca_club_tournament_daily d
           WHERE v.kind<>'CASH' AND d.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND d.tournament_id=v.id::uuid
             AND d.stat_date BETWEEN $2 AND $3
        ) f ON true
        LEFT JOIN LATERAL (
          SELECT count(DISTINCT p.user_id)::integer players
            FROM public.ca_club_tournament_player_daily p
           WHERE v.kind<>'CASH' AND p.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND p.tournament_id=v.id::uuid
             AND p.stat_date BETWEEN $2 AND $3
        ) tp ON true
    )
    SELECT jsonb_build_object(
      'sort',$7,
      'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'kind',q.kind,'id',q.id,'name',q.name,'variant',q.variant,
        'game_class',q.game_class,'stakes_tier',q.stakes_tier,
        'blinds',CASE WHEN q.big_blind>0 THEN
          trim(trailing '.' from trim(trailing '0' from q.small_blind::text))||'/'||
          trim(trailing '.' from trim(trailing '0' from q.big_blind::text)) END,
        'rake_percent',q.rake_percent,'started_at',q.started_at,'status',q.status,
        'creator_id',q.created_by,'creator_name',NULLIF(q.creator_name,''),
        'creator_avatar',q.creator_avatar,'fee',q.fee,'winnings',q.winnings,
        'hands',q.hands,'players',q.players)
        ORDER BY q.sort_value DESC,q.sort_time DESC,q.kind DESC,q.id DESC) FROM detail q),'[]'::jsonb),
      'next_cursor',CASE WHEN (SELECT count(*) FROM page_plus_one)>$9 THEN
        (SELECT jsonb_build_object('value',l.sort_value,'time',l.sort_time,'kind',l.kind,'id',l.id)
           FROM last_row l) ELSE NULL END,
      'has_more',(SELECT count(*) FROM page_plus_one)>$9,
      'filtered_count',(SELECT count(*) FROM filtered),
      'generated_at',now())
  $query$ INTO v_out
  USING p_club_id,v_start,v_end,v_game,v_stakes,v_search,v_sort,p_cursor,v_limit;

  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_data_snapshot_v2(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date:=(now() AT TIME ZONE 'UTC')::date;
  v_end date:=LEAST(COALESCE(p_end,v_today),v_today);
  v_start date:=COALESCE(p_start,v_end-13); v_days int; v_pstart date; v_pend date;
  v_game text:=UPPER(COALESCE(NULLIF(p_game,''),'ALL'));
  v_stakes text:=UPPER(COALESCE(NULLIF(p_stakes,''),'ALL'));
  v_q text:=NULLIF(btrim(COALESCE(p_search,'')),'');
  v_lim int:=GREATEST(LEAST(COALESCE(p_limit,100),500),1);
  v_union uuid; v_cur jsonb; v_prev jsonb; v_rows jsonb;
  v_felt numeric; v_pfelt numeric; v_felt_rows jsonb;
BEGIN
  IF NOT public.ca_can_view_whole_club_report(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
  IF v_start<v_end-92 THEN v_start:=v_end-92; END IF;
  IF v_start>v_end THEN v_start:=v_end; END IF;
  v_days:=(v_end-v_start)+1; v_pend:=v_start-1; v_pstart:=v_pend-(v_days-1);
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1;
  v_cur:=public.ca_club_data_screen(p_club_id,v_start,v_end,v_game,v_stakes,v_q,1)->'summary';
  v_prev:=public.ca_club_data_screen(p_club_id,v_pstart,v_pend,v_game,v_stakes,v_q,1)->'summary';
  v_cur:=v_cur||jsonb_build_object('hands',coalesce((public.fn_ca_club_game_summary(p_club_id,v_start,v_end,v_game,v_stakes,v_q)->>'hands')::bigint,0));
  v_prev:=v_prev||jsonb_build_object('hands',coalesce((public.fn_ca_club_game_summary(p_club_id,v_pstart,v_pend,v_game,v_stakes,v_q)->>'hands')::bigint,0));
  v_rows:=public.ca_club_game_page_core_20261006(p_club_id,v_start,v_end,v_game,v_stakes,v_q,'recent',NULL,v_lim)->'rows';
  IF EXISTS(SELECT 1 FROM public.unions u WHERE u.id=p_club_id) THEN v_union:=p_club_id; END IF;
  RETURN jsonb_build_object(
    'range',jsonb_build_object('start',v_start,'end',v_end,'days',v_days),
    'previous_range',jsonb_build_object('start',v_pstart,'end',v_pend,'days',v_days),
    'filters',jsonb_build_object('game',v_game,'stakes',v_stakes,'search',v_q),
    'summary',v_cur,'previous',v_prev,'delta',jsonb_build_object(
      'fee_pct',CASE WHEN COALESCE((v_prev->>'fee')::numeric,0)=0 THEN NULL ELSE round(((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric)/abs((v_prev->>'fee')::numeric)*100,1) END,
      'games_pct',CASE WHEN COALESCE((v_prev->>'games')::numeric,0)=0 THEN NULL ELSE round(((v_cur->>'games')::numeric-(v_prev->>'games')::numeric)/abs((v_prev->>'games')::numeric)*100,1) END,
      'winnings_abs',round((v_cur->>'total_winnings')::numeric-(v_prev->>'total_winnings')::numeric,2),
      'fee_abs',round((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric,2)),
    'rows',v_rows,'row_count',(v_cur->>'games')::int,'union_id',v_union,
    'data_updated_at',GREATEST(
      (SELECT max(c.updated_at) FROM public.club_table_daily c WHERE c.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND c.stat_date BETWEEN v_start AND v_end),
      (SELECT max(d.updated_at) FROM public.ca_club_tournament_daily d WHERE d.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN v_start AND v_end)),
    'generated_at',now());
END;
$function$;


REVOKE ALL ON FUNCTION public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer) TO authenticated,service_role;
-- Old clients reconcile cash + their legacy all-tournament MTT field. Keep that
-- transport contract while the v2 client reads exact MTTs and explicit subtotals.
CREATE OR REPLACE FUNCTION public.ca_club_data_snapshot(p_club_id uuid,p_start date DEFAULT NULL,p_end date DEFAULT NULL,p_game text DEFAULT 'ALL',p_stakes text DEFAULT 'ALL',p_search text DEFAULT NULL,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE r jsonb; k text;
BEGIN
 r:=public.ca_club_data_snapshot_v2(p_club_id,p_start,p_end,p_game,p_stakes,p_search,p_limit);
 FOREACH k IN ARRAY ARRAY['summary','previous'] LOOP
   r:=jsonb_set(r,ARRAY[k],(r->k)||jsonb_build_object('mtt_winnings',r->k->'tournament_winnings','mtt_fee',r->k->'tournament_fee'));
 END LOOP;
 RETURN r;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_player_breakdown(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date:=(now() AT TIME ZONE 'UTC')::date;
  v_end date:=LEAST(COALESCE(p_end,v_today),v_today);
  v_start date:=COALESCE(p_start,v_end-13);
  v_lim int:=GREATEST(LEAST(COALESCE(p_limit,100),500),1);
  v_union uuid; v_out jsonb;
BEGIN
  IF NOT public.ca_can_view_whole_club_report(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
  IF v_start<v_end-92 THEN v_start:=v_end-92; END IF;
  IF v_start>v_end THEN v_start:=v_end; END IF;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) LIMIT 1;
  WITH att_club AS MATERIALIZED (
    SELECT DISTINCT cm.user_id FROM public.club_members cm WHERE cm.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id))
  ), record AS MATERIALIZED (
    -- Hands and cash results exactly as the Member record files them: the
    -- funded club, UTC days, this club's launch accounting cutoff.
    SELECT f.user_id,SUM(f.net) FILTER (WHERE NOT f.is_mtt) cash_net,SUM(f.hands)::bigint hands
      FROM public.member_record_daily_facts f
     WHERE f.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id))
       AND f.accounting_cutoff IS NOT DISTINCT FROM public.fn_ca_launch_accounting_cutoff('club',f.club_id)
       AND f.played_on BETWEEN v_start AND v_end
     GROUP BY f.user_id
  ), tournament_pnl AS (
    SELECT d.user_id,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d
     WHERE d.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.user_id
  ), wallet_pnl AS (
    SELECT COALESCE(r.user_id,t.user_id) user_id,r.cash_net,t.tournament_net
      FROM record r FULL JOIN tournament_pnl t ON t.user_id=r.user_id
  ), rake AS (
    -- Fees exactly as the Member record counts them: cash and tournament
    -- fees filed to this club, from the fee counting start.
    SELECT t.user_id,sum(t.total_fees) rake
      FROM unnest(public.fn_ca_club_data_clubs(p_club_id)) cc(id) CROSS JOIN LATERAL public.ca_club_member_fee_totals(cc.id,v_start,v_end) t GROUP BY t.user_id
  ), hands AS (
    SELECT r.user_id,r.hands FROM record r
  ), merged AS MATERIALIZED (
    SELECT a.user_id,round(COALESCE(w.cash_net,0),2) cash_net,
      round(COALESCE(w.tournament_net,0),2) tournament_net,
      round(COALESCE(w.cash_net,0)+COALESCE(w.tournament_net,0),2) net,
      round(COALESCE(r.rake,0),2) rake,COALESCE(h.hands,0) hands
      FROM att_club a LEFT JOIN wallet_pnl w ON w.user_id=a.user_id
      LEFT JOIN rake r ON r.user_id=a.user_id LEFT JOIN hands h ON h.user_id=a.user_id
      WHERE (COALESCE(w.cash_net,0)<>0 OR COALESCE(w.tournament_net,0)<>0
         OR COALESCE(r.rake,0)<>0 OR COALESCE(h.hands,0)<>0)
        AND NOT EXISTS (SELECT 1 FROM public.profiles dp
                         WHERE dp.id = a.user_id AND dp.status = 'deleted')
  )
  SELECT jsonb_build_object('range',jsonb_build_object('start',v_start,'end',v_end,'days',(v_end-v_start)+1),
    'rake_complete_through',v_end,
    'totals',(SELECT jsonb_build_object('players',count(*),'net',round(COALESCE(SUM(net),0),2),
      'rake',round(COALESCE(SUM(rake),0),2),'hands',COALESCE(SUM(hands),0)) FROM merged),
    'players',COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id',q.user_id,
      'username',COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name),pr.username,'Player'),'avatar_url',pr.avatar_url,
      'is_horse',(public.fn_can_see_horse_flag(p_club_id) AND COALESCE(pr.is_horse,false)),'net',q.net,'cash_net',q.cash_net,
      'tournament_net',q.tournament_net,'rake',q.rake,'hands',q.hands) ORDER BY q.net DESC)
      FROM (SELECT * FROM merged ORDER BY net DESC LIMIT v_lim) q
      LEFT JOIN public.profiles pr ON pr.id=q.user_id),'[]'::jsonb),
    'player_count',(SELECT count(*) FROM merged),'generated_at',now()) INTO v_out;
  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_player_page_core_20261006(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_sort text DEFAULT 'winners'::text, p_search text DEFAULT NULL::text, p_cursor jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end,v_today),v_today);
  v_start date := COALESCE(p_start,v_end-13);
  v_sort text := LOWER(COALESCE(NULLIF(p_sort,''),'winners'));
  v_search text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_limit integer := GREATEST(LEAST(COALESCE(p_limit,100),200),1);
  v_union uuid;
  v_out jsonb;
BEGIN
  IF NOT public.ca_can_view_whole_club_report(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501';
  END IF;
  IF v_start < v_end-92 THEN v_start := v_end-92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  IF v_sort NOT IN ('winners','losers','rake','hands') THEN v_sort := 'winners'; END IF;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc
   WHERE uc.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) LIMIT 1;

  WITH att_club AS MATERIALIZED (
    SELECT DISTINCT cm.user_id FROM public.club_members cm WHERE cm.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id))
  ), record AS MATERIALIZED (
    -- Hands and cash results exactly as the Member record files them: the
    -- funded club, UTC days, this club's launch accounting cutoff.
    SELECT f.user_id,SUM(f.net) FILTER (WHERE NOT f.is_mtt) cash_net,SUM(f.hands)::bigint hands
      FROM public.member_record_daily_facts f
     WHERE f.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id))
       AND f.accounting_cutoff IS NOT DISTINCT FROM public.fn_ca_launch_accounting_cutoff('club',f.club_id)
       AND f.played_on BETWEEN v_start AND v_end
     GROUP BY f.user_id
  ), tournament_pnl AS (
    SELECT d.user_id,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d
     WHERE d.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.user_id
  ), wallet_pnl AS (
    SELECT COALESCE(r.user_id,t.user_id) user_id,r.cash_net,t.tournament_net
      FROM record r FULL JOIN tournament_pnl t ON t.user_id=r.user_id
  ), rake AS (
    -- Fees exactly as the Member record counts them: cash and tournament
    -- fees filed to this club, from the fee counting start.
    SELECT t.user_id,sum(t.total_fees) rake
      FROM unnest(public.fn_ca_club_data_clubs(p_club_id)) cc(id) CROSS JOIN LATERAL public.ca_club_member_fee_totals(cc.id,v_start,v_end) t GROUP BY t.user_id
  ), hands AS (
    SELECT r.user_id,r.hands FROM record r
  ), merged AS MATERIALIZED (
    SELECT a.user_id,COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name),pr.username,'Player') username,
           pr.avatar_url,(public.fn_can_see_horse_flag(p_club_id) AND COALESCE(pr.is_horse,false)) is_horse,
           round(COALESCE(w.cash_net,0),2) cash_net,
           round(COALESCE(w.tournament_net,0),2) tournament_net,
           round(COALESCE(w.cash_net,0)+COALESCE(w.tournament_net,0),2) net,
           round(COALESCE(r.rake,0),2) rake,COALESCE(h.hands,0) hands
      FROM att_club a LEFT JOIN wallet_pnl w ON w.user_id=a.user_id
      LEFT JOIN rake r ON r.user_id=a.user_id LEFT JOIN hands h ON h.user_id=a.user_id
      LEFT JOIN public.profiles pr ON pr.id=a.user_id
     WHERE (COALESCE(w.cash_net,0)<>0 OR COALESCE(w.tournament_net,0)<>0
        OR COALESCE(r.rake,0)<>0 OR COALESCE(h.hands,0)<>0)
        AND NOT EXISTS (SELECT 1 FROM public.profiles dp
                         WHERE dp.id = a.user_id AND dp.status = 'deleted')
  ), filtered AS MATERIALIZED (
    SELECT m.* FROM merged m
     WHERE v_search IS NULL OR m.username ILIKE '%'||v_search||'%'
        OR m.user_id::text ILIKE '%'||v_search||'%'
  ), scored AS MATERIALIZED (
    SELECT f.*,CASE v_sort WHEN 'losers' THEN -f.net
                           WHEN 'rake' THEN f.rake
                           WHEN 'hands' THEN f.hands::numeric
                           ELSE f.net END sort_value
      FROM filtered f
  ), page_plus_one AS MATERIALIZED (
    SELECT s.* FROM scored s
     WHERE p_cursor IS NULL OR ROW(s.sort_value,s.user_id::text) <
       ROW((p_cursor->>'value')::numeric,p_cursor->>'id')
     ORDER BY s.sort_value DESC,s.user_id::text DESC LIMIT v_limit+1
  ), visible AS MATERIALIZED (
    SELECT * FROM page_plus_one
     ORDER BY sort_value DESC,user_id::text DESC LIMIT v_limit
  ), last_row AS (
    SELECT * FROM visible ORDER BY sort_value ASC,user_id::text ASC LIMIT 1
  )
  SELECT jsonb_build_object(
    'sort',v_sort,
    'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'user_id',q.user_id,'username',q.username,'avatar_url',q.avatar_url,
      'is_horse',q.is_horse,'net',q.net,'cash_net',q.cash_net,
      'tournament_net',q.tournament_net,'rake',q.rake,'hands',q.hands)
      ORDER BY q.sort_value DESC,q.user_id::text DESC) FROM visible q),'[]'::jsonb),
    'next_cursor',CASE WHEN (SELECT count(*) FROM page_plus_one)>v_limit THEN
      (SELECT jsonb_build_object('value',l.sort_value,'id',l.user_id) FROM last_row l)
      ELSE NULL END,
    'has_more',(SELECT count(*) FROM page_plus_one)>v_limit,
    'filtered_count',(SELECT count(*) FROM filtered),
    'generated_at',now()) INTO v_out;

  RETURN v_out;
END;
$function$;

-- Preserve installed private/browser ACLs explicitly; neither pre-login role can call these reports.
REVOKE ALL ON FUNCTION public.fn_ca_club_cash_felt(uuid,date,date,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_ca_club_games(uuid,date,date,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_ca_club_games_searched(uuid,date,date,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_ca_club_games_unsearched(uuid,date,date,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_ca_club_game_rows_filtered(uuid,date,date,text,text,text,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_ca_club_game_rows(uuid,date,date,text,text,text,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_ca_club_game_summary_filtered(uuid,date,date,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_ca_club_game_summary(uuid,date,date,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ca_club_data_snapshot(uuid,date,date,text,text,text,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ca_club_player_breakdown(uuid,date,date,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_scope(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ca_club_data_screen(uuid,date,date,text,text,text,integer) FROM PUBLIC,anon;

-- The dedicated Union Data page uses the long-window rake endpoint. Its v2
-- contract shares the authoritative facts and current cash stacks, without
-- changing the legacy endpoint while old clients are still open.
CREATE OR REPLACE FUNCTION public.fn_ca_rake_felt_v2(p_clubs uuid[],p_start date,p_end date)
RETURNS TABLE(table_id uuid,club_id uuid,stat_date date,felt numeric) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $function$
 SELECT s.table_id,coalesce(s.club_id,public.fn_ca_cash_reporting_club(t.union_id,t.club_id,s.user_id)),(s.joined_at AT TIME ZONE 'UTC')::date,sum(s.stack)
 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id AND t.tournament_id IS NULL
 WHERE s.left_at IS NULL AND s.user_id IS NOT NULL AND coalesce(s.status,'active')<>'left' AND coalesce(s.stack,0)>0
 AND (s.joined_at AT TIME ZONE 'UTC')::date BETWEEN p_start AND p_end
 AND coalesce(s.club_id,public.fn_ca_cash_reporting_club(t.union_id,t.club_id,s.user_id))=ANY(p_clubs)
 GROUP BY 1,2,3;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_rake_felt_v2(uuid[],date,date) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_rake_window_v2(p_clubs uuid[],p_start date,p_end date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $function$
 WITH f AS MATERIALIZED (
 SELECT d.*,tr.tournament_type FROM public.ca_club_data_fact d LEFT JOIN public.tournaments tr ON d.kind='TOURNAMENT' AND tr.id=d.game_id
 WHERE d.club_id=ANY(p_clubs) AND d.stat_date BETWEEN p_start AND p_end
 ), felt AS MATERIALIZED (SELECT * FROM public.fn_ca_rake_felt_v2(p_clubs,p_start,p_end)),
 a AS (SELECT coalesce(sum(fee),0) fee,coalesce(sum(winnings),0) win,
 coalesce(sum(fee) FILTER(WHERE kind='CASH'),0) cf,coalesce(sum(winnings) FILTER(WHERE kind='CASH'),0) cw,
 coalesce(sum(fee) FILTER(WHERE kind='TOURNAMENT'),0) tf,coalesce(sum(winnings) FILTER(WHERE kind='TOURNAMENT'),0) tw,
 coalesce(sum(fee) FILTER(WHERE kind='TOURNAMENT' AND tournament_type='MTT'),0) mf,coalesce(sum(winnings) FILTER(WHERE kind='TOURNAMENT' AND tournament_type='MTT'),0) mw FROM f),
 games AS(SELECT kind,game_id FROM f UNION SELECT 'CASH',table_id FROM felt),
 hands AS(SELECT CASE WHEN cardinality(p_clubs)>1 THEN
 (SELECT count(*) FROM public.rake_records r WHERE r.created_at>=p_start::timestamp AT TIME ZONE 'UTC' AND r.created_at<(p_end+1)::timestamp AT TIME ZONE 'UTC'
 AND r.tournament_id IS NULL AND NOT coalesce(r.is_tournament,false)
 AND EXISTS(SELECT 1 FROM public.club_table_daily c WHERE c.club_id=ANY(p_clubs) AND c.stat_date BETWEEN p_start AND p_end AND c.table_id=r.table_id))
 ELSE (SELECT coalesce(sum(c.hands),0)::bigint FROM public.club_table_daily c WHERE c.club_id=ANY(p_clubs) AND c.stat_date BETWEEN p_start AND p_end) END n)
 SELECT jsonb_build_object('games',(SELECT count(*) FROM games),'cash_games',(SELECT count(*) FROM games WHERE kind='CASH'),
 'mtt_games',(SELECT count(DISTINCT game_id) FROM f WHERE kind='TOURNAMENT' AND tournament_type='MTT'),
 'tournament_games',(SELECT count(*) FROM games WHERE kind='TOURNAMENT'),'hands',(SELECT n FROM hands),
 'fee_exact',a.fee,'cash_fee_exact',a.cf,'mtt_fee_exact',a.mf,'tournament_fee_exact',a.tf,'fee',round(a.fee,2),'cash_fee',round(a.cf,2),'mtt_fee',round(a.mf,2),'tournament_fee',round(a.tf,2),
 'total_winnings',round(a.win+coalesce((SELECT sum(felt) FROM felt),0),2),
 'cash_winnings',round(a.cw+coalesce((SELECT sum(felt) FROM felt),0),2),'mtt_winnings',round(a.mw,2),'tournament_winnings',round(a.tw,2)) FROM a;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_rake_window_v2(uuid[],date,date) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_rake_series_v2(p_clubs uuid[],p_start date,p_end date,p_bucket text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $function$
 WITH rows AS(SELECT d.stat_date d,d.fee,d.winnings FROM public.ca_club_data_fact d WHERE d.club_id=ANY(p_clubs) AND d.stat_date BETWEEN p_start AND p_end
 UNION ALL SELECT stat_date,0,felt FROM public.fn_ca_rake_felt_v2(p_clubs,p_start,p_end)),
 agg AS(SELECT date_trunc(CASE WHEN p_bucket IN('day','week','month') THEN p_bucket ELSE 'day' END,d::timestamp)::date bucket,sum(fee) fee,sum(winnings) winnings FROM rows GROUP BY 1)
 SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY bucket),'[]'::jsonb) FROM agg a;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_rake_series_v2(uuid[],date,date,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_club_v2(p_clubs uuid[],p_start date,p_end date,p_limit integer,p_offset integer DEFAULT 0,p_search text DEFAULT NULL,p_sort text DEFAULT 'rake')
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $function$
 WITH ids AS(SELECT DISTINCT unnest(p_clubs) id),
 listed AS(SELECT c.id club_id,c.name,c.code,coalesce(c.avatar_url,c.logo_url) avatar_url,
 (w.s->>'fee_exact')::numeric fee,(w.s->>'cash_fee_exact')::numeric cash_fee,(w.s->>'mtt_fee_exact')::numeric mtt_fee,(w.s->>'tournament_fee_exact')::numeric tournament_fee,
 (w.s->>'total_winnings')::numeric winnings,(w.s->>'hands')::bigint hands,(w.s->>'games')::bigint games,public.ca_can_read_club_production(c.id) can_drill
 FROM ids JOIN public.clubs c ON c.id=ids.id CROSS JOIN LATERAL(SELECT public.fn_ca_rake_window_v2(ARRAY[c.id],p_start,p_end) s) w),
 filtered AS(SELECT * FROM listed WHERE nullif(btrim(coalesce(p_search,'')),'') IS NULL OR name ILIKE '%'||public.fn_like_escape(btrim(p_search))||'%' ESCAPE '\' OR coalesce(code,'') ILIKE '%'||public.fn_like_escape(btrim(p_search))||'%' ESCAPE '\'),
 page AS(SELECT * FROM filtered ORDER BY CASE WHEN p_sort='name' THEN name END,CASE WHEN p_sort='hands' THEN hands END DESC,CASE WHEN p_sort NOT IN('name','hands') THEN fee END DESC,name,club_id OFFSET greatest(coalesce(p_offset,0),0) LIMIT greatest(least(coalesce(p_limit,50),200),1))
 SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM page p),'[]'::jsonb),'total',(SELECT count(*) FROM filtered),'total_direct',(SELECT round(coalesce(sum(fee),0),2) FROM listed),'total_commission',NULL);
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_club_v2(uuid[],date,date,integer,integer,text,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.ca_rake_snapshot_v2(p_scope text DEFAULT 'club'::text, p_club_id uuid DEFAULT NULL::uuid, p_union_id uuid DEFAULT NULL::uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_agent_user_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'rake'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '20s'
 SET work_mem TO '64MB'
AS $function$
DECLARE
  v_scope text := lower(COALESCE(NULLIF(btrim(p_scope),''),'club'));
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start date := COALESCE(p_start, v_end - 6);
  v_off int := GREATEST(COALESCE(p_offset,0),0);
  v_q text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := lower(COALESCE(NULLIF(btrim(p_sort),''),'rake'));
  v_days int; v_pstart date; v_pend date; v_bucket text;
  v_union uuid; v_clubs uuid[];
  v_cur jsonb; v_prev jsonb; v_series jsonb;
  v_pack jsonb := jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0);
  v_kind text := 'none'; v_label text;
  v_agent jsonb; v_agent_p jsonb; v_live boolean := false;
BEGIN
  IF v_scope NOT IN ('club','union','agent') THEN
    RAISE EXCEPTION 'unknown scope %', v_scope USING ERRCODE='22023'; END IF;
  IF v_start < v_end - 730 THEN v_start := v_end - 730; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  v_days := (v_end - v_start) + 1; v_pend := v_start - 1; v_pstart := v_pend - (v_days - 1);
  v_bucket := CASE WHEN v_days <= 62 THEN 'day' WHEN v_days <= 400 THEN 'week' ELSE 'month' END;

  IF v_scope = 'agent' THEN
    IF p_club_id IS NULL THEN RAISE EXCEPTION 'agent scope needs a club' USING ERRCODE='22023'; END IF;
    v_agent := public.fn_agent_downline_rake_summary(p_agent_user_id, p_club_id,
      (v_start::timestamp AT TIME ZONE 'UTC'), ((v_end+1)::timestamp AT TIME ZONE 'UTC'));
    v_agent_p := public.fn_agent_downline_rake_summary(p_agent_user_id, p_club_id,
      (v_pstart::timestamp AT TIME ZONE 'UTC'), ((v_pend+1)::timestamp AT TIME ZONE 'UTC'));
    IF v_sort NOT IN ('rake','name','hands') THEN v_sort := 'rake'; END IF;
    v_pack := public.fn_ca_rake_by_downline(p_agent_user_id, p_club_id,
      (v_start::timestamp AT TIME ZONE 'UTC'), ((v_end+1)::timestamp AT TIME ZONE 'UTC'),
      p_limit, v_off, v_q, v_sort);
    SELECT COALESCE(c.name,'Club') INTO v_label FROM public.clubs c WHERE c.id = p_club_id;
    RETURN jsonb_build_object(
      'scope','agent','scope_label',COALESCE(v_label,'Downline'),'club_id',p_club_id,
      'union_id',NULL,'agent_user_id',p_agent_user_id,
      'range',jsonb_build_object('start',v_start,'end',v_end,'days',v_days),
      'previous_range',jsonb_build_object('start',v_pstart,'end',v_pend,'days',v_days),
      'summary',jsonb_build_object(
        'fee',round(COALESCE((v_agent->>'rake_generated')::numeric,0),2),
        'cash_fee',NULL,'mtt_fee',NULL,'games',NULL,
        'hands',COALESCE((v_agent->>'hands')::bigint,0),
        'total_winnings',NULL,'mtt_winnings',NULL,
        'members',COALESCE((v_agent->>'members')::int,0),
        'active',COALESCE((v_agent->>'active')::int,0),
        'commission_rate',(v_agent->>'commission_rate')::numeric,
        'estimated_commission',round(COALESCE((v_agent->>'estimated_commission')::numeric,0),2)),
      'previous',jsonb_build_object('fee',round(COALESCE((v_agent_p->>'rake_generated')::numeric,0),2),
        'hands',COALESCE((v_agent_p->>'hands')::bigint,0)),
      'delta',jsonb_build_object(
        'fee_pct',CASE WHEN COALESCE((v_agent_p->>'rake_generated')::numeric,0)=0 THEN NULL
          ELSE round((COALESCE((v_agent->>'rake_generated')::numeric,0)-(v_agent_p->>'rake_generated')::numeric)
               /abs((v_agent_p->>'rake_generated')::numeric)*100,1) END,
        'fee_abs',round(COALESCE((v_agent->>'rake_generated')::numeric,0)-COALESCE((v_agent_p->>'rake_generated')::numeric,0),2),
        'games_pct',NULL,'winnings_abs',NULL),
      'series','[]'::jsonb,'series_bucket',v_bucket,
      'breakdown',v_pack->'rows','breakdown_kind','downline',
      'breakdown_total',(v_pack->>'total_direct')::numeric,
      'breakdown_count',(v_pack->>'total')::int,
      'breakdown_offset',v_off,'commission_total',(v_pack->>'total_commission')::numeric,
      'breakdown_live',true,'rake_complete_through',NULL,
      'applied_search',v_q,'applied_sort',v_sort,
      'top_earner',v_agent->'top_earner','accounting_basis','utc_net_money_flow','generated_at',now());
  END IF;

  IF v_scope = 'union' THEN
    v_union := p_union_id;
    IF v_union IS NULL AND p_club_id IS NOT NULL THEN
      SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1; END IF;
    IF v_union IS NULL THEN RAISE EXCEPTION 'no union for this context' USING ERRCODE='22023'; END IF;
    IF NOT public.ca_can_oversee_union(v_union) THEN
      RAISE EXCEPTION 'not authorized for this union' USING ERRCODE='42501'; END IF;
    v_clubs:=public.fn_ca_club_data_clubs(v_union);
    SELECT u.name INTO v_label FROM public.unions u WHERE u.id=v_union;
    IF v_sort NOT IN ('rake','name','hands') THEN v_sort := 'rake'; END IF;
    v_pack := public.fn_ca_rake_by_club_v2(v_clubs, v_start, v_end, p_limit, v_off, v_q, v_sort);
    v_kind := 'club'; v_live := false;
  ELSE
    IF p_club_id IS NULL THEN RAISE EXCEPTION 'club scope needs a club' USING ERRCODE='22023'; END IF;
    IF NOT public.ca_can_read_whole_club_production(p_club_id) THEN
      RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
    v_clubs := ARRAY[p_club_id];
    SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1;
    SELECT c.name INTO v_label FROM public.clubs c WHERE c.id=p_club_id;
    IF v_sort NOT IN ('rake','name','cost','players') THEN v_sort := 'rake'; END IF;
    v_pack := public.fn_ca_rake_by_agent(p_club_id, v_start, v_end, p_limit, v_off, v_q, v_sort);
    v_kind := 'agent'; v_live := true;
  END IF;

  IF v_clubs IS NULL OR array_length(v_clubs,1) IS NULL THEN v_clubs := ARRAY[]::uuid[]; END IF;

  v_cur := public.fn_ca_rake_window_v2(v_clubs, v_start, v_end);
  v_prev := public.fn_ca_rake_window_v2(v_clubs, v_pstart, v_pend);
  v_series := public.fn_ca_rake_series_v2(v_clubs, v_start, v_end, v_bucket);

  RETURN jsonb_build_object(
    'scope',v_scope,'scope_label',COALESCE(v_label,initcap(v_scope)),
    'club_id',p_club_id,'union_id',v_union,'club_count',array_length(v_clubs,1),
    'range',jsonb_build_object('start',v_start,'end',v_end,'days',v_days),
    'previous_range',jsonb_build_object('start',v_pstart,'end',v_pend,'days',v_days),
    'summary',v_cur,'previous',v_prev,
    'delta',jsonb_build_object(
      'fee_pct',CASE WHEN COALESCE((v_prev->>'fee')::numeric,0)=0 THEN NULL
        ELSE round(((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric)/abs((v_prev->>'fee')::numeric)*100,1) END,
      'games_pct',CASE WHEN COALESCE((v_prev->>'games')::numeric,0)=0 THEN NULL
        ELSE round(((v_cur->>'games')::numeric-(v_prev->>'games')::numeric)/abs((v_prev->>'games')::numeric)*100,1) END,
      'fee_abs',round((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric,2),
      'winnings_abs',round((v_cur->>'total_winnings')::numeric-(v_prev->>'total_winnings')::numeric,2)),
    'series',v_series,'series_bucket',v_bucket,
    'breakdown',v_pack->'rows','breakdown_kind',v_kind,
    'breakdown_total',(v_pack->>'total_direct')::numeric,
    'breakdown_count',(v_pack->>'total')::int,
    'breakdown_offset',v_off,'commission_total',(v_pack->>'total_commission')::numeric,
    'breakdown_live',v_live,'rake_complete_through',NULL,
    'applied_search',v_q,'applied_sort',v_sort,
    'data_updated_at',GREATEST(
      (SELECT max(c.updated_at) FROM public.club_table_daily c
        WHERE c.club_id = ANY(v_clubs) AND c.stat_date BETWEEN v_start AND v_end),
      (SELECT max(d.updated_at) FROM public.ca_club_tournament_daily d
        WHERE d.club_id = ANY(v_clubs) AND d.stat_date BETWEEN v_start AND v_end)),
    'accounting_basis','utc_net_money_flow','generated_at',now());
END;
$function$

;
REVOKE ALL ON FUNCTION public.ca_rake_snapshot_v2(text,uuid,uuid,date,date,uuid,integer,integer,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_rake_snapshot_v2(text,uuid,uuid,date,date,uuid,integer,integer,text,text) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public.ca_rake_export_start_v2(p_scope_type text, p_scope_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_agent_user_id uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'rake'::text, p_request_id uuid DEFAULT gen_random_uuid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_scope text := lower(COALESCE(NULLIF(btrim(p_scope_type), ''), ''));
  v_scope_id uuid := p_scope_id;
  v_club_id uuid;
  v_union_id uuid;
  v_agent_user_id uuid;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start date := COALESCE(p_start, v_end - 6);
  v_search text := NULLIF(left(btrim(COALESCE(p_search, '')), 160), '');
  v_sort text := lower(COALESCE(NULLIF(btrim(p_sort), ''), 'rake'));
  v_request uuid := COALESCE(p_request_id, gen_random_uuid());
  v_chunk integer;
  v_max_rows constant integer := 20000;
  v_export_id uuid;
  v_expires_at timestamptz;
  v_existing public.ca_club_data_exports%ROWTYPE;
  v_response jsonb;
  v_reported integer;
  v_inserted integer;
  v_agent_overflow boolean;
  v_book_rows integer;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'sign in to prepare a Rake Snapshot export'
      USING ERRCODE = '42501';
  END IF;
  IF v_scope NOT IN ('club', 'union', 'agent') OR v_scope_id IS NULL THEN
    RAISE EXCEPTION 'Rake Snapshot export scope is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF v_start < v_end - 730 THEN v_start := v_end - 730; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;

  IF v_scope = 'club' THEN
    v_club_id := v_scope_id;
    v_agent_user_id := NULL;
    v_chunk := 200;
    IF v_sort NOT IN ('rake', 'name', 'cost', 'players') THEN v_sort := 'rake'; END IF;
    IF NOT public.ca_can_read_club_production(v_club_id) THEN
      RAISE EXCEPTION 'Rake Snapshot export is no longer authorized'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_scope = 'union' THEN
    v_union_id := v_scope_id;
    v_agent_user_id := NULL;
    v_chunk := 200;
    IF v_sort NOT IN ('rake', 'name', 'hands') THEN v_sort := 'rake'; END IF;
    IF NOT public.ca_can_oversee_union(v_union_id) THEN
      RAISE EXCEPTION 'Rake Snapshot export is no longer authorized'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    v_club_id := v_scope_id;
    v_agent_user_id := COALESCE(p_agent_user_id, v_user);
    v_chunk := 500;
    IF v_sort NOT IN ('rake', 'name', 'hands') THEN v_sort := 'rake'; END IF;
    IF NOT public.ca_can_read_rake_agent(v_agent_user_id, v_club_id) THEN
      RAISE EXCEPTION 'Rake Snapshot export is no longer authorized'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- One start per user at a time, refused immediately rather than queued.
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('ca-club-data-export-user:' || v_user::text, 0)
  ) THEN
    RAISE EXCEPTION 'Another Club Data export is already being prepared.'
      USING ERRCODE = '55000';
  END IF;

  -- A retried request resumes the same immutable job, and only a Rake job.
  SELECT *
    INTO v_existing
    FROM public.ca_club_data_exports existing_job
   WHERE existing_job.user_id = v_user
     AND existing_job.request_id = v_request
     AND existing_job.kind = 'rake'
     AND existing_job.expires_at >= now();

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.scope_type IS DISTINCT FROM v_scope
       OR v_existing.scope_id IS DISTINCT FROM v_scope_id
       OR v_existing.agent_user_id IS DISTINCT FROM v_agent_user_id
       OR v_existing.date_from IS DISTINCT FROM v_start
       OR v_existing.date_to IS DISTINCT FROM v_end
       OR v_existing.request_search IS DISTINCT FROM v_search
       OR v_existing.sort_key IS DISTINCT FROM v_sort THEN
      RAISE EXCEPTION 'Rake Snapshot request id was already used for different inputs'
        USING ERRCODE = '22023';
    END IF;
    IF v_existing.status <> 'ready' THEN
      RAISE EXCEPTION 'Rake Snapshot export is still being prepared'
        USING ERRCODE = '55000';
    END IF;
    IF COALESCE(
         (v_existing.metadata ->> 'contains_admin_commission')::boolean,
         false
       )
       AND NOT public.fn_is_club_admin_uid(v_existing.club_id) THEN
      RAISE EXCEPTION
        'Rake Snapshot export permissions changed; prepare a new export'
        USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object(
      'export_id', v_existing.id,
      'status', v_existing.status,
      'kind', v_existing.kind,
      'total_rows', v_existing.total_rows,
      'total_amount', v_existing.total_amount,
      'expires_at', v_existing.expires_at,
      'metadata', v_existing.metadata,
      'metadata_fingerprint', v_existing.metadata_fingerprint
    );
  END IF;

  -- The same request id held by a live job of another kind is a different
  -- request: refused, never replayed as Rake and never rebuilt over it.
  IF EXISTS (
    SELECT 1
      FROM public.ca_club_data_exports other_kind
     WHERE other_kind.user_id = v_user
       AND other_kind.request_id = v_request
       AND other_kind.kind <> 'rake'
       AND other_kind.expires_at >= now()
  ) THEN
    RAISE EXCEPTION 'Rake Snapshot request id was already used for different inputs'
      USING ERRCODE = '22023';
  END IF;

  -- The expired job owned by the caller is reclaimed first, and never behind
  -- the shared prune's try-lock: an owner whose previous export lost its
  -- cleanup must not be locked out of the next one. Bounded to one export
  -- (50,000 rows exceeds anything a door can prepare); SKIP LOCKED so a
  -- prune retiring the same parent from another session is never waited on.
  DELETE FROM public.ca_club_data_export_rows own_row
   USING (
     SELECT stale_row.export_id, stale_row.ordinal
       FROM public.ca_club_data_export_rows stale_row
       JOIN public.ca_club_data_exports expired_slot
         ON expired_slot.id = stale_row.export_id
      WHERE expired_slot.user_id = v_user
        AND expired_slot.expires_at < now()
      ORDER BY stale_row.export_id, stale_row.ordinal
      LIMIT 50000
      FOR UPDATE OF stale_row SKIP LOCKED
   ) doomed
   WHERE own_row.export_id = doomed.export_id
     AND own_row.ordinal = doomed.ordinal;

  DELETE FROM public.ca_club_data_exports expired_slot
   USING (
     SELECT reclaimable.id
       FROM public.ca_club_data_exports reclaimable
      WHERE reclaimable.user_id = v_user
        AND reclaimable.expires_at < now()
      FOR UPDATE SKIP LOCKED
   ) reclaimed
   WHERE expired_slot.id = reclaimed.id
     AND NOT EXISTS (
       SELECT 1
         FROM public.ca_club_data_export_rows export_row
        WHERE export_row.export_id = expired_slot.id
     );

  IF EXISTS (
    SELECT 1
      FROM public.ca_club_data_exports active_slot
     WHERE active_slot.user_id = v_user
  ) THEN
    RAISE EXCEPTION
      'Another Club Data export is already being prepared, downloaded, or cleaned up.'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.ca_club_data_exports(
    user_id, club_id, request_id, kind, scope_type, scope_id, union_id,
    agent_user_id, date_from, date_to, request_search, sort_key
  )
  VALUES (
    v_user, v_club_id, v_request, 'rake', v_scope, v_scope_id, v_union_id,
    v_agent_user_id, v_start, v_end, v_search, v_sort
  )
  RETURNING id, expires_at INTO v_export_id, v_expires_at;

  -- One data-changing statement owns the reporting snapshot. Its first call
  -- goes through ca_rake_snapshot, the public canonical door and authorization
  -- gate. Remaining pages call only the same private helpers that door uses.
  -- No Rake arithmetic or commission allocation is reimplemented here.
  WITH first_snapshot AS MATERIALIZED (
    SELECT public.ca_rake_snapshot_v2(
      v_scope,
      v_club_id,
      v_union_id,
      v_start,
      v_end,
      v_agent_user_id,
      v_chunk,
      0,
      v_search,
      v_sort
    ) AS document
  -- Search is applied after fn_ca_rake_by_downline's deliberately widened
  -- 20,001-row source walk. Count that unfiltered source independently: a
  -- narrow search must never turn a truncated downline into a "complete" file.
  ), agent_capacity AS MATERIALIZED (
    SELECT public.fn_ca_rake_by_downline(
             v_agent_user_id,
             v_club_id,
             (v_start::timestamp AT TIME ZONE 'UTC'),
             ((v_end + 1)::timestamp AT TIME ZONE 'UTC'),
             1,
             0,
             NULL,
             'rake'
           ) AS document
     WHERE v_scope = 'agent'
  ), snapshot_shape AS MATERIALIZED (
    SELECT first_snapshot.document,
           GREATEST(
             COALESCE((first_snapshot.document ->> 'breakdown_count')::integer, 0),
             0
           ) AS total,
           (
             v_scope = 'club'
             AND public.fn_is_club_admin_uid(v_club_id)
           ) AS contains_admin_commission,
           COALESCE(
             (agent_capacity.document ->> 'total')::integer,
             0
           ) > v_max_rows AS agent_overflow
      FROM first_snapshot
      LEFT JOIN agent_capacity ON true
  ), bounded_snapshot AS MATERIALIZED (
    SELECT *
      FROM snapshot_shape
     WHERE snapshot_shape.total <= v_max_rows
       AND NOT snapshot_shape.agent_overflow
  ), page_offsets AS (
    SELECT generate_series(0, bounded_snapshot.total - 1, v_chunk)::integer AS page_offset,
           bounded_snapshot.document,
           bounded_snapshot.total,
           bounded_snapshot.contains_admin_commission
      FROM bounded_snapshot
  ), page_packs AS MATERIALIZED (
    SELECT page_offsets.page_offset,
           CASE
             WHEN page_offsets.page_offset = 0 THEN
               jsonb_build_object(
                 'rows', COALESCE(page_offsets.document -> 'breakdown', '[]'::jsonb)
               )
             WHEN v_scope = 'club' THEN public.fn_ca_rake_by_agent(
               v_club_id, v_start, v_end, v_chunk, page_offsets.page_offset,
               v_search, v_sort
             )
             WHEN v_scope = 'union' THEN public.fn_ca_rake_by_club_v2(
               public.fn_ca_club_data_clubs(v_union_id),
               v_start, v_end, v_chunk, page_offsets.page_offset, v_search, v_sort
             )
             ELSE public.fn_ca_rake_by_downline(
               v_agent_user_id,
               v_club_id,
               (v_start::timestamp AT TIME ZONE 'UTC'),
               ((v_end + 1)::timestamp AT TIME ZONE 'UTC'),
               v_chunk,
               page_offsets.page_offset,
               v_search,
               v_sort
             )
           END AS page_document
      FROM page_offsets
  ), collected AS MATERIALIZED (
    SELECT page_row.row_data
      FROM page_packs
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(page_packs.page_document -> 'rows', '[]'::jsonb)
      ) WITH ORDINALITY AS page_row(row_data, page_ordinal)
  ), ordered AS (
    SELECT row_number() OVER (
             ORDER BY
               CASE WHEN v_scope = 'club' THEN
                 COALESCE((collected.row_data ->> 'is_unassigned')::boolean, false)
               END ASC NULLS LAST,
               CASE WHEN v_scope = 'club' AND v_sort = 'name' THEN
                 lower(COALESCE(collected.row_data ->> 'name', ''))
               END ASC NULLS LAST,
               CASE WHEN v_scope = 'club' AND v_sort = 'cost' THEN
                 NULLIF(collected.row_data ->> 'commission_earned', '')::numeric
               END DESC NULLS LAST,
               CASE WHEN v_scope = 'club' AND v_sort = 'players' THEN
                 COALESCE((collected.row_data ->> 'network_players')::numeric, 0)
               END DESC NULLS LAST,
               CASE WHEN v_scope = 'club' AND v_sort = 'rake' THEN
                 COALESCE((collected.row_data ->> 'network_rake')::numeric, 0)
               END DESC NULLS LAST,
               CASE WHEN v_scope = 'union' AND v_sort = 'name' THEN
                 lower(COALESCE(collected.row_data ->> 'name', ''))
               END ASC NULLS LAST,
               CASE WHEN v_scope = 'union' AND v_sort = 'hands' THEN
                 COALESCE((collected.row_data ->> 'hands')::numeric, 0)
               END DESC NULLS LAST,
               CASE WHEN v_scope = 'union' AND v_sort = 'rake' THEN
                 COALESCE((collected.row_data ->> 'fee')::numeric, 0)
               END DESC NULLS LAST,
               CASE WHEN v_scope = 'agent' AND v_sort = 'name' THEN
                 lower(COALESCE(collected.row_data ->> 'name', ''))
               END ASC NULLS LAST,
               CASE WHEN v_scope = 'agent' AND v_sort = 'hands' THEN
                 COALESCE((collected.row_data ->> 'hands')::numeric, 0)
               END DESC NULLS LAST,
               CASE WHEN v_scope = 'agent' AND v_sort = 'rake' THEN
                 COALESCE((collected.row_data ->> 'rake')::numeric, 0)
               END DESC NULLS LAST,
               lower(COALESCE(collected.row_data ->> 'name', '')) ASC,
               CASE WHEN v_scope = 'club' THEN
                 COALESCE(collected.row_data ->> 'agent_user_id', '')
               END ASC,
               CASE WHEN v_scope = 'union' THEN
                 COALESCE(collected.row_data ->> 'club_id', '')
               END ASC,
               CASE WHEN v_scope = 'agent' THEN
                 COALESCE(collected.row_data ->> 'player_id', '')
               END ASC
           )::integer AS ordinal,
           collected.row_data AS payload
      FROM collected
  ), inserted_rows AS (
    INSERT INTO public.ca_club_data_export_rows(export_id, ordinal, payload)
    SELECT v_export_id, ordered.ordinal, ordered.payload
      FROM ordered
     ORDER BY ordered.ordinal
    RETURNING ordinal
  ), ready_metadata AS MATERIALIZED (
    SELECT jsonb_build_object(
             'schema_version', 1,
             'kind', 'rake',
             'scope_type', v_scope,
             'scope_id', v_scope_id,
             'club_id', v_club_id,
             -- Scope identity, not incidental membership context: a club that
             -- belongs to a union is still a club-scoped immutable request.
             'union_id', v_union_id,
             'agent_user_id', v_agent_user_id,
             'date_from', v_start,
             'date_to', v_end,
             'search', v_search,
             'sort', v_sort,
             'generated_at', snapshot_shape.document -> 'generated_at',
             'scope_label', snapshot_shape.document -> 'scope_label',
             'breakdown_kind', snapshot_shape.document -> 'breakdown_kind',
             'breakdown_total', COALESCE(
               (snapshot_shape.document ->> 'breakdown_total')::numeric,
               0
             ),
             'commission_total', snapshot_shape.document -> 'commission_total',
             'contains_admin_commission', snapshot_shape.contains_admin_commission
           ) AS metadata,
           snapshot_shape.total,
           COALESCE(
             (snapshot_shape.document ->> 'breakdown_total')::numeric,
             0
           ) AS total_amount
      FROM snapshot_shape
     WHERE snapshot_shape.total <= v_max_rows
       AND NOT snapshot_shape.agent_overflow
  ), finalized AS (
    UPDATE public.ca_club_data_exports export_job
       SET status = 'ready',
           total_rows = ready_metadata.total,
           total_amount = ready_metadata.total_amount,
           union_id = NULLIF(ready_metadata.metadata ->> 'union_id', '')::uuid,
           metadata = ready_metadata.metadata,
           metadata_fingerprint = md5(ready_metadata.metadata::text)
      FROM ready_metadata
     WHERE export_job.id = v_export_id
       AND (SELECT count(*) FROM inserted_rows) = ready_metadata.total
    RETURNING jsonb_build_object(
      'export_id', export_job.id,
      'status', export_job.status,
      'kind', export_job.kind,
      'total_rows', export_job.total_rows,
      'total_amount', export_job.total_amount,
      'expires_at', export_job.expires_at,
      'metadata', export_job.metadata,
      'metadata_fingerprint', export_job.metadata_fingerprint
    ) AS response
  )
  SELECT (SELECT finalized.response FROM finalized),
         snapshot_shape.total,
         (SELECT count(*)::integer FROM inserted_rows),
         snapshot_shape.agent_overflow
    INTO v_response, v_reported, v_inserted, v_agent_overflow
    FROM snapshot_shape;

  IF COALESCE(v_agent_overflow, false) THEN
    -- Refused before any search filtering, and the refusal names the whole
    -- unfiltered book, never the searched subset. The capacity walk above
    -- stops at its 20,001-row sentinel, so the book is counted once more
    -- here, uncapped, on this refusal path only.
    SELECT count(*)::integer
      INTO v_book_rows
      FROM public.fn_agent_downline_rake(
             v_agent_user_id,
             v_club_id,
             (v_start::timestamp AT TIME ZONE 'UTC'),
             ((v_end + 1)::timestamp AT TIME ZONE 'UTC'),
             NULL,
             2147483647
           );
    RAISE EXCEPTION
      'Rake Snapshot export has % rows; the safe limit is %',
      v_book_rows,
      v_max_rows
      USING ERRCODE = '54000';
  END IF;
  IF v_reported > v_max_rows THEN
    RAISE EXCEPTION
      'Rake Snapshot export has % rows; the safe limit is %',
      v_reported,
      v_max_rows
      USING ERRCODE = '54000';
  END IF;
  IF v_reported IS NULL OR v_inserted IS DISTINCT FROM v_reported
     OR v_response IS NULL THEN
    RAISE EXCEPTION
      'Rake Snapshot export changed while it was being prepared'
      USING ERRCODE = '55000';
  END IF;

  -- Somebody else's stranded expired job, if any: bounded, non-blocking,
  -- and last, so the row locks it takes are held only until this commit.
  PERFORM public.ca_prune_expired_club_data_exports(2000);

  RETURN v_response;
END;
$function$
;
REVOKE ALL ON FUNCTION public.ca_rake_export_start_v2(text,uuid,date,date,uuid,text,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_rake_export_start_v2(text,uuid,date,date,uuid,text,text,uuid) TO authenticated,service_role;


COMMIT;
