-- the_knockout_door_owns_every_bust_a_hand_took
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT WAS HAPPENING (2026-09-10, read from rows, not guessed):
--
-- The engine records a bust through one door: fn_eliminate_tournament_player_atomic
-- (fn_claim_tournament_bounty_elimination for bounty events). The door demands
-- the knockout candidate the accepted hand froze, assigns the finishing place
-- from the ladder, records the prize entitlement, resolves the candidate and
-- releases the exact seat generation - one transaction.
--
-- Two pg_cron sweeps were racing that door. fn_ca_eliminate_absent_tournament_players
-- (job 362, every 15 minutes, dwell 10 minutes) marks a seatless zero-stack
-- player `eliminated` with chips 0 and POSITION NULL - "places are the
-- normalizer's to assign at the finish". It could not do that until migration
-- 20260910002804 (00:28 today) taught it to read the felt; from then on it
-- worked, and every player it took was one the engine's door was already
-- holding: measured at 07:12, ALL 1,270 eliminated-without-a-place rows in
-- the 44 RUNNING tournaments carried a `pending` knockout candidate - a hand
-- had taken every one of those stacks. The sweep took 69 in the 00:00 hour,
-- 254 in the 04:00 hour, 346 in the first fifteen minutes of 07:00.
--
-- Why that kills the event: fn_complete_tournament_entry_reprice, the proof
-- the engine must obtain after late registration closes, counts an eliminated
-- row without a place as an unfinished reprice ("mismatches"). It can never
-- pass while one such row exists, so reconcileTournamentEntryWindow returns
-- false, and TournamentManagerEliminations.runEliminationSweep returns BEFORE
-- the bust stage - by design, so a lost reprice cannot be acknowledged. The
-- engine therefore records no elimination at all in that event. Its busted
-- players sit seatless at zero, ten minutes later the sweep takes them too,
-- and the tournament can neither eliminate nor finish. Twenty RUNNING events
-- were in that state at 07:04 (2dbc9bb6 with 357 live and 97 busted players
-- waiting, 33883f12 with 134 stolen rows, db79a6df / cef15ddb / c5fce798
-- refusing the proof 84 times in sixteen minutes each), and the engine logged
-- 1,611 frames under Tournament.entry_window_reprice_unproven in that window.
-- Incident b03db5f2 ("absent players", critical) is this loop seen from the
-- detector's side.
--
-- THE FIX, at the root (CLAUDE.md 10.11 / 10.12):
--
--   1. The two sweeps are unscheduled. They are repair jobs and they were
--      repairing the wrong thing; the door they raced is the live path. Both
--      are entered in docs/BAND-AIDS-REGISTER.md with the retirement that
--      deletes them (20260910000850 on main, part of the seat-authority
--      cutover).
--   2. The two functions refuse any player whose latest knockout candidate is
--      not `rebought` - that bust belongs to the door - so a stray manual call
--      cannot repeat this.
--   3. The 1,270 stolen rows are put back exactly as they were before the
--      sweep took them: status playing, chips 0, no eliminated_at. Each still
--      has its pending candidate, so the door records it properly - place,
--      prize, bounty, seat generation - the moment the proof passes, which it
--      now does: the migration asserts zero reprice mismatches for every
--      RUNNING receipt still awaiting completion.
--   4. An eliminated row without a finishing place can no longer be written
--      into a RUNNING, COMPLETING or COMPLETED tournament by anybody: that is
--      the constraint trigger in the next migration,
--      an_elimination_without_a_place_cannot_be_written. It is separate
--      because CREATE TRIGGER locks tournament_players for the rest of its
--      transaction, and the first attempt at doing both in one transaction
--      deadlocked against an engine hand commit (40P01, 07:19) - the row
--      return waits on tournament row locks that the engine holds while the
--      engine waits on the table lock the DDL took (production DDL policy 7).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. the sweeps stop
DO $body$
DECLARE r record; v_n integer := 0;
BEGIN
  FOR r IN SELECT jobid, jobname FROM cron.job
            WHERE command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
               OR command ILIKE '%fn_ca_release_broke_seats%'
  LOOP
    PERFORM cron.unschedule(r.jobid);
    v_n := v_n + 1;
  END LOOP;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected to unschedule the two bust sweeps, found %', v_n;
  END IF;
END
$body$;

