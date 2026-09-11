-- ═══════════════════════════════════════════════════════════════════════════
--  THE PIVOT THE PAGE SHOWS IS THE PIVOT THE BANK APPLIES
--  BBJ programme, the sweep after phase 5 (2026-09-11)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every raked hand's drop is split three ways, and `fn_bbj_allocate` reads the
-- split from ONE authority: `ca_bbj_policy` row 1. Below the pivot a drop is
-- 50% main / 25% backup / 25% promo; at or above 100,000 in main it becomes
-- 25 / 25 / 50. Dan's ruling, 2026-08-18.
--
-- That number is written down in FOUR places and nothing checks that they
-- agree:
--
--   1. `ca_bbj_policy`                      the authority - read on every hand
--   2. server/src/config/RakeConfig.ts      BBJ_PIVOT_THRESHOLD = 100000
--   3. src/config/RakeConfig.ts             the same three constants, no reader
--   4. src/pages/BadBeatJackpotPage.tsx     bare literals 80000 and 100000, in
--                                           a banner every player can see
--
-- Nobody has been hurt by that yet because nothing has changed. It is about to
-- matter. Measured today:
--
--   pool                  main       main/day    reaches 80k   reaches 100k
--   Midway Union          52,376.70  3,614.80    7.6 days      13.2 days
--   Deep Stack Society    19,421.59  3,696.01    16.4 days     21.8 days
--
-- So in about a week the platform's largest pool starts showing a banner built
-- on a literal, and about a week after that the allocation actually changes.
-- `ca_bbj_policy` is a table - a single UPDATE moves the real threshold, with
-- no migration and no test anywhere that would notice - and the page would go
-- on counting toward a number the bank had stopped using.
--
-- This is the same defect this sweep has been fixing all evening: a surface
-- stating a rule the engine may not be applying. The fix is the same one: give
-- the surface the authority to read, instead of a copy to drift from.
--
-- ── WHY A FUNCTION AND NOT A GRANT ────────────────────────────────────────
--
-- `ca_bbj_policy` has RLS on, zero policies, and no SELECT for `anon` or
-- `authenticated` - which is why a constant was mirrored into TypeScript in
-- the first place. Opening the table would expose a writable-shaped surface
-- for one read. A SECURITY DEFINER reader returning jsonb exposes exactly the
-- published rule and nothing else.
--
-- It returns jsonb rather than a TABLE deliberately: an unscoped set-returning
-- definer reachable from a browser is the shape `check-definer-authorization`
-- refuses, and this one has no scope to take - it is one platform-wide policy.
--
-- The allocation rule is not private. It is how a jackpot a player contributes
-- to is divided, and the player-facing page already tries to show it. What is
-- private is a club's own rake RATE, which phase 3 gated and which is not
-- here. Pre-login roles still hold nothing: a signed-out visitor has no
-- jackpot page to read it on.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_bbj_allocation_policy()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  /* Promo is the REMAINDER in fn_bbj_allocate - it is never stored as a rate,
     because storing it would let the three drift out of summing to the drop.
     Derived the same way here, so this function cannot describe a split the
     allocator would not produce. */
  SELECT jsonb_build_object(
           'pivot_threshold',  p.pivot_threshold,
           'standard_main',    p.standard_main,
           'standard_backup',  p.standard_backup,
           'standard_promo',   round(1 - p.standard_main - p.standard_backup, 4),
           'pivot_main',       p.pivot_main,
           'pivot_backup',     p.pivot_backup,
           'pivot_promo',      round(1 - p.pivot_main - p.pivot_backup, 4)
         )
    FROM public.ca_bbj_policy p
   WHERE p.id = 1;
$function$;

COMMENT ON FUNCTION public.fn_bbj_allocation_policy() IS
  'The jackpot allocation rule as the ALLOCATOR reads it: ca_bbj_policy row 1, '
  'with promo derived as the remainder exactly as fn_bbj_allocate derives it. '
  'Exists so a player-facing surface reads the authority instead of a constant '
  'mirrored from it. The threshold was typed as a literal in two configs and '
  'twice more in the jackpot page banner, with nothing checking they agreed.';

REVOKE ALL ON FUNCTION public.fn_bbj_allocation_policy() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_allocation_policy() TO authenticated, service_role;

DO $$
DECLARE v jsonb;
BEGIN
  v := public.fn_bbj_allocation_policy();
  IF v IS NULL THEN
    RAISE EXCEPTION 'ca_bbj_policy row 1 is missing - the allocator has no rule to read';
  END IF;

  /* The three shares must re-sum to the whole drop on BOTH sides of the pivot,
     or this function would publish a split that loses or invents chips. */
  IF (v->>'standard_main')::numeric + (v->>'standard_backup')::numeric
       + (v->>'standard_promo')::numeric <> 1 THEN
    RAISE EXCEPTION 'the standard split does not sum to the drop: %', v;
  END IF;
  IF (v->>'pivot_main')::numeric + (v->>'pivot_backup')::numeric
       + (v->>'pivot_promo')::numeric <> 1 THEN
    RAISE EXCEPTION 'the pivot split does not sum to the drop: %', v;
  END IF;

  /* What it publishes must be what the allocator actually produces. Asked of
     fn_bbj_allocate itself rather than of the table, on 10,000.00 either side
     of the threshold, so a future change to the allocator that stops reading
     the policy is caught here rather than on a felt. */
  IF (SELECT a.main_portion FROM public.fn_bbj_allocate(10000, 0) a)
       <> 10000 * (v->>'standard_main')::numeric THEN
    RAISE EXCEPTION 'below the pivot the allocator disagrees with the published policy';
  END IF;
  IF (SELECT a.main_portion
        FROM public.fn_bbj_allocate(10000, (v->>'pivot_threshold')::numeric) a)
       <> 10000 * (v->>'pivot_main')::numeric THEN
    RAISE EXCEPTION 'at the pivot the allocator disagrees with the published policy';
  END IF;

  IF has_function_privilege('anon', 'public.fn_bbj_allocation_policy()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon still holds EXECUTE on the allocation policy read';
  END IF;
END $$;

COMMIT;
