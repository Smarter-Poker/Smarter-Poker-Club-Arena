-- ═══════════════════════════════════════════════════════════════════════════════
--  A SATELLITE IS RECOGNISED BY WHAT IT PAYS, NOT BY ONE SPELLING OF ITS VARIANT
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Found auditing the satellite heads-up shipped earlier today. That format is
-- a two-seat sit-and-go whose winner takes a SEAT in a bigger event, and its
-- row is deliberately `variant = 'sng'` (so every seat-first reader - the fast
-- start, fn_take_seat_and_buy_in, fn_repair_seat_first_games, the table sizing -
-- recognises a heads-up) with `tournament_type = 'SATELLITE'` and
-- `satellite_target_id` set.
--
-- Three money functions identify a satellite by `variant = 'satellite'` and
-- nothing else, so none of them can see that row for what it is:
--
--   fn_ca_fund_overlay_on_lock       an INCLUSION. A satellite's advertised
--                                    seats are a guarantee, and this is the
--                                    trigger that funds the shortfall from the
--                                    bank. It never fires for the new format,
--                                    so "1 Seat Guaranteed" is advertised and
--                                    not backed. Masked today because the
--                                    feeder is priced so two entries always
--                                    cover one ticket - and unmasked the moment
--                                    a target's buy-in is edited upward after
--                                    the feeder opens, or a seat is refunded,
--                                    because planSatelliteAwards still promises
--                                    the configured seat.
--
--   fn_pay_backed_payout_shortfalls  EXCLUSIONS, both. "Satellites award seats,
--   fn_tournament_payout_sweep       not cash. Reconciling them against a cash
--                                    payout table is wrong", say their own
--                                    comments - and both would have taken the
--                                    new format as a candidate. Neither has
--                                    actually mispaid, because both delegate
--                                    the money to fn_tournament_payout_reconcile,
--                                    which DOES check both spellings and returns
--                                    `skipped: satellite_awards_seats`. That is
--                                    a guard one refactor away from being lost:
--                                    it is the reconciler's rule protecting the
--                                    sweeps' bug, not the sweeps' own rule.
--
-- All three now ask the same three-part question, and the third part is the
-- durable one: `satellite_target_id IS NOT NULL` is the column that MEANS
-- "this pays a seat", and it is already what fn_award_satellite_seat,
-- fn_satellite_conservation_audit and fn_tournament_conservation_delta key on.
--
-- Direction of change, stated plainly: the two sweeps get a WIDER exclusion, so
-- they can only ever touch fewer events - that direction cannot create a
-- payment. The trigger gets a wider inclusion, which can, so note what bounds
-- it: it funds `GREATEST(0, guarantee - prize_pool)`, so an event whose field
-- already covers its seats funds zero and the code path ends at `IF v_short <= 0
-- THEN RETURN NEW`. Every satellite heads-up in existence is priced to cover.
--
-- Bodies are otherwise the functions as deployed (pg_get_functiondef,
-- 2026-09-03); a function is replaced whole.

CREATE OR REPLACE FUNCTION public.fn_ca_fund_overlay_on_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_short numeric; v_union uuid; v_bank numeric; v_from text; v_store text;
  v_st text; v_msg text; v_pool_before numeric;
  v_entrants int; v_places int; v_existing jsonb;
  v_guarantee numeric; v_seat_guarantee numeric; v_target uuid;
  v_attempt int; v_written boolean := false;
