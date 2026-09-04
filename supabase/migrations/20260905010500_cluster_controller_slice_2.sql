-- ═══════════════════════════════════════════════════════════════════════════
--  CLUSTER RUNTIME - OPERATION TABLE STAKES, SLICE 2 + SLICE 6 (SQL HALF)
--  OPORD 1.3 sections 9.2, 9.5, 9.8 as amended by OPORD 1.4 section 18.
--  2026-09-05.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE TABLES OPEN AND CLOSE THEMSELVES. Nothing here is decided by a person.
--
-- One function, fn_cash_cluster_tick(game_id, eligible_horses), is called by
-- server/src/cluster/ClusterController.ts every 5 s on the leader for every
-- enabled must-move game. It locks the cash_games row FOR UPDATE, reads the
-- rows, and does - in this order, nothing remembered between calls -
--
--   1. RECONCILE  expire stale moves; recount; Main 1 exists and is open (R3)
--   2. MUST-MOVE  every Main with an unreserved open seat pulls the
--                 longest-seated player off the feeder (1.3 s9.5)
--   3. OPEN       every live table full + two buyers -> a feeder (18.3)
--   4. PROMOTE    a feeder at 2 seated goes live; the previous feeder becomes
--                 Main N+1 (18.3)
--   5. BREAK      the newest table breaks when the rest can hold everyone at
--                 the floor, after 5 minutes of that being true (18.3)
--   6. ROLES      oldest is always Main 1; mains renumber; newest of the
--                 survivors is the feeder
--   7. WAKE/SLEEP live | dormant, derived (18.4)
--   8. EMIT       cash_cluster_events for every transition
--
-- A MOVE IS NOT A LEAVE. fn_cash_seat_move_execute moves the seat row's chips
-- from one table to another inside one transaction: no wallet is touched,
-- the chip-continuity session keeps its baseline and its clock and is simply
-- re-scoped to the new table, and the felt total does not change. The engine
-- executes a planned move at the player's next hand boundary; a move not
-- executed within 60 s expires and is planned again.
--
-- Pre-cutover: this manages ONLY cash_games rows with must_move = true. The
-- fleet's DEFAULT_TABLES and every hand-made (R9 manual) table are untouched
-- until Gate 7. R3 (Main 1 always on) moves from the two row flags to the
-- controller: fn_cash_game_create no longer sets auto_extension/auto_restart.
--
-- Part 2 of 2: functions only. Part 1 (20260905010000_cluster_columns_slice_2)
-- carries the columns and tables. One transaction: PostgREST reloads once.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. One writer opens a cluster table
-- ─────────────────────────────────────────────────────────────────────────────
-- fn_cash_game_create opened Main 1 inline. Feeders need the same projection
-- of the snapshot onto the engine columns, so the INSERT moves here and both
-- callers use it. Not a browser door: service_role and the create function.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_open_table(
  p_game_id    uuid,
  p_role       text,
  p_main_index integer,
  p_lifecycle  text DEFAULT 'opening',
  p_created_by uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  g record; s jsonb; v_opts jsonb;
  v_ante text; v_ante_chips numeric; v_vpip integer; v_vpip_window integer;
  v_bomb_on boolean; v_bomb_trigger text; v_bomb_ante integer; v_bomb_boards integer;
  v_min_bb integer; v_max_bb integer; v_name text; v_table_id uuid; v_n integer;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND: %', p_game_id; END IF;
  IF p_role NOT IN ('main', 'feeder') THEN RAISE EXCEPTION 'ROLE_INVALID: %', p_role; END IF;
  IF p_role = 'main' AND (p_main_index IS NULL OR p_main_index < 1) THEN
    RAISE EXCEPTION 'MAIN_INDEX_INVALID: %', p_main_index;
  END IF;
  IF p_lifecycle NOT IN ('opening', 'live') THEN RAISE EXCEPTION 'LIFECYCLE_INVALID: %', p_lifecycle; END IF;

  s := g.ruleset_snapshot;
  v_opts := coalesce(s->'options', '{}'::jsonb);
  v_ante := coalesce(s->>'regular_ante', 'none');
  v_ante_chips := CASE v_ante WHEN 'sb' THEN g.sb WHEN 'bb' THEN g.bb ELSE 0 END;
  v_vpip := coalesce((s->>'vpip_floor')::integer, 0);
  v_vpip_window := coalesce((s->>'vpip_window')::integer, 40);
  v_bomb_on := coalesce((s->'bombs'->>'enabled')::boolean, false);
  v_bomb_trigger := s->'bombs'->>'trigger';
  v_bomb_ante := (s->'bombs'->>'ante_bb')::integer;
  v_bomb_boards := (s->'bombs'->>'boards')::integer;
  v_min_bb := coalesce((s->>'min_buyin_bb')::integer, 40);
  v_max_bb := coalesce((s->>'max_buyin_bb')::integer, 200);

  -- "NLH 1/2 Classic" for Main 1, "NLH 1/2 Classic Main 2", "... Feeder".
  SELECT count(*) INTO v_n FROM public.tables WHERE cluster_id = p_game_id;
  v_name := CASE
    WHEN p_role = 'main' AND p_main_index = 1 THEN g.name
    WHEN p_role = 'main' THEN left(g.name, 50) || ' Main ' || p_main_index
    ELSE left(g.name, 50) || ' Feeder' END;

  INSERT INTO public.tables (
    club_id, union_id, name, game_type, game_variant, game_mode,
    small_blind, big_blind, stakes,
    max_players, min_buy_in, max_buy_in,
    ante_enabled, ante, ante_bb,
    nit_game, career_percent_min, maintain_percent_min, maintain_hands,
    bomb_pot_enabled, bomb_pot_trigger_mode, bomb_pot_interval_seconds, bomb_pot_frequency,
    bomb_pot_ante_multiplier, bomb_pot_board_count, bomb_pot_double_board, bomb_pot_min_players,
    straddle_enabled, auto_utg_straddle, voluntary_straddle,
    run_it_mode, run_it_twice, allow_run_it_twice, run_it_twice_enabled,
    rake_percent, rake_cap_bb,
    is_private, is_vip_only, is_anonymous, ban_chat, insurance_enabled,
    seven_deuce_enabled, seven_deuce_amount,
    action_time_seconds, auto_start_players,
    auto_extension, auto_restart, auto_create_table,
    status, current_players, created_by,
    cluster_id, role, main_index, lifecycle, opened_at, live_at
  ) VALUES (
    g.club_id, g.union_id, v_name, 'cash', g.variant, 'regular',
    g.sb, g.bb, public.fn_cash_stakes_label(g.sb, g.bb, g.variant),
    g.handedness, round(g.bb * v_min_bb, 2), round(g.bb * v_max_bb, 2),
    v_ante_chips > 0, v_ante_chips, CASE WHEN v_ante_chips > 0 THEN round(v_ante_chips / g.bb, 4) ELSE 0 END,
    v_vpip > 0, 0, v_vpip, v_vpip_window,
    v_bomb_on,
    CASE WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 'timed'
         WHEN v_bomb_on AND v_bomb_trigger = 'every_orbit' THEN 'once_per_orbit'
         ELSE 'every_n_hands' END,
    CASE WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 900 ELSE NULL END,
    0,
    coalesce(v_bomb_ante, 2), coalesce(v_bomb_boards, 1), coalesce(v_bomb_boards, 1) >= 2, 2,
    false, false, false,
    'player_choice', true, true, true,
    -1, -1,
    coalesce((v_opts->>'is_private')::boolean, false), coalesce((v_opts->>'is_vip_only')::boolean, false),
    coalesce((v_opts->>'is_anonymous')::boolean, false), coalesce((v_opts->>'ban_chat')::boolean, false),
    coalesce((v_opts->>'insurance_enabled')::boolean, false),
    coalesce((v_opts->>'seven_deuce_enabled')::boolean, false),
    CASE WHEN coalesce((v_opts->>'seven_deuce_enabled')::boolean, false) THEN 2 ELSE 0 END,
    LEAST(120, GREATEST(10, coalesce((v_opts->>'action_time_seconds')::integer, 15))), 2,
    -- A cluster table's life is the controller's (Slice 6). A manual (R9)
    -- table's life is the host's. Neither uses the lifecycle-pass flags.
    false, false, false,
    'waiting', 0, coalesce(p_created_by, g.created_by),
    p_game_id, p_role, CASE WHEN p_role = 'main' THEN p_main_index END, p_lifecycle,
    clock_timestamp(), CASE WHEN p_lifecycle = 'live' THEN clock_timestamp() END
  ) RETURNING id INTO v_table_id;

  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (p_game_id, v_table_id, CASE WHEN p_role = 'feeder' THEN 'feeder_opened' ELSE 'main_opened' END,
          jsonb_build_object('role', p_role, 'main_index', p_main_index, 'lifecycle', p_lifecycle, 'name', v_name));
  RETURN v_table_id;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_cash_cluster_open_table(uuid, text, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_open_table(uuid, text, integer, text, uuid) TO service_role;

-- fn_cash_game_create: same body as 20260904230000 up to the game INSERT, then
-- Main 1 through the shared writer. (The full validation block is kept
-- verbatim so the 26-scenario probe still passes; only the tail changes.)
CREATE OR REPLACE FUNCTION public.fn_cash_game_create(
  p_club_id    uuid,
  p_template   text,
  p_variant    text,
  p_sb         numeric,
  p_bb         numeric,
  p_handedness integer DEFAULT NULL,
  p_overrides  jsonb   DEFAULT '{}'::jsonb,
  p_name       text    DEFAULT NULL,
  p_must_move  boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_t text := lower(coalesce(p_template, ''));
  v_v text := lower(coalesce(p_variant, ''));
  v_def jsonb; v_snap jsonb; v_o jsonb := coalesce(p_overrides, '{}'::jsonb);
  v_must_move boolean := coalesce(p_must_move, true);
  v_union uuid;
  v_seats integer; v_choices integer[];
  v_stay integer; v_rejoin integer;
  v_min_bb integer; v_max_bb integer;
  v_ante text; v_vpip integer; v_vpip_window integer;
  v_bombs jsonb; v_bomb_on boolean; v_bomb_trigger text; v_bomb_ante integer; v_bomb_boards integer;
  v_opts jsonb; v_oo jsonb;
  v_name text; v_label text;
  v_game_id uuid; v_table_id uuid;
  v_variant_label text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_cash_game_create requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again' USING ERRCODE = '28000';
  END IF;
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'CLUB_REQUIRED';
  END IF;
  IF NOT (public.fn_can_create_games(p_club_id, v_uid) OR public.is_club_admin(p_club_id, v_uid)) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: you cannot create games in this club';
  END IF;

  IF v_t NOT IN ('classic', 'action', 'madness') THEN
    RAISE EXCEPTION 'TEMPLATE_UNKNOWN: %', p_template;
  END IF;
  IF v_v NOT IN ('nlh','plo4','plo5','plo6','plo8','flo8','flh','short_deck','pineapple') THEN
    RAISE EXCEPTION 'VARIANT_UNAVAILABLE: % is not available yet', p_variant;
  END IF;
  IF p_sb IS NULL OR p_bb IS NULL OR p_sb = 'NaN'::numeric OR p_bb = 'NaN'::numeric
     OR p_sb <= 0 OR p_bb <= p_sb
     OR round(p_sb, 2) <> p_sb OR round(p_bb, 2) <> p_bb
     OR p_bb > 100000 THEN
    RAISE EXCEPTION 'STAKES_INVALID: sb=% bb=%', p_sb, p_bb;
  END IF;
  IF jsonb_typeof(v_o) <> 'object' THEN
    RAISE EXCEPTION 'OVERRIDE_INVALID: overrides must be an object';
  END IF;

  v_def := public.fn_cash_template_defaults(v_t, v_v);

  SELECT array_agg(x::integer) INTO v_choices FROM jsonb_array_elements_text(v_def->'seat_choices') x;
  IF (v_def->>'seats_locked')::boolean THEN
    v_seats := (v_def->>'seats')::integer;
  ELSE
    v_seats := coalesce(p_handedness, (v_def->>'seats')::integer);
    IF NOT (v_seats = ANY (v_choices)) THEN
      RAISE EXCEPTION 'HANDEDNESS_INVALID: % is not offered for % %', v_seats, v_t, v_v;
    END IF;
  END IF;

  v_min_bb := public.fn_cash_override_int(v_o, 'min_buyin_bb', (v_def->>'min_buyin_bb')::integer);
  v_max_bb := public.fn_cash_override_int(v_o, 'max_buyin_bb', (v_def->>'max_buyin_bb')::integer);
  IF v_min_bb < 1 OR v_max_bb < v_min_bb OR v_max_bb > 1000 THEN
    RAISE EXCEPTION 'BUYIN_BAND_INVALID: % - % bb', v_min_bb, v_max_bb;
  END IF;
  v_ante := coalesce(v_o->>'regular_ante', v_def->>'regular_ante');
  IF v_ante NOT IN ('none', 'sb', 'bb') THEN
    RAISE EXCEPTION 'ANTE_INVALID: %', v_ante;
  END IF;
  v_vpip := public.fn_cash_override_int(v_o, 'vpip_floor', (v_def->>'vpip_floor')::integer);
  IF v_vpip < 0 OR v_vpip > 100 THEN RAISE EXCEPTION 'VPIP_INVALID: %', v_vpip; END IF;
  v_vpip_window := public.fn_cash_override_int(v_o, 'vpip_window', (v_def->>'vpip_window')::integer);
  IF v_vpip_window < 10 OR v_vpip_window > 200 THEN RAISE EXCEPTION 'VPIP_WINDOW_INVALID: %', v_vpip_window; END IF;

  IF v_o ? 'bombs' AND jsonb_typeof(v_o->'bombs') <> 'object' THEN
    RAISE EXCEPTION 'OVERRIDE_INVALID: bombs must be an object';
  END IF;
  v_bombs := coalesce(v_def->'bombs', '{}'::jsonb) || coalesce(v_o->'bombs', '{}'::jsonb);
  v_bomb_on := public.fn_cash_override_bool(v_bombs, 'enabled', false);
  v_bomb_trigger := v_bombs->>'trigger';
  v_bomb_ante := public.fn_cash_override_int(v_bombs, 'ante_bb', NULL);
  v_bomb_boards := public.fn_cash_override_int(v_bombs, 'boards', NULL);
  IF v_bomb_on THEN
    IF v_bomb_trigger IS NULL OR v_bomb_trigger NOT IN ('timed_15m', 'every_orbit') THEN
      RAISE EXCEPTION 'BOMB_TRIGGER_INVALID: %', v_bomb_trigger;
    END IF;
    IF v_bomb_ante IS NULL OR v_bomb_ante < 1 OR v_bomb_ante > 20 THEN
      RAISE EXCEPTION 'BOMB_ANTE_INVALID: %', v_bomb_ante;
    END IF;
    IF v_bomb_boards IS NULL OR v_bomb_boards < 2 OR v_bomb_boards > 3 THEN
      RAISE EXCEPTION 'BOMB_BOARDS_INVALID: %', v_bomb_boards;
    END IF;
  END IF;

  v_stay := public.fn_cash_override_int(v_o, 'stay_clock_min', (v_def->>'stay_clock_min')::integer);
  v_rejoin := public.fn_cash_override_int(v_o, 'rejoin_window_min', (v_def->>'rejoin_window_min')::integer);
  IF v_stay < (v_def->>'stay_clock_min')::integer THEN
    RAISE EXCEPTION 'STAY_CLOCK_BELOW_FLOOR: % minutes; the minimum is %', v_stay, v_def->>'stay_clock_min';
  END IF;
  IF v_rejoin < (v_def->>'rejoin_window_min')::integer THEN
    RAISE EXCEPTION 'REJOIN_WINDOW_BELOW_FLOOR: % minutes; the minimum is %', v_rejoin, v_def->>'rejoin_window_min';
  END IF;
  IF v_stay > 1440 OR v_rejoin > 10080 THEN
    RAISE EXCEPTION 'CLOCK_TOO_LONG';
  END IF;

  IF v_o ? 'options' AND jsonb_typeof(v_o->'options') <> 'object' THEN
    RAISE EXCEPTION 'OVERRIDE_INVALID: options must be an object';
  END IF;
  v_oo := coalesce(v_o->'options', '{}'::jsonb);
  v_opts := jsonb_build_object(
    'is_private',          public.fn_cash_override_bool(v_oo, 'is_private', false),
    'is_vip_only',         public.fn_cash_override_bool(v_oo, 'is_vip_only', false),
    'is_anonymous',        public.fn_cash_override_bool(v_oo, 'is_anonymous', false),
    'ban_chat',            public.fn_cash_override_bool(v_oo, 'ban_chat', false),
    'insurance_enabled',   public.fn_cash_override_bool(v_oo, 'insurance_enabled', false),
    'seven_deuce_enabled', public.fn_cash_override_bool(v_oo, 'seven_deuce_enabled', false) AND v_v = 'nlh',
    'action_time_seconds', LEAST(120, GREATEST(10, public.fn_cash_override_int(v_oo, 'action_time_seconds', 15)))
  );

  v_snap := v_def || jsonb_build_object(
    'seats', v_seats,
    'min_buyin_bb', v_min_bb,
    'max_buyin_bb', v_max_bb,
    'regular_ante', v_ante,
    'vpip_floor', v_vpip,
    'vpip_window', v_vpip_window,
    'bombs', jsonb_build_object('enabled', v_bomb_on, 'trigger', v_bomb_trigger, 'ante_bb', v_bomb_ante, 'boards', v_bomb_boards),
    'straddle', false,
    'stay_clock_min', v_stay,
    'rejoin_window_min', v_rejoin,
    'run_it_n_times', 'opt_in',
    'rake', 'existing',
    'options', v_opts,
    'table_mode', CASE WHEN v_must_move THEN 'must_move' ELSE 'manual' END,
    'sb', p_sb, 'bb', p_bb,
    'resolved_at', to_jsonb(clock_timestamp())
  );

  v_variant_label := CASE v_v
    WHEN 'nlh' THEN 'NLH' WHEN 'plo4' THEN 'PLO4' WHEN 'plo5' THEN 'PLO5' WHEN 'plo6' THEN 'PLO6'
    WHEN 'plo8' THEN 'PLO8' WHEN 'flo8' THEN 'FLO8' WHEN 'flh' THEN 'FLH'
    WHEN 'short_deck' THEN 'Short Deck' WHEN 'pineapple' THEN 'Pineapple' END;
  v_label := public.fn_cash_stakes_label(p_sb, p_bb, v_v);
  v_name := btrim(coalesce(p_name, ''));
  IF v_name = '' THEN
    v_name := v_variant_label || ' ' || v_label || ' ' || initcap(v_t);
  END IF;
  v_name := left(replace(replace(v_name, '<', ''), '>', ''), 60);

  SELECT u.id INTO v_union
    FROM public.fn_club_union_context(p_club_id) ctx
    JOIN public.unions u ON u.id = COALESCE(ctx.own_union_id, ctx.member_union_id);

  BEGIN
    INSERT INTO public.cash_games
      (club_id, union_id, name, template_name, variant, sb, bb, handedness, ruleset_snapshot, created_by, must_move)
    VALUES
      (p_club_id, v_union, v_name, v_t, v_v, p_sb, p_bb, v_seats, v_snap, v_uid, v_must_move)
    RETURNING id INTO v_game_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'GAME_EXISTS: this club already runs % % %', initcap(v_t), v_variant_label, v_label;
  END;

  -- Main 1 through the one cluster writer. A must-move game's Main 1 is kept
  -- open by the controller (R3); a manual table lives and dies with its host.
  v_table_id := public.fn_cash_cluster_open_table(v_game_id, 'main', 1, 'live', v_uid);

  RETURN jsonb_build_object('ok', true, 'game_id', v_game_id, 'table_id', v_table_id,
                            'name', v_name, 'must_move', v_must_move, 'snapshot', v_snap);
END;
$$;
REVOKE ALL ON FUNCTION public.fn_cash_game_create(uuid, text, text, numeric, numeric, integer, jsonb, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_create(uuid, text, text, numeric, numeric, integer, jsonb, text, boolean) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. A move is not a leave
-- ─────────────────────────────────────────────────────────────────────────────

-- What the engine asks at a hand boundary: "who at my table has a move?"
CREATE OR REPLACE FUNCTION public.fn_cash_seat_moves_pending(p_table_id uuid)
RETURNS TABLE(move_id uuid, player_id uuid, to_table_id uuid, to_table_name text, to_role text, to_main_index integer, reason text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT m.id, m.player_id, m.to_table_id, t.name, t.role, t.main_index, m.reason
    FROM public.cash_seat_moves m
    JOIN public.tables t ON t.id = m.to_table_id
   WHERE m.from_table_id = p_table_id AND m.state = 'pending' AND m.expires_at > clock_timestamp()
   ORDER BY m.created_at;
$$;
REVOKE ALL ON FUNCTION public.fn_cash_seat_moves_pending(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_moves_pending(uuid) TO service_role;

-- The move. Both seat rows and the session change inside one transaction;
-- no wallet row is written; the felt total is unchanged before and after.
-- trg_log_seat_stack_exit records an exit of OLD.stack when left_at is
-- stamped, so the stack is set to zero in a separate statement first: the
-- chips did not leave the felt, they changed chairs.
CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_execute(p_move_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  m record; src record; dst record; v_seat integer; v_new_id uuid; v_stack numeric;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'frozen');
  END IF;
  SELECT * INTO m FROM public.cash_seat_moves WHERE id = p_move_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF m.state <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'reason', m.state); END IF;
  IF m.expires_at <= clock_timestamp() THEN
    UPDATE public.cash_seat_moves SET state = 'expired' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;

  SELECT * INTO src FROM public.table_seats
   WHERE table_id = m.from_table_id AND user_id = m.player_id AND left_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'player_not_seated' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'player_not_seated');
  END IF;

  SELECT * INTO dst FROM public.tables WHERE id = m.to_table_id FOR UPDATE;
  IF NOT FOUND OR dst.status NOT IN ('waiting', 'running', 'active') OR dst.lifecycle IN ('breaking', 'closed') THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_unavailable' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_unavailable');
  END IF;

  -- The lowest open, unreserved seat at the destination. A notified waitlist
  -- hold reserves one seat: leave that many free.
  SELECT gs INTO v_seat FROM generate_series(1, coalesce(dst.max_players, 9)) gs
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats ts
                      WHERE ts.table_id = dst.id AND ts.seat_number = gs AND ts.left_at IS NULL)
   ORDER BY gs LIMIT 1;
  IF v_seat IS NULL THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_full' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_full');
  END IF;

  v_stack := coalesce(src.stack, 0);

  -- 1 + 2 in ONE sub-transaction: the old chair empties WITHOUT an exit of
  --    chips (stack to zero first, so trg_log_seat_stack_exit sees nothing
  --    leave), then the new chair takes the same player, the same chips and
  --    the SOURCE joined_at (1.3 s9.8 "join time travels"). If the new chair
  --    is refused, the exception block undoes the old chair's emptying too.
  BEGIN
    UPDATE public.table_seats SET stack = 0 WHERE id = src.id;
    UPDATE public.table_seats SET left_at = clock_timestamp(), leave_pending = false, status = 'left'
     WHERE id = src.id;
    -- (table_id, seat_number) is unique across departed rows too, so a chair
    -- that has been sat in before is REVIVED, the way atomic_table_buyin
    -- does it; a never-used chair is inserted.
    UPDATE public.table_seats
       SET user_id = src.user_id, member_id = src.member_id, stack = v_stack,
           is_sitting_out = false, is_away = false, joined_at = src.joined_at,
           horse_id = src.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = src.auto_rebuy, time_bank_remaining = src.time_bank_remaining,
           time_bank_uses_remaining = src.time_bank_uses_remaining, club_id = src.club_id,
           entry_hold = NULL, entry_post_agreed = src.entry_post_agreed, left_at = NULL
     WHERE table_id = dst.id AND seat_number = v_seat AND left_at IS NOT NULL
     RETURNING id INTO v_new_id;
    IF v_new_id IS NULL THEN
      INSERT INTO public.table_seats
        (table_id, seat_number, user_id, member_id, stack, is_sitting_out, is_away, joined_at,
         horse_id, status, leave_pending, auto_rebuy, time_bank_remaining, time_bank_uses_remaining,
         club_id, entry_hold, entry_post_agreed)
      VALUES
        (dst.id, v_seat, src.user_id, src.member_id, v_stack, false, false, src.joined_at,
         src.horse_id, 'active', false, src.auto_rebuy, src.time_bank_remaining, src.time_bank_uses_remaining,
         src.club_id, NULL, src.entry_post_agreed)
      RETURNING id INTO v_new_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- A guard on the destination refused the chair (restriction, four-table
    -- limit, a race for the seat). The whole move is undone by this
    -- exception block's rollback of the sub-transaction: the player is
    -- still in the old chair with the old stack, and the plan is cancelled.
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = left(SQLERRM, 200) WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_refused', 'detail', left(SQLERRM, 200));
  END;

  -- 3. The chip-continuity session follows the player: baseline, clock and
  --    window untouched. This is the "cluster" scope Slice 0 promised.
  UPDATE public.cash_player_session
     SET scope_id = dst.id, table_id = dst.id
   WHERE player_id = m.player_id AND scope_type = 'table' AND scope_id = m.from_table_id AND closed_at IS NULL;

  -- 4. Counts and the record.
  UPDATE public.tables t SET current_players =
    (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = t.id AND ts.left_at IS NULL)
   WHERE t.id IN (m.from_table_id, m.to_table_id);
  UPDATE public.cash_seat_moves
     SET state = 'done', executed_at = clock_timestamp(), to_seat_number = v_seat
   WHERE id = m.id;
  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (m.game_id, m.to_table_id, 'seat_moved',
          jsonb_build_object('player_id', m.player_id, 'from_table_id', m.from_table_id,
                             'to_seat', v_seat, 'stack', v_stack, 'reason', m.reason));

  RETURN jsonb_build_object('ok', true, 'to_table_id', m.to_table_id, 'to_seat_number', v_seat, 'stack', v_stack);
END;
$$;
REVOKE ALL ON FUNCTION public.fn_cash_seat_move_execute(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_move_execute(uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The tick
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick(p_game_id uuid, p_eligible_horses integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  g record; t record; r record;
  v_actions jsonb := '[]'::jsonb;
  v_now timestamptz := clock_timestamp();
  v_seated_total integer := 0;
  v_live_tables integer := 0;
  v_open_unreserved integer := 0;
  v_buyers integer;
  v_waiting integer;
  v_feeder record;
  v_prev_feeder record;
  v_candidate record;
  v_floor integer;
  v_remaining_capacity integer;
  v_remaining_tables integer;
  v_main1 record;
  v_new_state text;
  v_moves integer := 0;
  v_n integer;
  v_idx integer;
  v_shortest uuid;
  v_table_cap integer;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'skipped', 'frozen');
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT g.must_move THEN RETURN jsonb_build_object('ok', false, 'reason', 'manual_game'); END IF;

  -- ── 1. RECONCILE ─────────────────────────────────────────────────────────
  UPDATE public.cash_seat_moves SET state = 'expired'
   WHERE game_id = g.id AND state = 'pending' AND expires_at <= v_now;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('moves_expired', v_n); END IF;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.cluster_census (
    id uuid, role text, main_index integer, lifecycle text, status text, created_at timestamptz,
    max_players integer, seated integer, reserved integer, open_unreserved integer, breaking boolean
  ) ON COMMIT DROP;
  DELETE FROM pg_temp.cluster_census;
  INSERT INTO pg_temp.cluster_census
  SELECT tb.id, tb.role, tb.main_index, tb.lifecycle, tb.status, tb.created_at, coalesce(tb.max_players, 9),
         (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL)::integer,
         (SELECT count(*) FROM public.table_waitlist w
           WHERE w.table_id = tb.id AND w.status = 'notified' AND w.hold_expires_at > v_now)::integer,
         0, tb.lifecycle = 'breaking'
    FROM public.tables tb
   WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle <> 'closed';
  UPDATE pg_temp.cluster_census SET open_unreserved = GREATEST(0, max_players - seated - reserved);

  SELECT coalesce(sum(seated), 0), count(*) INTO v_seated_total, v_live_tables FROM pg_temp.cluster_census;

  -- R3: an enabled game always has Main 1 open. Anything that closed it
  -- (a stray close, the pre-controller lifecycle pass, a restart) is undone
  -- here rather than by a row flag.
  SELECT * INTO v_main1 FROM public.tables
   WHERE cluster_id = g.id AND role = 'main' AND main_index = 1 AND coalesce(is_deleted, false) = false
   ORDER BY created_at LIMIT 1;
  IF g.enabled AND (v_main1.id IS NULL OR v_main1.status NOT IN ('waiting', 'running', 'active') OR v_main1.lifecycle = 'closed') THEN
    IF v_main1.id IS NULL OR v_main1.lifecycle = 'closed' THEN
      PERFORM public.fn_cash_cluster_open_table(g.id, 'main', 1, 'live', NULL);
      v_actions := v_actions || jsonb_build_object('main1', 'opened');
    ELSE
      UPDATE public.tables SET status = 'waiting', lifecycle = 'live', current_players = 0, updated_at = now()
       WHERE id = v_main1.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, v_main1.id, 'main1_reopened');
      v_actions := v_actions || jsonb_build_object('main1', 'reopened');
    END IF;
    -- Recount after the repair; the rest of the tick sees the real board.
    DELETE FROM pg_temp.cluster_census;
    INSERT INTO pg_temp.cluster_census
    SELECT tb.id, tb.role, tb.main_index, tb.lifecycle, tb.status, tb.created_at, coalesce(tb.max_players, 9),
           (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL)::integer,
           (SELECT count(*) FROM public.table_waitlist w
             WHERE w.table_id = tb.id AND w.status = 'notified' AND w.hold_expires_at > v_now)::integer,
           0, tb.lifecycle = 'breaking'
      FROM public.tables tb
     WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
       AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle <> 'closed';
    UPDATE pg_temp.cluster_census SET open_unreserved = GREATEST(0, max_players - seated - reserved);
    SELECT coalesce(sum(seated), 0), count(*) INTO v_seated_total, v_live_tables FROM pg_temp.cluster_census;
  END IF;

  -- ── 2. MUST-MOVE (1.3 s9.5) ──────────────────────────────────────────────
  -- For every Main with an unreserved open seat, the longest-seated player on
  -- the feeder (or on a breaking table) is planned onto it, one per seat,
  -- one per player. The engine executes at the player's next hand boundary.
  FOR t IN SELECT * FROM pg_temp.cluster_census
            WHERE role = 'main' AND lifecycle = 'live' AND open_unreserved > 0
            ORDER BY main_index
  LOOP
    v_n := t.open_unreserved
         - (SELECT count(*) FROM public.cash_seat_moves m WHERE m.to_table_id = t.id AND m.state = 'pending');
    FOR r IN
      SELECT ts.user_id, ts.table_id
        FROM public.table_seats ts
        JOIN pg_temp.cluster_census c ON c.id = ts.table_id
       WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
         AND (c.role = 'feeder' OR c.breaking)
         AND c.id <> t.id
         AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
       ORDER BY c.breaking DESC, ts.joined_at ASC
       LIMIT GREATEST(v_n, 0)
    LOOP
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
      VALUES (g.id, r.user_id, r.table_id, t.id, 'must_move');
      v_moves := v_moves + 1;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, t.id, 'move_planned', jsonb_build_object('player_id', r.user_id, 'from_table_id', r.table_id, 'reason', 'must_move'));
    END LOOP;
  END LOOP;
  IF v_moves > 0 THEN v_actions := v_actions || jsonb_build_object('moves_planned', v_moves); END IF;

  -- ── 3. OPEN (18.3) ───────────────────────────────────────────────────────
  SELECT coalesce(sum(open_unreserved), 0) INTO v_open_unreserved
    FROM pg_temp.cluster_census WHERE lifecycle IN ('live', 'opening') AND NOT breaking;
  SELECT count(*) INTO v_waiting FROM public.cash_game_waitlist w
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified');
  v_buyers := v_waiting + GREATEST(coalesce(p_eligible_horses, 0), 0);
  -- (a CASE ... THEN inside an IF condition ends the condition early in
  --  PL/pgSQL, so the cap is computed first)
  v_table_cap := g.cap_mains + 1;
  IF g.allow_second_feeder THEN v_table_cap := v_table_cap + 1; END IF;

  IF g.enabled AND v_open_unreserved = 0 AND v_live_tables > 0
     AND NOT EXISTS (SELECT 1 FROM pg_temp.cluster_census WHERE lifecycle = 'opening')
     AND v_live_tables < v_table_cap THEN
    IF v_buyers >= 2 THEN
      UPDATE public.tables SET promote_pending = true
       WHERE cluster_id = g.id AND role = 'feeder' AND lifecycle = 'live';
      PERFORM public.fn_cash_cluster_open_table(g.id, 'feeder', NULL, 'opening', NULL);
      UPDATE public.cash_games SET opening_hold_since = NULL WHERE id = g.id;
      v_actions := v_actions || jsonb_build_object('feeder', 'opened', 'buyers', v_buyers);
    ELSIF v_buyers = 1 THEN
      -- One buyer holds for 60 s; the fleet's next cycle usually brings a
      -- partner. No ghost table.
      IF g.opening_hold_since IS NULL THEN
        UPDATE public.cash_games SET opening_hold_since = v_now WHERE id = g.id;
        INSERT INTO public.cash_cluster_events (game_id, kind) VALUES (g.id, 'table_opening_hold');
        v_actions := v_actions || jsonb_build_object('opening_hold', 'started');
      ELSIF g.opening_hold_since < v_now - interval '60 seconds' THEN
        UPDATE public.cash_games SET opening_hold_since = NULL WHERE id = g.id;
        INSERT INTO public.cash_cluster_events (game_id, kind) VALUES (g.id, 'table_opening_hold_expired');
        v_actions := v_actions || jsonb_build_object('opening_hold', 'expired');
      END IF;
    END IF;
  ELSIF g.opening_hold_since IS NOT NULL THEN
    UPDATE public.cash_games SET opening_hold_since = NULL WHERE id = g.id;
  END IF;

  -- ── 4. PROMOTE (18.3) ────────────────────────────────────────────────────
  -- An opening feeder with two seated is live. The feeder before it, marked
  -- promote_pending, becomes Main N+1.
  FOR t IN SELECT * FROM pg_temp.cluster_census WHERE lifecycle = 'opening' AND seated >= 2 LOOP
    UPDATE public.tables SET lifecycle = 'live', live_at = v_now WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'feeder_live');
    SELECT coalesce(max(main_index), 0) + 1 INTO v_idx FROM public.tables
     WHERE cluster_id = g.id AND role = 'main' AND lifecycle <> 'closed' AND coalesce(is_deleted, false) = false;
    FOR v_prev_feeder IN SELECT id, name FROM public.tables
                          WHERE cluster_id = g.id AND role = 'feeder' AND promote_pending AND id <> t.id
                            AND lifecycle = 'live' ORDER BY created_at
    LOOP
      UPDATE public.tables SET role = 'main', main_index = v_idx, promote_pending = false,
             name = left(g.name, 50) || ' Main ' || v_idx
       WHERE id = v_prev_feeder.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, v_prev_feeder.id, 'feeder_promoted_to_main', jsonb_build_object('main_index', v_idx));
      v_idx := v_idx + 1;
    END LOOP;
    v_actions := v_actions || jsonb_build_object('feeder_live', t.id);
  END LOOP;

  -- Refresh the census for the steps that read roles.
  UPDATE pg_temp.cluster_census c SET role = tb.role, main_index = tb.main_index, lifecycle = tb.lifecycle
    FROM public.tables tb WHERE tb.id = c.id;

  -- ── 5. BREAK (18.3) ──────────────────────────────────────────────────────
  -- Candidate: newest table first (feeder, then the highest main), never
  -- Main 1, never a table still opening. Condition: everyone fits in the
  -- rest at or above the floor. Five minutes of that, then it breaks.
  v_floor := CASE WHEN g.handedness <= 6 THEN 3 ELSE 4 END;
  SELECT * INTO v_candidate FROM pg_temp.cluster_census
   WHERE NOT (role = 'main' AND main_index = 1) AND lifecycle = 'live'
   ORDER BY (role = 'feeder') DESC, main_index DESC NULLS FIRST, created_at DESC LIMIT 1;

  IF NOT EXISTS (SELECT 1 FROM pg_temp.cluster_census WHERE breaking) AND v_candidate.id IS NOT NULL THEN
    SELECT coalesce(sum(max_players - reserved), 0), count(*) INTO v_remaining_capacity, v_remaining_tables
      FROM pg_temp.cluster_census WHERE id <> v_candidate.id AND lifecycle = 'live';
    IF v_remaining_tables >= 1
       AND v_seated_total <= v_remaining_capacity
       AND v_seated_total >= v_floor * v_remaining_tables THEN
      SELECT break_eligible_since INTO r FROM public.tables WHERE id = v_candidate.id;
      IF r.break_eligible_since IS NULL THEN
        UPDATE public.tables SET break_eligible_since = v_now WHERE id = v_candidate.id;
        v_actions := v_actions || jsonb_build_object('break_eligible', v_candidate.id);
      ELSIF r.break_eligible_since <= v_now - interval '5 minutes' THEN
        UPDATE public.tables SET lifecycle = 'breaking', break_started_at = v_now, break_eligible_since = NULL
         WHERE id = v_candidate.id;
        UPDATE pg_temp.cluster_census SET breaking = true, lifecycle = 'breaking' WHERE id = v_candidate.id;
        INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
        VALUES (g.id, v_candidate.id, 'table_break_started',
                jsonb_build_object('seated_total', v_seated_total, 'remaining_capacity', v_remaining_capacity));
        v_actions := v_actions || jsonb_build_object('break_started', v_candidate.id);
      END IF;
    ELSE
      UPDATE public.tables SET break_eligible_since = NULL
       WHERE cluster_id = g.id AND break_eligible_since IS NOT NULL;
    END IF;
  ELSE
    UPDATE public.tables SET break_eligible_since = NULL
     WHERE cluster_id = g.id AND break_eligible_since IS NOT NULL;
  END IF;

  -- A breaking table: every seated player is planned onto the shortest live
  -- table with room (must-move already took the mains' open seats above;
  -- this covers what is left, feeder included). When the last chair is
  -- empty it closes.
  FOR t IN SELECT * FROM pg_temp.cluster_census WHERE breaking LOOP
    IF t.seated = 0 THEN
      UPDATE public.tables SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now()
       WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'table_break_completed');
      DELETE FROM pg_temp.cluster_census WHERE id = t.id;
      v_actions := v_actions || jsonb_build_object('closed', t.id);
      CONTINUE;
    END IF;
    FOR r IN SELECT ts.user_id FROM public.table_seats ts
              WHERE ts.table_id = t.id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
              ORDER BY ts.joined_at
    LOOP
      SELECT c.id INTO v_shortest FROM pg_temp.cluster_census c
       WHERE c.id <> t.id AND NOT c.breaking AND c.lifecycle IN ('live', 'opening')
         AND c.open_unreserved - (SELECT count(*) FROM public.cash_seat_moves m WHERE m.to_table_id = c.id AND m.state = 'pending') > 0
       ORDER BY c.seated ASC, c.main_index ASC NULLS LAST LIMIT 1;
      EXIT WHEN v_shortest IS NULL;
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
      VALUES (g.id, r.user_id, t.id, v_shortest, 'break');
      v_moves := v_moves + 1;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, v_shortest, 'move_planned', jsonb_build_object('player_id', r.user_id, 'from_table_id', t.id, 'reason', 'break'));
    END LOOP;
  END LOOP;

  -- ── 6. ROLES (1.3 s9.2) ──────────────────────────────────────────────────
  -- Oldest live table is Main 1; mains renumber by age; with no feeder left
  -- and two or more tables, the newest becomes the feeder.
  v_idx := 0;
  FOR t IN SELECT * FROM pg_temp.cluster_census WHERE lifecycle IN ('live', 'opening') AND role = 'main' ORDER BY created_at LOOP
    v_idx := v_idx + 1;
    IF t.main_index IS DISTINCT FROM v_idx THEN
      UPDATE public.tables SET main_index = v_idx,
             name = CASE WHEN v_idx = 1 THEN g.name ELSE left(g.name, 50) || ' Main ' || v_idx END
       WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, t.id, 'main_renumbered', jsonb_build_object('from', t.main_index, 'to', v_idx));
    END IF;
  END LOOP;
  IF v_idx >= 2 AND NOT EXISTS (SELECT 1 FROM pg_temp.cluster_census WHERE role = 'feeder' AND lifecycle IN ('live', 'opening')) THEN
    SELECT * INTO t FROM pg_temp.cluster_census WHERE role = 'main' AND lifecycle = 'live' ORDER BY created_at DESC LIMIT 1;
    UPDATE public.tables SET role = 'feeder', main_index = NULL, promote_pending = false,
           name = left(g.name, 50) || ' Feeder'
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'main_demoted_to_feeder');
    v_actions := v_actions || jsonb_build_object('demoted', t.id);
  END IF;

  -- ── enabled = false (18.4): no seeding, no opening; empties close ─────────
  IF NOT g.enabled THEN
    FOR t IN SELECT * FROM pg_temp.cluster_census WHERE seated = 0 LOOP
      UPDATE public.tables SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now() WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'table_closed_disabled');
      v_actions := v_actions || jsonb_build_object('closed_disabled', t.id);
    END LOOP;
  END IF;

  -- ── 7. WAKE / SLEEP (18.4) ───────────────────────────────────────────────
  v_new_state := CASE WHEN v_seated_total = 0 AND coalesce(p_eligible_horses, 0) = 0 THEN 'dormant' ELSE 'live' END;
  IF g.enabled AND g.state IS DISTINCT FROM v_new_state THEN
    UPDATE public.cash_games SET state = v_new_state, updated_at = now() WHERE id = g.id;
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (g.id, CASE WHEN v_new_state = 'live' THEN 'game_woken' ELSE 'game_dormant' END,
            jsonb_build_object('seated_total', v_seated_total, 'eligible_horses', p_eligible_horses));
    v_actions := v_actions || jsonb_build_object('state', v_new_state);
  END IF;

  UPDATE public.cash_games SET last_tick_at = v_now, last_tick_actions = v_actions WHERE id = g.id;

  RETURN jsonb_build_object('ok', true, 'game_id', g.id, 'seated_total', v_seated_total,
                            'tables', v_live_tables, 'buyers', v_buyers, 'actions', v_actions);
