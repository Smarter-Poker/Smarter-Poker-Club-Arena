-- ═══════════════════════════════════════════════════════════════════════════════
-- THE MUST MOVE LOBBY: A SEAT CHANGE, AND THE ORDER YOU JOINED
-- (Operation Table Stakes; Dan 2026-09-05)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, verbatim: "EACH AND EVERY PLAYER GETS A SEAT CHANGE BUTTON WHEN THEY SIT
-- DOWN AT ANY 'FEEDER GAME', AND ARE ALLOWED TO USE IT ONCE TO CHANGE TABLES.
-- (NEVER TO THE MAIN GAME) BUT TO ANOTHER FEEDER GAME. IF THERE ARE NO SEATS
-- ... THEY BECOME '1ST ON THE LIST' TO TABLE CHANGE, IF TWO PEOPLE WANT TO
-- CHANGE TABLES, YOU SWITCH THOSE TWO PLAYERS. PLAYERS SHOULD ALSO BE ABLE TO
-- REQUEST A SPECIFIC FEEDER TABLE ... (SEAT CHANGE ALWAYS RE POSTS THE BB WHEN
-- GETTING TO A NEW TABLE). IF THEY ARE AUTO MOVED, NO POST UNLESS THEY ARE
-- ALREADY MOVED TO THE BB. (FREE HANDS UNTIL BB BECAUSE THEY ALREADY POSTED AT
-- THE PREVIOUS TABLE). YOU ALSO NEED TO RECORD AND POST THE ORDER OF WHEN A
-- PLAYER 'JOINED THE GAME' THATS THE MUST MOVE ORDER FOR ALL TABLE CHANGES TO
-- THE MAIN GAME. (ONCE THEY ARE ON THE MAIN GAME, YOU CAN TAKE THEM OFF THE
-- LIST) IF THEY LEAVE A TABLE AND JOIN THE SAME GAME AND STAKES AGAIN, THEY GO
-- TO THE BOTTOM OF THE LIST, BUT RATHOLE PROTECTION IS IN PLACE."
--
-- And on the rathole: "RATHOLE ONLY APPLIES TO WINNING PLAYERS. IF A PLAYER
-- BUYS IN FOR 100 WHEN TABLE MAX IS 400 AND LEAVES WITH 150, THEN TRIES TO SIT
-- BACK DOWN, MINIMUM BUY IN FOR THAT PLAYER FOR THE NEXT TWO HOURS IS 150."
--
-- In this architecture "the main game" is Main 1; every other table of the
-- game (the feeder, and the Mains promoted from it) is a "feeder game" in
-- Dan's words. So:
--
-- 1. THE ROSTER (`cash_game_roster`). One open row per player per game from
--    the moment their first chair is inserted until the moment their last
--    chair empties. `joined_at` is when they JOINED THE GAME and survives
--    every move (the executor declares itself; the roster trigger lets a
--    declared move through untouched). Leave and come back = a new row at
--    the bottom. The must-move list is the roster minus Main 1, in
--    `joined_at` order, and the planner now fills a Main 1 seat from that
--    list (any table but Main 1), and a Main N>1 seat from the feeder, both
--    in roster order rather than the chair's `joined_at`, which reset on
--    every move.
--
-- 2. THE SEAT CHANGE (`cash_seat_change_requests`). Once per roster row,
--    from any table but Main 1, to any other table but Main 1 - a specific
--    one or "any". A seat open now: a `seat_change` move is planned at once.
--    None: the request is first on that table's list, and the tick fills the
--    next unreserved chair from the list before anyone new. Two requests
--    that would accept each other's table are SWAPPED: two moves linked by
--    `swap_move_id`, each executed at its own table's hand boundary; the
--    first to arrive is held out of the deal (`ready_at`), the second lands
--    both chairs in one transaction (`fn_cash_seat_swap_execute`). Cancel
--    gives the button back; leaving the game cancels the request.
--
-- 3. ENTRY BY REASON. A seat change ARRIVES: `entry_hold = 'waiting'`,
--    `entry_post_agreed = true` (post the big blind, held until clear if
--    they land between the button and the blind). A must-move or a break
--    is not an arrival: `entry_hold = 'moved'` - dealt in on the next deal,
--    nothing posted, the big blind when it comes round. The check constraint
--    learns the third value; the engine learns what it means.
--
-- 4. THE FLOOR IS FOR WINNERS. `fn_cash_session_close` wrote a rejoin floor
--    for ANY departing stack above zero, so a player who bought 100 and left
--    with 60 was held to 60 for two hours. It now writes one only when the
--    departing stack is above the session baseline (buy-in plus every add-on
--    and rebuy). Existing floors that a closed session shows were written for
--    a non-winner are expired here.
--
-- 5. `fn_cash_game_lobby(game)` is the one read behind the Must Move Lobby:
--    every table with every chair and stack, the must-move list with
--    positions, the waitlist count, per-table seat-change queues and the
--    caller's own state (position, pending move, seat change available /
--    used / listed). `fn_cash_game_must_move_list(game)` is the list alone.
--
-- Swap moves are NOT reservations: a swap changes no table's headcount, so
-- every count of "pending moves to this table" now excludes rows with
-- `swap_move_id` (open-seat arithmetic in the door, the planner and the
-- break step).
--
-- ROLLBACK (functions and tables only; the two ALTERs are additive):
--   DROP FUNCTION IF EXISTS public.fn_cash_game_lobby(uuid);
--   DROP FUNCTION IF EXISTS public.fn_cash_game_must_move_list(uuid);
--   DROP FUNCTION IF EXISTS public.fn_cash_seat_change_request(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.fn_cash_seat_change_cancel(uuid);
--   DROP FUNCTION IF EXISTS public.fn_cash_seat_change_plan(uuid, timestamptz);
--   DROP FUNCTION IF EXISTS public.fn_cash_seat_swap_execute(uuid);
--   DROP TRIGGER IF EXISTS trg_cash_game_roster_track ON public.table_seats;
--   DROP FUNCTION IF EXISTS public.fn_cash_game_roster_track();
--   DROP TABLE IF EXISTS public.cash_seat_change_requests;
--   DROP TABLE IF EXISTS public.cash_game_roster;
--   -- re-apply 20260905053000 for fn_cash_cluster_tick, fn_cash_game_open_seats
--   -- re-apply 20260905050000 for fn_cash_seat_move_execute, fn_cash_seat_moves_pending
--   -- re-apply 20260904160500 for fn_cash_session_close

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 1 - the two additive ALTERs, each its own lock-timed transaction
-- (table_seats is realtime-published; a long exclusive lock there is the
-- deadlock the Gate 3 handoff records).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE public.table_seats DROP CONSTRAINT IF EXISTS table_seats_entry_hold_check;
ALTER TABLE public.table_seats ADD CONSTRAINT table_seats_entry_hold_check
  CHECK (entry_hold IS NULL OR entry_hold = ANY (ARRAY['waiting'::text, 'posting'::text, 'moved'::text]));
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE public.cash_seat_moves DROP CONSTRAINT IF EXISTS cash_seat_moves_reason_check;
ALTER TABLE public.cash_seat_moves ADD CONSTRAINT cash_seat_moves_reason_check
  CHECK (reason = ANY (ARRAY['must_move'::text, 'break'::text, 'seat_change'::text]));
ALTER TABLE public.cash_seat_moves ADD COLUMN IF NOT EXISTS swap_move_id uuid;
ALTER TABLE public.cash_seat_moves ADD COLUMN IF NOT EXISTS ready_at timestamptz;
COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 2a - the two tables (a foreign key to cash_games takes a share lock on
-- it that the live tick, holding table_seats, waits behind: brief, on its own).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ── The roster ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cash_game_roster (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id             uuid NOT NULL REFERENCES public.cash_games(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL,
  joined_at           timestamptz NOT NULL DEFAULT now(),
  left_at             timestamptz,
  seat_change_used_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_game_roster_open
  ON public.cash_game_roster (game_id, user_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cash_game_roster_game_joined
  ON public.cash_game_roster (game_id, joined_at) WHERE left_at IS NULL;
ALTER TABLE public.cash_game_roster ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_game_roster FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.cash_game_roster TO service_role;
COMMENT ON TABLE public.cash_game_roster IS
  'One open row per player per must-move game: joined_at is the must-move order (Dan 2026-09-05). Closed when the last chair in the game empties; a rejoin is a new row at the bottom.';

-- ── Seat-change requests ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cash_seat_change_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       uuid NOT NULL REFERENCES public.cash_games(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  from_table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  to_table_id   uuid REFERENCES public.tables(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'requested'
                CHECK (status = ANY (ARRAY['requested'::text, 'moved'::text, 'cancelled'::text])),
  note          text,
  move_id       uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_seat_change_requests_open
  ON public.cash_seat_change_requests (game_id, user_id) WHERE status = 'requested';
CREATE INDEX IF NOT EXISTS idx_cash_seat_change_requests_game_created
  ON public.cash_seat_change_requests (game_id, created_at) WHERE status = 'requested';
ALTER TABLE public.cash_seat_change_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_seat_change_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.cash_seat_change_requests TO service_role;
COMMENT ON TABLE public.cash_seat_change_requests IS
  'A player''s one voluntary table change inside a must-move game (never from or to Main 1). to_table_id NULL = any table but Main 1. requested -> moved (a cash_seat_moves row) | cancelled.';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 2b - the roster trigger (an exclusive lock on table_seats: lock-timed,
-- on its own, retried by the applier).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ── The roster trigger ──────────────────────────────────────────────────────
-- AFTER, and it can never refuse a seat: a roster that cannot be written is
-- a warning in the log, not a buy-in that fails.

CREATE OR REPLACE FUNCTION public.fn_cash_game_roster_track()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_game uuid;
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  SELECT cluster_id INTO v_game FROM public.tables WHERE id = NEW.table_id;
  IF v_game IS NULL THEN RETURN NEW; END IF;

  BEGIN
    IF NEW.left_at IS NULL THEN
      -- A live chair in the game. On the roster once, at the time of the
      -- first chair; a second chair (a move, mid-transaction) changes nothing.
      INSERT INTO public.cash_game_roster (game_id, user_id, joined_at)
      VALUES (v_game, NEW.user_id, coalesce(NEW.joined_at, now()))
      ON CONFLICT (game_id, user_id) WHERE left_at IS NULL DO NOTHING;
    ELSIF TG_OP = 'UPDATE' AND OLD.left_at IS NULL THEN
      -- The chair emptied. A move declares itself and is not a leave; a
      -- player with another live chair in the game, or a move still planned
      -- for them, is still in the game.
      IF current_setting('app.cash_seat_move', true) IS DISTINCT FROM 'on'
         AND NOT EXISTS (SELECT 1 FROM public.table_seats ts
                           JOIN public.tables t ON t.id = ts.table_id
                          WHERE ts.user_id = NEW.user_id AND ts.left_at IS NULL AND ts.id <> NEW.id
                            AND t.cluster_id = v_game AND t.lifecycle <> 'closed')
         AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m
                          WHERE m.player_id = NEW.user_id AND m.game_id = v_game AND m.state = 'pending') THEN
        UPDATE public.cash_game_roster SET left_at = now()
         WHERE game_id = v_game AND user_id = NEW.user_id AND left_at IS NULL;
        UPDATE public.cash_seat_change_requests
           SET status = 'cancelled', resolved_at = now(), note = 'left_game'
         WHERE game_id = v_game AND user_id = NEW.user_id AND status = 'requested';
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_cash_game_roster_track: % (seat %, user %)', SQLERRM, NEW.id, NEW.user_id;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cash_game_roster_track ON public.table_seats;
CREATE TRIGGER trg_cash_game_roster_track
  AFTER INSERT OR UPDATE OF left_at, user_id ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_cash_game_roster_track();

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 2c - the functions, the backfill and the assertions, one transaction
-- (functions only: safe to probe rolled back, no table lock held).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Backfill: everyone with a live chair in a game is on its roster, at the
-- earliest chair time the rows still show for them in that game.
INSERT INTO public.cash_game_roster (game_id, user_id, joined_at)
SELECT t.cluster_id, ts.user_id, min(ts.joined_at)
  FROM public.table_seats ts
  JOIN public.tables t ON t.id = ts.table_id
 WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
   AND t.cluster_id IS NOT NULL AND t.lifecycle <> 'closed'
 GROUP BY t.cluster_id, ts.user_id
ON CONFLICT (game_id, user_id) WHERE left_at IS NULL DO NOTHING;

-- ── Open seats: a swap is not a reservation ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_game_open_seats(p_table_id uuid)
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT GREATEST(0,
           coalesce(t.max_players, 9)
           - (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = t.id AND ts.left_at IS NULL)
           - (SELECT count(*) FROM public.table_waitlist w
               WHERE w.table_id = t.id AND w.status = 'notified' AND w.hold_expires_at > clock_timestamp())
           - (SELECT count(*) FROM public.cash_seat_moves m
               WHERE m.to_table_id = t.id AND m.state = 'pending' AND m.swap_move_id IS NULL))::integer
    FROM public.tables t WHERE t.id = p_table_id;
$$;

-- ── The list ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_game_must_move_list(p_game_id uuid)
RETURNS TABLE(pos integer, user_id uuid, alias text, table_id uuid, table_name text,
              role text, main_index integer, joined_at timestamptz)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT (row_number() OVER (ORDER BY r.joined_at, r.id))::integer AS pos,
         r.user_id, public.fn_player_display_name(r.user_id) AS alias,
         t.id, t.name, t.role, t.main_index, r.joined_at
    FROM public.cash_game_roster r
    JOIN public.table_seats ts ON ts.user_id = r.user_id AND ts.left_at IS NULL
    JOIN public.tables t ON t.id = ts.table_id AND t.cluster_id = r.game_id AND t.lifecycle <> 'closed'
   WHERE r.game_id = p_game_id AND r.left_at IS NULL
     AND NOT (t.role = 'main' AND t.main_index = 1)
   ORDER BY r.joined_at, r.id;
$$;

-- ── The lobby read ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_game_lobby(p_game_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
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
   WHERE t.cluster_id = g.id AND coalesce(t.is_deleted, false) = false AND t.lifecycle <> 'closed';

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
$$;

-- ── Planning a seat change (the tick and the door share it) ─────────────────
-- Service-only: the door is SECURITY DEFINER and calls it under the game
-- row lock, exactly as the tick does.

CREATE OR REPLACE FUNCTION public.fn_cash_seat_change_plan(p_game_id uuid, p_now timestamptz DEFAULT clock_timestamp())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r record; p record;
  v_census public.cash_cluster_census_row[];
  v_target uuid;
  v_moves integer := 0;
  v_move_a uuid; v_move_b uuid;
  v_seat_a integer; v_seat_b integer;
BEGIN
  v_census := public.fn_cash_cluster_census(p_game_id, p_now);

  FOR r IN SELECT q.* FROM public.cash_seat_change_requests q
            WHERE q.game_id = p_game_id AND q.status = 'requested'
            ORDER BY q.created_at, q.id
  LOOP
    -- Still in that chair, with chips, not on the way out?
    IF NOT EXISTS (SELECT 1 FROM public.table_seats ts
                    WHERE ts.table_id = r.from_table_id AND ts.user_id = r.user_id AND ts.left_at IS NULL) THEN
      UPDATE public.cash_seat_change_requests
         SET status = 'cancelled', resolved_at = p_now, note = 'left_table'
       WHERE id = r.id;
      CONTINUE;
    END IF;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.table_seats ts
                               WHERE ts.table_id = r.from_table_id AND ts.user_id = r.user_id AND ts.left_at IS NULL
                                 AND coalesce(ts.stack, 0) > 0 AND coalesce(ts.leave_pending, false) = false);
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = r.user_id AND m.state = 'pending');
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.cash_seat_moves m
                           WHERE m.player_id = r.user_id AND m.state = 'cancelled' AND m.created_at > p_now - interval '60 seconds');

    -- A chair: the table they asked for, or (any) the shortest other table
    -- that is not Main 1 and not closing.
    SELECT c.id INTO v_target FROM unnest(v_census) c
     WHERE c.id <> r.from_table_id AND NOT c.breaking AND c.lifecycle IN ('live', 'opening')
       AND NOT (c.role = 'main' AND c.main_index = 1)
       AND (r.to_table_id IS NULL OR c.id = r.to_table_id)
       AND c.open_unreserved
           - (SELECT count(*) FROM public.cash_seat_moves m
               WHERE m.to_table_id = c.id AND m.state = 'pending' AND m.swap_move_id IS NULL) > 0
     ORDER BY c.seated ASC, c.created_at ASC LIMIT 1;
    IF v_target IS NOT NULL THEN
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
      VALUES (p_game_id, r.user_id, r.from_table_id, v_target, 'seat_change')
      RETURNING id INTO v_move_a;
      UPDATE public.cash_seat_change_requests
         SET status = 'moved', resolved_at = p_now, move_id = v_move_a, note = 'seat_open'
       WHERE id = r.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (p_game_id, v_target, 'move_planned',
              jsonb_build_object('player_id', r.user_id, 'from_table_id', r.from_table_id, 'reason', 'seat_change'));
      v_moves := v_moves + 1;
      CONTINUE;
    END IF;

    -- A swap: the oldest other request whose table I would take and who
    -- would take mine. Both chairs are occupied, so both moves are linked
    -- and land together (fn_cash_seat_swap_execute).
    SELECT q.*, ts.seat_number AS their_seat INTO p
      FROM public.cash_seat_change_requests q
      JOIN unnest(v_census) c ON c.id = q.from_table_id
      JOIN public.table_seats ts ON ts.table_id = q.from_table_id AND ts.user_id = q.user_id AND ts.left_at IS NULL
     WHERE q.game_id = p_game_id AND q.status = 'requested' AND q.id <> r.id
       AND q.from_table_id <> r.from_table_id
       AND (r.to_table_id IS NULL OR q.from_table_id = r.to_table_id)
       AND (q.to_table_id IS NULL OR q.to_table_id = r.from_table_id)
       AND NOT c.breaking AND c.lifecycle = 'live'
       AND NOT (c.role = 'main' AND c.main_index = 1)
       AND coalesce(ts.stack, 0) > 0 AND coalesce(ts.leave_pending, false) = false
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = q.user_id AND m.state = 'pending')
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m
                        WHERE m.player_id = q.user_id AND m.state = 'cancelled' AND m.created_at > p_now - interval '60 seconds')
     ORDER BY q.created_at, q.id LIMIT 1;
    IF FOUND THEN
      SELECT ts.seat_number INTO v_seat_a FROM public.table_seats ts
       WHERE ts.table_id = r.from_table_id AND ts.user_id = r.user_id AND ts.left_at IS NULL;
      v_seat_b := p.their_seat;
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason, to_seat_number)
      VALUES (p_game_id, r.user_id, r.from_table_id, p.from_table_id, 'seat_change', v_seat_b)
      RETURNING id INTO v_move_a;
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason, to_seat_number, swap_move_id)
      VALUES (p_game_id, p.user_id, p.from_table_id, r.from_table_id, 'seat_change', v_seat_a, v_move_a)
      RETURNING id INTO v_move_b;
      UPDATE public.cash_seat_moves SET swap_move_id = v_move_b WHERE id = v_move_a;
      UPDATE public.cash_seat_change_requests
         SET status = 'moved', resolved_at = p_now, move_id = v_move_a, note = 'swap'
       WHERE id = r.id;
      UPDATE public.cash_seat_change_requests
         SET status = 'moved', resolved_at = p_now, move_id = v_move_b, note = 'swap'
       WHERE id = p.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (p_game_id, p.from_table_id, 'swap_planned',
              jsonb_build_object('player_id', r.user_id, 'with_player_id', p.user_id,
                                 'from_table_id', r.from_table_id, 'to_table_id', p.from_table_id));
      v_moves := v_moves + 2;
    END IF;
  END LOOP;
  RETURN v_moves;
