-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827061609; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- PHASE-2 PLATFORM AUDIT (2026-08-27): the reconciler stops shouting at a
-- corpse, and two grant hazards close. See the same-named file in
-- club-arena/supabase/migrations/ for the full finding write-up.
--
-- FINDING 1: reconcile_ledger_nightly reconciled chip_ledger against
-- public.wallets — the pool FROZEN 2026-08-21 with 732,591,994.33 stranded.
-- 575 wallets re-flagged critical every night (3,449 rows in 7 days), and the
-- one REAL alert (seat-stack exit #15448, 55 chips) drowned. A frozen pool's
-- invariant is IT DOES NOT MOVE: the per-wallet block becomes a single
-- baseline check.
-- FINDING 2: anon/authenticated held INSERT/UPDATE/DELETE on
-- trivia_tournaments, blocked only by absence of a write policy. Revoked.
-- FINDING 3: v_spin_tier_availability was SECURITY DEFINER over base tables
-- whose policies are already public-read — flipped to invoker.
-- trivia_tournaments_public stays DEFINER deliberately (answer-stripping
-- surface; base grants no SELECT); spatial_ref_sys is supabase_admin-owned
-- (cannot alter; known PostGIS limitation).

-- 1. Frozen-pool baseline
CREATE TABLE IF NOT EXISTS public.ca_frozen_pool_baseline (
  pool         text PRIMARY KEY,
  frozen_total numeric NOT NULL,
  frozen_at    timestamptz NOT NULL DEFAULT now(),
  note         text
);

ALTER TABLE public.ca_frozen_pool_baseline ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_frozen_pool_baseline FROM anon, authenticated;

INSERT INTO public.ca_frozen_pool_baseline (pool, frozen_total, note)
SELECT 'public.wallets', COALESCE(SUM(balance), 0),
       'Pool frozen 2026-08-21; retired from live flows. Baseline captured by this migration. Any change is a critical.'
  FROM public.wallets
ON CONFLICT (pool) DO NOTHING;

DO $$
DECLARE v numeric;
BEGIN
  SELECT frozen_total INTO v FROM public.ca_frozen_pool_baseline WHERE pool = 'public.wallets';
  IF v IS NULL OR v <= 0 THEN
    RAISE EXCEPTION 'baseline capture failed: frozen_total=%', v;
  END IF;
END $$;

-- 2. Reconciler: dead-pool per-wallet block out, freeze check in.
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

-- 3. Trivia write grants revoked
REVOKE INSERT, UPDATE, DELETE, REFERENCES, TRIGGER
  ON public.trivia_tournaments FROM anon, authenticated;

COMMENT ON VIEW public.trivia_tournaments_public IS
  'DELIBERATELY SECURITY DEFINER (advisor exception, 2026-08-27): the answer-stripping public read surface (removes correct_index/explanation). Base table grants no SELECT to anon/authenticated, so invoker would break the public listing while definer exposes only the stripped projection. Do not flip.';

-- 4. Spin availability view: invoker semantics
ALTER VIEW public.v_spin_tier_availability SET (security_invoker = true);
REVOKE REFERENCES, TRIGGER ON public.v_spin_tier_availability FROM anon, authenticated;

-- Post-apply assertions
DO $$
DECLARE g int; sec boolean;
BEGIN
  SELECT COUNT(*) INTO g FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='trivia_tournaments'
     AND grantee IN ('anon','authenticated')
     AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF g <> 0 THEN RAISE EXCEPTION 'trivia write grants survived: %', g; END IF;

  SELECT COALESCE((SELECT true FROM pg_class c
    WHERE c.relname='v_spin_tier_availability'
      AND c.reloptions::text LIKE '%security_invoker=true%'), false) INTO sec;
  IF NOT sec THEN RAISE EXCEPTION 'v_spin_tier_availability is not security_invoker'; END IF;
END $$;
