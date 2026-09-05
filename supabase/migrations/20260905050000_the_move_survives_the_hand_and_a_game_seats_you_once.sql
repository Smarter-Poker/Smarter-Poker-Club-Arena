-- ═══════════════════════════════════════════════════════════════════════════════
-- THE MOVE SURVIVES THE HAND, AND A GAME SEATS YOU ONCE
-- (Operation Table Stakes, deep-dive after the first live cycle; 2026-09-05)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Read from production at 00:45 UTC, NLH 0.10/0.25 Madness: Main 1 with ONE
-- player, the opening feeder with ONE player (a horse), and seventeen
-- `must_move` rows for that horse in `cash_seat_moves`, one a minute since
-- 00:28, every one `expired`. Two players in one game, each alone at a table,
-- neither able to play. The engine half of that (the wait-for-players loop
-- never executes a move) ships beside this file; the SQL half is here, with
-- six more defects the same read turned up.
--
-- 1. A MOVE LIVED SIXTY SECONDS; A HAND OFTEN LASTS LONGER. The engine tells
--    the player at the START of a hand ("Moving After This Hand") and moves
--    them at its END. Planned mid-hand, a move had to survive the rest of that
--    hand plus one whole hand - routinely more than a minute - so it expired
--    unexecuted, the tick planned it again, the player was told again, and
--    again. Now a move lives three minutes by default and the engine, when it
--    ANNOUNCES one, stamps `announced_at` and extends it to cover the hand
--    (`fn_cash_seat_move_announce`). `fn_cash_seat_moves_pending` returns
--    `announced_at`, so the engine can execute at settlement exactly the moves
--    it promised at the deal, and nothing it did not.
--
-- 2. A BUSTED PLAYER WAS MOVED WITH NOTHING. The planner never looked at the
--    stack; the executor moved `coalesce(stack, 0)`. A human in their five-
--    second rebuy window was carried to another chair with 0 while the modal
--    was still on their screen. The planner now skips an empty stack and a
--    `leave_pending` seat (a player who is leaving is not moved), and the
--    executor cancels (`busted`) rather than move zero.
--
-- 3. THE MOVE CARRIED THE WRONG ENTRY STATE. `entry_hold` was cleared and
--    `entry_post_agreed` travelled from the old table, so a restart between
--    the move and the destination's next deal made the mover a veteran (or
--    auto-posted them). A mover is ENTERING a table (Dan 2026-08-26: "wait
--    for the BB or post") and now starts with `entry_hold = 'waiting'`,
--    `entry_post_agreed = false`. A new chair is dealt in (the house trigger
--    `trg_new_seat_clear_sitout` does that on an insert; the executor writes
--    the same on a revived chair, so both paths agree); `is_away` - connection
--    state - travels.
--
-- 4. THE MOVE EXEMPTION WAS A SECOND-SEAT DOOR. 20260905041000 exempted any
--    seat insert by a player who already holds a live seat in the same
--    cluster from the four-table cap. That is the move - and also a second
--    buy-in into the same game, which nothing else refused. The executor now
--    declares itself (`set_config('app.cash_seat_move', 'on', true)`); the cap
--    exempts THAT, and the cluster door refuses a second live seat in one game
--    to anybody else (`ALREADY_IN_GAME`). The planner never plans a player
--    onto a table they are already sitting at. Found live at 01:35 UTC: one
--    horse (charles leclercq) with a chair on Main 1 AND a chair on the
--    breaking feeder of the same game, seated at both by the fleet. A second
--    chair on a breaking table has nowhere to go, so the tick sends it home
--    through the table-close cash-out (`second_chair_cashed_out`) - the stack
--    returns to the wallet, the other chair is untouched.
--
-- 5. AN OPENING FEEDER THAT NOBODY CAME TO NEVER CLOSED. BREAK wants `live`,
--    PROMOTE wants two seated, and `enabled = false` is the only thing that
--    closed an empty table. An `opening` feeder with nobody on it for three
--    minutes closes (`feeder_abandoned`), the live feeder's `promote_pending`
--    is withdrawn, and OPEN waits two minutes after an abandonment before
--    trying again.
--
-- 6. MADNESS ANTED A BIG BLIND FROM EVERY SEAT. "Big Blind Ante" (the
--    template's own words, `src/config/cashGames.ts`) is the format where the
--    big blind posts one ante for the table. `fn_cash_cluster_open_table`
--    wrote `ante = bb` and never `big_blind_ante_enabled`, so the engine
--    (`ante_mode: 'per_player'`) took a full big blind from every seat every
--    hand - on a 6-max, a six-blind pot before a card. All 28 live Madness
--    tables were in that state. The writer sets the flag for `regular_ante =
--    'bb'`; the 28 are backfilled (running engines read the row at their
--    next boot, the :55 restart at the latest).
--
-- 7. PRE-SLICE-2 MAIN 1s STILL CARRIED THE LIFECYCLE-PASS FLAGS.
--    `auto_restart` on a cluster table lets `fn_table_lifecycle_pass` reopen a
--    closed Main 1 as `status = 'waiting'` with `lifecycle = 'closed'` while
--    the tick opens a fresh one: two Main 1s, one a zombie. Backfilled off,
--    with the Stable Hand flags the old executor used to re-apply.
--
-- `fn_enforce_four_table_limit` is redefined here, so this file carries the
-- trigger, the index it depends on and the rollback that
-- `server/src/services/FourTableLimit.test.ts` reads from the LATEST definer.
--
-- ROLLBACK (Tier 2, hot tables):
--   DROP TRIGGER IF EXISTS trg_enforce_booking_game_cap ON public.tournament_players;
--   -- (then re-apply 20260905041000 for the previous bodies of
--   --  fn_enforce_four_table_limit, fn_refuse_seat_on_closed_cluster_table,
--   --  fn_cash_cluster_tick; 20260905042000 for fn_cash_seat_move_execute;
--   --  20260905010500 for fn_cash_cluster_open_table / fn_cash_seat_moves_pending)
--   ALTER TABLE public.cash_seat_moves ALTER COLUMN expires_at SET DEFAULT now() + interval '1 minute';
--   ALTER TABLE public.cash_seat_moves DROP COLUMN announced_at;
--   DROP FUNCTION IF EXISTS public.fn_cash_seat_move_announce(uuid[]);

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A move lives three minutes, and remembers when it was announced
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.cash_seat_moves
  ADD COLUMN IF NOT EXISTS announced_at timestamptz;
ALTER TABLE public.cash_seat_moves
  ALTER COLUMN expires_at SET DEFAULT now() + interval '3 minutes';

COMMENT ON COLUMN public.cash_seat_moves.announced_at IS
  'When the from-table engine told the player (deal start). Settlement executes announced moves only; an idle table executes any.';

CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_announce(p_move_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n integer;
BEGIN
  -- The engine has just promised "Moving After This Hand". The promise has
  -- to outlive the hand: five minutes covers any hand the engine's own
  -- watchdog would let run.
  UPDATE public.cash_seat_moves
     SET announced_at = coalesce(announced_at, clock_timestamp()),
         expires_at   = GREATEST(expires_at, clock_timestamp() + interval '5 minutes')
   WHERE id = ANY(p_move_ids) AND state = 'pending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_cash_seat_move_announce(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_move_announce(uuid[]) TO service_role;

-- The return type gains a column, which CREATE OR REPLACE cannot do.
DROP FUNCTION IF EXISTS public.fn_cash_seat_moves_pending(uuid);
CREATE FUNCTION public.fn_cash_seat_moves_pending(p_table_id uuid)
RETURNS TABLE(move_id uuid, player_id uuid, to_table_id uuid, to_table_name text, to_role text,
              to_main_index integer, reason text, announced_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT m.id, m.player_id, m.to_table_id, t.name, t.role, t.main_index, m.reason, m.announced_at
    FROM public.cash_seat_moves m
    JOIN public.tables t ON t.id = m.to_table_id
   WHERE m.from_table_id = p_table_id AND m.state = 'pending' AND m.expires_at > clock_timestamp()
   ORDER BY m.created_at;
$$;
REVOKE ALL ON FUNCTION public.fn_cash_seat_moves_pending(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_moves_pending(uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 + 3 + 4. The executor: declares itself, refuses to move nothing, carries
--            presence, and gives the mover a fresh entry
-- ─────────────────────────────────────────────────────────────────────────────

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

  -- NOTHING IS MOVED WITH NOTHING (2026-09-05). A busted player is in their
  -- rebuy window, or about to be stood up; either way the chair they are in
  -- is the one that resolves it. Cancelled, not expired: the planner leaves
  -- them alone for a minute and looks again.
  IF coalesce(src.stack, 0) <= 0 THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'busted' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'busted');
  END IF;

  SELECT * INTO dst FROM public.tables WHERE id = m.to_table_id FOR UPDATE;
  IF NOT FOUND OR dst.status NOT IN ('waiting', 'running', 'active') OR dst.lifecycle IN ('breaking', 'closed') THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_unavailable' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_unavailable');
  END IF;

  -- The lowest open seat at the destination. (A notified waitlist hold is a
  -- COUNT the planner respected when it chose this table, not a seat number.)
  SELECT gs INTO v_seat FROM generate_series(1, coalesce(dst.max_players, 9)) gs
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats ts
                      WHERE ts.table_id = dst.id AND ts.seat_number = gs AND ts.left_at IS NULL)
   ORDER BY gs LIMIT 1;
  IF v_seat IS NULL THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_full' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_full');
  END IF;

  v_stack := src.stack;

  -- THIS IS A MOVE (2026-09-05). The four-table cap and the one-seat-per-game
  -- door both read this: for the rest of this transaction a seat write is a
  -- player changing chairs inside one game, not entering one.
  PERFORM set_config('app.cash_seat_move', 'on', true);

  -- New chair first, then the old, in ONE sub-transaction: the player is
  -- never, even inside this transaction, seatless. Stack to zero before
  -- leaving, so trg_log_seat_stack_exit sees no chips leave a chair whose
  -- chips went to another chair. If the new chair is refused, the exception
  -- block undoes everything and the plan is cancelled with the reason.
  BEGIN
    -- (table_id, seat_number) is unique across departed rows too, so a chair
    -- that has been sat in before is REVIVED, the way atomic_table_buyin
    -- does it; a never-used chair is inserted. Presence travels; entry does
    -- not (a mover is entering this table: wait for the BB, or post).
    UPDATE public.table_seats
       SET user_id = src.user_id, member_id = src.member_id, stack = v_stack,
           -- A new chair is dealt in (trg_new_seat_clear_sitout does this on
           -- an INSERT unconditionally; written here too so a REVIVED chair
           -- starts the same way). is_away is connection state and travels.
           is_sitting_out = false, sit_out_at = NULL,
           is_away = coalesce(src.is_away, false),
           joined_at = src.joined_at,
           horse_id = src.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = src.auto_rebuy, time_bank_remaining = src.time_bank_remaining,
           time_bank_uses_remaining = src.time_bank_uses_remaining, club_id = src.club_id,
           entry_hold = 'waiting', entry_post_agreed = false, left_at = NULL
     WHERE table_id = dst.id AND seat_number = v_seat AND left_at IS NOT NULL
     RETURNING id INTO v_new_id;
    IF v_new_id IS NULL THEN
      INSERT INTO public.table_seats
        (table_id, seat_number, user_id, member_id, stack, is_sitting_out, is_away, sit_out_at, joined_at,
         horse_id, status, leave_pending, auto_rebuy, time_bank_remaining, time_bank_uses_remaining,
         club_id, entry_hold, entry_post_agreed)
      VALUES
        (dst.id, v_seat, src.user_id, src.member_id, v_stack,
         false, coalesce(src.is_away, false), NULL, src.joined_at,
         src.horse_id, 'active', false, src.auto_rebuy, src.time_bank_remaining, src.time_bank_uses_remaining,
         src.club_id, 'waiting', false)
      RETURNING id INTO v_new_id;
    END IF;
    UPDATE public.table_seats SET stack = 0 WHERE id = src.id;
    UPDATE public.table_seats SET left_at = clock_timestamp(), leave_pending = false, status = 'left'
     WHERE id = src.id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.cash_seat_move', '', true);
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = left(SQLERRM, 200) WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_refused', 'detail', left(SQLERRM, 200));
  END;
  PERFORM set_config('app.cash_seat_move', '', true);

  -- The chip-continuity session follows the player: baseline, clock and
  -- window untouched. This is the "cluster" scope Slice 0 promised.
  UPDATE public.cash_player_session
     SET scope_id = dst.id, table_id = dst.id
   WHERE player_id = m.player_id AND scope_type = 'table' AND scope_id = m.from_table_id AND closed_at IS NULL;

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The four-table cap exempts a declared move, and only that
-- ─────────────────────────────────────────────────────────────────────────────
-- The count itself (fn_concurrent_game_load) and the booking trigger are
-- unchanged. The partial indexes the count depends on are
-- idx_table_seats_user_live and idx_tournament_players_user_open
-- (20260824_four_table_limit / 20260828); they are not touched here.

CREATE OR REPLACE FUNCTION public.fn_enforce_four_table_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_live       int;
  v_is_closed  boolean;
  v_tournament uuid;
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A MOVE WITHIN ONE GAME IS NOT A FIFTH GAME (2026-09-05). Only the cluster
  -- executor sets this, for the one transaction in which a player changes
  -- chairs inside a game they are already in. It replaces the 041000 rule
  -- ("holds another live seat in this cluster"), which also let a player buy
  -- a second seat into a game they were already sitting in.
  IF current_setting('app.cash_seat_move', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT (t.status = 'closed'), t.tournament_id
    INTO v_is_closed, v_tournament
    FROM public.tables t
   WHERE t.id = NEW.table_id;
  IF COALESCE(v_is_closed, false) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || NEW.user_id::text, 0));

  v_live := public.fn_concurrent_game_load(NEW.user_id, NEW.id, NEW.table_id, v_tournament);

  IF v_live >= 4 THEN
    RAISE EXCEPTION
      'FOUR TABLE LIMIT: user % is already committed to % games and may not take another',
      NEW.user_id, v_live
      USING ERRCODE = '23514',
            HINT = 'Leave a table or unregister before joining another. A game is a live seat or a booking for a tournament that has not started. This limit applies to players and horses alike.';
  END IF;

  RETURN NEW;
END;
$$;

-- The trigger, so this file is the complete definition of the seat-side rule
-- (the test reads trigger and body from one place). It is created only if it
-- is missing: CREATE OR REPLACE keeps the function's OID, so the existing
-- trigger already runs the new body, and a DROP/CREATE on table_seats - a
-- realtime-published table - deadlocks against the realtime worker (seen in
-- this file's own rolled-back probe, and in 20260905010000's lock note).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'trg_enforce_four_table_limit'
                    AND tgrelid = 'public.table_seats'::regclass) THEN
    EXECUTE $t$
      CREATE TRIGGER trg_enforce_four_table_limit
        BEFORE INSERT OR UPDATE OF left_at ON public.table_seats
        FOR EACH ROW
        EXECUTE FUNCTION public.fn_enforce_four_table_limit()
    $t$;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4b. The cluster door: closed and breaking tables, and one seat per game
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_refuse_seat_on_closed_cluster_table()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_lifecycle text;
  v_cluster uuid;
