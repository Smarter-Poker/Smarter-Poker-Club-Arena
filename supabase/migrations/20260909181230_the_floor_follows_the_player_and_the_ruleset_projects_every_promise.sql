-- 20260909181230_the_floor_follows_the_player_and_the_ruleset_projects_every_promise
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-09 18:12:30 UTC.
-- Lane E of the 2026-09-09 must-move / Classic-Action-Madness audit
-- (docs/audits/2026-09-09-must-move-audit/lane-E.md).
--
-- Two defects on the felt, both read from rows, neither touching a wallet.
--
-- === 1. THE VPIP FLOOR WAS A TABLE RULE IN A GAME THAT MOVES YOU ===========
--
-- Dan 2026-09-04: "IF ANYONE FALLS UNDER THE SET THRESHOLD FOR THE GAME AFTER
-- 10 HANDS, OR ANYTIME AFTER THE 10 HANDS, THEY GET BOOTED."
--
-- fn_nit_check judged the MAINTAIN sample as "facts on THIS table since THIS
-- seat's joined_at". A must-move game moves a player between its tables, and
-- every move opened a fresh chair with a fresh joined_at, so the ten-hand
-- window restarted at zero on every move. Measured over the 24 hours to
-- 2026-09-09 18:00 UTC from cash_cluster_events(seat_moved) joined to
-- ca_hand_facts at the origin table:
--
--     action    1,492 moves    536 (36%) moved before 10 hands   median 15
--     madness     550 moves    387 (70%) moved before 10 hands   median  6
--
-- On Madness the median sitting at one table was SIX hands against a
-- ten-hand window. The floor the card advertises ("High VPIP Floor") could
-- not judge a player the game kept moving; the hero tracker
-- (fn_cash_vpip_status) and the horse brain's board (fn_nit_status) read the
-- same per-table sample, so all three agreed on a number that reset at every
-- move.
--
-- THE RULE NOW: on a cluster table the sample is the player's SITTING IN THE
-- GAME - every fact row on any table of the cluster since cash_game_roster
-- .joined_at (the roster row a move does not close; verified 302/302 seated
-- players on cluster tables hold a live roster row, none joined after their
-- chair). A table outside a cluster keeps the per-table rule unchanged. The
-- three readers change together so what a player is stood up on, what the
-- tracker shows them, and what a horse steers by are one number.
--
-- Measured before applying: 13 seats on floored tables (3 action, 10
-- madness, all horses), 0 evictable under either scope. Nothing is stood up
-- by this apply; the rule simply stops forgetting.
--
-- === 2. THE RULESET PROJECTION LEFT RUN-IT-TWICE (AND THREE SMALL THINGS) ==
--
-- The template snapshot carries run_it_n_times = 'opt_in' and the open path
-- (fn_cash_cluster_open_table) projects it as run_it_mode 'player_choice' +
-- the three RIT booleans true. fn_cash_apply_ruleset - "the one function
-- allowed to map a snapshot onto a cluster" - never projected RIT at all, so
-- the tables adopted at the Gate 7 cutover kept whatever the old form wrote.
-- Read 2026-09-09 18:00 UTC across live cluster tables:
--
--     classic  run_it_mode 'none' + all three booleans false    33 tables (23 seated)
--     classic  run_it_mode 'none' + mixed booleans               9 tables ( 7 seated)
--     classic  player_choice / true / true / true               55 tables
--
-- "NLH 0.50/1 Classic" ran five tables: four offered run-it-twice and one did
-- not. A must-move takes a player from one to the other. Same game, two
-- rulebooks.
--
-- Also fixed in the same function, each a one-line gap in the WHERE:
--   - bomb_pot_min_players was SET to 2 but not compared, so a table at 3
--     was reconciled only when something else moved (4 live rows);
--   - ante_bb likewise;
--   - seven_deuce_enabled had no NLH guard here (the create path has one:
--     "AND v_v = 'nlh'"), so a non-NLH snapshot carrying the option would
--     have been projected. 0 such rows today; the guard is defence in depth.
--
-- The 42 tables are realigned through fn_cash_apply_ruleset itself, and the
-- foot of this file asserts that no live cluster table disagrees with its
-- game on RIT afterwards.
--
-- PROBED ROLLED BACK (11.5) on production 2026-09-09 ~18:20 UTC, one call,
-- pg_temp copies of the four bodies, ending in RAISE:
--   bad_rit before=42 after=0 | applied_rows=42 | second apply=0 rows
--   min_players_bad before=4 after=0 | nit_status rows=13 changed=0
--   evict old=0 new=0 | nit_check ok-disagreements=0 | floorless=nit_game_off

