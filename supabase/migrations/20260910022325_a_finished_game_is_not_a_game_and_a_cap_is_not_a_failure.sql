-- 20260910022109_a_finished_game_is_not_a_game_and_a_cap_is_not_a_failure.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (2026-09-10, incident
-- Tournament.atomic_satellite_finish_refused, satellite
-- 9fee70de-c692-48fb-a423-98d730ab02bc "Friday Night Feature Satellite
-- Heads-Up", 38.00 pool, stuck RUNNING for 16+ hours):
--
-- The engine finished the satellite and called
-- fn_settle_satellite_finish_atomic. Delivery of the winner's 30.00 target
-- entry goes through fn_deliver_satellite_ticket_exact, which decided the
-- target was open and called fn_award_satellite_seat. That inserted a
-- tournament_players row on the target, trg_enforce_booking_game_cap counted
-- the winner's games with fn_concurrent_game_load, found 5, and raised
-- "FOUR TABLE LIMIT ... may not enter another". The atomic settlement caught
-- the exception, returned atomic_satellite_settlement_failed with
-- retryable=false, and the satellite could never complete: the winner's
-- entitlement stayed unpaid, the 38.00 stayed in escrow, and every retry
-- produced the same refusal. Two defects, read from the rows:
--
-- 1. fn_concurrent_game_load counted the winner's OWN seat at the satellite
--    that was finishing. A seat at a table whose tournament is COMPLETING,
--    COMPLETED or CANCELLED is not a game the player can still play; it is
--    exactly as much history as a seat at a closed table, which clause (1)
--    already excludes. The only reason the satellite seat was still open is
--    that seats are vacated AFTER settlement. So a winner in three other games
--    was refused the seat he had just won because the game he won it in was
--    counted against him.
--
-- 2. fn_deliver_satellite_ticket_exact never asked whether the winner could
--    legally take the seat. It already classifies "target closed", "target
--    full", "target economics changed" and "seat held elsewhere" as reasons
--    to deliver the frozen ticket value as cash through the exact obligation
--    path. The four-table cap is the same class of reason - the seat cannot
--    be given - but instead of choosing cash it tried the seat and let the
--    trigger blow up the whole settlement. The non-atomic gate path
--    (fn_settle_satellite_tournament_pre_money_path_gate) has known this
--    since it was written: it checks fn_concurrent_game_load before it plans
--    a seat. The atomic path, the one the engine calls, did not.
--
-- THE FIX, hard-coded at both lines:
--
-- - fn_concurrent_game_load clause (1) excludes a seat whose table belongs to
--   a tournament in COMPLETING / COMPLETED / CANCELLED. Every cap check in the
--   platform (booking cap, seat cap, satellite gate, fleet audit) reads this
--   one function, so they all agree.
-- - fn_deliver_satellite_ticket_exact takes the same per-user advisory lock the
--   cap triggers take, reads the same load the booking trigger will read for
--   the same target, and if the winner is at the cap it delivers the frozen
--   ticket value as cash (reason four_table_cap) instead of attempting a seat
--   the trigger is bound to refuse. The settlement can no longer fail on the
--   cap: it is decided before any write.
--
-- The stuck satellite is settled in the next migration, after this one is
-- live, because a probe never carries DDL (CLAUDE.md section 2 rule 7) and the
-- settlement had to be proven in a rolled-back transaction first (11.5).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. A finished game is not a game.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_concurrent_game_load(p_user_id uuid, p_exclude_seat_id uuid DEFAULT NULL::uuid, p_exclude_table_id uuid DEFAULT NULL::uuid, p_exclude_tournament_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (
    -- (1) A LIVE SEAT IS A GAME. A seat at a closed table is history.
    -- A FINISHED GAME IS NOT A GAME (2026-09-10): a seat at a table whose
    -- tournament is COMPLETING, COMPLETED or CANCELLED is history too. Seats
    -- are vacated after settlement, so during settlement the winner of a
    -- satellite still "sat" at it, and that seat was counted against the
    -- target entry he had just won.
    (
      SELECT count(*)
        FROM public.table_seats ts
        JOIN public.tables t ON t.id = ts.table_id
       WHERE ts.user_id = p_user_id
         AND ts.left_at IS NULL
         AND t.status <> 'closed'
         AND NOT EXISTS (
           SELECT 1
             FROM public.tournaments tr1
            WHERE tr1.id = t.tournament_id
              AND tr1.status IN ('COMPLETING', 'COMPLETED', 'CANCELLED')
         )
         AND (p_exclude_seat_id IS NULL OR ts.id IS DISTINCT FROM p_exclude_seat_id)
         AND (p_exclude_table_id IS NULL OR ts.table_id IS DISTINCT FROM p_exclude_table_id)
    )
    +
    -- (2) A BOOKING IS A GAME FROM ONE HOUR BEFORE ITS TOURNAMENT STARTS
    -- UNTIL THE TOURNAMENT STARTS (2026-09-06). RUNNING is absent
    -- deliberately: its entrants hold seats, counted by clause (1). A booking
    -- for an event further out than an hour is a plan, not a game - counting
    -- it from registration held 217 horses off the cash floor for events up
    -- to 68 hours away. A NULL start_time is a seat-first game that starts
    -- when it fills, so it always counts.
    (
      SELECT count(*)
        FROM public.tournament_players tp
        JOIN public.tournaments tr ON tr.id = tp.tournament_id
       WHERE tp.user_id = p_user_id
         AND tp.status IN ('registered', 'playing')
         AND tr.status IN ('ANNOUNCED', 'REGISTERING')
         AND (tr.start_time IS NULL OR tr.start_time <= now() + interval '60 minutes')
         AND (p_exclude_tournament_id IS NULL
              OR tp.tournament_id IS DISTINCT FROM p_exclude_tournament_id)
         -- NEVER BOTH. A seat-first game sells the chair before it starts, so
         -- a booking and a seat can describe the same game for a few minutes.
         AND NOT EXISTS (
           SELECT 1
             FROM public.table_seats ts2
             JOIN public.tables t2 ON t2.id = ts2.table_id
            WHERE ts2.user_id = p_user_id
              AND ts2.left_at IS NULL
              AND t2.status <> 'closed'
              AND t2.tournament_id = tp.tournament_id
         )
    )
  )::int;
$function$;

-- ---------------------------------------------------------------------------
-- 2. A cap is not a failure: decide cash before any write, never blow up.
--    Asserted text substitution on the live definition: the anchor must
--    appear exactly once, and the result must contain the new branch once.
-- ---------------------------------------------------------------------------
DO $body$
DECLARE
  v_def    text;
  v_anchor text := E'  IF NOT v_open THEN\n    RETURN jsonb_build_object(''delivery'',''cash'',''reason'',v_cash_reason);\n  END IF;';
  v_new    text := E'  -- A CAP IS NOT AN ECONOMIC FAILURE (2026-09-10). The four-table cap is\n'
                || E'  -- enforced by trg_enforce_booking_game_cap on the target registration\n'
                || E'  -- that fn_award_satellite_seat writes. Attempting the seat and letting\n'
                || E'  -- that trigger raise turned one refused chair into a settlement that\n'
                || E'  -- could never complete (satellite 9fee70de, 16 hours RUNNING). Take the\n'
                || E'  -- same per-user lock the triggers take, read the same count the booking\n'
                || E'  -- trigger will read for this target, and deliver the frozen value as\n'
                || E'  -- cash - exactly as a closed or full target already does.\n'
                || E'  IF v_open THEN\n'
                || E'    PERFORM pg_advisory_xact_lock(hashtextextended(''table_cap:'' || p_user_id::text, 0));\n'
                || E'    IF public.fn_concurrent_game_load(p_user_id, NULL, NULL, p_target_id) >= 4 THEN\n'
                || E'      v_open := false;\n'
                || E'      v_cash_reason := ''four_table_cap'';\n'
                || E'    END IF;\n'
                || E'  END IF;\n'
                || E'  IF NOT v_open THEN\n'
                || E'    RETURN jsonb_build_object(''delivery'',''cash'',''reason'',v_cash_reason);\n'
                || E'  END IF;';
  v_n      integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_deliver_satellite_ticket_exact';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_deliver_satellite_ticket_exact is missing';
  END IF;
  IF position('four_table_cap' IN v_def) > 0 THEN
    RAISE NOTICE 'fn_deliver_satellite_ticket_exact already carries the cap branch; nothing to do';
    RETURN;
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'anchor appears % times in fn_deliver_satellite_ticket_exact, expected exactly 1', v_n;
  END IF;
  v_def := replace(v_def, v_anchor, v_new);
  EXECUTE v_def;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_deliver_satellite_ticket_exact';
  v_n := (length(v_def) - length(replace(v_def, 'four_table_cap', ''))) / length('four_table_cap');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'post-condition: four_table_cap appears % times, expected 1', v_n;
  END IF;
  IF position('fn_concurrent_game_load(p_user_id, NULL, NULL, p_target_id) >= 4' IN v_def) = 0 THEN
    RAISE EXCEPTION 'post-condition: the cap read is not the booking trigger''s read';
  END IF;
END
$body$;

-- ---------------------------------------------------------------------------
-- 3. Post-conditions on the load function.
-- ---------------------------------------------------------------------------
DO $body$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_concurrent_game_load';
  IF position('tr1.status IN (''COMPLETING'', ''COMPLETED'', ''CANCELLED'')' IN v_def) = 0 THEN
    RAISE EXCEPTION 'post-condition: fn_concurrent_game_load does not exclude finished games';
  END IF;
  -- The four cap readers still resolve to this one function.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN
         ('fn_enforce_booking_game_cap', 'fn_enforce_four_table_limit',
          'fn_settle_satellite_tournament_pre_money_path_gate', 'fn_deliver_satellite_ticket_exact')
         AND p.prosrc LIKE '%fn_concurrent_game_load(%') <> 4 THEN
    RAISE EXCEPTION 'post-condition: a cap reader no longer reads fn_concurrent_game_load';
  END IF;
END
$body$;

COMMIT;
