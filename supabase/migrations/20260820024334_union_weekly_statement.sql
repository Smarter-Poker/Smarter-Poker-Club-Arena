-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820024334 "union_weekly_statement"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5317bafc443e266ff9a4d5cf41ace734 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- THE MONDAY STATEMENT, IN DAN'S TERMS (2026-08-19)
--
--   "rake is held by the union, but players inside the clubs generate the
--    rake and get credited... each club then squares up what their club won
--    or lost with the union each monday. so total lost minus rake back =
--    pay or collect amount."
--
-- Until now those were two disconnected mechanisms — a rakeback close and a
-- player-P&L settlement — and neither produced the one number a club actually
-- cares about. This is that number.
--
--   rake_generated   rake this club's players paid, attributed from
--                    rake_records.player_contributions
--   rakeback_owed    rake_generated x club_commission_rate (0.90 default)
--   player_net       what the club's players won (+) or lost (-) on union
--                    tables, realized flows plus the change in chips still
--                    sitting on the felt
--   pay_or_collect   POSITIVE  = the club PAYS the union
--                    NEGATIVE  = the club COLLECTS from the union
--
-- The arithmetic is exactly Dan's sentence: what the club lost, less what it
-- gets back. Because a player's loss already includes the rake they paid,
-- returning 90% of it leaves the union with its 10% — so a club that only
-- ever paid rake settles at one tenth of it, which is the intended margin
-- rather than a coincidence.
--
-- Read-only. It reports; it does not move a chip.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_union_weekly_statement(
  p_union_id uuid,
  p_start timestamptz DEFAULT NULL,
  p_end   timestamptz DEFAULT NULL
) RETURNS TABLE (
  club_id uuid,
  club_name text,
  rake_generated numeric,
  commission_rate numeric,
  rakeback_owed numeric,
  player_won numeric,
  player_lost numeric,
  player_net numeric,
  pay_or_collect numeric,
  direction text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_start timestamptz;
  v_end   timestamptz;
BEGIN
  -- Default to the week that the next Monday close will settle.
  v_end   := COALESCE(p_end, now());
  v_start := COALESCE(p_start, v_end - interval '7 days');

  RETURN QUERY
  WITH basis AS (
    SELECT b.club_id, b.rake_share
      FROM fn_union_rake_basis_by_club(p_union_id, v_start, v_end) b
  ),
  pnl AS (
    SELECT p.club_id, p.realized_net, p.seated_stack, p.winnings, p.losses
      FROM fn_union_pnl_all_clubs(p_union_id, v_start, v_end) p
  ),
  baseline AS (
    SELECT (e->>'club_id')::uuid AS club_id, (e->>'seated_end')::numeric AS seated_start
      FROM jsonb_array_elements(
             COALESCE(fn_union_pnl_baseline(p_union_id, v_end), '[]'::jsonb)) e
  )
  SELECT
    uc.club_id,
    c.name::text,
    COALESCE(bs.rake_share, 0),
    COALESCE(uc.club_commission_rate, 0.90),
    round(COALESCE(bs.rake_share, 0) * COALESCE(uc.club_commission_rate, 0.90), 2),
    COALESCE(pn.winnings, 0),
    COALESCE(pn.losses, 0),
    -- what the club's players actually netted, felt included
    round(COALESCE(pn.realized_net, 0)
          + (COALESCE(pn.seated_stack, 0) - COALESCE(bl.seated_start, pn.seated_stack, 0)), 2),
    -- Dan's formula: total lost, less the rakeback returned
    round(
      -(COALESCE(pn.realized_net, 0)
        + (COALESCE(pn.seated_stack, 0) - COALESCE(bl.seated_start, pn.seated_stack, 0)))
      - COALESCE(bs.rake_share, 0) * COALESCE(uc.club_commission_rate, 0.90), 2),
    CASE
      WHEN round(
             -(COALESCE(pn.realized_net, 0)
               + (COALESCE(pn.seated_stack, 0) - COALESCE(bl.seated_start, pn.seated_stack, 0)))
             - COALESCE(bs.rake_share, 0) * COALESCE(uc.club_commission_rate, 0.90), 2) > 0
        THEN 'club pays union'
      WHEN round(
             -(COALESCE(pn.realized_net, 0)
               + (COALESCE(pn.seated_stack, 0) - COALESCE(bl.seated_start, pn.seated_stack, 0)))
             - COALESCE(bs.rake_share, 0) * COALESCE(uc.club_commission_rate, 0.90), 2) < 0
        THEN 'union pays club'
      ELSE 'square'
    END::text
  FROM union_clubs uc
  JOIN clubs c ON c.id = uc.club_id
  LEFT JOIN basis bs ON bs.club_id = uc.club_id
  LEFT JOIN pnl   pn ON pn.club_id = uc.club_id
  LEFT JOIN baseline bl ON bl.club_id = uc.club_id
  WHERE uc.union_id = p_union_id
  ORDER BY 9 DESC;
END $$;

REVOKE ALL ON FUNCTION fn_union_weekly_statement(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_weekly_statement(uuid, timestamptz, timestamptz) TO authenticated, service_role;
