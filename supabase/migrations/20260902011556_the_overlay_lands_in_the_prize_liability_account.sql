-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902011556; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- The probe for the_overlay_is_funded_by_the_main_bank_atomically showed the
-- money moving correctly - pool 100 -> 600, bank -500.00 exactly, shortfall 0 -
-- and `ledger +0`. The journal row was never written, and my own
-- EXCEPTION WHEN OTHERS THEN NULL swallowed the reason. Money that moves
-- without a ledger row is precisely the class closed in Phase 1, and I had
-- re-created it in the fix for something else.
--
-- The cause was my vocabulary, not the schema. chip_ledger already models a
-- bet pool properly:
--
--   to_type  ... 'prize_liability'   <- THE BET POOL. I wrote 'tournament_pool'.
--   category ... 'overlay'           <- exactly this. I wrote 'tournament_overlay'.
--
-- So the double-entry account Dan asked for already exists in the ledger's own
-- vocabulary; the overlay simply has to be posted into it. from_type
-- 'union_bank' and 'club_treasury' were already correct.
--
-- And the swallow is replaced. A journal write must never block the money it
-- records - that rule stands - but the failure now lands in
-- ca_ledger_write_failures, the way atomic_distribute_rake does it, so an
-- unjournalled movement is loud instead of invisible.

CREATE OR REPLACE FUNCTION public.fn_ca_fund_overlay_on_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_short numeric;
  v_union uuid;
  v_bank  numeric;
  v_from  text;
  v_st    text;
  v_msg   text;
BEGIN
  IF NOT (COALESCE(OLD.status,'') IN ('ANNOUNCED','REGISTERING')
          AND NEW.status IN ('RUNNING','COMPLETING','COMPLETED')) THEN
    RETURN NEW;
  END IF;

  v_short := GREATEST(0, round(COALESCE(NEW.guaranteed_prize,0),2)
                       - round(COALESCE(NEW.prize_pool,0),2));
  IF v_short <= 0 THEN
    RETURN NEW;
  END IF;

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
          'union_id',v_union,'shortfall',v_short,'bank',COALESCE(v_bank,0)),
        NEW.id::text);
      RETURN NEW;
    END IF;

    UPDATE public.union_wallets
       SET chip_balance = chip_balance - v_short, updated_at = now()
     WHERE union_id = v_union;
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
          'club_id',NEW.club_id,'shortfall',v_short,'bank',COALESCE(v_bank,0)),
        NEW.id::text);
      RETURN NEW;
    END IF;

    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury,0) - v_short, updated_at = now()
     WHERE id = NEW.club_id;
  END IF;

  NEW.prize_pool := round(COALESCE(NEW.prize_pool,0) + v_short, 2);

  BEGIN
    INSERT INTO public.chip_ledger (
      performed_by, from_type, from_entity_id, to_type, to_entity_id,
      amount, category, club_id, tournament_id, description)
    VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      v_from, COALESCE(v_union, NEW.club_id), 'prize_liability', NEW.id,
      v_short, 'overlay', NEW.club_id, NEW.id,
      'Guarantee overlay funded from the main bank: '
        || COALESCE(NEW.name, NEW.id::text));
  EXCEPTION WHEN OTHERS THEN
    /* The journal must never block the money it records - but a movement that
       failed to journal has to be LOUD, not swallowed. */
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

COMMENT ON FUNCTION public.fn_ca_fund_overlay_on_lock() IS
  'Tops the prize pool up to the guarantee out of the main bank (union_wallets.chip_balance, or clubs.chip_treasury for a private event) in the SAME write that closes registration, so a guaranteed tournament cannot start underfunded. Posts the movement into the prize_liability account under category overlay - the bet pool the ledger already models. Idempotent by construction. All or nothing: if the bank cannot cover it the pool is untouched and a critical alert is raised.';

