-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828023723; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Money-path audit 2026-08-27. Three guards: cancellation, guarantee funding,
-- and the PKO+Mystery hybrid.
--
-- =====================================================================
-- GUARD 1 - CANCELLED must not destroy chips.
-- =====================================================================
-- 18 cancelled events hold 49 player rows that paid and were never refunded:
-- 766.00 chips destroyed. (The audit found 16 events / 25 rows / 596.00 looking
-- only at Heads-Up; across all variants it is wider.) ended_at is NULL on all of
-- them, which proves atomic_cancel_tournament never ran - something wrote
-- status='CANCELLED' directly, bypassing the refund loop and the fee reversal.
-- 686 of 7,779 cancelled events have no ended_at at all.
--
-- This is a DEFERRED CONSTRAINT TRIGGER, not a BEFORE trigger, and that matters:
-- atomic_cancel_tournament sets status='CANCELLED' FIRST and issues the refunds
-- afterwards in the same transaction. A BEFORE trigger would see zero refunds and
-- break the one code path that does this correctly. Deferring to COMMIT means the
-- legitimate path passes and a direct UPDATE fails.

CREATE OR REPLACE FUNCTION public.trg_tournaments_cancel_must_refund()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_rows integer; v_sum numeric;
BEGIN
  IF NEW.ended_at IS NULL THEN
    RAISE EXCEPTION
      'Tournament % cannot be CANCELLED without ended_at — cancel via atomic_cancel_tournament so the refunds and fee reversal run',
      NEW.id
      USING ERRCODE = '55000';
  END IF;

  WITH paid AS (
    SELECT w.user_id,
           round(COALESCE(sum(
             CASE WHEN w.type = 'debit'  AND w.category IN ('tournament_buyin','rebuy','addon') THEN w.amount
                  WHEN w.type = 'credit' AND w.category = 'refund' THEN -w.amount
                  ELSE 0 END), 0), 2) AS net
      FROM wallet_transactions w
     WHERE w.related_entity_id = NEW.id
     GROUP BY w.user_id
  )
  SELECT count(*), COALESCE(round(sum(net), 2), 0)
    INTO v_rows, v_sum
    FROM paid WHERE net > 0.005;

  IF COALESCE(v_rows, 0) > 0 THEN
    RAISE EXCEPTION
      'Tournament % cannot be CANCELLED: % entrant(s) paid % chips that were never refunded. Cancel via atomic_cancel_tournament.',
      NEW.id, v_rows, v_sum
      USING ERRCODE = '55000';
  END IF;

  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS tournaments_cancel_must_refund ON public.tournaments;

CREATE CONSTRAINT TRIGGER tournaments_cancel_must_refund
AFTER UPDATE ON public.tournaments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (upper(COALESCE(NEW.status,'')) IN ('CANCELLED','CANCELED')
      AND upper(COALESCE(OLD.status,'')) IS DISTINCT FROM upper(COALESCE(NEW.status,'')))
EXECUTE FUNCTION public.trg_tournaments_cancel_must_refund();


-- =====================================================================
-- GUARD 2 - a guarantee may not be announced that the treasury cannot pay.
-- =====================================================================
-- The overlay is currently conjured in TypeScript: effectivePrizePool() takes
-- Math.max(prize_pool, guaranteed_prize) and writes it straight to the row with
-- no treasury debit. fn_apply_prize_guarantee - which writes a
-- tournament_guarantee_overlays row and decrements clubs.chip_treasury - has
-- zero TypeScript callers. 2,823 completed guaranteed events have no overlay row.
--
-- Replacing those three TS write sites needs repo access. What CAN be enforced
-- here is the precondition: refuse to ANNOUNCE a guarantee the club cannot fund.
-- Measured now: Midway Union sits at treasury -4,346.80 with 29,667.30 of live
-- unfunded guarantee exposure already announced and still to be honoured.
--
-- OPERATIONAL CONSEQUENCE, READ THIS: with enforcement on, Midway Union cannot
-- announce further guaranteed events until its treasury is topped up. That is the
-- intent - it is how the bleeding stops - but it will be visible immediately in
-- the recurring scheduler. Per-club escape hatch, no redeploy needed:
--   UPDATE clubs SET guarantee_enforcement_enabled = false WHERE id = '...';
-- which downgrades the refusal to a critical alert.

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS guarantee_treasury_floor numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS guarantee_enforcement_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.clubs.guarantee_treasury_floor IS
  'Treasury level below which new guaranteed tournaments are refused. 0 = may not go negative.';
COMMENT ON COLUMN public.clubs.guarantee_enforcement_enabled IS
  'False downgrades the guarantee affordability refusal to a critical alert. Escape hatch only.';

