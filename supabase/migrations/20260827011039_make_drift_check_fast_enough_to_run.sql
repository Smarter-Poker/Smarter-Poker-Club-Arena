-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827011039; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The first cut of fn_chip_drift_since_baseline used a LATERAL, which meant
-- 1,502 sequential scans of an 88k-row chip_ledger and a statement timeout. A
-- reconciliation nobody can afford to run is a reconciliation nobody runs, so
-- this is a correctness issue, not a tuning one.
--
-- Rewritten as ONE grouped pass joined to the baseline, plus the index that
-- pass wants. Same arithmetic, same result.

CREATE INDEX IF NOT EXISTS idx_chip_ledger_club_to_created
  ON public.chip_ledger (club_id, to_entity_id, created_at);

CREATE INDEX IF NOT EXISTS idx_chip_ledger_club_from_created
  ON public.chip_ledger (club_id, from_entity_id, created_at);

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
  WITH moves AS (
    SELECT cl.club_id AS c_id,
           COALESCE(cl.to_entity_id, cl.from_entity_id) AS u_id,
           SUM(CASE WHEN cl.to_type   = 'player_wallet' THEN cl.amount ELSE 0 END)
         - SUM(CASE WHEN cl.from_type = 'player_wallet' THEN cl.amount ELSE 0 END) AS net,
           MIN(cl.created_at) AS first_at
    FROM public.chip_ledger cl
    WHERE cl.club_id IS NOT NULL
      AND cl.created_at >= (SELECT MIN(taken_at) FROM public.ca_chip_baseline)
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
    ON m.c_id = b.club_id AND m.u_id = b.user_id AND m.first_at >= b.taken_at;
$$;

COMMENT ON FUNCTION public.fn_chip_drift_since_baseline() IS
  'Drift that happened AFTER auditing was restored on 2026-08-26. Non-zero means chips moved without a ledger row, on our watch. The pre-baseline gap is deliberately excluded: it is unknowable, not zero.';

REVOKE ALL ON FUNCTION public.fn_chip_drift_since_baseline() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_chip_drift_since_baseline() TO service_role, authenticated;
