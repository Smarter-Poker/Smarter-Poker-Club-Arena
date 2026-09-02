-- ═══════════════════════════════════════════════════════════════════════════
-- INSURANCE: nightly reconciliation + observability views — 2026-08-28
-- Tier 2 (function body extended, additive views). Rollback at bottom.
--
-- 1. reconcile_ledger_nightly gains an 'insurance_bank' section: the sum of
--    insurance_transactions (premium − payout) per bank entity must equal the
--    stored union_wallets.insurance_wallet / club_wallets.insurance_balance.
--    Verified against production before this migration: the pools matched
--    exactly (one union entity, −307.49 = −307.49).
-- 2. v_insurance_pnl — money per club/union/kind/day from the settled ledger.
-- 3. v_insurance_activity — the decision funnel per club/day from
--    insurance_offer_events (offers are the denominator the repriced rates
--    need: are players still buying at rate = pWin/(1.2 x pLoss)?).
-- Both views are security_invoker so table RLS applies to the caller.
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_frozen  NUMERIC;
  v_now     NUMERIC;
BEGIN
  -- x222: clear today's existing rows so re-runs replace, not duplicate.
  DELETE FROM public.ledger_reconcile_log WHERE run_date = CURRENT_DATE;

  -- The FROZEN wallets pool must not move (replaces the per-wallet
  -- reconciliation of this pool, 2026-08-27).
  SELECT frozen_total INTO v_frozen
    FROM public.ca_frozen_pool_baseline WHERE pool = 'public.wallets';
  SELECT COALESCE(SUM(balance), 0) INTO v_now FROM public.wallets;
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  VALUES (
    'frozen_wallets_pool', NULL, COALESCE(v_frozen, 0), v_now,
    CASE WHEN v_frozen IS NULL THEN 'critical'
         WHEN v_now = v_frozen  THEN 'ok'
         ELSE 'critical' END,
    jsonb_build_object(
      'source', 'reconcile_ledger_nightly',
      'rule', 'pool frozen 2026-08-21: any movement means a money path is writing to the dead pool',
      'baseline', v_frozen, 'observed', v_now));

  -- Club treasuries (unchanged)
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
    SELECT COALESCE(c.club_id, d.club_id) AS club_id,
           COALESCE(c.amt, 0) - COALESCE(d.amt, 0) AS balance
    FROM credits c FULL OUTER JOIN debits d USING (club_id)
  ),
  stored AS (
    SELECT id AS club_id, COALESCE(chip_pool, 0) AS balance FROM public.clubs
  ),
  merged AS (
    SELECT COALESCE(l.club_id, s.club_id) AS club_id,
           COALESCE(l.balance, 0) AS ledger_balance,
           COALESCE(s.balance, 0) AS stored_balance
    FROM ledger l FULL OUTER JOIN stored s USING (club_id)
    WHERE (COALESCE(l.balance, 0) <> 0 OR COALESCE(s.balance, 0) <> 0)
  )
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'club_treasury', club_id, ledger_balance, stored_balance,
    CASE
      WHEN ABS(stored_balance - ledger_balance) = 0     THEN 'ok'
      WHEN ABS(stored_balance - ledger_balance) <= 1.00 THEN 'warn'
      ELSE 'critical'
    END,
    jsonb_build_object('source', 'reconcile_ledger_nightly')
  FROM merged
  WHERE club_id IS NOT NULL;

  -- INSURANCE + EV-CASHOUT BANK (added 2026-08-28): every settled contract
  -- writes premium/payout rows AND moves the signed insurance account in the
  -- same RPC. If the two ever disagree, a write was lost or a money path
  -- bypassed record_insurance_transaction.
  WITH led AS (
    SELECT bank_type, bank_entity_id,
           SUM(COALESCE(premium,0) - COALESCE(payout,0)) AS bal,
           COUNT(*) AS contracts
    FROM public.insurance_transactions
    WHERE bank_entity_id IS NOT NULL
    GROUP BY bank_type, bank_entity_id
  ),
  joined AS (
    SELECT l.bank_type, l.bank_entity_id, l.bal AS ledger_balance, l.contracts,
           COALESCE(
             CASE WHEN l.bank_type = 'union'
                  THEN (SELECT w.insurance_wallet FROM public.union_wallets w
                         WHERE w.union_id = l.bank_entity_id)
                  ELSE (SELECT c.insurance_balance FROM public.club_wallets c
                         WHERE c.club_id = l.bank_entity_id) END,
             0) AS stored_balance
    FROM led l
  )
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'insurance_bank', j.bank_entity_id, j.ledger_balance, j.stored_balance,
    CASE
      WHEN ABS(j.stored_balance - j.ledger_balance) = 0     THEN 'ok'
      WHEN ABS(j.stored_balance - j.ledger_balance) <= 0.01 THEN 'warn'
      ELSE 'critical'
    END,
    jsonb_build_object('source', 'reconcile_ledger_nightly',
                       'bank_type', j.bank_type, 'contracts', j.contracts)
  FROM joined j;

  -- Chips that left the felt and landed nowhere (added 2026-08-25, unchanged)
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'seat_stack_exit', x.user_id, x.stack, 0, 'critical',
         jsonb_build_object(
           'source', 'fn_unaccounted_seat_exits',
           'exit_id', x.exit_id, 'table_id', x.table_id,
           'club_id', x.club_id, 'exit_kind', x.exit_kind,
           'db_role', x.db_role, 'app_name', x.app_name,
           'occurred_at', x.occurred_at)
  FROM public.fn_unaccounted_seat_exits('1 day'::interval) x;

  -- Where the chips actually are (added 2026-08-25, unchanged)
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'chip_circulation', c.club_id, c.on_the_felt, c.total, 'ok',
         jsonb_build_object(
           'source', 'fn_club_chip_circulation',
           'club_name', c.club_name,
           'member_wallets', c.member_wallets,
           'on_the_felt', c.on_the_felt,
           'treasury', c.treasury)
  FROM public.fn_club_chip_circulation() c
  WHERE c.total <> 0;

  -- Cashier integrity (added 2026-08-27 phase 2 audit, unchanged)
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'cashout_escrow_stuck', e.player_id, e.amount, 0, 'critical',
         jsonb_build_object(
           'source', 'cashier_integrity',
           'escrow_id', e.id, 'cashout_id', e.cashout_request_id,
           'club_id', e.club_id, 'request_status', cr.status,
           'shape', CASE WHEN e.released_at IS NULL THEN 'unreleased_on_closed_request'
                         ELSE 'released_on_pending_request' END)
  FROM public.chip_escrow e
  JOIN public.cashout_requests cr ON cr.id = e.cashout_request_id
  WHERE (e.released_at IS NULL AND cr.status <> 'pending')
     OR (e.released_at IS NOT NULL AND cr.status = 'pending');

  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'negative_balance', t.entity_id, t.amount, 0, 'critical',
         jsonb_build_object('source', 'cashier_integrity', 'pool', t.pool, 'club_id', t.club_id)
  FROM (
    SELECT a.user_id AS entity_id, a.agent_wallet_balance AS amount, 'agent_wallet' AS pool, a.club_id
      FROM public.agents a WHERE COALESCE(a.agent_wallet_balance, 0) < 0
    UNION ALL
    SELECT a.user_id, a.promo_wallet_balance, 'promo_wallet', a.club_id
      FROM public.agents a WHERE COALESCE(a.promo_wallet_balance, 0) < 0
    UNION ALL
    SELECT m.user_id, m.chip_balance, 'player_wallet', m.club_id
      FROM public.club_members m WHERE COALESCE(m.chip_balance, 0) < 0
    UNION ALL
    SELECT c.id, c.chip_treasury, 'club_treasury', c.id
      FROM public.clubs c WHERE COALESCE(c.chip_treasury, 0) < 0
  ) t;

  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'over_claimed_send', ct.from_user_id,
         COALESCE((ct.metadata ->> 'claimed_back')::numeric, 0), ct.amount, 'critical',
         jsonb_build_object('source', 'cashier_integrity',
                            'transaction_id', ct.id, 'club_id', ct.club_id)
  FROM public.chip_transactions ct
  WHERE ct.transaction_type = 'agent_wallet_send'
    AND COALESCE((ct.metadata ->> 'claimed_back')::numeric, 0) > ct.amount;

  -- Recompute the summary counts from what we just inserted today
  SELECT
    COUNT(*)::INT                                          AS total,
    COUNT(*) FILTER (WHERE severity = 'ok')::INT           AS ok,
    COUNT(*) FILTER (WHERE severity = 'warn')::INT         AS warn,
    COUNT(*) FILTER (WHERE severity = 'critical')::INT     AS crit,
    COALESCE(MAX(ABS(stored_balance - ledger_balance)), 0) AS worst
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