CREATE OR REPLACE FUNCTION public.trg_tournaments_guarantee_affordable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_treasury numeric; v_floor numeric; v_enforce boolean; v_name text;
  v_exposure numeric; v_this numeric; v_headroom numeric;
BEGIN
  IF COALESCE(NEW.guaranteed_prize, 0) <= 0 OR NEW.club_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(chip_treasury, 0), COALESCE(guarantee_treasury_floor, 0),
         COALESCE(guarantee_enforcement_enabled, true), name
    INTO v_treasury, v_floor, v_enforce, v_name
    FROM public.clubs WHERE id = NEW.club_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- Guarantees already promised on this club's live, not-yet-finalized events.
  SELECT COALESCE(sum(GREATEST(COALESCE(t.guaranteed_prize,0) - COALESCE(t.prize_pool,0), 0)), 0)
    INTO v_exposure
    FROM public.tournaments t
   WHERE t.club_id = NEW.club_id
     AND t.id <> NEW.id
     AND COALESCE(t.guaranteed_prize, 0) > 0
     AND COALESCE(t.prize_pool_finalized, false) = false
     AND t.status IN ('ANNOUNCED','REGISTERING','RUNNING');

  v_this     := GREATEST(COALESCE(NEW.guaranteed_prize,0) - COALESCE(NEW.prize_pool,0), 0);
  v_headroom := v_treasury - v_floor - v_exposure - v_this;

  IF v_headroom < 0 THEN
    IF v_enforce THEN
      RAISE EXCEPTION
        'Club % cannot guarantee % chips: treasury %, floor %, already promised % on live events — short by %',
        COALESCE(v_name, NEW.club_id::text), NEW.guaranteed_prize,
        round(v_treasury,2), round(v_floor,2), round(v_exposure,2), round(-v_headroom,2)
        USING ERRCODE = '55000';
    ELSE
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('critical', 'trg_tournaments_guarantee_affordable',
              'Guaranteed tournament announced that the club treasury cannot cover: '
                || COALESCE(v_name, NEW.club_id::text),
              jsonb_build_object('club_id', NEW.club_id, 'tournament_id', NEW.id,
                                 'guaranteed_prize', NEW.guaranteed_prize,
                                 'treasury', v_treasury, 'floor', v_floor,
                                 'live_exposure', v_exposure, 'short_by', -v_headroom,
                                 'note', 'enforcement disabled for this club; no money was blocked'));
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS tournaments_guarantee_affordable_ins ON public.tournaments;
DROP TRIGGER IF EXISTS tournaments_guarantee_affordable_upd ON public.tournaments;

CREATE TRIGGER tournaments_guarantee_affordable_ins
BEFORE INSERT ON public.tournaments
FOR EACH ROW
WHEN (COALESCE(NEW.guaranteed_prize, 0) > 0)
EXECUTE FUNCTION public.trg_tournaments_guarantee_affordable();

-- Only re-checked when the promise itself changes, so routine tournament
-- updates (level ticks, player counts) pay nothing for this guard.
CREATE TRIGGER tournaments_guarantee_affordable_upd
BEFORE UPDATE ON public.tournaments
FOR EACH ROW
WHEN (COALESCE(NEW.guaranteed_prize, 0) > 0
      AND NEW.guaranteed_prize IS DISTINCT FROM OLD.guaranteed_prize)
EXECUTE FUNCTION public.trg_tournaments_guarantee_affordable();


-- =====================================================================
-- GUARD 3 - the PKO + Mystery hybrid is not a defined product.
-- =====================================================================
-- fn_collect_bounty computes v_mode = 'pko' whenever is_pko is set, regardless of
-- is_mystery_bounty, and no code path downstream handles the combination.
--
-- The ruling, and why: a PKO head is a claim against (bounty_pool -
-- bounty_pool_paid). A mystery chest is a sealed inventory where sum(chests) =
-- pool. They are two different pools. Paying a chest 50/50 into cash and head -
-- the obvious way to "support both" - would create head liability backed by chest
-- money and break the sealed-set invariant that makes the chest inventory
-- auditable. There is no arithmetic that satisfies both formats at once, so the
-- honest answer is that the combination is not a product, and the safe place to
-- say so is at creation.
--
-- Zero events currently carry both flags, so this constraint is free to add.
-- fn_collect_bounty also gets an explicit refusal as a tripwire, in case the
-- constraint is ever dropped.

ALTER TABLE public.tournaments
  DROP CONSTRAINT IF EXISTS tournaments_no_pko_mystery_hybrid;

ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_no_pko_mystery_hybrid
  CHECK (NOT (COALESCE(is_pko, false) AND COALESCE(is_mystery_bounty, false)));
