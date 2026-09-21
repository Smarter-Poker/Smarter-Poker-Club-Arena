-- 20260921064151_rakeback_close_refuses_a_stale_daily_cache.sql
--
-- TWO THINGS, ONE TRANSACTION (production DDL policy, CLAUDE.md section 2
-- rule 1: one change, one BEGIN/COMMIT, one PostgREST reload).
--
-- 1. THE ROOT FIX. fn_close_settlement_period chose its rakeback basis by
--    counting ROWS in rakeback_daily_state for the period's days and, if it
--    found one per day, reading rakeback_daily_user. It never asked whether
--    those rows were CURRENT. rakeback_daily_user is a derived cache whose
--    only writer, fn_rakeback_recompute_day, is called by nothing on a
--    schedule; it last ran at 2026-09-17 07:29 and stopped. So on
--    2026-09-21 the week of 09-14 stood at:
--
--      club-day                rows_seen   rows actually present
--      2a1132b9 2026-09-17         5,106                  36,606
--      2a1132b9 2026-09-18             0                  46,228
--      2a1132b9 2026-09-19             0                  40,652
--      2a1132b9 2026-09-20             0                  33,735
--      fade0000 2026-09-17         4,591                  59,426
--      fade0000 2026-09-18             0                  64,152
--      fade0000 2026-09-19             0                  33,785
--      fade0000 2026-09-20             0                  11,648
--
--    All seven days carried a state row, so the guard passed and the basis
--    came from a cache that was empty for three of them: 173,325.52 cached
--    against 629,495.88 real. The Monday 10:30 UTC payer
--    (/api/cron/rakeback-period-settle -> settle_club_rakeback ->
--    fn_close_settlement_period) would have paid Deep Stack Society's 373
--    payable periods 13,798.91 instead of 62,688.06 - 225 of them
--    understated - and stamped every one 'paid', after which the function
--    returns 'skipped' for ever. Midway Union's 493 would have deferred on a
--    0.02 treasury, so nothing there was lost, and no period anywhere would
--    have been stamped paid at zero (all had a positive cached basis).
--
--    A day is now counted only when no qualifying rake record for that
--    club-day arrived after the cache was computed. A stale or cold day
--    falls to the ELSE branch - the full fn_rake_shares_for_record scan that
--    was always there - so the cache becomes a pure optimisation that cannot
--    cost a player money. Verified against live data before shipping: the
--    predicate marked 09-14/15/16 fresh (0 late arrivals) and 09-17/18/19/20
--    stale, with no false result either way.
--
--    The stale days were then rebuilt through the table's own writer
--    (fn_rakeback_recompute_day, force=true, 8 club-days, 2,436 user-day
--    rows), so the correct answer is also the fast one. That is the
--    product's own idempotent writer being run, not a new repair job: no
--    cron, sweep, backfill or compensating write is created here, and none
--    may be (CLAUDE.md 10.12). What remains and is NOT fixed here is that
--    nothing calls fn_rakeback_recompute_day on a schedule; with this guard
--    in place that is a performance question, not a money one, and a new
--    schedule is the owner's to place on Open Claw (CLAUDE.md 10.85, 11).
--
-- 2. THE DECIDED OUTCOME of the 2026-09-17 cash accrual cutover gap,
--    recorded so it is a closed decision and not an open question. Detail
--    in the resolution text below.
--
-- NOTE FOR WHOEVER IS REFUSED BY THE CUTOVER GUARD NEXT. The HINT inside
-- fn_ca_guard_cash_cutover_not_ahead_of_settler describes the 2026-09-17
-- incident as "stranded 150 hands holding 266.61 of rake". Measured on
-- 2026-09-21 the real figure is 35,995 cash hands holding 70,266.90 - the
-- hint understates it by more than two orders of magnitude. The guard's
-- BEHAVIOUR is correct and was verified firing on 2026-09-21 (a cutover
-- five hours ahead was refused, and the singleton row is immutable besides),
-- so only its prose is wrong and it is left alone here rather than reopening
-- a money guard for a comment. The accurate numbers are in the
-- financial_alerts row written below.
--
-- No money moves in this migration.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(p_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period         record;
  v_admitted_club uuid;
  v_rake_total     numeric;
  v_rate           numeric;
  v_payout         numeric;
  v_payout_id      uuid;
  v_days_needed    int;
  v_days_have      int;
  v_from_rollup    boolean := true;
  v_is_member      boolean;
  v_balance        numeric;
  v_debit          jsonb;
  v_treasury       numeric;
  v_ledger_category text;
BEGIN
  SELECT club_id INTO v_admitted_club FROM public.rakeback_periods WHERE id=p_period_id;
  PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY[v_admitted_club]);
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id FOR UPDATE;
  IF FOUND AND v_period.club_id IS DISTINCT FROM v_admitted_club THEN RAISE EXCEPTION 'Rakeback period scope changed during admission' USING ERRCODE='40001'; END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found');
  END IF;

  IF v_period.status IN ('paid', 'expired') THEN
    RETURN jsonb_build_object('success', true, 'skipped', v_period.status, 'period_id', p_period_id);
  END IF;

  -- WHO IS ASKING. A grant is not an authorization check: it lives outside
  -- the function and CREATE OR REPLACE carries it forward unexamined. This
  -- function debits a treasury and credits a wallet, so it asks.
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL
          OR (auth.uid() <> v_period.user_id
              AND NOT public.fn_is_platform_admin()
              AND NOT EXISTS (SELECT 1 FROM public.clubs c
                               WHERE c.id = v_period.club_id
                                 AND c.owner_id = auth.uid()))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorised');
  END IF;

  -- The existing batch payer selects closed periods. Direct callers must too.
  IF (v_period.period_end+1)::timestamp AT TIME ZONE 'UTC' > statement_timestamp() THEN
    RETURN jsonb_build_object('success',false,'deferred','earning_period_open',
      'period_id',p_period_id,'matures_at',(v_period.period_end+1)::timestamp AT TIME ZONE 'UTC');
  END IF;

  -- ---- EVERY CHEAP REFUSAL FIRST -------------------------------------------
  -- Each of these is one indexed lookup. The basis below is a rollup sum at
  -- best and a full rake_records scan at worst, and there is no reason to pay
  -- for it on a period that cannot be paid out either way.

  -- CLAUDE.md 13 rule 5: a sweep that moves money checks the freeze first.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', false, 'deferred', 'platform_frozen',
                              'period_id', p_period_id);
  END IF;

  -- Rakeback is earned at a club and belongs in that club's wallet. A player
  -- with no membership there is not quietly paid somewhere else, and is not
  -- worth a rake scan to discover that.
  SELECT EXISTS (SELECT 1 FROM public.club_members cm
                  WHERE cm.user_id = v_period.user_id
                    AND cm.club_id = v_period.club_id
                    AND cm.status IN ('active','approved'))
    INTO v_is_member;

  IF NOT v_is_member THEN
    UPDATE public.rakeback_periods
       SET deferred_reason = 'no_membership_at_earning_club',
           deferred_at = NOW(), defer_count = defer_count + 1
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', false, 'deferred', 'no_membership_at_earning_club',
      'period_id', p_period_id, 'club_id', v_period.club_id, 'user_id', v_period.user_id);
  END IF;

  -- Can this club fund what this period is already believed to be worth? The
  -- estimate is the writer's own last computation, it is used ONLY to refuse,
  -- and refusing here costs one indexed row where continuing costs a full rake
  -- scan for a payment fn_debit_treasury would decline at the end of it.
  IF COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0) > 0 THEN
    SELECT COALESCE(c.chip_treasury, 0) INTO v_treasury
      FROM public.clubs c WHERE c.id = v_period.club_id;
    IF v_treasury < COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0) THEN
      UPDATE public.rakeback_periods
         SET deferred_reason = 'insufficient_club_treasury',
             deferred_at = NOW(), defer_count = defer_count + 1
       WHERE id = p_period_id;
      RETURN jsonb_build_object('success', false, 'deferred', 'insufficient_club_treasury',
        'period_id', p_period_id, 'club_id', v_period.club_id,
        'estimated_payout', COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0),
        'treasury', round(v_treasury, 2), 'checked', 'before_basis');
    END IF;
  END IF;

  -- ---- NOW THE WORK ---------------------------------------------------------
  -- rakeback_daily_user is the same allocation the writer used, computed once
  -- per club-day for every player. Where it does not cover the period - it
  -- began 2026-08-31 and the backlog reaches to 2026-07-20 - fall back to the
  -- original scan rather than pay somebody zero because a cache is cold.
  v_days_needed := (v_period.period_end - v_period.period_start) + 1;
  -- A CACHED DAY COUNTS ONLY IF IT IS FRESH (2026-09-21). This counted ROWS
  -- IN rakeback_daily_state, not whether those rows were current, so a
  -- club-day whose state row merely EXISTED satisfied the guard and sent the
  -- payout to an empty rakeback_daily_user. Measured on 2026-09-21: 09-18,
  -- 09-19 and 09-20 carried state rows with rows_seen = 0 and computed_at =
  -- 2026-09-14 for both clubs, and 09-17 stopped at 07:29 with 5,106 of
  -- 36,606 rows - so the week of 09-14 held 173,325.52 of cached basis
  -- against 629,495.88 real, and the Monday 10:30 payer would have paid 373
  -- Deep Stack Society periods 13,798.91 instead of 62,688.06 and stamped
  -- every one of them 'paid' for ever. A day is fresh only when no qualifying
  -- rake record for that club-day arrived after the cache was computed;
  -- anything else falls to the ELSE scan, which reads the complete source.
  -- The comment above has always promised "rather than pay somebody zero
  -- because a cache is cold" - this is the test that makes that true. The
  -- partial index idx_rake_records_club_created (club_id, created_at) WHERE
  -- rake_amount > 0 serves this predicate exactly, so it stays an index probe.
  SELECT count(*) INTO v_days_have FROM public.rakeback_daily_state s
   WHERE s.club_id = v_period.club_id
     AND s.day BETWEEN v_period.period_start AND v_period.period_end
     AND NOT EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.club_id = s.club_id
          AND r.created_at >= s.day::timestamp AT TIME ZONE 'UTC'
          AND r.created_at <  (s.day + 1)::timestamp AT TIME ZONE 'UTC'
          AND r.created_at >  s.computed_at
          AND r.rake_amount > 0);

  IF v_days_have >= v_days_needed THEN
    SELECT ROUND(COALESCE(SUM(d.cents), 0)::numeric / 100, 2)
      INTO v_rake_total
      FROM public.rakeback_daily_user d
     WHERE d.club_id = v_period.club_id
       AND d.user_id = v_period.user_id
       AND d.day BETWEEN v_period.period_start AND v_period.period_end;
  ELSE
    v_from_rollup := false;
    SELECT ROUND(COALESCE(SUM(s.credit), 0), 2)
      INTO v_rake_total
      FROM public.rake_records r
      CROSS JOIN LATERAL public.fn_rake_shares_for_record(
        r.hand_id, r.rake_amount, r.player_contributions, COALESCE(r.rake_method, 'DEALT_EQUAL')
      ) s
     WHERE r.club_id = v_period.club_id
       AND r.created_at >= v_period.period_start::timestamp AT TIME ZONE 'UTC'
       AND r.created_at <  (v_period.period_end + 1)::timestamp AT TIME ZONE 'UTC'
       AND r.rake_amount > 0
       AND r.player_contributions IS NOT NULL
       AND (r.player_contributions ? v_period.user_id::text)
       AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id, r.table_id, r.metadata)
       AND s.user_id = v_period.user_id;
  END IF;

  -- One source of truth for the rate: the player's own deal, else their agent's
  -- standing offer, else the legacy volume ladder, never more than the upline
  -- earns less ten points.
  v_rate   := public.fn_player_rakeback_rate(v_period.user_id, v_period.club_id, v_rake_total);
  v_payout := ROUND(v_rake_total * v_rate, 2);

  UPDATE public.rakeback_periods
     SET rake_generated  = v_rake_total,
         total_rake_paid = v_rake_total,
         rakeback_rate   = v_rate,
         rakeback_amount = v_payout,
         rakeback_earned = v_payout
   WHERE id = p_period_id;

  IF v_payout <= 0 THEN
    UPDATE public.rakeback_periods
       SET status = 'paid', paid_at = NOW(), deferred_reason = NULL, deferred_at = NULL
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'period_id', p_period_id, 'payout', 0,
                              'rake_total', v_rake_total, 'rakeback_rate', v_rate,
                              'from_rollup', v_from_rollup);
  END IF;

  INSERT INTO public.rakeback_period_payouts
    (rakeback_period_id, club_id, user_id, user_rake_contribution,
     rakeback_pct, payout_amount, status, paid_at)
  VALUES
    (p_period_id, v_period.club_id, v_period.user_id, v_rake_total,
     ROUND(v_rate * 100, 2), round(v_payout, 2), 'paid', NOW())
  ON CONFLICT (rakeback_period_id, user_id) DO NOTHING
  RETURNING id INTO v_payout_id;

  IF v_payout_id IS NULL THEN
    UPDATE public.rakeback_periods
       SET status = 'paid', paid_at = NOW(), deferred_reason = NULL, deferred_at = NULL
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'skipped', 'payout_exists', 'period_id', p_period_id);
  END IF;

  v_debit := public.fn_debit_treasury(
    v_period.club_id, v_payout,
    'Player rakeback ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    jsonb_build_object('period_id', p_period_id, 'user_id', v_period.user_id,
                       'rake_basis', v_rake_total, 'rate', v_rate));

  IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
    DELETE FROM public.rakeback_period_payouts WHERE id = v_payout_id;
    UPDATE public.rakeback_periods
       SET deferred_reason = 'insufficient_club_treasury',
           deferred_at = NOW(), defer_count = defer_count + 1
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', false, 'deferred', 'insufficient_club_treasury',
      'period_id', p_period_id, 'club_id', v_period.club_id, 'payout', v_payout,
      'treasury', v_debit->'balance');
  END IF;

  PERFORM set_config('app.ledger_club_id', v_period.club_id::text, true);

  v_ledger_category:=current_setting('app.ledger_category',true);
  PERFORM public.atomic_credit_wallet_and_log(
    v_period.user_id, v_payout, 'rakeback',
    'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    NULL, NULL, v_payout_id, 'rakeback:' || p_period_id::text
  );


  PERFORM set_config('app.ledger_club_id', '', true);
  PERFORM set_config('app.ledger_category',coalesce(v_ledger_category,''),true);

  SELECT cm.chip_balance INTO v_balance
    FROM public.club_members cm
   WHERE cm.user_id = v_period.user_id AND cm.club_id = v_period.club_id;

  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, amount, type, category, description, related_entity_id, balance_after)
  VALUES
    (v_period.user_id, 'PLAYER', v_payout, 'credit', 'rakeback',
     'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
     v_payout_id, v_balance);

  -- Bind the existing payout receipt only after its wallet row has been inserted.
  PERFORM set_config('app.ledger_maintenance',
                     'rakeback payout evidence pointer', true);
  UPDATE public.rakeback_period_payouts p
     SET wallet_transaction_id = w.id
    FROM public.wallet_transactions w
   WHERE p.id = v_payout_id AND w.related_entity_id = v_payout_id
     AND p.wallet_transaction_id IS NULL;
  PERFORM set_config('app.ledger_maintenance', '', true);

  UPDATE public.rakeback_periods
     SET status = 'paid', paid_at = NOW(), deferred_reason = NULL, deferred_at = NULL
   WHERE id = p_period_id;

  RETURN jsonb_build_object('success', true, 'period_id', p_period_id,
    'rake_total', v_rake_total, 'rakeback_rate', v_rate,
    'payout', v_payout, 'payout_id', v_payout_id, 'club_id', v_period.club_id,
    'from_rollup', v_from_rollup, 'funded_from', 'club_chip_treasury');