BEGIN
  IF NOT (COALESCE(OLD.status,'') IN ('ANNOUNCED','REGISTERING')
          AND NEW.status IN ('RUNNING','COMPLETING','COMPLETED')) THEN
    RETURN NEW;
  END IF;

  /* ── 1. payout table, from the field that actually entered ─────────────
     Only when nobody has registered yet. With registrations present,
     fn_guard_managed_game_lifecycle protects payout_structure and this
     trigger currently runs BEFORE it, so writing here refuses the whole
     start. Re-enabled once the trigger is renamed to sort after the guard.

     NOT FOR A SPIN (2026-09-02). A Spin's ladder comes from the tier the
     wheel drew - 10x is 80/20 - and this rule is "pay the top N% of the
     field", which on three seats rounds to one place and silently replaced
     every high multiplier with winner-take-all. 32 games, 1,592 chips. */
  SELECT count(*) INTO v_entrants
    FROM public.tournament_players tp WHERE tp.tournament_id = NEW.id;

  IF NEW.variant IS DISTINCT FROM 'spin' THEN
    IF v_entrants > 0 AND NOT EXISTS (
         SELECT 1 FROM pg_trigger tg
          WHERE tg.tgrelid = 'public.tournaments'::regclass
            AND tg.tgname = 'zz_ca_fund_overlay_on_lock')
    THEN
      NULL;  -- stand down: the guard would refuse the start
    ELSIF v_entrants > 0 THEN
      v_places := GREATEST(1, LEAST(v_entrants,
                    ceil(v_entrants * COALESCE(NEW.payout_percent,10) / 100.0)::int));
      BEGIN
        v_existing := NULLIF(btrim(COALESCE(NEW.payout_structure,'')), '')::jsonb;
      EXCEPTION WHEN OTHERS THEN v_existing := NULL; END;

      IF v_existing IS NULL
         OR jsonb_typeof(v_existing) <> 'array'
         OR jsonb_array_length(v_existing) = 0
         OR v_existing = '[{"place":1,"percentage":100}]'::jsonb
         OR jsonb_array_length(v_existing) <> v_places
      THEN
        NEW.payout_structure := public.fn_ca_payout_structure(
                                  v_entrants, COALESCE(NEW.payout_percent,10))::text;
      END IF;
    END IF;
  END IF;

  /* ── 2. the guarantee overlay, from the main bank ─────────────────────── */
  v_pool_before := round(COALESCE(NEW.prize_pool,0),2);
  v_guarantee   := round(COALESCE(NEW.guaranteed_prize,0),2);

  /* A GUARANTEED SEAT IS A GUARANTEE (2026-09-02). A satellite's advertised
     seats are worth target buy-in + fee each; the engine awards every one of
     them, so the bank funds the shortfall here, like any other guarantee. */
  IF COALESCE(NEW.satellite_seats, 0) > 0
     AND (NEW.variant = 'satellite'
          OR UPPER(COALESCE(NEW.tournament_type, '')) = 'SATELLITE'
          OR NEW.satellite_target_id IS NOT NULL) THEN
    v_target := COALESCE(NEW.satellite_target_id, NEW.satellite_target);
    IF v_target IS NOT NULL THEN
      SELECT round((COALESCE(t2.buy_in_amount,0) + COALESCE(t2.buy_in_fee,0)) * NEW.satellite_seats, 2)
        INTO v_seat_guarantee
        FROM public.tournaments t2 WHERE t2.id = v_target;
      v_guarantee := GREATEST(v_guarantee, COALESCE(v_seat_guarantee, 0));
    END IF;
  END IF;

  v_short := GREATEST(0, v_guarantee - v_pool_before);
  IF v_short <= 0 THEN RETURN NEW; END IF;

  PERFORM set_config('app.ledger_category', 'overlay', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', NEW.id::text, true);

  v_union := CASE WHEN COALESCE(NEW.is_private,false) THEN NULL ELSE NEW.union_id END;

  IF v_union IS NOT NULL THEN
    SELECT chip_balance INTO v_bank FROM public.union_wallets
     WHERE union_id = v_union FOR UPDATE;
    v_from := 'union_bank';
    v_store := 'union_wallets.chip_balance';
    IF COALESCE(v_bank,0) < v_short THEN
      PERFORM public.fn_raise_server_financial_alert(
        'critical', 'fn_ca_fund_overlay_on_lock',
        format('%s needs %s chips of overlay to meet its %s guarantee and the union bank holds %s. The pool was NOT topped up.',
               COALESCE(NEW.name, NEW.id::text), v_short,
               v_guarantee, COALESCE(v_bank,0)),
        jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
          'shortfall',v_short,'bank',COALESCE(v_bank,0)), NEW.id::text);
      RETURN NEW;
    END IF;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
    UPDATE public.union_wallets
       SET chip_balance = chip_balance - v_short, updated_at = now()
     WHERE union_id = v_union;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '0', true);
  ELSE
    SELECT chip_treasury INTO v_bank FROM public.clubs
     WHERE id = NEW.club_id FOR UPDATE;
    v_from := 'club_treasury';
    v_store := 'clubs.chip_treasury';
    IF COALESCE(v_bank,0) < v_short THEN
      PERFORM public.fn_raise_server_financial_alert(
        'critical', 'fn_ca_fund_overlay_on_lock',
        format('%s needs %s chips of overlay to meet its %s guarantee and the club treasury holds %s. The pool was NOT topped up.',
               COALESCE(NEW.name, NEW.id::text), v_short,
               v_guarantee, COALESCE(v_bank,0)),
        jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
          'shortfall',v_short,'bank',COALESCE(v_bank,0)), NEW.id::text);
      RETURN NEW;
    END IF;
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury,0) - v_short, updated_at = now()
     WHERE id = NEW.club_id;
    PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
  END IF;

  NEW.prize_pool := round(v_pool_before + v_short, 2);

  /* THE JOURNAL ROW RETRIES A DEADLOCK (2026-09-03). 40P01 is transient: the
     other transaction finishes and the same INSERT succeeds. Three attempts;
     any other SQLSTATE is a real refusal and is recorded on the first try. */
  FOR v_attempt IN 1..3 LOOP
    BEGIN
      INSERT INTO public.chip_ledger (
        performed_by, from_type, from_entity_id, to_type, to_entity_id,
        amount, category, club_id, tournament_id, description)
      VALUES (
        COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
        v_from, COALESCE(v_union, NEW.club_id), 'prize_liability', NEW.id,
        v_short, 'overlay', NEW.club_id, NEW.id,
        format('Guarantee overlay from the main bank: %s (%s) was %s short of its %s guarantee - field made %s, bank paid %s',
               COALESCE(NEW.name, 'tournament'), NEW.id::text,
               v_short, v_guarantee,
               v_pool_before, v_short));
      v_written := true;
      EXIT;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      IF v_st = '40P01' AND v_attempt < 3 THEN
        CONTINUE;  -- deadlock: try the same row again
      END IF;
      /* The message names the store that moved, so fn_ca_repair_write_failure
         maps it to the right ledger account (union_bank / club_treasury). */
      BEGIN
        INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
        VALUES (NEW.club_id, NULL, v_short, v_st,
                'fn_ca_fund_overlay_on_lock ' || v_store
                || ' -> prize_liability (tournament ' || NEW.id::text || ', attempt '
                || v_attempt::text || '): ' || v_msg);
      EXCEPTION WHEN OTHERS THEN NULL; END;
      EXIT;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

