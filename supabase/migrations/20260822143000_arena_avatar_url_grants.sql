-- ═══════════════════════════════════════════════════════════════════════════
-- arena_avatar_url — restore the column privileges the ALTER TABLE never gave it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SYMPTOM (Dan, 2026-08-22): the profile orb in the Club Arena global header
-- renders the bare placeholder glyph instead of the player's avatar, on every
-- page, for every account.
--
-- CAUSE: `public.profiles` is not granted at the TABLE level. A prior security
-- lockdown replaced `GRANT SELECT ON profiles` with a per-column grant list so
-- that email / phone / stripe_customer_id stop being readable by the
-- `authenticated` role. Column-level grants do not extend to columns added
-- later, and `20260822_arena_avatar_column.sql` added `arena_avatar_url`
-- earlier the same day with no GRANT beside it.
--
-- So every client read of that column returns 42501 (PostgREST 403), not a
-- null row. In useHeaderDataStore.loadOnce the avatar is fetched inside a
-- Promise.all beside the notification and message counts, so the rejection
-- takes all three down: avatarUrl stays null (placeholder orb) and the badge
-- counts never refresh either. The same 403 hits ~40 other client queries in
-- this repo that select `avatar_url:arena_avatar_url` — seats, friends,
-- leaderboards, tournament chip counts, player search.
--
-- UPDATE is missing for the same reason, which is why equipping an avatar in
-- AvatarGenerator/AvatarGallery silently fails to persist.
--
-- SAFETY: `arena_avatar_url` holds a path to public avatar art
-- (/avatars/table/*.webp). It is not PII, and this grant does not touch the
-- columns the lockdown deliberately withheld. Row scoping is unchanged: the
-- `profiles_update` RLS policy still limits writes to `auth.uid() = id`, and
-- fn_guard_profile_privileged_columns guards only the diamond/VIP columns.
--
-- ROLLBACK:
--   REVOKE SELECT (arena_avatar_url) ON public.profiles FROM authenticated;
--   REVOKE UPDATE (arena_avatar_url) ON public.profiles FROM authenticated;

BEGIN;

GRANT SELECT (arena_avatar_url) ON public.profiles TO authenticated;
GRANT UPDATE (arena_avatar_url) ON public.profiles TO authenticated;

-- Post-apply assertions: fail the migration rather than report a false success.
DO $$
DECLARE
    v_select boolean;
    v_update boolean;
BEGIN
    SELECT has_column_privilege('authenticated', 'public.profiles', 'arena_avatar_url', 'SELECT'),
           has_column_privilege('authenticated', 'public.profiles', 'arena_avatar_url', 'UPDATE')
      INTO v_select, v_update;

    IF NOT v_select THEN
        RAISE EXCEPTION 'authenticated still cannot SELECT profiles.arena_avatar_url';
    END IF;
    IF NOT v_update THEN
        RAISE EXCEPTION 'authenticated still cannot UPDATE profiles.arena_avatar_url';
    END IF;

    -- The lockdown must stay locked down.
    IF has_column_privilege('authenticated', 'public.profiles', 'email', 'SELECT')
       OR has_column_privilege('authenticated', 'public.profiles', 'stripe_customer_id', 'SELECT') THEN
        RAISE EXCEPTION 'PII columns became readable — this migration must not widen the grant list';
    END IF;
END $$;

COMMIT;