END;
$function$

;

-- ---------------------------------------------------------------------------
-- THE 2026-09-17 CASH ACCRUAL CUTOVER GAP: DECIDED, ABSORBED, RECORDED.
-- ---------------------------------------------------------------------------
INSERT INTO public.financial_alerts (severity, source, message, context, resolved, resolved_at, resolution)
VALUES (
  'warning',
  'cash_accrual_cutover_2026_09_17',
  'Cash accrual cutover gap 2026-09-17 07:28:33-18:24:02: 35,995 cash hands / 70,266.90 rake earned no agent commission. DECIDED: absorbed. Player rakeback unaffected.',
  jsonb_build_object(
    'cutover_at','2026-09-17T18:24:04.643251+00','settler_cursor_at','2026-09-17T07:28:31+00',
    'cash_records',35995,'distinct_hands',35995,'rake',70266.90,
    'latched_legacy_unverified',35994,'never_enqueued',1,'never_enqueued_rake',0.23,
    'by_role', jsonb_build_object(
      'agent', jsonb_build_object('amount',23750.59,'beneficiaries',71),
      'sub_agent', jsonb_build_object('amount',4145.73,'beneficiaries',40),
      'super_agent', jsonb_build_object('amount',27547.66,'beneficiaries',5),
      'club_residual', jsonb_build_object('amount',14822.92,'clubs',3)),
    'commission_entitlement_unbooked',55443.98,
    'distinct_commission_beneficiaries',116,'of_which_horses',115,'of_which_humans',1,
    'human_beneficiary', jsonb_build_object('username','kingfish','amount',149.71),
    'rakeback_players_affected',0,
    'tournament_rake_in_window_out_of_scope', jsonb_build_object('records',16311,'rake',41719.51)),
  true, now(),
  $res$ABSORBED BY THE HOUSE. There is no path that can pay this without fabricating evidence or building a repair job, and both are forbidden.

POPULATION, RECONCILED. The window is bounded by the rakeback settler cursor (07:28:31) and the cutover (18:24:04.643251). It holds 35,995 positive cash rake records over 35,995 distinct hands, 70,266.90 of rake, earned 07:28:33 to 18:24:02. 35,994 of them carry a work row latched status=legacy_unverified in the immutable accounting_cash_accrual_batches (70,266.67); one further record (0.23) was never enqueued at all. The wider figure of 52,305 records / 111,962.41 that this was first reported as counted TOURNAMENT rake in the same window as well: 16,311 records / 41,719.51 of it, which belongs to accounting_tournament_fee_* under its own cutover and is out of scope. The tournament legacy writer ran to 18:23:53 and its canonical writer began at 18:46:28, so the tournament side has no comparable hole. Cash only: 35,995 / 70,266.90.

NOBODY WAS PAID. agent_commissions source_type=rake_settlement (the legacy cash writer) has its last row at 2026-09-17 07:29:05; source_type=cash_rake_accrual (the canonical writer) has its first at 18:25:06. Between those two instants there is no cash commission row of any kind. Control windows confirm the shape rather than assume it: the 09-16 and 09-17-pre-cursor windows are 100% covered by the legacy path (10,795/10,795 and 8,571/8,571 in rakeback_stats_applied) and the post-cutover window is 100% covered by the canonical path (30,704/30,704 in accounting_cash_rake_sources); the gap window has 1 of 35,995.

WHAT WAS OWED, computed not guessed. fn_accounting_earning_contract is STABLE, reads accounting_agreement_history at the earning instant, and needs neither the v2 stamp nor a bank receipt, so the entitlement is computable even though it is not payable. Run over all 107,538 attributions in the window it resolved every one without error: agent 23,750.59 (71 beneficiaries), sub_agent 4,145.73 (40), super_agent 27,547.66 (5), club residual 14,822.92 (3 clubs). Those sum to 70,266.90, exactly the rake, so the allocation conserves. Agreements were establishable throughout: accounting_agreement_history begins 2026-09-14, before the window.

WHY IT CANNOT BE PAID, proven in a transaction that was rolled back. Both doors were called on a real gap record and both refused: the legacy writer credit_agent_commission_from_rake(...,rake_settlement,...) raised cash_source_requires_reconciliation (SQLSTATE 55000) because its cash branch no longer writes commissions at all - it delegates to fn_process_cash_accounting_source, which returns the latched verdict; and fn_accounting_cash_commission_plan raised cash_game_union_stamp_missing. The canonical path cannot be opened because the evidence it requires was never recorded: of the 35,995 records, 0 carry metadata.accounting_source_version=2, 0 carry metadata.union_id, and 0 have an accounting_cash_bank_receipts row, against 30,704 of 30,704 on all three for the post-cutover control. Those receipts attest to a union wallet credit or a chip retirement that did not happen in that form; writing them to unlock the payment would be manufacturing financial evidence. The verdicts are latched and the batch table is immutable by trigger, and the cutover cannot be moved (ca_cash_cutover_is_week_aligned, and the only week-aligned instant at or before the cursor would place 70,465 already-paid hands on the canonical side, which the accrual function rejects as cash_accrual_legacy_writer_after_cutover). The remaining option would be a new backfill or repair function, which CLAUDE.md 10.12 forbids outright. Per that law the answer is to say so plainly rather than ship the plaster.

WHO IS OUT OF POCKET. The rake itself was collected normally - all 35,995 records have a chip_ledger rake entry - so the chips left the pots and stayed with the clubs. What was never booked is the commission liability the clubs would have owed their uplines: 55,443.98 across 116 distinct beneficiaries. The clubs are better off by that amount and those 116 are worse off by it. 115 of the 116 are horses and 1 is human (kingfish, 149.71). Under CLAUDE.md 10.5 that makes no difference to the entitlement and none was applied: the computation included every horse on the same terms as the human, and the absorption falls on all 116 identically, for the mechanical reason that no door will open for any of them - not because a horse was filtered out of anything.

PLAYER RAKEBACK IS NOT AFFECTED, and this is the part that would have been easy to get wrong. Rakeback basis does not flow through rakeback_stats_applied; fn_rakeback_recompute_day rebuilds rakeback_daily_user wholesale from rake_attributions, and all 107,538 attributions for these hands are present and sum exactly to the rake. The 351 players who generated this rake lose nothing from the cutover gap. They were separately at risk from a stale daily cache, which is the root fix in this same migration, and that risk is now removed.

RECURRENCE. A cutover armed ahead of the settler cursor is what created this, and the arming path is now guarded. This record exists so the outcome is a decision with its reasoning attached rather than an open question the next agent re-opens.$res$
);

COMMIT;
