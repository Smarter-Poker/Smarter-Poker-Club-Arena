-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419234336 "phase40_fix_home_group_owner_hijack"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7db7d0e952244e33137bd10a9e3c0c9f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 40 bug #8 (NEW, discovered this sweep):
-- home_groups_update RLS policy uses USING-only semantics, meaning WITH CHECK
-- defaults to USING. An approved admin could UPDATE owner_id = themselves,
-- the post-row still satisfies USING (owner_id = auth.uid()), and the UPDATE
-- succeeds. Silent ownership hijack.
--
-- Defense: BEFORE UPDATE trigger that explicitly blocks owner_id mutation
-- unless (a) no auth session (cron/service_role/internal admin), or
-- (b) the session is the CURRENT owner legitimately transferring.
--
-- Verified exploit PRE-FIX: f39893fa (approved admin, non-owner) set
-- owner_id = their_uid on Saturday Night Poker Club and took ownership.
-- Rollback via RAISE EXCEPTION in probe — no persistent state change.

CREATE OR REPLACE FUNCTION public.protect_home_group_owner_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    -- Internal ops (service_role, cron handlers, explicit postgres admin)
    -- have no auth.uid(), pass through.
    IF auth.uid() IS NULL THEN
      RETURN NEW;
    END IF;
    -- Owner transferring to someone else is legitimate (though no API
    -- exposes this today — this keeps the door open if Dan builds a
    -- "transfer ownership" feature later).
    IF auth.uid() = OLD.owner_id THEN
      RETURN NEW;
    END IF;
    -- Everyone else: blocked.
    RAISE EXCEPTION 'Only the current owner can transfer ownership of a home group'
      USING ERRCODE = '42501',
            HINT = 'Direct UPDATE of owner_id by non-owners is denied';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_home_group_owner_id ON public.commander_home_groups;

CREATE TRIGGER trg_protect_home_group_owner_id
BEFORE UPDATE OF owner_id ON public.commander_home_groups
FOR EACH ROW
EXECUTE FUNCTION public.protect_home_group_owner_id();

COMMENT ON TRIGGER trg_protect_home_group_owner_id ON public.commander_home_groups IS
  'Phase 40: blocks non-owner admins from silently hijacking ownership via '
  'direct UPDATE owner_id = auth.uid(). Closes an RLS USING-only gap where '
  'post-row check defaulted to USING and passed for the new owner. '
  'Allows: service_role (auth.uid() IS NULL), and current owner transferring.';