-- The trigger function is reached only through the trigger on public.tournaments;
-- no browser can call it. Authorization unchanged.
REVOKE ALL ON FUNCTION public.fn_ca_fund_overlay_on_lock() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_fund_overlay_on_lock() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_pay_backed_payout_shortfalls(p_apply boolean DEFAULT false, p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_res jsonb;
  v_paid numeric := 0; v_events integer := 0;
  v_withheld numeric := 0; v_withheld_events integer := 0;
  v_refused integer := 0; v_refused_chips numeric := 0;
  v_alerts integer := 0;
  v_delta_after numeric;
BEGIN
  FOR r IN
    SELECT t.id, t.name, t.club_id, t.prize_pool,
           COALESCE((public.fn_tournament_payout_reconcile(t.id, false)->>'total_top_up')::numeric, 0) AS topup,
           public.fn_tournament_conservation_delta(t.id) AS delta,
           COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                      WHERE w.related_entity_id = t.id AND w.type = 'credit'
                        AND w.category = 'prize'), 0) AS wallet_prizes
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       -- Satellites award seats, not cash. Reconciling them against a cash
       -- pool would invent prizes that do not exist.
       AND NOT (COALESCE(t.variant, '') = 'satellite' OR UPPER(COALESCE(t.tournament_type, '')) = 'SATELLITE' OR t.satellite_target_id IS NOT NULL)
       -- A Spin's pool is funded by the reserve, not by this game's own
       -- collections, so its delta does not mean what it means elsewhere.
       AND COALESCE(t.variant, '') <> 'spin'
       /* THE LOG IS A RECEIPT, NOT A TOMBSTONE (2026-09-01).
          This clause used to be `NOT EXISTS (... backfill_log ...)`, so one
          pass over an event excluded it from every future pass, for good. That
          is wrong in principle rather than in practice today: an event can
          become payable AFTER its pass - a guarantee gets funded, a
          conservation baseline is acknowledged - and nothing would ever look
          at it again. Measured before this change, no logged event is payable
          right now (all 57 fail the conservation filter below on their own
          merits), so removing the clause unlocks no payment today and closes
          the door on a shortfall that outlives its one and only inspection.
          "Nothing is owed" is the only correct exclusion, and it is computed
          below as `topup <= 0.005`. The log stays, as the audit trail it
          should always have been. */
       AND public.fn_tournament_conservation_delta(t.id) > 0.01
     ORDER BY t.ended_at ASC NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    CONTINUE WHEN r.topup <= 0.005;

    /* CONSERVATION REFUSES BEFORE THE POOL DOES (2026-09-01).
       The reconciler computes "already paid" from tournament_payouts, on
       purpose - counting ledger rows instead caused two real double-pays. The
       cost of that choice is that an event whose record is incomplete reports
       a debt it does not have, and 61 events on this platform hold 5,515.91
       chips of prizes that reached wallets and were never recorded. If such a
       pool is ever funded, this sweep would pay them a second time.

       An event that has already disbursed its whole pool to wallets owes
       nobody, whatever the paperwork says. Refuse, and say so, so the record
       gets fixed rather than paid twice. */
    IF r.wallet_prizes + 0.01 >= COALESCE(r.prize_pool, 0) AND COALESCE(r.prize_pool, 0) > 0 THEN
      v_refused := v_refused + 1;
      v_refused_chips := v_refused_chips + r.topup;
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'warning', 'fn_pay_backed_payout_shortfalls',
             format('%s already paid %s of its %s pool to wallets, so the %s the reconciler reports as owed is a missing tournament_payouts record, not a debt. Paying nothing.',
                    COALESCE(r.name, r.id::text), round(r.wallet_prizes,2),
                    round(COALESCE(r.prize_pool,0),2), round(r.topup,2))
           , jsonb_build_object('kind','refused_already_disbursed','tournament_id',r.id,
               'club_id',r.club_id,'wallet_prizes',round(r.wallet_prizes,2),
               'prize_pool',round(COALESCE(r.prize_pool,0),2),'reported_top_up',round(r.topup,2))
       WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                          WHERE fa.source='fn_pay_backed_payout_shortfalls'
                            AND fa.resolved IS NOT TRUE
                            AND fa.context->>'kind'='refused_already_disbursed'
                            AND fa.context->>'tournament_id' = r.id::text);
      IF FOUND THEN v_alerts := v_alerts + 1; END IF;
      CONTINUE;
    END IF;

    -- The event must be holding at least what it is about to pay out. Not
    -- `delta >= 0` - that would let an event with 3 chips spare pay out 300.
    IF r.delta < r.topup THEN
      v_withheld := v_withheld + r.topup;
      v_withheld_events := v_withheld_events + 1;
      /* WITHHOLDING IS NEVER SILENT (2026-09-01).
         This branch used to increment a counter that reached a console line
         and nothing else. Money owed to a player and not paid produced no
         durable record anywhere, so nobody could find it later, and nobody
         did. It is a deduped alert now, per event, naming the gap. */
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'critical', 'fn_pay_backed_payout_shortfalls',
             format('%s owes players %s and its pool holds %s, so nothing was paid. The shortfall needs funding before anyone can be paid.',
                    COALESCE(r.name, r.id::text), round(r.topup,2), round(r.delta,2))
           , jsonb_build_object('kind','withheld_unfunded_pool','tournament_id',r.id,
               'club_id',r.club_id,'owed',round(r.topup,2),'pool_holds',round(r.delta,2),
               'funding_gap',round(r.topup - r.delta,2),
               'detail','no money was moved; funding an advertised guarantee is a human decision')
       WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                          WHERE fa.source='fn_pay_backed_payout_shortfalls'
                            AND fa.resolved IS NOT TRUE
                            AND fa.context->>'kind'='withheld_unfunded_pool'
                            AND fa.context->>'tournament_id' = r.id::text);
      IF FOUND THEN v_alerts := v_alerts + 1; END IF;
      CONTINUE;
    END IF;

    IF p_apply THEN
      /* ONE SETTLE PATH (Lane A3, 2026-09-02): the reconciler settles every
         place through fn_settle_tournament_obligation. `total_settled` is what
         that path actually paid; `total_top_up` is what was wanted. */
      v_res := public.fn_tournament_payout_reconcile(r.id, true);
      v_delta_after := public.fn_tournament_conservation_delta(r.id);

      IF v_delta_after < -0.01 THEN
        RAISE EXCEPTION 'paying % would leave conservation at %; refusing', r.id, v_delta_after;
      END IF;

      INSERT INTO public.tournament_payout_backfill_log
        (tournament_id, top_up, delta_before, delta_after)
      VALUES (r.id, COALESCE((v_res->>'total_settled')::numeric, (v_res->>'total_top_up')::numeric, r.topup), r.delta, v_delta_after)
      ON CONFLICT (tournament_id) DO UPDATE
        SET top_up = EXCLUDED.top_up,
            delta_before = EXCLUDED.delta_before,
            delta_after = EXCLUDED.delta_after;

      v_paid := v_paid + COALESCE((v_res->>'total_settled')::numeric, (v_res->>'total_top_up')::numeric, 0);
    ELSE
      v_paid := v_paid + r.topup;
    END IF;
    v_events := v_events + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'events_paid', v_events, 'chips_paid', round(v_paid, 2),
    'events_withheld_unfunded_pool', v_withheld_events,
    'chips_withheld_unfunded_pool', round(v_withheld, 2),
    'events_refused_already_disbursed', v_refused,
    'chips_refused_already_disbursed', round(v_refused_chips, 2),
    'alerts_raised', v_alerts,
    'money_path', 'fn_settle_tournament_obligation');
