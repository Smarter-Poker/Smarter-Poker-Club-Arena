-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: 20260819_audit_trail_club_settings_triggers.sql
-- Tier 2 (additive: 3 functions, 3 triggers; no DROP, no type changes)
--
-- WHY: The Club Settings page (ClubSettingsPage.tsx) renders an "Admin
-- Activity Log" backed by public.audit_trail, and the 20260428000001
-- migration gave club owners a SELECT policy on that table. But NOTHING ever
-- writes club-admin rows: the settings save is a direct client-side UPDATE of
-- public.clubs (RLS owner-gated), the masterBus 'ADMIN_ACTION' emit has no
-- persistence listener, and the ops-API routes that were supposed to write
-- audit rows do not exist for this surface. Production count at audit time:
-- 1 row total, 0 for any club. The log renders empty, forever.
--
-- WHAT: Write the audit trail from the database itself, where it cannot be
-- bypassed by any client:
--   1. AFTER UPDATE ON clubs        -> 'update_club_settings' with a
--      before/after diff of exactly the columns the settings page edits.
--   2. AFTER UPDATE ON club_members -> 'role_change' / 'banned' /
--      'unban_member' / 'member_status_change' when role or status moves.
--   3. AFTER DELETE ON club_members -> 'kick_member' (by staff) or
--      'member_left' (self).
--
-- Triggers early-exit when auth.uid() IS NULL, so engine / service_role
-- writes (chip sync, hand counters, fleet maintenance) cost one GUC read and
-- log nothing. The audit INSERT is wrapped so a logging failure can never
-- block the underlying save.
--
-- actor_role CHECK on audit_trail allows only
-- ('owner','co_owner','host','agent','sub_agent','union_admin',
--  'platform_admin','system'); club_members.role in practice holds
-- owner/member/player (admin/agent possible). Mapping below keeps every
-- insert constraint-legal.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_audit_club_settings ON public.clubs;
--   DROP TRIGGER IF EXISTS trg_audit_club_member_update ON public.club_members;
--   DROP TRIGGER IF EXISTS trg_audit_club_member_delete ON public.club_members;
--   DROP FUNCTION IF EXISTS public.fn_audit_club_settings_change();
--   DROP FUNCTION IF EXISTS public.fn_audit_club_member_change();
--   DROP FUNCTION IF EXISTS public.fn_audit_actor_role(uuid, uuid);
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Pre-flight: abort if the world is not the shape this migration assumes ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'audit_trail') THEN
    RAISE EXCEPTION 'pre-flight: public.audit_trail does not exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'audit_trail'
                   AND column_name = 'after_state') THEN
    RAISE EXCEPTION 'pre-flight: audit_trail.after_state missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'clubs'
                   AND column_name = 'allow_rabbit_hunt') THEN
    RAISE EXCEPTION 'pre-flight: clubs.allow_rabbit_hunt missing — wrong schema?';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'club_members'
                   AND column_name = 'status') THEN
    RAISE EXCEPTION 'pre-flight: club_members.status missing';
  END IF;
END $$;

-- ── Helper: map the acting user to a constraint-legal actor_role ──
CREATE OR REPLACE FUNCTION public.fn_audit_actor_role(p_club_id uuid, p_actor uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.clubs c
                 WHERE c.id = p_club_id AND c.owner_id = p_actor) THEN 'owner'
    ELSE COALESCE(
      (SELECT CASE cm.role
                WHEN 'owner' THEN 'owner'
                WHEN 'admin' THEN 'co_owner'
                WHEN 'agent' THEN 'agent'
                ELSE 'system'
              END
         FROM public.club_members cm
        WHERE cm.club_id = p_club_id AND cm.user_id = p_actor
        LIMIT 1),
      'system')
  END;
$$;

-- ── 1. Club settings changes ──
CREATE OR REPLACE FUNCTION public.fn_audit_club_settings_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_before  jsonb := '{}'::jsonb;
  v_after   jsonb := '{}'::jsonb;
  v_old     jsonb;
  v_new     jsonb;
  v_key     text;
  -- Exactly the columns the Club Settings page edits. chip_pool,
  -- member_count and the level columns are handled by their own systems and
  -- must not spam this log.
  v_watched text[] := ARRAY[
    'name','description','is_public','requires_approval',
    'default_rake_percent','rake_cap',
    'allow_straddle','allow_run_it_twice','allow_rabbit_hunt',
    'min_buyin_bb','max_buyin_bb'];
