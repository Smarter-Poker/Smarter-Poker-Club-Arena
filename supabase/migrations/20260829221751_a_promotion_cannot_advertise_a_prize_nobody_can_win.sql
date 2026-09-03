-- ═══════════════════════════════════════════════════════════════════════════
--  A PROMOTION CANNOT ADVERTISE A PRIZE NOBODY CAN WIN — SILENTLY (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE GAP. `promotions.prize_pool` and `promotion_leaderboards.prize` are
-- stored, read and RENDERED to players. Nothing anywhere writes
-- `promotion_leaderboards.prize`:
--
--   * PromotionService.updateLeaderboardScore upserts `score` only;
--   * recalculate_leaderboard_ranks (20260125800) UPDATEs `rank` and
--     `updated_at` only.
--
-- And there is no high-hand scorer, no rake-race settler and no leaderboard
-- payout job anywhere in the repo. So a club can create a leaderboard,
-- high_hand or rake_race promotion, advertise a prize pool, take part in it,
-- and NOBODY IS EVER PAID. Measured today: four promotions carrying 9,500 of
-- advertised prize pool between them, 0 leaderboard entries, 0 prizes written.
-- Those four are seed fixtures with past end dates, so no player is owed
-- anything right now -- which is luck, not safety.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO.
--
-- It does not build the payout. How a rake-race pool splits by rank, when a
-- high hand is scored and locked, what qualifies -- those are PRODUCT rules,
-- and inventing them inside a trigger would repeat the mistake that had
-- fn_settle_tournament_rake paying nobody for 39 events because an agent
-- decided on its own that horses should not earn.
--
-- It also does not BLOCK the promotion. Refusing the insert would break a club
-- mid-setup for a feature gap that is not their fault.
--
-- What it does is make the gap impossible to hit quietly: activating a
-- promotion of a type with no payout path, while advertising money, raises a
-- warning naming the promotion and the amount. One alert per promotion.
--
-- WHEN THE PAYOUT IS BUILT: delete this trigger in the same commit.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- DROP TRIGGER trg_promotion_prize_has_no_payout_path ON public.promotions;
-- DROP FUNCTION public.fn_warn_promotion_has_no_payout_path();
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_warn_promotion_has_no_payout_path()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Only the types that have no settler. deposit_match and refer_friend DO
  -- have a payout path (PromotionService.applyDepositBonus / processReferral),
  -- and tournament-backed types are paid by the engine.
  IF COALESCE(NEW.type, '') NOT IN ('leaderboard', 'high_hand', 'rake_race') THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.status, '') <> 'active' OR COALESCE(NEW.prize_pool, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO financial_alerts (severity, source, message, context)
  SELECT 'warning', 'promotions.no_payout_path',
         'A promotion is advertising a prize pool that nothing can pay out',
         jsonb_build_object(
           'promotion_id', NEW.id,
           'club_id', NEW.club_id,
           'name', NEW.name,
           'type', NEW.type,
           'prize_pool', NEW.prize_pool,
           'detail', 'promotion_leaderboards.prize is read and rendered but nothing writes it; '
                  || 'updateLeaderboardScore writes score only and recalculate_leaderboard_ranks '
                  || 'writes rank only, and there is no high-hand scorer, rake-race settler or '
                  || 'leaderboard payout job. Players can enter and qualify; nobody can be paid.')
   WHERE NOT EXISTS (
     SELECT 1 FROM financial_alerts
      WHERE source = 'promotions.no_payout_path'
        AND resolved IS NOT TRUE
        AND context->>'promotion_id' = NEW.id::text);

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_promotion_prize_has_no_payout_path ON public.promotions;

CREATE TRIGGER trg_promotion_prize_has_no_payout_path
  AFTER INSERT OR UPDATE OF status, prize_pool, type ON public.promotions
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_warn_promotion_has_no_payout_path();

DO $$
BEGIN
  PERFORM 1 FROM pg_trigger WHERE tgname = 'trg_promotion_prize_has_no_payout_path';
  IF NOT FOUND THEN RAISE EXCEPTION 'the trigger is not installed'; END IF;
END $$;