END;
$$;
REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) TO service_role;

-- The controller's worklist: every enabled must-move game, with its Main 1
-- so the engine can be woken.
CREATE OR REPLACE FUNCTION public.fn_cash_clusters_to_tick()
RETURNS TABLE(game_id uuid, club_id uuid, main1_table_id uuid, state text, enabled boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT g.id, g.club_id,
         (SELECT t.id FROM public.tables t WHERE t.cluster_id = g.id AND t.role = 'main' AND t.main_index = 1
            AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false ORDER BY t.created_at LIMIT 1),
         g.state, g.enabled
    FROM public.cash_games g
   WHERE g.must_move
     AND (g.enabled OR EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g.id AND t.lifecycle <> 'closed'
                                  AND t.status IN ('waiting','running','active')))
   ORDER BY g.created_at;
$$;
REVOKE ALL ON FUNCTION public.fn_cash_clusters_to_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_clusters_to_tick() TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4b. The management contract ignores lifecycle state and survives A -> B -> A
-- ─────────────────────────────────────────────────────────────────────────────
-- Both bodies as deployed 2026-09-05 plus the marked lines.

CREATE OR REPLACE FUNCTION public.fn_managed_game_contract_document(p_kind text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE p_kind
    WHEN 'table' THEN p_row - ARRAY[
      'current_players', 'status', 'created_at', 'updated_at', 'deleted_at',
      -- Cluster runtime state (Slice 2, 2026-09-05): what the controller
      -- moves every tick is not the host's contract.
      'lifecycle', 'role', 'main_index', 'opened_at', 'live_at', 'break_started_at',
      'break_eligible_since', 'promote_pending',
      'deleted_by', 'is_deleted', 'current_hand_id', 'hand_number',
      'last_activity_at', 'tournament_id', 'engine_instance_id',
      'first_button_seat', 'bomb_pot_manual_pending', 'bomb_pot_sched_state',
      'bomb_pot_next_due_at', 'engine_lease_owner', 'engine_lease_expires_at'
    ]::text[]
    WHEN 'tournament' THEN jsonb_strip_nulls(
      jsonb_build_object(
        'id', p_row -> 'id', 'club_id', p_row -> 'club_id',
        'union_id', p_row -> 'union_id', 'name', p_row -> 'name',
        'game_type', p_row -> 'game_type', 'variant', p_row -> 'variant',
        'tournament_type', p_row -> 'tournament_type',
        'buy_in_amount', p_row -> 'buy_in_amount', 'buy_in_fee', p_row -> 'buy_in_fee',
        'starting_chips', p_row -> 'starting_chips', 'max_players', p_row -> 'max_players',
        'min_players', p_row -> 'min_players', 'blind_structure', p_row -> 'blind_structure',
        'payout_structure', p_row -> 'payout_structure',
        'guaranteed_prize', p_row -> 'guaranteed_prize',
        'late_reg_levels', p_row -> 'late_reg_levels', 'late_reg_mins', p_row -> 'late_reg_mins',
        'rebuy_levels', p_row -> 'rebuy_levels', 'start_time', p_row -> 'start_time',
        'is_rebuy', p_row -> 'is_rebuy', 'is_reentry', p_row -> 'is_reentry',
        'rebuy_cost', p_row -> 'rebuy_cost', 'rebuy_chips', p_row -> 'rebuy_chips'
      ) || jsonb_build_object(
        'add_on_available', p_row -> 'add_on_available', 'addon_cost', p_row -> 'addon_cost',
        'addon_chips', p_row -> 'addon_chips', 'addon_levels', p_row -> 'addon_levels',
        'is_bounty', p_row -> 'is_bounty', 'bounty_amount', p_row -> 'bounty_amount',
        'is_pko', p_row -> 'is_pko', 'is_mystery_bounty', p_row -> 'is_mystery_bounty',
        'spin_type', p_row -> 'spin_type', 'satellite_target_id', p_row -> 'satellite_target_id',
        'satellite_seats', p_row -> 'satellite_seats', 'is_xmtt', p_row -> 'is_xmtt',
        'is_private', p_row -> 'is_private', 'short_description', p_row -> 'short_description',
        'is_vip_only', p_row -> 'is_vip_only', 'ban_chat', p_row -> 'ban_chat',
        'all_in_or_fold', p_row -> 'all_in_or_fold', 'label_as_new', p_row -> 'label_as_new',
        'hide_club_name', p_row -> 'hide_club_name',
        'action_time_seconds', p_row -> 'action_time_seconds', 'table_size', p_row -> 'table_size',
        'accelerated_mtt', p_row -> 'accelerated_mtt',
        'addon_break_minutes', p_row -> 'addon_break_minutes'
      ) || jsonb_build_object(
        'big_blind_ante', p_row -> 'big_blind_ante',
        'authorized_to_register', p_row -> 'authorized_to_register',
        'early_bird_enabled', p_row -> 'early_bird_enabled',
        'early_bird_chips', p_row -> 'early_bird_chips',
        'bubble_protection', p_row -> 'bubble_protection',
        'final_table_deal_enabled', p_row -> 'final_table_deal_enabled',
        'restart_every_minutes', p_row -> 'restart_every_minutes',
        'synchronized_breaks', p_row -> 'synchronized_breaks',
        'max_rebuys', p_row -> 'max_rebuys', 'max_reentries', p_row -> 'max_reentries',
        'is_multi_day', p_row -> 'is_multi_day', 'total_days', p_row -> 'total_days',
        'mystery_bounty_min', p_row -> 'mystery_bounty_min',
        'mystery_bounty_max', p_row -> 'mystery_bounty_max',
        'is_pinned', p_row -> 'is_pinned', 'schedule_id', p_row -> 'schedule_id'
      )
    )
    ELSE '{}'::jsonb
  END
$function$;

CREATE OR REPLACE FUNCTION public.fn_capture_managed_game_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_kind text := CASE TG_TABLE_NAME WHEN 'tables' THEN 'table' ELSE 'tournament' END;
  v_contract jsonb;
  v_hash text;
  v_last_hash text;
  v_version integer;
BEGIN
  IF v_kind = 'table' AND to_jsonb(NEW) -> 'tournament_id' <> 'null'::jsonb THEN
    RETURN NEW;
  END IF;

  v_contract := public.fn_managed_game_contract_document(v_kind, to_jsonb(NEW));
  v_hash := public.fn_managed_game_contract_hash(v_contract);

  SELECT contract_hash, version
    INTO v_last_hash, v_version
    FROM public.managed_game_contract_versions
   WHERE game_kind = v_kind AND game_id = NEW.id
   ORDER BY version DESC
   LIMIT 1;

  IF v_last_hash IS NOT DISTINCT FROM v_hash THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.managed_game_contract_versions (
    game_kind, game_id, club_id, union_id, version, contract,
    contract_hash, published_by, change_reason
  ) VALUES (
    v_kind, NEW.id, NEW.club_id, NEW.union_id, COALESCE(v_version, 0) + 1,
    v_contract, v_hash, auth.uid(),
    CASE
      WHEN TG_OP = 'INSERT' THEN 'created'
      WHEN auth.uid() IS NULL THEN 'system_revision'
      ELSE 'operator_revision'
    END
  )
  -- A contract that returns to an EARLIER version's content (A -> B -> A: a
  -- feeder promoted to a main and demoted back, a name edited and edited
  -- back) used to raise on the (kind, game, hash) unique key and take the
  -- whole UPDATE down with it - every tick, forever. The version ledger
  -- simply does not gain a row for a state it already holds (2026-09-05).
  ON CONFLICT ON CONSTRAINT managed_game_contract_version_game_kind_game_id_contract_ha_key DO NOTHING;

  RETURN NEW;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The thaw gives back the cluster clocks (18.5)
