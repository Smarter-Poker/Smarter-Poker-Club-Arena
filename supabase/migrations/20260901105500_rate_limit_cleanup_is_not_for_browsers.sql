-- The second unscoped definer of the night, same shape as the first.
--
-- cleanup_rate_limits() is SECURITY DEFINER, VOLATILE, and was executable by
-- `authenticated`. It deletes from public.rate_limits. The blast radius is
-- smaller than the ledger repair closed hours earlier - it only removes rows
-- older than ten minutes, so it cannot clear the limits actually throttling a
-- caller right now - but a logged-in browser has no business calling a
-- maintenance DELETE at all, and the Telemetry Exposure gate is repo-wide:
-- while this was open, every branch's CI was red again.
--
-- Nothing calls it. The daily prune (`rate-limit-prune`, 17 3 * * *) does its
-- own DELETE inside a DO block and never invokes this function, and no client
-- or server code references it. It is dead surface.
--
-- Worth noticing that this is the SECOND one found tonight, hours apart, both
-- pre-existing rather than newly written. The gate catches them one at a time
-- because it reports what is currently open; a default-deny on definer
-- functions would catch them all at once, and is the obvious follow-up.

REVOKE ALL ON FUNCTION public.cleanup_rate_limits() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_rate_limits() FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_rate_limits() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_rate_limits() TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.cleanup_rate_limits()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute the rate-limit cleanup';
  END IF;
  IF has_function_privilege('authenticated', 'public.cleanup_rate_limits()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can still execute the rate-limit cleanup';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.cleanup_rate_limits()', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost execute on the rate-limit cleanup';
  END IF;
END $$;