-- 2. the functions refuse a bust the door is holding
DO $body$
DECLARE
  v_def text; v_n integer;
  v_a1 text := E'     WHERE t.status = ''RUNNING''\n       AND p.status IN (''playing'', ''registered'')\n';
  v_a1n text := E'     WHERE t.status = ''RUNNING''\n       AND p.status IN (''playing'', ''registered'')\n'
     || E'       /* THE KNOCKOUT DOOR OWNS EVERY BUST A HAND TOOK (2026-09-10): a player\n'
     || E'          whose latest knockout candidate is not ''rebought'' was busted by an\n'
     || E'          accepted hand and belongs to fn_eliminate_tournament_player_atomic.\n'
     || E'          This sweep took 1,270 of them in seven hours, each without a\n'
     || E'          finishing place, and the reprice proof then refused every event. */\n'
     || E'       AND COALESCE((SELECT c.state FROM public.tournament_knockout_candidates c\n'
     || E'                       WHERE c.tournament_id = t.id AND c.eliminated_user_id = p.user_id\n'
     || E'                       ORDER BY c.hand_number DESC, c.id DESC LIMIT 1), ''rebought'') = ''rebought''\n';
  v_b1 text := E'     WHERE t.status = ''RUNNING''\n       AND tp.status IN (''playing'', ''registered'')\n';
  v_b1n text := E'     WHERE t.status = ''RUNNING''\n       AND tp.status IN (''playing'', ''registered'')\n'
     || E'       /* THE KNOCKOUT DOOR OWNS EVERY BUST A HAND TOOK (2026-09-10): see\n'
     || E'          fn_ca_eliminate_absent_tournament_players. */\n'
     || E'       AND COALESCE((SELECT c.state FROM public.tournament_knockout_candidates c\n'
     || E'                       WHERE c.tournament_id = t.id AND c.eliminated_user_id = tp.user_id\n'
     || E'                       ORDER BY c.hand_number DESC, c.id DESC LIMIT 1), ''rebought'') = ''rebought''\n';
BEGIN
  SELECT pg_get_functiondef('public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)'::regprocedure) INTO v_def;
  IF position('THE KNOCKOUT DOOR OWNS EVERY BUST' IN v_def) = 0 THEN
    v_n := (length(v_def) - length(replace(v_def, v_a1, ''))) / length(v_a1);
    IF v_n <> 1 THEN RAISE EXCEPTION 'eliminator anchor appears % times, expected 1', v_n; END IF;
    EXECUTE replace(v_def, v_a1, v_a1n);
  END IF;
  SELECT pg_get_functiondef('public.fn_ca_release_broke_seats(integer,integer,boolean)'::regprocedure) INTO v_def;
  IF position('THE KNOCKOUT DOOR OWNS EVERY BUST' IN v_def) = 0 THEN
    v_n := (length(v_def) - length(replace(v_def, v_b1, ''))) / length(v_b1);
    IF v_n <> 1 THEN RAISE EXCEPTION 'releaser anchor appears % times, expected 1', v_n; END IF;
    EXECUTE replace(v_def, v_b1, v_b1n);
  END IF;
END
$body$;

-- 3. the stolen busts go back to the door, and the proof passes
DO $body$
DECLARE
  v_stolen integer; v_other integer; v_rows integer; v_bad integer; v_batched integer;
