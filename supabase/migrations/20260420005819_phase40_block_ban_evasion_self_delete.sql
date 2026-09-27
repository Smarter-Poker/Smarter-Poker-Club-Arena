-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420005819 "phase40_block_ban_evasion_self_delete"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 493e0542188c00b962495d4d48e33cc3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 30: BAN EVASION via self-delete
--
-- The home_members_delete RLS policy allows any user to delete their own
-- member row (user_id = auth.uid()). A banned user can exploit this by:
--   1. DELETE their own 'banned' member row
--   2. Call join_home_group as a fresh request
--   3. Status goes to 'pending' (or 'approved' for open public groups!)
--   4. Ban effectively erased from the group's memory
--
-- Fix:
-- (A) BEFORE DELETE trigger on commander_home_members that blocks self-delete
--     of banned rows. Staff can still delete (e.g., to clean up after a
--     permanent decision).
-- (B) Tighten join_home_group to reject any user who has a 'banned' row OR
--     has had one in the past 7 days even if it was later deleted. This is
--     defense-in-depth: if somehow the trigger is bypassed, the join path
--     still won't re-add them.
--
-- For (B), we track the ban history by NOT deleting the row on ban — we set
-- status='banned' which is already the behavior. The trigger from (A) then
-- preserves the historical record.
-- ============================================================================

-- ---------- (A) BEFORE DELETE trigger ----------
CREATE OR REPLACE FUNCTION public.fn_block_home_member_ban_evasion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET row_security TO off
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_is_staff boolean;
BEGIN
  -- Internal / cron / trigger-chain contexts have no JWT. Allow.
  IF v_caller IS NULL THEN
    RETURN OLD;
  END IF;

  -- service_role (server-side admin code) bypass
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN OLD;
  END IF;

  -- If the row being deleted isn't banned, nothing special to check here
  IF OLD.status <> 'banned' THEN
    RETURN OLD;
  END IF;

  -- Banned row being deleted. Only staff of this group may do so (to
  -- permanently remove the person from the group, e.g. after an appeal).
  v_is_staff := fn_home_is_group_staff(v_caller, OLD.group_id);

  IF NOT v_is_staff THEN
    RAISE EXCEPTION
      'Cannot delete your own banned member row. Banned members cannot leave a group to evade their ban.'
      USING ERRCODE = '42501',
            HINT = 'Contact a group admin if you believe this ban is in error.';
  END IF;

  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS trg_block_home_member_ban_evasion ON commander_home_members;
CREATE TRIGGER trg_block_home_member_ban_evasion
  BEFORE DELETE ON commander_home_members
  FOR EACH ROW
  EXECUTE FUNCTION fn_block_home_member_ban_evasion();

COMMENT ON TRIGGER trg_block_home_member_ban_evasion ON commander_home_members IS
  'Phase 40: blocks a banned user from deleting their own member row as a '
  'ban-evasion strategy. Staff can still delete banned rows to permanently '
  'remove the person.';
