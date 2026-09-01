-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831104550; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 20260831_treasury_baseline_and_reconcile_from_the_line.sql
-- TIER 3. The club_treasury check compared four days of ledger flow against an
-- all-time stored balance. Write the gap down (as ca_chip_baseline did for
-- player wallets on 2026-08-26) and measure forward from the line.
-- ONLY the club_treasury block of reconcile_ledger_nightly changes.
-- Thresholds are UNCHANGED. See repo file for full rationale + ROLLBACK.

DO $preflight$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='reconcile_ledger_nightly';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'PRE-FLIGHT: reconcile_ledger_nightly() does not exist.';
  END IF;

  IF v_src NOT LIKE '%frozen_wallets_pool%' OR v_src NOT LIKE '%insurance_bank%'
     OR v_src NOT LIKE '%insurance_offer_unresolved%' OR v_src NOT LIKE '%seat_stack_exit%'
     OR v_src NOT LIKE '%chip_circulation%' OR v_src NOT LIKE '%cashout_escrow_stuck%'
     OR v_src NOT LIKE '%negative_balance%' OR v_src NOT LIKE '%over_claimed_send%'
     OR v_src NOT LIKE '%bomb_award_ledger_gap%' THEN
    RAISE EXCEPTION 'PRE-FLIGHT: reconcile_ledger_nightly() is missing a check this migration expects to preserve.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname='fn_club_members_ledger_writer'
               AND p.prosrc LIKE '%club_treasury%') THEN
    RAISE EXCEPTION 'PRE-FLIGHT: the club_members trigger still invents a club_treasury counterparty. Apply migration 1 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND p.proname='fn_horse_fund_from_treasury'
                   AND p.prosrc LIKE '%INSERT INTO public.chip_ledger%') THEN
    RAISE EXCEPTION 'PRE-FLIGHT: the real treasury writers do not journal yet. Apply migration 2 first.';
  END IF;

  IF to_regclass('public.ca_treasury_baseline') IS NOT NULL THEN
    RAISE EXCEPTION 'PRE-FLIGHT: ca_treasury_baseline already exists. The line is drawn once.';
  END IF;
END;
$preflight$;

