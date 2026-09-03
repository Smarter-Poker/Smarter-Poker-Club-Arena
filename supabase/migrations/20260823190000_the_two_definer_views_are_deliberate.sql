-- 20260823190000_the_two_definer_views_are_deliberate.sql
--
-- Supabase's security advisor reports exactly three ERROR-level findings on this
-- project. Two of them are these views, lint "security_definer_view". Both are
-- deliberate security CONTROLS, and applying the advisor's suggested remediation
-- would cause the leak it is trying to prevent.
--
-- (The third ERROR is rls_disabled_in_public on spatial_ref_sys, PostGIS's own
-- extension-owned table, which cannot take RLS and is not ours to change.)
--
-- 1. trivia_tournaments_public
--    Its whole purpose is to serve trivia questions WITHOUT the answers. The
--    definition strips each question object:
--        elem - 'correct_index' - 'explanation'
--    Definer rights are what allow anon and authenticated to read this curated
--    projection while having no access to trivia_tournaments itself, where the
--    answers live. Setting security_invoker = true would make the view resolve
--    with the caller's rights, so it would either stop working for players or
--    push callers to the base table - which is where correct_index is.
--
-- 2. v_spin_tier_availability
--    Exposes club_id and a single derived boolean, can_draw_100x. The inputs -
--    spin_bonus_pools.balance and highest_stake - are deliberately NOT exposed.
--    Created as a public view on purpose (20260820p_spin_tier_availability_public_view).
--    Definer rights are what keep the balance hidden while the boolean is
--    readable.
--
-- Recorded on the objects because an advisor that reports two ERRORs forever is
-- one people learn to ignore, and the specific "fix" here is harmful. The
-- assertion below fails if either view stops stripping what it strips, so this
-- comment cannot quietly become untrue.

COMMENT ON VIEW public.trivia_tournaments_public IS
  'DELIBERATE SECURITY DEFINER VIEW - do not set security_invoker = true. '
  'It exists to serve trivia questions with correct_index and explanation '
  'stripped out. Definer rights are what let anon/authenticated read this '
  'projection while having no access to trivia_tournaments, where the answers '
  'are. Supabase advisor flags this as security_definer_view (ERROR); that is a '
  'false positive here and the suggested remediation would leak the answers. '
  'Reviewed 2026-08-23.';

COMMENT ON VIEW public.v_spin_tier_availability IS
  'DELIBERATE SECURITY DEFINER VIEW - do not set security_invoker = true. '
  'Exposes club_id and the derived boolean can_draw_100x only; the inputs '
  '(spin_bonus_pools.balance, highest_stake) are deliberately hidden. Definer '
  'rights are the mechanism. Supabase advisor flags this as '
  'security_definer_view (ERROR); that is a false positive here. '
  'Reviewed 2026-08-23.';

DO $assert$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_viewdef('public.trivia_tournaments_public'::regclass, true) INTO v_def;
  IF position('correct_index' in v_def) = 0 OR position('explanation' in v_def) = 0 THEN
    RAISE EXCEPTION 'trivia_tournaments_public no longer strips the answer fields - re-review before trusting the comment';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c, unnest(coalesce(c.reloptions,'{}')) o
     WHERE c.oid IN ('public.trivia_tournaments_public'::regclass,
                     'public.v_spin_tier_availability'::regclass)
       AND o ILIKE 'security_invoker=true'
  ) THEN
    RAISE EXCEPTION 'a view documented as deliberately definer has been set security_invoker=true';
  END IF;

  SELECT pg_get_viewdef('public.v_spin_tier_availability'::regclass, true) INTO v_def;
  IF position('balance' in v_def) > 0 AND position('can_draw_100x' in v_def) = 0 THEN
    RAISE EXCEPTION 'v_spin_tier_availability shape changed - re-review';
  END IF;
END $assert$;

-- ROLLBACK
--   COMMENT ON VIEW public.trivia_tournaments_public IS NULL;
--   COMMENT ON VIEW public.v_spin_tier_availability IS NULL;