END;
$$;

-- ── The doors ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_seat_change_request(p_game_id uuid, p_to_table_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  g record; me record; dst record; ro record; q record;
  v_position integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in first' USING ERRCODE = '28000';
  END IF;
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: the platform is on its maintenance break' USING ERRCODE = 'check_violation';
  END IF;
  -- The same lock the tick takes: a request and a tick never plan the same
  -- chair twice.
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND: %', p_game_id; END IF;
  IF NOT g.must_move THEN
    RAISE EXCEPTION 'SEAT_CHANGE_MANUAL_GAME: a manual table has no seat change' USING ERRCODE = 'check_violation';
  END IF;

  SELECT ts.table_id, ts.seat_number, ts.stack, ts.leave_pending, t.role, t.main_index, t.lifecycle, t.name
    INTO me
    FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
   WHERE ts.user_id = v_uid AND ts.left_at IS NULL AND t.cluster_id = g.id AND t.lifecycle <> 'closed'
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_IN_GAME: you are not seated in this game' USING ERRCODE = 'check_violation';
  END IF;
  IF me.role = 'main' AND me.main_index = 1 THEN
    RAISE EXCEPTION 'SEAT_CHANGE_NOT_FROM_MAIN: the main game has no seat change' USING ERRCODE = 'check_violation';
  END IF;
  IF me.lifecycle = 'breaking' THEN
    RAISE EXCEPTION 'SEAT_CHANGE_TABLE_CLOSING: this table is closing and the game is already moving you' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = v_uid AND m.state = 'pending') THEN
    RAISE EXCEPTION 'MOVE_PENDING: you are already being moved' USING ERRCODE = 'check_violation';
  END IF;

  -- Idempotent: the open request is the answer.
  SELECT * INTO q FROM public.cash_seat_change_requests
   WHERE game_id = g.id AND user_id = v_uid AND status = 'requested';
  IF FOUND THEN
    RETURN public.fn_cash_seat_change_status(g.id, v_uid);
  END IF;

  SELECT * INTO ro FROM public.cash_game_roster WHERE game_id = g.id AND user_id = v_uid AND left_at IS NULL;
  IF NOT FOUND THEN
    -- A chair that predates the roster: put them on it now, at the chair's time.
    INSERT INTO public.cash_game_roster (game_id, user_id, joined_at)
    SELECT g.id, v_uid, coalesce(min(ts.joined_at), now()) FROM public.table_seats ts
     WHERE ts.user_id = v_uid AND ts.table_id = me.table_id AND ts.left_at IS NULL
    RETURNING * INTO ro;
  END IF;
  IF ro.seat_change_used_at IS NOT NULL THEN
    RAISE EXCEPTION 'SEAT_CHANGE_USED: you have used your seat change for this game' USING ERRCODE = 'check_violation';
  END IF;

  IF p_to_table_id IS NOT NULL THEN
    SELECT * INTO dst FROM public.tables WHERE id = p_to_table_id;
    IF NOT FOUND OR dst.cluster_id IS DISTINCT FROM g.id OR coalesce(dst.is_deleted, false)
       OR dst.lifecycle NOT IN ('live', 'opening') THEN
      RAISE EXCEPTION 'SEAT_CHANGE_TABLE_UNAVAILABLE: that table is not open in this game' USING ERRCODE = 'check_violation';
    END IF;
    IF dst.role = 'main' AND dst.main_index = 1 THEN
      RAISE EXCEPTION 'SEAT_CHANGE_NEVER_TO_MAIN: the main game fills in must-move order only' USING ERRCODE = 'check_violation';
    END IF;
    IF dst.id = me.table_id THEN
      RAISE EXCEPTION 'SEAT_CHANGE_SAME_TABLE: you are already at that table' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.tables t
                    WHERE t.cluster_id = g.id AND t.id <> me.table_id AND coalesce(t.is_deleted, false) = false
                      AND t.lifecycle IN ('live', 'opening') AND NOT (t.role = 'main' AND t.main_index = 1)) THEN
      RAISE EXCEPTION 'SEAT_CHANGE_NO_OTHER_TABLE: there is no other table to change to yet' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  INSERT INTO public.cash_seat_change_requests (game_id, user_id, from_table_id, to_table_id)
  VALUES (g.id, v_uid, me.table_id, p_to_table_id);
  UPDATE public.cash_game_roster SET seat_change_used_at = now() WHERE id = ro.id;
  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (g.id, me.table_id, 'seat_change_requested',
          jsonb_build_object('player_id', v_uid, 'to_table_id', p_to_table_id));

  -- Try now: a chair open, or a partner waiting, and they are moving at
  -- their next hand boundary; otherwise they are on the list.
  PERFORM public.fn_cash_seat_change_plan(g.id, clock_timestamp());
  RETURN public.fn_cash_seat_change_status(g.id, v_uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_cash_seat_change_status(p_game_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH q AS (
    SELECT * FROM public.cash_seat_change_requests
     WHERE game_id = p_game_id AND user_id = p_user_id
     ORDER BY (status = 'requested') DESC, created_at DESC, resolved_at DESC NULLS FIRST LIMIT 1),
  m AS (
    SELECT mv.*, t.name AS to_table_name, t.role AS to_role, t.main_index AS to_main_index
      FROM public.cash_seat_moves mv JOIN public.tables t ON t.id = mv.to_table_id
     WHERE mv.game_id = p_game_id AND mv.player_id = p_user_id AND mv.state = 'pending'
       AND mv.reason = 'seat_change'
     ORDER BY mv.created_at DESC LIMIT 1)
  SELECT jsonb_build_object(
    'ok', true,
    'action', CASE WHEN (SELECT id FROM m) IS NOT NULL AND (SELECT swap_move_id FROM m) IS NOT NULL THEN 'swapping'
                   WHEN (SELECT id FROM m) IS NOT NULL THEN 'moving'
                   WHEN (SELECT status FROM q) = 'requested' THEN 'listed'
                   WHEN (SELECT status FROM q) = 'moved' THEN 'moved'
                   ELSE coalesce((SELECT status FROM q), 'none') END,
    'request_id', (SELECT id FROM q),
    'to_table_id', coalesce((SELECT to_table_id FROM m), (SELECT to_table_id FROM q)),
    'to_table_name', (SELECT to_table_name FROM m),
    'to_role', (SELECT to_role FROM m),
    'to_main_index', (SELECT to_main_index FROM m),
    'position', CASE WHEN (SELECT status FROM q) = 'requested' THEN
                  (SELECT count(*) + 1 FROM public.cash_seat_change_requests x, q
                    WHERE x.game_id = p_game_id AND x.status = 'requested' AND x.created_at < q.created_at
                      AND (q.to_table_id IS NULL OR x.to_table_id IS NULL OR x.to_table_id = q.to_table_id)) END,
    'used_at', (SELECT seat_change_used_at FROM public.cash_game_roster
                 WHERE game_id = p_game_id AND user_id = p_user_id AND left_at IS NULL));
$$;

CREATE OR REPLACE FUNCTION public.fn_cash_seat_change_cancel(p_game_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_uid uuid := auth.uid(); v_n integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in first' USING ERRCODE = '28000';
  END IF;
  PERFORM 1 FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  -- Only a request still on the list can be taken back; a planned move is
  -- already the engine's.
  UPDATE public.cash_seat_change_requests
     SET status = 'cancelled', resolved_at = now(), note = 'cancelled_by_player'
   WHERE game_id = p_game_id AND user_id = v_uid AND status = 'requested';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    -- The button comes back.
    UPDATE public.cash_game_roster SET seat_change_used_at = NULL
     WHERE game_id = p_game_id AND user_id = v_uid AND left_at IS NULL;
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (p_game_id, 'seat_change_cancelled', jsonb_build_object('player_id', v_uid));
  END IF;
  RETURN jsonb_build_object('ok', true, 'cancelled', v_n);
END;
$$;

-- ── Pending moves: the engine also learns swap and held ─────────────────────

DROP FUNCTION IF EXISTS public.fn_cash_seat_moves_pending(uuid);
CREATE FUNCTION public.fn_cash_seat_moves_pending(p_table_id uuid)
RETURNS TABLE(move_id uuid, player_id uuid, to_table_id uuid, to_table_name text, to_role text,
              to_main_index integer, reason text, announced_at timestamptz,
              swap_move_id uuid, ready_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT m.id, m.player_id, m.to_table_id, t.name, t.role, t.main_index, m.reason, m.announced_at,
         m.swap_move_id, m.ready_at
    FROM public.cash_seat_moves m
    JOIN public.tables t ON t.id = m.to_table_id
   WHERE m.from_table_id = p_table_id AND m.state = 'pending' AND m.expires_at > clock_timestamp()
   ORDER BY m.created_at;
$$;

-- ── The swap ────────────────────────────────────────────────────────────────
-- Called by the engine at the hand boundary of EITHER table (through
-- fn_cash_seat_move_execute, which routes a linked move here). The first
-- caller marks its side ready and is told to hold the player out of the
-- deal; the second lands both chairs in one transaction.

CREATE OR REPLACE FUNCTION public.fn_cash_seat_swap_execute(p_move_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  m record; pm record; a record; b record; ta record; tb record;
  v_stack_a numeric; v_stack_b numeric; v_now timestamptz := clock_timestamp();
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'frozen');
  END IF;
  -- Lock both rows in id order, whichever side calls, so two engines
  -- arriving together cannot deadlock on each other's row.
  PERFORM 1 FROM public.cash_seat_moves
   WHERE id IN (p_move_id, (SELECT swap_move_id FROM public.cash_seat_moves WHERE id = p_move_id))
   ORDER BY id FOR UPDATE;
  SELECT * INTO m FROM public.cash_seat_moves WHERE id = p_move_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF m.state <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'reason', m.state); END IF;
  SELECT * INTO pm FROM public.cash_seat_moves WHERE id = m.swap_move_id;
  IF NOT FOUND OR pm.state <> 'pending' OR pm.expires_at <= v_now OR m.expires_at <= v_now THEN
    UPDATE public.cash_seat_moves SET state = CASE WHEN m.expires_at <= v_now THEN 'expired' ELSE 'cancelled' END,
           note = 'swap_partner_gone'
     WHERE id = m.id;
    IF pm.id IS NOT NULL AND pm.state = 'pending' THEN
      UPDATE public.cash_seat_moves SET state = 'expired', note = 'swap_partner_gone' WHERE id = pm.id;
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'swap_partner_gone');
  END IF;

  SELECT * INTO a FROM public.table_seats
   WHERE table_id = m.from_table_id AND user_id = m.player_id AND left_at IS NULL FOR UPDATE;
  SELECT * INTO b FROM public.table_seats
   WHERE table_id = pm.from_table_id AND user_id = pm.player_id AND left_at IS NULL FOR UPDATE;
  IF a.id IS NULL OR b.id IS NULL OR coalesce(a.stack, 0) <= 0 OR coalesce(b.stack, 0) <= 0 THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled',
           note = CASE WHEN a.id IS NULL THEN 'player_not_seated' WHEN coalesce(a.stack, 0) <= 0 THEN 'busted' ELSE 'swap_partner_gone' END
     WHERE id = m.id;
    UPDATE public.cash_seat_moves SET state = 'cancelled',
           note = CASE WHEN b.id IS NULL THEN 'player_not_seated' WHEN coalesce(b.stack, 0) <= 0 THEN 'busted' ELSE 'swap_partner_gone' END
     WHERE id = pm.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'swap_cancelled');
  END IF;
  SELECT * INTO ta FROM public.tables WHERE id = m.to_table_id;
  SELECT * INTO tb FROM public.tables WHERE id = pm.to_table_id;
  IF ta.lifecycle IN ('breaking', 'closed') OR tb.lifecycle IN ('breaking', 'closed') THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_unavailable' WHERE id IN (m.id, pm.id);
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_unavailable');
  END IF;

  -- This side has reached its hand boundary.
  IF m.ready_at IS NULL THEN
    UPDATE public.cash_seat_moves SET ready_at = v_now WHERE id = m.id;
  END IF;
  IF pm.ready_at IS NULL THEN
    -- Hold this player out of the next deal; the other table lands the swap.
    RETURN jsonb_build_object('ok', false, 'reason', 'waiting_partner', 'held', true,
                              'to_table_id', m.to_table_id, 'partner_id', pm.player_id);
  END IF;

  -- Both ready: the two chairs change hands in one sub-transaction.
  v_stack_a := a.stack; v_stack_b := b.stack;
  PERFORM set_config('app.cash_seat_move', 'on', true);
  BEGIN
    UPDATE public.table_seats SET stack = 0 WHERE id IN (a.id, b.id);
    UPDATE public.table_seats SET left_at = v_now, leave_pending = false, status = 'left' WHERE id IN (a.id, b.id);
    -- A takes B's chair (B's row, revived under A), B takes A's.
    UPDATE public.table_seats
       SET user_id = a.user_id, member_id = a.member_id, stack = v_stack_a,
           is_sitting_out = false, sit_out_at = NULL, is_away = coalesce(a.is_away, false),
           joined_at = a.joined_at, horse_id = a.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = a.auto_rebuy, time_bank_remaining = a.time_bank_remaining,
           time_bank_uses_remaining = a.time_bank_uses_remaining, club_id = a.club_id,
           entry_hold = 'waiting', entry_post_agreed = true, left_at = NULL
     WHERE id = b.id;
    UPDATE public.table_seats
       SET user_id = b.user_id, member_id = b.member_id, stack = v_stack_b,
           is_sitting_out = false, sit_out_at = NULL, is_away = coalesce(b.is_away, false),
           joined_at = b.joined_at, horse_id = b.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = b.auto_rebuy, time_bank_remaining = b.time_bank_remaining,
           time_bank_uses_remaining = b.time_bank_uses_remaining, club_id = b.club_id,
           entry_hold = 'waiting', entry_post_agreed = true, left_at = NULL
     WHERE id = a.id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.cash_seat_move', '', true);
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = left(SQLERRM, 200) WHERE id IN (m.id, pm.id);
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_refused', 'detail', left(SQLERRM, 200));
  END;
  PERFORM set_config('app.cash_seat_move', '', true);

  UPDATE public.cash_player_session SET scope_id = m.to_table_id, table_id = m.to_table_id
   WHERE player_id = m.player_id AND scope_type = 'table' AND scope_id = m.from_table_id AND closed_at IS NULL;
  UPDATE public.cash_player_session SET scope_id = pm.to_table_id, table_id = pm.to_table_id
   WHERE player_id = pm.player_id AND scope_type = 'table' AND scope_id = pm.from_table_id AND closed_at IS NULL;

  UPDATE public.cash_seat_moves SET state = 'done', executed_at = v_now, to_seat_number = b.seat_number WHERE id = m.id;
  UPDATE public.cash_seat_moves SET state = 'done', executed_at = v_now, to_seat_number = a.seat_number WHERE id = pm.id;
  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (m.game_id, m.to_table_id, 'seat_moved',
          jsonb_build_object('player_id', m.player_id, 'from_table_id', m.from_table_id, 'to_seat', b.seat_number,
                             'stack', v_stack_a, 'reason', 'seat_change', 'swap', true)),
         (pm.game_id, pm.to_table_id, 'seat_moved',
          jsonb_build_object('player_id', pm.player_id, 'from_table_id', pm.from_table_id, 'to_seat', a.seat_number,
                             'stack', v_stack_b, 'reason', 'seat_change', 'swap', true));
  RETURN jsonb_build_object('ok', true, 'swap', true, 'to_table_id', m.to_table_id, 'to_seat_number', b.seat_number,
                            'stack', v_stack_a,
                            'partner', jsonb_build_object('player_id', pm.player_id, 'from_table_id', pm.from_table_id,
                                                          'to_table_id', pm.to_table_id, 'to_seat_number', a.seat_number,
                                                          'stack', v_stack_b));
