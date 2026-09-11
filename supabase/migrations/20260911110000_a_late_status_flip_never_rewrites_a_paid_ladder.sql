/*
  A LATE STATUS FLIP NEVER REWRITES A PAID LADDER (2026-09-11).

  zz_ca_fund_overlay_on_lock fires on every ANNOUNCED/REGISTERING ->
  RUNNING/COMPLETING/COMPLETED transition and, in its first block, replaces
  payout_structure with fn_ca_payout_structure(entrants, payout_percent)
  whenever the stored ladder has a different number of places. That is a
  start-time rule. It assumed the first status write it sees is the start.

  THE EVENT IT BROKE.  Breakfast Turbo c1f15c30 (40 entrants, 180.00 pool).
    - 14:01:23  the REGISTERING -> RUNNING flip failed three times; the game
                was dealt with its row still REGISTERING.
    - 14:24:55  entry closed; the engine fitted a six-place ladder
                (32.53/23.42/16.86/12.14/8.74/6.31) for the final field of 40
                (managed_game_contract_versions v3).
    - 14:35:24 - 14:36:41  places 6 to 2 were paid against that ladder.
    - 14:53:50  the played-but-registering sweep relabelled the row
                REGISTERING -> COMPLETING. This trigger saw a finalized pool
                with a six-place ladder, computed ceil(40 x 10%) = 4 places,
                and wrote 43.12/24.76/17.90/14.22 over it (contract v4).
    - 14:53:51  first place was priced at 77.62 against an escrow holding
                58.55 and paid 58.55. Since then fn_settle_tournament_places
                has refused the event every one to two minutes: place
                obligations 5 and 6 lie outside its derived four-place ladder.
  zzzz_freeze_finalized_tournament_prize_pool, which would refuse any
  payout_structure change once the pool is finalized, is still disabled
  (Stage A), so nothing stopped the write.

  THE FIX.  The payout-table block runs only while the pool is not finalized
  and no place has been paid or owed. After finalization the entry-close
  door owns the final field's ladder; after the first obligation the ladder
  is the contract that money was priced against. Nothing else changes: the
  overlay block, the Spin exclusion and the start-time fit for an event that
  has not finalized are byte-for-byte what they were. The function is
  replaced only if it is still exactly the 20260907220945 definition.

  Measured 2026-09-11 against production: of the non-Spin events paid since
  2026-09-01, c1f15c30 is the only one whose ladder was revised after its
  first payout.
*/
BEGIN;
-- a18b13b7... is the 20260907220945 definition live in production on 2026-09-11;
-- bb132bf0... is this migration's own definition, so a re-apply is a no-op.
DO $guard$ BEGIN
IF md5(pg_get_functiondef('public.fn_ca_fund_overlay_on_lock()'::regprocedure))
   NOT IN ('a18b13b709dc1e4d37b38f55a00eb6f4', 'bb132bf0c6fdedec767db56109c48e5e') THEN
