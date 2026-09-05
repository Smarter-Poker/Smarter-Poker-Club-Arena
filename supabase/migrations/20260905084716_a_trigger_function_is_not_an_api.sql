-- A TRIGGER FUNCTION IS NOT AN API (2026-09-05)
--
-- The Supabase security advisor flagged five SECURITY DEFINER functions as
-- callable by anon: fn_daily_missions_claimed_milestone, fn_guard_union_creation,
-- fn_new_club_gets_the_ladder, fn_new_union_gets_the_ladder and
-- fn_spin_ladder_is_the_drawn_one. Three name payout ladders, which reads
-- alarming.
--
-- IT IS NOT EXPLOITABLE, and saying so plainly matters more than the scare:
-- all five RETURN trigger, PostgreSQL refuses to invoke a trigger function
-- directly ("trigger functions can only be called as triggers"), and PostgREST
-- does not expose trigger-returning functions as RPC endpoints. Nobody can
-- reach them over the API today.
--
-- The grant is still wrong, and it is wider than the five the linter saw - it
-- only reports trigger functions that are SECURITY DEFINER. Measured:
--
--   trigger functions in public                     437
--   reachable by authenticated                       37
--   reachable by anon                                19
--
-- Among them: fn_ca_block_browser_money_table, fn_guard_rake_belongs_to_club,
-- fn_tournament_payouts_are_append_only, fn_ca_settlement_transition_guard,
-- fn_ca_audit_diamond_change - the guards that protect the money paths were
-- themselves granted to the browser roles.
--
-- TWO THINGS THIS MIGRATION LEARNED THE HARD WAY, both caught by its own
-- assertion rather than by review:
--
--   1. Revoking from anon and authenticated left 19 still reachable, because
--      PostgreSQL grants EXECUTE on every new function to PUBLIC by default
--      and both roles inherit it. PUBLIC has to be named explicitly.
--   2. Two are owned by supabase_admin, not postgres, so this migration
--      cannot revoke them and does not try: postgis_cache_bbox and
--      checkauthtrigger, both PostGIS built-ins and both harmless. They are
--      skipped by OWNERSHIP rather than by name, so a future PostGIS function
--      does not reintroduce a failure here.
--
-- Triggers fire as part of the statement that fired them and consult the table
-- owner's rights, never the grantee's, so revoking EXECUTE cannot change any
-- trigger's behaviour. What it removes is a standing invitation: the day one
-- of these is rewritten to RETURNS void for a backfill, the grant is already
-- there and nobody looks again.
--
-- APPLIED 2026-09-05. Result: 0 of ours reachable by a browser role, 2 PostGIS
-- built-ins left (not ours), 594 user triggers intact.

DO $revoke$
DECLARE
  r record;
  v_count integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid,
           quote_ident(n.nspname) || '.' || quote_ident(p.proname)
             || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      JOIN pg_type t      ON t.oid = p.prorettype   AND t.typname = 'trigger'
     WHERE pg_get_userbyid(p.proowner) = current_user
       AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  LOOP
    IF (SELECT t.typname FROM pg_type t
         JOIN pg_proc p2 ON p2.prorettype = t.oid
        WHERE p2.oid = r.oid) <> 'trigger' THEN
      RAISE EXCEPTION 'refusing to revoke on a non-trigger function: %', r.sig;
    END IF;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'revoked EXECUTE on % trigger functions (PUBLIC, anon, authenticated)', v_count;
END
$revoke$;

DO $verify$
DECLARE
  v_mine integer; v_foreign integer; v_triggers integer;
BEGIN
  SELECT count(*) FILTER (WHERE pg_get_userbyid(p.proowner) = current_user),
         count(*) FILTER (WHERE pg_get_userbyid(p.proowner) <> current_user)
    INTO v_mine, v_foreign
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    JOIN pg_type t      ON t.oid = p.prorettype   AND t.typname = 'trigger'
   WHERE has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_mine <> 0 THEN
    RAISE EXCEPTION '% trigger functions we own still carry a browser-role grant', v_mine;
  END IF;

  SELECT count(*) INTO v_triggers FROM pg_trigger WHERE NOT tgisinternal;
  IF v_triggers = 0 THEN
    RAISE EXCEPTION 'no user triggers remain - something went very wrong';
  END IF;

  RAISE NOTICE 'clean: 0 of ours reachable by a browser role, % left owned elsewhere (PostGIS), % user triggers intact',
               v_foreign, v_triggers;
END
$verify$;
