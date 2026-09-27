-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420003353 "phase4_reconcile_ledger_fn"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 dcf54c7a3436bea899fa655522720141 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Phase 4.1.2 — Reconciliation function.
-- For each player_wallet and club_treasury, computes:
--   ledger_balance = SUM(credits) - SUM(debits) from chip_ledger
--   stored_balance = wallets.balance / clubs.chip_pool
-- Inserts one row per entity into ledger_reconcile_log with severity.
--
-- Severity thresholds (absolute drift):
--   ok       : |drift| = 0
--   warn     : 0 < |drift| <= 1.00   (rounding noise / cent-level)
--   critical : |drift| > 1.00

CREATE OR REPLACE FUNCTION public.reconcile_ledger_nightly()
RETURNS TABLE (
  total_checked    INT,
  ok_count         INT,
  warn_count       INT,
  critical_count   INT,
  worst_drift      NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total   INT := 0;
  v_ok      INT := 0;
  v_warn    INT := 0;
  v_crit    INT := 0;
  v_worst   NUMERIC := 0;
BEGIN
  -- ── Player wallets ────────────────────────────────────────────────────
  WITH credits AS (
    SELECT to_entity_id AS user_id, SUM(amount) AS amt
    FROM public.chip_ledger
    WHERE to_type = 'player_wallet' AND to_entity_id IS NOT NULL
    GROUP BY to_entity_id
  ),
  debits AS (
    SELECT from_entity_id AS user_id, SUM(amount) AS amt
    FROM public.chip_ledger
    WHERE from_type = 'player_wallet' AND from_entity_id IS NOT NULL
    GROUP BY from_entity_id
  ),
  ledger AS (
    SELECT
      COALESCE(c.user_id, d.user_id) AS user_id,
      COALESCE(c.amt, 0) - COALESCE(d.amt, 0) AS balance
    FROM credits c FULL OUTER JOIN debits d USING (user_id)
  ),
  stored AS (
    SELECT user_id, SUM(COALESCE(balance, 0)) AS balance
    FROM public.wallets
    WHERE wallet_type IN ('player','PLAYER','CASH','cash')
    GROUP BY user_id
  ),
  merged AS (
    SELECT
      COALESCE(l.user_id, s.user_id) AS user_id,
      COALESCE(l.balance, 0)         AS ledger_balance,
      COALESCE(s.balance, 0)         AS stored_balance
    FROM ledger l FULL OUTER JOIN stored s USING (user_id)
    WHERE (COALESCE(l.balance, 0) <> 0 OR COALESCE(s.balance, 0) <> 0)
  )
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT
    'player_wallet',
    user_id,
    ledger_balance,
    stored_balance,
    CASE
      WHEN ABS(stored_balance - ledger_balance) = 0          THEN 'ok'
      WHEN ABS(stored_balance - ledger_balance) <= 1.00      THEN 'warn'
      ELSE                                                         'critical'
    END,
    jsonb_build_object('source', 'reconcile_ledger_nightly', 'wallet_type_filter', 'player/PLAYER/CASH')
  FROM merged
  WHERE user_id IS NOT NULL;

  GET DIAGNOSTICS v_total = ROW_COUNT;

  -- ── Club treasuries ───────────────────────────────────────────────────
  WITH credits AS (
    SELECT to_entity_id AS club_id, SUM(amount) AS amt
    FROM public.chip_ledger
    WHERE to_type = 'club_treasury' AND to_entity_id IS NOT NULL
    GROUP BY to_entity_id
  ),
  debits AS (
    SELECT from_entity_id AS club_id, SUM(amount) AS amt
    FROM public.chip_ledger
    WHERE from_type = 'club_treasury' AND from_entity_id IS NOT NULL
    GROUP BY from_entity_id
  ),
  ledger AS (
    SELECT
      COALESCE(c.club_id, d.club_id) AS club_id,
      COALESCE(c.amt, 0) - COALESCE(d.amt, 0) AS balance
    FROM credits c FULL OUTER JOIN debits d USING (club_id)
  ),
  stored AS (
    SELECT id AS club_id, COALESCE(chip_pool, 0) AS balance FROM public.clubs
  ),
  merged AS (
    SELECT
      COALESCE(l.club_id, s.club_id) AS club_id,
      COALESCE(l.balance, 0)         AS ledger_balance,
      COALESCE(s.balance, 0)         AS stored_balance
    FROM ledger l FULL OUTER JOIN stored s USING (club_id)
    WHERE (COALESCE(l.balance, 0) <> 0 OR COALESCE(s.balance, 0) <> 0)
  )
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT
    'club_treasury',
    club_id,
    ledger_balance,
    stored_balance,
    CASE
      WHEN ABS(stored_balance - ledger_balance) = 0          THEN 'ok'
      WHEN ABS(stored_balance - ledger_balance) <= 1.00      THEN 'warn'
      ELSE                                                         'critical'
    END,
    jsonb_build_object('source', 'reconcile_ledger_nightly')
  FROM merged
  WHERE club_id IS NOT NULL;

  -- Recompute the summary counts from what we just inserted today
  SELECT
    COUNT(*)::INT                                                 AS total,
    COUNT(*) FILTER (WHERE severity = 'ok')::INT                  AS ok,
    COUNT(*) FILTER (WHERE severity = 'warn')::INT                AS warn,
    COUNT(*) FILTER (WHERE severity = 'critical')::INT            AS crit,
    COALESCE(MAX(ABS(stored_balance - ledger_balance)), 0)        AS worst
  INTO v_total, v_ok, v_warn, v_crit, v_worst
  FROM public.ledger_reconcile_log
  WHERE run_date = CURRENT_DATE;

  total_checked  := v_total;
  ok_count       := v_ok;
  warn_count     := v_warn;
  critical_count := v_crit;
  worst_drift    := v_worst;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.reconcile_ledger_nightly() IS
  'Phase 4.1.2 — sums chip_ledger to derive expected balances and compares against stored wallets.balance / clubs.chip_pool. Writes one row per entity to ledger_reconcile_log and returns summary.';

