-- A logged-in browser could run a ledger repair.
--
-- fn_ca_repair_write_failure is SECURITY DEFINER, VOLATILE, and was executable
-- by `authenticated`. It takes a write-failure id, a counterparty type, a
-- counterparty entity and a reason, and it posts a correction against the
-- ledger account those map to -- club_treasury, promo_wallet, the player
-- stores. It takes no identity argument and never looks at who is calling, so
-- the caller's own identity places no limit at all on which failure it repairs
-- or what it attributes the repair to.
--
-- This is the exact shape the Telemetry Exposure gate exists to catch, and it
-- was catching it: the check has been failing on EVERY branch in the repo,
-- because it asks the live database rather than the branch. That is worth
-- saying plainly -- a red gate on everyone's PR is how a real finding gets
-- reclassified as noise.
--
-- Nothing calls it. Not the client, not the server, not pg_cron, and no other
-- database function (fn_ca_guard_watchlist merely names it in an array of
-- routines to watch). It is an operator tool that was left open, not a feature
-- anyone is using, so closing it removes no capability from anybody.
--
-- The grants below are exactly what the gate's own remediation text prescribes.

REVOKE ALL ON FUNCTION public.fn_ca_repair_write_failure(bigint, text, uuid, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_repair_write_failure(bigint, text, uuid, text)
  FROM anon;
REVOKE ALL ON FUNCTION public.fn_ca_repair_write_failure(bigint, text, uuid, text)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_repair_write_failure(bigint, text, uuid, text)
  TO service_role;

-- Prove it in the migration rather than trusting that the revoke took.
DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.fn_ca_repair_write_failure(bigint, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute the ledger write-failure repair';
  END IF;
  IF has_function_privilege('authenticated',
       'public.fn_ca_repair_write_failure(bigint, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can still execute the ledger write-failure repair';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_ca_repair_write_failure(bigint, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost execute on the ledger write-failure repair';
  END IF;
END $$;
