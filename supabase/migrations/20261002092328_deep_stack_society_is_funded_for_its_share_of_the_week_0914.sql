-- 20261002092328_deep_stack_society_is_funded_for_its_share_of_the_week_0914.sql
--
-- DEEP STACK SOCIETY IS FUNDED FOR ITS SHARE OF THE WEEK OF 2026-09-14 (2026-10-02)
--
-- The payment of the week of 2026-09-14 (legacy cascade operation 19aa02d6,
-- 20261002025516, Dan's decision "Pay the measured 138,303.43", reaffirmed
-- 2026-10-02) was refused at 2026-10-02 09:21:22 UTC, rolled back whole:
--
--   legacy_discharge_payer_shortfall
--   [{"kind":"club","club_id":"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3",
--     "net":-205358.97,"opening":202028.44,"shortfall":3330.53}]
--
-- Deep Stack Society is standalone (no union), so its own treasury is the
-- payer of its legs of the week, 205,358.97 net. The treasury is live and
-- falls with play (horse funding draws on it): 201,728.44 at 09:24.
--
-- DECISION (CLAUDE.md 10.9, delegated by Dan): the house funds its club
-- through THE sanctioned door, fn_ca_fund_club (20260901111955: a ledgered
-- system_mint into club_treasury, never a raw UPDATE), by exactly what the
-- payment needs at apply time plus a 10,000.00 float for the drift between
-- this transaction and the payment's: greatest(0, 205,358.97 + 10,000.00 -
-- treasury). Nothing is paid to any player here; the payment and its amounts
-- are 20261002025516's and unchanged. Whatever float the payment does not use
-- stays in the club's treasury, ledgered.
--
-- Refuses unless operation 19aa02d6 is still certified and unpaid, and the
-- key is unused (a replay mints nothing).

-- @live-proof: (SELECT count(*) FROM public.chip_ledger WHERE idempotency_key = 'club-funding:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3:legacy-week-2026-09-14') = 1

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $mig$
DECLARE
  c_dss   CONSTANT uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  c_op    CONSTANT uuid := '19aa02d6-1023-441a-9979-3e65ceab6240';
  c_net   CONSTANT numeric := 205358.97;
  c_float CONSTANT numeric := 10000.00;
  c_key   CONSTANT text := 'club-funding:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3:legacy-week-2026-09-14';
  v_state text; v_before numeric; v_amount numeric; v_res jsonb; v_after numeric; v_leg numeric;
BEGIN
  SELECT state INTO v_state FROM public.accounting_owner_legacy_operations
   WHERE operation_id = c_op AND mode = 'legacy_cascade';
  IF v_state IS DISTINCT FROM 'certified' THEN
    RAISE EXCEPTION 'dss funding: operation 19aa02d6 is %, not certified-and-unpaid; nothing to fund', v_state;
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = c_key) THEN
    RAISE EXCEPTION 'dss funding: % already journaled - refusing to fund twice', c_key;
  END IF;

  SELECT chip_treasury INTO v_before FROM public.clubs WHERE id = c_dss FOR NO KEY UPDATE;
  v_amount := round(greatest(0, c_net + c_float - COALESCE(v_before, 0)), 2);
  IF v_amount <= 0 THEN
    RAISE NOTICE 'dss funding: treasury % already covers % plus float; nothing minted', v_before, c_net;
    RETURN;
  END IF;
  IF v_amount > 50000.00 THEN
    RAISE EXCEPTION 'dss funding: the treasury (%) has fallen far enough that % would be needed; read it again before funding', v_before, v_amount;
  END IF;

  v_res := public.fn_ca_fund_club(c_dss, v_amount,
    format('House funds Deep Stack Society for its 205,358.97 share of the week of 2026-09-14 rakeback (operation 19aa02d6, Dan''s decision), refused legacy_discharge_payer_shortfall at 09:21 UTC; treasury %s, minted %s (need plus 10,000.00 float). Migration 20261002092328.', v_before, v_amount),
    c_key);
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE OR (v_res->>'replayed')::boolean THEN
    RAISE EXCEPTION 'dss funding: fn_ca_fund_club did not fund: %', v_res;
  END IF;

  SELECT chip_treasury INTO v_after FROM public.clubs WHERE id = c_dss;
  SELECT sum(amount) INTO v_leg FROM public.chip_ledger WHERE idempotency_key = c_key;
  IF round(v_after - v_before, 2) <> v_amount OR v_leg IS DISTINCT FROM v_amount OR v_after < c_net THEN
    RAISE EXCEPTION 'dss funding post-image: treasury % -> % (minted %, leg %), payment needs %', v_before, v_after, v_amount, v_leg, c_net;
  END IF;
  RAISE NOTICE 'dss funding: treasury % -> % (minted %)', v_before, v_after, v_amount;
END
$mig$;

COMMIT;
