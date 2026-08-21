DROP VIEW IF EXISTS public.v_spin_tier_availability;

CREATE VIEW public.v_spin_tier_availability AS
SELECT
  p.club_id,
  (p.balance >= p.highest_stake * 100::numeric * 1.5) AS can_draw_100x
FROM public.spin_bonus_pools p;

COMMENT ON VIEW public.v_spin_tier_availability IS
  'Public, balance-hiding availability of the TOP spin tier (100x). One boolean per club and nothing that lets a reader recover the reserve balance. can_draw_500x was dropped 2026-08-21 when the 500x tier was retired.';

REVOKE ALL ON public.v_spin_tier_availability FROM PUBLIC;
GRANT SELECT ON public.v_spin_tier_availability TO authenticated, anon, service_role;