BEGIN
  -- Engine / service_role / cron writes carry no JWT: not an admin UI action.
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  FOREACH v_key IN ARRAY v_watched LOOP
    IF (v_old -> v_key) IS DISTINCT FROM (v_new -> v_key) THEN
      v_before := v_before || jsonb_build_object(v_key, v_old -> v_key);
      v_after  := v_after  || jsonb_build_object(v_key, v_new -> v_key);
    END IF;
  END LOOP;

  IF v_after = '{}'::jsonb THEN
    RETURN NEW;  -- update touched none of the settings columns
  END IF;

  BEGIN
    INSERT INTO public.audit_trail
      (actor_id, actor_role, action, target_type, target_id, club_id,
       before_state, after_state)
    VALUES
      (v_actor, public.fn_audit_actor_role(NEW.id, v_actor),
       'update_club_settings', 'club', NEW.id, NEW.id,
       v_before, v_after);
  EXCEPTION WHEN OTHERS THEN
    -- The log must never block the save it is logging.
    RAISE WARNING 'audit_trail insert failed for club %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_club_settings ON public.clubs;
CREATE TRIGGER trg_audit_club_settings
  AFTER UPDATE ON public.clubs
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_audit_club_settings_change();

-- ── 2 + 3. Member admin actions: role/status changes and removals ──
CREATE OR REPLACE FUNCTION public.fn_audit_club_member_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_action text;
  v_before jsonb;
  v_after  jsonb;
  v_club   uuid;
  v_target uuid;
BEGIN
  IF v_actor IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_club   := OLD.club_id;
    v_target := OLD.user_id;
    v_action := CASE WHEN v_actor = OLD.user_id THEN 'member_left'
                     ELSE 'kick_member' END;
    v_before := jsonb_build_object('role', OLD.role, 'status', OLD.status);
    v_after  := NULL;
  ELSE
    v_club   := NEW.club_id;
    v_target := NEW.user_id;
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      v_action := 'role_change';
      v_before := jsonb_build_object('role', OLD.role);
      v_after  := jsonb_build_object('role', NEW.role);
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      -- Action names chosen so the AuditLog UI's category filters match:
      -- 'banned' / 'unban_member' land under Player via the 'ban' prefix.
      v_action := CASE
        WHEN NEW.status = 'banned' THEN 'banned'
        WHEN OLD.status = 'banned' THEN 'unban_member'
        ELSE 'member_status_change' END;
      v_before := jsonb_build_object('status', OLD.status);
      v_after  := jsonb_build_object('status', NEW.status);
    ELSE
      RETURN NEW;  -- chip/stat sync etc. — not an admin action
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.audit_trail
      (actor_id, actor_role, action, target_type, target_id, club_id,
       before_state, after_state)
    VALUES
      (v_actor, public.fn_audit_actor_role(v_club, v_actor),
       v_action, 'member', v_target, v_club, v_before, v_after);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'audit_trail insert failed for club % member %: %',
      v_club, v_target, SQLERRM;
  END;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_club_member_update ON public.club_members;
CREATE TRIGGER trg_audit_club_member_update
  AFTER UPDATE OF role, status ON public.club_members
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_audit_club_member_change();

DROP TRIGGER IF EXISTS trg_audit_club_member_delete ON public.club_members;
CREATE TRIGGER trg_audit_club_member_delete
  AFTER DELETE ON public.club_members
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_audit_club_member_change();

-- ── Lock down the SECURITY DEFINER helpers (repo convention, see #79) ──
-- Trigger functions cannot be invoked directly, but revoke anyway so a
-- future signature change cannot quietly become a privilege hole.
REVOKE EXECUTE ON FUNCTION public.fn_audit_club_settings_change() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_audit_club_member_change() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_audit_actor_role(uuid, uuid) FROM anon, authenticated;

-- ── Post-apply assertions ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.clubs'::regclass
                   AND tgname = 'trg_audit_club_settings') THEN
    RAISE EXCEPTION 'post-apply: trg_audit_club_settings missing on clubs';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
      WHERE tgrelid = 'public.club_members'::regclass
        AND tgname IN ('trg_audit_club_member_update',
                       'trg_audit_club_member_delete')) <> 2 THEN
    RAISE EXCEPTION 'post-apply: club_members audit triggers missing';
  END IF;
END $$;
