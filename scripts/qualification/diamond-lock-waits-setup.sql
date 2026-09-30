-- Diamond Phase 11 line 5: the scale-out fixture for scripts/qualification/diamond-lock-waits.py.
-- Runs on the isolated tests/sql accepted-hand fixture AFTER the live doors are loaded
-- (diamond-lock-waits-live-doors.sql). Psql variables: tables, seats, per_player.
-- K Diamond plain-cash tables in the fixture arena, `seats` players seated at each through the live
-- reserve door, every player at `per_player` tables at once (multi-tabling), each with one settled
-- purchase lot so settles walk the lot-reservation path. Nothing here ever leaves this cluster.
DO $$ BEGIN
 IF current_database()<>'poker_diamond_phase6_accepted_test' OR inet_server_addr() IS NOT NULL
    OR current_setting('port')<>'55472' THEN RAISE EXCEPTION 'isolated diamond lock-wait fixture only'; END IF;
END $$;
\set ON_ERROR_STOP on
SET client_min_messages = warning;
CREATE TABLE IF NOT EXISTS perf_tables(idx integer PRIMARY KEY, table_id uuid NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS perf_players(idx integer PRIMARY KEY, user_id uuid NOT NULL UNIQUE);
CREATE SEQUENCE IF NOT EXISTS perf_hand_number START 1000001;
TRUNCATE perf_tables, perf_players;

BEGIN;
-- Tables: the fixture arena's own table row, K times.
INSERT INTO perf_tables SELECT g, ('30000000-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid
  FROM generate_series(0, :tables - 1) g;
INSERT INTO public.tables(id, club_id, min_buy_in, max_buy_in, status, game_variant)
  SELECT table_id, '20000000-0000-0000-0000-000000000001', 10, 100000, 'active', 'nlh' FROM perf_tables;
-- Players: seats*tables/per_player of them, each with Diamonds and one settled purchase lot.
INSERT INTO perf_players SELECT g, ('10000000-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid
  FROM generate_series(0, (:tables * :seats) / :per_player - 1) g;
INSERT INTO public.profiles(id, diamonds) SELECT user_id, 10000000 FROM perf_players;
INSERT INTO public.diamond_purchase_lots(user_id, issued, created_at)
  SELECT user_id, 1000000, now() - interval '60 days' FROM perf_players;
-- Seats: slot j = table*seats + seat goes to player j mod P, so every player sits at
-- per_player distinct tables. Custody through the live reserve door, then the seat,
-- then the custody binds to it (the shape tests/sql/poker-diamond-cash-custody-setup.sql uses).
CREATE TEMP TABLE perf_slots AS
  SELECT t.idx AS t_idx, t.table_id, s AS seat_number, p.user_id, gen_random_uuid() AS seat_id
    FROM perf_tables t CROSS JOIN generate_series(1, :seats) s
    JOIN perf_players p ON p.idx = ((t.idx * :seats + s - 1) % ((:tables * :seats) / :per_player));
CREATE TEMP TABLE perf_custody AS
  SELECT slot.*, (public.fn_poker_diamond_reserve(slot.user_id, 'cash_seat', slot.table_id,
          'seat:'||slot.seat_id, 1000, gen_random_uuid())->>'custody_id')::uuid AS custody_id
    FROM perf_slots slot;
INSERT INTO public.table_seats(id, table_id, user_id, seat_number, stack, joined_at, club_id)
  SELECT seat_id, table_id, user_id, seat_number, 1000, '2026-09-30T00:00:00Z',
         '20000000-0000-0000-0000-000000000001' FROM perf_custody;
UPDATE public.poker_diamond_custody c SET state='active', seat_id=s.id, seat_joined_at=s.joined_at,
       occupancy_id=s.occupancy_id
  FROM perf_custody pc JOIN public.table_seats s ON s.id = pc.seat_id WHERE c.id = pc.custody_id;
COMMIT;

-- The live deferred guard, as production has it on table_seats (fires at every commit).
DROP TRIGGER IF EXISTS zzz_diamond_seat_keeps_custody ON public.table_seats;
CREATE CONSTRAINT TRIGGER zzz_diamond_seat_keeps_custody AFTER INSERT OR DELETE OR UPDATE ON public.table_seats
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_poker_diamond_seat_keeps_custody();

-- One settled hand at one table: the hand's players are every seat at the table; two of them put
-- ten Diamonds each into the pot and one of the two takes it. The settlement lane the engine's
-- commit path shares, then the live Diamond settle door (table row, then every player's wallet,
-- seats, custody, lots, receipt). Refuses loudly if the door refuses.
CREATE OR REPLACE FUNCTION perf_settle(p_idx integer) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_t uuid; v_hand bigint; v_roster jsonb; v_n integer; v_a integer; v_b integer; v_stacks jsonb; v_r jsonb;
BEGIN
  SELECT table_id INTO STRICT v_t FROM perf_tables WHERE idx = p_idx;
  -- The engine is the only writer of its table's seats between hands, so the stacks it sends
  -- are the stacks on disk. Here other sessions top up at this table, so the roster is read
  -- under the table row the settle door takes first anyway: the payload cannot go stale.
  PERFORM 1 FROM public.tables WHERE id = v_t FOR UPDATE;
  v_hand := nextval('perf_hand_number');
  PERFORM public.fn_ca_share_settlement_lane_for_table(v_t);
  SELECT jsonb_agg(jsonb_build_object('user_id', s.user_id, 'seat_id', s.id,
           'seat_joined_at', s.joined_at, 'stack_before', s.stack::bigint) ORDER BY s.user_id), count(*)
    INTO v_roster, v_n FROM public.table_seats s WHERE s.table_id = v_t AND s.left_at IS NULL;
  v_a := floor(random() * v_n)::integer;
  v_b := (v_a + 1 + floor(random() * (v_n - 1))::integer) % v_n;
  IF (v_roster->v_a->>'stack_before')::bigint < 10 THEN
    SELECT v_b, v_a INTO v_a, v_b;
  END IF;
  SELECT jsonb_agg(CASE WHEN o - 1 = v_a THEN e || jsonb_build_object('stack', (e->>'stack_before')::bigint - 10)
                        WHEN o - 1 = v_b THEN e || jsonb_build_object('stack', (e->>'stack_before')::bigint + 10)
                        ELSE e || jsonb_build_object('stack', (e->>'stack_before')::bigint) END ORDER BY o)
    INTO v_stacks FROM jsonb_array_elements(v_roster) WITH ORDINALITY x(e, o);
  v_r := public.fn_poker_diamond_settle_cash_hand(v_t, v_hand, v_stacks, 0, 0, NULL, 0);
  IF (v_r->>'success')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'perf_settle refused: %', v_r;
  END IF;
  RETURN v_r;
END $f$;

-- A mid-session top-up, as the engine sends it between hands: the stack the engine holds for a
-- seated player, one Diamond, through the live top-up door (or the table-first order the harness
-- lays over it). The door's own verdicts - a stack that moved under the request (a hand settled
-- first), a seat at its maximum - are answered, not raised: they are not lock waits. A deadlock is
-- raised, and pgbench counts it.
CREATE OR REPLACE FUNCTION perf_topup(p_idx integer) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_t uuid; v_u uuid; v_stack numeric;
BEGIN
  SELECT table_id INTO STRICT v_t FROM perf_tables WHERE idx = p_idx;
  SELECT s.user_id, s.stack INTO v_u, v_stack FROM public.table_seats s
   WHERE s.table_id = v_t AND s.left_at IS NULL ORDER BY random() LIMIT 1;
  BEGIN
    RETURN public.fn_poker_diamond_top_up(v_u, v_t, 1, v_stack, gen_random_uuid());
  EXCEPTION WHEN SQLSTATE '55000' OR SQLSTATE '23514' THEN
    RETURN jsonb_build_object('refused', SQLERRM);
  END;
END $f$;

ANALYZE;
SELECT json_build_object('tables', (SELECT count(*) FROM perf_tables), 'players', (SELECT count(*) FROM perf_players),
  'seats', (SELECT count(*) FROM public.table_seats WHERE left_at IS NULL AND table_id IN (SELECT table_id FROM perf_tables)),
  'active_custody', (SELECT count(*) FROM public.poker_diamond_custody WHERE state='active'),
  'max_tables_per_player', (SELECT max(n) FROM (SELECT count(*) n FROM public.table_seats s JOIN perf_tables t ON t.table_id=s.table_id GROUP BY s.user_id) x));
