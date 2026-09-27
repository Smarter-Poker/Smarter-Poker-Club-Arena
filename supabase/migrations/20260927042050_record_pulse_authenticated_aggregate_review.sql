-- Record the fixed authenticated aggregate in the existing telemetry review.
-- No function, privilege, scheduler or other review entry changes. The source
-- gate separately pins its declaration; this live table is name-based metadata.
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM public.ca_browser_definer_allowlist WHERE proname='fn_smarter_poker_pulse_cron_counts' AND reason LIKE '%3ed3ef0cd98df4468106fd46ab956317%'))
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '8s';
DO $review$
DECLARE
  v_reason constant text := $reason$Authenticated-only pulse helper returns one fixed row of two shared operational counts: active home/pnm jobs and failures in the last 24 hours. It cannot return job names, commands, errors, identities, money or product rows. Reviewed definition MD5 3ed3ef0cd98df4468106fd46ab956317; empty search_path, SQL STABLE, 8s limit, no arguments or writes. The outer pulse remains SECURITY INVOKER for caller-specific product RLS. The maintained source guard pins the exact declaration and rejects anonymous grants; this existing name-based live review entry is not a future-definition hash guard.$reason$;
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_proc p
    WHERE p.oid='public.fn_smarter_poker_pulse_cron_counts()'::regprocedure
      AND md5(pg_get_functiondef(p.oid))='3ed3ef0cd98df4468106fd46ab956317'
      AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='s'
      AND p.proacl=ARRAY['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::aclitem[]
      AND p.proconfig=ARRAY['search_path=""','statement_timeout=8s']
  ) OR has_function_privilege('anon','public.fn_smarter_poker_pulse_cron_counts()','EXECUTE')
    OR has_schema_privilege('authenticated','cron','USAGE') THEN
    RAISE EXCEPTION 'PULSE_AGGREGATE_REVIEW_SOURCE_CHANGED' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT FROM public.ca_browser_definer_allowlist
    WHERE proname='fn_smarter_poker_pulse_cron_counts' AND reason IS DISTINCT FROM v_reason) THEN
    RAISE EXCEPTION 'PULSE_AGGREGATE_REVIEW_ENTRY_CHANGED' USING ERRCODE='55000';
  END IF;
  INSERT INTO public.ca_browser_definer_allowlist(proname,reason)
    SELECT 'fn_smarter_poker_pulse_cron_counts',v_reason
    WHERE NOT EXISTS (SELECT FROM public.ca_browser_definer_allowlist
      WHERE proname='fn_smarter_poker_pulse_cron_counts');
END
$review$;
COMMIT;