END;
$$;

-- ── The executor: entry by reason, and a linked move is a swap ──────────────

CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_execute(p_move_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  m record; src record; dst record; v_seat integer; v_new_id uuid; v_stack numeric;
  v_hold text; v_agreed boolean;
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
  -- A LINKED MOVE IS A SWAP (2026-09-05): both chairs are occupied and both
  -- land together.
  IF m.swap_move_id IS NOT NULL THEN
    RETURN public.fn_cash_seat_swap_execute(m.id);
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

  -- ENTRY BY REASON (Dan 2026-09-05). A seat change ARRIVES at a table: it
  -- posts the big blind (held until clear if it lands between the button and
  -- the blind). A must-move or a break is NOT an arrival - the player already
  -- posted at the table they came from - so they are dealt in on the next
  -- deal with nothing owed, and take the big blind when it comes round.
  v_hold := CASE WHEN m.reason = 'seat_change' THEN 'waiting' ELSE 'moved' END;
  v_agreed := (m.reason = 'seat_change');

  -- THIS IS A MOVE (2026-09-05). The four-table cap, the one-seat-per-game
  -- door and the roster all read this: for the rest of this transaction a
  -- seat write is a player changing chairs inside one game, not entering or
  -- leaving one.
  PERFORM set_config('app.cash_seat_move', 'on', true);

  -- New chair first, then the old, in ONE sub-transaction: the player is
  -- never, even inside this transaction, seatless. Stack to zero before
  -- leaving, so trg_log_seat_stack_exit sees no chips leave a chair whose
  -- chips went to another chair. If the new chair is refused, the exception
  -- block undoes everything and the plan is cancelled with the reason.
  BEGIN
    UPDATE public.table_seats
       SET user_id = src.user_id, member_id = src.member_id, stack = v_stack,
           is_sitting_out = false, sit_out_at = NULL,
           is_away = coalesce(src.is_away, false),
           joined_at = src.joined_at,
           horse_id = src.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = src.auto_rebuy, time_bank_remaining = src.time_bank_remaining,
           time_bank_uses_remaining = src.time_bank_uses_remaining, club_id = src.club_id,
           entry_hold = v_hold, entry_post_agreed = v_agreed, left_at = NULL
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
         src.club_id, v_hold, v_agreed)
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

  RETURN jsonb_build_object('ok', true, 'to_table_id', m.to_table_id, 'to_seat_number', v_seat, 'stack', v_stack,
                            'reason', m.reason);
