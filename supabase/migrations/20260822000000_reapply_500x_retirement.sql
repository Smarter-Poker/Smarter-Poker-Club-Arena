-- Re-apply view change to remove can_draw_500x which was accidentally reverted in production

DROP VIEW IF EXISTS public.v_spin_tier_availability;

CREATE VIEW public.v_spin_tier_availability AS
SELECT
  p.club_id,
  (p.balance >= p.highest_stake * 100::numeric * 1.5) AS can_draw_100x
FROM public.spin_bonus_pools p;

COMMENT ON VIEW public.v_spin_tier_availability IS
  'Public, balance-hiding availability of the TOP spin tier (100x).';

REVOKE ALL ON public.v_spin_tier_availability FROM PUBLIC;
GRANT SELECT ON public.v_spin_tier_availability TO authenticated, anon, service_role;
