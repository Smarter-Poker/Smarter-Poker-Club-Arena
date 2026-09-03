-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902013538; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- tournaments.payout_structure is TEXT, not jsonb. My comparison in
-- the_payout_table_is_built_from_the_field_that_showed_up wrote
-- COALESCE(NEW.payout_structure,'[]'::jsonb), which is a type error raised at
-- RUNTIME inside the trigger - so it would have blocked EVERY tournament
-- start, on a floor that starts thousands a day.
--
-- It never reached production traffic: the probe ran the real transition
-- first, in a transaction it rolled back, and the error surfaced there instead
-- of on a live event. This is exactly why the probe drives the real UPDATE
-- rather than calling the function in isolation.
--
-- Fixed by parsing the text as jsonb for the comparison and writing the new
-- structure back as text, matching the column.

CREATE OR REPLACE FUNCTION public.fn_ca_fund_overlay_on_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_short numeric; v_union uuid; v_bank numeric; v_from text;
  v_st text; v_msg text; v_pool_before numeric;
  v_entrants int; v_places int; v_existing jsonb;
BEGIN
  IF NOT (COALESCE(OLD.status,'') IN ('ANNOUNCED','REGISTERING')
          AND NEW.status IN ('RUNNING','COMPLETING','COMPLETED')) THEN
    RETURN NEW;
  END IF;

  /* ── 1. the payout table, from the field that actually entered ────────── */
  SELECT count(*) INTO v_entrants
    FROM public.tournament_players tp WHERE tp.tournament_id = NEW.id;

  IF v_entrants > 0 THEN
    v_places := GREATEST(1, LEAST(v_entrants,
                  ceil(v_entrants * COALESCE(NEW.payout_percent,10) / 100.0)::int));

    BEGIN
      v_existing := NULLIF(btrim(COALESCE(NEW.payout_structure,'')), '')::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_existing := NULL;             -- unparseable is treated as absent
    END;

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
$fn$;