BEGIN;

-- ---------------------------------------------------------------------------
-- 1a. fn_nit_check: the MAINTAIN sample is the sitting in the GAME
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_nit_check(p_table_id uuid, p_user_id uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_on            boolean;
  v_career_min    integer;
  v_maintain_min  integer;
  v_maintain_n    integer;
  v_game          uuid;
  v_since         timestamptz;
  v_career_floor  integer;
  v_career_hands  integer;
  v_career_vpip   numeric;
  v_table_hands   integer;
  v_table_vpip    numeric;
BEGIN
  SELECT COALESCE(t.nit_game, false),
         GREATEST(COALESCE(t.career_percent_min, 0), 0),
         GREATEST(COALESCE(t.maintain_percent_min, 0), 0),
         GREATEST(COALESCE(t.maintain_hands, 10), 1),
         t.cluster_id
    INTO v_on, v_career_min, v_maintain_min, v_maintain_n, v_game
    FROM public.tables t WHERE t.id = p_table_id LIMIT 1;

  -- The toggle is the master switch. With NIT Game off the three numbers do
  -- nothing, which is what a switch labelled "Penalty for tight play" means
  -- and what makes the numbers safe to leave at their defaults.
  IF NOT COALESCE(v_on, false) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'nit_game_off');
  END IF;

  -- CAREER
  IF v_career_min > 0 THEN
    v_career_floor := GREATEST(v_maintain_n * 10, 100);
    SELECT count(*)::int,
           CASE WHEN count(*) = 0 THEN NULL
                ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
      INTO v_career_hands, v_career_vpip
      FROM public.ca_hand_facts f
     WHERE f.user_id = p_user_id;

    IF v_career_hands >= v_career_floor AND v_career_vpip < v_career_min THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'career_vpip',
        'vpip', v_career_vpip, 'required', v_career_min, 'hands', v_career_hands);
    END IF;
  END IF;

  -- MAINTAIN
  -- THE SITTING IN THE GAME, NOT THE CHAIR (2026-09-09, lane E audit). Dan:
  -- "IF ANYONE FALLS UNDER THE SET THRESHOLD FOR THE GAME AFTER 10 HANDS".
  -- A must-move game opens a fresh chair on every move, and judging "this
  -- table since this chair" restarted the window at zero each time - on
  -- Madness the median sitting at one table was six hands against a ten-hand
  -- window, so the floor could never judge a player the game kept moving.
  -- On a cluster table the sample is every fact row on any table of the game
  -- since the roster row's joined_at (a move does not close it; a leave
  -- does, so a player who rebuys after a break still starts a fresh count).
  -- A table outside a cluster keeps the per-table rule.
  IF v_maintain_min > 0 THEN
    v_since := p_since;
    IF v_game IS NOT NULL THEN
      SELECT r.joined_at INTO v_since
        FROM public.cash_game_roster r
       WHERE r.game_id = v_game AND r.user_id = p_user_id AND r.left_at IS NULL
       ORDER BY r.joined_at DESC
       LIMIT 1;
      IF NOT FOUND THEN v_since := p_since; END IF;

      SELECT count(*)::int,
             CASE WHEN count(*) = 0 THEN NULL
                  ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
        INTO v_table_hands, v_table_vpip
        FROM public.ca_hand_facts f
       WHERE f.user_id = p_user_id
         AND (v_since IS NULL OR f.played_at >= v_since)
         AND f.table_id IN (SELECT t2.id FROM public.tables t2 WHERE t2.cluster_id = v_game);
    ELSE
      SELECT count(*)::int,
             CASE WHEN count(*) = 0 THEN NULL
                  ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
        INTO v_table_hands, v_table_vpip
        FROM public.ca_hand_facts f
       WHERE f.table_id = p_table_id
         AND f.user_id = p_user_id
         AND (v_since IS NULL OR f.played_at >= v_since);
    END IF;

    IF v_table_hands >= v_maintain_n AND v_table_vpip < v_maintain_min THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'maintain_vpip',
        'vpip', v_table_vpip, 'required', v_maintain_min, 'hands', v_table_hands);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'reason', 'within_limits');
END;
$function$;

