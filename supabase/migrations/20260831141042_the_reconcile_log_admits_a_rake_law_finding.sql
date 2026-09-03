-- ═══════════════════════════════════════════════════════════════════════════
-- THE RECONCILE LOG ADMITS A RAKE-LAW FINDING
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two more defects in the rake-law alarm, both mine, both caught on a manual
-- run before pg_cron reached the job. Nothing was ever written; nothing needs
-- repairing.
--
--   1. `ledger_reconcile_log.entity_type` carries a CHECK listing the twelve
--      finding types the log knows about, and 'rake_law' was not one of them.
--      That closed vocabulary is a feature — it is what stops a typo inventing
--      a silent thirteenth category nobody greps for — so the fix is to widen
--      the list once, deliberately, rather than to drop the constraint.
--   2. The severity vocabulary is ('ok','warn','critical'). I wrote 'warning'.
--
-- The lesson is the one this audit keeps re-learning: read the constraint. Do
-- not infer the shape of a table from its column names.
--
-- NOT VALID then VALIDATE so the catalogue change takes ACCESS EXCLUSIVE only
-- briefly and the 57,730 existing rows are re-checked under a lock that does
-- not block readers.
--
-- APPLIED TO PRODUCTION 2026-08-31 via Supabase MCP apply_migration
-- (version 20260831141042). Verified afterwards: fn_rake_law_check('24 hours')
-- logged 35 findings on its first run and 0 on an immediate second run, which
-- is both halves of the contract — it sees them, and it does not double-log.

ALTER TABLE public.ledger_reconcile_log
  DROP CONSTRAINT ledger_reconcile_log_entity_type_check;

ALTER TABLE public.ledger_reconcile_log
  ADD CONSTRAINT ledger_reconcile_log_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'player_wallet','club_treasury','agent_wallet','frozen_wallets_pool',
    'chip_circulation','seat_stack_exit','cashout_escrow_stuck',
    'negative_balance','over_claimed_send','insurance_bank',
    'insurance_offer_unresolved','bomb_award_ledger_gap',
    'rake_law'
  ])) NOT VALID;

ALTER TABLE public.ledger_reconcile_log
  VALIDATE CONSTRAINT ledger_reconcile_log_entity_type_check;

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
