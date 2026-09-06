-- 20260906011318_the_feeder_tables_stay_within_one_player_of_each_other.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE FEEDER TABLES STAY WITHIN ONE PLAYER OF EACH OTHER (Dan 2026-09-05)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- MEASURED, from Dan's capture of NLH 0.05/0.10 Classic: 39 players, 5 tables,
-- seated 9 / 9 / 9 / 9 / 3. Dan: "feeder games must be balanced, there
-- shouldn't be 3 tables of 9 and one table of [3] ... feeder games should stay
-- balanced as best as possible", and: research what the proper table balancing
-- is for feeder games and mirror it.
--
-- WHAT A CARD ROOM ACTUALLY DOES, and what this mirrors:
--
--   1. THE MAIN GAME IS FED, NEVER BALANCED. A must-move table exists so one
--      full game of that limit is always running; when a seat opens in the
--      main game the top of the must-move list is compelled into it. Main 1 is
--      therefore held FULL on purpose and is not part of the balancing pool.
--      That half already exists here - step 2 of fn_cash_cluster_tick - and
--      this migration does not touch it.
--   2. THE MUST-MOVE TABLES ARE BALANCED AMONG THEMSELVES. What was missing.
--      The standard is one player: a table may be one short of another, never
--      two. (The TDA states the same threshold from the other end - full-table
--      play HALTS on a table three or more players short of the largest, so
--      the balancing rule that keeps that from happening is "within one".)
--      Four nines and a three is five tables away from that.
--   3. A PREDETERMINED PROCEDURE PICKS THE TABLE, not anyone's discretion. In
--      a feeder chain that order is stated as "starting on the LAST table and
--      working their way to the main table", so ties here break toward the
--      NEWEST table giving up a player and the table CLOSEST to the main game
--      receiving one.
--   4. THE LAST TO ARRIVE IS THE ONE ASKED TO MOVE. When a room balances into
--      a short table it is the newest arrivals who go; the established game is
--      left alone. This uses the same clock everything else in this cluster
--      uses - cash_game_roster.joined_at, the must-move order - read from the
--      other end.
--
--      The TDA's own balancing rule is "move the player who will be the next
--      big blind, into the worst position". IT IS NOT USED HERE AND THAT IS
--      DELIBERATE: this database does not hold the button. tables has
--      first_button_seat (a seed) and nothing else; the running dealer_seat
--      lives in hand_state_snapshots and in tables.live_state, both of which
--      are the engine's in-flight state and neither of which is safe to read
--      from a planner that runs on a five-second clock between hands. Reading
--      a stale button and moving the WRONG player is worse than moving a
--      deterministic one, and a blind is not dodged either way: a planned move
--      executes at the player's next hand boundary and
--      fn_cash_seat_move_execute seats them with entry_hold = 'moved', which
--      is the "post the big blind when it comes round" entry. Nobody gains a
--      free orbit from being balanced.
--
-- Moving a player between must-move tables does NOT change their place on the
-- must-move list. The list is ordered by cash_game_roster.joined_at across the
-- whole game and is blind to which table you sit at, so a balance move cannot
-- delay or advance anybody's turn at the main game. That is why a lateral move
-- is safe to make on the room's terms rather than the player's.
--
-- LAW 10.5, HORSES ARE PLAYERS: there is no is_horse anywhere below. A horse
-- is balanced exactly like a human, moved by the same rule, into the same
-- seats, on the same clock. A filter here would be the same bug as the one
-- that cost 39 tournaments their rake attribution.
--
-- ONE MOVE PER GAME PER PASS. The planner is called from
-- fn_cash_clusters_tick_all once per tick (5 s), plans at most one move, and
-- stops. A six-player gap therefore closes over about fifteen seconds, one
-- player at a time - which is also the pace a floor moves at, and it means a
-- transient count (a table mid-deal, a seat about to be filled by the
-- must-move step that runs first) never triggers a cascade of moves that the
-- next tick has to undo.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── The fourth reason a chair moves ──────────────────────────────────────
-- must_move (up to the main game), break (this table is closing), seat_change
-- (the player asked), and now balance (the room evened the tables). The
-- executor already treats everything that is not 'seat_change' the same way -
-- entry_hold = 'moved', not agreed - so 'balance' needs no branch there, only
-- room in this constraint and its own sentence in the notice.
ALTER TABLE public.cash_seat_moves DROP CONSTRAINT IF EXISTS cash_seat_moves_reason_check;
ALTER TABLE public.cash_seat_moves ADD CONSTRAINT cash_seat_moves_reason_check
  CHECK (reason = ANY (ARRAY['must_move'::text, 'break'::text, 'seat_change'::text, 'balance'::text]));