COMMENT ON FUNCTION public.fn_nit_check(uuid, uuid, timestamptz) IS
  'The NIT game VPIP rule. On a cluster table the maintain window is the sitting in the GAME (every table of the cluster since cash_game_roster.joined_at), so a must-move cannot reset it (2026-09-09).';

-- ---------------------------------------------------------------------------
-- 1b. fn_nit_status: the board the horse brain steers by, same scope
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_nit_status(p_table_id uuid)
 RETURNS TABLE(user_id uuid, hands integer, vpip numeric, required integer, window_hands integer, evict boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_on    boolean;
  v_min   integer;
  v_n     integer;
  v_game  uuid;
  v_since timestamptz;
  r       record;
BEGIN
  SELECT COALESCE(t.nit_game, false),
         GREATEST(COALESCE(t.maintain_percent_min, 0), 0),
         GREATEST(COALESCE(t.maintain_hands, 10), 1),
         t.cluster_id
    INTO v_on, v_min, v_n, v_game
    FROM public.tables t WHERE t.id = p_table_id LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  FOR r IN
    SELECT ts.user_id AS uid, ts.joined_at
      FROM public.table_seats ts
     WHERE ts.table_id = p_table_id
       AND ts.left_at IS NULL
  LOOP
    -- Same sample fn_nit_check judges: the sitting in the game on a cluster
    -- table, the chair elsewhere (2026-09-09).
    v_since := r.joined_at;
    IF v_game IS NOT NULL THEN
      SELECT cr.joined_at INTO v_since
        FROM public.cash_game_roster cr
       WHERE cr.game_id = v_game AND cr.user_id = r.uid AND cr.left_at IS NULL
       ORDER BY cr.joined_at DESC
       LIMIT 1;
      IF NOT FOUND THEN v_since := r.joined_at; END IF;

      SELECT count(*)::int,
             CASE WHEN count(*) = 0 THEN NULL
                  ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
        INTO hands, vpip
        FROM public.ca_hand_facts f
       WHERE f.user_id = r.uid
         AND (v_since IS NULL OR f.played_at >= v_since)
         AND f.table_id IN (SELECT t2.id FROM public.tables t2 WHERE t2.cluster_id = v_game);
    ELSE
      SELECT count(*)::int,
             CASE WHEN count(*) = 0 THEN NULL
                  ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
        INTO hands, vpip
        FROM public.ca_hand_facts f
       WHERE f.table_id = p_table_id
         AND f.user_id = r.uid
         AND (v_since IS NULL OR f.played_at >= v_since);
    END IF;
    user_id      := r.uid;
    required     := CASE WHEN v_on THEN v_min ELSE 0 END;
    window_hands := v_n;
    evict        := v_on AND v_min > 0 AND hands >= v_n AND vpip IS NOT NULL AND vpip < v_min;
    RETURN NEXT;
  END LOOP;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 1c. fn_cash_vpip_status: the hero tracker prints the judged number
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_cash_vpip_status(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_on     boolean;
  v_min    integer;
  v_n      integer;
  v_game   uuid;
  v_joined timestamptz;
  v_since  timestamptz;
  v_hands  integer;
  v_vpip   numeric;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  END IF;

  SELECT COALESCE(t.nit_game, false),
         GREATEST(COALESCE(t.maintain_percent_min, 0), 0),
         GREATEST(COALESCE(t.maintain_hands, 10), 1),
         t.cluster_id
    INTO v_on, v_min, v_n, v_game
    FROM public.tables t WHERE t.id = p_table_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  SELECT ts.joined_at INTO v_joined
    FROM public.table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
   ORDER BY ts.joined_at DESC NULLS LAST
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'seated', false,
      'nit_game', v_on, 'required', CASE WHEN v_on THEN v_min ELSE 0 END, 'window', v_n);
  END IF;

  -- The number the rule judges (fn_nit_check): the sitting in the GAME on a
  -- cluster table, the chair elsewhere (2026-09-09).
  v_since := v_joined;
  IF v_game IS NOT NULL THEN
    SELECT r.joined_at INTO v_since
      FROM public.cash_game_roster r
     WHERE r.game_id = v_game AND r.user_id = v_uid AND r.left_at IS NULL
     ORDER BY r.joined_at DESC
     LIMIT 1;
    IF NOT FOUND THEN v_since := v_joined; END IF;

    SELECT count(*)::int,
           CASE WHEN count(*) = 0 THEN NULL
                ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
      INTO v_hands, v_vpip
      FROM public.ca_hand_facts f
     WHERE f.user_id = v_uid
       AND (v_since IS NULL OR f.played_at >= v_since)
       AND f.table_id IN (SELECT t2.id FROM public.tables t2 WHERE t2.cluster_id = v_game);
  ELSE
    SELECT count(*)::int,
           CASE WHEN count(*) = 0 THEN NULL
                ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
      INTO v_hands, v_vpip
      FROM public.ca_hand_facts f
     WHERE f.table_id = p_table_id
       AND f.user_id = v_uid
       AND (v_since IS NULL OR f.played_at >= v_since);
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'seated', true,
    'nit_game', v_on,
    'required', CASE WHEN v_on THEN v_min ELSE 0 END,
    'window', v_n,
    'hands', v_hands,
    'vpip', v_vpip,
    'since', v_since);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. fn_cash_apply_ruleset: project run-it-N-times, guard 7-2, compare all
