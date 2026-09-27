-- 20260927222130_the_engine_reads_the_rebuy_window_it_asks.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  THE ENGINE CAN READ THE REBUY WINDOW IT ASKS
-- ===========================================================================
--
-- #5466 (engine e6b9dc5d, serving since 2026-09-27 20:56 UTC) made the bust
-- sweep read public.fn_ca_tournament_rebuy_window once per batch, so a
-- tournament whose window has closed stops asking the purchase door for every
-- busted horse. The engine calls it as service_role. 20260909014433 created
-- the function owner-only (REVOKE ALL ... FROM PUBLIC, anon, authenticated,
-- service_role) and nothing ever granted it back, so in production every call
-- answers 42501 "permission denied for function fn_ca_tournament_rebuy_window"
-- (proved 2026-09-27 22:15 UTC with SET LOCAL ROLE service_role, rolled back).
-- The manager reads an errored policy as "unknown, retain the purchase path",
-- so the closed-window short-circuit has never run once.
--
-- What that costs, read from production on 2026-09-27:
--   * every bust sweep of a rebuy / re-entry / Free Buy event with a closed
--     window calls process_tournament_rebuy for the first busted horse whose
--     allowance is not used up. One such refusal ("Tournament is not accepting
--     rebuys or re-entries", 55000) took 24.9 s in a rolled-back probe, and a
--     live one held tournament 618741a5's settlement lane exclusively for
--     14.8 s at 22:09:42. Mean 2,636 ms, max 29,145 ms over 7,737 calls.
--   * the sweep's 5 s work budget is gone before the batch reaches its
--     mutation phase, so it records at most one finish per scheduler turn.
--     The three events with the largest backlogs are exactly the closed-window
--     Free Buy events: 618741a5 (215 busted players still 'playing' at 0
--     chips), c775d008 (102) and ac10f59a (98). Non-rebuy MTTs hold at most 4.
--     The same events recorded 5 finishes in 3 s at 21:53:37 and 21:56:58,
--     inside the maintenance freeze, where tryTournamentRebuys returns before
--     any read; out of the freeze they record about one per turn.
--   * the unrecorded busts hold their roster chairs, so the balancer cannot
--     consolidate, and every park_requested break source whose last hand busted
--     somebody is refused its movement admission (f06_movement_prior raises
--     F06_MOVEMENT_ELIMINATION_UNPROVEN - 1,660 refusals in 30 minutes across
--     18 source tables). The fields drained to one live player per table:
--     618741a5 38 players on 38 tables, ac10f59a 37 on 37, c775d008 38 on 35,
--     none dealing since 20:12, 20:27 and 16:27 UTC.
--
-- The fix is the grant the engine's call needs, and only that: EXECUTE for
-- service_role (the role the engine and every other server-side caller of
-- this policy uses). anon and authenticated stay revoked. The body, owner,
-- SECURITY DEFINER, search_path and volatility are asserted unchanged before
-- and after. The function only reads public.tournaments; it writes nothing,
-- so granting it moves no chip, seat, registration or wallet.
--
-- Law: tests/every-rpc-the-engine-calls-is-one-the-engine-may-execute.law.test.ts
-- (the engine's rpc names against the migrations' grant history; planted red
-- on origin/main a1077c7c0c naming fn_ca_tournament_rebuy_window alone).
--
-- @live-proof: (SELECT has_function_privilege('service_role', 'public.fn_ca_tournament_rebuy_window(uuid)'::regprocedure, 'EXECUTE') AND NOT has_function_privilege('anon', 'public.fn_ca_tournament_rebuy_window(uuid)'::regprocedure, 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fn_ca_tournament_rebuy_window(uuid)'::regprocedure, 'EXECUTE'))

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_tournament_rebuy_window(uuid)'::regprocedure
       AND md5(p.prosrc) = 'b9b7ba44728a4f9a72a0c8f77934dbc3'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
       AND p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'PREIMAGE: fn_ca_tournament_rebuy_window is not the owner-only definition read 2026-09-27';
  END IF;
END
$pre$;

GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_rebuy_window(uuid) TO service_role;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_tournament_rebuy_window(uuid)'::regprocedure
       AND md5(p.prosrc) = 'b9b7ba44728a4f9a72a0c8f77934dbc3'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
       AND p.prosecdef
       AND p.provolatile = 'v')
     OR NOT has_function_privilege('service_role', 'public.fn_ca_tournament_rebuy_window(uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_tournament_rebuy_window(uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_tournament_rebuy_window(uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_ca_tournament_rebuy_window is not executable by service_role alone with its body, owner and settings unchanged';
  END IF;
END
$post$;

COMMIT;
