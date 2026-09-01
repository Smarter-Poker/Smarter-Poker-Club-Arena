-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829123006; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-08-29: a lost bomb-pot award unit cannot stay silent.
-- Full rationale in supabase/migrations/20260829_bomb_award_ledger_gaps_are_loud.sql
CREATE OR REPLACE FUNCTION public.fn_bomb_pot_ledger_gaps(
  p_since interval    DEFAULT '1 day'::interval,
  p_grace interval    DEFAULT '10 minutes'::interval,
  p_epoch timestamptz DEFAULT timestamptz '2026-08-28 22:38:00+00'
)
RETURNS TABLE (
  hand_history_id uuid,
  table_id        uuid,
  hand_number     bigint,
  occurred_at     timestamptz,
  board_count     integer,
  trigger_reason  text,
  net_winnings    numeric,
  ledger_total    numeric,
  award_units     bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    h.id,
    h.table_id,
    h.hand_number::bigint,
    h.created_at,
    (h.bomb_pot ->> 'board_count')::int,
    h.bomb_pot ->> 'trigger_reason',
    round(COALESCE(h.pot_size, 0) - COALESCE(h.rake_amount, 0) - COALESCE(h.bbj_amount, 0), 2),
    round(COALESCE(u.total, 0), 2),
    COALESCE(u.units, 0)
  FROM public.hand_history h
  LEFT JOIN LATERAL (
    SELECT SUM(a.amount) AS total, COUNT(*) AS units
    FROM public.bomb_pot_award_units a
    WHERE a.hand_history_id = h.id
  ) u ON true
  WHERE h.bomb_pot IS NOT NULL
    AND h.created_at >  now() - p_since
    AND h.created_at <  now() - p_grace
    AND h.created_at >= p_epoch
    AND round(COALESCE(h.pot_size, 0) - COALESCE(h.rake_amount, 0) - COALESCE(h.bbj_amount, 0), 2)
        IS DISTINCT FROM round(COALESCE(u.total, 0), 2)
  ORDER BY h.created_at DESC
$$;

REVOKE ALL ON FUNCTION public.fn_bomb_pot_ledger_gaps(interval, interval, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bomb_pot_ledger_gaps(interval, interval, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.fn_bomb_pot_ledger_gaps(interval, interval, timestamptz) IS
  'Settled bomb hands whose bomb_pot_award_units do not sum to net winnings. '
  'Read by reconcile_ledger_nightly, which files each row as critical.';

ALTER TABLE public.ledger_reconcile_log
  DROP CONSTRAINT IF EXISTS ledger_reconcile_log_entity_type_check;
ALTER TABLE public.ledger_reconcile_log
  ADD CONSTRAINT ledger_reconcile_log_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'player_wallet'::text, 'club_treasury'::text, 'agent_wallet'::text,
    'frozen_wallets_pool'::text, 'chip_circulation'::text, 'seat_stack_exit'::text,
    'cashout_escrow_stuck'::text, 'negative_balance'::text, 'over_claimed_send'::text,
    'insurance_bank'::text, 'insurance_offer_unresolved'::text,
    'bomb_award_ledger_gap'::text]));

DO $$
DECLARE
  v_gaps int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_bomb_pot_ledger_gaps'
  ) THEN
    RAISE EXCEPTION 'assertion failed: fn_bomb_pot_ledger_gaps missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ledger_reconcile_log_entity_type_check'
      AND pg_get_constraintdef(oid) LIKE '%bomb_award_ledger_gap%'
  ) THEN
    RAISE EXCEPTION 'assertion failed: entity_type check does not allow bomb_award_ledger_gap';
  END IF;

  SELECT count(*) INTO v_gaps FROM public.fn_bomb_pot_ledger_gaps('30 days'::interval);
  RAISE NOTICE 'fn_bomb_pot_ledger_gaps over 30 days: % hand(s)', v_gaps;
END $$;
