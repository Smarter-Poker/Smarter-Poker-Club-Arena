-- AN ALARM A PLAYER CAN SWITCH OFF IS NOT AN ALARM.
--
-- fn_resolve_settled_financial_alerts shipped executable by `authenticated`.
-- It is SECURITY DEFINER, so row-level security does not apply to it, and it
-- is VOLATILE, because it writes.
--
-- Called with the default p_apply => false it returns which financial alerts
-- are currently open. Called with p_apply => true it marks them resolved - and
-- the alerts it resolves are the earner_not_paid class raised by
-- fn_payout_guarantee_check, which is to say the alarm that fires when a
-- tournament did not pay somebody. Nothing in the body consults auth.uid(),
-- auth.role(), auth.jwt() or the request, so every account that can log in
-- could read the platform's open money problems and then clear them.
--
-- That is not a data leak, it is worse in kind: it is a switch on the smoke
-- detector. An unpaid player's alert being silently resolved does not look like
-- an attack afterwards - it looks like the payout was fine.
--
-- WHY REVOKE AND NOT ALLOWLIST. ca_browser_definer_allowlist exists for
-- routines a browser genuinely has to reach, with a written reason. This one
-- has no callers at all: not the Club Arena client, not the engine server, not
-- the scripts, not the workflows, not the World Hub. It is a maintenance sweep
-- and it belongs to service_role, which still has it.
--
-- Its sibling fn_raise_financial_alert KEEPS its grant on purpose. The browser
-- client raises alerts through it (src/services/FinancialAlertService.ts) and
-- it is throttled for exactly that reason. Raising an alarm is not the same
-- act as clearing one, and only the second is being closed here.
--
-- This is what has been failing the Telemetry Exposure gate on every branch
-- since it landed, because that gate reads the live database rather than the
-- diff - so no pull request in the repository could go green while it stood.
--
-- WHY THE GUARD CLAUSE. The routine exists in production but its CREATE was
-- never committed - it was applied straight to the database, so no migration
-- in this repository defines it. A bare REVOKE naming a function that a clean
-- rebuild has never created is a migration that fails on an empty database,
-- which would trade a live hole for a broken bootstrap. to_regprocedure()
-- returns NULL instead of raising for a routine that is not there, so this
-- closes the grant where the routine exists and is a no-op where it does not.

DO $$
BEGIN
  IF to_regprocedure('public.fn_resolve_settled_financial_alerts(boolean, integer)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer)'
         || ' FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer)'
         || ' TO service_role';
    RAISE NOTICE 'fn_resolve_settled_financial_alerts: revoked from the browser, service_role retained';
  ELSE
    RAISE NOTICE 'fn_resolve_settled_financial_alerts: not present, nothing to revoke';
  END IF;
END $$;
