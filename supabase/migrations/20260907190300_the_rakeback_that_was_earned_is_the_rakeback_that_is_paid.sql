-- THE RAKEBACK THAT WAS EARNED IS THE RAKEBACK THAT IS PAID
-- =============================================================================
-- PHASE 5 of 8: auto-rakeback.
--
-- MEASURED BEFORE ANY OF THIS WAS WRITTEN. 443,513.92 is owed to 1,005 players
-- across 3,458 closed rakeback periods, the oldest ending 2026-07-20, and the
-- last player rakeback this platform paid was on 2026-08-20. Not one of those
-- players was told, and nothing was broken in a way anybody could see: the
-- Monday cron fires, runs for 38 seconds, and returns http_500.
--
-- WHY IT CANNOT FINISH. settle_club_rakeback closes EVERY pending period for a
-- club in one statement, and each close re-scans rake_records with a per-record
-- lateral share allocation to recover one player's share. Measured on this
-- database: 2,632 ms per period, worst 4,070 ms. Midway's 1,769 pending
-- periods are therefore about 4,656 seconds - 78 minutes - of work in a single
-- statement, and the service_role that every server-side job authenticates as
-- carries statement_timeout = 8s. It has not been able to settle even three
-- periods since the backlog outgrew that. The job did not degrade; it stopped,
-- and kept reporting the stop as a 500 that nothing paged on.
--
-- The rake was never lost. rakeback_daily_user already holds the same math,
-- computed ONCE per club-day by fn_rakeback_recompute_day for every player at
-- once - 4,938 ms for the heaviest day in the backlog, covering 463 players.
-- The writer has read that rollup since 20260831. The payer never did.
--
-- WHAT ELSE THE PAYER WAS GETTING WRONG, all of it measured on the 3,458
-- pending periods:
--
--   THE RATE. fn_rakeback_recompute_periods writes a rate from
--   fn_player_rakeback_rate - the player's negotiated deal, else their agent's
--   standing offer, else the legacy volume ladder, and never more than the
--   upline earns less ten points. fn_close_settlement_period threw all of that
--   away and recomputed from the bare ladder. 1,505 periods would have paid a
--   different number: 95,645.93 underpaid across 1,301 of them, 17,479.31
--   overpaid across 204 - and every one of those 204 would have paid a player
--   MORE than their upline receives, which is the exact margin violation
--   fn_club_rakeback_margin_violations exists to detect and the payer never
--   consulted.
--
--   THE CLUB. The payer debits the earning club's treasury, then credits
--   through atomic_credit_wallet_and_log, which - given no table id - resolves
--   the player's HOME club, meaning the club they joined first. For 2,428 of
--   3,458 periods that is a different club: 327,117.23 funded by one club and
--   handed to another club's float. 2,666 of those players are active members
--   of the club they earned it at and simply needed to be asked about it; 792
--   (123,453.91, 263 players, 789 of them horses) have no membership row at
--   the earning club at all. Those are NOT quietly re-routed here. They are
--   deferred with a reason, because paying a player at a club they do not
--   belong to is the defect, not the fix. Every one of them sits behind
--   Midway's treasury anyway, so no player waits a day longer for it.
--
--   THE ADMIN BUTTON. fn_run_pending_rakeback_settlement gates on the caller
--   being an admin profile, then calls settle_club_rakeback, which accepted
--   only the engine or the CLUB OWNER. A platform admin owns no clubs, so the
--   Settle Now button on the settlement dashboard has always settled nothing
--   and returned success:true, clubs_processed:0.
--
--   THE FREEZE. Neither fn_debit_treasury nor atomic_credit_wallet_and_log
--   consults fn_platform_frozen, so the rakeback path would move money in the
--   middle of the :55 maintenance break. CLAUDE.md 13 rule 5.
--
--   THE RECEIPT. balance_after on the wallet_transactions row was read from
--   public.wallets - the pool frozen since 2026-08-21 with nothing reading it -
--   while the chips went to club_members.chip_balance. The player's own history
--   reported a balance that was not theirs.
--
-- WHAT THIS DOES NOT DO. It does not mint a chip and it does not move the
-- backlog. Midway Union owes 280,142.57 against a treasury of 0.66; that is a
-- real shortfall, and this makes it explicit and durable on the period rather
-- than a warning that stopped being written on 2026-08-29 because the job
-- started dying earlier in the loop.
-- =============================================================================

BEGIN;

-- WHY A PERIOD DID NOT PAY, on the period, not in a log ------------------------

ALTER TABLE public.rakeback_periods
  ADD COLUMN IF NOT EXISTS deferred_reason text,
  ADD COLUMN IF NOT EXISTS deferred_at     timestamptz,
  ADD COLUMN IF NOT EXISTS defer_count     integer NOT NULL DEFAULT 0;

-- The drain reads (club, status, period_end); the payer reads the rollup by
-- (club, user, day). Neither had an index shaped like its query.
CREATE INDEX IF NOT EXISTS rakeback_periods_due_idx
  ON public.rakeback_periods (club_id, period_end)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS rakeback_daily_user_club_user_day_idx
  ON public.rakeback_daily_user (club_id, user_id, day);

-- A CREDIT CAN NOW SAY WHICH CLUB IT BELONGS TO --------------------------------
-- One substitution on the live definition rather than a retyped 4.4 KB money
-- function. app.ledger_club_id is transaction-local and unset by default, so
-- every existing caller keeps the exact behaviour it has today.

