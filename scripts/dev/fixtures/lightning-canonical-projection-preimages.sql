CREATE OR REPLACE FUNCTION public.fn_cash_cluster_open_table(p_game_id uuid, p_role text, p_main_index integer, p_lifecycle text DEFAULT 'opening'::text, p_created_by uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g record; s jsonb; v_opts jsonb;
  v_ante text; v_ante_chips numeric; v_vpip integer; v_vpip_window integer;
  v_bomb_on boolean; v_bomb_trigger text; v_bomb_ante integer; v_bomb_boards integer;
  v_min_bb integer; v_max_bb integer; v_name text; v_table_id uuid; v_n integer;
  v_kill_mode text; v_kill_bb smallint;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR SHARE;
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
  v_vpip_window := coalesce((s->>'vpip_window')::integer, 10);
  v_bomb_on := coalesce((s->'bombs'->>'enabled')::boolean, false);
  v_bomb_trigger := s->'bombs'->>'trigger';
  v_bomb_ante := (s->'bombs'->>'ante_bb')::integer;
  v_bomb_boards := (s->'bombs'->>'boards')::integer;
  v_min_bb := coalesce((s->>'min_buyin_bb')::integer, 40);
  v_max_bb := coalesce((s->>'max_buyin_bb')::integer, 200);
  -- KILL POTS (kill-v1, 20260924034010). The game's snapshot carries
  -- {"kill":{"mode","threshold_bb"}}; fn_cash_apply_ruleset projects the
  -- same two values identically. 'off' whenever the kill would be refused
  -- at this table, so opening a table never fails on a kill setting.
  v_kill_bb := CASE WHEN (s->'kill'->>'threshold_bb') IN ('8','10','12','15')
                    THEN (s->'kill'->>'threshold_bb')::smallint ELSE 10 END;
  v_kill_mode := lower(coalesce(s->'kill'->>'mode', 'off'));
  IF v_kill_mode NOT IN ('half', 'full') THEN
    v_kill_mode := 'off';
  ELSIF public.fn_kill_pot_configuration_refusal(v_kill_mode, g.variant, 'cash', NULL, v_bomb_on, g.bb, g.club_id) IS NOT NULL THEN
    v_kill_mode := 'off';
  ELSIF NOT public.fn_capability_available('cash.fixed_limit.kill_pots') THEN
    v_kill_mode := 'off';
  END IF;

  -- "NLH 1/2 Classic" for Main 1, "NLH 1/2 Classic Main 2", "... Feeder".
  -- LIVE tables only. R3 reopens a closed cluster's one table with the
  -- closed row still present, so an all-time count made a reopened lone
  -- feeder "<game> Feeder" and the lone-feeder guard then stopped the ROLES
  -- step ever renaming it (2026-09-21 remediation).
  SELECT count(*) INTO v_n FROM public.tables WHERE cluster_id = p_game_id
     AND lifecycle <> 'closed' AND coalesce(is_deleted, false) = false;
  v_name := CASE
    WHEN p_role = 'main' AND p_main_index = 1 THEN g.name
    WHEN p_role = 'main' THEN left(g.name, 50) || ' Main ' || p_main_index
    -- the cluster's first table stands for the game, whatever its role
    WHEN v_n = 0 THEN g.name
    ELSE left(g.name, 50) || ' Feeder' END;

  INSERT INTO public.tables (
    club_id, union_id, name, game_type, game_variant, game_mode,
    small_blind, big_blind, stakes,
    max_players, min_buy_in, max_buy_in,
    ante_enabled, ante, ante_bb, big_blind_ante_enabled,
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
    cluster_id, role, main_index, lifecycle, opened_at, live_at,
    kill_mode, kill_threshold_bb
  ) VALUES (
    g.club_id, g.union_id, v_name, 'cash', g.variant, 'regular',
    g.sb, g.bb, public.fn_cash_stakes_label(g.sb, g.bb, g.variant),
    g.handedness, round(g.bb * v_min_bb, 2), round(g.bb * v_max_bb, 2),
    -- BIG BLIND ANTE (2026-09-05): 'bb' is the format, not just the size -
    -- the big blind posts one ante for the table. 'sb' is the classic ante,
    -- a small blind from every seat.
    v_ante_chips > 0, v_ante_chips, CASE WHEN v_ante_chips > 0 THEN round(v_ante_chips / g.bb, 4) ELSE 0 END,
    (v_ante = 'bb'),
    v_vpip > 0, 0, v_vpip, v_vpip_window,
    v_bomb_on,
    CASE WHEN v_bomb_on AND v_bomb_trigger IN ('timed_10m', 'timed_15m', 'timed_20m') THEN 'timed'
         WHEN v_bomb_on AND v_bomb_trigger = 'every_orbit' THEN 'once_per_orbit'
         ELSE 'every_n_hands' END,
    CASE WHEN NOT v_bomb_on THEN NULL
         WHEN v_bomb_trigger = 'timed_10m' THEN 600
         WHEN v_bomb_trigger = 'timed_15m' THEN 900
         WHEN v_bomb_trigger = 'timed_20m' THEN 1200
         ELSE NULL END,
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
    clock_timestamp(), CASE WHEN p_lifecycle = 'live' THEN clock_timestamp() END,
    v_kill_mode, v_kill_bb
  ) RETURNING id INTO v_table_id;

  IF EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.asset='diamonds') THEN
    PERFORM public.fn_poker_diamond_project_cluster(g.id,v_table_id);
  END IF;

  -- BORN HALTED IN A CLUSTER THAT IS NOT DEALING CASH (2026-09-26).
  IF g.cluster_mode IS DISTINCT FROM 'must_move' THEN
    UPDATE public.tables t
       SET dealing_halted_at = clock_timestamp(),
           dealing_halted_reason = CASE WHEN g.cluster_mode = 'pending_on'
                                        THEN 'lightning_pending_on' ELSE 'lightning' END
     WHERE t.id = v_table_id;
  END IF;

  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (p_game_id, v_table_id, CASE WHEN p_role = 'feeder' THEN 'feeder_opened' ELSE 'main_opened' END,
          jsonb_build_object('role', p_role, 'main_index', p_main_index, 'lifecycle', p_lifecycle, 'name', v_name));
  RETURN v_table_id;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_apply_ruleset(p_game_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g record; s jsonb; v_opts jsonb;
  v_ante text; v_ante_chips numeric; v_vpip integer; v_vpip_window integer;
  v_bomb_on boolean; v_bomb_trigger text; v_bomb_ante integer; v_bomb_boards integer;
  v_min_bb integer; v_max_bb integer;
  v_trigger_mode text; v_interval integer; v_action_secs integer;
  v_rit text; v_rit_mode text; v_rit_on boolean; v_sd boolean;
  v_n integer := 0;
  v_kill_mode text; v_kill_bb smallint;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.asset='diamonds') THEN
    RETURN public.fn_poker_diamond_project_cluster(g.id,NULL);
  END IF;
  s := g.ruleset_snapshot;
  IF s IS NULL THEN RETURN 0; END IF;

  -- The same mapping fn_cash_cluster_open_table applies at open. Kept in
  -- one place by construction: the opener's INSERT and this UPDATE must read
  -- the snapshot identically or a fresh table and a reconciled one disagree.
  v_opts := coalesce(s->'options', '{}'::jsonb);
  v_ante := coalesce(s->>'regular_ante', 'none');
  v_ante_chips := CASE v_ante WHEN 'sb' THEN g.sb WHEN 'bb' THEN g.bb ELSE 0 END;
  v_vpip := coalesce((s->>'vpip_floor')::integer, 0);
  v_vpip_window := coalesce((s->>'vpip_window')::integer, 10);
  v_bomb_on := coalesce((s->'bombs'->>'enabled')::boolean, false);
  v_bomb_trigger := s->'bombs'->>'trigger';
  v_bomb_ante := (s->'bombs'->>'ante_bb')::integer;
  v_bomb_boards := (s->'bombs'->>'boards')::integer;
  v_min_bb := coalesce((s->>'min_buyin_bb')::integer, 40);
  v_max_bb := coalesce((s->>'max_buyin_bb')::integer, 200);
  v_trigger_mode := CASE WHEN v_bomb_on AND v_bomb_trigger IN ('timed_10m', 'timed_15m', 'timed_20m') THEN 'timed'
                         WHEN v_bomb_on AND v_bomb_trigger = 'every_orbit' THEN 'once_per_orbit'
                         ELSE 'every_n_hands' END;
  v_interval := CASE WHEN NOT v_bomb_on THEN NULL
                     WHEN v_bomb_trigger = 'timed_10m' THEN 600
                     WHEN v_bomb_trigger = 'timed_15m' THEN 900
                     WHEN v_bomb_trigger = 'timed_20m' THEN 1200
                     ELSE NULL END;
  v_action_secs := LEAST(120, GREATEST(10, coalesce((v_opts->>'action_time_seconds')::integer, 15)));
  -- RUN IT N TIMES (2026-09-09, lane E audit): the opener projects the
  -- snapshot's run_it_n_times as run_it_mode + the three RIT booleans and
  -- this function never did, so the 42 tables adopted at the Gate 7 cutover
  -- kept the old form's answer - four tables of one game offering
  -- run-it-twice and the fifth not. The snapshot only ever says 'opt_in'
  -- today; the other spellings are mapped rather than defaulted so a future
  -- writer cannot land 'none' by accident.
  v_rit := lower(coalesce(s->>'run_it_n_times', 'opt_in'));
  v_rit_mode := CASE v_rit
                  WHEN 'opt_in' THEN 'player_choice'
                  WHEN 'player_choice' THEN 'player_choice'
                  WHEN 'mandatory_twice' THEN 'mandatory_twice'
                  WHEN 'mandatory_three' THEN 'mandatory_three'
                  ELSE 'none' END;
  v_rit_on := v_rit_mode <> 'none';
  -- 7-2 IS A HOLD'EM BOUNTY. The create path guards it ("AND v_v = 'nlh'");
  -- the projection guards it too so no other snapshot writer can put a
  -- seven-deuce bounty on an Omaha table.
  v_sd := coalesce((v_opts->>'seven_deuce_enabled')::boolean, false) AND g.variant = 'nlh';
  -- KILL POTS (kill-v1, 20260924034010). Exactly the opener's projection:
  -- 'off' whenever the kill would be refused at this game's tables, so a
  -- tick never fails on a kill setting and a demoted capability turns the
  -- whole game off together rather than one table at a time.
  v_kill_bb := CASE WHEN (s->'kill'->>'threshold_bb') IN ('8','10','12','15')
                    THEN (s->'kill'->>'threshold_bb')::smallint ELSE 10 END;
  v_kill_mode := lower(coalesce(s->'kill'->>'mode', 'off'));
  IF v_kill_mode NOT IN ('half', 'full') THEN
    v_kill_mode := 'off';
  ELSIF public.fn_kill_pot_configuration_refusal(v_kill_mode, g.variant, 'cash', NULL, v_bomb_on, g.bb, g.club_id) IS NOT NULL THEN
    v_kill_mode := 'off';
  ELSIF NOT public.fn_capability_available('cash.fixed_limit.kill_pots') THEN
    v_kill_mode := 'off';
  END IF;

  UPDATE public.tables t
     SET ante_enabled = v_ante_chips > 0,
         ante = v_ante_chips,
         ante_bb = CASE WHEN v_ante_chips > 0 THEN round(v_ante_chips / g.bb, 4) ELSE 0 END,
         big_blind_ante_enabled = (v_ante = 'bb'),
         nit_game = v_vpip > 0,
         career_percent_min = 0,
         maintain_percent_min = v_vpip,
         maintain_hands = v_vpip_window,
         bomb_pot_enabled = v_bomb_on,
         bomb_pot_trigger_mode = v_trigger_mode,
         bomb_pot_interval_seconds = v_interval,
         bomb_pot_frequency = 0,
         bomb_pot_ante_multiplier = coalesce(v_bomb_ante, 2),
         bomb_pot_board_count = coalesce(v_bomb_boards, 1),
         bomb_pot_double_board = coalesce(v_bomb_boards, 1) >= 2,
         bomb_pot_min_players = 2,
         min_buy_in = round(g.bb * v_min_bb, 2),
         max_buy_in = round(g.bb * v_max_bb, 2),
         -- THE CEILING IS THE GAME'S HANDEDNESS, BUT NEVER BELOW AN
         -- OCCUPIED CHAIR (2026-09-09). Two PLO5 Classic tables carried
         -- max_players 7 on a 6-handed game and one had a player in seat
         -- 7; the ceiling follows the seats down at the first tick AFTER
         -- that chair empties, so nobody is closed out of a seat.
         max_players = GREATEST(g.handedness,
                                coalesce((SELECT max(ts.seat_number) FROM public.table_seats ts
                                           WHERE ts.table_id = t.id AND ts.left_at IS NULL), 0)),
         stakes = public.fn_cash_stakes_label(g.sb, g.bb, g.variant),
         small_blind = g.sb, big_blind = g.bb, game_variant = g.variant,
         straddle_enabled = false, auto_utg_straddle = false, voluntary_straddle = false,
         run_it_mode = v_rit_mode,
         run_it_twice = v_rit_on,
         allow_run_it_twice = v_rit_on,
         run_it_twice_enabled = v_rit_on,
         is_private = coalesce((v_opts->>'is_private')::boolean, false),
         is_vip_only = coalesce((v_opts->>'is_vip_only')::boolean, false),
         is_anonymous = coalesce((v_opts->>'is_anonymous')::boolean, false),
         ban_chat = coalesce((v_opts->>'ban_chat')::boolean, false),
         insurance_enabled = coalesce((v_opts->>'insurance_enabled')::boolean, false),
         seven_deuce_enabled = v_sd,
         seven_deuce_amount = CASE WHEN v_sd THEN 2 ELSE 0 END,
         action_time_seconds = v_action_secs,
         kill_mode = v_kill_mode,
         kill_threshold_bb = v_kill_bb,
         updated_at = now()
   WHERE t.cluster_id = g.id
     AND t.lifecycle <> 'closed'
     AND coalesce(t.is_deleted, false) = false
     AND (
          t.ante_enabled IS DISTINCT FROM (v_ante_chips > 0)
       OR t.ante IS DISTINCT FROM v_ante_chips
       OR t.ante_bb IS DISTINCT FROM (CASE WHEN v_ante_chips > 0 THEN round(v_ante_chips / g.bb, 4) ELSE 0 END)
       OR t.big_blind_ante_enabled IS DISTINCT FROM (v_ante = 'bb')
       OR t.nit_game IS DISTINCT FROM (v_vpip > 0)
       OR t.maintain_percent_min IS DISTINCT FROM v_vpip
       OR t.maintain_hands IS DISTINCT FROM v_vpip_window
       OR t.bomb_pot_enabled IS DISTINCT FROM v_bomb_on
       OR t.bomb_pot_trigger_mode IS DISTINCT FROM v_trigger_mode
       OR t.bomb_pot_interval_seconds IS DISTINCT FROM v_interval
       OR t.bomb_pot_ante_multiplier IS DISTINCT FROM coalesce(v_bomb_ante, 2)
       OR t.bomb_pot_board_count IS DISTINCT FROM coalesce(v_bomb_boards, 1)
       OR t.bomb_pot_double_board IS DISTINCT FROM (coalesce(v_bomb_boards, 1) >= 2)
       OR t.bomb_pot_min_players IS DISTINCT FROM 2
       OR t.min_buy_in IS DISTINCT FROM round(g.bb * v_min_bb, 2)
       OR t.max_buy_in IS DISTINCT FROM round(g.bb * v_max_bb, 2)
       OR t.max_players IS DISTINCT FROM GREATEST(g.handedness,
                                coalesce((SELECT max(ts.seat_number) FROM public.table_seats ts
                                           WHERE ts.table_id = t.id AND ts.left_at IS NULL), 0))
       OR t.stakes IS DISTINCT FROM public.fn_cash_stakes_label(g.sb, g.bb, g.variant)
       OR t.small_blind IS DISTINCT FROM g.sb
       OR t.big_blind IS DISTINCT FROM g.bb
       OR t.game_variant IS DISTINCT FROM g.variant
       OR t.career_percent_min IS DISTINCT FROM 0
       OR coalesce(t.straddle_enabled, false) OR coalesce(t.auto_utg_straddle, false) OR coalesce(t.voluntary_straddle, false)
       OR t.run_it_mode IS DISTINCT FROM v_rit_mode
       OR t.run_it_twice IS DISTINCT FROM v_rit_on
       OR t.allow_run_it_twice IS DISTINCT FROM v_rit_on
       OR t.run_it_twice_enabled IS DISTINCT FROM v_rit_on
       OR t.is_private IS DISTINCT FROM coalesce((v_opts->>'is_private')::boolean, false)
       OR t.is_vip_only IS DISTINCT FROM coalesce((v_opts->>'is_vip_only')::boolean, false)
       OR t.is_anonymous IS DISTINCT FROM coalesce((v_opts->>'is_anonymous')::boolean, false)
       OR t.ban_chat IS DISTINCT FROM coalesce((v_opts->>'ban_chat')::boolean, false)
       OR t.insurance_enabled IS DISTINCT FROM coalesce((v_opts->>'insurance_enabled')::boolean, false)
       OR t.seven_deuce_enabled IS DISTINCT FROM v_sd
       OR t.seven_deuce_amount IS DISTINCT FROM (CASE WHEN v_sd THEN 2 ELSE 0 END)
       OR t.action_time_seconds IS DISTINCT FROM v_action_secs
       OR t.kill_mode IS DISTINCT FROM v_kill_mode
       OR t.kill_threshold_bb IS DISTINCT FROM v_kill_bb
     );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (g.id, 'ruleset_applied',
            jsonb_build_object('tables', v_n, 'vpip_floor', v_vpip, 'vpip_window', v_vpip_window,
                               'ante', v_ante, 'bombs', v_bomb_on, 'bomb_trigger', v_trigger_mode,
                               'rit', v_rit_mode, 'kill', v_kill_mode));
  END IF;
  RETURN v_n;
END;
$function$
;

