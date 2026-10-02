-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419235506 "phase40_fix_welcome_member_trigger_schema_drift"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 66d4a0d7f551ba2550e2582a174e5674 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 / Bug #8 — fix fn_welcome_new_approved_member schema drift.
--
-- The trigger references commander_home_posts.data (JSONB) which was never
-- actually added to the schema. Every non-owner member approval has been
-- either silently failing this trigger or being rolled back.
--
-- Fix: (a) add the 'data' JSONB column the trigger was designed to use —
-- it's a universal social-schema extension point (reactions metadata,
-- embed cards, polls payload, etc) and additive is safe.
-- (b) harden the trigger: wrap the welcome-post INSERT in EXCEPTION
-- so that even a future schema drift can NEVER block a member approval.
-- Welcome posts are nice-to-have. Approvals are critical-path.
-- ============================================================================

-- (a) Additive column, safe
ALTER TABLE commander_home_posts
  ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Helpful index for the dedup lookup the trigger will do
CREATE INDEX IF NOT EXISTS idx_commander_home_posts_welcome_user_id
  ON commander_home_posts ((data->>'welcome_user_id'))
  WHERE post_type = 'announcement';

-- (b) Hardened trigger — never block approval even on unexpected errors
CREATE OR REPLACE FUNCTION public.fn_welcome_new_approved_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_group RECORD;
    v_member_name text;
    v_welcome_exists boolean;
BEGIN
    -- Only fire for transitions into 'approved'
    IF TG_OP = 'INSERT' AND NEW.status <> 'approved' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND (OLD.status = 'approved' OR NEW.status <> 'approved') THEN
      RETURN NEW;
    END IF;

    -- Entire block is defensive: if ANYTHING goes wrong generating the
    -- welcome post, we swallow the error and return NEW so the underlying
    -- member approval still commits. Bug #8 would have become invisible
    -- with this shape regardless of the column existing.
    BEGIN
      SELECT * INTO v_group FROM commander_home_groups WHERE id = NEW.group_id;
      IF v_group.owner_id = NEW.user_id THEN RETURN NEW; END IF;

      SELECT COALESCE(display_name, full_name, username, 'a new member') INTO v_member_name
        FROM profiles WHERE id = NEW.user_id;

      -- Dedup: don't post twice for same user in same group
      SELECT EXISTS(
        SELECT 1 FROM commander_home_posts
          WHERE group_id = NEW.group_id
            AND post_type = 'announcement'
            AND data->>'welcome_user_id' = NEW.user_id::text
      ) INTO v_welcome_exists;
      IF v_welcome_exists THEN RETURN NEW; END IF;

      INSERT INTO commander_home_posts (
        group_id, author_id, post_type, visible_to,
        content, data, is_published, is_pinned
      ) VALUES (
        NEW.group_id, v_group.owner_id, 'announcement', 'members',
        '👋 Everyone welcome ' || v_member_name || ' to ' || v_group.name || '!',
        jsonb_build_object('welcome_user_id', NEW.user_id, 'auto_generated', true),
        true, false
      );
    EXCEPTION
      WHEN OTHERS THEN
        -- Log but do not propagate — approval is the important event
        RAISE WARNING 'fn_welcome_new_approved_member swallowed error for '
          'group=% user=%: % (%)',
          NEW.group_id, NEW.user_id, SQLERRM, SQLSTATE;
    END;

    RETURN NEW;
END;
$function$;

COMMENT ON COLUMN commander_home_posts.data IS
  'Phase 40: JSONB extension payload. Standard social-schema column — '
  'used today for welcome-post dedup (data->>welcome_user_id), '
  'reserved for future post metadata (embed cards, poll configs, etc).';

COMMENT ON FUNCTION public.fn_welcome_new_approved_member IS
  'Phase 40: fires when a non-owner member''s status becomes approved. '
  'Posts a welcome announcement in the group. Entire work is wrapped in '
  'EXCEPTION so a failure NEVER blocks member approval — welcome posts '
  'are nice-to-have, approvals are critical-path.';
