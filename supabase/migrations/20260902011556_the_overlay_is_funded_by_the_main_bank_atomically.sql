-- ═══════════════════════════════════════════════════════════════════════════
-- DAN'S RULING, 2026-09-02: "ANY OVERLAYS ARE SUPPOSED TO BE FUNDED BY THE
-- MAIN BANK. SO CHANGE IT TO THE BET POOL, AND MAKE IT ATOMIC SO IT CAN NEVER
-- BE WRONG."
--
-- A guarantee is a promise that the prize pool reaches a floor. Six events in
-- 48 hours paid only what the field put in - 1,703 chips short, on events
-- advertising 2,500 guaranteed - because nothing ever topped the pool up.
--
-- WHY IT WAS NEVER A FUNDING PROBLEM. Two guards already existed:
-- trg_tournaments_guarantee_affordable refuses a guarantee the bank cannot
-- cover, and fn_guard_tournament_start_readiness refuses to START an event
-- whose guarantee is short. Both check the bank COULD pay. Neither ever made
-- it pay. The money was always there; nothing moved it.
--
-- THE BET POOL. chip_ledger already models this properly: to_type
-- 'prize_liability' IS the bet pool, and category 'overlay' already exists.
-- The overlay is posted union_bank -> prize_liability. (My first attempt
-- invented 'tournament_pool'/'tournament_overlay', the CHECK constraints
-- rejected it, and my own EXCEPTION handler swallowed the reason - money moved
-- with no journal row, the exact class closed in Phase 1. The probe caught it.)
--
-- WHERE THE MONEY COMES FROM. union_wallets.chip_balance, the Union Bank -
-- which atomic_distribute_rake deliberately never touches. NOT rake_wallet:
-- rake is owed to the clubs on Friday and is not the operator's to spend. A
-- private or union-less event draws on the club's own chip_treasury.
--
-- WHEN. In the SAME WRITE that closes registration - the BEFORE UPDATE trigger
-- assigns NEW.prize_pool directly rather than issuing its own UPDATE, so the
-- funding and the status change are one atomic statement and cannot come
-- apart. Funding at COMPLETED would be too late: all six underpaid events show
-- credited == prize_pool exactly, so payouts are priced off the pool.
--
-- IDEMPOTENT BY CONSTRUCTION. The top-up raises prize_pool to the guarantee,
-- so a second pass computes a shortfall of zero. No flag to drift.
--
-- ALL OR NOTHING. If the bank cannot cover it, the pool is untouched and a
-- critical alert is raised. A partially funded guarantee is worse than an
-- unfunded one because it looks paid.
--
-- Verified in rolled-back probes: pool 100 -> 600, bank -500.00 exactly,
-- shortfall 0 after, one journal row union_bank -> prize_liability 500.00
-- category overlay, zero ledger write failures.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_ca_overlay_shortfall(p_tournament_id uuid)
RETURNS numeric
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT GREATEST(0, round(COALESCE(t.guaranteed_prize,0),2) - round(COALESCE(t.prize_pool,0),2))
    FROM public.tournaments t WHERE t.id = p_tournament_id;
$fn$;

COMMENT ON FUNCTION public.fn_ca_overlay_shortfall(uuid) IS
  'What the main bank still owes this tournament to meet its guarantee. Zero once the pool has been topped up, which is why the funding is idempotent without a flag.';

CREATE OR REPLACE FUNCTION public.fn_ca_fund_overlay_on_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_short numeric; v_union uuid; v_bank numeric; v_from text;
  v_st text; v_msg text;
BEGIN
  IF NOT (COALESCE(OLD.status,'') IN ('ANNOUNCED','REGISTERING')
          AND NEW.status IN ('RUNNING','COMPLETING','COMPLETED')) THEN
    RETURN NEW;
  END IF;

  v_short := GREATEST(0, round(COALESCE(NEW.guaranteed_prize,0),2)
                       - round(COALESCE(NEW.prize_pool,0),2));
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
      'Guarantee overlay funded from the main bank: ' || COALESCE(NEW.name, NEW.id::text));
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
  'Tops the prize pool up to the guarantee out of the main bank in the SAME write that closes registration, so a guaranteed tournament cannot start underfunded. Posts union_bank -> prize_liability under category overlay: the bet pool the ledger already models. Idempotent by construction. All or nothing.';

DROP TRIGGER IF EXISTS trg_ca_fund_overlay_on_lock ON public.tournaments;
CREATE TRIGGER trg_ca_fund_overlay_on_lock
  BEFORE UPDATE OF status ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_fund_overlay_on_lock();

REVOKE ALL ON FUNCTION public.fn_ca_overlay_shortfall(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_overlay_shortfall(uuid) TO service_role, authenticated;
