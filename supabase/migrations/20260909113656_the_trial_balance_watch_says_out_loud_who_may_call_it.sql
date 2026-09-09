/* fn_ca_trial_balance_watch became a SECURITY DEFINER *writer* an hour ago:
   it now records each reading in ca_detector_runs so the persistence rule has
   a predecessor to compare against. It takes no actor and calls neither
   auth.uid() nor auth.role(), so it cannot know who is asking - and a definer
   writer that cannot know who is asking must not be reachable from a browser.

   Its live grants are already only postgres and service_role, and its only
   callers are the pg_cron jobs ca-trial-balance-hourly and
   ca-diamond-trial-balance-hourly at :20 past the hour; nothing in src/ or in
   an edge function calls it. So this changes nothing that runs. It is written
   down because a migration that declares a definer writer has to name its
   grants in the same migration, or the next reader has to go and find out. */
REVOKE ALL ON FUNCTION public.fn_ca_trial_balance_watch(timestamp with time zone, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_trial_balance_watch(timestamp with time zone, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.fn_ca_trial_balance_watch(timestamp with time zone, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_trial_balance_watch(timestamp with time zone, numeric) TO service_role;

DO $assert$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
     WHERE routine_schema = 'public'
       AND routine_name = 'fn_ca_trial_balance_watch'
       AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  ) THEN
    RAISE EXCEPTION 'a browser role can still execute the trial balance watch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
     WHERE routine_schema = 'public'
       AND routine_name = 'fn_ca_trial_balance_watch'
       AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'the engine can no longer execute the trial balance watch';
  END IF;
END
$assert$;;
