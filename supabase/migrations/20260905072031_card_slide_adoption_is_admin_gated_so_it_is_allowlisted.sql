-- 20260905072031_card_slide_adoption_is_admin_gated_so_it_is_allowlisted.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CARD SLIDE ADOPTION IS ADMIN-GATED, SO IT IS ALLOWLISTED, NOT REVOKED
-- (2026-09-05)
--
-- `Telemetry Exposure` went red on every branch, because it asks PRODUCTION
-- what a browser can reach rather than reading the diff. The single open
-- routine was `fn_card_slide_adoption(p_days integer)`, which arrived with the
-- card presentation engine (#3072) and is executable by `authenticated`.
--
-- WHY THE ALLOWLIST AND NOT A REVOKE. The check flags a routine that is
-- SECURITY DEFINER, takes no identity argument, and is reachable by a browser -
-- a good heuristic, and here the premise behind it is false. The function's
-- first two statements ARE an identity check:
--
--     v_caller uuid := auth.uid();
--     IF v_caller IS NULL THEN RETURN; END IF;
--     IF NOT public.fn_is_platform_admin() THEN RETURN; ...
--
-- and its own comment says why it answers empty rather than raising: "an
-- authenticated non-admin opening an admin panel is a UI state, not an
-- incident." A routine written to be opened from an admin panel in a browser,
-- which returns nothing to everyone else, is precisely what
-- `ca_browser_definer_allowlist` is for. Revoking it would close a door that
-- was built on purpose and leave the panel silently empty for admins too.
--
-- Not mine, and fixed anyway: CLAUDE.md section 5 rule 8 - "If you find main
-- already red, fixing it comes before your own work. You cannot ship past it
-- anyway."
--
-- Idempotent: the allowlist has no unique constraint on proname, so the insert
-- is guarded by NOT EXISTS rather than ON CONFLICT.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

INSERT INTO public.ca_browser_definer_allowlist (proname, reason)
SELECT
  'fn_card_slide_adoption',
  'Card-slide adoption telemetry for the admin panel. SECURITY DEFINER with no '
  || 'identity ARGUMENT, but it reads the identity itself: it returns immediately '
  || 'when auth.uid() is null and again when fn_is_platform_admin() is false, so a '
  || 'non-admin browser gets an empty result rather than platform data. Reachable '
  || 'from a browser on purpose - it backs an admin panel - which is why this is '
  || 'allowlisted rather than revoked (2026-09-05).'
WHERE NOT EXISTS (
  SELECT 1 FROM public.ca_browser_definer_allowlist WHERE proname = 'fn_card_slide_adoption'
);

-- The gate this migration exists to satisfy: nothing unaccounted may remain.
DO $$
DECLARE v_open int; v_names text;
BEGIN
  SELECT count(*), coalesce(string_agg(proname, ', '), '')
    INTO v_open, v_names
    FROM public.fn_ca_browser_reachable_telemetry();
  IF v_open <> 0 THEN
    RAISE EXCEPTION
      'telemetry exposure is still open for % routine(s): %. Each one is either '
      'revoked from anon/authenticated or allowlisted with a written reason.',
      v_open, v_names;
  END IF;
END $$;

-- And the routine really is gated, so the allowlist entry is not a shortcut.
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_card_slide_adoption';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_card_slide_adoption does not exist - do not allowlist a routine that is not there';
  END IF;
  IF position('fn_is_platform_admin' IN v_src) = 0 THEN
    RAISE EXCEPTION
      'fn_card_slide_adoption no longer gates on fn_is_platform_admin - the reason this '
      'row gives is no longer true, so revoke the routine instead of allowlisting it';
  END IF;
END $$;

COMMIT;
