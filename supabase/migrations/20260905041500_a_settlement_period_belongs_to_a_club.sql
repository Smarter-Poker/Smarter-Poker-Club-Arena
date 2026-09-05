-- ═══════════════════════════════════════════════════════════════════════════
--  A SETTLEMENT PERIOD BELONGS TO A CLUB
--  Club Operations upgrade, phase 7 of 8. 2026-09-05.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `/clubs/<slug>/settlement` asks `get_current_settlement_period()`, which
-- takes no club argument at all:
--
--     FROM settlement_periods sp WHERE sp.status = 'open'
--    ORDER BY sp.start_at DESC LIMIT 1
--
-- the newest open period ON THE PLATFORM, whoever is looking. Measured today,
-- that single open row is `5a9811f0`, **club_id NULL**, union-scoped, running
-- 2026-08-16 to 2026-08-23 - three weeks stale and belonging to no club. So
-- every club's settlement page has been headed by the same period, which is
-- not that club's, and in the reference club's case is not any club's.
--
-- The client then made it worse in a way the table did not deserve. Every
-- figure the header shows is a real column on `settlement_periods` -
-- `period_number`, `year`, `total_bbj_contributions`, `total_player_winnings`,
-- `total_player_losses`, `total_hands_dealt` - and `SettlementService` threw
-- all of them away: `periodNumber: 1`, `year: new Date().getFullYear()`, and
-- four hardcoded zeroes. Hence the permanent "Period 1/2026" over a grid of
-- zeros, on a page whose data was sitting one SELECT away. (One period in the
-- table carries 4,719.32 of rake, 259.07 of drop and 267,312 hands.)
--
-- This adds a club-scoped overload rather than changing the existing one: the
-- no-argument function is still called by the union surfaces, and a period
-- lookup is not the place to change what an existing caller receives.
--
-- WHICH PERIOD IS "THIS CLUB'S", in order:
--   1. the club's own OPEN period;
--   2. failing that, the club's own most recent period that is not yet
--      settled (processing or disputed) - work that is still in flight;
--   3. failing that, the open period of the union the club belongs to, marked
--      as the union's so the page can say whose it is;
--   4. failing that, the club's most recent period of any status.
-- Nothing is invented: when a club has never had a period and its union has
-- none open, the function returns no rows and the page says so.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '0';

CREATE OR REPLACE FUNCTION public.get_current_settlement_period(p_club_id uuid)
RETURNS TABLE(
  id uuid,
  club_id uuid,
  union_id uuid,
  scope text,
  period_number integer,
  year integer,
  period_start timestamptz,
  period_end timestamptz,
  status text,
  total_rake numeric,
  total_bbj numeric,
  total_player_winnings numeric,
  total_player_losses numeric,
  total_hands_dealt bigint,
  settled_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN;
  END IF;
  -- Any member may see which period their club is in; the money inside it is
  -- gated by the reads that return it, not by this lookup.
  IF NOT public.ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT c.union_id INTO v_union FROM clubs c WHERE c.id = p_club_id;

  RETURN QUERY
  WITH candidates AS (
    SELECT sp.*,
           CASE
             WHEN sp.club_id = p_club_id AND sp.status = 'open'                   THEN 1
             WHEN sp.club_id = p_club_id AND sp.status IN ('processing','disputed') THEN 2
             WHEN sp.club_id IS NULL AND v_union IS NOT NULL
                  AND sp.union_id = v_union AND sp.status = 'open'                THEN 3
             WHEN sp.club_id = p_club_id                                          THEN 4
           END AS rank
      FROM settlement_periods sp
     WHERE sp.club_id = p_club_id
        OR (sp.club_id IS NULL AND v_union IS NOT NULL AND sp.union_id = v_union
            AND sp.status = 'open')
  )
  SELECT c.id, c.club_id, c.union_id,
         CASE WHEN c.club_id = p_club_id THEN 'club' ELSE 'union' END,
         c.period_number, c.year, c.start_at, c.end_at, c.status::text,
         COALESCE(c.total_rake_collected, 0),
         COALESCE(c.total_bbj_contributions, 0),
         COALESCE(c.total_player_winnings, 0),
         COALESCE(c.total_player_losses, 0),
         COALESCE(c.total_hands_dealt, 0)::bigint,
         c.settled_at
    FROM candidates c
   WHERE c.rank IS NOT NULL
   ORDER BY c.rank, c.start_at DESC
   LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.get_current_settlement_period(uuid) IS
  'The settlement period THIS club is in, with every figure the row actually carries. The no-argument overload returns the newest open period on the platform regardless of club, which is what the club settlement page used to head itself with.';

REVOKE ALL ON FUNCTION public.get_current_settlement_period(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_settlement_period(uuid) TO authenticated, service_role;

DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_current_settlement_period';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected the no-argument lookup and the club-scoped one, found %', v_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_current_settlement_period'
       AND pg_get_function_identity_arguments(p.oid) = 'p_club_id uuid'
       AND p.prosrc LIKE '%total_hands_dealt%'
  ) THEN
    RAISE EXCEPTION 'the club-scoped period still does not return what the row carries';
  END IF;
END $$;

COMMIT;