-- ── The planner ─────────────────────────────────────────────────────────
-- Returns the number of moves planned (0 or 1). Reads the same census every
-- other step reads, so it can never disagree with the tick about who is
-- seated where.
CREATE OR REPLACE FUNCTION public.fn_cash_cluster_balance(
  p_game_id uuid,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_census public.cash_cluster_census_row[];
  v_planned integer := 0;
  v_from uuid;
  v_to uuid;
  v_player uuid;
BEGIN
  v_census := public.fn_cash_cluster_census(p_game_id, p_now);

  /*
   * ONE STATEMENT, so the pool, the pair and the mover are all decided
   * against the same snapshot. Splitting it would let the fullest table
   * change between choosing it and choosing whom to take from it.
   *
   * `n` is the PROJECTED headcount - what the table will hold once every
   * pending move lands - not the live one. Without that, a table that has
   * already been given three players by the must-move step (which runs first,
   * in the same pass) still reads as short and is handed three more.
   */
  WITH pool AS (
    SELECT c.id,
           c.main_index,
           c.created_at,
           c.seated
             - (SELECT count(*) FROM public.cash_seat_moves m
                 WHERE m.from_table_id = c.id AND m.state = 'pending')
             + (SELECT count(*) FROM public.cash_seat_moves m
                 WHERE m.to_table_id = c.id AND m.state = 'pending') AS n,
           c.open_unreserved
             - (SELECT count(*) FROM public.cash_seat_moves m
                 WHERE m.to_table_id = c.id AND m.state = 'pending' AND m.swap_move_id IS NULL) AS room
      FROM unnest(v_census) c
     -- The pool is every LIVE table of the game except the main game. A
     -- breaking table is already emptying (step 5 owns it) and an opening one
     -- has not started; neither is balanced.
     WHERE c.lifecycle = 'live'
       AND NOT c.breaking
       AND NOT (c.role = 'main' AND c.main_index = 1)
  ),
  -- The fullest gives up a player; ties go to the NEWEST table, which is the
  -- feeder end of the chain (main_index IS NULL on a feeder, so NULLS FIRST
  -- on a DESC sort puts feeders ahead of mains).
  hi AS (
    SELECT * FROM pool ORDER BY n DESC, main_index DESC NULLS FIRST, created_at DESC LIMIT 1
  ),
  -- The shortest with a chair actually free receives; ties go to the table
  -- closest to the main game.
  lo AS (
    SELECT * FROM pool WHERE room > 0
     ORDER BY n ASC, main_index ASC NULLS LAST, created_at ASC LIMIT 1
  ),
  /*
   * WITHIN ONE PLAYER IS BALANCED. A gap of one is the normal state of an odd
   * headcount and must not start a move that the next tick reverses.
   *
   * AND BALANCING NEVER MAKES TWO TABLES THAT CANNOT DEAL. Without the two
   * floors below, a cluster holding a Main 2 with two players and a live table
   * with none reads as a gap of two, and the "fix" is to move one player and
   * leave 1 and 1 - two tables that cannot deal a hand, out of one that could.
   * A room does not balance a thin game, it BREAKS one, and the tick's step 5
   * already does exactly that once everyone fits elsewhere. So:
   *
   *   hi.n >= 3   the table giving up a player still has 2 afterwards;
   *   lo.n >= 1   the table receiving one has 2 afterwards.
   *
   * A live table at 0 or 1 is a break candidate, not a destination, and the
   * step that owns it is the one that should have it.
   */
  pair AS (
    SELECT hi.id AS from_id, lo.id AS to_id
      FROM hi, lo
     WHERE hi.id <> lo.id
       AND hi.n - lo.n >= 2
       AND hi.n >= 3
       AND lo.n >= 1
  ),
  mover AS (
    SELECT p.from_id, p.to_id, ts.user_id
      FROM pair p
      JOIN public.table_seats ts ON ts.table_id = p.from_id AND ts.left_at IS NULL
     WHERE ts.user_id IS NOT NULL
       -- NOT WITH NOTHING, NOT WHILE LEAVING (the same two guards the
       -- must-move step carries): a busted seat is inside its rebuy window and
       -- a leave_pending seat is already on its way out.
       AND coalesce(ts.stack, 0) > 0
       AND coalesce(ts.leave_pending, false) = false
       AND NOT EXISTS (SELECT 1 FROM public.table_seats d
                        WHERE d.table_id = p.to_id AND d.user_id = ts.user_id AND d.left_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m
                        WHERE m.player_id = ts.user_id AND m.state = 'pending')
       -- BACK-OFF: a move the engine just refused is not re-planned every 5 s.
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m
                        WHERE m.player_id = ts.user_id AND m.state = 'cancelled'
                          AND m.created_at > p_now - interval '60 seconds')
     -- THE LAST TO ARRIVE MOVES. The roster's joined_at is the game's own
     -- clock and survives every previous move; the chair's joined_at is the
     -- fallback for a chair that predates the roster row.
     ORDER BY coalesce((SELECT r.joined_at FROM public.cash_game_roster r
                         WHERE r.game_id = p_game_id AND r.user_id = ts.user_id AND r.left_at IS NULL),
                       ts.joined_at) DESC,
              ts.joined_at DESC
     LIMIT 1
  ),
  ins AS (
    INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
    SELECT p_game_id, m.user_id, m.from_id, m.to_id, 'balance' FROM mover m
    RETURNING player_id, from_table_id, to_table_id
  )
  -- At most one row by construction (mover is LIMIT 1), so the first element
  -- of each aggregate IS the move; count is 0 or 1 and everything else null.
  SELECT count(*)::integer,
         (array_agg(i.from_table_id))[1],
         (array_agg(i.to_table_id))[1],
         (array_agg(i.player_id))[1]
    INTO v_planned, v_from, v_to, v_player
    FROM ins i;

  IF coalesce(v_planned, 0) > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
    VALUES (p_game_id, v_to, 'move_planned',
            jsonb_build_object('player_id', v_player, 'from_table_id', v_from, 'reason', 'balance'));
  END IF;

  RETURN coalesce(v_planned, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_balance(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_balance(uuid, timestamptz) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_balance(uuid, timestamptz) IS
  'Plans at most one balancing move between the must-move tables of one cash cluster, keeping them within one player of each other (Dan 2026-09-05). Main 1 is fed and never balanced. Called once per game per pass from fn_cash_clusters_tick_all, after the tick.';

-- ── The pass calls it ───────────────────────────────────────────────────
-- Re-emitted in full (the house pattern: a migration owns the whole body it
-- changes). The ONLY differences from 20260905091025 are the balance call
-- inside each game's own sub-block, the two counters it feeds, and this note.
-- Inside the sub-block on purpose: a balance planner that throws must cost
-- that one game its pass, exactly as a failing tick does, and never the pass.
CREATE OR REPLACE FUNCTION public.fn_cash_clusters_tick_all(p_eligible jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  w record;
  v_now timestamptz := clock_timestamp();
  v_games integer := 0;
  v_ticked integer := 0;
  v_errors integer := 0;
  v_rested integer := 0;
  v_balanced integer := 0;
  v_bal integer;
  v_eligible integer;
  v_res jsonb;
  v_results jsonb := '[]'::jsonb;
  v_sqlstate text;
  v_message text;
BEGIN
  -- THE FREEZE (CLAUDE.md 13): the same short-circuit the per-game tick has,
  -- taken once for the pass so a frozen platform costs one row read.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'skipped', 'frozen',
                              'games', 0, 'ticked', 0, 'errors', 0, 'rested', 0,
                              'balanced', 0,
                              'results', '[]'::jsonb);
  END IF;

  FOR w IN
    SELECT l.game_id, l.club_id, l.main1_table_id, l.state, l.enabled,
           g.last_tick_at,
           coalesce((p_eligible ->> (l.main1_table_id::text))::integer, 0) AS eligible,
           EXISTS (
             SELECT 1
               FROM public.tables t
               JOIN public.table_seats ts ON ts.table_id = t.id AND ts.left_at IS NULL
              WHERE t.cluster_id = l.game_id
                AND t.lifecycle <> 'closed'
           ) AS anyone_seated
      FROM public.fn_cash_clusters_to_tick() l
      JOIN public.cash_games g ON g.id = l.game_id
     ORDER BY g.created_at
  LOOP
    v_games := v_games + 1;

    -- DUE? Live, disabled, occupied or wanted: every pass. Otherwise every 30 s.
    IF NOT (
         w.state = 'live'
      OR NOT w.enabled
      OR w.anyone_seated
      OR w.eligible > 0
      OR w.last_tick_at IS NULL
      OR w.last_tick_at < v_now - interval '30 seconds'
    ) THEN
      v_rested := v_rested + 1;
      CONTINUE;
    END IF;

    v_eligible := w.eligible;
    BEGIN
      v_res := public.fn_cash_cluster_tick(w.game_id, v_eligible);
      v_ticked := v_ticked + 1;
      -- THE TABLES STAY WITHIN ONE PLAYER (Dan 2026-09-05). After the tick,
      -- never before it: the must-move step has just filled the main game's
      -- open seats from the list, and balancing against the board as it was
      -- BEFORE that would move players the tick was about to move anyway.
      v_bal := public.fn_cash_cluster_balance(w.game_id, v_now);
      v_balanced := v_balanced + coalesce(v_bal, 0);
      v_results := v_results || jsonb_build_object(
        'game_id', w.game_id,
        'main1_table_id', w.main1_table_id,
        'enabled', w.enabled,
        'balanced', coalesce(v_bal, 0),
        'result', coalesce(v_res, '{}'::jsonb)
      );
    EXCEPTION WHEN OTHERS THEN
      -- The sub-block rolled this game's tick back; the pass goes on. The
      -- error is a row, not a log line, so the next agent can find it.
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
      v_errors := v_errors + 1;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (w.game_id, w.main1_table_id, 'controller_tick_error',
              jsonb_build_object('sqlstate', v_sqlstate, 'message', v_message));
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true,
                            'games', v_games,
                            'ticked', v_ticked,
                            'errors', v_errors,
                            'rested', v_rested,
                            'balanced', v_balanced,
                            'results', v_results);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_cash_clusters_tick_all(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_clusters_tick_all(jsonb) TO service_role;

COMMIT;
