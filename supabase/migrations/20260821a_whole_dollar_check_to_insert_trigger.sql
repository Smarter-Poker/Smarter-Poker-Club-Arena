-- ═══════════════════════════════════════════════════════════════════════════════
-- 20260821a: whole-dollar buy-in rule — CHECK constraint → INSERT-scoped trigger
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHY (live incident, 2026-08-21 ~01:00-02:20Z):
-- 20260820_whole_dollar_tournament_buyins.sql added
--   CHECK ((buy_in_amount + COALESCE(buy_in_fee,0)) = round(...)) NOT VALID
-- believing NOT VALID grandfathers existing rows. It does not: NOT VALID only
-- skips the initial validation SCAN — the CHECK still fires on every INSERT
-- and every UPDATE. 9,814 pre-refactor tournaments (old 1.1x pricing: 5.00 +
-- 0.50 = 5.50) became READ-ONLY:
--   * level_started_at persists failed every level ("violates check
--     constraint tournaments_whole_dollar_buyin" in engine logs, every cycle)
--   * two decided Turbo SNGs (3056c82a, ff73ca13) could not be flipped to
--     COMPLETING, so the stalled-winner recovery watchdog span uselessly for
--     an hour — winners uncrowned, prizes unpaid
--   * ANY future recovery/reconcile touching a legacy row would fail
--
-- The rule itself is right and stays enforced — but only where it can be
-- honored: on NEW rows, and on updates that CHANGE the buy-in columns.
-- Status flips, level clocks, and recovery on legacy rows must never be
-- hostage to a price written under the old convention.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_whole_dollar_buyin ON public.tournaments;
--   DROP FUNCTION IF EXISTS public.fn_enforce_whole_dollar_buyin();
--   ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_whole_dollar_buyin
--     CHECK ((buy_in_amount + COALESCE(buy_in_fee, 0::numeric))
--            = round(buy_in_amount + COALESCE(buy_in_fee, 0::numeric))) NOT VALID;

ALTER TABLE public.tournaments
  DROP CONSTRAINT IF EXISTS tournaments_whole_dollar_buyin;

CREATE OR REPLACE FUNCTION public.fn_enforce_whole_dollar_buyin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Enforce only when the price is being SET: every INSERT, and any UPDATE
  -- that actually changes a buy-in column. Updates to other columns on
  -- legacy fractional-total rows pass untouched.
  IF TG_OP = 'INSERT'
     OR NEW.buy_in_amount IS DISTINCT FROM OLD.buy_in_amount
     OR NEW.buy_in_fee    IS DISTINCT FROM OLD.buy_in_fee
  THEN
    IF (COALESCE(NEW.buy_in_amount, 0) + COALESCE(NEW.buy_in_fee, 0))
       <> round(COALESCE(NEW.buy_in_amount, 0) + COALESCE(NEW.buy_in_fee, 0))
    THEN
      RAISE EXCEPTION
        'whole-dollar buy-in rule: buy_in_amount (%) + buy_in_fee (%) must total a whole number — split a whole total via splitBuyIn(), never surcharge the fee on top',
        NEW.buy_in_amount, NEW.buy_in_fee;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_whole_dollar_buyin ON public.tournaments;
CREATE TRIGGER trg_whole_dollar_buyin
  BEFORE INSERT OR UPDATE ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_enforce_whole_dollar_buyin();

-- Post-apply assertions
DO $$
BEGIN
  -- 1. The old CHECK is gone.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tournaments'::regclass
      AND conname = 'tournaments_whole_dollar_buyin'
  ) THEN
    RAISE EXCEPTION 'tournaments_whole_dollar_buyin CHECK still present';
  END IF;
  -- 2. The trigger exists.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.tournaments'::regclass
      AND tgname = 'trg_whole_dollar_buyin'
  ) THEN
    RAISE EXCEPTION 'trg_whole_dollar_buyin missing';
  END IF;
END $$;
