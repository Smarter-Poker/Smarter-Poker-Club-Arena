-- ═══════════════════════════════════════════════════════════════════════════
--  R10: A MUST-MOVE GAME COUNTS ITS PLAYERS LIKE A TOURNAMENT (2026-09-04)
-- ═══════════════════════════════════════════════════════════════════════════
-- Dan, verbatim: "0/6 SHOULD NEVER BE A THING ON MUST MOVE GAMES, IT SHOULD
-- ACT LIKE A TOURNAMENT COUNTER, AND COUNT HOW MANY PLAYERS ARE INSIDE THIS
-- GAME TYPE."
--
-- get_club_home (body as deployed 2026-09-04) now carries, per table row, the
-- cluster it belongs to and the GAME-wide figures - players inside the whole
-- game, live tables in it, must_move, template, state - and no longer lists a
-- cluster table whose lifecycle is closed. The lobby collapses a cluster to
-- one row (Main 1) and paints the game figures on it.
--
-- Functions only: one transaction, no table lock.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_club_home(p_club_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club           public.clubs%ROWTYPE;
  v_uid            uuid := auth.uid();
  v_union_id       uuid;
  v_union_club_ids uuid[];
  v_member_count   integer;
  v_playing        integer;
  v_membership     jsonb;
  v_tables         jsonb;
  v_tournaments    jsonb;
  v_bbj            jsonb;
  v_club_names     jsonb;
BEGIN
  IF p_club_key ~ '^[0-9a-fA-F]{8}-' THEN
    SELECT * INTO v_club FROM public.clubs WHERE id = p_club_key::uuid LIMIT 1;
  ELSIF p_club_key ~ '^[0-9]+$' THEN
    SELECT * INTO v_club FROM public.clubs WHERE club_id = p_club_key::integer LIMIT 1;
  ELSE
    SELECT * INTO v_club FROM public.clubs WHERE slug = p_club_key LIMIT 1;
  END IF;

  IF v_club.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT uc.union_id INTO v_union_id
  FROM public.union_clubs uc WHERE uc.club_id = v_club.id LIMIT 1;
  IF v_union_id IS NULL THEN
    v_union_id := v_club.union_id;
  END IF;

  IF v_union_id IS NOT NULL THEN
    SELECT array_agg(uc.club_id) INTO v_union_club_ids
    FROM public.union_clubs uc WHERE uc.union_id = v_union_id;
  END IF;
  v_union_club_ids := COALESCE(v_union_club_ids, ARRAY[]::uuid[]) || v_club.id;

  -- THIS CLUB'S MEMBERS. Not the union's. See the header.
  -- 2026-09-02: through the definer helper. Under club_members RLS this COUNT
  -- evaluated four policy functions per member row - 2,026 ms for Deep Stack
  -- Society - and, called ~70x/min by the lobby, was 26% of all database time.
  v_member_count := public.fn_club_member_count(v_club.id);

  -- Everyone in a seat at a live table, right now, anywhere on the platform.
  -- Counted from the seats, never from clubs.online_count.
  SELECT count(DISTINCT ts.user_id)::int INTO v_playing
  FROM public.table_seats ts
  JOIN public.tables tb ON tb.id = ts.table_id
  WHERE ts.left_at IS NULL
    AND tb.status IN ('waiting', 'running')
    AND public.fn_club_home_in_scope(
          tb.club_id, tb.is_private, tb.union_id,
          v_union_id, v_club.id, v_union_club_ids);

  IF v_uid IS NOT NULL THEN
    SELECT jsonb_build_object('chip_balance', cm.chip_balance, 'role', cm.role)
      INTO v_membership
    FROM public.club_members cm
    WHERE cm.club_id = v_club.id AND cm.user_id = v_uid LIMIT 1;
  END IF;

  -- id -> name for every club whose games can appear on this board.
  SELECT COALESCE(jsonb_object_agg(c.id::text, c.name), '{}'::jsonb) INTO v_club_names
  FROM public.clubs c WHERE c.id = ANY (v_union_club_ids);

  -- A LIVE GAME MUST NEVER BE TRUNCATED AWAY (2026-09-02, same rule as
  -- TableService.getClubTables in #2696): occupancy first, so the 200-row cap
  -- can only ever trim EMPTY tables. Ordered by created_at alone, Deep Stack
  -- Society's 1,058 open tables put its 51 running games behind the 200
  -- newest empty ones and the lobby read "0/x OPEN" all the way down.
  SELECT COALESCE(jsonb_agg(t ORDER BY t.current_players DESC, t.created_at DESC), '[]'::jsonb) INTO v_tables
  FROM (
    SELECT id, name, game_variant, stakes, current_players, max_players, status,
           small_blind, big_blind, min_buy_in, max_buy_in, created_at, club_id,
           run_it_twice, run_it_twice_enabled, allow_run_it_twice, run_it_mode,
           insurance_enabled, straddle_enabled, straddle_type, auto_utg_straddle,
           bomb_pot_enabled, bomb_pot_frequency, bomb_pot_double_board, bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds, bomb_pot_variant, bomb_pot_ante_multiplier, bomb_pot_ante_fixed,
           ante_enabled, ante, seven_deuce_enabled, seven_deuce_amount,
           time_bank_enabled, all_in_or_fold,
           cap_enabled, cap_bb, no_rathole, pineapple_holdem,
           is_anonymous, ban_chat, restrict_observers, auto_start_players,
           is_vip_only, label_as_new, is_featured, hide_club_name,
           nit_game, career_percent_min, maintain_percent_min, maintain_hands,
           -- R10 (Dan 2026-09-04): a must-move game shows how many players are
           -- INSIDE THE GAME, like a tournament counter, never a per-table x/6.
           -- The lobby collapses a cluster to its Main 1 row and paints these.
           cluster_id, role, main_index, lifecycle,
           (SELECT g.must_move FROM public.cash_games g WHERE g.id = tb.cluster_id) AS cluster_must_move,
           (SELECT g.template_name FROM public.cash_games g WHERE g.id = tb.cluster_id) AS cluster_template,
           (SELECT g.state FROM public.cash_games g WHERE g.id = tb.cluster_id) AS cluster_state,
           (SELECT count(*) FROM public.table_seats ts JOIN public.tables t2 ON t2.id = ts.table_id
             WHERE t2.cluster_id = tb.cluster_id AND ts.left_at IS NULL AND t2.lifecycle <> 'closed')::int AS cluster_players,
           (SELECT count(*) FROM public.tables t2
             WHERE t2.cluster_id = tb.cluster_id AND t2.lifecycle <> 'closed'
               AND t2.status IN ('waiting','running','active'))::int AS cluster_tables
    FROM public.tables tb
    WHERE is_deleted = false
      AND status NOT IN ('closed', 'deleted')
      AND COALESCE(lifecycle, 'live') <> 'closed'
      AND tournament_id IS NULL
      AND COALESCE(is_template, false) = false
      AND public.fn_club_home_in_scope(club_id, is_private, union_id,
                                       v_union_id, v_club.id, v_union_club_ids)
    ORDER BY current_players DESC, created_at DESC LIMIT 200
  ) t;

  SELECT COALESCE(jsonb_agg(x ORDER BY x.start_time ASC), '[]'::jsonb) INTO v_tournaments
  FROM (
    SELECT id, name, game_type, variant, table_size, buy_in_amount, buy_in_fee,
           guaranteed_prize, start_time, status, current_players, max_players,
           starting_chips, club_id, union_id, is_xmtt, late_reg_mins,
           late_reg_levels, started_at, current_level,
           is_vip_only, label_as_new, hide_club_name, is_pinned
    FROM public.tournaments
    WHERE status IN ('REGISTERING', 'RUNNING', 'LATE_REG', 'STARTING_SOON')
      -- THE PUBLISHED WINDOW (2026-08-26). Everything already under way or
      -- starting inside 48 hours, plus anything above a 200 total buy-in for
      -- 6 days. The client applies the identical rule row by row
      -- (src/utils/tournamentScheduleWindow.ts); this bound exists so the
      -- LIMIT below can never be what decides, since a running event's
      -- start_time is in the past and therefore sorts ahead of the whole
      -- future card.
      AND start_time <= now() + interval '72 hours'
             + CASE
                 WHEN COALESCE(buy_in_amount, 0) + COALESCE(buy_in_fee, 0) >= 200
                   THEN interval '3 days'
                 ELSE interval '0'
               END
      AND public.fn_club_home_in_scope(club_id, is_private, union_id,
                                       v_union_id, v_club.id, v_union_club_ids)
    ORDER BY start_time ASC LIMIT 500
  ) x;

  SELECT jsonb_build_object('id', bp.id, 'main_balance', bp.main_balance) INTO v_bbj
  FROM public.bbj_pools bp
  WHERE CASE WHEN v_union_id IS NOT NULL
             THEN (bp.union_id = v_union_id OR bp.club_id = ANY (v_union_club_ids))
             ELSE bp.club_id = v_club.id END
  ORDER BY (bp.union_id IS NOT NULL) DESC LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    'club', jsonb_build_object(
      'id', v_club.id,
      'club_id', v_club.club_id,
      'name', v_club.name,
      'description', v_club.description,
      'avatar_url', v_club.avatar_url,
      'logo_url', v_club.logo_url,
      'member_count', v_member_count,
      'online_count', v_playing,
      'owner_id', v_club.owner_id,
      'level', v_club.level,
      'hierarchy_units_rounded_up', v_club.hierarchy_units_rounded_up,
      'player_threshold_current', v_club.player_threshold_current,
      'player_threshold_next', v_club.player_threshold_next,
      'hierarchy_threshold_current', v_club.hierarchy_threshold_current,
      'hierarchy_threshold_next', v_club.hierarchy_threshold_next,
      'created_at', v_club.created_at
    ),
    'membership', v_membership,
    'union_id', v_union_id,
    'union_club_ids', to_jsonb(v_union_club_ids),
    'club_names', v_club_names,
    'member_count', v_member_count,
    'players_playing', v_playing,
    'tables', v_tables,
    'tournaments', v_tournaments,
    'bbj', v_bbj
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_club_home(text) TO authenticated, service_role;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_club_home';
  IF position('cluster_players' in v_src) = 0 OR position('cluster_tables' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: get_club_home does not carry the game figures';
  END IF;
  RAISE NOTICE 'R10: the club home carries the game-wide player count for a cluster.';
END $$;

COMMIT;
