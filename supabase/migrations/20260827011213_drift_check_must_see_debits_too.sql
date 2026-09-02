-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827011213; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- MY BUG, caught by the drift number refusing to be zero.
--
-- The first cut of fn_chip_drift_since_baseline identified a ledger row's
-- player with:
--
--     coalesce(cl.to_entity_id, cl.from_entity_id)
--
-- inherited from the 2026-04 reconcile, where rows populated only ONE side.
-- The new trigger populates BOTH sides, so on a DEBIT (player -> treasury)
-- `to_entity_id` holds the CLUB and the coalesce never reaches
-- `from_entity_id`. Every debit was therefore attributed to the club and
-- counted as zero movement for the player, which showed up as 80 members
-- "drifting" with a net of -18,963: precisely the buy-ins, missing.
--
-- A reconciliation that cannot see money leaving is worse than none, because
-- it reports a shortfall that is not there and hides one that is. Match on
-- the side that actually names a player instead.

CREATE OR REPLACE FUNCTION public.fn_chip_drift_since_baseline()
RETURNS TABLE (
  club_id uuid, user_id uuid,
  opening_balance numeric, movements_since numeric,
  expected numeric, actual numeric, drift numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH span AS (SELECT MIN(taken_at) AS t0 FROM public.ca_chip_baseline),
  moves AS (
    SELECT cl.club_id AS c_id,
           /* The player is whichever side is typed player_wallet. Never a
              coalesce: both sides are populated now. */
           CASE WHEN cl.to_type = 'player_wallet' THEN cl.to_entity_id
                ELSE cl.from_entity_id END AS u_id,
           SUM(CASE WHEN cl.to_type   = 'player_wallet' THEN cl.amount ELSE 0 END)
         - SUM(CASE WHEN cl.from_type = 'player_wallet' THEN cl.amount ELSE 0 END) AS net
    FROM public.chip_ledger cl, span
    WHERE cl.club_id IS NOT NULL
      AND cl.created_at >= span.t0
      AND (cl.to_type = 'player_wallet' OR cl.from_type = 'player_wallet')
    GROUP BY 1, 2
  )
  SELECT b.club_id, b.user_id, b.opening_balance,
         COALESCE(m.net, 0)                              AS movements_since,
         b.opening_balance + COALESCE(m.net, 0)          AS expected,
         COALESCE(cm.chip_balance, 0)                    AS actual,
         COALESCE(cm.chip_balance, 0) - (b.opening_balance + COALESCE(m.net, 0)) AS drift
  FROM public.ca_chip_baseline b
  JOIN public.club_members cm
    ON cm.club_id = b.club_id AND cm.user_id = b.user_id
  LEFT JOIN moves m
    ON m.c_id = b.club_id AND m.u_id = b.user_id;
$$;

COMMENT ON FUNCTION public.fn_chip_drift_since_baseline() IS
  'Drift that happened AFTER auditing was restored on 2026-08-26. Non-zero means chips moved without a ledger row, on our watch. Identifies the player by which SIDE is typed player_wallet - a coalesce over the two entity ids silently drops every debit. The pre-baseline gap is excluded: it is unknowable, not zero.';

REVOKE ALL ON FUNCTION public.fn_chip_drift_since_baseline() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_chip_drift_since_baseline() TO service_role, authenticated;
