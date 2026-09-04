-- ═══════════════════════════════════════════════════════════════════════════════
--  CASH GAMES - OPERATION TABLE STAKES, SLICE 1 (OPORD 1.3 section 7-8 as
--  amended by OPORD 1.4 sections 2.6, 2.7 and 18.1). 2026-09-04.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- A HOST CREATES A GAME, NOT A TABLE.
--   `cash_games` is the cluster: one row per (club, variant, sb, bb,
--   template). Its `ruleset_snapshot` is the template's defaults with the
--   host's overrides resolved at creation, so a live game never mutates when
--   someone later edits the global template (ROE 6). Every `tables` row of a
--   cash game points at it (`cluster_id`, `role`, `main_index`, `lifecycle`).
--
-- WHO CREATES MAIN 1. OPORD 1.4 section 18 gives that to the cluster
--   controller, which ships with Slice 2 at Gate 3. Until then
--   fn_cash_game_create inserts Main 1 itself, in the same transaction as the
--   game row, from the same snapshot - so A1.1 ("one game row and exactly one
--   Main 1, never two, never zero") holds from this migration on, and the
--   controller inherits a table shaped exactly as it would have made it.
--
-- WHAT THE SNAPSHOT DRIVES TODAY. The engine reads `tables` columns, not the
--   snapshot, so the create function projects the snapshot onto the columns
--   the engine already honours: seats, buy-in band, regular ante, the VPIP
--   floor (`nit_game` + `maintain_percent_min` + `maintain_hands`, enforced by
--   fn_nit_evictions), double-board bombs (timed 15:00 for Action, once per
--   orbit for Madness), run-it-N opt-in, rake inherit, straddle off. The
--   stay clock and rejoin window are read from the snapshot by
--   fn_cash_session_open at every buy-in. Slice 4 replaces the VPIP and bomb
--   mechanics with the OPORD's exact ones; the snapshot keys are theirs.
--
-- RULINGS APPLIED (OPORD 1.4 section 1): R1 PLO family 6 locked - for games
--   created here. The global seat law (tableSeating.ts, the tables trigger)
--   changes at the Slice 6 cutover, when every table becomes a game; shrinking
--   live 8-seat PLO tables mid-programme is not a Slice 1 change. R5 variant
--   names are the engine's. ROE 7: stay clock and rejoin window may only be
--   raised. ROE 8: no straddles. ROE 16: an unknown variant is refused, never
--   silently saved as NLHE.
--
-- ONE TRANSACTION.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE GAME
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cash_games (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id             uuid NOT NULL,
  union_id            uuid,
  name                text NOT NULL,
  template_name       text NOT NULL CHECK (template_name IN ('classic', 'action', 'madness')),
  variant             text NOT NULL CHECK (variant IN ('nlh','plo4','plo5','plo6','plo8','flo8','flh','short_deck','pineapple')),
  sb                  numeric(14,2) NOT NULL CHECK (sb > 0),
  bb                  numeric(14,2) NOT NULL CHECK (bb > sb),
  handedness          integer NOT NULL CHECK (handedness BETWEEN 2 AND 9),
  ruleset_snapshot    jsonb NOT NULL,
  enabled             boolean NOT NULL DEFAULT true,
  state               text NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'dormant')),
  cap_mains           integer NOT NULL DEFAULT 8 CHECK (cap_mains BETWEEN 1 AND 32),
  allow_second_feeder boolean NOT NULL DEFAULT false,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One live game per key per club. Template name IS in this key (a club may
-- run Classic 1/2 and Madness 1/2 side by side); it is NOT in the rejoin key
-- (cash_rejoin_constraints), so the floor spans both.
CREATE UNIQUE INDEX IF NOT EXISTS cash_games_one_per_key
  ON public.cash_games (club_id, variant, sb, bb, template_name)
  WHERE enabled;