-- ── Observability views ────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.v_insurance_pnl
WITH (security_invoker = true) AS
SELECT
  it.club_id,
  it.union_id,
  it.kind,
  (it.created_at AT TIME ZONE 'utc')::date AS day,
  COUNT(*)                                   AS contracts,
  COUNT(*) FILTER (WHERE it.payout > 0)      AS paid_out,
  ROUND(SUM(COALESCE(it.premium, 0)), 2)     AS bank_in,
  ROUND(SUM(COALESCE(it.payout, 0)), 2)      AS bank_out,
  ROUND(SUM(COALESCE(it.premium, 0) - COALESCE(it.payout, 0)), 2) AS bank_net
FROM public.insurance_transactions it
GROUP BY it.club_id, it.union_id, it.kind, (it.created_at AT TIME ZONE 'utc')::date;

CREATE OR REPLACE VIEW public.v_insurance_activity
WITH (security_invoker = true) AS
SELECT
  e.club_id,
  (e.created_at AT TIME ZONE 'utc')::date AS day,
  COUNT(*) FILTER (WHERE e.event = 'offered')    AS offers,
  COUNT(*) FILTER (WHERE e.event = 'accepted')   AS accepted,
  COUNT(*) FILTER (WHERE e.event = 'declined')   AS declined,
  COUNT(*) FILTER (WHERE e.event = 'timeout')    AS timeouts,
  COUNT(*) FILTER (WHERE e.event = 'cashed_out') AS cashouts,
  ROUND(AVG(e.equity_percent) FILTER (WHERE e.event = 'offered'), 1) AS avg_offer_equity,
  ROUND(AVG(e.pot) FILTER (WHERE e.event = 'offered'), 2)            AS avg_offer_pot
