-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826173118; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Today's earlier sweep matched function NAMES (%chip%, %wallet%, %pay%, ...)
-- and closed all seventeen it found. That is the wrong axis: a function is
-- dangerous because of the table it writes, not because of what someone called
-- it. Re-run against the DEFINITIONS -- every SECURITY DEFINER function
-- executable by `authenticated` or `anon`, containing no auth.uid(), whose body
-- INSERTs or UPDATEs a money table -- and five more appear. Not one of them
-- would have matched the name sweep.
--
--   fn_horse_fund_from_treasury(p_table_id, p_user_id, p_amount)
--       writes chip_transactions and table_seats. Takes an arbitrary user and
--       an arbitrary amount and moves club treasury chips onto a seat. This is
--       a treasury drain reachable by any logged-in caller.
--   fn_horse_seat_from_treasury(p_table_id, p_user_id, p_seat_number, p_amount)
--       same family, same shape.
--   fn_seat_late_registrant(p_tournament_id, p_user_id)
--       writes table_seats and tournament_players -- seats an arbitrary user.
--   fn_release_phantom_seat_claims()
--       writes tournament_players.
--   fn_reset_broken_streak_multipliers()
--       writes profiles.
--
-- CALL SITES, checked before revoking:
--   fn_horse_fund_from_treasury      club-arena server/src/services/supabase/wallets.ts,
--                                    the Hetzner engine on SUPABASE_SERVICE_ROLE_KEY
--   fn_reset_broken_streak_multipliers  World Hub pages/api/social/share-count.js,
--                                    server-side on SUPABASE_SERVICE_ROLE_KEY
--   the other three                  no call site in either repo
-- A revoke on `authenticated` does not touch service_role, so both live callers
-- are unaffected.
--
-- ALSO CHECKED: no RLS policy in `public` references any of the five (a policy
-- predicate runs as the querying role, so revoking one a policy calls would
-- silently deny rows). fn_seat_late_registrant is called from
-- fn_register_for_tournament and fn_sweep_seatless_late_registrants, both
-- SECURITY DEFINER and therefore running as their owner -- asserted below.
--
-- ROLLBACK: GRANT EXECUTE ON FUNCTION <each signature> TO authenticated;

REVOKE EXECUTE ON FUNCTION public.fn_horse_fund_from_treasury(uuid, uuid, numeric) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_horse_seat_from_treasury(uuid, uuid, integer, numeric) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_release_phantom_seat_claims() FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_reset_broken_streak_multipliers() FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_seat_late_registrant(uuid, uuid) FROM authenticated, anon, PUBLIC;

DO $check$
DECLARE v_bad text; v_owner text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('fn_horse_fund_from_treasury','fn_horse_seat_from_treasury',
                      'fn_release_phantom_seat_claims','fn_reset_broken_streak_multipliers',
                      'fn_seat_late_registrant')
    AND (has_function_privilege('authenticated', p.oid,'EXECUTE')
      OR has_function_privilege('anon', p.oid,'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'still reachable from the browser: %', v_bad;
  END IF;

  IF NOT has_function_privilege('service_role',
       'public.fn_horse_fund_from_treasury(uuid,uuid,numeric)','EXECUTE') THEN
    RAISE EXCEPTION 'the engine lost EXECUTE on fn_horse_fund_from_treasury';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_reset_broken_streak_multipliers()','EXECUTE') THEN
    RAISE EXCEPTION 'share-count.js lost EXECUTE on fn_reset_broken_streak_multipliers';
  END IF;

  -- the tournament path calls fn_seat_late_registrant as its owner; that must hold
  SELECT pg_get_userbyid(proowner) INTO v_owner FROM pg_proc
   WHERE oid = 'public.fn_register_for_tournament'::regproc;
  IF NOT has_function_privilege(v_owner,
       'public.fn_seat_late_registrant(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'fn_register_for_tournament can no longer seat a late registrant';
  END IF;
END
$check$;
