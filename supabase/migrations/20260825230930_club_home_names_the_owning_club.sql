-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825230930; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- `hide_club_name` is a toggle on the table creation page, on both tables and
-- tournaments, that has never had anything to hide: no lobby surface in Club
-- Arena has ever printed the owning club's name.
--
-- That absence is itself the bug. A UNION lobby lists games from every club in
-- the union side by side (fn_club_home_in_scope returns them), and a player
-- looking at that board cannot tell whose game is whose. So the flag gets its
-- subject: the payload now names the owning club, the board prints it only
-- when the game belongs to a DIFFERENT club than the one being viewed, and
-- `hide_club_name` suppresses it.
--
-- `club_names` is a flat id -> name map rather than a name repeated on every
-- row: 200 tables across a handful of clubs would otherwise ship the same
-- string 200 times.

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
  SELECT count(*)::int INTO v_member_count
  FROM public.club_members cm
  WHERE cm.club_id = v_club.id
    AND cm.status IN ('active', 'approved');

  -- Everyone in a seat at a live table, right now, anywhere on the platform.
  -- Counted from the seats, never from clubs.online_count.
  SELECT count(DISTINCT ts.user_id)::int INTO v_playing
  FROM public.table_seats ts
  JOIN public.tables tb ON tb.id = ts.table_id
  WHERE ts.left_at IS NULL
    AND tb.status IN ('waiting', 'running');

  IF v_uid IS NOT NULL THEN
    SELECT jsonb_build_object('chip_balance', cm.chip_balance, 'role', cm.role)
      INTO v_membership
    FROM public.club_members cm
    WHERE cm.club_id = v_club.id AND cm.user_id = v_uid LIMIT 1;
  END IF;

  -- id -> name for every club whose games can appear on this board.
  SELECT COALESCE(jsonb_object_agg(c.id::text, c.name), '{}'::jsonb) INTO v_club_names
  FROM public.clubs c WHERE c.id = ANY (v_union_club_ids);

  SELECT COALESCE(jsonb_agg(t ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_tables
  FROM (
    SELECT id, name, game_variant, stakes, current_players, max_players, status,
           small_blind, big_blind, min_buy_in, max_buy_in, created_at, club_id,
           -- Rule medallions
           run_it_twice, run_it_twice_enabled, allow_run_it_twice, run_it_mode,
           insurance_enabled, straddle_enabled, straddle_type, auto_utg_straddle,
           bomb_pot_enabled, bomb_pot_frequency, bomb_pot_double_board,
           ante_enabled, ante, seven_deuce_enabled, seven_deuce_amount,
           time_bank_enabled, all_in_or_fold,
           cap_enabled, cap_bb, no_rathole, pineapple_holdem,
           is_anonymous, ban_chat, restrict_observers, auto_start_players,
           -- Lobby flags. is_private is not here: it decides whether the row
           -- is returned at all, in fn_club_home_in_scope below.
           is_vip_only, label_as_new, is_featured, hide_club_name
    FROM public.tables
    WHERE is_deleted = false
      AND status NOT IN ('closed', 'deleted')
      AND tournament_id IS NULL
      AND public.fn_club_home_in_scope(club_id, is_private, union_id,
                                       v_union_id, v_club.id, v_union_club_ids)
    ORDER BY created_at DESC LIMIT 200
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
      AND public.fn_club_home_in_scope(club_id, is_private, union_id,
                                       v_union_id, v_club.id, v_union_club_ids)
    ORDER BY start_time ASC LIMIT 200
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
      -- Both counts come from this one place so the header cannot flip
      -- between two writers again.
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

DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.get_club_home('shark-club');
  IF COALESCE((v->>'found')::boolean, false) THEN
    IF NOT (v ? 'club_names') THEN
      RAISE EXCEPTION 'club_names did not reach the payload';
    END IF;
    IF v->'tables'->0 IS NOT NULL AND NOT (v->'tables'->0 ? 'club_id') THEN
      RAISE EXCEPTION 'club_id did not reach the table payload';
    END IF;
  END IF;
END $$;