FROM public.insurance_offer_events e
GROUP BY e.club_id, (e.created_at AT TIME ZONE 'utc')::date;

-- Post-apply assertion: the insurance bank must reconcile TODAY, or this
-- migration itself is wrong about the pools.
DO $$
DECLARE bad INT;
BEGIN
  SELECT COUNT(*) INTO bad FROM (
    SELECT l.bank_type, l.bank_entity_id, l.bal,
           COALESCE(CASE WHEN l.bank_type='union'
                THEN (SELECT w.insurance_wallet FROM public.union_wallets w WHERE w.union_id=l.bank_entity_id)
                ELSE (SELECT c.insurance_balance FROM public.club_wallets c WHERE c.club_id=l.bank_entity_id) END, 0) AS stored
    FROM (SELECT bank_type, bank_entity_id, SUM(COALESCE(premium,0)-COALESCE(payout,0)) AS bal
          FROM public.insurance_transactions WHERE bank_entity_id IS NOT NULL
          GROUP BY 1,2) l
  ) x WHERE ABS(x.stored - x.bal) > 0.01;
  IF bad > 0 THEN
    RAISE EXCEPTION 'insurance bank does not reconcile at migration time (% entities drifted)', bad;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK (Tier 2):
--   DROP VIEW IF EXISTS public.v_insurance_activity;
--   DROP VIEW IF EXISTS public.v_insurance_pnl;
--   <recreate reconcile_ledger_nightly from the previous migration body
--    (identical to this one minus the insurance_bank section)>
-- ═══════════════════════════════════════════════════════════════════════════