ALTER TABLE public.cash_games ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cash_games_read ON public.cash_games;
CREATE POLICY cash_games_read ON public.cash_games FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.cash_games FROM anon;
GRANT SELECT ON public.cash_games TO authenticated;
GRANT ALL ON public.cash_games TO service_role;

COMMENT ON TABLE public.cash_games IS
  'Operation Table Stakes: a cash GAME (the cluster). ruleset_snapshot is the resolved template + host overrides at creation; live games never mutate when the template changes.';

-- The table side of the link. Nullable until the Slice 6 cutover, which
-- assigns every live cash table to a game and adds the CHECK.
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS cluster_id uuid REFERENCES public.cash_games(id);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS role text CHECK (role IN ('main', 'feeder'));
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS main_index integer CHECK (main_index >= 1);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS lifecycle text CHECK (lifecycle IN ('opening', 'live', 'breaking', 'closed'));
CREATE INDEX IF NOT EXISTS tables_cluster_id_idx ON public.tables (cluster_id) WHERE cluster_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. TEMPLATE DEFAULTS (OPORD 1.3 section 8). The one source: the client
--    renders what this returns; fn_cash_game_create resolves from it.
-- ─────────────────────────────────────────────────────────────────────────────

-- "1/2", "0.5/1", "0.01/0.02": the `tables.stakes` text the lobby and the
-- fleet already write (HorseOrchestrator writes `${sb}/${bb}`).
CREATE OR REPLACE FUNCTION public.fn_cash_stakes_label(p_sb numeric, p_bb numeric)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT rtrim(rtrim(to_char(p_sb, 'FM999999990.00'), '0'), '.') || '/' ||
         rtrim(rtrim(to_char(p_bb, 'FM999999990.00'), '0'), '.');
