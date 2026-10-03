-- 20261003092151_the_overdue_agent_commission_is_paid_from_the_club_bank.sql
--
-- THE OVERDUE AGENT COMMISSION WEEKS ARE PAID FROM THE CLUB BANK
-- (one-off, runs once; operation c419b506-79a3-465a-99ba-adca6e0e5c2e)
--
-- WHAT WAS OWED. agent_commission_unsettled_rollup read 2,361,330.13 across
-- 239 (club, agent) pairs at 2026-10-03 09:11 UTC. About 1.18M of it is the
-- open week 2026-09-28 07:00Z -> 10-05 07:00Z and is paid by that week's own
-- close; it is not touched here. The rest is 1,162,765.28 of recorded,
-- unsettled agent commission created before 2026-09-28 07:00Z
-- (docs/changelog/2026-10-03-launch-money-and-alert-hygiene.md section 1),
-- measured read-only per club and week on 2026-10-03 09:15 UTC:
--
--   Deep Stack Society  560,017.06  weeks 08-31, 09-07 (club floor 09-21)
--   SHARK CLUB          485,808.88  weeks 04-27 .. 08-24, plus 88.12 of 09-14
--   Club JAQK           113,695.75  weeks 04-27, 07-20 .. 08-24, plus 127.27 of 09-14
--   Midway Union          3,243.59  weeks 08-17 .. 09-14 (the union's house club)
--
-- No payment for any of it exists in wallet_transactions or chip_transactions.
-- The weekly close refuses those weeks by design (floors 2026-09-21, accrual
-- cutover 2026-09-17), the agent claim that used to pay them is retired
-- (fn_agent_claim_commission now answers "settled automatically"), and
-- fn_accounting_legacy_certify_week only discharges a week recorded in
-- accounting_deferred_obligations, which these weeks are not. So nothing in
-- the platform can ever pay them: this is the one-off that does.
--
-- THE BASIS IS THE RECORDED ROWS, AND THE PAYER IS THE CLUB BANK.
--   * The weekly close pays an agent exactly the sum of his recorded rows for
--     the period (kingfish, SHARK CLUB, week 09-21: 3,757 rows, 825.74 summed
--     and 825.74 settled), so the recorded rows are the platform's own basis.
--   * Dan, 2026-09-01, on the legacy commission rows that had been stamped
--     settled with no payment: "ITS RAKE BACK RIGHT? PAY IT OUT FROM THE OWNER
--     ACCOUNT FROM THE CLUB BANK" (docs/changelog/2026-09-01-the-agents-books-
--     tell-the-truth.md). These are those rows and their successors.
--   * Every pair is paid its own recorded amount directly, club_treasury ->
--     player_wallet, category commission: one leg, one wallet credit, one
--     receipt (settlement_invoices + Messenger record + notification, made by
--     the accounting_transfer_document trigger and asserted per leg).
--
-- HORSES ARE PAID THE SAME WAY. 236 of the 239 pairs are house horses. They
-- are paid, not waived: CLAUDE.md 10.5 (a horse EARNS agent commissions and IS
-- PAID everything a human is paid, "Never 'skip the horses' on a repayment"),
-- Dan's 2026-09-26 ruling that reversed the closure of the week of 09-14
-- "without payment because every recipient is a house horse"
-- (docs/changelog/2026-09-26-horses-are-paid-the-clawback-returns-and-two-
-- closures-reopen.md), and operation 19aa02d6, which paid 784,513.37 of that
-- week's commission to horse agents. A waiver here would be the 093159 write-off
-- again.
--
-- THE ONE HUMAN. kingfish (47965354-0e56-43ef-931c-ddaab82af765) is paid
-- 3,556.42: Club JAQK 13.00 (2 rake rows of 2026-04-28), SHARK CLUB 3,460.51
-- (weeks 08-17 and 08-24: 8,515 rows), Midway Union 82.91 (weeks 08-17 ..
-- 09-07: 135 rows). His open-week rows (4,973.74 at 09:15) stay with the
-- 10-05 close.
--
-- FUNDING. The payer is the recorded club's bank; where the bank cannot carry
-- the payment, the house funds it first through a sanctioned door:
--   * Club JAQK, SHARK CLUB and the union's house club hold 44.76, 11,120.68
--     and 0.02. The weeks they owe were never closed by the union (Dan,
--     2026-09-02: the old-basis weeks are never settled), so the clubs' share of
--     that rake never left the union rake treasury (3,483,247.32 at 09:15).
--     The union funds each of them exactly what it pays its agents here
--     (union_wallet -> club_treasury, the round-1 leg shape of 19aa02d6), so
--     each club bank ends where it started.
--   * Deep Stack Society is standalone. Its rake of those weeks was credited to
--     its treasury at the hand (before 20260917181100 retired standalone rake)
--     and has since been spent; the treasury now holds 638,780.09, which is the
--     banked rake of 09-14 and 09-21 and must carry the 10-05 close (open-week
--     commission 406,689.40 at 08:00 against a week of rake still to bank).
--     The house funds it by exactly this payment through fn_ca_fund_club (the
--     ledgered system_mint door with its register row, as 20261002092328 did
--     for this club's share of the week of 09-14), so the payment does not
--     starve the open week.
--
-- PAYEE WALLET. A pair is paid into the agent's wallet in the club that
-- recorded the commission. 79 pairs (59 Deep Stack Society, 20 Midway Union,
-- 3,119.47 between them, 3,033.38 of it two Midway agents) have no wallet in
-- that club; as in operation e5b10b0a ("a payee with no account in the
-- recorded club is paid to a player wallet"), they are paid into their wallet
-- in a union member club, else their lowest-id club. The payer is still the
-- recorded club and the leg says so (metadata.recorded_club_id).
--
-- SETTLED, NOT STAMPED. Stamping settled_at on ~3.6M rows outlasts the apply
-- door (2026-10-02 05:26Z). As the weekly stage and 19aa02d6 do, each paid
-- (pair, week) gets one agent_commission_settlements row spanning exactly its
-- paid rows (first created_at .. last created_at + 1 microsecond), ref
-- owner_legacy_commission:c419b506-..., which the rollup and every reader
-- exclude. No span may overlap an existing settlement of the pair. The rollup
-- is brought down by 20261003092205 in its own short transaction (a recompute
-- inside a payment deadlocked on 2026-10-02 06:18Z).
--
-- RUNS ONCE. A replay finds its own legs or settlement rows and refuses whole.
-- Any moved figure refuses the whole transaction. Refuses inside :45-:04 and
-- during a platform freeze or settlement freeze. No cron, watcher or retry,
-- no clearing account, no row deleted, no settled record rewritten.
--
-- @live-proof: (SELECT count(*) > 0 FROM public.agent_commission_settlements WHERE settlement_ref = 'owner_legacy_commission:c419b506-79a3-465a-99ba-adca6e0e5c2e')
-- @live-proof: (SELECT count(*) = 1 FROM public.chip_ledger WHERE idempotency_key = 'owner_legacy_commission:c419b506-79a3-465a-99ba-adca6e0e5c2e:pay:a41434bb-8d0c-400a-8f0d-e8b3d65afed4:47965354-0e56-43ef-931c-ddaab82af765')

BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '840s';

DO $op$
DECLARE
  c_op     CONSTANT uuid := 'c419b506-79a3-465a-99ba-adca6e0e5c2e';
  c_ref    CONSTANT text := 'owner_legacy_commission:c419b506-79a3-465a-99ba-adca6e0e5c2e';
  c_union  CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';
  c_dss    CONSTANT uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  c_jaqk   CONSTANT uuid := 'a0000000-0000-0000-0000-000000000001';
  c_shark  CONSTANT uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  c_kf     CONSTANT uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  c_sys    CONSTANT uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_cut    CONSTANT timestamptz := '2026-09-28 07:00:00+00';
  r record;
  v_club_skip text; v_member_skip text; v_union_skip text; v_category text; v_ctx text;
  v_total numeric; v_union_total numeric := 0; v_rows bigint; v_pairs int; v_legs int := 0; v_fund_legs int := 0;
  v_cb numeric; v_ca numeric; v_pb numeric; v_pa numeric; v_rw_before numeric; v_rw_after numeric;
  v_lid uuid; v_mint jsonb; v_settled int; v_result jsonb; v_plan_total numeric; v_plan_union numeric;
BEGIN
  -- 1. The door is open and this has not run.
  IF public.fn_platform_frozen() OR extract(minute FROM clock_timestamp()) >= 45 OR extract(minute FROM clock_timestamp()) < 4 THEN
    RAISE EXCEPTION 'overdue commission: outside :04-:44 or the platform is frozen' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN
    RAISE EXCEPTION 'overdue commission: EMERGENCY_PROFIT_DRIFT_LOCK is active';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('owner-legacy-commission:' || c_op::text, 0));
  IF EXISTS (SELECT 1 FROM public.agent_commission_settlements WHERE settlement_ref = c_ref)
     OR EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key LIKE c_ref || ':%')
     OR EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = 'club-funding:' || c_dss::text || ':' || c_ref) THEN
    RAISE EXCEPTION 'overdue commission: operation % already ran; never replay', c_op;
  END IF;

  -- 2. The plan: every recorded, unsettled, uncovered row before the open week,
  --    by (club, agent, week). Weeks are Monday 07:00Z, anchored on c_cut.
  --    Every pair with an unsettled row has a rollup row (its insert trigger
  --    writes one), so the clubs come from the rollup and each club is read
  --    through its own range of agent_commissions_open_idx (club_id, user_id,
  --    created_at) WHERE settled_at IS NULL. Measured 2026-10-03: under a
  --    minute a club. The figures below prove nothing was missed.
  CREATE TEMP TABLE _oc_rows ON COMMIT DROP AS
    SELECT q.* FROM (SELECT DISTINCT club_id FROM public.agent_commission_unsettled_rollup
                      WHERE oldest_unsettled < c_cut) k
    CROSS JOIN LATERAL (
      SELECT ac.club_id, ac.user_id,
             floor((extract(epoch FROM ac.created_at) - extract(epoch FROM c_cut)) / 604800)::int AS wk,
             count(*)::int AS n, sum(ac.amount) AS amount, min(ac.created_at) AS first_at, max(ac.created_at) AS last_at
        FROM public.agent_commissions ac
       WHERE ac.club_id = k.club_id
         AND ac.settled_at IS NULL AND ac.created_at < c_cut AND ac.user_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                          WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                            AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)
       GROUP BY 1, 2, 3) q;

  IF EXISTS (SELECT 1 FROM _oc_rows WHERE amount IS NULL OR amount < 0 OR amount <> round(amount, 2)) THEN
    RAISE EXCEPTION 'overdue commission: a (pair, week) is not a positive whole-cent amount: %',
      (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM _oc_rows WHERE amount IS NULL OR amount < 0 OR amount <> round(amount, 2) LIMIT 5) x);
  END IF;
  -- The measured figures. Old weeks do not move; if these do, refuse.
  IF (SELECT COALESCE(sum(amount), 0) FROM _oc_rows WHERE club_id = c_dss)   <> 560017.06
  OR (SELECT COALESCE(sum(amount), 0) FROM _oc_rows WHERE club_id = c_shark) <> 485808.88
  OR (SELECT COALESCE(sum(amount), 0) FROM _oc_rows WHERE club_id = c_jaqk)  <> 113695.75
  OR (SELECT COALESCE(sum(amount), 0) FROM _oc_rows WHERE club_id = c_union) <> 3243.59
  OR (SELECT sum(amount) FROM _oc_rows) <> 1162765.28
  OR (SELECT sum(amount) FROM _oc_rows WHERE user_id = c_kf) <> 3556.42
  OR (SELECT sum(amount) FROM _oc_rows WHERE user_id = c_kf AND club_id = c_shark) <> 3460.51 THEN
    RAISE EXCEPTION 'overdue commission: the recorded figures moved: %',
      (SELECT jsonb_object_agg(club_id::text, s) FROM (SELECT club_id, sum(amount) s FROM _oc_rows GROUP BY 1) x);
  END IF;
  -- No paid span may overlap a settlement the pair already has.
  IF EXISTS (SELECT 1 FROM _oc_rows o JOIN public.agent_commission_settlements s
              ON s.club_id = o.club_id AND s.user_id = o.user_id
             AND s.period_start < o.last_at + interval '1 microsecond' AND s.period_end > o.first_at) THEN
    RAISE EXCEPTION 'overdue commission: a paid span overlaps an existing settlement period';
  END IF;

  CREATE TEMP TABLE _oc_pay ON COMMIT DROP AS
    SELECT o.club_id AS payer_club, o.user_id, sum(o.amount) AS amount, sum(o.n)::bigint AS n,
           COALESCE(c.union_id = c_union, false) AS union_scope, NULL::uuid AS wallet_club,
           NULL::numeric AS opening, NULL::numeric AS closing
      FROM _oc_rows o JOIN public.clubs c ON c.id = o.club_id
     GROUP BY o.club_id, o.user_id, c.union_id;
  UPDATE _oc_pay p SET wallet_club = (
    SELECT cm.club_id FROM public.club_members cm JOIN public.clubs c ON c.id = cm.club_id
     WHERE cm.user_id = p.user_id
     ORDER BY (cm.club_id = p.payer_club) DESC,
              (c.union_id IS NOT DISTINCT FROM c_union AND NOT COALESCE(c.is_union, false)) DESC,
              cm.club_id
     LIMIT 1);
  IF EXISTS (SELECT 1 FROM _oc_pay WHERE wallet_club IS NULL) THEN
    RAISE EXCEPTION 'overdue commission: an agent has no wallet in any club: %',
      (SELECT jsonb_agg(jsonb_build_object('club', payer_club, 'user', user_id, 'amount', amount)) FROM _oc_pay WHERE wallet_club IS NULL);
  END IF;
  IF EXISTS (SELECT 1 FROM _oc_pay WHERE NOT union_scope AND payer_club <> c_dss) THEN
    RAISE EXCEPTION 'overdue commission: an unexpected standalone payer club';
  END IF;
  SELECT count(*), sum(n), sum(amount), COALESCE(sum(amount) FILTER (WHERE union_scope), 0)
    INTO v_pairs, v_rows, v_plan_total, v_plan_union FROM _oc_pay;

  -- The plan is read; the writes still have to finish before the break.
  IF public.fn_platform_frozen() OR extract(minute FROM clock_timestamp()) >= 45 OR extract(minute FROM clock_timestamp()) < 4 THEN
    RAISE EXCEPTION 'overdue commission: the plan finished outside :04-:44; nothing written' USING ERRCODE = '55000';
  END IF;

  -- 3. Every row this writes is locked up front, back to back, before any
  --    write (20261002080718): clubs by id, the union rake row, payee wallets.
  PERFORM id FROM public.clubs WHERE id IN (SELECT payer_club FROM _oc_pay) ORDER BY id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.union_wallets WHERE union_id = c_union FOR NO KEY UPDATE;
  PERFORM cm.user_id FROM public.club_members cm JOIN _oc_pay p ON p.wallet_club = cm.club_id AND p.user_id = cm.user_id
    ORDER BY cm.club_id, cm.user_id FOR NO KEY UPDATE OF cm;
  UPDATE _oc_pay p SET opening = cm.chip_balance FROM public.club_members cm WHERE cm.club_id = p.wallet_club AND cm.user_id = p.user_id;

  -- 4. The house funds Deep Stack Society by exactly its payment, through the
  --    sanctioned issuance door (before the autoledger is stood down).
  SELECT sum(amount) INTO v_total FROM _oc_pay WHERE payer_club = c_dss;
  IF v_total > 0 THEN
    v_mint := public.fn_ca_fund_club(c_dss, v_total,
      'Owner-authorized one-off (CLAUDE.md 10.9, operation ' || c_op::text || '): funds the overdue agent commission of the weeks '
      || '2026-08-31 and 2026-09-07 that this standalone club recorded and never paid (' || v_total::text || '). The rake those weeks earned was '
      || 'credited to this treasury at the hand and has since been spent; the house re-funds it so the payment does not starve the open week.',
      'club-funding:' || c_dss::text || ':' || c_ref);
    IF COALESCE((v_mint->>'ok')::boolean, false) IS NOT TRUE OR COALESCE((v_mint->>'replayed')::boolean, false) THEN
      RAISE EXCEPTION 'overdue commission: Deep Stack Society funding failed: %', v_mint;
    END IF;
  END IF;

  v_club_skip := current_setting('app.ledger_autoskip_clubs', true);
  v_member_skip := current_setting('app.ledger_autoskip_club_members', true);
  v_union_skip := current_setting('app.ledger_autoskip_union_wallets', true);
  v_category := current_setting('app.ledger_category', true);
  v_ctx := current_setting('app.accounting_routing_context', true);
  PERFORM public.fn_ca_declare_ledger('rakeback', 'union_wallet', c_union, NULL, NULL, ARRAY['union_wallets', 'clubs', 'club_members']);

  -- 5. The union funds each of its clubs exactly what that club pays here.
  FOR r IN SELECT payer_club, sum(amount) AS amount FROM _oc_pay WHERE union_scope GROUP BY 1 ORDER BY 1 LOOP
    SELECT chip_treasury INTO v_cb FROM public.clubs WHERE id = r.payer_club;
    UPDATE public.clubs SET chip_treasury = chip_treasury + r.amount WHERE id = r.payer_club RETURNING chip_treasury INTO v_ca;
    IF v_ca IS NULL OR v_ca - v_cb <> r.amount THEN
      RAISE EXCEPTION 'overdue commission: funding of club % did not land', r.payer_club;
    END IF;
    INSERT INTO public.chip_ledger(performed_by, from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, union_id,
        description, idempotency_key, metadata, pre_to_balance, post_to_balance)
    VALUES (c_sys, 'union_wallet', c_union, 'club_treasury', r.payer_club, r.amount, 'rakeback', r.payer_club, c_union,
        'Union funds its club for the overdue agent commission of the pre-floor weeks (owner-authorized one-off)',
        c_ref || ':fund:' || r.payer_club::text,
        jsonb_build_object('legacy_commission_operation_id', c_op, 'purpose', 'fund_overdue_agent_commission', 'cutoff', c_cut),
        v_cb, v_ca)
    RETURNING id INTO v_lid;
    IF NOT EXISTS (SELECT 1 FROM public.settlement_invoices i WHERE i.source_ledger_id = v_lid AND i.status = 'paid'
                    AND i.net_amount = r.amount AND i.chips_transferred AND i.message_sent
                    AND EXISTS (SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id = i.id)) THEN
      RAISE EXCEPTION 'overdue commission: funding receipt missing for club %', r.payer_club;
    END IF;
    v_union_total := v_union_total + r.amount;
    v_fund_legs := v_fund_legs + 1;
  END LOOP;

  -- 6. Each club bank pays each agent its recorded overdue commission.
  FOR r IN SELECT * FROM _oc_pay ORDER BY payer_club, user_id LOOP
    PERFORM set_config('app.ledger_category', 'commission', true);
    SELECT chip_treasury INTO v_cb FROM public.clubs WHERE id = r.payer_club;
    SELECT chip_balance INTO v_pb FROM public.club_members WHERE club_id = r.wallet_club AND user_id = r.user_id;
    UPDATE public.clubs SET chip_treasury = chip_treasury - r.amount
     WHERE id = r.payer_club AND chip_treasury >= r.amount RETURNING chip_treasury INTO v_ca;
    UPDATE public.club_members SET chip_balance = chip_balance + r.amount, updated_at = now()
     WHERE club_id = r.wallet_club AND user_id = r.user_id RETURNING chip_balance INTO v_pa;
    IF v_ca IS NULL OR v_pa IS NULL OR v_cb - v_ca <> r.amount OR v_pa - v_pb <> r.amount THEN
      RAISE EXCEPTION 'overdue commission: transfer not conserved for % / % (bank %)', r.payer_club, r.user_id, v_cb;
    END IF;
    INSERT INTO public.wallet_transactions(user_id, wallet_type, type, amount, category, description, balance_after)
    VALUES (r.user_id, 'PLAYER', 'credit', r.amount, 'commission',
            'Overdue agent commission of the weeks before 2026-09-28, paid by the club bank (owner-authorized one-off)', v_pa);
    INSERT INTO public.chip_ledger(performed_by, from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, union_id,
        description, idempotency_key, metadata, pre_from_balance, post_from_balance, pre_to_balance, post_to_balance)
    VALUES (c_sys, 'club_treasury', r.payer_club, 'player_wallet', r.user_id, r.amount, 'commission', r.wallet_club,
        CASE WHEN r.union_scope THEN c_union END,
        'Overdue agent commission of the weeks before 2026-09-28 (owner-authorized one-off)',
        c_ref || ':pay:' || r.payer_club::text || ':' || r.user_id::text,
        jsonb_build_object('legacy_commission_operation_id', c_op, 'recorded_club_id', r.payer_club, 'wallet_club_id', r.wallet_club,
          'recorded_rows', r.n, 'cutoff', c_cut, 'basis', 'recorded agent_commissions rows, unsettled and uncovered',
          'weeks', (SELECT jsonb_agg(jsonb_build_object('first_at', o.first_at, 'last_at', o.last_at, 'rows', o.n, 'amount', o.amount) ORDER BY o.wk)
                      FROM _oc_rows o WHERE o.club_id = r.payer_club AND o.user_id = r.user_id)),
        v_cb, v_ca, v_pb, v_pa)
    RETURNING id INTO v_lid;
    IF (SELECT count(*) FROM public.settlement_invoices i WHERE i.source_ledger_id = v_lid AND i.status = 'paid'
          AND i.chips_transferred AND i.message_sent AND i.net_amount = r.amount
          AND EXISTS (SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id = i.id)) <> 1 THEN
      RAISE EXCEPTION 'overdue commission: receipt missing for % / %', r.payer_club, r.user_id;
    END IF;
    v_legs := v_legs + 1;
  END LOOP;

  -- 7. The union rake treasury: one debit for everything it funded.
  IF v_union_total > 0 THEN
    SELECT rake_wallet INTO v_rw_before FROM public.union_wallets WHERE union_id = c_union;
    UPDATE public.union_wallets SET rake_wallet = rake_wallet - v_union_total,
           total_settlements = COALESCE(total_settlements, 0) + v_union_total, updated_at = now()
     WHERE union_id = c_union AND rake_wallet >= v_union_total RETURNING rake_wallet INTO v_rw_after;
    IF v_rw_after IS NULL OR v_rw_before - v_rw_after <> v_union_total THEN
      RAISE EXCEPTION 'overdue commission: union rake treasury short: % of %', v_rw_before, v_union_total;
    END IF;
    INSERT INTO public.union_wallet_transactions(union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes)
    SELECT c_union, x.payer_club, x.amount, 'rakeback', 'rake_wallet', 'debit',
           v_rw_before - sum(x.amount) OVER (ORDER BY x.payer_club),
           'Funds this club for the overdue agent commission of the pre-floor weeks (operation ' || c_op::text || ')'
      FROM (SELECT payer_club, sum(amount) AS amount FROM _oc_pay WHERE union_scope GROUP BY 1) x;
  END IF;

  PERFORM set_config('app.ledger_autoskip_clubs', COALESCE(v_club_skip, ''), true);
  PERFORM set_config('app.ledger_autoskip_club_members', COALESCE(v_member_skip, ''), true);
  PERFORM set_config('app.ledger_autoskip_union_wallets', COALESCE(v_union_skip, ''), true);
  PERFORM set_config('app.ledger_category', COALESCE(v_category, ''), true);
  PERFORM set_config('app.accounting_routing_context', COALESCE(v_ctx, ''), true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);

  -- 8. The paid rows are settled by period, one row per (pair, week).
  INSERT INTO public.agent_commission_settlements(club_id, user_id, union_id, period_start, period_end, amount, rows_count, paid_at, settlement_ref)
  SELECT o.club_id, o.user_id, p.union_scope_union, o.first_at, o.last_at + interval '1 microsecond', o.amount, o.n, now(), c_ref
    FROM _oc_rows o
    JOIN (SELECT payer_club, user_id, CASE WHEN union_scope THEN c_union END AS union_scope_union FROM _oc_pay) p
      ON p.payer_club = o.club_id AND p.user_id = o.user_id;
  GET DIAGNOSTICS v_settled = ROW_COUNT;
  IF v_settled <> (SELECT count(*) FROM _oc_rows) THEN
    RAISE EXCEPTION 'overdue commission: % of % settlement periods written', v_settled, (SELECT count(*) FROM _oc_rows);
  END IF;

  -- 9. Conservation, on the balances themselves.
  UPDATE _oc_pay p SET closing = cm.chip_balance FROM public.club_members cm WHERE cm.club_id = p.wallet_club AND cm.user_id = p.user_id;
  IF EXISTS (SELECT 1 FROM (SELECT wallet_club, user_id, min(opening) o, min(closing) c, sum(amount) a FROM _oc_pay GROUP BY 1, 2) q
              WHERE q.c IS DISTINCT FROM q.o + q.a) THEN
    RAISE EXCEPTION 'overdue commission: a payee balance is not opening + paid';
  END IF;
  IF v_legs <> v_pairs OR (SELECT count(*) FROM public.chip_ledger WHERE idempotency_key LIKE c_ref || ':%') <> v_pairs + v_fund_legs
     OR (SELECT sum(amount) FROM public.chip_ledger WHERE idempotency_key LIKE c_ref || ':pay:%') <> v_plan_total
     OR (SELECT sum(amount) FROM public.chip_ledger WHERE idempotency_key LIKE c_ref || ':fund:%') <> v_plan_union
     OR v_union_total <> v_plan_union THEN
    RAISE EXCEPTION 'overdue commission: legs do not add up (pairs %, legs %, fund legs %, union %)', v_pairs, v_legs, v_fund_legs, v_union_total;
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key LIKE c_ref || ':%'
              AND (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')) THEN
    RAISE EXCEPTION 'overdue commission: a leg touched the clearing account';
  END IF;

  v_result := jsonb_build_object('operation_id', c_op, 'cutoff', c_cut, 'pairs', v_pairs, 'rows_settled', v_rows,
    'settlement_periods', v_settled, 'paid', v_plan_total, 'legs', v_legs, 'union_funding', v_union_total,
    'union_rake_wallet_before', v_rw_before, 'union_rake_wallet_after', v_rw_after,
    'dss_funding', v_mint,
    'by_club', (SELECT jsonb_object_agg(payer_club::text, s) FROM (SELECT payer_club, sum(amount) s FROM _oc_pay GROUP BY 1) x),
    'kingfish', (SELECT jsonb_object_agg(payer_club::text, amount) FROM _oc_pay WHERE user_id = c_kf),
    'payees_outside_recorded_club', (SELECT count(*) FROM _oc_pay WHERE wallet_club <> payer_club));

  -- The commit-time ledger checks run here, inside the operation.
  SET CONSTRAINTS ALL IMMEDIATE;

  RAISE NOTICE 'overdue agent commission paid: %', v_result;
END
$op$;

COMMIT;
