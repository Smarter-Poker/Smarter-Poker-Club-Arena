-- A GUARANTEED SEAT IS A GUARANTEE, AND IS FUNDED AT LOCK
-- Chip Accounting Standard S12 / S15 / 3.2 step 9 (2026-09-02, found by the
-- round-2 conflict audit two hours after the engine cut over to
-- fn_settle_tournament_obligation).
--
-- A satellite advertises `satellite_seats` seats into its target. The engine
-- awards every advertised seat whether or not the field paid for them
-- (measured over 14 days: eleven satellites collected 3,217.50 and awarded
-- 4,600 in seats plus 2,200 in cash). Until today the difference was minted:
-- the target's prize_pool rose with no debit anywhere. Lane G stopped the
-- mint by moving the seat value out of the satellite's own pool (or as much of
-- it as the pool holds, with a warning), and fn_settle_tournament_obligation
-- now refuses a cash payout past the pool. Together they expose what the
-- guarantee always was: house money that nobody had put up.
--
-- The one place this bites a player: when a seat cannot be booked into the
-- target (fn_award_satellite_seat returned 400 at 20:14 today, tournament
-- 91dd8dbf) the engine pays the ticket value in cash as a 'place' obligation.
-- Against an unfunded pool that cash is now REFUSED with escrow_short - the
-- obligation is recorded as owed and unpaid, and the winner waits for a human.
-- Twelve satellites are open right now, all union events into the Sunday Deep
-- Stack, 18 guaranteed seats worth 3,600 against 1,003.50 collected; the first
-- locks at 23:00 UTC.
--
-- THE FIX is the standard's rule for every guarantee (already live for
-- guaranteed_prize since this morning): at lock, the bank puts the overlay
-- INTO the pool before it is advertised, or refuses loudly and the event pays
-- what it holds. A satellite's guarantee is `satellite_seats x (target buy-in
-- + fee)`; the overlay is that minus the collected pool. Same bank rules, same
-- refusal, same ledger row (union_bank|club_treasury -> prize_liability,
-- category overlay). Nothing else in the trigger changes.
--
-- Cost, stated plainly for Dan: at today's fields the union bank (69,820.84)
-- funds about 2,600 chips across the twelve open satellites. That is the
-- guarantee the lobby has been advertising; it used to be minted.
--
-- One statement, one transaction (CREATE OR REPLACE of the trigger function;
-- the trigger zz_ca_fund_overlay_on_lock is untouched).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_fund_overlay_on_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_short numeric; v_union uuid; v_bank numeric; v_from text;
  v_st text; v_msg text; v_pool_before numeric;
  v_entrants int; v_places int; v_existing jsonb;
  v_guarantee numeric; v_seat_guarantee numeric; v_target uuid;
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
  IF NEW.variant = 'satellite' AND COALESCE(NEW.satellite_seats, 0) > 0 THEN
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
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
      VALUES (NEW.club_id, NULL, v_short, v_st,
              'fn_ca_fund_overlay_on_lock (tournament ' || NEW.id::text || '): ' || v_msg);
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END;

  RETURN NEW;
END;
$function$;

-- Trigger function: not callable by anyone directly. Restated for the repo's definer gate.
REVOKE ALL ON FUNCTION public.fn_ca_fund_overlay_on_lock() FROM PUBLIC, anon, authenticated;

COMMIT;
