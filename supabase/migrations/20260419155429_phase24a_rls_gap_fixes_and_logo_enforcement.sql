-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419155429 "phase24a_rls_gap_fixes_and_logo_enforcement"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 80625d9b758befe64e9aefbb31cd01ba of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART A — Critical RLS + schema fixes
--  -----------------------------------------------------------------------
--  P0.2: commander_home_posts missing INSERT/UPDATE/DELETE RLS policies
--  P0.3: commander_home_members SELECT is self-only; hosts can't read group
--  P0.4: Phase 17 logo requirement not enforced at DB level
-- =========================================================================

-- ────────────────────────────────────────────────────────────────────────
-- P0.2: commander_home_posts — add INSERT/UPDATE/DELETE policies
-- ────────────────────────────────────────────────────────────────────────

-- INSERT: approved members can post (RPC also enforces; this adds defense in depth)
CREATE POLICY home_posts_insert ON commander_home_posts
  FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND (
      group_id IN (SELECT id FROM commander_home_groups WHERE owner_id = auth.uid())
      OR group_id IN (
          SELECT group_id FROM commander_home_members
           WHERE user_id = auth.uid() AND status = 'approved'
      )
    )
  );

-- UPDATE: author edits own post; owner/admin can edit any post in their group
CREATE POLICY home_posts_update ON commander_home_posts
  FOR UPDATE TO authenticated
  USING (
    author_id = auth.uid()
    OR group_id IN (SELECT id FROM commander_home_groups WHERE owner_id = auth.uid())
    OR group_id IN (
        SELECT group_id FROM commander_home_members
         WHERE user_id = auth.uid() AND role = 'admin' AND status = 'approved'
    )
  )
  WITH CHECK (
    author_id = auth.uid()
    OR group_id IN (SELECT id FROM commander_home_groups WHERE owner_id = auth.uid())
    OR group_id IN (
        SELECT group_id FROM commander_home_members
         WHERE user_id = auth.uid() AND role = 'admin' AND status = 'approved'
    )
  );

-- DELETE: author deletes own post; owner/admin can moderate-delete
CREATE POLICY home_posts_delete ON commander_home_posts
  FOR DELETE TO authenticated
  USING (
    author_id = auth.uid()
    OR group_id IN (SELECT id FROM commander_home_groups WHERE owner_id = auth.uid())
    OR group_id IN (
        SELECT group_id FROM commander_home_members
         WHERE user_id = auth.uid() AND role = 'admin' AND status = 'approved'
    )
  );

-- ────────────────────────────────────────────────────────────────────────
-- P0.3: commander_home_members — add host-sees-group-members SELECT policy
-- The existing "Enable users to view their own data only" restricts to self.
-- Add a second policy so owners + admins can read all members of their groups.
-- Postgres OR-combines multiple policies for the same cmd (any match = grant).
-- ────────────────────────────────────────────────────────────────────────

CREATE POLICY home_members_host_sees_group ON commander_home_members
  FOR SELECT TO authenticated
  USING (
    -- Group owner can see all members of their group
    group_id IN (SELECT id FROM commander_home_groups WHERE owner_id = auth.uid())
    OR
    -- Approved admin can see all members of their group
    group_id IN (
        SELECT group_id FROM commander_home_members m2
         WHERE m2.user_id = auth.uid() 
           AND m2.role = 'admin' 
           AND m2.status = 'approved'
    )
    OR
    -- Any approved member can see the membership roster of their own group
    -- (needed for "who's in this group" display; pending/declined/banned still hidden)
    (
      status = 'approved'
      AND group_id IN (
          SELECT group_id FROM commander_home_members m3
           WHERE m3.user_id = auth.uid() AND m3.status = 'approved'
      )
    )
  );

-- ────────────────────────────────────────────────────────────────────────
-- P0.4: Phase 17 hard logo requirement — enforce at DB level for NEW inserts
-- Grandfathers the 2 existing legacy rows (is_private=true|false with NULL logo).
-- Once backfilled, switch to full NOT NULL.
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_home_group_logo_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
    IF NEW.profile_photo_url IS NULL OR trim(NEW.profile_photo_url) = '' THEN
        RAISE EXCEPTION 'PROFILE_PHOTO_REQUIRED' 
              USING HINT = 'home groups must have a logo (Phase 17 requirement)',
                    ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_enforce_home_group_logo
    BEFORE INSERT ON commander_home_groups
    FOR EACH ROW 
    EXECUTE FUNCTION public.enforce_home_group_logo_on_insert();

COMMENT ON FUNCTION public.enforce_home_group_logo_on_insert() IS
  'Phase 24 / P0.4: enforces Phase 17 hard logo requirement at DB level for new groups. Existing rows grandfathered until backfill.';

COMMENT ON TRIGGER trg_enforce_home_group_logo ON commander_home_groups IS
  'Phase 24: rejects new home groups created without a profile_photo_url. Pairs with P8.1 logo backfill TODO for legacy rows.';
