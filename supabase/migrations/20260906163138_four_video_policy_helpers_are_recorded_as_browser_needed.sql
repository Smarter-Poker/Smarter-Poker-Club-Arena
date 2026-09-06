-- ═══════════════════════════════════════════════════════════════════════════
--  A POLICY HELPER IS NOT AN OPERATOR CONSOLE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `check-telemetry-exposure` went red on `main` at 16:29 UTC with four
-- routines, all of which arrived in the 16:14 video/YouTube schema change:
--
--     fn_is_video_library_asset_eligible(p_asset_id uuid)
--     fn_is_video_library_lineage_eligible(uuid, text, text, text, text)
--     legacy_transition_eligible(p_post social_posts)
--     legacy_transition_eligible(p_reel social_reels)
--
-- They meet the check's criteria exactly: SECURITY DEFINER, executable by
-- `anon` and `authenticated`, no identity argument, and they never consult
-- auth.uid(). The check is not wrong.
--
-- THE FIRST REMEDY IT PRINTS WOULD HAVE BEEN AN OUTAGE. Read before writing
-- anything, from pg_policy:
--
--   video_library_videos / video_library_public_read
--     fn_is_video_library_asset_eligible(id)
--
--   social_posts / video_posts_public_select_guard
--     ... legacy_transition_eligible(social_posts.*)
--      OR fn_is_video_library_lineage_eligible(source_asset_id, ...)
--
--   social_reels / video_reels_public_select_guard
--     ... legacy_transition_eligible(social_reels.*)
--      OR fn_is_video_library_lineage_eligible(source_asset_id, ...)
--
-- **All four are RLS policy helpers.** A policy expression is evaluated as the
-- CALLER, so the caller must hold EXECUTE on every function inside it.
-- `REVOKE ... FROM anon, authenticated` on these would make every anonymous
-- and logged-in SELECT of the public video feed fail with "permission denied
-- for function" - the whole social video surface, dark, to close a hole that
-- is not one.
--
-- SECURITY DEFINER is also correct for them rather than incidental: a policy
-- helper that reads the table its own policy protects must not be re-filtered
-- by that policy, or it recurses. That is the standard shape.
--
-- WHAT THEY ACTUALLY EXPOSE. Each takes an identifier the caller already holds
-- and answers one boolean about it - is this asset eligible, is this row's
-- lineage intact, is this a legacy row in transition. There is no roster, no
-- list, no amount, and nothing about any other player. That is the opposite of
-- `fn_bbj_unclaimed_shares()`, which took NO argument and returned every player
-- owed money; that one was closed the same day (20260906153953).
--
-- SO THIS IS AN ALLOWLIST ENTRY, and the allowlist is being used for the thing
-- it exists for - "a definer a browser genuinely needs, with a written reason".
-- The reason names the policy, so a later reader can check it rather than trust
-- it.
--
-- NOT MY PROGRAMME, AND THAT IS SAID OUT LOUD. These four belong to the video
-- library work and landed fifteen minutes before this file. They are recorded
-- here because the check was red on `main` and CLAUDE.md section 8 puts a red
-- main ahead of your own work - not because anybody has decided their final
-- shape. If that programme re-scopes them (a `p_viewer uuid`, or an auth.uid()
-- filter inside), DELETE these four rows in the same change: an allowlist entry
-- outliving its reason is how an allowlist becomes a place to hide things.
--
-- This migration is DATA ONLY. Four INSERTs, no DDL, so it fires no
-- pgrst_ddl_watch and costs no schema reload - which matters at 16:31 today,
-- with the fleet still recovering from 133 reload-triggering statements in the
-- single minute 16:14.
--
-- ROLLBACK:
--   DELETE FROM public.ca_browser_definer_allowlist
--    WHERE proname IN ('fn_is_video_library_asset_eligible',
--                      'fn_is_video_library_lineage_eligible',
--                      'legacy_transition_eligible');

BEGIN;

DO $$
DECLARE
  v_missing text;
