-- 2026-08-28: reconcile_ledger_nightly's new 'insurance_bank' section hit the
-- entity_type CHECK constraint on ledger_reconcile_log (caught by running the
-- function immediately after 20260828120500 applied — verification, not
-- production traffic). Extend the allow-list.
ALTER TABLE public.ledger_reconcile_log
  DROP CONSTRAINT IF EXISTS ledger_reconcile_log_entity_type_check;
ALTER TABLE public.ledger_reconcile_log
  ADD CONSTRAINT ledger_reconcile_log_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'player_wallet'::text, 'club_treasury'::text, 'agent_wallet'::text,
    'frozen_wallets_pool'::text, 'chip_circulation'::text, 'seat_stack_exit'::text,
    'cashout_escrow_stuck'::text, 'negative_balance'::text, 'over_claimed_send'::text,
    'insurance_bank'::text]));

-- ROLLBACK: re-add the constraint without 'insurance_bank' (and remove the
-- insurance_bank section from reconcile_ledger_nightly first).