BEGIN
  IF NEW.left_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT cluster_id, lifecycle INTO v_cluster, v_lifecycle FROM public.tables WHERE id = NEW.table_id;
  IF v_cluster IS NULL THEN RETURN NEW; END IF;
  IF v_lifecycle IN ('breaking', 'closed') THEN
    RAISE EXCEPTION 'TABLE_CLOSING: this table is % and takes no new players - the game will seat you at its next open table', v_lifecycle
      USING ERRCODE = 'check_violation';
  END IF;
  -- ONE SEAT PER GAME (2026-09-05). A must-move game is one game however many
  -- tables it has; a player holds one chair in it. The executor, changing that
  -- chair, declares itself and is let through; everybody else is refused.
  IF current_setting('app.cash_seat_move', true) IS DISTINCT FROM 'on'
     AND NEW.user_id IS NOT NULL
     AND EXISTS (SELECT 1
                   FROM public.table_seats ts
                   JOIN public.tables t ON t.id = ts.table_id
                  WHERE ts.user_id = NEW.user_id
                    AND ts.left_at IS NULL
                    AND ts.id IS DISTINCT FROM NEW.id
                    AND t.cluster_id = v_cluster
                    AND t.id <> NEW.table_id
                    AND t.lifecycle <> 'closed') THEN
    RAISE EXCEPTION 'ALREADY_IN_GAME: you already have a seat in this game - the game moves you between its tables itself'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. The writer of a cluster table: Big Blind Ante means the big blind posts it
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_open_table(p_game_id uuid, p_role text, p_main_index integer, p_lifecycle text DEFAULT 'opening'::text, p_created_by uuid DEFAULT NULL::uuid)
RETURNS uuid
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
    cluster_id, role, main_index, lifecycle, opened_at, live_at
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 + 4 + 5. The tick: the planner's three filters, and the abandoned feeder
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick(p_game_id uuid, p_eligible_horses integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  g record; t record; r record;
  v_census public.cash_cluster_census_row[];
  v_actions jsonb := '[]'::jsonb;
  v_now timestamptz := clock_timestamp();
  v_seated_total integer := 0;
  v_live_tables integer := 0;
  v_open_unreserved integer := 0;
  v_buyers integer;
  v_waiting integer;
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
  v_res jsonb;
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

  -- A CLOSED TABLE WITH SOMEONE ON IT (2026-09-05). The census excludes
  -- closed tables, so a player who reached one (the seat guard below now
  -- refuses; this covers what got through before it, and any future hole)
  -- would never be planned out. It goes back to `breaking`, which the
  -- census sees and step 5 walks empty, then closes again.
  FOR t IN SELECT tb.id FROM public.tables tb
            WHERE tb.cluster_id = g.id AND tb.lifecycle = 'closed'
              AND coalesce(tb.is_deleted, false) = false
              AND EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL)
  LOOP
    UPDATE public.tables SET lifecycle = 'breaking', status = 'running', break_started_at = v_now, updated_at = now()
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'closed_table_reopened_to_break');
    v_actions := v_actions || jsonb_build_object('reopened_to_break', t.id);
  END LOOP;

  -- AN OPENING FEEDER NOBODY CAME TO (2026-09-05). It was opened for two
  -- buyers; three minutes with nobody on it means they went elsewhere. It
  -- closes, the live feeder it was going to promote stays the feeder, and
  -- OPEN below waits two minutes before trying again.
  FOR t IN SELECT tb.id FROM public.tables tb
            WHERE tb.cluster_id = g.id AND tb.lifecycle = 'opening'
              AND coalesce(tb.is_deleted, false) = false
              AND coalesce(tb.opened_at, tb.created_at) < v_now - interval '3 minutes'
              AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL)
  LOOP
    UPDATE public.tables SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now()
     WHERE id = t.id;
    UPDATE public.tables SET promote_pending = false
     WHERE cluster_id = g.id AND role = 'feeder' AND promote_pending;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'feeder_abandoned');
    v_actions := v_actions || jsonb_build_object('feeder_abandoned', t.id);
  END LOOP;

  v_census := public.fn_cash_cluster_census(g.id, v_now);
  SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;

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
    v_census := public.fn_cash_cluster_census(g.id, v_now);
    SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;
  END IF;

  -- ── 2. MUST-MOVE (1.3 s9.5) ──────────────────────────────────────────────
  -- For every Main with an unreserved open seat, the longest-seated player on
  -- the feeder (or on a breaking table) is planned onto it, one per seat,
  -- one per player. The engine executes at the player's next hand boundary.
  FOR t IN SELECT * FROM unnest(v_census) c
            WHERE c.role = 'main' AND c.lifecycle = 'live' AND c.open_unreserved > 0
            ORDER BY c.main_index
  LOOP
    v_n := t.open_unreserved
         - (SELECT count(*) FROM public.cash_seat_moves m WHERE m.to_table_id = t.id AND m.state = 'pending');
    FOR r IN
      SELECT ts.user_id, ts.table_id
        FROM public.table_seats ts
        JOIN unnest(v_census) c ON c.id = ts.table_id
       WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
         AND (c.role = 'feeder' OR c.breaking)
         AND c.id <> t.id
         -- NOT WITH NOTHING, NOT WHILE LEAVING (2026-09-05): a busted seat is
         -- in its rebuy window, a leave_pending seat is on its way out.
         AND coalesce(ts.stack, 0) > 0
         AND coalesce(ts.leave_pending, false) = false
         -- Never onto a table they are already sitting at.
         AND NOT EXISTS (SELECT 1 FROM public.table_seats d WHERE d.table_id = t.id AND d.user_id = ts.user_id AND d.left_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
         -- BACK-OFF (2026-09-05): a move the engine just refused (cancelled
         -- with a note) is not re-planned every 5 s; the refusal gets a minute.
         AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'cancelled' AND m.created_at > v_now - interval '60 seconds')
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
  SELECT coalesce(sum(c.open_unreserved), 0) INTO v_open_unreserved
    FROM unnest(v_census) c WHERE c.lifecycle IN ('live', 'opening') AND NOT c.breaking;
  SELECT count(*) INTO v_waiting FROM public.cash_game_waitlist w
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified');
  v_buyers := v_waiting + GREATEST(coalesce(p_eligible_horses, 0), 0);
  -- (a CASE ... THEN inside an IF condition ends the condition early in
  --  PL/pgSQL, so the cap is computed first)
  v_table_cap := g.cap_mains + 1;
  IF g.allow_second_feeder THEN v_table_cap := v_table_cap + 1; END IF;

  IF g.enabled AND v_open_unreserved = 0 AND v_live_tables > 0
     AND NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle = 'opening')
     AND v_live_tables < v_table_cap
     -- Two minutes after a feeder was abandoned, not before.
     AND NOT EXISTS (SELECT 1 FROM public.cash_cluster_events e
                      WHERE e.game_id = g.id AND e.kind = 'feeder_abandoned' AND e.at > v_now - interval '2 minutes') THEN
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
  FOR t IN SELECT * FROM unnest(v_census) c WHERE c.lifecycle = 'opening' AND c.seated >= 2 LOOP
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

  -- Refresh the census for the steps that read roles (the counts are the
  -- tick's own snapshot and stay).
  SELECT coalesce(array_agg(
           (tb.id, tb.role, tb.main_index, tb.lifecycle, c.status, c.created_at, c.max_players,
            c.seated, c.reserved, c.open_unreserved, c.breaking)::public.cash_cluster_census_row
           ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
    INTO v_census
    FROM unnest(v_census) c JOIN public.tables tb ON tb.id = c.id;

  -- ── 5. BREAK (18.3) ──────────────────────────────────────────────────────
  -- Candidate: newest table first (feeder, then the highest main), never
  -- Main 1, never a table still opening. Condition: everyone fits in the
  -- rest at or above the floor. Five minutes of that, then it breaks.
  v_floor := CASE WHEN g.handedness <= 6 THEN 3 ELSE 4 END;
  SELECT * INTO v_candidate FROM unnest(v_census) c
   WHERE NOT (c.role = 'main' AND c.main_index = 1) AND c.lifecycle = 'live'
   ORDER BY (c.role = 'feeder') DESC, c.main_index DESC NULLS FIRST, c.created_at DESC LIMIT 1;

  IF NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.breaking) AND v_candidate.id IS NOT NULL THEN
    SELECT coalesce(sum(c.max_players - c.reserved), 0), count(*) INTO v_remaining_capacity, v_remaining_tables
      FROM unnest(v_census) c WHERE c.id <> v_candidate.id AND c.lifecycle = 'live';
    IF v_remaining_tables >= 1
       -- STRICT (2026-09-05, first live cycle): everyone fits AND the rest
       -- keeps a seat open. At `<=` the rest is exactly full at the moment
       -- of the break, which is the OPEN rule's own trigger (no unreserved
       -- seat), so the feeder was broken and re-opened 7 s apart.
       AND v_seated_total < v_remaining_capacity
       AND v_seated_total >= v_floor * v_remaining_tables THEN
      SELECT break_eligible_since INTO r FROM public.tables WHERE id = v_candidate.id;
      IF r.break_eligible_since IS NULL THEN
        UPDATE public.tables SET break_eligible_since = v_now WHERE id = v_candidate.id;
        v_actions := v_actions || jsonb_build_object('break_eligible', v_candidate.id);
      ELSIF r.break_eligible_since <= v_now - interval '5 minutes' THEN
        UPDATE public.tables SET lifecycle = 'breaking', break_started_at = v_now, break_eligible_since = NULL
         WHERE id = v_candidate.id;
        SELECT coalesce(array_agg(
                 (c.id, c.role, c.main_index,
                  CASE WHEN c.id = v_candidate.id THEN 'breaking' ELSE c.lifecycle END,
                  c.status, c.created_at, c.max_players, c.seated, c.reserved, c.open_unreserved,
                  c.breaking OR c.id = v_candidate.id)::public.cash_cluster_census_row
                 ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
          INTO v_census FROM unnest(v_census) c;
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
  FOR t IN SELECT * FROM unnest(v_census) c WHERE c.breaking LOOP
    IF t.seated = 0 THEN
      UPDATE public.tables SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now()
       WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'table_break_completed');
      SELECT coalesce(array_agg(c ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
        INTO v_census FROM unnest(v_census) c WHERE c.id <> t.id;
      v_actions := v_actions || jsonb_build_object('closed', t.id);
      CONTINUE;
    END IF;
    -- A SECOND CHAIR IN ONE GAME (2026-09-05). Before the door refused it, the
    -- fleet could seat the same horse at two tables of one game; found live
    -- with one of the two chairs on this breaking table. There is nowhere to
    -- move that chair to (they are already at the other table), so it goes
    -- home: the stack returns to the wallet through the forced cash-out the
    -- table-close path uses. Nothing is lost; the other chair is untouched.
    FOR r IN SELECT ts.user_id, ts.seat_number, ts.stack,
                    coalesce(ts.club_id, public.fn_player_home_club(ts.user_id, NULL)) AS club_id
               FROM public.table_seats ts
              WHERE ts.table_id = t.id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
                AND coalesce(ts.stack, 0) > 0
                AND EXISTS (SELECT 1 FROM public.table_seats o JOIN public.tables ot ON ot.id = o.table_id
                             WHERE o.user_id = ts.user_id AND o.left_at IS NULL AND o.table_id <> t.id
                               AND ot.cluster_id = g.id AND ot.lifecycle IN ('live', 'opening'))
    LOOP
      CONTINUE WHEN r.club_id IS NULL;
      -- The same three calls fn_cashout_seats_for_closing_table makes, per seat.
      PERFORM public.fn_ensure_club_wallet(r.user_id, r.club_id);
      PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', t.id);
      v_res := public.atomic_seat_cashout_locked(r.user_id, t.id, r.seat_number, 'forced');
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, t.id, 'second_chair_cashed_out',
              jsonb_build_object('player_id', r.user_id, 'seat', r.seat_number, 'stack', r.stack,
                                 'club_id', r.club_id, 'credited', v_res->'credited', 'key', v_res->'idempotency_key'));
      v_actions := v_actions || jsonb_build_object('second_chair_cashed_out', r.user_id);
    END LOOP;
    FOR r IN SELECT ts.user_id FROM public.table_seats ts
              WHERE ts.table_id = t.id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
                AND coalesce(ts.stack, 0) > 0
                AND coalesce(ts.leave_pending, false) = false
                AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
                AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'cancelled' AND m.created_at > v_now - interval '60 seconds')
              ORDER BY ts.joined_at
    LOOP
      SELECT c.id INTO v_shortest FROM unnest(v_census) c
       WHERE c.id <> t.id AND NOT c.breaking AND c.lifecycle IN ('live', 'opening')
         AND c.open_unreserved - (SELECT count(*) FROM public.cash_seat_moves m WHERE m.to_table_id = c.id AND m.state = 'pending') > 0
         AND NOT EXISTS (SELECT 1 FROM public.table_seats d WHERE d.table_id = c.id AND d.user_id = r.user_id AND d.left_at IS NULL)
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
  FOR t IN SELECT * FROM unnest(v_census) c WHERE c.lifecycle IN ('live', 'opening') AND c.role = 'main' ORDER BY c.created_at LOOP
    v_idx := v_idx + 1;
    IF t.main_index IS DISTINCT FROM v_idx THEN
      UPDATE public.tables SET main_index = v_idx,
             name = CASE WHEN v_idx = 1 THEN g.name ELSE left(g.name, 50) || ' Main ' || v_idx END
       WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, t.id, 'main_renumbered', jsonb_build_object('from', t.main_index, 'to', v_idx));
    END IF;
  END LOOP;
  IF v_idx >= 2 AND NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.role = 'feeder' AND c.lifecycle IN ('live', 'opening')) THEN
    SELECT * INTO t FROM unnest(v_census) c WHERE c.role = 'main' AND c.lifecycle = 'live' ORDER BY c.created_at DESC LIMIT 1;
    UPDATE public.tables SET role = 'feeder', main_index = NULL, promote_pending = false,
           name = left(g.name, 50) || ' Feeder'
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'main_demoted_to_feeder');
    v_actions := v_actions || jsonb_build_object('demoted', t.id);
  END IF;

  -- ── enabled = false (18.4): no seeding, no opening; empties close ─────────
  IF NOT g.enabled THEN
    FOR t IN SELECT * FROM unnest(v_census) c WHERE c.seated = 0 LOOP
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 6 + 7. Data: the Madness tables, and the pre-Slice-2 flags
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.tables t
   SET big_blind_ante_enabled = true, updated_at = now()
  FROM public.cash_games g
 WHERE g.id = t.cluster_id
   AND coalesce(g.ruleset_snapshot->>'regular_ante', 'none') = 'bb'
   AND coalesce(t.big_blind_ante_enabled, false) = false
   AND t.lifecycle <> 'closed';