-- ---------------------------------------------------------------------------
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
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  s := g.ruleset_snapshot;
  IF s IS NULL THEN RETURN 0; END IF;

  -- The same mapping fn_cash_cluster_open_table applies at open. Kept in
  -- one place by construction: the opener's INSERT and this UPDATE must read
  -- the snapshot identically or a fresh table and a reconciled one disagree.
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
  v_trigger_mode := CASE WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 'timed'
                         WHEN v_bomb_on AND v_bomb_trigger = 'every_orbit' THEN 'once_per_orbit'
                         ELSE 'every_n_hands' END;
  v_interval := CASE WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 900 ELSE NULL END;
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
     );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (g.id, 'ruleset_applied',
            jsonb_build_object('tables', v_n, 'vpip_floor', v_vpip, 'vpip_window', v_vpip_window,
                               'ante', v_ante, 'bombs', v_bomb_on, 'bomb_trigger', v_trigger_mode,
                               'rit', v_rit_mode));
  END IF;
  RETURN v_n;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. LET THE TABLES FOLLOW, THROUGH THE PLATFORM'S OWN PATH
-- ---------------------------------------------------------------------------
SELECT sum(public.fn_cash_apply_ruleset(id)) FROM public.cash_games WHERE enabled;

-- ---------------------------------------------------------------------------
-- 4. ASSERT, AND ABORT IF THE BOARD MOVED
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  v_bad_rit int;
  v_bad_sd int;
  v_bad_min int;
  v_probe jsonb;
BEGIN
  SELECT count(*) INTO v_bad_rit
    FROM public.tables t JOIN public.cash_games g ON g.id = t.cluster_id
   WHERE t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false AND g.enabled
     AND (t.run_it_mode IS DISTINCT FROM 'player_choice'
          OR t.run_it_twice IS DISTINCT FROM true
          OR t.allow_run_it_twice IS DISTINCT FROM true
          OR t.run_it_twice_enabled IS DISTINCT FROM true);
  IF v_bad_rit <> 0 THEN
    RAISE EXCEPTION 'ABORT: % live cluster tables still disagree with their game on run-it-N-times', v_bad_rit;
  END IF;

  SELECT count(*) INTO v_bad_sd
    FROM public.tables t JOIN public.cash_games g ON g.id = t.cluster_id
   WHERE t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false
     AND g.variant <> 'nlh' AND coalesce(t.seven_deuce_enabled, false);
  IF v_bad_sd <> 0 THEN
    RAISE EXCEPTION 'ABORT: % non-NLH cluster tables carry a seven-deuce bounty', v_bad_sd;
  END IF;

  SELECT count(*) INTO v_bad_min
    FROM public.tables t JOIN public.cash_games g ON g.id = t.cluster_id
   WHERE t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false AND g.enabled
     AND t.bomb_pot_min_players IS DISTINCT FROM 2;
  IF v_bad_min <> 0 THEN
    RAISE EXCEPTION 'ABORT: % live cluster tables still carry a bomb_pot_min_players other than 2', v_bad_min;
  END IF;

  -- The rule still answers, and still says off on a table with no floor.
  SELECT public.fn_nit_check(t.id, '00000000-0000-0000-0000-000000000000'::uuid, NULL) INTO v_probe
    FROM public.tables t WHERE t.cluster_id IS NOT NULL AND coalesce(t.nit_game, false) = false LIMIT 1;
  IF v_probe IS NOT NULL AND v_probe->>'reason' IS DISTINCT FROM 'nit_game_off' THEN
    RAISE EXCEPTION 'ABORT: fn_nit_check on a floorless table answered %', v_probe;
  END IF;
END;
$assert$;

COMMIT;
