-- v_spin_tier_availability was missing can_draw_500x.
--
-- The client has always asked for it:
--   src/hooks/useSpinTierAvailability.ts
--     .select('club_id, can_draw_100x, can_draw_500x')
--
-- PostgREST answered 42703 (column does not exist) for that whole select, so
-- the hook took its `if (error) return;` path on EVERY refresh and kept an
-- empty cache. The visible effect was not "500x missing" but the entire tier
-- badge dying: DynamicGameCard computes
--   liveTop = can_draw_500x ? 500 : can_draw_100x ? 100 : null
-- and with no rows it is always null, so neither "100x LIVE" nor "500x LIVE"
-- ever rendered, even for clubs whose reserve pool covered the 100x.
--
-- The 500x rule mirrors the 100x rule already in the view: the reserve pool
-- must cover the top prize with the same 1.5x safety margin, so a tier is only
-- advertised as live when it is actually payable.
--   100x -> balance >= highest_stake * 100 * 1.5
--   500x -> balance >= highest_stake * 500 * 1.5
--
-- Column is APPENDED, which is what CREATE OR REPLACE VIEW permits; existing
-- readers of club_id / can_draw_100x are unaffected.
--
-- Found by the phantom-column CI gate once 46 false positives stopped burying
-- it. Applied to production 2026-08-21 via the Supabase MCP.

CREATE OR REPLACE VIEW public.v_spin_tier_availability AS
  SELECT
    club_id,
    balance >= (highest_stake * 100::numeric * 1.5) AS can_draw_100x,
    balance >= (highest_stake * 500::numeric * 1.5) AS can_draw_500x
  FROM spin_bonus_pools p;

DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name  = 'v_spin_tier_availability'
    AND column_name IN ('club_id', 'can_draw_100x', 'can_draw_500x');

  IF n <> 3 THEN
    RAISE EXCEPTION
      'v_spin_tier_availability must expose club_id, can_draw_100x and can_draw_500x; found % of 3', n;
  END IF;
END
$$;

-- ROLLBACK
-- A plain CREATE OR REPLACE cannot DROP the appended column, so a rollback is
--   DROP VIEW public.v_spin_tier_availability;
--   CREATE VIEW public.v_spin_tier_availability AS
--     SELECT club_id,
--            balance >= (highest_stake * 100::numeric * 1.5) AS can_draw_100x
--     FROM spin_bonus_pools p;
-- and every reader of can_draw_500x must be reverted in the same change.