CREATE TABLE public.ca_treasury_baseline (
  club_id            uuid        PRIMARY KEY REFERENCES public.clubs(id) ON DELETE CASCADE,
  opening_balance    numeric     NOT NULL,
  ledger_at_baseline numeric     NOT NULL,
  unledgered_gap     numeric     NOT NULL,
  taken_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ca_treasury_baseline IS
  'Opening club_treasury balances at the 2026-08-31 cutover. Everything before taken_at is acknowledged as unreconstructable; reconcile_ledger_nightly measures chip_ledger flow forward from this line. Mirrors ca_chip_baseline for the player-wallet pool. Do NOT re-baseline: moving the line erases real drift.';

DO $baseline$
BEGIN
  PERFORM 1 FROM public.clubs FOR UPDATE;

  INSERT INTO public.ca_treasury_baseline
    (club_id, opening_balance, ledger_at_baseline, unledgered_gap)
  SELECT
    c.id,
    COALESCE(c.chip_treasury, 0),
    COALESCE(l.bal, 0),
    COALESCE(c.chip_treasury, 0) - COALESCE(l.bal, 0)
  FROM public.clubs c
  LEFT JOIN LATERAL (
    SELECT SUM(CASE WHEN cl.to_type   = 'club_treasury' THEN cl.amount ELSE 0 END)
         - SUM(CASE WHEN cl.from_type = 'club_treasury' THEN cl.amount ELSE 0 END) AS bal
    FROM public.chip_ledger cl
    WHERE (cl.to_type = 'club_treasury' AND cl.to_entity_id = c.id)
       OR (cl.from_type = 'club_treasury' AND cl.from_entity_id = c.id)
  ) l ON true;
END;
$baseline$;

CREATE OR REPLACE FUNCTION public.reconcile_ledger_nightly()
 RETURNS TABLE(total_checked integer, ok_count integer, warn_count integer, critical_count integer, worst_drift numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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
  DELETE FROM public.ledger_reconcile_log WHERE run_date = CURRENT_DATE;

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

  /* CLUB TREASURY, MEASURED FROM THE LINE (2026-08-31). */
  WITH cut AS (
    SELECT MIN(taken_at) AS t0 FROM public.ca_treasury_baseline
  ),
  base AS (
    SELECT club_id, opening_balance FROM public.ca_treasury_baseline
  ),
  credits AS (
    SELECT cl.to_entity_id AS club_id, SUM(cl.amount) AS amt
    FROM public.chip_ledger cl, cut
    WHERE cl.to_type = 'club_treasury' AND cl.to_entity_id IS NOT NULL
      AND cl.created_at >= cut.t0
    GROUP BY cl.to_entity_id
  ),
  debits AS (
    SELECT cl.from_entity_id AS club_id, SUM(cl.amount) AS amt
    FROM public.chip_ledger cl, cut
    WHERE cl.from_type = 'club_treasury' AND cl.from_entity_id IS NOT NULL
      AND cl.created_at >= cut.t0
    GROUP BY cl.from_entity_id
  ),
  ids AS (
    SELECT club_id FROM base
    UNION SELECT club_id FROM credits
    UNION SELECT club_id FROM debits
  ),
  ledger AS (
    SELECT i.club_id,
           COALESCE(b.opening_balance, 0)
             + COALESCE(c.amt, 0) - COALESCE(d.amt, 0) AS balance,
           COALESCE(b.opening_balance, 0) AS opening,
           COALESCE(c.amt, 0)             AS credited,
           COALESCE(d.amt, 0)             AS debited
    FROM ids i
    LEFT JOIN base    b ON b.club_id = i.club_id
    LEFT JOIN credits c ON c.club_id = i.club_id
    LEFT JOIN debits  d ON d.club_id = i.club_id
  ),
  stored AS (
    SELECT id AS club_id, COALESCE(chip_treasury, 0) AS balance FROM public.clubs
  ),
  merged AS (
    SELECT COALESCE(l.club_id, s.club_id) AS club_id,
           COALESCE(l.balance, 0) AS ledger_balance,
           COALESCE(s.balance, 0) AS stored_balance,
           COALESCE(l.opening, 0) AS opening,
           COALESCE(l.credited, 0) AS credited,
           COALESCE(l.debited, 0) AS debited
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
    jsonb_build_object('source', 'reconcile_ledger_nightly',
                       'basis', 'ca_treasury_baseline + post-cutover chip_ledger flow',
                       'opening_balance', opening,
                       'credited_since', credited,
                       'debited_since', debited,
                       'cutover', (SELECT MIN(taken_at) FROM public.ca_treasury_baseline))
  FROM merged
  WHERE club_id IS NOT NULL;

  -- INSURANCE + EV-CASHOUT BANK (2026-08-28)
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

  -- INSURANCE FUNNEL INTEGRITY (added 2026-08-28): every offer must resolve.
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'insurance_offer_unresolved', u.player_id, u.offered, u.resolved, 'critical',
         jsonb_build_object('source', 'reconcile_ledger_nightly',
                            'table_id', u.table_id, 'hand_number', u.hand_number,
                            'last_offer', u.last_offer)
  FROM public.fn_unresolved_insurance_offers('1 day'::interval) u;

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

  -- BOMB-POT AWARD LEDGER (added 2026-08-29)
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'bomb_award_ledger_gap', NULL, g.net_winnings, g.ledger_total, 'critical',
         jsonb_build_object(
           'source', 'fn_bomb_pot_ledger_gaps',
           'hand_history_id', g.hand_history_id,
           'table_id', g.table_id,
           'hand_number', g.hand_number,
           'occurred_at', g.occurred_at,
           'board_count', g.board_count,
           'trigger_reason', g.trigger_reason,
           'award_units', g.award_units)
  FROM public.fn_bomb_pot_ledger_gaps('1 day'::interval) g;

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

DO $postapply$
DECLARE
  v_src text;
  v_clubs int;
  v_base  int;
  v_crit  int;
  v_rows  text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='reconcile_ledger_nightly';

  IF v_src NOT LIKE '%frozen_wallets_pool%' OR v_src NOT LIKE '%insurance_bank%'
     OR v_src NOT LIKE '%insurance_offer_unresolved%' OR v_src NOT LIKE '%seat_stack_exit%'
     OR v_src NOT LIKE '%chip_circulation%' OR v_src NOT LIKE '%cashout_escrow_stuck%'
     OR v_src NOT LIKE '%negative_balance%' OR v_src NOT LIKE '%over_claimed_send%'
     OR v_src NOT LIKE '%bomb_award_ledger_gap%' THEN
    RAISE EXCEPTION 'POST-APPLY: a non-treasury check was lost in the rewrite.';
  END IF;

  IF v_src NOT LIKE '%ca_treasury_baseline%' THEN
    RAISE EXCEPTION 'POST-APPLY: the club_treasury block does not read the baseline.';
  END IF;

  IF v_src NOT LIKE '%ABS(stored_balance - ledger_balance) <= 1.00 THEN ''warn''%' THEN
    RAISE EXCEPTION 'POST-APPLY: the club_treasury severity thresholds were changed. They must not be.';
  END IF;

  SELECT count(*) INTO v_clubs FROM public.clubs;
  SELECT count(*) INTO v_base  FROM public.ca_treasury_baseline;
  IF v_base <> v_clubs THEN
    RAISE EXCEPTION 'POST-APPLY: baselined % clubs but % exist.', v_base, v_clubs;
  END IF;

  PERFORM public.reconcile_ledger_nightly();

  SELECT count(*) INTO v_crit FROM public.ledger_reconcile_log
   WHERE run_date = CURRENT_DATE AND entity_type = 'club_treasury' AND severity <> 'ok';

  SELECT string_agg(format('%s: stored=%s ledger=%s drift=%s severity=%s',
                           entity_id, stored_balance, ledger_balance,
                           stored_balance - ledger_balance, severity), ' | ')
    INTO v_rows
    FROM public.ledger_reconcile_log
   WHERE run_date = CURRENT_DATE AND entity_type = 'club_treasury';

  IF v_crit > 0 THEN
    RAISE WARNING 'POST-APPLY: % club_treasury row(s) are not ok. Residual: %', v_crit, v_rows;
  ELSE
    RAISE NOTICE 'POST-APPLY OK: every club_treasury row reports ok. %', v_rows;
  END IF;
END;
$postapply$;
