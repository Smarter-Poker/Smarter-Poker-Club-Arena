-- Isolated configuration only, copied from the existing authoritative audit.
-- Never run against production or disable the CREATE FUNCTION financial guard.
-- Source: 20260831233537_ca_alert_audit_round3_contained.sql, registry section.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';
DO $registry$
BEGIN
  IF session_user <> 'leaderboard_qualification_bootstrap'
     OR current_user <> 'leaderboard_qualification_bootstrap'
     OR current_database() <> 'postgres'
     OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'Registry fixture requires isolated bootstrap socket';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users)
     OR EXISTS (SELECT 1 FROM public.clubs)
     OR EXISTS (SELECT 1 FROM public.unions)
     OR EXISTS (SELECT 1 FROM public.ca_money_rpc_registry) THEN
    RAISE EXCEPTION 'Registry fixture requires empty restored business and configuration tables';
  END IF;
  INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
SELECT v.proname, 'approved'::text AS status, v.notes FROM (VALUES
  ('fn_complete_club_opening_setup',
   'Audited 2026-08-31 (alert audit round 3): owner/admin-gated, definer, single-transaction club opening funding (spin seed via fn_spin_activate, bbj seed, promo budget, leaderboard budget). Declares category club_opening_allocation / counterparty opening_setup - vocabulary added same day. Leaderboard budget is held as club_opening_setups.leaderboard_seed_remaining and counted in the supply snapshot as leaderboard_liability.'),
  ('fn_payout_leaderboard',
   'Audited 2026-08-31 (alert audit round 3): definer, canonical-round guard, batch-idempotent (leaderboard_payout_batches), seed-then-promo-then-overlay funding, winner credits via fn_credit_and_log with idempotency keys. Declares category leaderboard_payout / counterparty leaderboard_round - vocabulary added same day.')
) AS v(proname, notes);
  IF (SELECT count(*) FROM public.ca_money_rpc_registry) <> 2
     OR EXISTS (SELECT 1 FROM public.ca_money_rpc_registry
       WHERE added_at IS DISTINCT FROM transaction_timestamp())
     OR EXISTS (
       (SELECT proname, status, notes FROM public.ca_money_rpc_registry
        EXCEPT
SELECT v.proname, 'approved'::text AS status, v.notes FROM (VALUES
  ('fn_complete_club_opening_setup',
   'Audited 2026-08-31 (alert audit round 3): owner/admin-gated, definer, single-transaction club opening funding (spin seed via fn_spin_activate, bbj seed, promo budget, leaderboard budget). Declares category club_opening_allocation / counterparty opening_setup - vocabulary added same day. Leaderboard budget is held as club_opening_setups.leaderboard_seed_remaining and counted in the supply snapshot as leaderboard_liability.'),
  ('fn_payout_leaderboard',
   'Audited 2026-08-31 (alert audit round 3): definer, canonical-round guard, batch-idempotent (leaderboard_payout_batches), seed-then-promo-then-overlay funding, winner credits via fn_credit_and_log with idempotency keys. Declares category leaderboard_payout / counterparty leaderboard_round - vocabulary added same day.')
) AS v(proname, notes)
       ) UNION ALL (
SELECT v.proname, 'approved'::text AS status, v.notes FROM (VALUES
  ('fn_complete_club_opening_setup',
   'Audited 2026-08-31 (alert audit round 3): owner/admin-gated, definer, single-transaction club opening funding (spin seed via fn_spin_activate, bbj seed, promo budget, leaderboard budget). Declares category club_opening_allocation / counterparty opening_setup - vocabulary added same day. Leaderboard budget is held as club_opening_setups.leaderboard_seed_remaining and counted in the supply snapshot as leaderboard_liability.'),
  ('fn_payout_leaderboard',
   'Audited 2026-08-31 (alert audit round 3): definer, canonical-round guard, batch-idempotent (leaderboard_payout_batches), seed-then-promo-then-overlay funding, winner credits via fn_credit_and_log with idempotency keys. Declares category leaderboard_payout / counterparty leaderboard_round - vocabulary added same day.')
) AS v(proname, notes)
        EXCEPT SELECT proname, status, notes FROM public.ca_money_rpc_registry)
     ) THEN
    RAISE EXCEPTION 'Registry fixture differs from the two authoritative approved entries';
  END IF;
END;
$registry$;
COMMIT;
