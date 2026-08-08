-- ============================================================================
-- AUDIT M4 — the ledger reconciliation does not reconcile anything
-- ============================================================================
--
-- M4 was filed as "the reconciliation formula double-subtracts locked balance,
-- so it reports a false imbalance equal to the sum of locked balances". That is
-- true of the arithmetic and irrelevant in practice: `locked_balance` is 0.00 on
-- all 1,836 wallets in production. Nothing has ever written it. The term is
-- multiplied by zero.
--
-- What is actually wrong is larger, and it was found by running the check
-- instead of reading it.
--
-- 1. IT RUNS IN EVERY BROWSER. `App.tsx` -> `bootServices` ->
--    `FinancialCronService.start()` schedules `runReconciliation()` 30 seconds
--    after boot and every 24 hours, in every open session.
--
-- 2. UNDER RLS IT SEES ONE WALLET. Probed as role `authenticated`: `wallets`
--    returns 1 row (the caller's own), `wallet_transactions` returns only that
--    user's rows, and the visible `category='mint'` total is 0.00. So the
--    "global" formula `minted - wallets - locked` evaluates to
--    `0 - (that user's balance) - 0`. The reported discrepancy is simply the
--    caller's own balance, negated. It is not a measurement of anything.
--
-- 3. IT HAS BEEN WRITING THAT TO AN OPS TABLE FOR FIVE MONTHS.
--    `financial_health_checks` holds 1,049 `ledger_reconciliation` rows dated
--    2026-03-13 to 2026-08-05: 1,039 failed, 10 passed, with 199 distinct
--    "difference" values between -14,427,910.23 and +2,200,000.00. The scatter
--    is the per-user signature. The 10 passes are users with a zero balance.
--    A check that fails 99% of the time trains everyone to ignore it, which is
--    worse than having no check — and M3 built durable CRITICAL alerting whose
--    natural consumer is this.
--
-- 4. ANY AUTHENTICATED USER CAN WRITE TO IT. The table's only INSERT policy is
--    "Authenticated users insert health checks" with no restriction, so the
--    financial audit history is client-writable.
--
-- 5. EVEN SERVER-SIDE THE FORMULA IS WRONG. `category='mint'` has exactly THREE
--    rows, all on 2026-03-08, totalling 2,200,000.01. Actual wallet holdings are
--    732,052,547.12. The real injection was `category='deposit'` (763 rows,
--    69,060,448.35) which the formula ignores entirely, and even
--    mint + deposit is two orders of magnitude short. Reconciling the whole
--    transaction log against holdings leaves 776,380,648.42 unexplained:
--    credits 281,729,874.76, debits 324,828,482.76, net -43,098,608.00, against
--    holdings of 732,052,603.08 in wallets plus 1,229,437.34 on tables. Several
--    categories simply stopped being written (`rake` ends 2026-04-02,
--    `transfer` 2026-03-19, `rebuy` 2026-04-19).
--
-- WHAT THIS MIGRATION DOES, AND WHAT IT DELIBERATELY DOES NOT
-- It does NOT ship a corrected conservation check. There is no defensible
-- genesis figure to reconcile against: `wallet_transactions` is a partial log,
-- and inventing a baseline would just replace a wrong number with a
-- confident-looking wrong number. Asserting balance against an unknown genesis
-- is the original bug.
--
-- Instead it establishes the thing that makes reconciliation possible: a
-- periodic, server-side SNAPSHOT of the components. Absolute conservation is
-- unknowable right now, but conservation BETWEEN TWO SNAPSHOTS is not —
-- delta(holdings) must equal delta(credits - debits) over the same window. That
-- is a real invariant, it needs no genesis, and it is exactly the invariant an
-- unbacked credit violates. Every mint M17 found would have shown up in it.
--
-- The first snapshot is the baseline. From the second onwards the delta check
-- is meaningful, and can be wired to the M3 alerting channel with a straight
-- face.
-- ============================================================================

-- ─── 1. The snapshot store ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chip_supply_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  taken_at          timestamptz NOT NULL DEFAULT now(),
  wallets_total     numeric NOT NULL,
  wallets_locked    numeric NOT NULL,
  table_stacks      numeric NOT NULL,
  tx_credits        numeric NOT NULL,
  tx_debits         numeric NOT NULL,
  wallet_count      integer NOT NULL,
  seat_count        integer NOT NULL,
  -- Component breakdown by category, so a future investigator can see WHERE a
  -- delta came from without re-deriving it from 2M transaction rows.
  credits_by_category jsonb NOT NULL DEFAULT '{}'::jsonb,
  debits_by_category  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Filled in from the previous snapshot. NULL on the very first row, which is
  -- the honest representation of "no baseline yet" - not 0, and not "balanced".
  delta_holdings    numeric,
  delta_tx_net      numeric,
  unexplained_delta numeric
);

CREATE INDEX IF NOT EXISTS idx_chip_supply_snapshots_taken_at
  ON public.chip_supply_snapshots (taken_at DESC);

ALTER TABLE public.chip_supply_snapshots ENABLE ROW LEVEL SECURITY;

-- Ops data. Readable by nobody client-side and writable by nobody client-side:
-- the whole point is that it cannot be influenced by the thing it measures.
REVOKE ALL ON TABLE public.chip_supply_snapshots FROM PUBLIC;
REVOKE ALL ON TABLE public.chip_supply_snapshots FROM anon;
REVOKE ALL ON TABLE public.chip_supply_snapshots FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chip_supply_snapshots TO service_role;

