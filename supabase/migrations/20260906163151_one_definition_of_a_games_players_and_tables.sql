-- 20260906163151_one_definition_of_a_games_players_and_tables.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- ONE DEFINITION OF A GAME'S PLAYERS AND TABLES.
--
-- Three places answered "how many players and tables are in this cash game"
-- and all three answered differently. The handoff has carried this as an open
-- item since 2026-09-05 with the note that they agree today only because the
-- population that made them differ was repaired by hand.
--
--   fn_cash_cluster_census  is_deleted  status IN (...)  lifecycle <> closed
--                           yes         yes              yes
--   get_club_home.players   no          no               yes
--   get_club_home.tables    no          yes              yes
--   fn_cash_game_lobby      yes         no               yes
--
-- The census is authoritative: it is what fn_cash_cluster_tick reads to
-- decide what the game IS - how many tables it has, which one is Main 1, when
-- to open a feeder and when to break one. A read path that disagrees with it
-- is showing the player a different game from the one the controller is
-- running.
--
-- The worst of the three is get_club_home, which disagrees WITH ITSELF: its
-- player count filters neither `is_deleted` nor `status`, while its table
-- count filters `status`. So a seat on a table that this same function does
-- not count as a table was still counted as a player - the lobby could show
-- "7 players, 1 table" for a game whose second table had just been closed or
-- deleted, which is exactly the shape of Dan's original complaint (50 players
-- showing, one person sitting).
--
-- All three now carry the census predicate, verbatim:
--
--   coalesce(is_deleted,false) = false
--   AND status IN ('waiting','running','active')
--   AND lifecycle <> 'closed'
--
-- Nothing else in either function is touched; both are re-emitted from their
-- LIVE bodies (read from pg_get_functiondef at 16:31 CDT on 2026-09-06), as
-- the tick_all header asks, so this cannot silently revert somebody's work.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

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
           -- ONE DEFINITION (20260906163151). Both of these carry the SAME
           -- predicate as fn_cash_cluster_census, which is what the
           -- controller decides the game's shape from. They did not: the
           -- player count filtered neither is_deleted nor status, so a seat
           -- on a table this very function did not count as a table was
           -- still counted as a player.
           (SELECT count(*) FROM public.table_seats ts JOIN public.tables t2 ON t2.id = ts.table_id
             WHERE t2.cluster_id = tb.cluster_id AND ts.left_at IS NULL
               AND COALESCE(t2.is_deleted, false) = false
               AND t2.status IN ('waiting','running','active')
               AND t2.lifecycle <> 'closed')::int AS cluster_players,
           (SELECT count(*) FROM public.tables t2
             WHERE t2.cluster_id = tb.cluster_id
               AND COALESCE(t2.is_deleted, false) = false
               AND t2.status IN ('waiting','running','active')
               AND t2.lifecycle <> 'closed')::int AS cluster_tables
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

