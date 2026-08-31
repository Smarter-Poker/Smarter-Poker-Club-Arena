-- ═══════════════════════════════════════════════════════════════════════════
-- THE ALARM COULD NOT RAISE AN ALARM
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_rake_law_check` listed `drift` in its INSERT column list.
-- `ledger_reconcile_log.drift` is GENERATED ALWAYS AS
-- (stored_balance - ledger_balance), so every call raised 428C9 and the check
-- could never have logged anything at all.
--
-- Caught on its first manual run, before pg_cron reached the job, so nothing
-- was written and nothing needs repairing.
--
-- The VALUE was right: ledger_balance carries the rake OWED and
-- stored_balance the rake TAKEN, so the generated drift is already
-- rake - allowed. The column simply has to be left for Postgres to fill.
--
-- Worth saying plainly: the mechanism that refused this write is the same one
-- 20260831133000 had just used to stop four buy-in columns disagreeing. It
-- works, including on its author.
--
-- APPLIED TO PRODUCTION 2026-08-31 via Supabase MCP apply_migration
-- (version 20260831140922).

CREATE OR REPLACE FUNCTION public.fn_rake_law_check(p_window interval DEFAULT '2 hours')
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_new integer;
BEGIN
  WITH v AS (
    SELECT * FROM public.fn_rake_law_violations(p_window)
  ), ins AS (
    INSERT INTO public.ledger_reconcile_log
      (run_date, run_ts, entity_type, entity_id, ledger_balance, stored_balance,
       severity, metadata, notes)
    SELECT CURRENT_DATE, now(), 'rake_law', v.table_id,
           v.allowed, v.rake,
           CASE WHEN v.kind = 'board_not_recorded' THEN 'warn' ELSE 'critical' END,
           jsonb_build_object(
             'kind', v.kind,
             'hand_id', v.hand_id,
             'occurred_at', v.occurred_at,
             'stake', v.small_blind::text || '/' || v.big_blind::text,
             'pot', v.pot),
           v.kind || ': raked ' || v.rake::text || ' where ' || v.allowed::text || ' was owed'
      FROM v
     WHERE NOT EXISTS (
       SELECT 1 FROM public.ledger_reconcile_log l
        WHERE l.entity_type = 'rake_law'
          AND l.metadata->>'hand_id' = v.hand_id::text)
    RETURNING 1
  )
  SELECT count(*) INTO v_new FROM ins;
  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_rake_law_check(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_law_check(interval) TO service_role;
