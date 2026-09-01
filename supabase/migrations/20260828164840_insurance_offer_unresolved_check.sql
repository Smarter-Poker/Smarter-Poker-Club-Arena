-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828164840; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- INSURANCE FUNNEL INTEGRITY - 2026-08-28. Mirrored in repo:
-- supabase/migrations/20260828190000_insurance_offer_unresolved_check.sql

ALTER TABLE public.ledger_reconcile_log
  DROP CONSTRAINT IF EXISTS ledger_reconcile_log_entity_type_check;
ALTER TABLE public.ledger_reconcile_log
  ADD CONSTRAINT ledger_reconcile_log_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'player_wallet'::text, 'club_treasury'::text, 'agent_wallet'::text,
    'frozen_wallets_pool'::text, 'chip_circulation'::text, 'seat_stack_exit'::text,
    'cashout_escrow_stuck'::text, 'negative_balance'::text, 'over_claimed_send'::text,
    'insurance_bank'::text, 'insurance_offer_unresolved'::text]));

CREATE OR REPLACE FUNCTION public.fn_unresolved_insurance_offers(p_window interval DEFAULT '1 day')
RETURNS TABLE(
  table_id uuid, hand_number integer, player_id uuid,
  offered bigint, resolved bigint, last_offer timestamptz)
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $$
  SELECT e.table_id, e.hand_number, e.player_id,
         COUNT(*) FILTER (WHERE e.event = 'offered')                                   AS offered,
         COUNT(*) FILTER (WHERE e.event IN ('accepted','declined','timeout','cashed_out')) AS resolved,
         MAX(e.created_at) FILTER (WHERE e.event = 'offered')                          AS last_offer
  FROM public.insurance_offer_events e
  WHERE e.created_at > now() - p_window
  GROUP BY e.table_id, e.hand_number, e.player_id
  HAVING COUNT(*) FILTER (WHERE e.event = 'offered')
       > COUNT(*) FILTER (WHERE e.event IN ('accepted','declined','timeout','cashed_out'))
     AND MAX(e.created_at) FILTER (WHERE e.event = 'offered') < now() - interval '3 minutes';
$$;