BEGIN
  SELECT count(*) FILTER (WHERE latest = 'pending'), count(*) FILTER (WHERE latest IS DISTINCT FROM 'pending')
    INTO v_stolen, v_other
    FROM (
      SELECT (SELECT c.state FROM public.tournament_knockout_candidates c
               WHERE c.tournament_id = tp.tournament_id AND c.eliminated_user_id = tp.user_id
               ORDER BY c.hand_number DESC, c.id DESC LIMIT 1) AS latest
        FROM public.tournament_players tp
        JOIN public.tournaments t ON t.id = tp.tournament_id
       WHERE t.status = 'RUNNING' AND tp.status = 'eliminated' AND tp.position IS NULL
    ) x;
  IF v_other <> 0 THEN
    RAISE EXCEPTION '% eliminated-without-a-place rows in RUNNING events have no pending knockout candidate; this migration only returns busts the door is holding', v_other;
  END IF;
  SELECT count(*) INTO v_batched
    FROM public.tournament_players tp
    JOIN public.tournaments t ON t.id = tp.tournament_id
   WHERE t.status = 'RUNNING' AND tp.status = 'eliminated' AND tp.position IS NULL
     AND EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches b WHERE b.tournament_id = t.id);
  IF v_batched <> 0 THEN
    RAISE EXCEPTION '% stolen rows belong to events with a settlement batch; refusing to touch a prepared result', v_batched;
  END IF;

  /* Lock every affected event first, in the order the roster trigger itself
     uses (fn_lock_tournament_launch_proof_parents: launch receipt, then the
     tournament, each by id). The trigger takes the receipt NOWAIT and raises
     TOURNAMENT_TRANSITION_BUSY if an engine transaction holds it; taking both
     here, waiting, before the first row is written means the trigger finds
     them already ours. Taking them per row in table order against a live
     engine is how the first attempt deadlocked. */
  PERFORM 1 FROM public.tournament_launch_receipts r
   WHERE r.tournament_id IN (
     SELECT t.id FROM public.tournaments t
      WHERE t.status = 'RUNNING'
        AND EXISTS (SELECT 1 FROM public.tournament_players tp
                     WHERE tp.tournament_id = t.id AND tp.status = 'eliminated' AND tp.position IS NULL))
   ORDER BY r.tournament_id FOR UPDATE;
  PERFORM 1 FROM public.tournaments t
   WHERE t.status = 'RUNNING'
     AND EXISTS (SELECT 1 FROM public.tournament_players tp
                  WHERE tp.tournament_id = t.id AND tp.status = 'eliminated' AND tp.position IS NULL)
   ORDER BY t.id FOR UPDATE;

  UPDATE public.tournament_players tp
     SET status = 'playing', chips = 0, eliminated_at = NULL
    FROM public.tournaments t
   WHERE t.id = tp.tournament_id AND t.status = 'RUNNING'
     AND tp.status = 'eliminated' AND tp.position IS NULL
     AND (SELECT c.state FROM public.tournament_knockout_candidates c
           WHERE c.tournament_id = tp.tournament_id AND c.eliminated_user_id = tp.user_id
           ORDER BY c.hand_number DESC, c.id DESC LIMIT 1) = 'pending';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_stolen THEN
    RAISE EXCEPTION 'returned % rows to the door, expected %', v_rows, v_stolen;
  END IF;

  -- every RUNNING receipt still awaiting its reprice proof must now prove
  -- clean, by the proof's own non-satellite formula
  SELECT count(*) INTO v_bad
    FROM public.tournament_entry_close_receipts r
    JOIN public.tournaments t ON t.id = r.tournament_id
   WHERE t.status = 'RUNNING' AND r.reprice_completed_at IS NULL
     AND NOT (lower(COALESCE(t.variant,'')) = 'satellite' OR upper(COALESCE(t.tournament_type,'')) = 'SATELLITE'
              OR t.satellite_target_id IS NOT NULL OR t.satellite_target IS NOT NULL)
     AND EXISTS (
       SELECT 1
         FROM public.tournament_players tp
         LEFT JOIN public.fn_ca_tournament_place_amounts(t.id) a ON a.place = tp.position
        WHERE tp.tournament_id = t.id AND tp.status = 'eliminated'
          AND (tp.position IS NULL OR tp.prize IS DISTINCT FROM COALESCE(a.amount, 0)));
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% RUNNING receipts would still fail the reprice proof after the return', v_bad;
  END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'fn_ca_eliminate_absent_tournament_players (pg_cron job 362) recorded seatless zero-stack players eliminated with no finishing place ten minutes after a hand busted them, ahead of the engine''s knockout door. fn_complete_tournament_entry_reprice counts such a row as an unfinished reprice, so the proof refused every affected event and TournamentManagerEliminations.runEliminationSweep returned before its bust stage: no elimination could be recorded, more players sat busted and seatless, and the sweep took those too. Fixed in migration the_knockout_door_owns_every_bust_a_hand_took: both sweeps unscheduled and made to refuse any bust a hand took, an eliminated row without a place is refused by constraint trigger, and the 1,270 stolen rows were returned to the door.',
         correction_ref = 'migration the_knockout_door_owns_every_bust_a_hand_took',
         resolution = 'Every seatless busted player carried a pending knockout candidate; returned to status playing / chips 0 so fn_eliminate_tournament_player_atomic records each with its place, prize and bounty as the accepted hand determined. The detector will read a transient count while the engine drains them.'
   WHERE i.status = 'open' AND i.source = 'fn_ca_conservation_sweep:fn_ca_absent_tournament_players';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'expected to resolve 1 absent-players incident, resolved %', v_rows; END IF;
END
$body$;

COMMIT;
