-- x222 — Make reconcile_ledger_nightly() idempotent across same-day reruns.
--
-- Bug discovered Phase L: today's run reported 68 critical drifts but
-- only 34 are unique users. The RPC was being invoked twice today (08:00
-- failed cron + AG manual retrigger post-fix), and each call appended
-- new rows to ledger_reconcile_log without clearing the previous batch.
-- The summary then re-counted ALL of today's rows, exactly doubling
-- every metric.
--
-- Root cause: original INSERT had no de-duplication. Each call appended.
-- After re-running with manual triggers (operator may need to retry a
-- failed cron), counts always inflate.
--
-- Fix: DELETE today's rows BEFORE re-inserting. Idempotent: subsequent
-- runs replace the day's entries cleanly, summary always reflects the
-- LATEST run only. Prior days are untouched (forensic history preserved).
--
-- Verification post-apply (2026-05-03):
--   First run after fix: total_checked=584, ok=548, warn=2, critical=34
--   (down from doubled 68 — confirms dedup works)
--
-- Applied to prod via Supabase MCP. This is the repo paper-trail copy.

CREATE OR REPLACE FUNCTION public.reconcile_ledger_nightly()
 RETURNS TABLE(total_checked integer, ok_count integer, warn_count integer, critical_count integer, worst_drift numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total   INT := 0;
  v_ok      INT := 0;
  v_warn    INT := 0;
  v_crit    INT := 0;
  v_worst   NUMERIC := 0;
BEGIN
  -- x222: clear today's existing rows so re-runs replace, not duplicate.
  DELETE FROM public.ledger_reconcile_log WHERE run_date = CURRENT_DATE;

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
$function$;