END;
$function$;

-- Engine-only sweep; authorization unchanged.
REVOKE ALL ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_sweep(p_days integer DEFAULT 2, p_apply boolean DEFAULT false, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  r          record;
  v_res      jsonb;
  v_out      jsonb := '[]'::jsonb;
  v_n        int    := 0;
  v_topup    numeric := 0;
  v_matched  int    := 0;
  v_scanned  int    := 0;
  v_failed   int    := 0;
  v_fail_ids uuid[] := ARRAY[]::uuid[];
  v_first_err text;
  v_limit    int    := GREATEST(p_limit, 1);
  v_since    timestamptz := now() - make_interval(days => GREATEST(p_days, 1));
BEGIN
  SELECT count(*) INTO v_matched
    FROM tournaments t
   WHERE t.status = 'COMPLETED'
     AND COALESCE(t.ended_at, t.started_at, t.updated_at) > v_since
     AND COALESCE(t.prize_pool, 0) > 0
     AND NOT (COALESCE(t.variant, '') = 'satellite' OR UPPER(COALESCE(t.tournament_type, '')) = 'SATELLITE' OR t.satellite_target_id IS NOT NULL);

  FOR r IN
    SELECT t.id
      FROM tournaments t
     WHERE t.status = 'COMPLETED'
       AND COALESCE(t.ended_at, t.started_at, t.updated_at) > v_since
       AND COALESCE(t.prize_pool, 0) > 0
       AND NOT (COALESCE(t.variant, '') = 'satellite' OR UPPER(COALESCE(t.tournament_type, '')) = 'SATELLITE' OR t.satellite_target_id IS NOT NULL)
     ORDER BY COALESCE(t.ended_at, t.started_at, t.updated_at) DESC
     LIMIT v_limit
  LOOP
    v_scanned := v_scanned + 1;
    BEGIN
      v_res := fn_tournament_payout_reconcile(r.id, p_apply);
      IF COALESCE((v_res->>'clean')::boolean, true) = false THEN
        v_out   := v_out || v_res;
        v_n     := v_n + 1;
        v_topup := v_topup + COALESCE((v_res->>'total_top_up')::numeric, 0);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      IF v_first_err IS NULL THEN v_first_err := SQLERRM; END IF;
      IF array_length(v_fail_ids, 1) IS NULL OR array_length(v_fail_ids, 1) < 20 THEN
        v_fail_ids := v_fail_ids || r.id;
      END IF;
    END;
  END LOOP;

  IF v_failed > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'warning',
           'fn_tournament_payout_sweep',
           format('Payout sweep could not reconcile %s of %s tournament(s) in this '
                  'pass; the rest were paid. First error: %s',
                  v_failed, v_scanned, COALESCE(v_first_err, 'unknown')),
           jsonb_build_object('failed', v_failed, 'scanned', v_scanned,
                              'first_error', v_first_err,
                              'sample_tournaments', to_jsonb(v_fail_ids))
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_tournament_payout_sweep'
          AND fa.resolved IS NOT TRUE);
  END IF;

  -- Truncation on an APPLYING pass, stated as what it is rather than as a
  -- conclusion this function is not in a position to draw. A narrow pass that
  -- truncates is normal when a deep pass backs it (RakebackSettlerService);
  -- the hourly pg_cron job has nothing behind it, so for that caller the
  -- unreached tail really is unreachable. This function cannot tell the two
  -- apart, so it reports and does not diagnose.
  IF p_apply AND v_matched > v_scanned THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'warning',
           'fn_tournament_payout_sweep_truncated',
           format('An applying payout sweep examined %s of %s tournament(s) in its '
                  '%s-day window and stopped at its %s-row limit, leaving %s '
                  'unexamined. It orders newest-first, so those only get older: '
                  'they are reached only by a wider pass, if one is configured. '
                  'If this caller has no deeper pass behind it, raise the limit.',
                  v_scanned, v_matched, GREATEST(p_days, 1), v_limit,
                  v_matched - v_scanned),
           jsonb_build_object('scanned', v_scanned, 'matched', v_matched,
                              'days', GREATEST(p_days, 1), 'limit', v_limit,
                              'unexamined', v_matched - v_scanned)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_tournament_payout_sweep_truncated'
          AND fa.resolved IS NOT TRUE);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'days', p_days,
    'applied', p_apply,
    'tournaments_with_findings', v_n,
    'total_top_up', round(v_topup, 2),
    'findings', v_out,
    'candidates_matched', v_matched,
    'candidates_scanned', v_scanned,
    'truncated', v_matched > v_scanned,
    'window_column', 'coalesce(ended_at, started_at, updated_at)',
    'failed', v_failed,
    'failed_tournaments', to_jsonb(v_fail_ids),
    'first_error', v_first_err
  );
END;
$function$;

-- Engine-only sweep; authorization unchanged.
REVOKE ALL ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer) TO service_role;