RAISE EXCEPTION 'fn_ca_fund_overlay_on_lock changed since 20260907220945; rebase this correction before applying';
END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_fund_overlay_on_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_short numeric; v_union uuid; v_bank numeric; v_from text; v_store text;
  v_pool_before numeric;
  v_entrants int; v_places int; v_existing jsonb;
  v_guarantee numeric; v_seat_guarantee numeric; v_target uuid;
  v_attempt int; v_fallback numeric;
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

  /* NOT ONCE THE POOL IS FINALIZED OR A PLACE IS OWED (2026-09-11). This is a
     start-time fit. A game whose REGISTERING -> RUNNING flip failed deals with
     its row still REGISTERING, so the first status write that lands can come
     at entry close, after places are paid, or after the finish. Breakfast
     Turbo c1f15c30 was relabelled REGISTERING -> COMPLETING at 14:53:50 on
     2026-09-08, seventeen minutes after places 6 to 2 were paid against the
     six-place ladder fitted at entry close, and this block replaced that
     ladder with a four-place one: first place was then priced at 77.62
     against an escrow holding 58.55, and fn_settle_tournament_places has
     refused the event ever since because places 5 and 6 fell outside the
     ladder. Once the pool is finalized the entry-close door owns the final
     field's ladder, and once any place is paid or owed the ladder is the
     contract that money was priced against. Neither may be rewritten by a
     late lifecycle label. */
  IF NEW.variant IS DISTINCT FROM 'spin'
     AND NOT COALESCE(OLD.prize_pool_finalized, false)
     AND NOT EXISTS (SELECT 1 FROM public.tournament_payouts p
                      WHERE p.tournament_id = NEW.id)
     AND NOT EXISTS (SELECT 1 FROM public.tournament_obligations o
                      WHERE o.tournament_id = NEW.id) THEN
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
      /* THE MAIN BANK IS SHORT - FALL BACK TO THE CLUB TREASURY.
         Dan 2026-09-04. Refusing here meant advertising a guarantee and then
         not paying it. */
      SELECT chip_treasury INTO v_fallback
        FROM public.clubs WHERE id = NEW.club_id FOR UPDATE;

      IF COALESCE(v_fallback,0) >= v_short THEN
        v_from  := 'club_treasury';
        v_store := 'clubs.chip_treasury';
        PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
        UPDATE public.clubs
           SET chip_treasury = COALESCE(chip_treasury,0) - v_short, updated_at = now()
         WHERE id = NEW.club_id;
        PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
        PERFORM public.fn_raise_server_financial_alert(
          'warning', 'fn_ca_fund_overlay_on_lock',
          format('%s took its %s chip overlay from the club treasury: the union bank held only %s. The guarantee WAS met. Refill the union bank.',
                 COALESCE(NEW.name, NEW.id::text), v_short, COALESCE(v_bank,0)),
          jsonb_build_object('kind','overlay_funded_from_fallback','tournament_id',NEW.id,
            'shortfall',v_short,'union_bank',COALESCE(v_bank,0),
            'club_treasury',COALESCE(v_fallback,0)), NEW.id::text);
        v_union := NULL;  -- the ledger row names the account that actually moved
      ELSE
        PERFORM public.fn_raise_server_financial_alert(
          'critical', 'fn_ca_fund_overlay_on_lock',
          format('%s needs %s chips of overlay to meet its %s guarantee. The union bank holds %s and the club treasury holds %s. BOTH are short and the pool was NOT topped up.',
                 COALESCE(NEW.name, NEW.id::text), v_short, v_guarantee,
                 COALESCE(v_bank,0), COALESCE(v_fallback,0)),
          jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
            'shortfall',v_short,'bank',COALESCE(v_bank,0),
            'club_treasury',COALESCE(v_fallback,0)), NEW.id::text);
        RETURN NEW;
      END IF;
    ELSE
      PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
      UPDATE public.union_wallets
         SET chip_balance = chip_balance - v_short, updated_at = now()
       WHERE union_id = v_union;
      PERFORM set_config('app.ledger_autoskip_union_wallets', '0', true);
    END IF;
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

  -- Funding and its escrow/journal leg are one transaction. A failed
  -- journal insert must undo the bank debit and the advertised pool change.
  -- Retry only transient deadlocks; every final error propagates to the
  -- original status update, whose existing lifecycle can retry safely.
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
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      IF v_attempt = 3 THEN RAISE; END IF;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_fund_overlay_on_lock() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_fund_overlay_on_lock() TO service_role;

DO $assert$
DECLARE v_def text := pg_get_functiondef('public.fn_ca_fund_overlay_on_lock()'::regprocedure);
BEGIN
  IF position('AND NOT COALESCE(OLD.prize_pool_finalized, false)' IN v_def) = 0
     OR position('FROM public.tournament_payouts p' IN v_def) = 0
     OR position('FROM public.tournament_obligations o' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the payout-table block is not guarded by finalization and settlement evidence';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.tournaments'::regclass
                    AND tgname = 'zz_ca_fund_overlay_on_lock' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'zz_ca_fund_overlay_on_lock is not the enabled trigger on public.tournaments';
  END IF;
END
$assert$;
COMMIT;
