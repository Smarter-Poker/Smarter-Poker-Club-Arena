CREATE OR REPLACE FUNCTION public.bump_daily_challenge_dashboard_revision()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid;
  v_revision bigint;
BEGIN
  IF TG_TABLE_NAME = 'profiles' THEN
    v_user_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
  ELSE
    v_user_id := NEW.user_id;
  END IF;

  -- Cascading account deletion removes the profile before child triggers run.
  -- A cursor for a deleted user is unusable and would violate the cursor FK.
  IF v_user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_user_id) THEN
    INSERT INTO public.daily_challenge_dashboard_revisions (user_id, revision, updated_at)
    VALUES (v_user_id, 1, clock_timestamp())
    ON CONFLICT (user_id) DO UPDATE
      SET revision = public.daily_challenge_dashboard_revisions.revision + 1,
          updated_at = EXCLUDED.updated_at
    RETURNING revision INTO v_revision;

    BEGIN
      PERFORM realtime.send(
        jsonb_build_object('revision', v_revision),
        'daily_mission_revision_changed',
        'daily-mission-revision:' || v_user_id::text,
        true
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Daily Mission revision broadcast failed: %', SQLERRM;
    END;

    IF TG_TABLE_NAME = 'user_daily_challenges' THEN
      IF TG_OP = 'UPDATE'
         AND OLD.completed IS NOT TRUE
         AND NEW.completed IS TRUE THEN
        BEGIN
          PERFORM realtime.send(
            jsonb_build_object(
              'id', NEW.id,
              'challengeId', NEW.challenge_id,
              'name', NEW.challenge_name_snapshot,
              'diamondReward', NEW.diamond_reward_snapshot
            ),
            'daily_mission_completed',
            'daily-mission-completion:' || v_user_id::text,
            true
          );
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'Daily Mission completion broadcast failed: %', SQLERRM;
        END;
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$
