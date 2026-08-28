-- ═══════════════════════════════════════════════════════════════════════════
-- INSURANCE FUNNEL INTEGRITY — 2026-08-28 (Tier 2, additive)
--
-- Every 'offered' row in insurance_offer_events must be answered by exactly
-- one outcome row (accepted / declined / timeout / cashed_out) — the engine's
-- DeadlineScheduler guarantees a decision within the offer window. An offer
-- with no outcome means the engine died mid-window or an outcome write was
-- dropped (they are fire-and-forget by design). This makes that LOUD in the
-- nightly reconciler instead of silently under-counting the funnel.
--
-- Rule: per (table, hand, player) over the last day, offered-count must not
-- exceed resolved-count once the newest offer is >3 minutes old (window is
-- 25s; 3 min is generous slack for clock skew and settle timing).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.ledger_reconcile_log
  DROP CONSTRAINT IF EXISTS ledger_reconcile_log_entity_type_check;
ALTER TABLE public.ledger_reconcile_log
  ADD CONSTRAINT ledger_reconcile_log_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'player_wallet'::text, 'club_treasury'::text, 'agent_wallet'::text,
    'frozen_wallets_pool'::text, 'chip_circulation'::text, 'seat_stack_exit'::text,
    'cashout_escrow_stuck'::text, 'negative_balance'::text, 'over_claimed_send'::text,
    'insurance_bank'::text, 'insurance_offer_unresolved'::text]));

-- Helper so both the nightly function and ad-hoc checks share one definition.
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

-- The nightly reconciler picks it up: append-only section, executed by
-- recreating the function with the new block inserted after 'insurance_bank'.
-- (Full function body lives in 20260828120500; only the addition is new.)
-- Applied via Supabase MCP as a targeted CREATE OR REPLACE of
-- reconcile_ledger_nightly including this block:
--
--   INSERT INTO public.ledger_reconcile_log
--     (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
--   SELECT 'insurance_offer_unresolved', u.player_id, u.offered, u.resolved, 'critical',
--          jsonb_build_object('source', 'reconcile_ledger_nightly',
--                             'table_id', u.table_id, 'hand_number', u.hand_number,
--                             'last_offer', u.last_offer)
--   FROM public.fn_unresolved_insurance_offers('1 day'::interval) u;
