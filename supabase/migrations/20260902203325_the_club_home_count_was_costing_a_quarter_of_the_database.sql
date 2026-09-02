-- THE CLUB HOME COUNT WAS COSTING A QUARTER OF THE DATABASE (2026-09-02)
--
-- Measured in pg_stat_statements since the 2026-09-01 14:50 reset:
-- get_club_home - 127,356 calls, mean 1,811 ms, max 7,999 ms (the statement
-- timeout), 3,843 database-minutes = 26% of ALL execution time on the
-- platform, more than the hand-history writer and the realtime WAL poller
-- put together. It is what the club lobby paints from, and ClubHomePage also
-- re-calls it on EVERY realtime `tables` UPDATE in scope (debounced 250 ms)
-- just to re-read one number, `players_playing`. With 1,131 open cash tables
-- changing on every seat transition, that is ~70 calls a minute around the
-- clock.
--
-- Profiled as an authenticated user (service_role bypasses RLS and answers
-- in 370 ms, which is why this never showed up in a psql session):
--
--   tables list          118 ms
--   players_playing       54 ms
--   tournaments           16 ms
--   MEMBER COUNT       2,026 ms   <- club_members RLS: fn_union_oversees_club,
--                                    fn_club_cashier_scope,
--                                    fn_club_cashier_can_transact and
--                                    is_club_admin evaluated PER ROW, 417 rows
--                                    for Deep Stack Society, 584 for SHARK
--   whole function     5,797 ms
--
-- A member COUNT is not sensitive - the club card shows it to everyone, and
-- get_club_home already returns it to any caller - so the count is moved
-- behind a SECURITY DEFINER helper that answers from the index in ~1 ms. The
-- function stays SECURITY INVOKER for everything that lists rows; only the
-- aggregate is exempted, and the helper returns nothing but the integer.
--
-- SECOND, the same truncation #2696 fixed in TableService lives here too:
-- `ORDER BY created_at DESC LIMIT 200`. Deep Stack Society carries 1,058 open
-- cash tables, so the lobby's fast path fetched the 200 NEWEST (the 50/100
-- and 25/50 tables created last in the 09-01 build, all empty) and 41 of
-- its 51 running games were never on the page. Occupancy first, so the cap
-- can only ever trim empty tables; created_at stays as the tiebreak.
--
-- THIRD, a light RPC for the one number the realtime refresh actually wants,
-- so ClubHomePage can stop re-fetching the whole lobby to update a counter.
--
-- Every DDL statement is inside this one transaction: one PostgREST schema
-- reload, not four (production DDL policy, CLAUDE.md section 2).
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_club_member_count(p_club_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT count(*)::int
  FROM public.club_members cm
  WHERE cm.club_id = p_club_id
    AND cm.status IN ('active', 'approved');
$$;

COMMENT ON FUNCTION public.fn_club_member_count(uuid) IS
  'Active/approved member COUNT of one club, as an integer and nothing else. SECURITY DEFINER on purpose: the count is public (every club card shows it) and under club_members RLS the same COUNT evaluated four policy functions per row - 2,026 ms for a 417-member club, called ~70x/min by get_club_home (2026-09-02).';

REVOKE ALL ON FUNCTION public.fn_club_member_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_club_member_count(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_club_players_playing(p_club_key text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_club           public.clubs%ROWTYPE;
  v_union_id       uuid;
  v_union_club_ids uuid[];
  v_playing        integer;
BEGIN
  IF p_club_key ~ '^[0-9a-fA-F]{8}-' THEN
    SELECT * INTO v_club FROM public.clubs WHERE id = p_club_key::uuid LIMIT 1;
  ELSIF p_club_key ~ '^[0-9]+$' THEN
    SELECT * INTO v_club FROM public.clubs WHERE club_id = p_club_key::integer LIMIT 1;
  ELSE
    SELECT * INTO v_club FROM public.clubs WHERE slug = p_club_key LIMIT 1;
  END IF;
  IF v_club.id IS NULL THEN
    RETURN NULL;
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

  -- Identical to the players_playing term of get_club_home: distinct users in
  -- a live seat at a table this lobby can see. SECURITY INVOKER, RLS applies.
  SELECT count(DISTINCT ts.user_id)::int INTO v_playing
  FROM public.table_seats ts
  JOIN public.tables tb ON tb.id = ts.table_id
  WHERE ts.left_at IS NULL
    AND tb.status IN ('waiting', 'running')
    AND public.fn_club_home_in_scope(
          tb.club_id, tb.is_private, tb.union_id,
          v_union_id, v_club.id, v_union_club_ids);
  RETURN COALESCE(v_playing, 0);
END;
$function$;

COMMENT ON FUNCTION public.get_club_players_playing(text) IS
  'The players_playing number of get_club_home on its own (~50 ms), for the realtime counter refresh that used to re-fetch the entire lobby payload (~1.8 s) on every seat transition (2026-09-02).';

REVOKE ALL ON FUNCTION public.get_club_players_playing(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_club_players_playing(text) TO authenticated, service_role;

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
           nit_game, career_percent_min, maintain_percent_min, maintain_hands
    FROM public.tables
    WHERE is_deleted = false
      AND status NOT IN ('closed', 'deleted')
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

COMMENT ON FUNCTION public.get_club_home(text) IS
  'Club lobby payload in one round trip (was six). SECURITY INVOKER: RLS applies to every read, so it returns exactly what the caller could fetch itself. 2026-09-02: the member count goes through fn_club_member_count (definer, integer only) because under club_members RLS it cost 2 s per call and 26% of all database time; tables are ordered occupancy-first so the 200-row cap never hides a live game.';

COMMIT;
