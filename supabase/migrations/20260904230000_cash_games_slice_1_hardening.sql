-- ═══════════════════════════════════════════════════════════════════════════
--  CASH GAMES, SLICE 1 HARDENING + RULING R9 (Operation Table Stakes,
--  2026-09-04). Follows 20260904160500_cash_games_slice_1.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Findings from the post-slice audit (docs/changelog/2026-09-04-cash-games-
-- slice-1-hardening.md), each fixed here:
--
--   H1  A Slice 1 game was IMMORTAL. Main 1 carries auto_restart = true (R3)
--       and fn_table_lifecycle_pass reopens every closed table carrying it,
--       so a host who closed the game got it back within a fleet cycle, and
--       cash_games.enabled had no writer, so GAME_EXISTS refused the key
--       forever. Now: closing Main 1 through fn_close_managed_game disables
--       the game (enabled = false, closed_at, closed_by), the restart loop
--       skips a table whose game is disabled, and the unique key frees up.
--   H2  Fixed-limit games were named and labelled by BLINDS ("FLH 1/2")
--       while the picker, the lobby and the old create path all speak in BET
--       SIZES ("FLH 2/4"). fn_cash_stakes_label takes the variant now and
--       both the name and tables.stakes come from it.
--   H3  Numeric edge cases: 'NaN' passed every check; sub-cent blinds
--       reached the CHECK as a raw check_violation; a nine-figure blind
--       printed '###'. STAKES_INVALID covers all three now.
--   H4  A malformed override ("40.5", "abc", bombs as an array) surfaced a
--       raw cast error or silently switched bombs off. OVERRIDE_INVALID:<key>
--       now, and bombs must be an object.
--   H5  cash_games was readable by every signed-in user on the platform,
--       private games included. Read is now members of the club, or anyone
--       for a game that is not private.
--   H6  Default names started with the template word, which the lobby's
--       title stripper does not know, so every card read "NLH 1/2" over
--       "Classic NLH 1/2". Names are "NLH 1/2 Classic" now; the stripper
--       leaves "Classic" as the subtitle.
--   H7  Trailing zeros: the picker prints 0.05/0.10, the label printed
--       0.05/0.1. Two decimals whenever the figure is not whole.
--
-- RULING R9 (Dan 2026-09-04): "after you select which game type you want to
-- create for the table, you should then have to check off, manually create
-- individual tables, or use automated must move games." A game therefore
-- has a TABLE MODE. must_move = true is the cluster of OPORD 1.4 (Main 1
-- always on, feeders open and close themselves). must_move = false is a
-- single table the host runs by hand: it closes when it empties like any
-- host table, it may be created as many times as the host likes at the same
-- key, and it never grows. Both go through this one function; the browser
-- still writes nothing.
--
-- One transaction: PostgREST reloads once.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. cash_games: table mode, closure, read scope
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.cash_games
  ADD COLUMN IF NOT EXISTS must_move  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS closed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS closed_by  uuid;

COMMENT ON COLUMN public.cash_games.must_move IS
  'R9: true = automated must-move cluster (OPORD 1.4); false = one table the host runs by hand.';

-- The one-per-key rule is for must-move games only: a host may run any number
-- of hand-made tables at the same stakes (that is what "individual" means).
DROP INDEX IF EXISTS public.cash_games_one_per_key;
CREATE UNIQUE INDEX cash_games_one_per_key
  ON public.cash_games (club_id, variant, sb, bb, template_name)
  WHERE enabled AND must_move;

