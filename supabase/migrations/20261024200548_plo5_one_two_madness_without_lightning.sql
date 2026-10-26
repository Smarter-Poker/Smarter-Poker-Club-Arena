-- 20261024200548_plo5_one_two_madness_without_lightning.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- @live-proof: EXISTS (SELECT 1 FROM public.cash_games g JOIN public.tables t ON t.cluster_id=g.id AND t.lifecycle<>'closed' WHERE g.club_id='fade0000-0000-0000-0000-000000000001'::uuid AND g.enabled AND g.variant='plo5' AND g.sb=1 AND g.bb=2 AND g.template_name='classic' AND NOT g.lightning_enabled AND g.ruleset_snapshot->>'rules_profile'='madness_without_lightning' AND (g.ruleset_snapshot->>'vpip_floor')='50' AND g.ruleset_snapshot->>'regular_ante'='bb' AND t.maintain_percent_min=50 AND t.big_blind_ante_enabled AND t.bomb_pot_enabled)
--
-- OWNER (Dan, 2026-10-24): "A 1/2 PLO5 MADNESS GAME WHILE THE BUGS ARE BEING
-- WORKED OUT FOR LIGHTNING GAMES. START IT NOW, 50% VPIP BB ANTE."
--
-- WHY IT CANNOT GO THROUGH fn_cash_game_create:
--   Since 20261023230807 the Madness template IS Lightning Games: the creator
--   forces lightning_enabled=true, always_on pools, a 40% floor, refuses a
--   second enabled Madness game at the stake (GAME_EXISTS), and the floor
--   trigger rewrites every Madness snapshot to 40%. The Lightning PLO5 1/2
--   game (f67a1436-...) is live and stays live for the Lightning work.
--   Classic is ordinary must-move poker - exactly what is wanted while
--   Lightning is being fixed - but its template promise is "no antes, no
--   bombs, no VPIP floor", and the floor trigger enforces that on every write.
--
-- WHAT THIS DOES:
--   1. fn_cash_game_floor_from_template learns ONE named rules profile,
--      'madness_without_lightning', honoured only on a Classic (non-Lightning)
--      game: the four promised fields come from the Madness template, with the
--      owner's 50% floor. Every other game is untouched, byte for byte in
--      behaviour. The profile cannot be supplied by a player or host:
--      fn_cash_game_create builds its snapshot from template defaults and
--      named overrides only, never from a free-form object.
--   2. Opens "PLO5 1/2 Madness" in Midway Union: 6-max, must-move, Lightning
--      off, BB ante, 50% VPIP over 10 hands, two-board bomb pots at 3 BB every
--      10 minutes, 100-200 BB buy-in. Main 1 is opened live through the one
--      cluster writer and projected by fn_cash_apply_ruleset, the same path a
--      created game takes.
--   3. Asserts the projected table carries every promise, and aborts if not.
--
-- REVERSIBLE: switching the game off through fn_cash_game_switch_off retires
-- it exactly like any Classic game. While it is enabled it holds the Midway
-- Classic PLO5 1/2 must-move key (cash_games_one_per_key); the ordinary
-- "PLO5 1/2 Classic" (4a762a3c) is disabled today and stays as it is.
--
-- No wallet, seat, hand or payout writes. No relation locks beyond row inserts.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $floor$
BEGIN
  IF md5(pg_get_functiondef('public.fn_cash_game_floor_from_template()'::regprocedure))
     <> '150ab8e54d84afe212fb4175b1e3ce81' THEN
    RAISE EXCEPTION 'fn_cash_game_floor_from_template changed since this migration was written; requalify';
  END IF;
END $floor$;

CREATE OR REPLACE FUNCTION public.fn_cash_game_floor_from_template()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_def jsonb;
BEGIN
  IF NEW.ruleset_snapshot IS NULL THEN
    RETURN NEW;
  END IF;

  -- THE TEMPLATE IS A PROMISE TO THE PLAYER (2026-09-09). The four fields the
  -- lobby blurb names come from fn_cash_template_defaults on EVERY write, not
  -- only at creation. "No Antes, No Bombs, No VPIP Floor" cannot be true of a
  -- game whose snapshot says otherwise, whoever wrote that snapshot.
  --
  -- `||` and not jsonb_set for `bombs`: the object is replaced WHOLE, so a
  -- stale member inside it (a trigger left over from a template change) cannot
  -- survive underneath a corrected `enabled`.
  v_def := public.fn_cash_template_defaults(NEW.template_name, NEW.variant);

  -- MADNESS WITHOUT LIGHTNING (Dan 2026-10-24). One named profile, honoured
  -- only on an ordinary Classic game that is not Lightning: the Madness
  -- promise (BB ante, two-board bombs every 10 minutes) with the owner's 50%
  -- floor. It is still the template that decides, on every write.
  IF NEW.template_name = 'classic'
     AND NOT coalesce(NEW.lightning_enabled, false)
     AND NEW.variant NOT IN ('pineapple', 'pineapple_holdem')
     AND NEW.ruleset_snapshot->>'rules_profile' = 'madness_without_lightning' THEN
    v_def := public.fn_cash_template_defaults('madness', NEW.variant)
             || jsonb_build_object('vpip_floor', 50);
  END IF;

  NEW.ruleset_snapshot := NEW.ruleset_snapshot
    || jsonb_build_object(
         'vpip_floor',   v_def->'vpip_floor',
         'vpip_window',  v_def->'vpip_window',
         'regular_ante', v_def->'regular_ante',
         'bombs',        v_def->'bombs');

  RETURN NEW;