$$;
GRANT EXECUTE ON FUNCTION public.fn_cash_stakes_label(numeric, numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_cash_template_defaults(p_template text, p_variant text)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_t text := lower(coalesce(p_template, 'classic'));
  v_v text := lower(coalesce(p_variant, 'nlh'));
  v_family text;
  v_seats integer; v_seats_locked boolean; v_seat_choices integer[];
  v_vpip integer; v_vpip_window integer;
BEGIN
  IF v_t NOT IN ('classic', 'action', 'madness') THEN
    RAISE EXCEPTION 'TEMPLATE_UNKNOWN: %', p_template;
  END IF;

  v_family := CASE
    WHEN v_v IN ('plo4','plo5','plo6','plo8','flo8') THEN 'plo'
    WHEN v_v = 'short_deck' THEN 'shortdeck'
    WHEN v_v = 'pineapple' THEN 'pineapple'
    ELSE 'holdem' END;

  -- seats
  IF v_family = 'plo' THEN
    v_seats := 6; v_seats_locked := true; v_seat_choices := ARRAY[6];
  ELSIF v_family = 'holdem' THEN
    IF v_t = 'classic' THEN v_seats := 9; v_seat_choices := ARRAY[9, 6];
    ELSE v_seats := 6; v_seat_choices := ARRAY[2,3,4,5,6,7,8,9]; END IF;
    v_seats_locked := false;
  ELSE
    v_seats := 6; v_seats_locked := false; v_seat_choices := ARRAY[2,3,4,5,6,7,8];
  END IF;

  -- VPIP floor per template x family (percent); window per section 11.2
  v_vpip := CASE v_t
    WHEN 'classic' THEN 0
    WHEN 'action'  THEN CASE v_family WHEN 'holdem' THEN 30 WHEN 'plo' THEN 40 ELSE 35 END
    ELSE                CASE v_family WHEN 'holdem' THEN 60 WHEN 'plo' THEN 70 ELSE 65 END END;
  v_vpip_window := CASE v_t WHEN 'madness' THEN 30 ELSE 40 END;

  RETURN jsonb_build_object(
    'template', v_t,
    'variant', v_v,
    'family', v_family,
    'seats', v_seats,
    'seats_locked', v_seats_locked,
    'seat_choices', to_jsonb(v_seat_choices),
    'min_buyin_bb', CASE v_t WHEN 'classic' THEN 40 WHEN 'action' THEN 50 ELSE 100 END,
    'max_buyin_bb', 200,
    'regular_ante', CASE v_t WHEN 'classic' THEN 'none' WHEN 'action' THEN 'sb' ELSE 'bb' END,
    'vpip_floor', v_vpip,
    'vpip_window', v_vpip_window,
    'bombs', jsonb_build_object(
      'enabled', v_t <> 'classic',
      'trigger', CASE v_t WHEN 'action' THEN 'timed_15m' WHEN 'madness' THEN 'every_orbit' ELSE NULL END,
      'ante_bb', CASE v_t WHEN 'action' THEN 2 WHEN 'madness' THEN 3 ELSE NULL END,
      'boards', CASE WHEN v_t = 'classic' THEN NULL ELSE 2 END),
    'straddle', false,
    'stay_clock_min', 10,
    'rejoin_window_min', 120,
    'run_it_n_times', 'opt_in',
    'rake', 'existing'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_cash_template_defaults(text, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. CREATE A GAME (and, until the controller exists, its Main 1)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_game_create(
  p_club_id    uuid,
  p_template   text,
  p_variant    text,
  p_sb         numeric,
  p_bb         numeric,
  p_handedness integer DEFAULT NULL,
  p_overrides  jsonb   DEFAULT '{}'::jsonb,
  p_name       text    DEFAULT NULL
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
  v_union uuid;
  v_seats integer; v_choices integer[];
  v_stay integer; v_rejoin integer;
  v_min_bb integer; v_max_bb integer;
  v_ante text; v_vpip integer; v_vpip_window integer;
  v_bombs jsonb; v_bomb_on boolean; v_bomb_trigger text; v_bomb_ante integer; v_bomb_boards integer;
  v_opts jsonb;
  v_name text;
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
  -- The same gate the tables INSERT policy applies.
  IF NOT (public.fn_can_create_games(p_club_id, v_uid) OR public.is_club_admin(p_club_id, v_uid)) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: you cannot create games in this club';
  END IF;

  -- ── what ─────────────────────────────────────────────────────────────────
  IF v_t NOT IN ('classic', 'action', 'madness') THEN
    RAISE EXCEPTION 'TEMPLATE_UNKNOWN: %', p_template;
  END IF;
  -- ROE 16: a variant the engine cannot deal is refused here, never saved as NLHE.
  IF v_v NOT IN ('nlh','plo4','plo5','plo6','plo8','flo8','flh','short_deck','pineapple') THEN
    RAISE EXCEPTION 'VARIANT_UNAVAILABLE: % is not available yet', p_variant;
  END IF;
  IF p_sb IS NULL OR p_bb IS NULL OR p_sb <= 0 OR p_bb <= p_sb THEN
    RAISE EXCEPTION 'STAKES_INVALID: sb=% bb=%', p_sb, p_bb;
  END IF;

  v_def := public.fn_cash_template_defaults(v_t, v_v);

  -- ── seats (section 7 step 5, R1) ────────────────────────────────────────
  SELECT array_agg(x::integer) INTO v_choices FROM jsonb_array_elements_text(v_def->'seat_choices') x;
  IF (v_def->>'seats_locked')::boolean THEN
    v_seats := (v_def->>'seats')::integer;                       -- PLO family: 6, locked
  ELSE
    v_seats := coalesce(p_handedness, (v_def->>'seats')::integer);
    IF NOT (v_seats = ANY (v_choices)) THEN
      RAISE EXCEPTION 'HANDEDNESS_INVALID: % is not offered for % %', v_seats, v_t, v_v;
    END IF;
  END IF;

  -- ── overrides (every field of section 8; two may only be raised) ─────────
  v_min_bb := coalesce((v_o->>'min_buyin_bb')::integer, (v_def->>'min_buyin_bb')::integer);
  v_max_bb := coalesce((v_o->>'max_buyin_bb')::integer, (v_def->>'max_buyin_bb')::integer);
  IF v_min_bb < 1 OR v_max_bb < v_min_bb OR v_max_bb > 1000 THEN
    RAISE EXCEPTION 'BUYIN_BAND_INVALID: % - % bb', v_min_bb, v_max_bb;
  END IF;
  v_ante := coalesce(v_o->>'regular_ante', v_def->>'regular_ante');
  IF v_ante NOT IN ('none', 'sb', 'bb') THEN
    RAISE EXCEPTION 'ANTE_INVALID: %', v_ante;
  END IF;
  v_vpip := coalesce((v_o->>'vpip_floor')::integer, (v_def->>'vpip_floor')::integer);
  IF v_vpip < 0 OR v_vpip > 100 THEN RAISE EXCEPTION 'VPIP_INVALID: %', v_vpip; END IF;
  v_vpip_window := coalesce((v_o->>'vpip_window')::integer, (v_def->>'vpip_window')::integer);
  IF v_vpip_window < 10 OR v_vpip_window > 200 THEN RAISE EXCEPTION 'VPIP_WINDOW_INVALID: %', v_vpip_window; END IF;

  v_bombs := coalesce(v_def->'bombs', '{}'::jsonb) || coalesce(v_o->'bombs', '{}'::jsonb);
  v_bomb_on := coalesce((v_bombs->>'enabled')::boolean, false);
  v_bomb_trigger := v_bombs->>'trigger';
  v_bomb_ante := (v_bombs->>'ante_bb')::integer;
  v_bomb_boards := (v_bombs->>'boards')::integer;
  IF v_bomb_on THEN
    IF v_bomb_trigger IS NULL OR v_bomb_trigger NOT IN ('timed_15m', 'every_orbit') THEN
      RAISE EXCEPTION 'BOMB_TRIGGER_INVALID: %', v_bomb_trigger;
    END IF;
    IF v_bomb_ante IS NULL OR v_bomb_ante < 1 OR v_bomb_ante > 20 THEN
      RAISE EXCEPTION 'BOMB_ANTE_INVALID: %', v_bomb_ante;
    END IF;
    -- Section 15: never a single-board default; the host may choose 2 or 3.
    IF v_bomb_boards IS NULL OR v_bomb_boards < 2 OR v_bomb_boards > 3 THEN
      RAISE EXCEPTION 'BOMB_BOARDS_INVALID: %', v_bomb_boards;
    END IF;
  END IF;

  -- ROE 7: stay clock and rejoin window may only be RAISED.
  v_stay := coalesce((v_o->>'stay_clock_min')::integer, (v_def->>'stay_clock_min')::integer);
  v_rejoin := coalesce((v_o->>'rejoin_window_min')::integer, (v_def->>'rejoin_window_min')::integer);
  IF v_stay < (v_def->>'stay_clock_min')::integer THEN
    RAISE EXCEPTION 'STAY_CLOCK_BELOW_FLOOR: % minutes; the minimum is %', v_stay, v_def->>'stay_clock_min';
  END IF;
  IF v_rejoin < (v_def->>'rejoin_window_min')::integer THEN
    RAISE EXCEPTION 'REJOIN_WINDOW_BELOW_FLOOR: % minutes; the minimum is %', v_rejoin, v_def->>'rejoin_window_min';
  END IF;
  IF v_stay > 1440 OR v_rejoin > 10080 THEN
    RAISE EXCEPTION 'CLOCK_TOO_LONG';
  END IF;

  -- Table options that exist today and are not in section 8. Honoured as-is.
  v_opts := jsonb_build_object(
    'is_private',          coalesce((v_o->'options'->>'is_private')::boolean, false),
    'is_vip_only',         coalesce((v_o->'options'->>'is_vip_only')::boolean, false),
    'is_anonymous',        coalesce((v_o->'options'->>'is_anonymous')::boolean, false),
    'ban_chat',            coalesce((v_o->'options'->>'ban_chat')::boolean, false),
    'insurance_enabled',   coalesce((v_o->'options'->>'insurance_enabled')::boolean, false),
    'seven_deuce_enabled', coalesce((v_o->'options'->>'seven_deuce_enabled')::boolean, false) AND v_v = 'nlh',
    'action_time_seconds', LEAST(120, GREATEST(10, coalesce((v_o->'options'->>'action_time_seconds')::integer, 15)))
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
    'sb', p_sb, 'bb', p_bb,
    'resolved_at', to_jsonb(clock_timestamp())
  );

  -- ── name ─────────────────────────────────────────────────────────────────
  v_variant_label := CASE v_v
    WHEN 'nlh' THEN 'NLH' WHEN 'plo4' THEN 'PLO4' WHEN 'plo5' THEN 'PLO5' WHEN 'plo6' THEN 'PLO6'
    WHEN 'plo8' THEN 'PLO8' WHEN 'flo8' THEN 'FLO8' WHEN 'flh' THEN 'FLH'
    WHEN 'short_deck' THEN 'Short Deck' WHEN 'pineapple' THEN 'Pineapple' END;
  v_name := btrim(coalesce(p_name, ''));
  IF v_name = '' THEN
    v_name := initcap(v_t) || ' ' || v_variant_label || ' ' || public.fn_cash_stakes_label(p_sb, p_bb);
  END IF;
  v_name := left(replace(replace(v_name, '<', ''), '>', ''), 60);

  -- Union scope, the same way fn_game_creation_access stamps it: the club's
  -- own union or the union it belongs to (fn_club_union_context consults both
  -- clubs.union_id and union_clubs, which disagree on live data), and only a
  -- union that really exists. The old page wrote `union_id: access?.unionId`
  -- from that RPC's answer; this is the same answer resolved server-side.
  SELECT u.id INTO v_union
    FROM public.fn_club_union_context(p_club_id) ctx
    JOIN public.unions u ON u.id = COALESCE(ctx.own_union_id, ctx.member_union_id);

  -- ── the game ─────────────────────────────────────────────────────────────
  BEGIN
    INSERT INTO public.cash_games
      (club_id, union_id, name, template_name, variant, sb, bb, handedness, ruleset_snapshot, created_by)
    VALUES
      (p_club_id, v_union, v_name, v_t, v_v, p_sb, p_bb, v_seats, v_snap, v_uid)
    RETURNING id INTO v_game_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'GAME_EXISTS: this club already runs % % %/%', initcap(v_t), v_variant_label, p_sb, p_bb;
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
    p_sb, p_bb, public.fn_cash_stakes_label(p_sb, p_bb),
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
    -- R3 (OPORD 1.4): Main 1 is always on. Until the ClusterController lands
    -- (Slice 6) the two existing keep-alive mechanisms carry that ruling:
    -- auto_extension = true is what HorseFleetManager.retireSurplusTables
    -- honours when a table empties (skipped, not closed), auto_restart = true
    -- is what fn_table_lifecycle_pass reopens if anything closes it anyway.
    -- auto_create_table stays false: feeders are the controller's, and the
    -- lifecycle pass's clone would not carry cluster_id.
    true, true, false,
    'waiting', 0, v_uid,
    v_game_id, 'main', 1, 'live'
  ) RETURNING id INTO v_table_id;

  RETURN jsonb_build_object('ok', true, 'game_id', v_game_id, 'table_id', v_table_id,
                            'name', v_name, 'snapshot', v_snap);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_cash_game_create(uuid, text, text, numeric, numeric, integer, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_create(uuid, text, text, numeric, numeric, integer, jsonb, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE SESSION INHERITS THE GAME'S CLOCKS (ROE 7 lives in the snapshot)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_session_open(p_user_id uuid, p_table_id uuid, p_buy_in numeric)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_t record; v_id uuid; v_stay integer := 600000; v_rejoin integer := 7200000; v_snap jsonb;
BEGIN
  SELECT t.id, t.club_id, t.game_variant, t.small_blind, t.big_blind, t.tournament_id, t.cluster_id
    INTO v_t FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND OR v_t.tournament_id IS NOT NULL THEN RETURN NULL; END IF;

  -- A game's snapshot may RAISE the two clocks (never lower: CHECK floors on
  -- the session row and the create function both refuse it).
  IF v_t.cluster_id IS NOT NULL THEN
    SELECT g.ruleset_snapshot INTO v_snap FROM public.cash_games g WHERE g.id = v_t.cluster_id;
    IF v_snap IS NOT NULL THEN
      v_stay   := GREATEST(600000,  coalesce((v_snap->>'stay_clock_min')::integer, 10) * 60000);
      v_rejoin := GREATEST(7200000, coalesce((v_snap->>'rejoin_window_min')::integer, 120) * 60000);
    END IF;
  END IF;

  IF p_buy_in IS NOT NULL THEN
    UPDATE public.cash_player_session
       SET closed_at = clock_timestamp(), closed_reason = 'stale_on_reopen'
     WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id
       AND closed_at IS NULL;
  END IF;

  INSERT INTO public.cash_player_session
    (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline,
     stay_clock_ms, rejoin_window_ms, stay_remaining_ms, stay_running, stay_last_tick_at, opened_at)
  VALUES
    (p_user_id, v_t.club_id, 'table', p_table_id, p_table_id, v_t.game_variant,
     v_t.small_blind, v_t.big_blind, GREATEST(COALESCE(p_buy_in, 0), 0),
     v_stay, v_rejoin, v_stay, false, clock_timestamp(), clock_timestamp())
  ON CONFLICT (player_id, scope_type, scope_id) WHERE closed_at IS NULL DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.cash_player_session
     WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id
       AND closed_at IS NULL;
  END IF;
  RETURN v_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ASSERTIONS
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_j jsonb; v_src text;
BEGIN
  v_j := public.fn_cash_template_defaults('madness', 'plo5');
  IF (v_j->>'seats')::int <> 6 OR NOT (v_j->>'seats_locked')::boolean OR (v_j->>'min_buyin_bb')::int <> 100
     OR (v_j->'bombs'->>'ante_bb')::int <> 3 OR v_j->'bombs'->>'trigger' <> 'every_orbit' OR (v_j->>'vpip_floor')::int <> 70 THEN
    RAISE EXCEPTION 'ASSERT FAILED: madness/plo5 defaults are not section 8';
  END IF;
  v_j := public.fn_cash_template_defaults('classic', 'nlh');
  IF v_j->'seat_choices' <> '[9, 6]'::jsonb OR (v_j->'bombs'->>'enabled')::boolean THEN
    RAISE EXCEPTION 'ASSERT FAILED: classic/nlh defaults are not section 8';
  END IF;
  v_j := public.fn_cash_template_defaults('action', 'short_deck');
  IF (v_j->>'vpip_floor')::int <> 35 OR v_j->'bombs'->>'trigger' <> 'timed_15m' OR (v_j->>'seats')::int <> 6 THEN
    RAISE EXCEPTION 'ASSERT FAILED: action/short_deck defaults are not section 8';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_cash_session_open';
  IF position('ruleset_snapshot' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: sessions do not inherit the game clocks';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tables' AND column_name='cluster_id') THEN
    RAISE EXCEPTION 'ASSERT FAILED: tables.cluster_id missing';
  END IF;
  RAISE NOTICE 'cash games slice 1: cash_games, template defaults, fn_cash_game_create, session inherits clocks.';
END $$;

COMMIT;
