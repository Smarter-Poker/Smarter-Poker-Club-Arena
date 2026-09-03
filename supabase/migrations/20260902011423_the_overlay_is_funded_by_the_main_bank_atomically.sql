-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902011423; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- DAN'S RULING, 2026-09-02: "ANY OVERLAYS ARE SUPPOSED TO BE FUNDED BY THE
-- MAIN BANK. SO CHANGE IT TO THE BET POOL, AND MAKE IT ATOMIC SO IT CAN NEVER
-- BE WRONG."
--
-- A guarantee is a promise that the prize pool reaches a floor. Six events in
-- 48 hours paid out only what the field put in - 1,703 chips short, on events
-- advertising 2,500 guaranteed - because nothing ever topped the pool up.
--
-- This is the bet-pool model the industry uses, applied to the existing
-- schema: the pool is topped to the guarantee out of the MAIN BANK, and it
-- happens in the SAME STATEMENT as the status change that closes registration.
-- Not a job, not a sweep, not a nightly repair. One transaction: the event
-- cannot leave registration and the bank cannot fail to fund it, because they
-- are the same write.
--
-- WHERE THE MONEY COMES FROM. The main bank is union_wallets.chip_balance -
-- the Union Bank, which atomic_distribute_rake deliberately never touches
-- (rake goes to rake_wallet, a different pot). For a private or union-less
-- event it is the club's own chip_treasury. Never the rake treasury: rake is
-- owed to the clubs at the end of the week and is not the operator's to spend.
--
-- WHEN. On the transition OUT of the registration phase - into RUNNING,
-- COMPLETING or COMPLETED, whichever the engine reaches first. That is the
-- moment the field is locked and the guarantee becomes a debt, and it is
-- before any payout is computed. Funding at COMPLETED would be too late: the
-- six underpaid events all show credited == prize_pool exactly, so payouts are
-- priced off the pool.
--
-- IDEMPOTENT BY CONSTRUCTION. The top-up raises prize_pool to the guarantee,
-- so a second pass computes a shortfall of zero. No flag to get out of sync.
--
-- ALL OR NOTHING. If the bank cannot cover the overlay the pool is left
-- untouched and a critical alert is raised. A partially funded guarantee is
-- the one outcome worse than an unfunded one, because it looks paid.
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

-- ── The atomic top-up, as a BEFORE UPDATE trigger ──────────────────────────
-- BEFORE, and assigning NEW.prize_pool directly rather than UPDATE-ing the
-- row: that keeps it in the same write as the status change and avoids
-- recursing into this trigger.
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
BEGIN
  -- only when the field locks: registration -> anything downstream
  IF NOT (COALESCE(OLD.status,'') IN ('ANNOUNCED','REGISTERING')
          AND NEW.status IN ('RUNNING','COMPLETING','COMPLETED')) THEN
    RETURN NEW;
  END IF;

  v_short := GREATEST(0, round(COALESCE(NEW.guaranteed_prize,0),2)
                       - round(COALESCE(NEW.prize_pool,0),2));
  IF v_short <= 0 THEN
    RETURN NEW;                       -- field beat the guarantee; nothing owed
  END IF;

  /* ZERO-DRIFT: say what this movement is before any balance is written, so
     the auto-journal files it as an overlay rather than anonymous suspense. */
  PERFORM set_config('app.ledger_category', 'tournament_overlay', true);
  PERFORM set_config('app.ledger_counterparty', 'tournament_pool', true);
  PERFORM set_config('app.ledger_counterparty_entity', NEW.id::text, true);

  v_union := CASE WHEN COALESCE(NEW.is_private,false) THEN NULL ELSE NEW.union_id END;

  IF v_union IS NOT NULL THEN
    -- THE MAIN BANK. Not rake_wallet: that is owed to the clubs on Friday.
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
      RETURN NEW;                     -- all or nothing; never a partial top-up
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

  -- the bet pool rises to the guarantee, in this same write
  NEW.prize_pool := round(COALESCE(NEW.prize_pool,0) + v_short, 2);

  BEGIN
    INSERT INTO public.chip_ledger (
      performed_by, from_type, from_entity_id, to_type, to_entity_id,
      amount, category, club_id, tournament_id, description)
    VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      v_from, COALESCE(v_union, NEW.club_id), 'tournament_pool', NEW.id,
      v_short, 'tournament_overlay', NEW.club_id, NEW.id,
      'Guarantee overlay funded from the main bank: '
        || COALESCE(NEW.name, NEW.id::text));
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- the journal must never be able to block the money it records
  END;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_fund_overlay_on_lock() IS
  'Tops the prize pool up to the guarantee out of the main bank (union_wallets.chip_balance, or clubs.chip_treasury for a private event) in the SAME write that closes registration, so a guaranteed tournament cannot start underfunded. Idempotent by construction: the top-up removes the shortfall. All or nothing: if the bank cannot cover it the pool is untouched and a critical alert is raised.';

DROP TRIGGER IF EXISTS trg_ca_fund_overlay_on_lock ON public.tournaments;
CREATE TRIGGER trg_ca_fund_overlay_on_lock
  BEFORE UPDATE OF status ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_fund_overlay_on_lock();

REVOKE ALL ON FUNCTION public.fn_ca_overlay_shortfall(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_overlay_shortfall(uuid) TO service_role, authenticated;