DROP POLICY IF EXISTS cash_games_read ON public.cash_games;
CREATE POLICY cash_games_read ON public.cash_games FOR SELECT TO authenticated
  USING (
    NOT coalesce((ruleset_snapshot->'options'->>'is_private')::boolean, false)
    OR EXISTS (SELECT 1 FROM public.club_members cm
                WHERE cm.club_id = cash_games.club_id AND cm.user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The stakes label speaks the variant's language (H2, H7)
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.fn_cash_stakes_label(numeric, numeric);

CREATE OR REPLACE FUNCTION public.fn_cash_money_text(p numeric)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE WHEN p = trunc(p) THEN trunc(p)::bigint::text
              ELSE to_char(p, 'FM999999990.00') END;
$$;
GRANT EXECUTE ON FUNCTION public.fn_cash_money_text(numeric) TO authenticated, service_role;

-- Blinds for no-limit and pot-limit; bet sizes (bb / 2bb) for fixed limit,
-- which is how src/lib/bettingStructure.stakesLabel and the old create path
-- have always written it.
CREATE OR REPLACE FUNCTION public.fn_cash_stakes_label(p_sb numeric, p_bb numeric, p_variant text DEFAULT 'nlh')
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE WHEN lower(coalesce(p_variant, 'nlh')) IN ('flh', 'flo8')
              THEN public.fn_cash_money_text(p_bb) || '/' || public.fn_cash_money_text(p_bb * 2)
              ELSE public.fn_cash_money_text(p_sb) || '/' || public.fn_cash_money_text(p_bb) END;
$$;
GRANT EXECUTE ON FUNCTION public.fn_cash_stakes_label(numeric, numeric, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Override parsing that says which key was wrong (H4)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_override_int(p_o jsonb, p_key text, p_default integer)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v text := p_o->>p_key;
BEGIN
  IF v IS NULL THEN RETURN p_default; END IF;
  IF v !~ '^-?[0-9]{1,9}$' THEN
    RAISE EXCEPTION 'OVERRIDE_INVALID: % must be a whole number, got %', p_key, v;
  END IF;
  RETURN v::integer;
END;
$$;
GRANT EXECUTE ON FUNCTION public.fn_cash_override_int(jsonb, text, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_cash_override_bool(p_o jsonb, p_key text, p_default boolean)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v text := p_o->>p_key;
BEGIN
  IF v IS NULL THEN RETURN p_default; END IF;
  IF lower(v) IN ('true', 't', '1') THEN RETURN true; END IF;
  IF lower(v) IN ('false', 'f', '0') THEN RETURN false; END IF;
  RAISE EXCEPTION 'OVERRIDE_INVALID: % must be true or false, got %', p_key, v;
END;
$$;
GRANT EXECUTE ON FUNCTION public.fn_cash_override_bool(jsonb, text, boolean) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. fn_cash_game_create with a table mode (R9) and the hardening (H2-H4, H6)
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.fn_cash_game_create(uuid, text, text, numeric, numeric, integer, jsonb, text);

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
  v_ante_chips numeric;
  v_variant_label text;
BEGIN
  -- ── who ──────────────────────────────────────────────────────────────────
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

  -- ── what ─────────────────────────────────────────────────────────────────
  IF v_t NOT IN ('classic', 'action', 'madness') THEN
    RAISE EXCEPTION 'TEMPLATE_UNKNOWN: %', p_template;
  END IF;
  IF v_v NOT IN ('nlh','plo4','plo5','plo6','plo8','flo8','flh','short_deck','pineapple') THEN
    RAISE EXCEPTION 'VARIANT_UNAVAILABLE: % is not available yet', p_variant;
  END IF;
  -- H3: NaN compares false against everything, so it is named outright; the
  -- columns are numeric(14,2), so anything finer than a cent is refused
  -- rather than rounded into a CHECK violation; and the label has ten digits.
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

  -- ── seats (section 7 step 5, R1) ────────────────────────────────────────
  SELECT array_agg(x::integer) INTO v_choices FROM jsonb_array_elements_text(v_def->'seat_choices') x;
  IF (v_def->>'seats_locked')::boolean THEN
    v_seats := (v_def->>'seats')::integer;
  ELSE
    v_seats := coalesce(p_handedness, (v_def->>'seats')::integer);
    IF NOT (v_seats = ANY (v_choices)) THEN
      RAISE EXCEPTION 'HANDEDNESS_INVALID: % is not offered for % %', v_seats, v_t, v_v;
    END IF;
  END IF;

  -- ── overrides (every field of section 8; two may only be raised) ─────────
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

  -- ROE 7: stay clock and rejoin window may only be RAISED.
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

  -- ── name (H2, H6) ────────────────────────────────────────────────────────
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

  -- Union scope, the same way fn_game_creation_access stamps it.
  SELECT u.id INTO v_union
    FROM public.fn_club_union_context(p_club_id) ctx
    JOIN public.unions u ON u.id = COALESCE(ctx.own_union_id, ctx.member_union_id);

  -- ── the game ─────────────────────────────────────────────────────────────
  BEGIN
    INSERT INTO public.cash_games
      (club_id, union_id, name, template_name, variant, sb, bb, handedness, ruleset_snapshot, created_by, must_move)
    VALUES
      (p_club_id, v_union, v_name, v_t, v_v, p_sb, p_bb, v_seats, v_snap, v_uid, v_must_move)
    RETURNING id INTO v_game_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'GAME_EXISTS: this club already runs % % %', initcap(v_t), v_variant_label, v_label;
  END;

  -- ── Main 1, from the snapshot (the controller takes this over at Gate 3) ──
  v_ante_chips := CASE v_ante WHEN 'sb' THEN p_sb WHEN 'bb' THEN p_bb ELSE 0 END;

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
    cluster_id, role, main_index, lifecycle
  ) VALUES (
    p_club_id, v_union, v_name, 'cash', v_v, 'regular',
    p_sb, p_bb, v_label,
    v_seats, round(p_bb * v_min_bb, 2), round(p_bb * v_max_bb, 2),
    v_ante_chips > 0, v_ante_chips, CASE WHEN v_ante_chips > 0 THEN round(v_ante_chips / p_bb, 4) ELSE 0 END,
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
    (v_opts->>'is_private')::boolean, (v_opts->>'is_vip_only')::boolean, (v_opts->>'is_anonymous')::boolean,
    (v_opts->>'ban_chat')::boolean, (v_opts->>'insurance_enabled')::boolean,
    (v_opts->>'seven_deuce_enabled')::boolean, CASE WHEN (v_opts->>'seven_deuce_enabled')::boolean THEN 2 ELSE 0 END,
    (v_opts->>'action_time_seconds')::integer, 2,
    -- R3 for a must-move game: Main 1 is always on (auto_extension keeps it
    -- open when it empties, auto_restart reopens it) until the controller owns
    -- the lifecycle at Slice 6. R9 for a hand-made table: it lives and dies
    -- like any host table. auto_create_table is never set: the lifecycle
    -- pass's clone would not carry cluster_id.
    v_must_move, v_must_move, false,
    'waiting', 0, v_uid,
    v_game_id, 'main', 1, 'live'
  ) RETURNING id INTO v_table_id;

  RETURN jsonb_build_object('ok', true, 'game_id', v_game_id, 'table_id', v_table_id,
                            'name', v_name, 'must_move', v_must_move, 'snapshot', v_snap);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_cash_game_create(uuid, text, text, numeric, numeric, integer, jsonb, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_create(uuid, text, text, numeric, numeric, integer, jsonb, text, boolean) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Closing Main 1 closes the GAME (H1)
-- ─────────────────────────────────────────────────────────────────────────────
-- Body as deployed (fn_close_managed_game, read from production 2026-09-04)
-- plus the cluster clause in the 'table' branch. The door is
-- fn_execute_managed_game_command (kinds 'table' | 'tournament'); a whole-game
-- close arrives with the controller at Slice 6.

CREATE OR REPLACE FUNCTION public.fn_close_managed_game(p_kind text, p_game_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid:=auth.uid(); v_club uuid; v_status text; v_cluster uuid; v_role text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF p_kind='table' THEN
    SELECT club_id,status,cluster_id,role INTO v_club,v_status,v_cluster,v_role FROM public.tables WHERE id=p_game_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','game_not_found'); END IF;
    IF NOT public.fn_can_create_games(v_club,v_uid) THEN RETURN jsonb_build_object('ok',false,'reason','not_authorized'); END IF;
    IF lower(COALESCE(v_status,'')) IN ('closed','completed','cancelled','finished') THEN
      RETURN jsonb_build_object('ok',false,'reason','already_closed');
    END IF;
    -- Operators never force-cash-out a player. The player/engine owns the
    -- canonical seat-exit transaction; management can close only an empty felt.
    PERFORM 1 FROM public.table_seats ts
      WHERE ts.table_id=p_game_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
      FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok',false,'reason','players_seated');
    END IF;
    UPDATE public.tables SET status='closed',current_players=0,updated_at=now() WHERE id=p_game_id;
    -- H1: Main 1 IS the game. Closing it on purpose disables the game, so the
    -- lifecycle pass does not reopen it and the key is free to be created
    -- again. A feeder closing is the cluster's own business.
    IF v_cluster IS NOT NULL AND v_role = 'main' THEN
      UPDATE public.cash_games
         SET enabled=false, state='dormant', closed_at=now(), closed_by=v_uid, updated_at=now()
       WHERE id=v_cluster AND enabled;
    END IF;
    RETURN jsonb_build_object('ok',true);
  ELSIF p_kind='tournament' THEN
    SELECT club_id,status INTO v_club,v_status FROM public.tournaments WHERE id=p_game_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','game_not_found'); END IF;
    IF NOT public.fn_can_create_games(v_club,v_uid) THEN RETURN jsonb_build_object('ok',false,'reason','not_authorized'); END IF;
    IF upper(COALESCE(v_status,'')) IN ('COMPLETED','CANCELLED','CANCELED','COMPLETING') THEN RETURN jsonb_build_object('ok',false,'reason','already_closed'); END IF;
    PERFORM 1 FROM public.tournament_players tp
      WHERE tp.tournament_id=p_game_id AND tp.user_id IS NOT NULL
      FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok',false,'reason','players_registered');
    END IF;
    UPDATE public.tournaments SET status='CANCELLED',ended_at=now(),updated_at=now() WHERE id=p_game_id;
    UPDATE public.tables SET status='closed',current_players=0 WHERE tournament_id=p_game_id;
    RETURN jsonb_build_object('ok',true);
  END IF;
  RETURN jsonb_build_object('ok',false,'reason','invalid_game_kind');
END $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. The lifecycle pass leaves a disabled game closed (H1)
-- ─────────────────────────────────────────────────────────────────────────────
-- Body as deployed (read from production 2026-09-04) plus one NOT EXISTS in
-- the restart loop.

CREATE OR REPLACE FUNCTION public.fn_table_lifecycle_pass()
 RETURNS TABLE(action text, table_id uuid, table_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r      record;
  v_new  uuid;
  v_n    integer;
  v_name text;
BEGIN
  -- ── AUTO RESTART: reopen a closed table whose host asked for it ──────────
  -- Never a tournament table (those close on purpose, at the end of a game),
  -- never a deleted one, never a template, and never (H1, 2026-09-04) the
  -- Main 1 of a cash game its host has closed.
  FOR r IN
    SELECT t.id, t.name FROM public.tables t
     WHERE COALESCE(t.auto_restart, false)
       AND t.status = 'closed'
       AND t.tournament_id IS NULL
       AND COALESCE(t.is_deleted, false) = false
       AND COALESCE(t.is_template, false) = false
       AND NOT EXISTS (SELECT 1 FROM public.cash_games g
                        WHERE g.id = t.cluster_id AND NOT g.enabled)
     LIMIT 50
  LOOP
    UPDATE public.tables
       SET status = 'waiting', current_players = 0, updated_at = now()
     WHERE id = r.id AND status = 'closed';
    action := 'restarted'; table_id := r.id; table_name := r.name; RETURN NEXT;
  END LOOP;

  -- ── AUTO CREATE TABLE: a sibling when this one is within a seat of full ──
  -- Capped at 3 in a family, the same ceiling spawnOverflowTables uses, so a
  -- busy night cannot fill the lobby with clones. The name is suffixed rather
  -- than duplicated, so the family is recognisable on the board.
  FOR r IN
    SELECT t.id, t.name, t.club_id, t.max_players,
           (SELECT count(*) FROM public.table_seats s
             WHERE s.table_id = t.id AND s.left_at IS NULL) AS taken
      FROM public.tables t
     WHERE COALESCE(t.auto_create_table, false)
       AND t.tournament_id IS NULL
       AND COALESCE(t.is_deleted, false) = false
       AND COALESCE(t.is_template, false) = false
       AND t.status IN ('active', 'waiting', 'running')
       AND COALESCE(t.max_players, 0) > 0
     LIMIT 50
  LOOP
    CONTINUE WHEN r.taken < GREATEST(r.max_players - 1, 1);

    -- The family is this table and anything already spawned from it.
    SELECT count(*)::int INTO v_n FROM public.tables f
     WHERE f.club_id = r.club_id
       AND COALESCE(f.is_deleted, false) = false
       AND f.status IN ('active', 'waiting', 'running')
       AND (f.name = split_part(r.name, ' #', 1)
            OR f.name LIKE split_part(r.name, ' #', 1) || ' #%');
    CONTINUE WHEN v_n >= 3;

    -- Only spawn when EVERY table in the family is near full. One quiet
    -- sibling means the demand is already served.
    IF EXISTS (
      SELECT 1 FROM public.tables f
       WHERE f.club_id = r.club_id
         AND COALESCE(f.is_deleted, false) = false
         AND f.status IN ('active', 'waiting', 'running')
         AND (f.name = split_part(r.name, ' #', 1)
              OR f.name LIKE split_part(r.name, ' #', 1) || ' #%')
         AND (SELECT count(*) FROM public.table_seats s
               WHERE s.table_id = f.id AND s.left_at IS NULL)
             < GREATEST(COALESCE(f.max_players, 0) - 1, 1)
    ) THEN
      CONTINUE;
    END IF;

    v_name := split_part(r.name, ' #', 1) || ' #' || (v_n + 1)::text;
    BEGIN
      v_new := public.fn_clone_table_row(r.id, v_name);
      UPDATE public.tables SET status = 'waiting' WHERE id = v_new;
      action := 'created'; table_id := v_new; table_name := v_name; RETURN NEXT;
    EXCEPTION WHEN unique_violation THEN
      -- Two cycles racing for the same name is expected and harmless.
      NULL;
    END;
  END LOOP;
END;
$function$;

-- Fleet-only, exactly as it already is in production: CREATE OR REPLACE keeps
-- the ACL, but check-definer-authorization reads the FILE, so say it again.
REVOKE ALL ON FUNCTION public.fn_table_lifecycle_pass() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_table_lifecycle_pass() TO service_role;

-- Management-only: reached through fn_execute_managed_game_command, which is
-- the authenticated door and does its own fn_can_create_games check.
REVOKE ALL ON FUNCTION public.fn_close_managed_game(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_close_managed_game(text, uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Assertions
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_src text;
BEGIN
  IF public.fn_cash_stakes_label(1, 2, 'flh') <> '2/4' THEN
    RAISE EXCEPTION 'ASSERT FAILED: limit label is not bet sizes';
  END IF;
  IF public.fn_cash_stakes_label(0.05, 0.10, 'nlh') <> '0.05/0.10' THEN
    RAISE EXCEPTION 'ASSERT FAILED: two decimals when not whole';
  END IF;
  IF public.fn_cash_stakes_label(1, 2, 'plo4') <> '1/2' THEN
    RAISE EXCEPTION 'ASSERT FAILED: whole blinds print whole';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cash_games' AND column_name='must_move') THEN
    RAISE EXCEPTION 'ASSERT FAILED: cash_games.must_move missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname='public' AND p.proname='fn_cash_game_create' AND p.pronargs <> 9) THEN
    RAISE EXCEPTION 'ASSERT FAILED: the old fn_cash_game_create signature survived';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_table_lifecycle_pass';
  IF position('NOT g.enabled' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: the lifecycle pass still reopens a closed game';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_close_managed_game';
  IF position('closed_by=v_uid' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: closing Main 1 does not close the game';
  END IF;
  RAISE NOTICE 'cash games slice 1 hardening: table mode, closure, labels, override errors, read scope.';
END $$;

COMMIT;
