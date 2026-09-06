-- THE THREE LOCK-ORDER FUNCTIONS STATE WHO MAY EXECUTE THEM.
--
-- `scripts/ci/check-definer-authorization.mjs` blocked the push that carried
-- 20260906152529, 20260906152700 and 20260906152850, and it was right to.
-- Each of those replaces a SECURITY DEFINER function that WRITES, and none of
-- the three files says a word about who may call it. The checker starts from
-- the Postgres default - EXECUTE held by PUBLIC - and reads a file that never
-- revokes as a file that leaves the function open to any browser.
--
-- THE LIVE DATABASE IS NOT OPEN, and that is exactly why this needs saying in
-- the repo. Measured on production 2026-09-06 15:24 UTC, after the three were
-- applied:
--
--   fn_sync_tournament_chips          {postgres, service_role}   auth=false anon=false
--   fn_settle_tournament_rake         {postgres, service_role}   auth=false anon=false
--   fn_seat_horse_in_seat_first_game  {postgres, service_role}   auth=false anon=false
--
-- Two things kept it that way, and neither belongs in a file: CREATE OR
-- REPLACE preserves an existing function's ACL, so the grants these three
-- have always had survived the replace; and an [autorevoke] event trigger on
-- this database strips PUBLIC/anon EXECUTE from a newly created function (it
-- fired for all five migrations - the NOTICEs are in the apply log). A repo
-- that relies on either is a repo whose files do not mean what they say: a
-- replay onto a database where the function does not exist yet, or one
-- without that event trigger, would create all three wide open.
--
-- So this states it. Option 1 from the checker's own remedy, because none of
-- the three should ever be reachable from a browser:
--
--   * fn_sync_tournament_chips writes tournament_players.chips for a whole
--     event from a caller-supplied array. A browser holding it could set any
--     player's stack in any tournament.
--   * fn_settle_tournament_rake moves an event's whole fee into a union
--     wallet or a club treasury.
--   * fn_seat_horse_in_seat_first_game creates seats and registrations.
--
-- All three are engine-only paths and are called with the service role
-- (`server/src/services/supabase/client.ts`). PUBLIC is named alongside the
-- two browser roles, because a REVOKE that names only `authenticated` while
-- PUBLIC still holds EXECUTE reads as a fix and does nothing - the trap the
-- checker's own header records.
--
-- No behaviour changes. On this database every statement below is a no-op
-- that asserts the state already holds; on any other, it is the fix.

BEGIN;

REVOKE ALL ON FUNCTION public.fn_sync_tournament_chips(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_tournament_chips(uuid, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_rake(uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid, uuid)
  TO service_role;

-- ---------------------------------------------------------------------------
-- PROVE IT, against the live catalogue: the engine keeps them, no browser role
-- can reach them, and the two reporting triggers stay unreachable too.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND (p.proname, pg_get_function_identity_arguments(p.oid)) IN (
             ('fn_sync_tournament_chips',         'uuid, jsonb'),
             ('fn_settle_tournament_rake',        'uuid, text'),
             ('fn_seat_horse_in_seat_first_game', 'uuid, uuid'))
  LOOP
    IF NOT has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED: the engine can no longer execute %', r.proname;
    END IF;
    IF has_function_privilege('authenticated', r.oid, 'EXECUTE')
       OR has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED: a browser role can still execute %', r.proname;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('trg_ca_reporting_wallet_insert', 'trg_ca_reporting_rake_insert')
         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
              OR has_function_privilege('anon', p.oid, 'EXECUTE'))) <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: a browser role can execute a reporting rollup trigger function';
  END IF;

  RAISE NOTICE 'DEFINER_GRANTS_STATED engine only; no browser role holds EXECUTE on any of the three';
END $verify$;

COMMIT;