END;
$function$;

DO $open$
DECLARE
  c_club   constant uuid := 'fade0000-0000-0000-0000-000000000001';
  c_owner  constant uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  v_game   uuid;
  v_table  uuid;
  v_snap   jsonb;
  t        record;
BEGIN
  SELECT id INTO v_game FROM public.cash_games
   WHERE club_id = c_club AND variant = 'plo5' AND sb = 1.00 AND bb = 2.00
     AND template_name = 'classic' AND enabled AND closed_at IS NULL
     AND ruleset_snapshot->>'rules_profile' = 'madness_without_lightning';

  IF v_game IS NULL THEN
    v_snap := public.fn_cash_template_defaults('classic', 'plo5')
      || jsonb_build_object(
           'rules_profile', 'madness_without_lightning',
           'seats', 6,
           'min_buyin_bb', 100,
           'max_buyin_bb', 200,
           'straddle', false,
           'stay_clock_min', 10,
           'rejoin_window_min', 120,
           'run_it_n_times', 'opt_in',
           'rake', 'existing',
           'options', jsonb_build_object(
             'is_private', false, 'is_vip_only', false, 'is_anonymous', false,
             'ban_chat', false, 'insurance_enabled', false,
             'seven_deuce_enabled', false, 'action_time_seconds', 15),
           'table_mode', 'must_move',
           'sb', 1.00, 'bb', 2.00,
           'resolved_at', to_jsonb(clock_timestamp()));

    INSERT INTO public.cash_games
      (club_id, union_id, name, template_name, variant, sb, bb, handedness,
       ruleset_snapshot, created_by, must_move, lightning_enabled)
    VALUES
      (c_club, c_club, 'PLO5 1/2 Madness', 'classic', 'plo5', 1.00, 2.00, 6,
       v_snap, c_owner, true, false)
    RETURNING id INTO v_game;

    v_table := public.fn_cash_cluster_open_table(v_game, 'main', 1, 'live', c_owner);
  END IF;

  PERFORM public.fn_cash_apply_ruleset(v_game);

  -- The promise, read back off what a player will actually sit at.
  SELECT g.ruleset_snapshot AS s, g.lightning_enabled AS le, g.handedness AS h
    INTO t FROM public.cash_games g WHERE g.id = v_game;
  IF (t.s->>'vpip_floor') IS DISTINCT FROM '50' OR (t.s->>'regular_ante') IS DISTINCT FROM 'bb'
     OR (t.s->'bombs'->>'enabled') IS DISTINCT FROM 'true' OR t.le OR t.h <> 6 THEN
    RAISE EXCEPTION 'PLO5 1/2 Madness snapshot did not take the profile: %', t.s;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tables tb
     WHERE tb.cluster_id = v_game AND tb.lifecycle <> 'closed'
       AND tb.maintain_percent_min = 50 AND tb.maintain_hands = 10 AND tb.nit_game
       AND tb.big_blind_ante_enabled AND tb.ante = 2.00
       AND tb.bomb_pot_enabled AND tb.bomb_pot_interval_seconds = 600
       AND tb.bomb_pot_board_count = 2 AND tb.bomb_pot_ante_multiplier = 3
       AND tb.small_blind = 1.00 AND tb.big_blind = 2.00 AND tb.game_variant = 'plo5'
       AND tb.max_players = 6 AND tb.min_buy_in = 200.00 AND tb.max_buy_in = 400.00) THEN
    RAISE EXCEPTION 'PLO5 1/2 Madness table did not project the promise';
  END IF;

  INSERT INTO public.cash_cluster_events (game_id, kind, payload)
  VALUES (v_game, 'game_opened_by_owner_instruction',
          jsonb_build_object('migration', '20261024200548',
                             'rules_profile', 'madness_without_lightning',
                             'owner_words', 'A 1/2 PLO5 MADNESS GAME WHILE THE BUGS ARE BEING WORKED OUT FOR LIGHTNING GAMES. START IT NOW, 50% VPIP BB ANTE.'));
END $open$;

COMMIT;
