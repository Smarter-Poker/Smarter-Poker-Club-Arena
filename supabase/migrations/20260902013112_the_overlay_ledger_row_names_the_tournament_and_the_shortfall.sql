-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902013112; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- DAN, 2026-09-02: "WHEN YOU ARE TAKING CHIPS FROM THE MAIN BANK TO PAY AN
-- OVERLAY OR SHORTAGE, THERE MUST BE A TRANSACTION RECORD OF IT IN THE LEDGER,
-- SAYING WHICH TOURNAMENT IT WAS, AND HOW MUCH IT WAS SHORT."
--
-- He is right, and one_movement_one_journal_row got it backwards. When the
-- overlay trigger fired live at 01:28 on Midnight Bounty (NLH) it produced TWO
-- rows for the same 42.50:
--
--   union_bank -> prize_liability  42.50  "Guarantee overlay funded from the
--                                          main bank: Midnight Bounty (NLH)"
--   union_bank -> prize_liability  42.50  "auto-ledgered union_wallets
--                                          .chip_balance delta -42.50"
--
-- The second names no tournament and carries no tournament_id. Earlier I
-- deduplicated the BACKFILL by deleting the descriptive rows and keeping the
-- automatic ones - which threw away exactly the detail Dan is asking for. The
-- rule was right ("never both"); I kept the wrong half.
--
-- So: suppress the auto-journal for the bank debit and keep the descriptive
-- row, which now also states the SHORTFALL and the GUARANTEE it was measured
-- against, so the record answers "which tournament" and "how much short"
-- without a join.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_ca_fund_overlay_on_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_short numeric; v_union uuid; v_bank numeric; v_from text;
  v_st text; v_msg text; v_pool_before numeric;
BEGIN
  IF NOT (COALESCE(OLD.status,'') IN ('ANNOUNCED','REGISTERING')
          AND NEW.status IN ('RUNNING','COMPLETING','COMPLETED')) THEN
    RETURN NEW;
  END IF;

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
    /* the descriptive row below IS the record of this movement; stand the
       auto-journal down so there is exactly one, and it is the readable one */
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

COMMENT ON FUNCTION public.fn_ca_fund_overlay_on_lock() IS
  'Tops the prize pool up to the guarantee out of the main bank in the SAME write that closes registration. Writes exactly ONE ledger row for the draw - union_bank/club_treasury -> prize_liability, category overlay - naming the tournament, the shortfall, the guarantee and what the field actually made. The auto-journal is suppressed for the bank debit so the readable row is the only one.';

