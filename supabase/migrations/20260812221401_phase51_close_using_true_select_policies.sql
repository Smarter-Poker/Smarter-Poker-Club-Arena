-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812221401 "phase51_close_using_true_select_policies"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3a3b87d77cfdcaa5bfdcc09b30ecc840 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Phase 51 — Replace six blanket `USING (true)` SELECT policies
--
-- WHY: 20260520000003_consolidate_permissive_policies.sql "consolidated"
-- several visibility-aware SELECT policies into unconditional ones. Postgres
-- OR-combines PERMISSIVE policies, so any correct policy sitting alongside a
-- `USING (true)` policy is a no-op. Net effect: every row of these tables is
-- readable directly through PostgREST with the public anon key.
--
-- CONCRETE EXPOSURE CLOSED HERE:
--   social_page_posts   - posts with visibility='private', AND posts with
--                         is_approved=false, i.e. content sitting in the
--                         moderation queue, were publicly readable.
--   social_page_reviews - unpublished reviews were publicly readable.
--   social_pages        - pages with is_public=false were publicly readable.
--   home_game_vouches   - anonymous enumeration of probable members of
--                         PRIVATE home groups.
--   commander_post_comments   - comments readable regardless of whether the
--                         parent post is visible to the caller.
--   commander_venue_followers - full follower lists enumerable by anyone.
--
-- BLAST-RADIUS CHECK (done before writing this migration):
--   * social_page_posts / social_page_reviews / home_game_vouches /
--     commander_post_comments / commander_venue_followers have ZERO
--     client-side reads - they are reached only through service-role API
--     routes, which bypass RLS entirely and are therefore unaffected.
--   * social_pages has server-side readers (sitemap, /hub/home-games/in/**)
--     which use SERVICE_ROLE_KEY and already filter is_public=true, plus one
--     client-side reader (commander manage.js) where the caller is the page
--     owner - covered by the owner_id branch below.
--
-- Idempotent and re-runnable. Tier 3. ROLLBACK at the bottom.
-- =====================================================================

-- ---------- PRE-FLIGHT ----------
DO $$
DECLARE
    v_missing text := '';
BEGIN
    IF to_regclass('public.social_pages')              IS NULL THEN v_missing := v_missing||'social_pages '; END IF;
    IF to_regclass('public.social_page_posts')         IS NULL THEN v_missing := v_missing||'social_page_posts '; END IF;
    IF to_regclass('public.social_page_reviews')       IS NULL THEN v_missing := v_missing||'social_page_reviews '; END IF;
    IF to_regclass('public.home_game_vouches')         IS NULL THEN v_missing := v_missing||'home_game_vouches '; END IF;
    IF to_regclass('public.commander_post_comments')   IS NULL THEN v_missing := v_missing||'commander_post_comments '; END IF;
    IF to_regclass('public.commander_venue_followers') IS NULL THEN v_missing := v_missing||'commander_venue_followers '; END IF;
    IF v_missing <> '' THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAILED: missing tables: %', v_missing;
    END IF;
END $$;

-- =====================================================================
-- 1. social_pages : public pages, or your own
-- =====================================================================
DROP POLICY IF EXISTS "social_pages_read" ON public.social_pages;
CREATE POLICY "social_pages_read"
    ON public.social_pages FOR SELECT
    USING (
        COALESCE(is_public, false) = true
        OR owner_id = (SELECT auth.uid())
    );

-- =====================================================================
-- 2. social_page_posts : approved + public visibility + on a visible page,
--    or your own authored post.
--    NOTE: the EXISTS is evaluated under the caller's own RLS context, so it
--    composes with policy 1 above - a post on a non-public page is only
--    visible to that page's owner.
-- =====================================================================
DROP POLICY IF EXISTS "social_page_posts_read" ON public.social_page_posts;
CREATE POLICY "social_page_posts_read"
    ON public.social_page_posts FOR SELECT
    USING (
        author_id = (SELECT auth.uid())
        OR (
            COALESCE(is_approved, false) = true
            AND COALESCE(visibility, 'public') = 'public'
            AND EXISTS (
                SELECT 1 FROM public.social_pages sp
                WHERE sp.id = social_page_posts.page_id
            )
        )
    );

-- =====================================================================
-- 3. social_page_reviews : published reviews on visible pages, or your own
-- =====================================================================
DROP POLICY IF EXISTS "social_page_reviews_read" ON public.social_page_reviews;
CREATE POLICY "social_page_reviews_read"
    ON public.social_page_reviews FOR SELECT
    USING (
        reviewer_id = (SELECT auth.uid())
        OR (
            COALESCE(is_published, false) = true
            AND EXISTS (
                SELECT 1 FROM public.social_pages sp
                WHERE sp.id = social_page_reviews.page_id
            )
        )
    );

-- =====================================================================
-- 4. home_game_vouches : vouches on NON-private groups, your own vouch, or
--    vouches on a group you are staff of.
--    Closes anonymous membership enumeration of private home groups.
-- =====================================================================
DROP POLICY IF EXISTS "Anyone can read vouches" ON public.home_game_vouches;
DROP POLICY IF EXISTS "home_game_vouches_read"  ON public.home_game_vouches;
CREATE POLICY "home_game_vouches_read"
    ON public.home_game_vouches FOR SELECT
    USING (
        user_id = (SELECT auth.uid())
        OR fn_home_is_group_staff((SELECT auth.uid()), group_id)
        OR EXISTS (
            SELECT 1 FROM public.commander_home_groups g
            WHERE g.id = home_game_vouches.group_id
              AND COALESCE(g.is_private, false) = false
        )
    );

-- =====================================================================
-- 5. commander_post_comments : visible iff the PARENT POST is visible.
--    commander_home_posts already carries a correct membership/visibility
--    policy, and the EXISTS below inherits it under the caller's context.
-- =====================================================================
DROP POLICY IF EXISTS "Public read comments"          ON public.commander_post_comments;
DROP POLICY IF EXISTS "commander_post_comments_read"  ON public.commander_post_comments;
CREATE POLICY "commander_post_comments_read"
    ON public.commander_post_comments FOR SELECT
    USING (
        user_id = (SELECT auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.commander_home_posts p
            WHERE p.id = commander_post_comments.post_id
        )
    );

-- =====================================================================
-- 6. commander_venue_followers : own follow rows only.
--    Public follower COUNTS must be served by the service-role API routes
--    (they already are); the raw follower list is not public data.
-- =====================================================================
DROP POLICY IF EXISTS "Public read venue followers count"  ON public.commander_venue_followers;
DROP POLICY IF EXISTS "commander_venue_followers_read"     ON public.commander_venue_followers;
CREATE POLICY "commander_venue_followers_read"
    ON public.commander_venue_followers FOR SELECT
    USING ( user_id = (SELECT auth.uid()) );

-- ---------- POST-APPLY ASSERTIONS ----------
DO $$
DECLARE
    v_blanket int;
    r         record;
BEGIN
    SELECT COUNT(*) INTO v_blanket
    FROM pg_policies
    WHERE schemaname='public' AND cmd='SELECT' AND qual='true'
      AND tablename IN ('social_pages','social_page_posts','social_page_reviews',
                        'home_game_vouches','commander_post_comments','commander_venue_followers');

    IF v_blanket > 0 THEN
        RAISE EXCEPTION 'POST-APPLY FAILED: % blanket USING(true) SELECT policies remain', v_blanket;
    END IF;

    FOR r IN SELECT unnest(ARRAY['social_pages','social_page_posts','social_page_reviews',
                                 'home_game_vouches','commander_post_comments',
                                 'commander_venue_followers']) AS t
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE schemaname='public' AND tablename=r.t AND cmd='SELECT') THEN
            RAISE EXCEPTION 'POST-APPLY FAILED: % has RLS but NO SELECT policy - it would return nothing', r.t;
        END IF;
    END LOOP;

    RAISE NOTICE 'phase51 OK: 6 blanket SELECT policies replaced with visibility-aware equivalents.';
END $$;

-- =====================================================================
-- ROLLBACK (restores the INSECURE prior state - emergency use only):
--   DROP POLICY IF EXISTS "social_pages_read" ON public.social_pages;
--   CREATE POLICY "social_pages_read" ON public.social_pages FOR SELECT USING (true);
--   DROP POLICY IF EXISTS "social_page_posts_read" ON public.social_page_posts;
--   CREATE POLICY "social_page_posts_read" ON public.social_page_posts FOR SELECT USING (true);
--   DROP POLICY IF EXISTS "social_page_reviews_read" ON public.social_page_reviews;
--   CREATE POLICY "social_page_reviews_read" ON public.social_page_reviews FOR SELECT USING (true);
--   DROP POLICY IF EXISTS "home_game_vouches_read" ON public.home_game_vouches;
--   CREATE POLICY "Anyone can read vouches" ON public.home_game_vouches FOR SELECT USING (true);
--   DROP POLICY IF EXISTS "commander_post_comments_read" ON public.commander_post_comments;
--   CREATE POLICY "Public read comments" ON public.commander_post_comments FOR SELECT USING (true);
--   DROP POLICY IF EXISTS "commander_venue_followers_read" ON public.commander_venue_followers;
--   CREATE POLICY "Public read venue followers count" ON public.commander_venue_followers FOR SELECT USING (true);
-- =====================================================================