BEGIN
  -- Do not record a reason for a function that is not there, and do not record
  -- "a policy calls it" without checking that a policy calls it. Both would be
  -- a fiction written to silence a check, which is the one thing the allowlist
  -- must never hold.
  FOR v_missing IN
    SELECT n FROM unnest(ARRAY[
      'fn_is_video_library_asset_eligible',
      'fn_is_video_library_lineage_eligible',
      'legacy_transition_eligible'
    ]) AS n
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = n
    )
  LOOP
    RAISE EXCEPTION
      'refusing to allowlist %(): it does not exist in public. Re-read this migration.', v_missing;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    WHERE pg_get_expr(pol.polqual, pol.polrelid) ~* 'fn_is_video_library_asset_eligible'
  ) THEN
    RAISE EXCEPTION
      'refusing to allowlist fn_is_video_library_asset_eligible: no RLS policy references it, so the reason below would be untrue';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    WHERE pg_get_expr(pol.polqual, pol.polrelid) ~* 'legacy_transition_eligible'
  ) THEN
    RAISE EXCEPTION
      'refusing to allowlist legacy_transition_eligible: no RLS policy references it';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    WHERE pg_get_expr(pol.polqual, pol.polrelid) ~* 'fn_is_video_library_lineage_eligible'
  ) THEN
    RAISE EXCEPTION
      'refusing to allowlist fn_is_video_library_lineage_eligible: no RLS policy references it';
  END IF;
END $$;

INSERT INTO public.ca_browser_definer_allowlist (proname, reason)
VALUES
  (
    'fn_is_video_library_asset_eligible',
    'RLS policy helper, not a console. Called by policy video_library_public_read on '
    || 'video_library_videos as fn_is_video_library_asset_eligible(id). A policy expression '
    || 'runs as the CALLER, so anon and authenticated must hold EXECUTE or every read of the '
    || 'public video library fails with permission denied. SECURITY DEFINER is required, not '
    || 'incidental: the helper reads the table its own policy protects and would recurse as '
    || 'INVOKER. It takes an asset id the caller already holds and answers one boolean about '
    || 'that asset - no roster, no amounts, nothing about another account. Owned by the video '
    || 'library programme; delete this row if they re-scope it.'
  ),
  (
    'fn_is_video_library_lineage_eligible',
    'RLS policy helper, not a console. Called by policy video_posts_public_select_guard on '
    || 'social_posts and video_reels_public_select_guard on social_reels, against columns of '
    || 'the row being read (source_asset_id, youtube_video_id, canonical_asset_key, '
    || 'publication_key, the playback url). A policy expression runs as the CALLER, so '
    || 'revoking EXECUTE from anon or authenticated takes the whole social video feed offline '
    || 'rather than closing anything. Answers one boolean about a row the caller is already '
    || 'reading. Owned by the video library programme; delete this row if they re-scope it.'
  ),
  (
    'legacy_transition_eligible',
    'RLS policy helper, not a console - both overloads, (p_post social_posts) and '
    || '(p_reel social_reels). Called by video_posts_public_select_guard and '
    || 'video_reels_public_select_guard as legacy_transition_eligible(social_posts.*) / '
    || '(social_reels.*), i.e. on the row already being evaluated, to let rows predating the '
    || 'video-rights transition stay visible. A policy expression runs as the CALLER, so a '
    || 'revoke here darkens the feed instead of closing a hole; there is nothing to read out '
    || 'of it that the caller is not already reading. Owned by the video library programme; '
    || 'delete this row if they re-scope it.'
  )
ON CONFLICT (proname) DO NOTHING;

COMMIT;

-- ── POST-CHECK ─────────────────────────────────────────────────────────────
-- The live judgement function is the same one check-telemetry-exposure reads,
-- so zero here is the same zero CI asks for.
DO $$
DECLARE v_open int;
BEGIN
  SELECT count(*) INTO v_open FROM public.fn_ca_browser_reachable_telemetry();
  IF v_open <> 0 THEN
    RAISE EXCEPTION
      'post-check: % unscoped SECURITY DEFINER routine(s) are still browser-reachable and unrecorded', v_open;
  END IF;
  RAISE NOTICE 'post-check: nothing unscoped is browser-reachable without a written reason';
END $$;
