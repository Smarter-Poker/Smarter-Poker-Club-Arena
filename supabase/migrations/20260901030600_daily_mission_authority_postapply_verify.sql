DO $verify$
BEGIN
  IF has_function_privilege('authenticated',
       'public.assign_user_challenges(text,text[])', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.bump_challenge_progress(uuid,jsonb,jsonb,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.increment_challenge_progress(uuid,uuid,integer,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.record_daily_challenge_event(uuid,text,jsonb,jsonb,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.enqueue_daily_challenge_event(uuid,text,jsonb,jsonb,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-apply: a raw Daily Missions writer is browser-executable';
  END IF;
  IF has_table_privilege('authenticated', 'public.daily_mission_operations', 'INSERT')
     OR NOT has_function_privilege('authenticated',
       'public.record_daily_mission_operation(text,text,integer,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-apply: telemetry did not move behind its bounded RPC';
  END IF;
  IF has_table_privilege('anon', 'public.friendships', 'SELECT') THEN
    RAISE EXCEPTION 'post-apply: anonymous users can read friendship edges';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'hand_history'
      AND column_name = 'daily_mission_events'
  ) THEN RAISE EXCEPTION 'post-apply: hand mission facts column is missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.hand_history'::regclass
      AND tgname = 'trg_enqueue_hand_daily_missions' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.friendships'::regclass
      AND tgname = 'trg_daily_missions_friend_accepted' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.tournament_players'::regclass
      AND tgname = 'trg_daily_missions_tournament_registered' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.user_daily_challenges'::regclass
      AND tgname = 'trg_daily_missions_claimed_milestone' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'post-apply: a Daily Missions projection trigger is missing'; END IF;
  IF to_regclass('public.daily_challenge_progress_events') IS NULL
     OR to_regclass('public.daily_challenge_event_outbox') IS NULL
     OR to_regclass('public.daily_challenge_milestone_claims') IS NULL
     OR to_regclass('public.v_daily_challenge_event_outbox_health') IS NULL THEN
    RAISE EXCEPTION 'post-apply: an authority receipt or health surface is missing';
  END IF;
  IF to_regnamespace('cron') IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-missions-outbox-minute')
    OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-missions-retention-daily')
  ) THEN RAISE EXCEPTION 'post-apply: Daily Missions maintenance jobs are missing'; END IF;
END;
$verify$;