DO $migrate$
DECLARE v_def text; v_new text; v_a text; v_r text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc
   WHERE proname='atomic_credit_wallet_and_log' AND pronamespace='public'::regnamespace;

  v_a := E'  IF v_club_id IS NULL THEN\n'
      || E'    v_club_id := public.fn_player_home_club(p_user_id, NULL);\n'
      || E'  END IF;';
  v_r := E'  IF v_club_id IS NULL THEN\n'
      || E'    -- A caller that KNOWS which club a credit belongs to says so in\n'
      || E'    -- app.ledger_club_id. Rakeback earned at a club is paid into THAT\n'
      || E'    -- club''s wallet, not into whichever club the player joined first.\n'
      || E'    -- Unset - which is every existing caller - is the old behaviour\n'
      || E'    -- exactly, because fn_player_home_club ignores a NULL hint.\n'
      || E'    v_club_id := public.fn_player_home_club(p_user_id,\n'
      || E'      NULLIF(current_setting(''app.ledger_club_id'', true), '''')::uuid);\n'
      || E'  END IF;';

  IF position(v_a in v_def) = 0 THEN
    RAISE EXCEPTION 'the home-club fallback in atomic_credit_wallet_and_log is not where this migration expects it';
  END IF;
  v_new := replace(v_def, v_a, v_r);
  IF v_new = v_def THEN RAISE EXCEPTION 'the club-hint substitution did not take'; END IF;
  EXECUTE v_new;
END
$migrate$;

-- THE PAYER --------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(p_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period         record;
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
BEGIN
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found');
  END IF;

  IF v_period.status IN ('paid', 'expired') THEN
    RETURN jsonb_build_object('success', true, 'skipped', v_period.status, 'period_id', p_period_id);
  END IF;

  -- CLAUDE.md 13 rule 5: a sweep that moves money checks the freeze first. The
  -- engine is dead for two of the five minutes; pg_cron and PostgREST are not.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', false, 'deferred', 'platform_frozen',
                              'period_id', p_period_id);
  END IF;

  -- THE BASIS. rakeback_daily_user is the same allocation the writer used,
  -- computed once per club-day for every player instead of once per player by
  -- re-reading every rake record. Where the rollup does not cover the period -
  -- it began on 2026-08-31 and the backlog reaches back to 2026-07-20 - fall
  -- back to the original scan rather than pay somebody zero because a cache is
  -- cold. fn_settle_club_rakeback_batch warms the rollup first so the batch
  -- path does not take the slow branch.
  v_days_needed := (v_period.period_end - v_period.period_start) + 1;
  SELECT count(*) INTO v_days_have FROM public.rakeback_daily_state s
   WHERE s.club_id = v_period.club_id
     AND s.day BETWEEN v_period.period_start AND v_period.period_end;

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
       AND r.created_at >= v_period.period_start::timestamptz
       AND r.created_at <  (v_period.period_end + 1)::timestamptz
       AND r.rake_amount > 0
       AND r.player_contributions IS NOT NULL
       AND (r.player_contributions ? v_period.user_id::text)
       AND s.user_id = v_period.user_id;
  END IF;

  -- THE RATE. One source of truth, the same one the writer used: the player's
  -- own deal, else their agent's standing offer, else the legacy ladder, capped
  -- at what the upline earns less ten points. The bare ladder that used to live
  -- here is still in there as the third branch, for a player with neither.
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

  -- THE CLUB. Rakeback is earned at a club and belongs in that club's wallet.
  -- A player with no membership there is not quietly paid somewhere else.
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
      'period_id', p_period_id, 'club_id', v_period.club_id, 'user_id', v_period.user_id,
      'payout', v_payout);
  END IF;

  INSERT INTO public.rakeback_period_payouts
    (rakeback_period_id, club_id, user_id, user_rake_contribution,
     rakeback_pct, payout_amount, status, paid_at)
  VALUES
    (p_period_id, v_period.club_id, v_period.user_id, v_rake_total,
     ROUND(v_rate * 100, 2), v_payout, 'paid', NOW())
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

  -- Pay it into the club it was earned at. The hint is transaction-local and
  -- read by atomic_credit_wallet_and_log; membership was proved above.
  PERFORM set_config('app.ledger_club_id', v_period.club_id::text, true);

  PERFORM public.atomic_credit_wallet_and_log(
    v_period.user_id, v_payout, 'rakeback',
    'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    NULL, NULL, v_payout_id, 'rakeback:' || p_period_id::text
  );

  PERFORM set_config('app.ledger_club_id', '', true);

  -- The receipt reports the balance the chips actually landed in. It used to
  -- read public.wallets, which has been frozen since 2026-08-21 and which this
  -- payment never touches.
  SELECT cm.chip_balance INTO v_balance
    FROM public.club_members cm
   WHERE cm.user_id = v_period.user_id AND cm.club_id = v_period.club_id;

  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, amount, type, category, description, related_entity_id, balance_after)
  VALUES
    (v_period.user_id, 'PLAYER', v_payout, 'credit', 'rakeback',
     'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
     v_payout_id, v_balance);

  UPDATE public.rakeback_periods
     SET status = 'paid', paid_at = NOW(), deferred_reason = NULL, deferred_at = NULL
   WHERE id = p_period_id;

  RETURN jsonb_build_object('success', true, 'period_id', p_period_id,
    'rake_total', v_rake_total, 'rakeback_rate', v_rate,
    'payout', v_payout, 'payout_id', v_payout_id, 'club_id', v_period.club_id,
    'from_rollup', v_from_rollup, 'funded_from', 'club_chip_treasury');
END;
$function$;

COMMENT ON FUNCTION public.fn_close_settlement_period(uuid) IS
  'Pays one rakeback period. Basis from the rakeback_daily_user rollup, falling back to a direct rake_records scan when the rollup does not cover the period. Rate from fn_player_rakeback_rate - the same policy the writer used, including the upline cap - never a hardcoded ladder. Credits the club the rake was earned at, refuses to pay a player who is not a member there, refuses to move money during a maintenance freeze, and records why on the period when it defers.';

COMMIT;
