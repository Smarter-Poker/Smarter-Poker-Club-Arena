-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902171129; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- A SPIN'S PAYOUT LADDER IS DRAWN, NOT COMPUTED FROM THE FIELD SIZE
--
-- LIVE MONEY BUG, 32 games and 1,592 chips since 2026-09-02 04:13 UTC.
--
-- fn_ca_fund_overlay_on_lock fires BEFORE UPDATE on tournaments when status
-- moves REGISTERING -> RUNNING. That is exactly the moment the engine writes
-- the Spin draw, so the trigger sees the drawn ladder and rewrites it.
--
-- Its rule is an MTT rule: pay the top `payout_percent` of the field. For a
-- three-handed Spin that is
--
--   v_places := GREATEST(1, LEAST(3, ceil(3 * 10 / 100.0)::int))   ->  1
--
-- and then the condition `jsonb_array_length(v_existing) <> v_places` is TRUE
-- for every high multiplier, because a 10x pays TWO places. So the drawn
-- [{place:1,80},{place:2,20}] was replaced by
-- fn_ca_payout_structure(3, 10), which returns exactly
--
--   [{"place": 1, "percentage": 100.0000000000000000}]
--
-- That string is byte-identical to what is on every affected row - this was
-- confirmed against production, not inferred. Second place was paid nothing.
--
-- WHY IT STARTED SUDDENLY. The trigger's own comment says the payout rewrite
-- stood down while it sorted BEFORE fn_guard_managed_game_lifecycle, and was
-- to be "re-enabled once the trigger is renamed to sort after the guard". It
-- is now named `zz_ca_fund_overlay_on_lock`. The rename re-enabled the
-- rewrite, and every 10x since has paid 100/0 instead of 80/20.
--
-- THE FIX. A Spin's ladder is a property of the multiplier the wheel drew,
-- from SPIN_TIERS - 2x/3x/4x/5x pay one place, 10x pays 80/20, and the higher
-- tiers pay three. It is not a percentage of a three-player field and never
-- was. The overlay half of this trigger is untouched: a Spin carries no
-- guarantee, so it returns at the `v_short <= 0` line as it always did.
--
-- Everything below is byte-identical to the deployed function except the
-- single `NEW.variant IS DISTINCT FROM 'spin'` guard on section 1.
--
-- ROLLBACK: re-apply the previous definition (drop the variant guard).

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
  v_short := GREATEST(0, round(COALESCE(NEW.guaranteed_prize,0),2) - v_pool_before);
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
               round(COALESCE(NEW.guaranteed_prize,0),2), COALESCE(v_bank,0)),
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
               round(COALESCE(NEW.guaranteed_prize,0),2), COALESCE(v_bank,0)),
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
             v_short, round(COALESCE(NEW.guaranteed_prize,0),2),
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

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='fn_ca_fund_overlay_on_lock';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_ca_fund_overlay_on_lock is missing after replace';
  END IF;
  IF v_def NOT LIKE '%variant IS DISTINCT FROM ''spin''%' THEN
    RAISE EXCEPTION 'the spin guard did not take';
  END IF;
  -- the overlay half must still be intact
  IF v_def NOT LIKE '%prize_liability%' OR v_def NOT LIKE '%chip_treasury%' THEN
    RAISE EXCEPTION 'the guarantee overlay was lost in the rewrite';
  END IF;
  RAISE NOTICE 'spin guard in place; overlay intact';
END $$;