CREATE OR REPLACE FUNCTION public.fn_cash_game_lobby(p_game_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  g record;
  me record;
  v_tables jsonb;
  v_list jsonb;
  v_me jsonb := 'null'::jsonb;
  v_req record;
  v_move record;
  v_roster record;
  v_position integer;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND: %', p_game_id; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'name', t.name, 'role', t.role, 'main_index', t.main_index,
           'lifecycle', t.lifecycle, 'status', t.status, 'max_players', coalesce(t.max_players, 9),
           'seated', (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = t.id AND ts.left_at IS NULL),
           'open_seats', public.fn_cash_game_open_seats(t.id),
           'seat_change_queue', (SELECT count(*) FROM public.cash_seat_change_requests q
                                  WHERE q.game_id = g.id AND q.status = 'requested' AND q.to_table_id = t.id),
           'seats', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'seat_number', ts.seat_number, 'user_id', ts.user_id,
                        'alias', public.fn_player_display_name(ts.user_id),
                        'stack', ts.stack, 'is_sitting_out', ts.is_sitting_out,
                        'joined_game_at', (SELECT r.joined_at FROM public.cash_game_roster r
                                            WHERE r.game_id = g.id AND r.user_id = ts.user_id AND r.left_at IS NULL))
                        ORDER BY ts.seat_number), '[]'::jsonb)
                       FROM public.table_seats ts WHERE ts.table_id = t.id AND ts.left_at IS NULL)
         ) ORDER BY (t.role = 'feeder'), t.main_index NULLS LAST, t.created_at), '[]'::jsonb)
    INTO v_tables
    FROM public.tables t
   WHERE t.cluster_id = g.id AND coalesce(t.is_deleted, false) = false
     -- ONE DEFINITION (20260906163151): the same predicate as
     -- fn_cash_cluster_census and get_club_home. Without the status test this
     -- listed a table the controller does not consider part of the game.
     AND t.status IN ('waiting', 'running', 'active')
     AND t.lifecycle <> 'closed';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'position', l.pos, 'user_id', l.user_id, 'alias', l.alias,
           'table_id', l.table_id, 'table_name', l.table_name, 'role', l.role,
           'main_index', l.main_index, 'joined_at', l.joined_at) ORDER BY l.pos), '[]'::jsonb)
    INTO v_list
    FROM public.fn_cash_game_must_move_list(g.id) l;

  IF v_uid IS NOT NULL THEN
    SELECT ts.table_id, ts.seat_number, ts.stack, t.role, t.main_index, t.lifecycle
      INTO me
      FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
     WHERE ts.user_id = v_uid AND ts.left_at IS NULL AND t.cluster_id = g.id AND t.lifecycle <> 'closed'
     LIMIT 1;
    SELECT * INTO v_roster FROM public.cash_game_roster r
     WHERE r.game_id = g.id AND r.user_id = v_uid AND r.left_at IS NULL;
    SELECT l.pos INTO v_position FROM public.fn_cash_game_must_move_list(g.id) l WHERE l.user_id = v_uid;
    SELECT * INTO v_req FROM public.cash_seat_change_requests q
     WHERE q.game_id = g.id AND q.user_id = v_uid AND q.status = 'requested';
    SELECT m.id, m.to_table_id, m.reason, m.announced_at, m.ready_at, m.swap_move_id, t.name AS to_table_name,
           t.role AS to_role, t.main_index AS to_main_index
      INTO v_move
      FROM public.cash_seat_moves m JOIN public.tables t ON t.id = m.to_table_id
     WHERE m.game_id = g.id AND m.player_id = v_uid AND m.state = 'pending' AND m.expires_at > clock_timestamp()
     ORDER BY m.created_at DESC LIMIT 1;

    v_me := jsonb_build_object(
      'user_id', v_uid,
      'seated', me.table_id IS NOT NULL,
      'table_id', me.table_id, 'seat_number', me.seat_number, 'stack', me.stack,
      'role', me.role, 'main_index', me.main_index, 'lifecycle', me.lifecycle,
      'on_main_one', (me.role = 'main' AND me.main_index = 1),
      'joined_game_at', v_roster.joined_at,
      'must_move_position', v_position,
      'seat_change', jsonb_build_object(
         -- The button: seated somewhere other than Main 1, not used, nothing
         -- pending, and the table is not already closing under them.
         'available', (me.table_id IS NOT NULL AND NOT (me.role = 'main' AND me.main_index = 1)
                       AND v_roster.seat_change_used_at IS NULL AND v_req.id IS NULL AND v_move.id IS NULL
                       AND me.lifecycle NOT IN ('breaking', 'closed')),
         'used_at', v_roster.seat_change_used_at,
         'request', CASE WHEN v_req.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', v_req.id, 'to_table_id', v_req.to_table_id, 'created_at', v_req.created_at,
            'position', (SELECT count(*) + 1 FROM public.cash_seat_change_requests q
                          WHERE q.game_id = g.id AND q.status = 'requested' AND q.created_at < v_req.created_at
                            AND (v_req.to_table_id IS NULL OR q.to_table_id IS NULL OR q.to_table_id = v_req.to_table_id))) END),
      -- Not seated: their place on the game's waitlist, if any (Gate 4).
      'waitlist', CASE WHEN me.table_id IS NULL THEN public.fn_cash_game_waitlist_position(g.id) ELSE NULL END,
      'pending_move', CASE WHEN v_move.id IS NULL THEN NULL ELSE jsonb_build_object(
         'id', v_move.id, 'to_table_id', v_move.to_table_id, 'to_table_name', v_move.to_table_name,
         'to_role', v_move.to_role, 'to_main_index', v_move.to_main_index, 'reason', v_move.reason,
         'announced', v_move.announced_at IS NOT NULL, 'swap', v_move.swap_move_id IS NOT NULL,
         'held', v_move.ready_at IS NOT NULL) END);
  END IF;

  RETURN jsonb_build_object(
    'game', jsonb_build_object('id', g.id, 'name', g.name, 'template_name', g.template_name,
                               'variant', g.variant, 'sb', g.sb, 'bb', g.bb, 'handedness', g.handedness,
                               'state', g.state, 'must_move', g.must_move, 'enabled', g.enabled,
                               'last_tick_at', g.last_tick_at),
    'tables', v_tables,
    'must_move_list', v_list,
    'waitlist', jsonb_build_object('waiting', (SELECT count(*) FROM public.cash_game_waitlist w
                                                WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified'))),
    'seat_changes_requested', (SELECT count(*) FROM public.cash_seat_change_requests q
                                WHERE q.game_id = g.id AND q.status = 'requested'),
    'me', v_me,
    'as_of', clock_timestamp());
END;
$function$;

DO $$
DECLARE
  v_gch text;
  v_lob text;
  c_pred constant text := 'status IN (''waiting'', ''running'', ''active'')';
BEGIN
  SELECT prosrc INTO v_gch FROM pg_proc WHERE proname = 'get_club_home' AND pronamespace = 'public'::regnamespace;
  SELECT prosrc INTO v_lob FROM pg_proc WHERE proname = 'fn_cash_game_lobby' AND pronamespace = 'public'::regnamespace;

  -- get_club_home now filters is_deleted in BOTH subqueries (it filtered it in
  -- neither), and status in both (it filtered it in one).
  IF (length(v_gch) - length(replace(v_gch, 'COALESCE(t2.is_deleted, false) = false', ''))) / length('COALESCE(t2.is_deleted, false) = false') <> 2 THEN
    RAISE EXCEPTION 'VERIFY: get_club_home does not filter is_deleted in both cluster subqueries';
  END IF;
  IF (length(v_gch) - length(replace(v_gch, '''waiting'',''running'',''active''', ''))) / length('''waiting'',''running'',''active''') <> 2 THEN
    RAISE EXCEPTION 'VERIFY: get_club_home does not filter status in both cluster subqueries';
  END IF;

  IF position(c_pred in v_lob) = 0 THEN
    RAISE EXCEPTION 'VERIFY: fn_cash_game_lobby does not carry the status predicate';
  END IF;
  IF position('coalesce(t.is_deleted, false) = false' in v_lob) = 0 THEN
    RAISE EXCEPTION 'VERIFY: fn_cash_game_lobby lost its is_deleted filter';
  END IF;

  -- And the three agree on a live board: every game's club-home count equals
  -- the census count. Checked over every enabled game, not a sample.
  IF EXISTS (
    SELECT 1
      FROM public.cash_games g
     WHERE g.enabled
       AND (SELECT count(*) FROM public.tables t2
             WHERE t2.cluster_id = g.id AND COALESCE(t2.is_deleted, false) = false
               AND t2.status IN ('waiting','running','active') AND t2.lifecycle <> 'closed')
           <> coalesce(array_length(public.fn_cash_cluster_census(g.id), 1), 0)
  ) THEN
    RAISE EXCEPTION 'VERIFY: a game''s table count still disagrees with fn_cash_cluster_census';
  END IF;
END $$;

COMMIT;
