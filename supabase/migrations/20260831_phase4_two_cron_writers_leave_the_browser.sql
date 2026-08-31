-- ══════════════════════════════════════════════════════════════════════════
--  TWO CRON WRITERS THAT ANY LOGGED-IN PLAYER COULD FIRE
-- ══════════════════════════════════════════════════════════════════════════
--
-- Found by audit-live-definer-exposure.mjs on its first run after it learned
-- its fourth question -- but by questions ONE and TWO, which have been asking
-- since 2026-08-28. Both of these arrived after the last baseline, through the
-- Supabase MCP, which is exactly the path the daily live audit exists to watch
-- and the repository gate cannot see.
--
-- Both take NO ARGUMENTS, both write, both are SECURITY DEFINER, neither ever
-- consults auth.uid()/auth.role()/auth.jwt(), and `authenticated` held EXECUTE
-- on both. Neither is called from club-arena/src, club-arena/server/src, or the
-- World Hub's pages/, src/ or scripts/. They are cron work.
--
--   check_upcoming_tournament_pushes()
--     Queues the 15-minute and starting-soon push notifications for every
--     registrant of every upcoming tournament. A logged-in caller could fire it
--     in a loop and push-spam every registered player on the platform -- from
--     the platform's own verified sender, which is the worst kind.
--
--   fn_check_ungated_money_rpcs()
--     The security self-check. It INSERTS into financial_alerts at severity
--     'critical' when it finds an ungated money RPC. A logged-in caller could
--     fire it repeatedly and bury the real alarm under its own output. An
--     alarm anybody can ring is an alarm nobody reads -- and this estate has
--     already learned once, on 2026-08-31, what an alert loop does to the
--     signal (the payout reconciler re-raised accepted overpayments every
--     cycle until a resolution handshake was added).
--
-- Zero arguments is worth stating plainly: it means there is nothing to
-- validate and no safer parameterisation available. The grant IS the whole
-- control, so the grant is what changes.

REVOKE ALL ON FUNCTION public.check_upcoming_tournament_pushes()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_upcoming_tournament_pushes()
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_check_ungated_money_rpcs()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_check_ungated_money_rpcs()
  TO service_role;

DO $$
DECLARE r record; v_open int := 0;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'public.check_upcoming_tournament_pushes()',
      'public.fn_check_ungated_money_rpcs()'
    ]) AS sig
  LOOP
    IF has_function_privilege('anon', r.sig, 'EXECUTE')
       OR has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '% is still reachable from a browser role', r.sig;
    END IF;
    IF NOT has_function_privilege('service_role', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '% lost service_role - the cron path is broken', r.sig;
    END IF;
    v_open := v_open + 1;
  END LOOP;

  IF v_open <> 2 THEN
    RAISE EXCEPTION 'expected to close 2 functions, closed %', v_open;
  END IF;

  -- And the live audit's own questions must now answer clean for writers.
  IF jsonb_array_length(public.fn_definer_exposure_audit()->'unauthenticated_writers') <> 2 THEN
    RAISE EXCEPTION 'unauthenticated_writers is %, expected the 2 baselined ones only',
      jsonb_array_length(public.fn_definer_exposure_audit()->'unauthenticated_writers');
  END IF;
  IF jsonb_array_length(public.fn_definer_exposure_audit()->'anon_writers') <> 0 THEN
    RAISE EXCEPTION 'anon_writers is not zero';
  END IF;
END $$;
