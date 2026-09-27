-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424010215 "20260421130000_hg_require_onboarded_trigger_guard"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b0eff4012fb2ad0101ee6354edfb2ee0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════
-- COMMERCIAL-GRADE ONBOARDING GATE — trigger-level enforcement
-- ═══════════════════════════════════════════════════════════════
-- Problem: fn_get_home_games_onboarding_status sets
-- profiles.home_games_onboarded_at after completion, and
-- fn_attest_over_18 / fn_set_user_jurisdiction / fn_record_tos_acceptance
-- populate the 6 gate inputs — but no DB-level enforcement ensures
-- onboarding completes BEFORE a user writes HG content. All 24
-- user-facing write RPCs relied on the UI's honor system.
--
-- This migration adds a BEFORE INSERT trigger on every user-write-
-- bearing HG table. If auth.uid() = the row's writer column AND that
-- user has profiles.home_games_onboarded_at IS NULL, the insert is
-- rejected with ONBOARDING_REQUIRED.
--
-- Exempt contexts:
--   • service_role / NULL auth.uid() (cron, migrations, internal RPCs)
--   • rows written by someone OTHER than the subject user (admin
--     approvals, moderation actions, host-created RSVPs on behalf of
--     guests)
--
-- No UPDATE triggers: once a user has successfully written something,
-- they stay able to edit/change it even if the policy version bumps —
-- matches industry norm of not locking mid-session.

CREATE OR REPLACE FUNCTION public.fn_hg_require_onboarded_on_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid            uuid;
  v_target_user_id uuid;
  v_onboarded_at   timestamptz;
BEGIN
  v_uid := auth.uid();

  -- 1) No auth context (cron / service_role / superuser) → skip gate
  IF v_uid IS NULL THEN RETURN NEW; END IF;
  BEGIN
    IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
  EXCEPTION WHEN OTHERS THEN NULL;  -- auth.role() may be unavailable in some ctxs
  END;

  -- 2) Identify the row's writer column based on the target table
  v_target_user_id := CASE TG_TABLE_NAME
    WHEN 'commander_home_groups'          THEN (NEW.owner_id)
    WHEN 'commander_home_games'           THEN (NEW.host_id)
    WHEN 'commander_home_posts'           THEN (NEW.author_id)
    WHEN 'commander_home_post_comments'   THEN (NEW.author_id)
    WHEN 'commander_home_post_likes'      THEN (NEW.user_id)
    WHEN 'commander_home_members'         THEN (NEW.user_id)
    WHEN 'commander_home_rsvps'           THEN (NEW.user_id)
    WHEN 'commander_home_game_photos'     THEN (NEW.uploader_id)
    WHEN 'commander_home_poll_votes'      THEN (NEW.user_id)
    WHEN 'commander_home_polls'           THEN (NEW.created_by)
    WHEN 'commander_home_invite_tokens'   THEN (NEW.created_by)
    WHEN 'commander_home_ban_appeals'     THEN (NEW.user_id)
    WHEN 'commander_home_content_reports' THEN (NEW.reporter_id)
    WHEN 'commander_home_game_reviews'    THEN (NEW.reviewer_id)
    WHEN 'commander_home_group_follows'   THEN (NEW.user_id)
    WHEN 'commander_home_game_templates'  THEN (NEW.created_by)
    ELSE NULL
  END;

  -- 3) If the writer column doesn't match the calling user, the write
  -- is on-behalf-of (admin approval, moderator action). Don't gate.
  IF v_target_user_id IS NULL OR v_target_user_id <> v_uid THEN
    RETURN NEW;
  END IF;

  -- 4) Check onboarding
  SELECT home_games_onboarded_at INTO v_onboarded_at
    FROM public.profiles WHERE id = v_uid;
  IF v_onboarded_at IS NOT NULL THEN RETURN NEW; END IF;

  -- 5) Not onboarded → reject
  RAISE EXCEPTION 'ONBOARDING_REQUIRED'
    USING HINT = 'Complete the Home Games welcome flow (age, jurisdiction, policy acceptance) before using Home Games.';
END;
$fn$;

COMMENT ON FUNCTION public.fn_hg_require_onboarded_on_write() IS
  'HG commercial-grade onboarding gate. Fires BEFORE INSERT on HG user-write tables. Gates only when caller == row writer AND caller not onboarded. Bypasses service_role and admin-on-behalf-of-user writes.';

-- ── Register the trigger on every user-write-bearing HG table ──
DO $do$
DECLARE v_tbl text; v_tables text[] := ARRAY[
  'commander_home_groups','commander_home_games','commander_home_posts',
  'commander_home_post_comments','commander_home_post_likes','commander_home_members',
  'commander_home_rsvps','commander_home_game_photos','commander_home_poll_votes',
  'commander_home_polls','commander_home_invite_tokens','commander_home_ban_appeals',
  'commander_home_content_reports','commander_home_game_reviews',
  'commander_home_group_follows','commander_home_game_templates'
];
BEGIN
  FOREACH v_tbl IN ARRAY v_tables LOOP
    -- Only register if the table exists
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relname=v_tbl) THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_hg_require_onboarded ON public.%I;
         CREATE TRIGGER trg_hg_require_onboarded
           BEFORE INSERT ON public.%I
           FOR EACH ROW EXECUTE FUNCTION public.fn_hg_require_onboarded_on_write();',
        v_tbl, v_tbl);
    END IF;
  END LOOP;
END $do$;
