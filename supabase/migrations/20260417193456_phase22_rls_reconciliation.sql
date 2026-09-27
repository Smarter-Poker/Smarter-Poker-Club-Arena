-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417193456 "phase22_rls_reconciliation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 53144c0de74828fbb34ca6547b05c4aa of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — RLS reconciliation
--  -----------------------------------------------------------------------
--  Closes three RLS gaps found by the systematic home-games schema audit.
--  None of them affect production traffic (Table Tablet flow is unimplemented;
--  reviews + posts tables both have 0 rows; only commander_home_seats has
--  9 test fixture rows in 1 game), but all three would leak/accept anon
--  writes if exploited today.
--
--  GAP 1 — commander_home_seats has RLS disabled + 0 policies
--    anon currently has SELECT/INSERT/UPDATE/DELETE/TRUNCATE on this table.
--    Any internet user could read all seat assignments, insert fakes, or
--    truncate the whole table. FIX: enable RLS + add scoped policies
--    matching the seating flow (host writes, members read, seated user
--    can toggle their own row).
--
--  GAP 2 — commander_home_game_reviews has a wildcard catch-all policy
--    `patch_maintain_access` uses `using=true` + `with_check=true` for ALL
--    commands, which effectively negates RLS on this table for every role
--    (including anon). Any internet user could read, write, or delete any
--    review. Table is empty today so no historical leak. FIX: drop the
--    wildcard, add scoped reviewer-ownership policies.
--
--  GAP 3 — commander_home_posts.home_posts_select uses `using=true`
--    Public-readable on an empty, unused table. Harmless today but will
--    leak if the table gets used later. FIX: replace with a membership-
--    scoped SELECT. Writes stay blocked (no write policies exist yet;
--    we'll add them when the feature lands).
--
--  All policies use the standard supabase RLS pattern; service_role
--  still bypasses (automatic, via BYPASSRLS on the service role).
-- =========================================================================


-- ─── GAP 1: commander_home_seats ───────────────────────────────────────
ALTER TABLE commander_home_seats ENABLE ROW LEVEL SECURITY;

-- Read: host of the game, group owner, approved group member, or the
-- user themselves (if seated)
CREATE POLICY home_seats_select ON commander_home_seats
    FOR SELECT
    USING (
        user_id = auth.uid()
        OR game_id IN (
            SELECT id FROM commander_home_games WHERE host_id = auth.uid()
        )
        OR game_id IN (
            SELECT hg.id
              FROM commander_home_games hg
              JOIN commander_home_groups g ON g.id = hg.group_id
             WHERE g.owner_id = auth.uid()
        )
        OR game_id IN (
            SELECT hg.id
              FROM commander_home_games hg
              JOIN commander_home_members m ON m.group_id = hg.group_id
             WHERE m.user_id = auth.uid()
               AND m.status  = 'approved'
        )
    );

-- Insert: only the game host or the group owner can lay out seats
CREATE POLICY home_seats_insert ON commander_home_seats
    FOR INSERT
    WITH CHECK (
        game_id IN (
            SELECT id FROM commander_home_games WHERE host_id = auth.uid()
        )
        OR game_id IN (
            SELECT hg.id
              FROM commander_home_games hg
              JOIN commander_home_groups g ON g.id = hg.group_id
             WHERE g.owner_id = auth.uid()
        )
    );

-- Update: host, group owner, or the seated user (so a player can mark
-- themselves "away" without the host intervening)
CREATE POLICY home_seats_update ON commander_home_seats
    FOR UPDATE
    USING (
        user_id = auth.uid()
        OR game_id IN (
            SELECT id FROM commander_home_games WHERE host_id = auth.uid()
        )
        OR game_id IN (
            SELECT hg.id
              FROM commander_home_games hg
              JOIN commander_home_groups g ON g.id = hg.group_id
             WHERE g.owner_id = auth.uid()
        )
    );

-- Delete: host or group owner only
CREATE POLICY home_seats_delete ON commander_home_seats
    FOR DELETE
    USING (
        game_id IN (
            SELECT id FROM commander_home_games WHERE host_id = auth.uid()
        )
        OR game_id IN (
            SELECT hg.id
              FROM commander_home_games hg
              JOIN commander_home_groups g ON g.id = hg.group_id
             WHERE g.owner_id = auth.uid()
        )
    );


-- ─── GAP 2: commander_home_game_reviews ────────────────────────────────
DROP POLICY IF EXISTS patch_maintain_access ON commander_home_game_reviews;

-- Read: reviewer themselves, host of game, group owner, approved member
CREATE POLICY home_game_reviews_select ON commander_home_game_reviews
    FOR SELECT
    USING (
        reviewer_id = auth.uid()
        OR game_id IN (
            SELECT id FROM commander_home_games WHERE host_id = auth.uid()
        )
        OR game_id IN (
            SELECT hg.id
              FROM commander_home_games hg
              JOIN commander_home_groups g ON g.id = hg.group_id
             WHERE g.owner_id = auth.uid()
        )
        OR game_id IN (
            SELECT hg.id
              FROM commander_home_games hg
              JOIN commander_home_members m ON m.group_id = hg.group_id
             WHERE m.user_id = auth.uid()
               AND m.status  = 'approved'
        )
    );

-- Insert: only the reviewer themselves, and they must have been an
-- approved member of the group whose game they're reviewing
CREATE POLICY home_game_reviews_insert ON commander_home_game_reviews
    FOR INSERT
    WITH CHECK (
        reviewer_id = auth.uid()
        AND game_id IN (
            SELECT hg.id
              FROM commander_home_games hg
              JOIN commander_home_members m ON m.group_id = hg.group_id
             WHERE m.user_id = auth.uid()
               AND m.status  = 'approved'
        )
    );

-- Update: reviewer only, and only their own row
CREATE POLICY home_game_reviews_update ON commander_home_game_reviews
    FOR UPDATE
    USING       (reviewer_id = auth.uid())
    WITH CHECK  (reviewer_id = auth.uid());

-- Delete: reviewer OR the game host (host moderation)
CREATE POLICY home_game_reviews_delete ON commander_home_game_reviews
    FOR DELETE
    USING (
        reviewer_id = auth.uid()
        OR game_id IN (
            SELECT id FROM commander_home_games WHERE host_id = auth.uid()
        )
    );


-- ─── GAP 3: commander_home_posts ───────────────────────────────────────
DROP POLICY IF EXISTS home_posts_select ON commander_home_posts;

-- Scope SELECT to approved members or host/owner. Table is unused today;
-- no write policies yet (writes are denied by default with RLS on).
CREATE POLICY home_posts_select ON commander_home_posts
    FOR SELECT
    USING (
        group_id IN (
            SELECT id FROM commander_home_groups
             WHERE owner_id = auth.uid()
                OR NOT is_private   -- anyone may read posts in a public group
        )
        OR group_id IN (
            SELECT group_id FROM commander_home_members
             WHERE user_id = auth.uid() AND status = 'approved'
        )
    );

NOTIFY pgrst, 'reload schema';
