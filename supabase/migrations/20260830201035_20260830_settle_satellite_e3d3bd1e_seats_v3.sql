-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830201035; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Settle the Sunday Deep Stack Satellite $25 (e3d3bd1e) and put its five seats
-- into the relaunched Main Event. See v2 for the full reasoning. v1 aborted on
-- the four-table cap; v2 aborted because fn_tournament_unregister_counter is
-- BROKEN — it updates a column `registered_count` that does not exist on
-- tournaments, so every call raises 42703. That function is dead on arrival
-- and is reported separately; the decrement it was supposed to do is inlined
-- here against the columns that actually exist.
--
-- THE CAP IS NOT BYPASSED. All three unseated winners sit at exactly the
-- four-game limit. Each gives up their furthest-out, cheapest booking (all
-- tomorrow or later, 0.00-10.00 buy-ins) to take the 200.00 seat they won
-- tonight, refunded through atomic_tournament_unregister, with the vacated
-- event's pool and headcount corrected. Two winners already hold a seat in the
-- target and are skipped rather than re-inserted — an insert trips the cap
-- before the unique constraint can dedupe, which is how v1 died.
--
-- All five are horses, seated exactly as humans would be. No is_horse branch.
-- Per newly awarded seat: +180.00 prize_pool, +20.00 total_rake, one
-- rake_records row — the identical split a direct buy-in produces.

DO $$
DECLARE
  v_sat    uuid := 'e3d3bd1e-d74c-403f-8d78-dd3c2436d879';
  v_target uuid := 'dfae9288-40e2-485d-8c97-a13dd53ab483';
  v_status text;
  v_pool0  numeric;
  v_pool1  numeric;
  r        record;
  d        record;
  v_res    jsonb;
  v_freed  int := 0;
  v_new    int := 0;
  v_kept   int := 0;
BEGIN
  SELECT status, prize_pool INTO v_status, v_pool0 FROM tournaments WHERE id = v_target;
  IF v_status NOT IN ('ANNOUNCED','REGISTERING') THEN
    RAISE EXCEPTION 'Target is % — seats cannot be awarded into it', v_status;
  END IF;

  WITH ranked AS (
    SELECT user_id, row_number() OVER (ORDER BY chips DESC) AS pos
      FROM tournament_players
     WHERE tournament_id = v_sat AND status = 'playing'
  )
  UPDATE tournament_players tp
     SET position = ranked.pos, status = 'eliminated', chips = 0
    FROM ranked
   WHERE tp.tournament_id = v_sat AND tp.user_id = ranked.user_id;

  UPDATE tournament_players
     SET status = 'winner'
   WHERE tournament_id = v_sat AND position = 1;

  FOR r IN
    SELECT user_id, username, position
      FROM tournament_players
     WHERE tournament_id = v_sat AND position BETWEEN 1 AND 5
     ORDER BY position
  LOOP
    IF EXISTS (SELECT 1 FROM tournament_players
                WHERE tournament_id = v_target AND user_id = r.user_id) THEN
      UPDATE tournament_players
         SET is_satellite_qualifier = true
       WHERE tournament_id = v_target AND user_id = r.user_id;
      v_kept := v_kept + 1;
      CONTINUE;
    END IF;

    IF public.fn_concurrent_game_load(r.user_id, NULL, NULL, v_target) >= 4 THEN
      SELECT t.id, t.name, t.buy_in_amount, t.buy_in_fee
        INTO d
        FROM tournament_players tp
        JOIN tournaments t ON t.id = tp.tournament_id
       WHERE tp.user_id = r.user_id
         AND tp.status = 'registered'
         AND t.status IN ('ANNOUNCED','REGISTERING')
         AND t.id <> v_target
       ORDER BY t.start_time DESC,
                (COALESCE(t.buy_in_amount,0) + COALESCE(t.buy_in_fee,0)) ASC
       LIMIT 1;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Winner % is at the cap with no droppable booking', r.username;
      END IF;

      IF NOT public.atomic_tournament_unregister(
                d.id, r.user_id,
                COALESCE(d.buy_in_amount,0) + COALESCE(d.buy_in_fee,0)) THEN
        RAISE EXCEPTION 'Could not free a booking for %', r.username;
      END IF;

      -- Inlined because fn_tournament_unregister_counter is broken (see header).
      UPDATE tournaments
         SET prize_pool      = GREATEST(COALESCE(prize_pool,0) - COALESCE(d.buy_in_amount,0), 0),
             current_players = GREATEST(COALESCE(current_players,0) - 1, 0),
             updated_at      = now()
       WHERE id = d.id;

      v_freed := v_freed + 1;
      RAISE NOTICE '% freed a seat by leaving % (refunded %)',
        r.username, d.name, COALESCE(d.buy_in_amount,0) + COALESCE(d.buy_in_fee,0);
    END IF;

    SELECT public.fn_award_satellite_seat(v_sat, v_target, r.user_id, r.username) INTO v_res;
    IF coalesce(v_res->>'ok','false') <> 'true' THEN
      RAISE EXCEPTION 'Seat award failed for % (pos %): %', r.username, r.position, v_res->>'reason';
    END IF;
    IF coalesce(v_res->>'awarded','false') = 'true' THEN
      v_new := v_new + 1;
    ELSE
      v_kept := v_kept + 1;
    END IF;
  END LOOP;

  IF v_new + v_kept <> 5 THEN
    RAISE EXCEPTION 'Expected to process 5 seats, processed %', v_new + v_kept;
  END IF;

  UPDATE tournaments
     SET status = 'COMPLETED', ended_at = now(), prize_pool_finalized = true, updated_at = now()
   WHERE id = v_sat;

  IF EXISTS (SELECT 1 FROM tournament_players
              WHERE tournament_id = v_sat AND position IS NULL) THEN
    RAISE EXCEPTION 'Satellite still has unplaced players';
  END IF;

  SELECT prize_pool INTO v_pool1 FROM tournaments WHERE id = v_target;
  IF v_pool1 <> v_pool0 + (v_new * 180.00) THEN
    RAISE EXCEPTION 'Prize pool moved % -> %, expected +% for % new seat(s)',
      v_pool0, v_pool1, v_new * 180.00, v_new;
  END IF;

  RAISE NOTICE 'Satellite settled: % new seat(s), % already seated, % booking(s) freed. Pool % -> %.',
    v_new, v_kept, v_freed, v_pool0, v_pool1;
END $$;