END;
$$;

-- ── The floor is for winners ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_session_close(p_user_id uuid, p_table_id uuid, p_stack numeric, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_t record; v_s record; v_window integer := 7200000; v_exp timestamptz; v_c record; v_now timestamptz := clock_timestamp();
BEGIN
  SELECT t.club_id, t.game_variant, t.small_blind, t.big_blind, t.tournament_id
    INTO v_t FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND OR v_t.tournament_id IS NOT NULL THEN RETURN; END IF;

  UPDATE public.cash_player_session
     SET closed_at = v_now, closed_reason = COALESCE(p_reason, 'leave')
   WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id AND closed_at IS NULL
   RETURNING * INTO v_s;
  IF FOUND THEN v_window := COALESCE(v_s.rejoin_window_ms, 7200000); END IF;

  IF COALESCE(p_stack, 0) <= 0 THEN RETURN; END IF;             -- bust-to-zero: no floor (A0.11)
  -- RATHOLE ONLY APPLIES TO WINNING PLAYERS (Dan 2026-09-05). The floor is
  -- written only when the departing stack is above the session baseline (the
  -- buy-in plus every add-on and rebuy). A player who is down leaves and
  -- comes back at the table minimum like anyone else. No session, no
  -- baseline, no floor: a chair the platform never opened a session for
  -- cannot be judged a winner.
  IF v_s.id IS NULL OR p_stack <= COALESCE(v_s.baseline, 0) THEN RETURN; END IF;
  IF v_t.club_id IS NULL OR v_t.game_variant IS NULL
     OR v_t.small_blind IS NULL OR v_t.big_blind IS NULL THEN RETURN; END IF;

  v_exp := v_now + make_interval(secs => v_window / 1000.0);

  SELECT * INTO v_c FROM public.cash_rejoin_constraints c
   WHERE c.player_id = p_user_id AND c.club_id = v_t.club_id AND c.variant = v_t.game_variant
     AND c.sb = v_t.small_blind AND c.bb = v_t.big_blind AND c.expires_at > v_now
   ORDER BY c.expires_at DESC LIMIT 1
   FOR UPDATE;
  IF FOUND THEN
    UPDATE public.cash_rejoin_constraints
       SET required_stack = GREATEST(required_stack, p_stack),
           expires_at     = GREATEST(expires_at, v_exp),
           left_at        = v_now,
           source_table_id = p_table_id
     WHERE id = v_c.id;
  ELSE
    INSERT INTO public.cash_rejoin_constraints
      (player_id, club_id, variant, sb, bb, required_stack, left_at, expires_at, source_table_id)
    VALUES (p_user_id, v_t.club_id, v_t.game_variant, v_t.small_blind, v_t.big_blind,
            p_stack, v_now, v_exp, p_table_id);
  END IF;
END;
$$;

-- A floor written for a player the closed session shows was not ahead is
-- expired now: they may sit back down at the table minimum.
UPDATE public.cash_rejoin_constraints c
   SET expires_at = clock_timestamp()
 WHERE c.expires_at > clock_timestamp()
   AND EXISTS (SELECT 1 FROM public.cash_player_session s
                WHERE s.player_id = c.player_id AND s.table_id = c.source_table_id
                  AND s.closed_at IS NOT NULL
                  AND s.closed_at BETWEEN c.left_at - interval '10 seconds' AND c.left_at + interval '10 seconds'
                  AND COALESCE(s.baseline, 0) >= c.required_stack);

-- ── Grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.fn_cash_game_roster_track() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cash_game_open_seats(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_open_seats(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_cash_game_must_move_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_must_move_list(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_cash_game_lobby(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_lobby(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_cash_seat_change_plan(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_change_plan(uuid, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_seat_change_request(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_change_request(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_cash_seat_change_status(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_change_status(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_seat_change_cancel(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_change_cancel(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_cash_seat_moves_pending(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_moves_pending(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_seat_swap_execute(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_swap_execute(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_seat_move_execute(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_move_execute(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_session_close(uuid, uuid, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_session_close(uuid, uuid, numeric, text) TO service_role;

-- ── The tick: roster order, the seat-change step, swaps are not reservations ──
-- (20260905053000's body plus exactly the edits above)

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

  -- THE ROSTER AND THE SEAT-CHANGE LIST (Dan 2026-09-05). A roster row whose
  -- player holds no chair in the game and has no move planned is closed (the
  -- seat trigger closes most of them; this catches a chair that emptied
  -- while a move was pending and the move then died). A seat change whose
  -- move was cancelled or expired goes back on the list, at its old place;
  -- the back-off in the planner gives the refusal its minute.
  UPDATE public.cash_game_roster ro SET left_at = v_now
   WHERE ro.game_id = g.id AND ro.left_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
                      WHERE ts.user_id = ro.user_id AND ts.left_at IS NULL AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed')
     AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves mv WHERE mv.player_id = ro.user_id AND mv.game_id = g.id AND mv.state = 'pending');
  UPDATE public.cash_seat_change_requests rq SET status = 'cancelled', resolved_at = v_now, note = 'left_game'
   WHERE rq.game_id = g.id AND rq.status = 'requested'
     AND NOT EXISTS (SELECT 1 FROM public.cash_game_roster ro WHERE ro.game_id = g.id AND ro.user_id = rq.user_id AND ro.left_at IS NULL);
  UPDATE public.cash_seat_change_requests rq SET status = 'requested', resolved_at = NULL, move_id = NULL, note = 'move_' || mv.state
    FROM public.cash_seat_moves mv
   WHERE rq.game_id = g.id AND rq.status = 'moved' AND rq.move_id = mv.id AND mv.state IN ('cancelled', 'expired')
     AND EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = rq.from_table_id AND ts.user_id = rq.user_id AND ts.left_at IS NULL);

  -- THE GAME WAITLIST (Gate 4, 2026-09-05). A row whose player now holds a
  -- seat in the game is `seated`; a `notified` row (the join door told them
  -- a seat was open) that has not turned into a seat in three minutes is
  -- `expired` - their browser asks again if they are still there, and the
  -- OPEN rule stops counting a buyer who left.
  UPDATE public.cash_game_waitlist w SET status = 'seated', updated_at = v_now
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified')
     AND EXISTS (SELECT 1 FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
                  WHERE ts.user_id = w.user_id AND ts.left_at IS NULL AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed');
  UPDATE public.cash_game_waitlist w SET status = 'expired', updated_at = v_now
   WHERE w.game_id = g.id AND w.status = 'notified' AND w.updated_at < v_now - interval '3 minutes';

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
         - (SELECT count(*) FROM public.cash_seat_moves m WHERE m.to_table_id = t.id AND m.state = 'pending' AND m.swap_move_id IS NULL);
    FOR r IN
      SELECT ts.user_id, ts.table_id
        FROM public.table_seats ts
        JOIN unnest(v_census) c ON c.id = ts.table_id
       WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
         -- A Main 1 seat draws from the WHOLE list (every table but Main 1);
         -- a Main N seat draws from the feeder and any breaking table.
         AND (c.role = 'feeder' OR c.breaking OR (t.main_index = 1 AND c.id <> t.id))
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
       -- THE ORDER YOU JOINED THE GAME (Dan 2026-09-05): the roster's
       -- joined_at, which survives every move; the chair's own joined_at
       -- only for a chair that predates the roster.
       ORDER BY c.breaking DESC,
                coalesce((SELECT r2.joined_at FROM public.cash_game_roster r2
                           WHERE r2.game_id = g.id AND r2.user_id = ts.user_id AND r2.left_at IS NULL), ts.joined_at) ASC,
                ts.joined_at ASC
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

  -- ── 2b. SEAT CHANGES (Dan 2026-09-05) ────────────────────────────────────
  -- After Main seats are filled in must-move order and before a feeder is
  -- opened: a requested table change takes the next unreserved chair on a
  -- table that is not Main 1, oldest request first; two requests that would
  -- take each other's table are swapped.
  v_n := public.fn_cash_seat_change_plan(g.id, v_now);
  IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('seat_changes_planned', v_n); END IF;

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
              ORDER BY coalesce((SELECT r2.joined_at FROM public.cash_game_roster r2
                                  WHERE r2.game_id = g.id AND r2.user_id = ts.user_id AND r2.left_at IS NULL), ts.joined_at),
                       ts.joined_at
    LOOP
      SELECT c.id INTO v_shortest FROM unnest(v_census) c
       WHERE c.id <> t.id AND NOT c.breaking AND c.lifecycle IN ('live', 'opening')
         AND c.open_unreserved - (SELECT count(*) FROM public.cash_seat_moves m WHERE m.to_table_id = c.id AND m.state = 'pending' AND m.swap_move_id IS NULL) > 0
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


REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) TO service_role;


-- ── Assertions: the migration checks itself, and aborts if the board moved ──

DO $chk$
DECLARE v_body text; v_exec text; v_pend text;
BEGIN
  v_body := pg_get_functiondef('public.fn_cash_cluster_tick(uuid, integer)'::regprocedure);
  IF v_body NOT LIKE '%cash_game_roster%' THEN RAISE EXCEPTION 'tick: roster order missing'; END IF;
  IF v_body NOT LIKE '%fn_cash_seat_change_plan%' THEN RAISE EXCEPTION 'tick: seat-change step missing'; END IF;
  IF v_body NOT LIKE '%swap_move_id IS NULL%' THEN RAISE EXCEPTION 'tick: swaps still count as reservations'; END IF;
  IF v_body NOT LIKE '%t.main_index = 1 AND c.id <> t.id%' THEN RAISE EXCEPTION 'tick: Main 1 does not draw from the whole list'; END IF;
  v_exec := pg_get_functiondef('public.fn_cash_seat_move_execute(uuid)'::regprocedure);
  IF v_exec NOT LIKE '%fn_cash_seat_swap_execute%' THEN RAISE EXCEPTION 'executor: swap routing missing'; END IF;
  IF v_exec NOT LIKE '%''moved''%' THEN RAISE EXCEPTION 'executor: moved entry missing'; END IF;
  v_pend := pg_get_functiondef('public.fn_cash_seat_moves_pending(uuid)'::regprocedure);
  IF v_pend NOT LIKE '%ready_at%' THEN RAISE EXCEPTION 'pending: ready_at missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cash_game_roster_track' AND tgrelid = 'public.table_seats'::regclass) THEN
    RAISE EXCEPTION 'roster trigger missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
              WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL AND t.cluster_id IS NOT NULL AND t.lifecycle <> 'closed'
                AND NOT EXISTS (SELECT 1 FROM public.cash_game_roster r
                                 WHERE r.game_id = t.cluster_id AND r.user_id = ts.user_id AND r.left_at IS NULL)) THEN
    RAISE EXCEPTION 'roster backfill left a seated player off the list';
  END IF;
END $chk$;

COMMIT;
