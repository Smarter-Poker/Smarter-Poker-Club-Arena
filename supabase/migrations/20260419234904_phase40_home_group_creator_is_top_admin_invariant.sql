-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419234904 "phase40_home_group_creator_is_top_admin_invariant"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b549243c5be8a0a4207d9c5e26a2d5e7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40: Home Group Creator = Top Admin (invariant lockdown)
-- See earlier attempt for full rationale.
-- This version folds in:
--   *) Cleanup of IMPOSTER owner rows (existing data drift) — demote to admin
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) DATA REPAIR: demote any role='owner' member row whose user_id does not
-- match the parent group's owner_id. Set to admin (preserves history).
-- ----------------------------------------------------------------------------
UPDATE commander_home_members m
SET role = 'admin',
    joined_at = COALESCE(m.joined_at, now())
FROM commander_home_groups g
WHERE g.id = m.group_id
  AND m.role = 'owner'
  AND m.user_id IS DISTINCT FROM g.owner_id;

-- Sanity: no owner rows should remain that don't match owner_id
DO $$
DECLARE v_n int;
BEGIN
  SELECT COUNT(*) INTO v_n
  FROM commander_home_members m
  JOIN commander_home_groups g ON g.id = m.group_id
  WHERE m.role = 'owner' AND m.user_id IS DISTINCT FROM g.owner_id;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Data repair failed: % imposter owner rows remain', v_n;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- A) owner_id NOT NULL
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'commander_home_groups'
      AND column_name = 'owner_id'
      AND is_nullable = 'YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM commander_home_groups WHERE owner_id IS NULL) THEN
      RAISE EXCEPTION 'Cannot set owner_id NOT NULL: % group(s) have NULL owner_id',
        (SELECT COUNT(*) FROM commander_home_groups WHERE owner_id IS NULL);
    END IF;
    ALTER TABLE commander_home_groups ALTER COLUMN owner_id SET NOT NULL;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- B) Drop the duplicate SET NULL FK on owner_id; keep the CASCADE variant
-- ----------------------------------------------------------------------------
ALTER TABLE commander_home_groups
  DROP CONSTRAINT IF EXISTS fk_commander_home_groups_owner_profile;

-- ----------------------------------------------------------------------------
-- G) Hardened auto_add_group_owner (DO UPDATE, not DO NOTHING)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_add_group_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF NEW.owner_id IS NULL THEN
    RAISE EXCEPTION 'commander_home_groups.owner_id cannot be NULL — '
      'the creator of a home game is always the top admin';
  END IF;

  INSERT INTO commander_home_members (
    group_id, user_id, role, status, joined_at, can_host, is_regular,
    notifications_enabled, notify_announcements, notify_new_games,
    notify_game_reminders, notify_rsvp_updates
  ) VALUES (
    NEW.id, NEW.owner_id, 'owner', 'approved', now(), true, true,
    true, true, true, true, true
  )
  ON CONFLICT (group_id, user_id) DO UPDATE
    SET role = 'owner',
        status = 'approved',
        can_host = true,
        joined_at = COALESCE(commander_home_members.joined_at, now());

  RETURN NEW;
END;
$function$;

-- ----------------------------------------------------------------------------
-- C + D + E) Protect owner's member row from DELETE and hostile UPDATE
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_home_group_owner_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_owner_id uuid;
  v_row      commander_home_members%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;

  SELECT owner_id INTO v_owner_id
  FROM commander_home_groups
  WHERE id = v_row.group_id;

  -- Group deleted in this TX (cascade) → let it through
  IF v_owner_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- Not the owner's row → no protection applies
  IF v_row.user_id IS DISTINCT FROM v_owner_id THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- (C) Block DELETE of owner's member row
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cannot remove the creator from their own home group. '
      'Transfer ownership first (UPDATE commander_home_groups.owner_id).'
      USING ERRCODE = '42501';
  END IF;

  -- (D) Block role demotion on owner's row
  IF TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role THEN
    IF NEW.role <> 'owner' THEN
      RAISE EXCEPTION 'Cannot change role of the group creator. '
        'The creator is always the top admin (role = owner).'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- (E) Block status change on owner's row
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status <> 'approved' THEN
      RAISE EXCEPTION 'Cannot change status of the group creator to %. '
        'The creator is always an approved member.', NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_protect_home_group_owner_membership_del
  ON commander_home_members;
CREATE TRIGGER trg_protect_home_group_owner_membership_del
  BEFORE DELETE ON commander_home_members
  FOR EACH ROW EXECUTE FUNCTION protect_home_group_owner_membership();

DROP TRIGGER IF EXISTS trg_protect_home_group_owner_membership_upd
  ON commander_home_members;
CREATE TRIGGER trg_protect_home_group_owner_membership_upd
  BEFORE UPDATE OF role, status ON commander_home_members
  FOR EACH ROW EXECUTE FUNCTION protect_home_group_owner_membership();

-- ----------------------------------------------------------------------------
-- F) Exactly one 'owner' row per group (partial unique index)
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_commander_home_members_one_owner_per_group
  ON commander_home_members (group_id)
  WHERE role = 'owner';

-- Transaction-end consistency check: the single owner's user_id matches owner_id
CREATE OR REPLACE FUNCTION public.verify_home_group_owner_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_owner_id uuid;
  v_owner_member_user_id uuid;
BEGIN
  SELECT owner_id INTO v_owner_id
  FROM commander_home_groups
  WHERE id = COALESCE(NEW.group_id, OLD.group_id);

  IF v_owner_id IS NULL THEN RETURN NULL; END IF;

  SELECT user_id INTO v_owner_member_user_id
  FROM commander_home_members
  WHERE group_id = COALESCE(NEW.group_id, OLD.group_id)
    AND role = 'owner';

  IF v_owner_member_user_id IS NULL THEN
    RAISE EXCEPTION 'Home group % has no owner-member row. The creator '
      'must always be seated as role=owner.',
      COALESCE(NEW.group_id, OLD.group_id)
      USING ERRCODE = '23514';
  END IF;

  IF v_owner_member_user_id <> v_owner_id THEN
    RAISE EXCEPTION 'Home group % has mismatched ownership: owner_id=% but '
      'the role=owner member row belongs to user %.',
      COALESCE(NEW.group_id, OLD.group_id), v_owner_id, v_owner_member_user_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_verify_home_group_owner_consistency
  ON commander_home_members;
CREATE CONSTRAINT TRIGGER trg_verify_home_group_owner_consistency
  AFTER INSERT OR UPDATE OR DELETE ON commander_home_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_home_group_owner_consistency();

-- ----------------------------------------------------------------------------
-- Documentation
-- ----------------------------------------------------------------------------
COMMENT ON COLUMN commander_home_groups.owner_id IS
  'Phase 40: NOT NULL. The creator is permanently the top admin. Changes '
  'allowed only via ownership transfer. Enforced by trigger '
  'trg_protect_home_group_owner_id and CONSTRAINT TRIGGER '
  'trg_verify_home_group_owner_consistency.';

COMMENT ON TRIGGER trg_protect_home_group_owner_membership_del
  ON commander_home_members IS
  'Phase 40: blocks DELETE of the creator''s member row.';

COMMENT ON TRIGGER trg_protect_home_group_owner_membership_upd
  ON commander_home_members IS
  'Phase 40: blocks role/status changes on the creator''s member row.';