-- ─────────────────────────────────────────────────────────────────────────────
-- Body as deployed 2026-09-04 plus two steps; see the step comments.

CREATE OR REPLACE FUNCTION public.fn_thaw_platform(p_freeze_started timestamp with time zone, p_frozen_seconds numeric, p_thawed_by text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Stop starting new steps once this much of our own wall clock is spent.
  -- PostgREST's service_role statement_timeout is 8s; the remainder is head
  -- room for the step in flight and for the FOR UPDATE wait.
  c_budget      CONSTANT INTERVAL := interval '4 seconds';
  -- tournaments.level_started_at rows per call (~20ms each through triggers).
  c_level_batch CONSTANT INTEGER  := 40;

  v_started  TIMESTAMPTZ := clock_timestamp();
  v_row      public.engine_maintenance_thaws%ROWTYPE;
  v_shift    INTERVAL;
  v_counts   JSONB;
  v_n        INTEGER;
  v_done     TEXT[] := '{}';
  v_cursor   UUID;
  v_last     UUID;
  v_batch_n  INTEGER;
  v_total    INTEGER;
BEGIN
  -- Sanity: a thaw claiming more than fifteen frozen minutes is a bug or a
  -- clock skew, and shifting every deadline on the platform by a wrong number
  -- is strictly worse than shifting by nothing.
  IF p_frozen_seconds IS NULL OR p_frozen_seconds <= 0 OR p_frozen_seconds > 900 THEN
    RETURN jsonb_build_object('ok', false, 'complete', false, 'reason', 'implausible_frozen_seconds');
  END IF;

  -- Claim this freeze (or find it already claimed). The ledger row is the
  -- checkpoint file for every call that follows.
  INSERT INTO public.engine_maintenance_thaws (freeze_started_at, frozen_seconds, shifted, thawed_by)
  VALUES (p_freeze_started, p_frozen_seconds, '{}'::jsonb, p_thawed_by)
  ON CONFLICT (freeze_started_at) DO NOTHING;

  SELECT * INTO v_row
    FROM public.engine_maintenance_thaws
   WHERE freeze_started_at = p_freeze_started
     FOR UPDATE;

  v_counts := COALESCE(v_row.shifted, '{}'::jsonb);
  IF COALESCE((v_counts->>'complete')::boolean, false) THEN
    RETURN jsonb_build_object('ok', true, 'complete', true, 'reason', 'already_thawed', 'shifted', v_counts);
  END IF;

  -- One shift for the whole platform: the number the claim recorded.
  v_shift := make_interval(secs => v_row.frozen_seconds);

  -- The thaw's own writes must pass the freeze guard even if it is called a
  -- moment before break_ends_at, and trg_stamp_sit_out_at lets the sit-out
  -- shift through only under this GUC. LOCAL: dies with this transaction.
  PERFORM set_config('app.freeze_bypass', 'on', TRUE);

  -- ── Step: sit-out clocks on live seats ─────────────────────────────────
  -- The whole reason a player can sit out at :53 and still own their seat
  -- at :00. Cheap (index on status; a handful of rows).
  IF NOT (v_counts ? 'sit_out_at') THEN
    UPDATE public.table_seats
       SET sit_out_at = sit_out_at + v_shift
     WHERE left_at IS NULL AND sit_out_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('sit_out_at', v_n);
    v_done := array_append(v_done, 'sit_out_at');
  END IF;

  -- ── Step: waitlist seat holds ──────────────────────────────────────────
  -- Holds alive when the freeze began (including any that "expired" during
  -- it - the shift resurrects exactly the time they were owed and no more).
  IF NOT (v_counts ? 'hold_expires_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.table_waitlist
       SET hold_expires_at = hold_expires_at + v_shift
     WHERE hold_expires_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('hold_expires_at', v_n);
    v_done := array_append(v_done, 'hold_expires_at');
  END IF;

  -- ── Step: tournament add-on windows ────────────────────────────────────
  IF NOT (v_counts ? 'addon_period_ends_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournaments
       SET addon_period_ends_at = addon_period_ends_at + v_shift
     WHERE addon_period_ends_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('addon_period_ends_at', v_n);
    v_done := array_append(v_done, 'addon_period_ends_at');
  END IF;

  -- ── Step: the cashier claim-back window (10 minutes; a freeze would eat half)
  IF NOT (v_counts ? 'reversible_until') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.chip_transactions
       SET reversible_until = reversible_until + v_shift
     WHERE reversible_until > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('reversible_until', v_n);
    v_done := array_append(v_done, 'reversible_until');
  END IF;

  -- ── Step: mystery bounty reveal windows ────────────────────────────────
  IF NOT (v_counts ? 'reveal_deadline_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournament_bounty_awards
       SET reveal_deadline_at = reveal_deadline_at + v_shift
     WHERE reveal_deadline_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('reveal_deadline_at', v_n);
    v_done := array_append(v_done, 'reveal_deadline_at');
  END IF;

  -- ── Step: bust-rebuy prompts ───────────────────────────────────────────
  IF NOT (v_counts ? 'rebuy_prompt_until') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournament_players
       SET rebuy_prompt_until = rebuy_prompt_until + v_shift
     WHERE rebuy_prompt_until > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('rebuy_prompt_until', v_n);
    v_done := array_append(v_done, 'rebuy_prompt_until');
  END IF;

  -- ── Step: timed bomb pots ──────────────────────────────────────────────
  -- Due exactly as far after the thaw as they were before the freeze.
  IF NOT (v_counts ? 'bomb_pot_next_due_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tables
       SET bomb_pot_next_due_at = bomb_pot_next_due_at + v_shift
     WHERE bomb_pot_next_due_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('bomb_pot_next_due_at', v_n);
    v_done := array_append(v_done, 'bomb_pot_next_due_at');
  END IF;

  -- ── Step: CHIP CONTINUITY stay clocks (2026-09-04) ─────────────────────
  -- A running stay clock is `remaining as of last_tick`; shifting last_tick
  -- forward by the frozen minutes is exactly "the freeze did not count".
  -- Only ticks stamped before the thaw: a row the engine has already
  -- re-settled after the break carries no frozen time to give back.
  IF NOT (v_counts ? 'cash_stay_last_tick_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.cash_player_session
       SET stay_last_tick_at = stay_last_tick_at + v_shift
     WHERE closed_at IS NULL AND stay_running AND stay_last_tick_at <= p_freeze_started + v_shift;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cash_stay_last_tick_at', v_n);
    v_done := array_append(v_done, 'cash_stay_last_tick_at');
  END IF;

  -- ── Step: CHIP CONTINUITY rejoin floors (2026-09-04) ───────────────────
  IF NOT (v_counts ? 'cash_rejoin_expires_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.cash_rejoin_constraints
       SET expires_at = expires_at + v_shift
     WHERE expires_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cash_rejoin_expires_at', v_n);
    v_done := array_append(v_done, 'cash_rejoin_expires_at');
  END IF;

  -- ── Step: CLUSTER CONTROLLER deadlines (Slice 2, 2026-09-05) ────────────
  -- break_eligible_since is the break hysteresis clock: five frozen minutes
  -- must not count as five quiet minutes. A pending seat move expires 60 s
  -- after it was planned; a frozen engine could not execute it in time.
  IF NOT (v_counts ? 'cluster_break_eligible_since') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tables
       SET break_eligible_since = break_eligible_since + v_shift
     WHERE break_eligible_since IS NOT NULL AND break_eligible_since <= p_freeze_started + v_shift
       AND cluster_id IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cluster_break_eligible_since', v_n);
    v_done := array_append(v_done, 'cluster_break_eligible_since');
  END IF;
  IF NOT (v_counts ? 'cluster_move_expires_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.cash_seat_moves
       SET expires_at = expires_at + v_shift
     WHERE state = 'pending' AND expires_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cluster_move_expires_at', v_n);
    v_done := array_append(v_done, 'cluster_move_expires_at');
  END IF;

  -- ── Step (chunked): blind level clocks ─────────────────────────────────
  -- ONLY for running events NOT on the synchronized break. An MTT on the :55
  -- break has its level clock suspended by pauseForBreak and restored by
  -- resumeFromBreak; shifting it here would give that event the five minutes
  -- twice. Short formats (Spins, Heads-Up) never take the synchronized break,
  -- so their wall-time level clock ran straight through the park - this is
  -- what gives it back (the 2026-08-27 incident class where Spins lost whole
  -- levels to a stop they never asked for).
  --
  -- This is the expensive one (~20ms/row through the table's UPDATE
  -- triggers), so it walks the primary key c_level_batch rows at a time and
  -- checkpoints the cursor after every batch. The shift is additive, so the
  -- cursor is what makes re-entry safe: a row below the cursor is done.
  -- The batch ordering by id is stable because no row's id changes and the
  -- set of RUNNING events cannot grow while the engine is parked.
  WHILE NOT (v_counts ? 'level_started_at') AND clock_timestamp() - v_started <= c_budget LOOP
    v_cursor := NULLIF(v_counts->>'level_started_at_cursor', '')::uuid;
    v_total  := COALESCE((v_counts->>'level_started_at_so_far')::integer, 0);

    WITH batch AS (
      SELECT id
        FROM public.tournaments
       WHERE status = 'RUNNING'
         AND COALESCE(on_break, FALSE) = FALSE
         AND level_started_at IS NOT NULL
         AND (v_cursor IS NULL OR id > v_cursor)
       ORDER BY id
       LIMIT c_level_batch
    ),
    shifted AS (
      UPDATE public.tournaments t
         SET level_started_at = t.level_started_at + v_shift
        FROM batch b
       WHERE t.id = b.id
      RETURNING t.id
    )
    -- (no max(uuid) in Postgres; uuid order is bytewise, identical to its hex text order)
    SELECT count(*), max(id::text)::uuid INTO v_batch_n, v_last FROM shifted;

    v_total := v_total + COALESCE(v_batch_n, 0);

    IF COALESCE(v_batch_n, 0) < c_level_batch THEN
      -- The last batch. Record the final count and drop the cursor keys.
      v_counts := (v_counts - 'level_started_at_cursor' - 'level_started_at_so_far')
                  || jsonb_build_object('level_started_at', v_total);
      v_done := array_append(v_done, 'level_started_at');
    ELSE
      v_counts := v_counts || jsonb_build_object(
        'level_started_at_cursor', v_last::text,
        'level_started_at_so_far', v_total
      );
    END IF;
  END LOOP;

  -- NOT shifted, deliberately:
  --   * tournaments.break_ends_at - the synchronized break owns it and the
  --     engine's resumeFromBreak restores it;
  --   * late_reg (started_at + late_reg_mins) - registration is frozen during
  --     the break, and the hourly tournament break has consumed those same
  --     five minutes of late-reg wall time since it was built. Shifting
  --     started_at would falsify history; parity with the existing break is
  --     the honest behaviour;
  --   * ban/mute/promotion expiries - a punishment or a promotion elapsing
  --     during a break is time genuinely passing, not play being taken away.

  -- Complete when every step has its key.
  IF v_counts ?& ARRAY['sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
                       'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
                       'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
                       'cluster_break_eligible_since','cluster_move_expires_at'] THEN
    v_counts := v_counts || jsonb_build_object('complete', true);
  END IF;

  -- Checkpoint. This commit is what a later call resumes from.
  UPDATE public.engine_maintenance_thaws
     SET shifted   = v_counts,
         thawed_at = now()
   WHERE freeze_started_at = p_freeze_started;

  RETURN jsonb_build_object(
    'ok', true,
    'complete', COALESCE((v_counts->>'complete')::boolean, false),
    'steps_this_call', to_jsonb(v_done),
    'elapsed_ms', round(extract(epoch from clock_timestamp() - v_started) * 1000),
    'shifted', v_counts
  );
END;
$function$;

-- Engine-only, exactly as they already are in production: CREATE OR REPLACE
-- keeps an ACL, but check-definer-authorization reads the FILE.
REVOKE ALL ON FUNCTION public.fn_thaw_platform(timestamptz, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_thaw_platform(timestamptz, numeric, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_capture_managed_game_contract() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_capture_managed_game_contract() TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Assertions
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_src text;
BEGIN
  IF to_regclass('public.cash_seat_moves') IS NULL OR to_regclass('public.cash_game_waitlist') IS NULL
     OR to_regclass('public.cash_cluster_events') IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: cluster tables missing';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_thaw_platform';
  IF position('cluster_break_eligible_since' in v_src) = 0 OR position('cluster_move_expires_at' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: the thaw does not give back the cluster clocks';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_cash_game_create';
  IF position('fn_cash_cluster_open_table' in v_src) = 0 OR position('v_must_move, v_must_move, false' in v_src) > 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: fn_cash_game_create must open Main 1 through the cluster writer, with no lifecycle-pass flags';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_cash_seat_move_execute';
  IF position('wallet' in v_src) > 0 AND position('no wallet row is written' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: a move must not touch a wallet';
  END IF;
  RAISE NOTICE 'cluster controller slice 2: tick, moves, waitlist, events, thaw.';
END $$;

COMMIT;
