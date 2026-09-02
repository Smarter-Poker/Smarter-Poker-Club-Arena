-- MIRROR (zero-drift audit finding, 2026-08-31): this function existed ONLY in
-- the live database — the check that catches tournament play-chip conservation
-- drift was not version-controlled. This file is the byte-exact live
-- definition; applying it is an idempotent identical CREATE OR REPLACE.
-- Known open item: it reports an un-root-caused ~261-chip (0.012%) fractional
-- drift on multi-table events every cycle (engine multi-table split follow-up).
CREATE OR REPLACE FUNCTION public.fn_tournament_chip_conservation_check(p_tolerance_per_player numeric DEFAULT 1)
 RETURNS TABLE(tournament_id uuid, name text, players bigint, expected_chips numeric, actual_chips numeric, drift numeric, drift_per_player numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH live AS (
    SELECT t.id,
           t.name,
           COALESCE(t.starting_chips, 0) AS starting_chips,
           COALESCE(t.rebuy_chips, 0)    AS rebuy_chips,
           COALESCE(t.addon_chips, 0)    AS addon_chips,
           (SELECT count(*) FROM tournament_players tp
             WHERE tp.tournament_id = t.id) AS players,
           (SELECT COALESCE(sum(tp.rebuys), 0) FROM tournament_players tp
             WHERE tp.tournament_id = t.id) AS rebuys,
           (SELECT count(*) FROM tournament_players tp
             WHERE tp.tournament_id = t.id AND tp.add_on) AS addons,
           (SELECT COALESCE(sum(ts.stack), 0)
              FROM table_seats ts
              JOIN tables tb ON tb.id = ts.table_id
             WHERE tb.tournament_id = t.id AND ts.left_at IS NULL) AS seat_stacks
      FROM tournaments t
     WHERE t.status = 'RUNNING'
  ),
  calc AS (
    SELECT l.id, l.name, l.players,
           (l.players * l.starting_chips)
             + (l.rebuys * l.rebuy_chips)
             + (l.addons * l.addon_chips) AS expected_chips,
           l.seat_stacks AS actual_chips
      FROM live l
  )
  SELECT c.id, c.name, c.players,
         round(c.expected_chips, 2),
         round(c.actual_chips, 2),
         round(c.actual_chips - c.expected_chips, 2),
         round((c.actual_chips - c.expected_chips) / NULLIF(c.players, 0), 3)
    FROM calc c
   WHERE c.players > 0
     AND abs(c.actual_chips - c.expected_chips)
         > (GREATEST(p_tolerance_per_player, 0) * c.players)
   ORDER BY abs(c.actual_chips - c.expected_chips) DESC;
$function$;

-- ---------------------------------------------------------------------------
-- AND THE GRANTS PRODUCTION ALREADY HAS (added by the agent landing this
-- bundle, after check-definer-authorization blocked the push).
--
-- The guard was right, and right about the case this file exists for: REPLAY.
-- Live, this function is already closed to the browser (anon false,
-- authenticated false, service_role true) because a later phase-4 migration
-- revoked it. But a bare CREATE OR REPLACE ... SECURITY DEFINER in a fresh
-- database is created with the default PUBLIC grant, so replaying this file
-- alone would rebuild an exposure production has already closed. On the day
-- Midway Union is rebuilt from these files, that is the whole difference.
--
-- Its only caller is the engine (server/src/services/RakebackSettlerService.ts)
-- as service_role, so the browser roles lose nothing.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_tournament_chip_conservation_check(numeric) FROM PUBLIC, anon, authenticated;
