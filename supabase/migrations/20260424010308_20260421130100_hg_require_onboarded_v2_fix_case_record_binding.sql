-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424010308 "20260421130100_hg_require_onboarded_v2_fix_case_record_binding"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d09284c5de0db5212ac6463d8da0bad2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- v2: CASE arms bind NEW.column at parse time for RECORD, producing
-- 42703 errors for columns that don't exist on the actual target table.
-- Switch to IF/ELSIF chain where only the matching branch's column
-- reference executes.

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
  IF v_uid IS NULL THEN RETURN NEW; END IF;
  BEGIN
    IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  IF    TG_TABLE_NAME = 'commander_home_groups'          THEN v_target_user_id := NEW.owner_id;
  ELSIF TG_TABLE_NAME = 'commander_home_games'           THEN v_target_user_id := NEW.host_id;
  ELSIF TG_TABLE_NAME = 'commander_home_posts'           THEN v_target_user_id := NEW.author_id;
  ELSIF TG_TABLE_NAME = 'commander_home_post_comments'   THEN v_target_user_id := NEW.author_id;
  ELSIF TG_TABLE_NAME = 'commander_home_post_likes'      THEN v_target_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'commander_home_members'         THEN v_target_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'commander_home_rsvps'           THEN v_target_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'commander_home_game_photos'     THEN v_target_user_id := NEW.uploader_id;
  ELSIF TG_TABLE_NAME = 'commander_home_poll_votes'      THEN v_target_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'commander_home_polls'           THEN v_target_user_id := NEW.created_by;
  ELSIF TG_TABLE_NAME = 'commander_home_invite_tokens'   THEN v_target_user_id := NEW.created_by;
  ELSIF TG_TABLE_NAME = 'commander_home_ban_appeals'     THEN v_target_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'commander_home_content_reports' THEN v_target_user_id := NEW.reporter_id;
  ELSIF TG_TABLE_NAME = 'commander_home_game_reviews'    THEN v_target_user_id := NEW.reviewer_id;
  ELSIF TG_TABLE_NAME = 'commander_home_group_follows'   THEN v_target_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'commander_home_game_templates'  THEN v_target_user_id := NEW.created_by;
  ELSE v_target_user_id := NULL;
  END IF;

  IF v_target_user_id IS NULL OR v_target_user_id <> v_uid THEN
    RETURN NEW;
  END IF;

  SELECT home_games_onboarded_at INTO v_onboarded_at
    FROM public.profiles WHERE id = v_uid;
  IF v_onboarded_at IS NOT NULL THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'ONBOARDING_REQUIRED'
    USING HINT = 'Complete the Home Games welcome flow (age, jurisdiction, policy acceptance) before using Home Games.';
END;
$fn$;