UPDATE public.tables
   SET auto_restart = false, auto_extension = false, auto_create_table = false, updated_at = now()
 WHERE cluster_id IS NOT NULL
   AND (coalesce(auto_restart, false) OR coalesce(auto_extension, false) OR coalesce(auto_create_table, false));

UPDATE public.tables
   SET settings = settings - 'retire_when_empty' - 'night_parked', updated_at = now()
 WHERE cluster_id IS NOT NULL
   AND settings IS NOT NULL
   AND (settings ? 'retire_when_empty' OR settings ? 'night_parked');

-- ─────────────────────────────────────────────────────────────────────────────
-- Assertions: every edit above is pinned, and the file aborts if one is missing
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_tick text; v_exec text; v_cap text; v_door text; v_open text; v_pend text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_tick FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_cash_cluster_tick';
  SELECT pg_get_functiondef(p.oid) INTO v_exec FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_cash_seat_move_execute';
  SELECT pg_get_functiondef(p.oid) INTO v_cap FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_enforce_four_table_limit';
  SELECT pg_get_functiondef(p.oid) INTO v_door FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_refuse_seat_on_closed_cluster_table';
  SELECT pg_get_functiondef(p.oid) INTO v_open FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_cash_cluster_open_table';
  SELECT pg_get_functiondef(p.oid) INTO v_pend FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_cash_seat_moves_pending';

  IF v_tick NOT LIKE '%feeder_abandoned%' THEN RAISE EXCEPTION 'tick: abandoned feeder step missing'; END IF;
  IF v_tick NOT LIKE '%second_chair_cashed_out%' THEN RAISE EXCEPTION 'tick: second chair step missing'; END IF;
  IF v_tick NOT LIKE '%coalesce(ts.stack, 0) > 0%' THEN RAISE EXCEPTION 'tick: stack filter missing'; END IF;
  IF v_tick NOT LIKE '%coalesce(ts.leave_pending, false) = false%' THEN RAISE EXCEPTION 'tick: leave_pending filter missing'; END IF;
  IF v_tick NOT LIKE '%d.table_id = t.id AND d.user_id = ts.user_id%' THEN RAISE EXCEPTION 'tick: already-seated filter missing'; END IF;
  IF v_tick LIKE '%DELETE FROM%' OR v_tick LIKE '%CREATE TEMP%' THEN RAISE EXCEPTION 'tick: temp table or bare DELETE crept back'; END IF;
  IF v_tick NOT LIKE '%v_seated_total < v_remaining_capacity%' THEN RAISE EXCEPTION 'tick: strict break lost'; END IF;
  IF v_exec NOT LIKE '%app.cash_seat_move%' THEN RAISE EXCEPTION 'executor: move declaration missing'; END IF;
  IF v_exec NOT LIKE '%''busted''%' THEN RAISE EXCEPTION 'executor: busted refusal missing'; END IF;
  IF v_exec NOT LIKE '%entry_hold = ''waiting'', entry_post_agreed = false%' THEN RAISE EXCEPTION 'executor: fresh entry missing'; END IF;
  IF v_exec NOT LIKE '%is_sitting_out = false, sit_out_at = NULL%' THEN RAISE EXCEPTION 'executor: a revived chair must start dealt in'; END IF;
  IF v_cap NOT LIKE '%app.cash_seat_move%' THEN RAISE EXCEPTION 'cap: GUC exemption missing'; END IF;
  IF v_cap LIKE '%t.cluster_id = v_cluster%' THEN RAISE EXCEPTION 'cap: the second-seat door is still open'; END IF;
  IF v_door NOT LIKE '%ALREADY_IN_GAME%' THEN RAISE EXCEPTION 'door: one seat per game missing'; END IF;
  IF v_open NOT LIKE '%(v_ante = ''bb'')%' THEN RAISE EXCEPTION 'open_table: big blind ante flag missing'; END IF;
  IF v_pend NOT LIKE '%announced_at%' THEN RAISE EXCEPTION 'pending: announced_at missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_enforce_four_table_limit' AND tgrelid = 'public.table_seats'::regclass) THEN
    RAISE EXCEPTION 'cap: trigger missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tables t JOIN public.cash_games g ON g.id = t.cluster_id
              WHERE coalesce(g.ruleset_snapshot->>'regular_ante', 'none') = 'bb' AND t.lifecycle <> 'closed'
                AND coalesce(t.big_blind_ante_enabled, false) = false) THEN
    RAISE EXCEPTION 'data: a bb-ante cluster table still antes from every seat';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tables WHERE cluster_id IS NOT NULL AND (coalesce(auto_restart, false) OR coalesce(auto_extension, false))) THEN
    RAISE EXCEPTION 'data: a cluster table still carries a lifecycle-pass flag';
  END IF;
END $$;

COMMIT;