COMMENT ON TABLE public.chip_supply_snapshots IS
  'AUDIT M4: periodic server-side snapshot of total chip supply components. '
  'Absolute conservation is not currently checkable (wallet_transactions is a '
  'partial log and there is no trustworthy genesis figure), but conservation '
  'BETWEEN snapshots is: delta(holdings) must equal delta(credits - debits). '
  'Never make this table client-readable or client-writable.';

-- ─── 2. The snapshot function ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_snapshot_chip_supply()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_prev  public.chip_supply_snapshots%ROWTYPE;
  v_new   public.chip_supply_snapshots%ROWTYPE;
  v_w     numeric; v_l numeric; v_wc integer;
  v_s     numeric; v_sc integer;
  v_c     numeric; v_d numeric;
  v_cbc   jsonb;   v_dbc jsonb;
BEGIN
  SELECT COALESCE(sum(balance),0), COALESCE(sum(COALESCE(locked_balance,0)),0), count(*)
    INTO v_w, v_l, v_wc
  FROM public.wallets;

  SELECT COALESCE(sum(stack),0), count(*)
    INTO v_s, v_sc
  FROM public.table_seats WHERE left_at IS NULL;

  SELECT COALESCE(sum(amount) FILTER (WHERE type='credit'),0),
         COALESCE(sum(amount) FILTER (WHERE type='debit'),0)
    INTO v_c, v_d
  FROM public.wallet_transactions;

  SELECT COALESCE(jsonb_object_agg(category, total), '{}'::jsonb) INTO v_cbc
  FROM (SELECT category, round(sum(amount),2) AS total
        FROM public.wallet_transactions WHERE type='credit'
        GROUP BY category) c;

  SELECT COALESCE(jsonb_object_agg(category, total), '{}'::jsonb) INTO v_dbc
  FROM (SELECT category, round(sum(amount),2) AS total
        FROM public.wallet_transactions WHERE type='debit'
        GROUP BY category) d;

  SELECT * INTO v_prev
  FROM public.chip_supply_snapshots
  ORDER BY taken_at DESC LIMIT 1;

  INSERT INTO public.chip_supply_snapshots (
    wallets_total, wallets_locked, table_stacks,
    tx_credits, tx_debits, wallet_count, seat_count,
    credits_by_category, debits_by_category,
    delta_holdings, delta_tx_net, unexplained_delta
  )
  VALUES (
    v_w, v_l, v_s, v_c, v_d, v_wc, v_sc, v_cbc, v_dbc,
    -- All three deltas stay NULL on the first snapshot. There is no previous
    -- reading, and "no baseline yet" must not be reported as zero drift.
    CASE WHEN v_prev.id IS NULL THEN NULL
         ELSE (v_w + v_s) - (v_prev.wallets_total + v_prev.table_stacks) END,
    CASE WHEN v_prev.id IS NULL THEN NULL
         ELSE (v_c - v_d) - (v_prev.tx_credits - v_prev.tx_debits) END,
    CASE WHEN v_prev.id IS NULL THEN NULL
         ELSE ((v_w + v_s) - (v_prev.wallets_total + v_prev.table_stacks))
              - ((v_c - v_d) - (v_prev.tx_credits - v_prev.tx_debits)) END
  )
  RETURNING * INTO v_new;

  RETURN jsonb_build_object(
    'ok', true,
    'snapshot_id', v_new.id,
    'taken_at', v_new.taken_at,
    'holdings', v_w + v_s,
    'wallets_total', v_w,
    'table_stacks', v_s,
    'tx_net', v_c - v_d,
    'delta_holdings', v_new.delta_holdings,
    'delta_tx_net', v_new.delta_tx_net,
    'unexplained_delta', v_new.unexplained_delta,
    'is_baseline', (v_prev.id IS NULL)
  );
END;
$function$;

-- service_role ONLY. This must see every wallet, which is precisely why it can
-- never be granted to `authenticated` - under RLS a client-side caller sees one
-- row and computes nonsense, which is the bug being fixed.
REVOKE ALL ON FUNCTION public.fn_snapshot_chip_supply() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_snapshot_chip_supply() FROM anon;
REVOKE ALL ON FUNCTION public.fn_snapshot_chip_supply() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_snapshot_chip_supply() TO service_role;

COMMENT ON FUNCTION public.fn_snapshot_chip_supply() IS
  'AUDIT M4: records one chip-supply snapshot and its delta against the previous '
  'one. service_role ONLY - a client-side caller is RLS-scoped to its own wallet '
  'and would produce a per-user number, which is exactly what the browser-side '
  'reconciliation was doing for five months. Never grant to authenticated.';

-- ─── 3. Stop the client writing to the ops audit table ──────────────────────
-- The reconciliation that produced these rows is being removed from the client,
-- but the open INSERT policy is a separate problem: a financial audit trail that
-- any signed-in user can append to is not an audit trail.
DROP POLICY IF EXISTS "Authenticated users insert health checks" ON public.financial_health_checks;

CREATE POLICY financial_health_checks_service_insert
  ON public.financial_health_checks
  FOR INSERT TO service_role
  WITH CHECK (true);

COMMENT ON TABLE public.financial_health_checks IS
  'AUDIT M4: service_role writes only. The 1,049 ledger_reconciliation rows '
  'dated 2026-03-13..2026-08-05 predate this and are per-browser artefacts of an '
  'RLS-scoped client-side check - 1,039 failed, 10 passed, 199 distinct '
  'difference values. Treat that range as noise, not history.';
