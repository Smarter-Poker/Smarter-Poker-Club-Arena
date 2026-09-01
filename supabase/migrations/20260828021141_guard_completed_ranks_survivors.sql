-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828021141; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Money-path audit 2026-08-27, lane: payouts / conservation
--
-- CRITICAL - 751 players finished a tournament and were never ranked. Across 125
-- COMPLETED tournaments, 699 rows are still status='playing' with a null position:
-- the event was force-completed without ranking the survivors, so places 2..N had
-- no identifiable holder and fn_tournament_payout_reconcile refused to pay them.
-- Union Grand Championship (NLH): 30 entrants, 2,500 pool, a payout structure
-- summing to exactly 100, and one prize credit of 750.00 - place 1's 30% went out
-- and the other 70% evaporated.
--
-- The audit's remedy was "block the COMPLETED write while any row is 'playing'".
-- A hard block is the wrong shape: the engine force-completes precisely when it
-- has lost track of the table, so raising there would strand the tournament in
-- RUNNING forever and convert a payout bug into a stuck-event bug. Instead this
-- ranks the survivors in the same statement, immediately before the row flips.
-- The write always succeeds and always leaves every place owned.
--
-- Ranking rule: survivors take the free positions - the places not already held
-- by an eliminated player or a declared winner - in ascending order, assigned by
-- chips descending. On the example above that is places 2..28 handed to the 27
-- survivors by stack, which is the correct poker result.
--
-- Also stamps ended_at when the engine omitted it. 65 events are currently stuck
-- on ended_at IS NULL holding 953.07 of rake the settler cannot claim; this stops
-- that class from growing.

CREATE OR REPLACE FUNCTION public.fn_rank_survivors(p_tournament_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_ranked integer := 0;
  v_bound  integer;
BEGIN
  SELECT GREATEST(COUNT(*), COALESCE(MAX(position), 0))
    INTO v_bound
    FROM tournament_players
   WHERE tournament_id = p_tournament_id;

  IF COALESCE(v_bound, 0) = 0 THEN
    RETURN 0;
  END IF;

  WITH taken AS (
    SELECT DISTINCT position
      FROM tournament_players
     WHERE tournament_id = p_tournament_id
       AND position IS NOT NULL
  ),
  survivors AS (
    SELECT id,
           row_number() OVER (
             ORDER BY COALESCE(chips, 0) DESC,
                      COALESCE(chip_count, 0) DESC,
                      registered_at ASC,
                      id ASC
           ) AS rn
      FROM tournament_players
     WHERE tournament_id = p_tournament_id
       AND position IS NULL
  ),
  free AS (
    SELECT g AS pos, row_number() OVER (ORDER BY g) AS rn
      FROM generate_series(1, v_bound) g
     WHERE NOT EXISTS (SELECT 1 FROM taken tk WHERE tk.position = g)
  )
  UPDATE tournament_players tp
     SET position      = f.pos,
         status        = CASE WHEN f.pos = 1 THEN 'winner' ELSE 'eliminated' END,
         eliminated_at = CASE WHEN f.pos = 1 THEN tp.eliminated_at
                              ELSE COALESCE(tp.eliminated_at, now()) END
    FROM survivors s
    JOIN free f ON f.rn = s.rn
   WHERE tp.id = s.id;

  GET DIAGNOSTICS v_ranked = ROW_COUNT;
  RETURN v_ranked;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.trg_tournaments_rank_before_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_ranked integer;
BEGIN
  v_ranked := public.fn_rank_survivors(NEW.id);

  IF NEW.ended_at IS NULL THEN
    NEW.ended_at := now();
  END IF;

  IF COALESCE(v_ranked, 0) > 0 THEN
    RAISE LOG 'tournament % completed with % unranked survivor(s); ranked by chips before the status flip',
      NEW.id, v_ranked;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS tournaments_rank_before_complete ON public.tournaments;

CREATE TRIGGER tournaments_rank_before_complete
BEFORE UPDATE ON public.tournaments
FOR EACH ROW
WHEN (NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED')
EXECUTE FUNCTION public.trg_tournaments_rank_before_complete();

REVOKE ALL ON FUNCTION public.fn_rank_survivors(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_rank_survivors(uuid) TO service_role;
